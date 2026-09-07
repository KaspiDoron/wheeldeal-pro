// AUDIT F136 - the offers-table rival lookup had no declined / out-of-stock
// filter, so a shop that had already withdrawn was still cited as leverage.
//
// Shop B quotes 200 at 10:00 and an `offers` row is written. At 10:20 shop B
// replies "sorry, no bikes for those dates": `fields.shopUnavailable` is set
// and the Redis copy is evicted - but NOTHING deletes or flags the `offers`
// row, and with REDIS_URL unset the Postgres path is the only path. At 10:30
// the traveller taps "Push harder" on shop A (quoting 300): the lookup returns
// 200 and the composed message tells shop A to beat a price from a shop that
// has already refused to rent.
//
// The rule exists one module over - negotiation/session-rivals.ts drops every
// row whose `declined` or `outOfStock` is true - and its comment says the two
// paths "must not disagree about which shops are still in the hunt".
//
// EXECUTED: the real `cheapestRivalQuoteFor` over a Map-backed PostgREST that
// evaluates the query strings the code actually builds, plus the pure
// predicate underneath it.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("./runtime-config", async () => {
  const h = await import("./privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "./privacy/postgrest-store.test-helper";
import { cheapestRivalQuoteFor, pickRival, type RivalOffer } from "./search-session";
import { withdrawnVendorIds } from "./negotiation/session-rivals";
import type { SessionShopRow } from "./graph/types";

const USER = "traveller@example.com";
const VEHICLE = "scooter-125";
const SEARCH_ID = 77;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function offer(vendorId: string, pricePerDay: number) {
  return {
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
  };
}

beforeEach(() => {
  store.reset();
  store.seed("searches", [{ id: SEARCH_ID, user_email: USER, created_at: iso(60 * 60_000) }]);
  // Shop B is the cheapest quote in the hunt; shop C is the next one up.
  store.seed("offers", [offer("shop-b", 200), offer("shop-c", 250)]);
});

const rival = (excludeVendorIds?: string[]) =>
  cheapestRivalQuoteFor(USER, {
    vendorId: "shop-a",
    currency: "THB",
    vehicleKey: VEHICLE,
    belowPrice: 300,
    durationDays: 3,
    excludeVendorIds,
  });

describe("EXECUTED (F136): a withdrawn shop is not a citable rival", () => {
  it("the control: with nobody withdrawn the cheapest quote is the rival", async () => {
    expect((await rival())?.pricePerDay).toBe(200);
  });

  it("a shop the caller knows has withdrawn is skipped, not cited", async () => {
    // THE ASSERTION THAT FAILED BEFORE THE FIX: the offers query filters on
    // user, simulated, currency, vehicle_key, created_at and search_id only,
    // and `pickRival` had no declined / outOfStock / phase concept at all - so
    // the withdrawn shop's 200 came straight back.
    expect((await rival(["shop-b"]))?.pricePerDay).toBe(250);
  });

  it("with every rival withdrawn there is no leverage at all, not a stale one", async () => {
    expect(await rival(["shop-b", "shop-c"])).toBeNull();
  });

  it("the exclusion is a bar, not a preference - it never resurrects a dearer row", async () => {
    // shop-c at 250 is still strictly cheaper than the 300 being negotiated;
    // once it too is barred, the answer is null rather than the 300 itself.
    store.seed("offers", [offer("shop-d", 320)]);
    expect(await rival(["shop-b", "shop-c"])).toBeNull();
  });
});

describe("EXECUTED (F136): the pure predicate honours the bar", () => {
  const offers: RivalOffer[] = [
    { vendorId: "shop-b", pricePerDay: 200, currency: "THB", vehicleKey: VEHICLE, createdAt: iso(0), searchId: SEARCH_ID },
    { vendorId: "shop-c", pricePerDay: 250, currency: "THB", vehicleKey: VEHICLE, createdAt: iso(0), searchId: SEARCH_ID },
  ];
  const args = {
    vendorId: "shop-a",
    currency: "THB",
    vehicleKey: VEHICLE,
    belowPrice: 300,
    sinceIso: iso(3600_000),
    searchId: SEARCH_ID,
  };

  it("pickRival drops an excluded vendor the same way it drops the shop itself", () => {
    expect(pickRival(offers, args)?.pricePerDay).toBe(200);
    expect(pickRival(offers, { ...args, excludeVendorIds: ["shop-b"] })?.pricePerDay).toBe(250);
  });
});

describe("EXECUTED (F136): one rule decides who is still in the hunt", () => {
  const row = (over: Partial<SessionShopRow>): SessionShopRow => ({
    vendorId: "shop-x",
    vendorName: "Shop X",
    pricePerDay: 200,
    currency: "THB",
    ...over,
  });

  it("withdrawnVendorIds names the declined, the out-of-stock and the dead", () => {
    const ids = withdrawnVendorIds([
      row({ vendorId: "declined", declined: true }),
      row({ vendorId: "gone", outOfStock: true }),
      row({ vendorId: "dead-thread", phase: "dead" }),
      row({ vendorId: "closing-thread", phase: "closing" }),
      row({ vendorId: "live", phase: "negotiating" }),
    ]);
    expect([...ids].sort()).toEqual(["closing-thread", "dead-thread", "declined", "gone"]);
  });

  it("a row with no vendor id contributes nothing", () => {
    expect([...withdrawnVendorIds([row({ vendorId: "", declined: true })])]).toEqual([]);
  });
});
