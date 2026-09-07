// AUDIT F097 - the reconciled currency was never written back onto the
// extraction, so the STORED media reading kept the model's raw code.
//
// A +66 shop answers with a price-board photo. The vision reader returns
// pricePerDay 250 with currency "USD" (the bare 250 under a baht glyph the
// model missed). agent-loop reconciles that against the shop's own currency
// and writes offers.currency = THB - but `cur` stayed a local const, so
// `readingFrom(extraction)` stamped "USD" onto
// whatsapp_messages.raw.reading.prices[]. The traveller's understanding panel
// then reads "250 USD" under a baht board, and effective-price hands the same
// USD to the card and the booking on every later reply that carries no price.
//
// EXECUTED: the real processVendorReply over a Map-backed PostgREST, plus the
// real effectivePriceFor for the read-side half.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("./runtime-config", async () => {
  const h = await import("./privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "./privacy/postgrest-store.test-helper";
import { processVendorReply } from "./agent-loop";
import { effectivePriceFor } from "./effective-price";

const EMAIL = "traveller@example.com";
const SHOP = "66812345678";
const T0 = Date.parse("2026-09-04T09:00:00.000Z");

/** The vision worker's answer: a real price, the WRONG currency code. */
const BOARD_READ = {
  found: true,
  pricePerDay: 250,
  currency: "USD",
  matchesSpec: true,
  confidence: "high",
  imageRead: true,
  imageKind: "price-list",
  imageSummary: "A printed price board.",
} as unknown as Parameters<typeof processVendorReply>[0]["preExtracted"];

function seedThread() {
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
      raw: {
        sender: EMAIL,
        receiver: EMAIL,
        vendorId: "v-krabi-1",
        vendorName: "Krabi Scooter Rent",
        kind: "rfq",
        // The country-less label the geocoder leaves behind - the currency has
        // to come from the shop's own phone prefix.
        region: "My current location",
        rfq: {
          vehicleClass: "scooter",
          transmission: "automatic",
          durationDays: 3,
          accessories: [],
          fulfillment: "any",
        },
      },
    },
    {
      id: 2,
      wa_message_id: "IN-1",
      direction: "inbound",
      from_number: SHOP,
      to_number: "wd-instance",
      body: "(price board photo)",
      received_at: new Date(T0).toISOString(),
      raw: { sender: EMAIL, receiver: EMAIL },
    },
  ]);
}

/** The stored reading the conversation panel and the card both read back. */
function storedReading(): { prices?: { pricePerDay: number; currency?: string }[] } | undefined {
  const row = store
    .rows("whatsapp_messages")
    .find((r) => r.wa_message_id === "IN-1") as { raw?: Record<string, unknown> } | undefined;
  return row?.raw?.reading as { prices?: { pricePerDay: number; currency?: string }[] } | undefined;
}

