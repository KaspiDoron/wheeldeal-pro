import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT F016 - the traveller's accept/decline of a substitute vehicle must
// return the REAL write result.
//
// resolveAlternativeOffer awaited sbUpdate and threw its boolean away,
// returning { ok: true } regardless. sbUpdate never throws - it returns false
// on no connection, an 8s abort and every non-2xx - so a Decline whose PATCH
// 5xx'd answered ok:true, the route said { ok: true, accepted: false }, the
// card cleared the "we have a 150 instead" question... and fields.alternativeOffer
// was still parked with `declined` never set, so the next turn kept negotiating
// the vehicle the traveller had just refused and the next reload re-asked.
// persistAlternativeOffer had the identical unread-write shape.
//
// Every test here EXECUTES the store against a Map-backed negotiation_threads.

vi.mock("server-only", () => ({}));

type Fields = Record<string, unknown>;
interface ThreadRow {
  thread_key: string;
  user_email: string;
  vendor_id: string;
  fields: Fields | null;
}

const db: {
  threads: Map<string, ThreadRow>;
  writeOk: boolean;
  readFails: boolean;
  patches: Array<{ filter: string; values: Record<string, unknown> }>;
} = { threads: new Map(), writeOk: true, readFails: false, patches: [] };

vi.mock("../runtime-config", () => ({
  sbSelectStrict: async (_table: string, query: string) => {
    if (db.readFails) return { error: "unavailable" as const };
    const email = decodeURIComponent(/user_email=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const vendor = decodeURIComponent(/vendor_id=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const rows = [...db.threads.values()]
      .filter((r) => r.user_email === email && r.vendor_id === vendor)
      .map((r) => ({ thread_key: r.thread_key, fields: r.fields ? { ...r.fields } : null }));
    return { rows };
  },
  sbUpdate: async (_table: string, filter: string, values: Record<string, unknown>) => {
    db.patches.push({ filter, values });
    if (!db.writeOk) return false;
    const key = decodeURIComponent(/thread_key=eq\.([^&]+)/.exec(filter)?.[1] ?? "");
    const row = db.threads.get(key);
    if (!row) return false;
    db.threads.set(key, { ...row, ...(values as Partial<ThreadRow>) });
    return true;
  },
  sbInsert: async () => true,
  sbSelect: async () => [],
}));

import { persistAlternativeOffer, resolveAlternativeOffer } from "./substitution-store";
import type { AlternativeOffer } from "./substitution";

const EMAIL = "t@example.com";
const VENDOR = "v1";
const KEY = "t@example.com|v1";

const offer: AlternativeOffer = {
  vehicle: "Yamaha Nmax 155",
  engineSizeCc: 155,
  pricePerDay: 220,
  currency: "THB",
  closeness: "acceptable",
  at: 1_700_000_000_000,
};

const seed = (fields: Fields) => {
  db.threads.set(KEY, { thread_key: KEY, user_email: EMAIL, vendor_id: VENDOR, fields });
};

const stored = () => db.threads.get(KEY)?.fields ?? {};

beforeEach(() => {
  db.threads = new Map();
  db.writeOk = true;
  db.readFails = false;
  db.patches = [];
});

describe("F016: resolveAlternativeOffer reports the write, not the intention", () => {
  it("REPRODUCTION: Decline while the PATCH fails -> ok:false, and the choice is still parked", async () => {
    seed({ round: 2, alternativeOffer: offer });
    db.writeOk = false;
    const res = await resolveAlternativeOffer({ email: EMAIL, vendorId: VENDOR, accept: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    // The write was attempted - this is not the stale path...
    expect(db.patches).toHaveLength(1);
    // ...and the durable truth is unchanged: the question is still open and
    // the thread is NOT declined.
    expect(stored().alternativeOffer).toEqual(offer);
    expect(stored().declined).toBeUndefined();
  });

  it("REPRODUCTION: Accept while the PATCH fails -> ok:false, nothing retargeted", async () => {
    seed({ alternativeOffer: offer });
    db.writeOk = false;
    const res = await resolveAlternativeOffer({ email: EMAIL, vendorId: VENDOR, accept: true });
    expect(res.ok).toBe(false);
    expect(stored().acceptedVehicle).toBeUndefined();
    expect(stored().vehicleConfirmation).toBeUndefined();
  });

  it("a persisted Decline clears the choice and declines the thread", async () => {
    seed({ round: 2, alternativeOffer: offer });
    const res = await resolveAlternativeOffer({ email: EMAIL, vendorId: VENDOR, accept: false });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.offer.vehicle).toBe("Yamaha Nmax 155");
    expect(stored().alternativeOffer).toBeNull();
    expect(stored().declined).toBe(true);
    expect(stored().round).toBe(2);
  });

  it("a persisted Accept retargets the thread", async () => {
    seed({ alternativeOffer: offer });
    const res = await resolveAlternativeOffer({ email: EMAIL, vendorId: VENDOR, accept: true });
    expect(res.ok).toBe(true);
    expect(stored().alternativeOffer).toBeNull();
    expect(stored().acceptedVehicle).toBe("Yamaha Nmax 155");
    expect(stored().acceptedVehicleCc).toBe(155);
    expect(stored().vehicleConfirmation).toMatchObject({ status: "confirmed" });
  });

  it("no parked choice is STALE, not a store failure", async () => {
    seed({ round: 1 });
    const res = await resolveAlternativeOffer({ email: EMAIL, vendorId: VENDOR, accept: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("stale");
    expect(db.patches).toHaveLength(0);
  });

  it("an unreadable thread is UNAVAILABLE, not stale", async () => {
    seed({ alternativeOffer: offer });
    db.readFails = true;
    const res = await resolveAlternativeOffer({ email: EMAIL, vendorId: VENDOR, accept: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
  });
});

describe("F016: persistAlternativeOffer returns whether the offer was PARKED", () => {
  it("REPRODUCTION: a failed PATCH is false", async () => {
    seed({ round: 1 });
    db.writeOk = false;
    const ok = await persistAlternativeOffer({ email: EMAIL, vendorId: VENDOR, offer });
    expect(ok).toBe(false);
    expect(stored().alternativeOffer).toBeUndefined();
  });

  it("a landed PATCH is true, and the ask-once guard still holds", async () => {
    seed({ round: 1 });
    expect(await persistAlternativeOffer({ email: EMAIL, vendorId: VENDOR, offer })).toBe(true);
    expect(stored().alternativeOffer).toEqual(offer);
    expect(
      await persistAlternativeOffer({ email: EMAIL, vendorId: VENDOR, offer: { ...offer, vehicle: "Other" } })
    ).toBe(false);
    expect(stored().alternativeOffer).toEqual(offer);
  });
});

describe("F016: /api/negotiate/alternative answers 502 for a write that did not land", () => {
  const post = (body: unknown) =>
    new Request("http://localhost/api/negotiate/alternative", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  async function loadRoute() {
    vi.resetModules();
    vi.doMock("@/lib/session", () => ({
      getSession: async () => ({ email: EMAIL }),
    }));
    const mod = await import("../../app/api/negotiate/alternative/route");
    return mod.POST;
  }

  it("REPRODUCTION: the PATCH fails -> 502 and the choice stays open", async () => {
    seed({ alternativeOffer: offer });
    db.writeOk = false;
    const POST = await loadRoute();
    const res = await POST(post({ vendorId: VENDOR, accept: false }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBeUndefined();
    expect(body.stale).not.toBe(true);
    expect(String(body.error)).toMatch(/try again/i);
    expect(stored().alternativeOffer).toEqual(offer);
  });

  it("a choice that is no longer open stays a 409", async () => {
    seed({ round: 1 });
    const POST = await loadRoute();
    const res = await POST(post({ vendorId: VENDOR, accept: false }));
    expect(res.status).toBe(409);
    expect((await res.json()).stale).toBe(true);
  });

  it("a persisted decision is a 200", async () => {
    seed({ alternativeOffer: offer });
    const POST = await loadRoute();
    const res = await POST(post({ vendorId: VENDOR, accept: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: true, vehicle: "Yamaha Nmax 155" });
  });
});
