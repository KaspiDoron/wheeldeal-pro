import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT F010 - the app_users rung ladder must report WHICH rung landed, and
// the read-back must not echo a value that never persisted.
//
// mirror() walks three upsert payloads, richest first (stay + consents,
// consents, base), so signup never depends on a pending column migration.
// PostgREST's merge-duplicates only touches the columns present in the body -
// so when the top rung fails once (an 8s abort, a 429, a 5xx) and the second
// lands, the stay_* columns keep their OLD values. mirror() still returned
// true, setUserStay() returned true, and because remember(rec) ran BEFORE the
// write - on the very object getUser had cached - the route's read-back served
// the revoked consent from memory while the database still said "share the
// hotel with shops".
//
// Every test here EXECUTES setUserStay / getUserStay against a Map-backed
// app_users table whose upsert behaves like merge-duplicates.

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

const db: {
  users: Map<string, Row>;
  /** How many withStay attempts (payloads carrying stay_label) fail next. */
  failStayAttempts: number;
  failAll: boolean;
  payloads: Row[];
} = { users: new Map(), failStayAttempts: 0, failAll: false, payloads: [] };

vi.mock("./runtime-config", () => ({
  supabaseConfigured: () => true,
  sbSelectStrict: async (_table: string, query: string) => {
    const email = decodeURIComponent(/email=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const row = db.users.get(email);
    return { rows: row ? [{ ...row }] : [] };
  },
  sbInsert: async (table: string, rows: Row[]) => {
    if (table !== "app_users") return true;
    const payload = rows[0];
    db.payloads.push(payload);
    if (db.failAll) return false;
    if ("stay_label" in payload && db.failStayAttempts > 0) {
      db.failStayAttempts -= 1;
      return false;
    }
    // merge-duplicates: only the columns PRESENT in the body change.
    const key = String(payload.email);
    db.users.set(key, { ...(db.users.get(key) ?? {}), ...payload });
    return true;
  },
  sbSelect: async () => [],
  sbUpdate: async () => true,
  sbDelete: async () => true,
}));

import { setUserStay, getUserStay } from "./access";

const EMAIL = "t@example.com";

const seed = () => {
  db.users.set(EMAIL, {
    email: EMAIL,
    phone: null,
    name: "Tal",
    provider: "email",
    status: "active",
    plan: "free",
    password_hash: null,
    must_change_password: false,
    terms_accepted_at: "2026-08-01T00:00:00Z",
    terms_version: null,
    wa_risk_accepted_at: "2026-08-01T00:00:00Z",
    ai_responsibility_accepted_at: null,
    stay_label: "Sun House Hotel",
    stay_lat: 18.79,
    stay_lng: 98.98,
    stay_share_consent_at: "2026-08-02T00:00:00Z",
    sessions_valid_from: null,
    added_at: "2026-08-01T00:00:00Z",
    last_seen: "2026-08-01T00:00:00Z",
  });
};

beforeEach(() => {
  db.users = new Map();
  db.failStayAttempts = 0;
  db.failAll = false;
  db.payloads = [];
  globalThis.__wheeldeal_users_v2__ = undefined;
  seed();
});

describe("F010: revoking the stay consent reports the truth of the rung that landed", () => {
  it("REPRODUCTION: the top rung fails and a lower rung lands -> false, and the read-back says consent is STILL on", async () => {
    // Two failures: the retry of the top rung fails as well, so the ladder
    // steps down to the consents payload, which carries no stay_* columns.
    db.failStayAttempts = 2;
    const ok = await setUserStay(EMAIL, { label: undefined, shareConsent: false });
    expect(ok).toBe(false);
    // The database still shares the hotel...
    expect(db.users.get(EMAIL)?.stay_share_consent_at).toBe("2026-08-02T00:00:00Z");
    // ...and the read-back the profile route does must say so, not echo the
    // unpersisted revocation from this instance's cache.
    const stay = await getUserStay(EMAIL);
    expect(stay).toEqual({
      label: "Sun House Hotel",
      lat: 18.79,
      lng: 98.98,
      shareConsent: true,
    });
  });

  it("a single blip on the top rung is retried with the SAME payload and lands", async () => {
    db.failStayAttempts = 1;
    const ok = await setUserStay(EMAIL, { label: undefined, shareConsent: false });
    expect(ok).toBe(true);
    expect(db.users.get(EMAIL)?.stay_share_consent_at).toBeNull();
    expect(db.users.get(EMAIL)?.stay_label).toBeNull();
    expect(await getUserStay(EMAIL)).toBeNull();
  });

  it("nothing lands -> false, and the cache does not keep the phantom revocation", async () => {
    db.failAll = true;
    const ok = await setUserStay(EMAIL, { label: undefined, shareConsent: false });
    expect(ok).toBe(false);
    const stay = await getUserStay(EMAIL);
    expect(stay?.shareConsent).toBe(true);
    expect(stay?.label).toBe("Sun House Hotel");
  });

  it("the happy path persists and reads back the revocation", async () => {
    const ok = await setUserStay(EMAIL, { label: undefined, shareConsent: false });
    expect(ok).toBe(true);
    expect(await getUserStay(EMAIL)).toBeNull();
  });

  it("granting consent lands on the top rung with the coordinates", async () => {
    const ok = await setUserStay(EMAIL, {
      label: "Moon Villa",
      lat: 7.9,
      lng: 98.3,
      shareConsent: true,
    });
    expect(ok).toBe(true);
    const row = db.users.get(EMAIL)!;
    expect(row.stay_label).toBe("Moon Villa");
    expect(typeof row.stay_share_consent_at).toBe("string");
    expect(await getUserStay(EMAIL)).toMatchObject({ label: "Moon Villa", lat: 7.9, lng: 98.3, shareConsent: true });
  });
});

describe("F010: /api/profile/update refuses to report a stay save that did not land", () => {
  const post = (body: unknown) =>
    new Request("http://localhost/api/profile/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  async function loadRoute(opts: { saved: boolean }) {
    vi.resetModules();
    vi.doMock("@/lib/session", () => ({
      getSession: async () => ({ email: EMAIL }),
    }));
    const rec = { email: EMAIL, phone: undefined, name: "Tal", provider: "email" };
    vi.doMock("@/lib/access", () => ({
      getUser: async () => rec,
      registerUser: async () => rec,
      setUserStay: async () => opts.saved,
      // The read-back after a failed save is the database truth: still shared.
      getUserStay: async () =>
        opts.saved ? null : { label: "Sun House Hotel", shareConsent: true },
    }));
    const mod = await import("../app/api/profile/update/route");
    return mod.POST;
  }

  it("REPRODUCTION: an unpersisted revocation is a 502, not ok:true", async () => {
    const POST = await loadRoute({ saved: false });
    const res = await POST(post({ shareStayConsent: false, stayLabel: "" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBeUndefined();
    expect(String(body.error)).toMatch(/nothing changed/i);
  });

  it("a persisted save is still a 200 carrying the read-back", async () => {
    const POST = await loadRoute({ saved: true });
    const res = await POST(post({ shareStayConsent: false, stayLabel: "" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; profile: { stayShareConsent: boolean } };
    expect(body.ok).toBe(true);
    expect(body.profile.stayShareConsent).toBe(false);
  });
});
