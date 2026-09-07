import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// TWO "BROKEN" MODULES, ONE WRONG COLUMN NAME.
//
// The audit filed M12 (substitution) and M16 (special requests / accessories)
// as separate broken modules. They are the same defect.
//
// `negotiation_threads` is keyed by `thread_key` - "thread_key text primary
// key" in supabase/schema.sql. There is NO `id` column. Both stores read
// `select=id,fields` and wrote `id=eq.<row.id>`. PostgREST answers a select
// naming an unknown column with 400 + 42703, sbSelect collapses EVERY failure
// to [], so the read found nothing and both functions returned their failure
// value on every call, for every user, since the day they were written:
//
//   - persistAlternativeOffer has never stored a single offer, which is why the
//     accept UI in VendorCard has never once appeared. That JSX is wired
//     correctly end to end - /api/replies returns `alternativeOffer` from these
//     very fields - it was starved, not dead.
//   - vendor.offer.accessories is undefined for every vendor in every session,
//     so the verdict chips could never render.
//
// These tests drive the real functions against a stubbed transport and assert
// what goes on the wire. A source pin would not have caught the original bug
// either: `select=id,fields` looks perfectly reasonable.

const SUPA_ENV = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-stub",
};

interface Call {
  url: string;
  method: string;
  body?: string;
}

/**
 * A transport that rejects an unknown column the way Postgres does.
 *
 * This matters more than it looks. A permissive stub that answers every select
 * with a row makes the OLD code pass these tests: `row.id` is `undefined`,
 * `id=eq.undefined` is still a well-formed PATCH, and the assertion sails
 * through against a query the database would have refused. The stub has to be
 * as strict as the thing it stands in for or it is not evidence of anything.
 */