beforeEach(() => {
  store.reset();
  (globalThis as { __wheeldeal_users_v2__?: Map<string, unknown> }).__wheeldeal_users_v2__ = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in test");
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("EXECUTED (F097): the stored reading speaks the thread's currency of record", () => {
  it("a board read as USD on a +66 thread is stamped THB, the same code the offer carries", async () => {
    seedThread();
    const send = vi.fn(async () => ({ ok: true as const, id: "x" }));

    await processVendorReply({
      fromDigits: SHOP,
      // No currency token anywhere in the text: reconcileCurrency must fall
      // back to the shop's own currency rather than defend the model's "USD".
      text: "250 per day",
      waMessageId: "IN-1",
      senderEmail: EMAIL,
      remoteJid: `${SHOP}@s.whatsapp.net`,
      preExtracted: BOARD_READ,
      send: send as unknown as Parameters<typeof processVendorReply>[0]["send"],
    }).catch(() => {});

    const reading = storedReading();
    expect(reading?.prices?.length).toBeGreaterThan(0);
    // THE ASSERTION THAT FAILED BEFORE: "USD" under a baht board.
    expect(reading!.prices![0].currency).toBe("THB");

    // ...and the offers row the reconciliation already got right, so the two
    // surfaces cannot disagree about what money this shop quoted.
    const offer = store.rows("offers").find((o) => Number(o.price_per_day) === 250);
    expect(offer?.currency).toBe("THB");
  });

  it("a currency nobody named anywhere stays ABSENT in the reading, never a confident USD", async () => {
    // Same turn, but the shop's number carries no country we can price from
    // and the region names none either: the panel must render nothing rather
    // than invent dollars (the `|| localCur || \"USD\"` last resort belongs to
    // the offers row alone).
    const UNKNOWN = "99912345678";
    store.seed("app_users", [{ email: EMAIL, status: "active", sessions_valid_from: null }]);
    store.seed("whatsapp_messages", [
      {
        id: 1,
        wa_message_id: "OUT-2",
        direction: "outbound",
        from_number: "wd-instance",
        to_number: UNKNOWN,
        body: "Hi, do you have an automatic scooter for 3 days?",
        received_at: new Date(T0 - 3_600_000).toISOString(),
        raw: {
          sender: EMAIL,
          receiver: EMAIL,
          vendorId: "v-unknown-1",
          vendorName: "Unknown Rent",
          kind: "rfq",
          region: "My current location",
          rfq: {
            vehicleClass: "scooter",
            transmission: "automatic",
            // One day, so no package divide can null the price before the
            // reading is stamped - this case is about the CODE, not the number.
            durationDays: 1,
            accessories: [],
            fulfillment: "any",
          },
        },
      },
      {
        id: 2,
        wa_message_id: "IN-2",
        direction: "inbound",
        from_number: UNKNOWN,
        to_number: "wd-instance",
        body: "(price board photo)",
        received_at: new Date(T0).toISOString(),
        raw: { sender: EMAIL, receiver: EMAIL },
      },
    ]);
    const send = vi.fn(async () => ({ ok: true as const, id: "x" }));

    await processVendorReply({
      fromDigits: UNKNOWN,
      text: "250 per day",
      waMessageId: "IN-2",
      senderEmail: EMAIL,
      remoteJid: `${UNKNOWN}@s.whatsapp.net`,
      preExtracted: {
        found: true,
        pricePerDay: 250,
        matchesSpec: true,
        confidence: "high",
        imageRead: true,
        imageKind: "price-list",
      } as unknown as Parameters<typeof processVendorReply>[0]["preExtracted"],
      send: send as unknown as Parameters<typeof processVendorReply>[0]["send"],
    }).catch(() => {});

    const row = store
      .rows("whatsapp_messages")
      .find((r) => r.wa_message_id === "IN-2") as { raw?: Record<string, unknown> } | undefined;
    const reading = row?.raw?.reading as
      | { prices?: { pricePerDay: number; currency?: string }[] }
      | undefined;
    expect(reading?.prices?.length).toBeGreaterThan(0);
    expect(reading!.prices![0].currency).toBeUndefined();
  });
});

describe("EXECUTED (F097): a board row with no currency of its own borrows the row's", () => {
  it("the menu-photo tier falls back to rowCurrency instead of answering null", () => {
    const eff = effectivePriceFor({
      found: false,
      rowPrice: null,
      rowCurrency: "THB",
      threadPrice: null,
      boardPrices: [{ pricePerDay: 250, available: true }],
      durationDays: 3,
    });
    expect(eff?.source).toBe("menu-photo");
    // THE ASSERTION THAT FAILED BEFORE: a null currency here is what the card
    // turns into "$250" via its own `?? "USD"` last resort.
    expect(eff?.currency).toBe("THB");
  });

  it("the board's OWN currency still wins when it has one", () => {
    const eff = effectivePriceFor({
      found: false,
      rowPrice: null,
      rowCurrency: "THB",
      threadPrice: null,
      boardPrices: [{ pricePerDay: 250, available: true, currency: "MYR" }],
      durationDays: 3,
    });
    expect(eff?.currency).toBe("MYR");
  });

  it("the derived menu tier borrows it too", () => {
    const eff = effectivePriceFor({
      found: false,
      rowPrice: null,
      rowCurrency: "THB",
      threadPrice: null,
      boardPrices: null,
      options: [{ pricePerDay: 300, label: "Click 125" }],
      durationDays: 3,
    });
    expect(eff?.source).toBe("menu");
    expect(eff?.currency).toBe("THB");
  });
});
