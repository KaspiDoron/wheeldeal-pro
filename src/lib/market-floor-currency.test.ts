// AUDIT F095 - the floor chain diverged from the currency chain for a
// country-less region label, so every price-sanity net went dark.
//
// The traveller taps "use my current location", the reverse geocode does not
// return, and the label stays the literal "My current location" (or a raw
// "8.0000, 98.0000" pin). The reply path resolves the currency from the SHOP'S
// PHONE PREFIX and gets THB - while `floorPriceFor` was handed the label alone,
// `currencyForRegion` matched nothing in it, and `defaultFloor` fell to its USD
// baseline. `floor.currency === cur` was then false, `floorSameCur` was null,
// and the total-vs-per-day divide, the implausible-price rail and the
// credible-floor clamp were all skipped - for exactly the labels the comment
// above them names.
//
// EXECUTED against the real `floorPriceFor` over a Map-backed PostgREST.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
// Only the two network-touching readers are stubbed; every other export stays
// real so the modules under test link exactly as they do in production.
vi.mock("./ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai")>()),
  chat: async () => "",
  chatGrounded: async () => ({ text: "", citations: [] }),
}));
vi.mock("./runtime-config", async () => {
  const h = await import("./privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "./privacy/postgrest-store.test-helper";
import { floorPriceFor } from "./market";
import { processVendorReply } from "./agent-loop";
import type { StructuredRFQ } from "./types";

const SCOOTER = {
  vehicleClass: "scooter",
  engineSizeCc: 125,
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "pickup",
} as unknown as StructuredRFQ;

// The two labels the geocoder actually leaves behind when it fails.
const PIN = "My current location";
const RAW = "8.0000, 98.0000";

beforeEach(() => {
  store.reset();
  (globalThis as { __wheeldeal_users_v2__?: Map<string, unknown> }).__wheeldeal_users_v2__ =
    new Map();
});

describe("F095: the floor speaks the thread's currency, or it says nothing", () => {
  it("EXECUTED: a country-less label plus the shop's country resolves a THB floor, not a USD one", async () => {
    // No stored rows at all: this is the deterministic seed path.
    const floor = await floorPriceFor(PIN, SCOOTER, {
      currency: "THB",
      countryRegion: "Thailand",
    });
    expect(floor?.currency).toBe("THB");
    expect(floor!.floor).toBeGreaterThan(100);
  });

  it("EXECUTED: a raw pin label behaves the same", async () => {
    const floor = await floorPriceFor(RAW, SCOOTER, {
      currency: "THB",
      countryRegion: "Thailand",
    });
    expect(floor?.currency).toBe("THB");
  });

  it("EXECUTED: the STORED country row is found through the country fallback", async () => {
    store.seed("market_floor_prices", [
      {
        region_key: "thailand",
        vehicle_key: "scooter-125",
        currency: "THB",
        floor_per_day: 222,
        typical_per_day: 340,
        updated_at: new Date().toISOString(),
      },
    ]);
    const floor = await floorPriceFor(PIN, SCOOTER, {
      currency: "THB",
      countryRegion: "Thailand",
    });
    expect(floor).toEqual({ floor: 222, typical: 340, currency: "THB" });
  });

  it("EXECUTED: the AREA row still wins over the country row", async () => {
    // The fixConcern: the country keys are an ADDITIONAL set, never a swap -
    // an area row for "Ao Nang, Thailand" must not be discarded.
    store.seed("market_floor_prices", [
      {
        region_key: "thailand",
        vehicle_key: "scooter-125",
        currency: "THB",
        floor_per_day: 222,
        typical_per_day: 340,
        updated_at: new Date().toISOString(),
      },
      {
        region_key: "ao nang, thailand",
        vehicle_key: "scooter-125",
        currency: "THB",
        floor_per_day: 265,
        typical_per_day: 400,
        updated_at: new Date().toISOString(),
      },
    ]);
    const floor = await floorPriceFor("Ao Nang, Thailand", SCOOTER, {
      currency: "THB",
      countryRegion: "Thailand",
    });
    expect(floor?.floor).toBe(265);
  });

  it("EXECUTED: a currency the conversion table does not know returns NULL, not an invented number", async () => {
    // The other half of the fixConcern: converting the USD baseline through a
    // crude fx map for a currency it is missing invents a floor. Absent beats
    // wrong - the caller then has no floor rather than a false one.
    const floor = await floorPriceFor(PIN, SCOOTER, {
      currency: "XOF",
      countryRegion: "Senegal",
    });
    expect(floor).toBe(null);
  });

  it("EXECUTED: with no currency argument the old region-only behaviour is unchanged", async () => {
    const floor = await floorPriceFor("Krabi, Thailand", SCOOTER);
    expect(floor?.currency).toBe("THB");
  });
});

// ---------------------------------------------------------------------------
// THE CALL SITES, PROVEN BY EXECUTION.
//
// The first round pinned agent-loop.ts and graph/engine.ts with a readFileSync
// grep for the `floorPriceFor(floorRegion, rfq, { currency: cur,` shape. A
// grep cannot tell whether the value that reaches the floor is the currency
// this thread actually resolved, and it goes green on a file that never runs.
// Both sites are reachable over the Map-backed PostgREST, so both are driven
// here instead: the live inbound turn through `processVendorReply`, and the
// failover engine's tick input through `buildTurnFromThread`.
// ---------------------------------------------------------------------------

const EMAIL = "traveller@example.com";
/** A +66 shop: the country - and so the currency - is only in the prefix. */
const SHOP = "66812345678";
const T0 = Date.parse("2026-09-04T09:00:00.000Z");

/** The label the geocoder leaves behind when the reverse lookup does not return. */
const RFQ_RAW = {
  sender: EMAIL,
  receiver: EMAIL,
  vendorId: "v-krabi-1",
  vendorName: "Krabi Scooter Rent",
  kind: "rfq",
  region: PIN,
  rfq: {
    vehicleClass: "scooter",
    transmission: "automatic",
    durationDays: 3,
    accessories: [],
    fulfillment: "any",
  },
};

function seedThread(): void {
  store.seed("app_users", [{ email: EMAIL, status: "active", sessions_valid_from: null }]);
  store.seed("whatsapp_messages", [
    {
      id: 1,
      wa_message_id: "OUT-1",
      direction: "outbound",
      from_number: "wd-instance",
      to_number: SHOP,
      body: "Hi, do you have an automatic scooter for 3 days?",
      received_at: new Date(T0 - 3_600_000).toISOString(),
      raw: RFQ_RAW,
    },
    {
      id: 2,
      wa_message_id: "IN-1",
      direction: "inbound",
      from_number: SHOP,
      to_number: "wd-instance",
      body: "900",
      received_at: new Date(T0).toISOString(),
      raw: { sender: EMAIL, receiver: EMAIL },
    },
  ]);
}

describe("EXECUTED (F095): the live reply turn arms the price-sanity nets", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in test");
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a bare total from a +66 shop under a country-less label is divided, not banked per day", async () => {
    seedThread();
    const send = vi.fn(async () => ({ ok: true as const, id: "x" }));

    await processVendorReply({
      // "900" carries no span of its own, so the deterministic reader cannot
      // divide it - the TOTAL-vs-PER-DAY net is the only thing standing
      // between the traveller and a 900 THB/day scooter, and that net is gated
      // on a floor denominated in this thread's currency.
      fromDigits: SHOP,
      text: "900",
      waMessageId: "IN-1",
      senderEmail: EMAIL,
      remoteJid: `${SHOP}@s.whatsapp.net`,
      preExtracted: {
        found: true,
        pricePerDay: 900,
        matchesSpec: true,
        confidence: "high",
      } as unknown as Parameters<typeof processVendorReply>[0]["preExtracted"],
      send: send as unknown as Parameters<typeof processVendorReply>[0]["send"],
    }).catch(() => {});

    const offers = store.rows("offers");
    expect(offers.length).toBeGreaterThan(0);
    // THE ASSERTION THAT FAILED BEFORE: 900 was banked as the daily rate,
    // because the floor came back USD 5 while the price of record was THB.
    expect(Number(offers[0].price_per_day)).toBe(300);
    expect(offers[0].currency).toBe("THB");
  });

  it("and no floor-currency-mismatch breadcrumb is written for that thread", async () => {
    seedThread();
    const send = vi.fn(async () => ({ ok: true as const, id: "x" }));

    await processVendorReply({
      fromDigits: SHOP,
      text: "900",
      waMessageId: "IN-1",
      senderEmail: EMAIL,
      remoteJid: `${SHOP}@s.whatsapp.net`,
      preExtracted: {
        found: true,
        pricePerDay: 900,
        matchesSpec: true,
        confidence: "high",
      } as unknown as Parameters<typeof processVendorReply>[0]["preExtracted"],
      send: send as unknown as Parameters<typeof processVendorReply>[0]["send"],
    }).catch(() => {});

    const mismatches = store
      .rows("agent_events")
      .filter((e) => e.kind === "floor-currency-mismatch");
    expect(mismatches).toEqual([]);
  });
});

describe("EXECUTED (F095): the failover engine's tick resolves the same floor", () => {
  it("buildTurnFromThread hands the engine a THB floor instead of an undefined one", async () => {
    seedThread();
    store.seed("offers", [
      {
        id: 1,
        user_email: EMAIL,
        vendor_id: "v-krabi-1",
        vendor_name: "Krabi Scooter Rent",
        price_per_day: 300,
        currency: "THB",
        created_at: new Date(T0).toISOString(),
      },
    ]);

    const { buildTurnFromThread } = await import("./graph/engine");
    const input = await buildTurnFromThread(`${EMAIL}:${SHOP}`, "tick");

    expect(input).not.toBe(null);
    expect(input!.currency).toBe("THB");
    // THE ASSERTION THAT FAILED BEFORE: floorSameCur was null on every tick for
    // this label, so the engine negotiated with no floor at all.
    expect(typeof input!.floorPrice).toBe("number");
    expect(input!.floorPrice).toBeGreaterThan(100);
  });
});