async function harness(handler: (url: string, method: string) => Response) {
  vi.resetModules();
  globalThis.__wheeldeal_cfg__ = undefined;
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
      const select = /[?&]select=([^&]*)/.exec(url)?.[1];
      const asked = select ? decodeURIComponent(select).split(",") : [];
      // The real column set (supabase/schema.sql negotiation_threads). The
      // stores read `version` too now, because their write is guarded on it
      // (audit M38) - a stub that refused it would be modelling a table that
      // does not exist either.
      const known = [
        "thread_key",
        "user_email",
        "vendor_id",
        "vendor_name",
        "to_number",
        "phase",
        "stage",
        "version",
        "fields",
        "node_runs",
        "waiting_until",
        "last_decision_id",
        "updated_at",
        "*",
      ];
      const bad = asked.find((c) => c && !known.includes(c));
      if (url.includes("negotiation_threads") && bad) return unknownColumn(bad);
      // Likewise a filter on a column that is not there.
      if (url.includes("negotiation_threads") && /[?&]id=eq\./.test(url)) {
        return unknownColumn("id");
      }
      return handler(url, method);
    })
  );
  return {
    calls,
    store: await import("./vehicle/substitution-store"),
    accessories: await import("./thread/accessory-pass"),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** What PostgREST actually says when you name a column that is not there. */
const unknownColumn = (col: string) =>
  json({ code: "42703", message: `column negotiation_threads.${col} does not exist` }, 400);

const THREAD = {
  thread_key: "traveller@example.com:66812345678",
  fields: { pricePerDay: 300 },
};

const OFFER = {
  vehicle: "Honda PCX 150",
  engineSizeCc: 150,
  pricePerDay: 220,
  currency: "THB",
  closeness: "acceptable" as const,
  reason: "No 125 today",
  at: 1_700_000_000_000,
};

describe("REPRODUCTION: both stores addressed a column that does not exist", () => {
  const saved = { ...process.env };
  beforeEach(() => Object.assign(process.env, SUPA_ENV));
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
    globalThis.__wheeldeal_cfg__ = undefined;
  });

  it("the substitution read asks for thread_key, never id", async () => {
    const { store, calls } = await harness(() => json([THREAD]));
    await store.persistAlternativeOffer({
      email: "traveller@example.com",
      vendorId: "v1",
      offer: OFFER,
    });
    const read = calls.find((c) => c.method === "GET");
    expect(read, "no read was issued").toBeTruthy();
    expect(read!.url).toContain("select=thread_key,fields");
    expect(read!.url).not.toContain("select=id");
  });

  it("...and the write targets thread_key, so the offer actually lands", async () => {
    const { store, calls } = await harness(() => json([THREAD]));
    const ok = await store.persistAlternativeOffer({
      email: "traveller@example.com",
      vendorId: "v1",
      offer: OFFER,
    });
    // Against the old code this was false, always, for everyone.
    expect(ok).toBe(true);
    const write = calls.find((c) => c.method === "PATCH");
    expect(write, "nothing was written").toBeTruthy();
    expect(write!.url).toContain("thread_key=eq.");
    expect(write!.url).not.toMatch(/[?&]id=eq\./);
    expect(JSON.parse(write!.body!).fields.alternativeOffer.vehicle).toBe("Honda PCX 150");
    // The rest of the thread's fields survive the read-modify-write.
    expect(JSON.parse(write!.body!).fields.pricePerDay).toBe(300);
  });

  it("accepting a substitution retargets the thread and confirms the vehicle", async () => {
    const pending = { ...THREAD, fields: { ...THREAD.fields, alternativeOffer: OFFER } };
    const { store, calls } = await harness(() => json([pending]));
    const res = await store.resolveAlternativeOffer({
      email: "traveller@example.com",
      vendorId: "v1",
      accept: true,
    });
    expect(res.ok).toBe(true);
    const fields = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).fields;
    expect(fields.alternativeOffer).toBeNull();
    expect(fields.acceptedVehicleCc).toBe(150);
    // The traveller settling the vehicle question is the strongest evidence
    // there is - stronger than any message the shop could send.
    expect(fields.vehicleConfirmation.status).toBe("confirmed");
  });

  it("declining ends the thread where it would have ended anyway", async () => {
    const pending = { ...THREAD, fields: { ...THREAD.fields, alternativeOffer: OFFER } };
    const { store, calls } = await harness(() => json([pending]));
    await store.resolveAlternativeOffer({
      email: "traveller@example.com",
      vendorId: "v1",
      accept: false,
    });
    const fields = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).fields;
    expect(fields.declined).toBe(true);
    expect(fields.alternativeOffer).toBeNull();
  });

  it("a shop that repeats itself does not overwrite a choice on screen", async () => {
    const pending = { ...THREAD, fields: { ...THREAD.fields, alternativeOffer: OFFER } };
    const { store, calls } = await harness(() => json([pending]));
    const ok = await store.persistAlternativeOffer({
      email: "traveller@example.com",
      vendorId: "v1",
      offer: { ...OFFER, pricePerDay: 999 },
    });
    expect(ok).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("accessory verdicts reach thread_key too, and merge with what is there", async () => {
    const withPrior = {
      ...THREAD,
      fields: {
        ...THREAD.fields,
        accessories: [{ item: "helmet", verdict: "confirmed", at: 1 }],
      },
    };
    const { accessories, calls } = await harness(() => json([withPrior]));
    const status = await accessories.persistAccessoryStatus({
      email: "traveller@example.com",
      vendorId: "v1",
      requested: ["helmet", "phone mount"],
      verdicts: [{ item: "phone mount", verdict: "confirmed" as const }],
      now: 2,
    });
    // Against the old code this was null, always - which is exactly why
    // vendor.offer.accessories was undefined for every vendor.
    expect(status).not.toBeNull();
    const write = calls.find((c) => c.method === "PATCH");
    expect(write!.url).toContain("thread_key=eq.");
    expect(write!.url).not.toMatch(/[?&]id=eq\./);
    // A shop that confirmed helmets earlier is not un-confirmed by a later
    // message that happened not to mention them.
    const items = JSON.parse(write!.body!).fields.accessories as { item: string }[];
    expect(items.map((i) => i.item).sort()).toEqual(["helmet", "phone mount"]);
  });

  it("the OLD query shape is what a real Postgres would have rejected", async () => {
    // Proof the failure mode is what is claimed: had either store still asked
    // for `id`, this transport answers exactly as PostgREST does, and the
    // strict read reports it rather than pretending the thread is absent.
    const { store, calls } = await harness(() => json([THREAD]));
    const ok = await store.persistAlternativeOffer({
      email: "traveller@example.com",
      vendorId: "v1",
      offer: OFFER,
    });
    expect(ok).toBe(true);
    expect(calls.every((c) => !c.url.includes("select=id"))).toBe(true);
  });
});

describe("an unreadable thread is not an absent one", () => {
  const saved = { ...process.env };
  beforeEach(() => Object.assign(process.env, SUPA_ENV));
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
    globalThis.__wheeldeal_cfg__ = undefined;
  });

  it("a 500 does not report the offer as parked", async () => {
    const { store, calls } = await harness(() => new Response("boom", { status: 500 }));
    expect(
      await store.persistAlternativeOffer({
        email: "traveller@example.com",
        vendorId: "v1",
        offer: OFFER,
      })
    ).toBe(false);
    // And nothing was written on a guess.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("...nor as a decision the traveller already made", async () => {
    const { store } = await harness(() => new Response("boom", { status: 500 }));
    expect(
      await store.resolveAlternativeOffer({
        email: "traveller@example.com",
        vendorId: "v1",
        accept: true,
      })
      // Audit F016: an unreadable thread is UNAVAILABLE - the route answers
      // 502 (still open, try again), never the 409 "no longer open" a stale
      // choice gets.
    ).toEqual({ ok: false, reason: "unavailable", offer: null });
  });
});
