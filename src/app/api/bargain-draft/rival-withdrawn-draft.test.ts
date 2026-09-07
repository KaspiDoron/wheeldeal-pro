// AUDIT F136, the user-tap half - "Push harder" cited a shop that had already
// withdrawn.
//
// The route is the ONLY source of the rival number it composes with (the
// client hint is recorded and ignored), and it takes that number from the
// `offers` table through `cheapestRivalQuoteFor`. Nothing retires an offers
// row when a shop declines or says it has nothing for those dates - only the
// Redis copy is evicted, and with REDIS_URL unset the Postgres path is the
// only path. So the draft could tell shop A to beat 200 from a shop that had
// refused to rent, and the target is computed to UNDERCUT that dead number.
//
// This is a user tap, not the 72s turn wall, so it can afford the one bounded
// `negotiation_threads` read that says who is still in the hunt.
//
// EXECUTED: the real POST handler over a Map-backed PostgREST, with the real
// search-session lookup underneath it; only the composer is stubbed, to record
// the rival it was handed.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "traveller@example.com", plan: "ultra" }),
}));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

/** What the route handed the composer on the last call. */
const composed: { rival?: number; target?: number }[] = [];

vi.mock("@/lib/agents", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agents")>("@/lib/agents");
  return {
    ...actual,
    runSafety: async () => ({ allowed: true, reason: "" }),
    composeBargain: async (opts: { rivalPricePerDay?: number; targetPricePerDay?: number }) => {
      composed.push({ rival: opts.rivalPricePerDay, target: opts.targetPricePerDay });
      return { message: "Hi! Any better price for the three days?", tacticId: "t", tacticLabel: "T" };
    },
  };
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { POST } from "./route";

const USER = "traveller@example.com";
const RFQ = {
  vehicleClass: "scooter",
  engineSizeCc: 125,
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "pickup",
};
/** vehicleKeyFor(RFQ) - the bucket every offers row in this hunt is stamped with. */
const VEHICLE = "scooter-125";
const SEARCH_ID = 91;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const offerRow = (vendorId: string, pricePerDay: number) => ({
  user_email: USER,
  vendor_id: vendorId,
  vendor_name: `Shop ${vendorId}`,
  price_per_day: pricePerDay,
  currency: "THB",
  vehicle_key: VEHICLE,
  effective_daily_rate: null,
  quote_basis_days: null,
  simulated: false,
  search_id: SEARCH_ID,
  created_at: iso(20 * 60_000),
});

const threadRow = (vendorId: string, fields: Record<string, unknown>) => ({
  thread_key: `${USER}:6681000${vendorId.length}`,
  user_email: USER,
  vendor_id: vendorId,
  to_number: "6681000111",
  phase: "collecting_terms",
  fields,
  updated_at: iso(5 * 60_000),
});

const pushHarder = () =>
  POST(
    new Request("http://local/api/bargain-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendor: { id: "shop-a", name: "Shop A", whatsapp: "+66 81 234 5678" },
        rfq: RFQ,
        region: "Chiang Mai, Thailand",
        currentPricePerDay: 300,
        round: 1,
      }),
    })
  );

beforeEach(() => {
  store.reset();
  composed.length = 0;
  store.seed("searches", [{ id: SEARCH_ID, user_email: USER, created_at: iso(60 * 60_000) }]);
  store.seed("offers", [offerRow("shop-b", 200), offerRow("shop-c", 250)]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in test");
    })
  );
});

describe("EXECUTED (F136): Push harder never cites a shop that withdrew", () => {
  it("the control: with both rivals still renting, the cheapest is cited", async () => {
    store.seed("negotiation_threads", [threadRow("shop-b", {}), threadRow("shop-c", {})]);
    const res = await pushHarder();
    expect(res.status).toBe(200);
    expect(composed[0].rival).toBe(200);
  });

  it("a shop whose thread says DECLINED is skipped, and the next real quote is used", async () => {
    store.seed("negotiation_threads", [
      threadRow("shop-b", { declined: true, pricePerDay: 200 }),
      threadRow("shop-c", { pricePerDay: 250 }),
    ]);
    const res = await pushHarder();
    expect(res.status).toBe(200);
    // THE ASSERTION THAT FAILED BEFORE THE FIX: the offers row for shop-b was
    // never retired, so the draft was composed against a dead 200.
    expect(composed[0].rival).toBe(250);
  });

  it("a shop that has nothing for these dates is skipped the same way", async () => {
    store.seed("negotiation_threads", [
      threadRow("shop-b", { shopUnavailable: true, pricePerDay: 200 }),
      threadRow("shop-c", { pricePerDay: 250 }),
    ]);
    await pushHarder();
    expect(composed[0].rival).toBe(250);
  });

  it("with every rival withdrawn the draft carries NO rival, not a stale one", async () => {
    store.seed("negotiation_threads", [
      threadRow("shop-b", { declined: true }),
      threadRow("shop-c", { shopUnavailable: true }),
    ]);
    await pushHarder();
    expect(composed[0].rival).toBeUndefined();
    // ...and the target falls back to the ordinary cut of the quote rather
    // than being computed to undercut a number nobody will honour.
    expect(composed[0].target).toBe(255);
  });

  it("an UNREADABLE ledger fails closed: no rival, rather than an unverified one", async () => {
    // Honest degradation. A store that cannot answer "who is still in the
    // hunt" must not be read as "nobody has withdrawn" - that is the confident
    // zero this repo bans - and it must not 500 the tap either. The draft goes
    // out without leverage.
    store.seed("negotiation_threads", [threadRow("shop-b", { declined: true })]);
    store.unavailable.add("negotiation_threads");
    const res = await pushHarder();
    expect(res.status).toBe(200);
    expect(composed).toHaveLength(1);
    expect(composed[0].rival).toBeUndefined();
  });
});
