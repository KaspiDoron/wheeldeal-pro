// AUDIT F094 - the manual Bargain / Push-harder route resolved USD from the
// REGION ALONE, so a Thai shop was asked for dollars and every rival dropped.
//
// The traveller taps "use my current location", the reverse geocode does not
// return, and the label stays the literal "My current location". They tap
// "Push harder" on a +66 shop: `currencyForRegion(region)` matches no country
// token, the route fell to "USD", composeBargain emitted a dollar ask under a
// money rule swearing dollars were local, and the server-authoritative rival
// lookup queried `currency=eq.USD` while every offer in the hunt is stamped
// THB - so the cross-shop leverage the route exists for came back empty.
//
// EXECUTED: the real POST handler over a Map-backed PostgREST (the currency it
// hands to the composer and to the rival lookup is captured), plus the real
// composeBargain for the `|| "USD"` default the fix has to remove with it.

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
const composed: { currency?: string; region?: string; target?: number }[] = [];

vi.mock("@/lib/agents", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agents")>("@/lib/agents");
  return {
    ...actual,
    runSafety: async () => ({ allowed: true, reason: "" }),
    composeBargain: async (opts: {
      currency?: string;
      region?: string;
      targetPricePerDay?: number;
    }) => {
      composed.push({
        currency: opts.currency,
        region: opts.region,
        target: opts.targetPricePerDay,
      });
      return { message: "Hi! Any better price for the 3 days?", tacticId: "t", tacticLabel: "T" };
    },
  };
});

/** What the route handed the server-authoritative rival lookup. */
const rivalLookups: { currency?: string }[] = [];

vi.mock("@/lib/search-session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/search-session")>(
    "@/lib/search-session"
  );
  return {
    ...actual,
    cheapestRivalQuoteFor: async (_email: string, args: { currency: string }) => {
      rivalLookups.push({ currency: args.currency });
      return null;
    },
  };
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { POST } from "./route";

const RFQ = {
  vehicleClass: "scooter",
  engineSizeCc: 125,
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "pickup",
};

/** The label the geocoder leaves behind when it does not return. */
const PIN = "My current location";

const push = (region: string | undefined, whatsapp: string) =>
  POST(
    new Request("http://local/api/bargain-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendor: { id: "v-krabi-1", name: "Krabi Scooter Rent", whatsapp },
        rfq: RFQ,
        region,
        currentPricePerDay: 250,
        round: 0,
      }),
    })
  );

beforeEach(() => {
  store.reset();
  composed.length = 0;
  rivalLookups.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in test");
    })
  );
});

describe("EXECUTED (F094): the manual bargain speaks the shop's money", () => {
  it("a country-less label plus a +66 shop composes in THB, not USD", async () => {
    const res = await push(PIN, "+66 81 234 5678");
    expect(res.status).toBe(200);
    expect(composed).toHaveLength(1);
    // THE ASSERTION THAT FAILED BEFORE: the route resolved "USD" from the
    // label alone and asked a Thai shop for dollars.
    expect(composed[0].currency).toBe("THB");
  });

  it("...and the rival lookup queries THB, so the hunt's own offers are visible", async () => {
    await push(PIN, "+66 81 234 5678");
    expect(rivalLookups).toHaveLength(1);
    expect(rivalLookups[0].currency).toBe("THB");
  });

  it("a region that DOES name a country still wins over the prefix", async () => {
    await push("Bali, Indonesia", "+66 81 234 5678");
    expect(composed[0].currency).toBe("IDR");
  });

  it("a currency nothing can resolve is left UNSET, and no rival is looked up", async () => {
    // Neither the label nor the prefix names a country: a comparison with no
    // currency is not leverage, and a dollar ask is a lie.
    await push(PIN, "+999 12 345 678");
    expect(composed).toHaveLength(1);
    expect(composed[0].currency).toBeUndefined();
    expect(rivalLookups).toHaveLength(0);
  });
});

describe("EXECUTED (F094): composeBargain never invents dollars of its own", () => {
  it("with no currency anywhere, the draft carries bare numbers and no dollar sign", async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents")>("@/lib/agents");
    const draft = await actual.composeBargain({
      rfq: RFQ as never,
      vendor: { name: "Krabi Scooter Rent" } as never,
      currentPricePerDay: 250,
      region: PIN,
      round: 0,
    });
    // THE ASSERTION THAT FAILED BEFORE: agents.ts's own `|| "USD"` made the
    // fix inert - `money(213)` printed "$213" into the shop's message.
    expect(draft.message).not.toContain("$");
    expect(draft.message).not.toMatch(/\bUSD\b/);
  });

  it("with a currency, the draft still names it exactly as before", async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents")>("@/lib/agents");
    const draft = await actual.composeBargain({
      rfq: RFQ as never,
      vendor: { name: "Krabi Scooter Rent" } as never,
      currentPricePerDay: 250,
      region: PIN,
      currency: "THB",
      round: 0,
    });
    expect(draft.message).toMatch(/฿/);
  });
});
