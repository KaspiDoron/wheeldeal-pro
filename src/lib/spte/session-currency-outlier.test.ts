// AUDIT F096 - the dominant-currency rescue in buildSession could not fire,
// because this shop's own mis-stamped row was counted in the tally it tested.
//
// A Krabi hunt: A, B and C are stamped THB at 250, 280 and 300. Shop D - also
// on a +66 number - answers "RM 300 per day", `reconcileCurrency` keeps MYR
// because the token really is there, and D's thread row is stamped MYR. On D's
// next turn the guard asked `!tally.has(input.currency)` over a row set that
// ALWAYS contains D itself, so it was false, `compareCur` stayed MYR,
// `validRivals` dropped A, B and C on strict currency equality and
// `sessionFloor` handed back D's own 300 as the session low. The most
// expensive shop in the hunt was negotiated with zero rivals and a floor equal
// to its own quote - the exact failure the comment two lines above claims to
// have closed.
//
// EXECUTED: the real runSpteLiveTurn over the live.test.ts GraphIO harness,
// reading the rival count and session low off the turn's own telemetry.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async () => ({ text: null }),
  extractJson: () => null,
}));

import { runSpteLiveTurn } from "./live";
import type { GraphIO, GraphTurnInput, SessionShopRow } from "../graph/types";

/** The three THB shops in the hunt, plus THIS shop's own row. */
function hunt(thisShop: Partial<SessionShopRow>): SessionShopRow[] {
  return [
    { vendorId: "v-d", vendorName: "Shop D", isThisShop: true, ...thisShop },
    { vendorId: "v-a", vendorName: "Shop A", pricePerDay: 250, currency: "THB" },
    { vendorId: "v-b", vendorName: "Shop B", pricePerDay: 280, currency: "THB" },
    { vendorId: "v-c", vendorName: "Shop C", pricePerDay: 300, currency: "THB" },
  ] as SessionShopRow[];
}

function mockIo(rows: SessionShopRow[]) {
  const events: Array<{ kind: string; detail: string }> = [];
  const io = {
    now: () => 1_000_000,
    sessionTable: async () => rows,
    guardAndSend: async ({ text }: { text: string }) => ({
      delivered: "sent" as const,
      detail: "ok",
      finalText: text,
    }),
    queueOutbox: async () => {},
    insertWakeup: async () => {},
    recordEvent: async ({ kind, detail }: { kind: string; detail: string }) => {
      events.push({ kind, detail });
    },
    writeTrace: async () => {},
  } as unknown as GraphIO;
  return { io, events };
}

function input(partial: Partial<GraphTurnInput> = {}): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "user@x.com:66812345678",
      userEmail: "user@x.com",
      // A THAI number: the shop's own prefix is the evidence that its MYR
      // stamp is the outlier, not a genuine foreign quote.
      toDigits: "66812345678",
      shopMessage: "RM 300 per day",
      images: [],
      audios: [],
    },
    ctx: {
      sender: "user@x.com",
      vendorId: "v-d",
      vendorName: "Shop D",
      region: "Krabi, Thailand",
      rfq: null,
    },
    rfq: {
      vehicleClass: "scooter",
      engineSizeCc: 125,
      transmission: "any",
      durationDays: 4,
      accessories: [],
      fulfillment: "any",
      vendorMessage: "",
    },
    extraction: {
      found: true,
      pricePerDay: 300,
      currency: "MYR",
      matchesSpec: true,
      confidence: "high",
    },
    usablePrice: 300,
    currency: "MYR",
    sessionClosed: false,
    history: "",
    priorOutbound: ["Hi! Do you have a 125cc scooter for 4 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    deadlineAt: 1_045_000,
    ...partial,
  } as GraphTurnInput;
}

/** What the turn recorded about the session it negotiated against. */
function turnDetail(events: Array<{ kind: string; detail: string }>) {
  const row = events.find((e) => e.kind === "engine-v3-turn");
  expect(row, "the turn must record engine-v3-turn").toBeTruthy();
  return JSON.parse(row!.detail) as { rivals: number; lowest: number | null };
}

describe("EXECUTED (F096): one mis-stamped thread cannot blind itself to its own hunt", () => {
  it("a +66 shop stamped MYR among three THB shops still sees them as rivals", async () => {
    const { io, events } = mockIo(hunt({ pricePerDay: 300, currency: "MYR" }));
    await runSpteLiveTurn(input(), io);
    const d = turnDetail(events);
    // THE ASSERTIONS THAT FAILED BEFORE: zero rivals, and a session low equal
    // to this shop's own quote.
    expect(d.rivals).toBe(3);
    expect(d.lowest).toBe(250);
  });

  it("a GENUINELY foreign shop is still never compared across currencies", async () => {
    // Same hunt, but shop D is on a MALAYSIAN number: its MYR stamp agrees with
    // its own prefix, so nothing is suspect and strict equality must hold - a
    // cross-currency comparison would invent leverage out of an exchange rate
    // nobody applied.
    const { io, events } = mockIo(hunt({ pricePerDay: 300, currency: "MYR" }));
    await runSpteLiveTurn(
      input({
        event: {
          kind: "inbound-text",
          threadKey: "user@x.com:60123456789",
          userEmail: "user@x.com",
          toDigits: "60123456789",
          shopMessage: "RM 300 per day",
          images: [],
          audios: [],
        },
        ctx: {
          sender: "user@x.com",
          vendorId: "v-d",
          vendorName: "Shop D",
          region: undefined,
          rfq: null,
        },
      }),
      io
    );
    const d = turnDetail(events);
    expect(d.rivals).toBe(0);
    expect(d.lowest).toBe(300);
  });

  it("a thread that AGREES with the session is unchanged - every rival is kept", async () => {
    const { io, events } = mockIo(hunt({ pricePerDay: 320, currency: "THB" }));
    await runSpteLiveTurn(input({ currency: "THB" }), io);
    const d = turnDetail(events);
    expect(d.rivals).toBe(3);
    expect(d.lowest).toBe(250);
  });

  it("a single stray row cannot move the comparison - the two-row bar holds", async () => {
    // Only ONE other shop, and it disagrees with this thread's stamp: one row
    // is not a majority, so nothing is adopted and the strict filter stands.
    const rows = [
      { vendorId: "v-d", vendorName: "Shop D", isThisShop: true, pricePerDay: 300, currency: "MYR" },
      { vendorId: "v-a", vendorName: "Shop A", pricePerDay: 250, currency: "THB" },
    ] as SessionShopRow[];
    const { io, events } = mockIo(rows);
    await runSpteLiveTurn(input(), io);
    const d = turnDetail(events);
    expect(d.rivals).toBe(0);
  });
});
