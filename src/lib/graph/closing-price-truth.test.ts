// Audit F143 - the numeric guard ran on four node kinds only, so the two
// numerals that reach a shop without a rail were the deal-closing price and
// the clarify question.
//
// The closing price is the worse half: /api/negotiate/close-deal forwards
// `Number(body.pricePerDay)` straight from the browser and nodes.ts prefers it
// over the thread's own field (`Number(p.pricePerDay) || f.pricePerDay`), so a
// stale card sends "250/day as we agreed" to a shop whose standing quote is
// 300. Extending the guarded node-kind list alone does not catch that - a
// stale card price is a numeral the shop itself said earlier, so it is
// grounded - which is why the payload-vs-thread comparison is the repair, and
// the guard extension is the net under it.
//
// Executed end to end through runGraphTurn with the stubbed IO of
// engine.test.ts (no LLM, deterministic composers).
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatVision: async () => null,
  extractJson: () => null,
}));
vi.mock("../runtime-config", () => ({
  getConfig: async () => undefined,
  setConfig: async () => {},
  sbInsert: async () => true,
  sbSelect: async () => [],
  sbUpdate: async () => {},
}));
vi.mock("../wa-guard", () => ({
  guardOutbound: async ({ text }: { text: string }) => ({ allow: true, text }),
  afterSend: async () => {},
}));
vi.mock("../market", () => ({
  floorPriceFor: async () => ({ floor: 150, typical: 240, currency: "THB" }),
  vehicleKeyFor: () => "motorbike-125",
  regionKeysFor: () => ["chiang-mai"],
}));

import { runGraphTurn } from "./engine";
import { defaultGraphSpec } from "./default-graph";
import { newThreadState } from "./state";
import type { ExtractedOffer } from "../agents";
import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "./types";
import type { StructuredRFQ } from "../types";

const RFQ: StructuredRFQ = {
  vehicleClass: "motorbike",
  transmission: "manual",
  durationDays: 3,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
  engineSizeCc: 125,
};

function makeIO(seed: NegotiationThreadState) {
  const sends: { to: string; text: string }[] = [];
  let saved: NegotiationThreadState = seed;
  const io: GraphIO = {
    loadState: async () => ({ ...saved }),
    saveState: async (s) => {
      saved = s;
    },
    cheapestRival: async () => undefined,
    sessionTable: async () => [],
    insertWakeup: async () => {},
    clearWakeups: async () => {},
    queueOutbox: async () => {},
    guardAndSend: async ({ toNumber, text }) => {
      sends.push({ to: toNumber, text });
      return { delivered: "sent", detail: "sent", finalText: text };
    },
    markPresentable: async () => {},
    insertBargainDraft: async () => {},
    recentOutboundGlobal: async () => [],
    writeTrace: async () => {},
    llmAllowed: false,
    now: () => 1_700_000_000_000,
  };
  return { io, sends };
}

function input(over: Partial<GraphTurnInput>): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "u@x:66111",
      userEmail: "u@x",
      toDigits: "66111",
      shopMessage: "",
      images: [],
      audios: [],
    },
    ctx: {
      sender: "u@x",
      vendorId: "v1",
      vendorName: "Shop A",
      rfq: RFQ,
      region: "Chiang Mai, Thailand",
      plan: "free",
    },
    rfq: RFQ,
    currency: "THB",
    floorPrice: 150,
    floorTypical: 240,
    sessionClosed: false,
    history: "Us: hi 125cc 3 days?\nShop: 300 baht per day",
    priorOutbound: ["hi 125cc 3 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    transcript: null,
    deadlineAt: 1_700_000_000_000 + 60_000,
    ...over,
  } as GraphTurnInput;
}

const spec = defaultGraphSpec();
const seed = () =>
  newThreadState({
    threadKey: "u@x:66111",
    userEmail: "u@x",
    vendorId: "v1",
    vendorName: "Shop A",
    toNumber: "66111",
  });

function closeEvent(payload: Record<string, unknown>) {
  return {
    kind: "user-close-deal" as const,
    threadKey: "u@x:66111",
    userEmail: "u@x",
    toDigits: "66111",
    shopMessage: "",
    images: [],
    audios: [],
    payload,
  };
}

describe("F143 - the deal-closing price is checked against the thread", () => {
  it("a stale card price never reaches the shop: the thread's own number does", async () => {
    // The shop amended to 300 after the card was rendered; the browser still
    // posts the 250 it drew.
    const { io, sends } = makeIO({
      ...seed(),
      fields: {
        firmCount: 0,
        toneDegraded: false,
        rounds: 1,
        pricePerDay: 300,
        currency: "THB",
        fulfillment: "on-shop",
      },
    });
    await runGraphTurn(
      input({ event: closeEvent({ pricePerDay: 250, currency: "THB", fulfillment: "on-shop" }) }),
      io,
      spec
    );
    expect(sends.length).toBe(1);
    expect(sends[0].text).toContain("300");
    expect(sends[0].text).not.toContain("250");
  });

  it("a payload that agrees with the thread closes unchanged", async () => {
    const { io, sends } = makeIO({
      ...seed(),
      fields: {
        firmCount: 0,
        toneDegraded: false,
        rounds: 1,
        pricePerDay: 300,
        currency: "THB",
        fulfillment: "on-shop",
      },
    });
    await runGraphTurn(
      input({ event: closeEvent({ pricePerDay: 300, currency: "THB", fulfillment: "on-shop" }) }),
      io,
      spec
    );
    expect(sends.length).toBe(1);
    expect(sends[0].text).toContain("300");
  });

  it("a delivery address with its own numerals still closes (the guard is not a wall)", async () => {
    const { io, sends } = makeIO({
      ...seed(),
      fields: {
        firmCount: 0,
        toneDegraded: false,
        rounds: 1,
        pricePerDay: 300,
        currency: "THB",
        fulfillment: "delivery",
      },
    });
    await runGraphTurn(
      input({
        event: closeEvent({
          pricePerDay: 300,
          currency: "THB",
          fulfillment: "delivery",
          address: "45/12 Moo 5, Nimman Road",
          when: "around 10:30",
        }),
      }),
      io,
      spec
    );
    expect(sends.length).toBe(1);
    expect(sends[0].text).toContain("45/12 Moo 5");
  });

  it("a price nothing in the thread holds is not sent as agreed", async () => {
    // No price on the thread, none in the history: the browser's 250 is
    // ungrounded and the closing message must not assert it.
    const { io, sends } = makeIO({
      ...seed(),
      fields: { firmCount: 0, toneDegraded: false, rounds: 1, fulfillment: "on-shop" },
    });
    await runGraphTurn(
      input({
        history: "Us: hi 125cc 3 days?\nShop: let me check with the boss",
        event: closeEvent({ pricePerDay: 250, currency: "THB", fulfillment: "on-shop" }),
      }),
      io,
      spec
    );
    expect(sends.some((s) => s.text.includes("250"))).toBe(false);
  });

  it("a price the shop actually said still closes even with no thread field", async () => {
    const { io, sends } = makeIO({
      ...seed(),
      fields: { firmCount: 0, toneDegraded: false, rounds: 1, fulfillment: "on-shop" },
    });
    await runGraphTurn(
      input({
        history: "Us: hi 125cc 3 days?\nShop: 250 baht per day ok",
        event: closeEvent({ pricePerDay: 250, currency: "THB", fulfillment: "on-shop" }),
      }),
      io,
      spec
    );
    expect(sends.length).toBe(1);
    expect(sends[0].text).toContain("250");
  });
});

describe("F143 - the clarify question is grounded too, unless it read media", () => {
  const clarifyInput = (over: Partial<GraphTurnInput>) =>
    input({
      event: {
        kind: "inbound-text",
        threadKey: "u@x:66111",
        userEmail: "u@x",
        toDigits: "66111",
        shopMessage: "we have bikes",
        images: [],
        audios: [],
      },
      extraction: {
        found: false,
        matchesSpec: true,
        confidence: "low",
        currency: "THB",
        clarifyMessage: "Just to confirm, is 3500 a day for the scooter?",
      } as ExtractedOffer,
      ...over,
    });

  it("an extraction that invented a price does not put it on the wire", async () => {
    const { io, sends } = makeIO({
      ...seed(),
      fields: { firmCount: 0, toneDegraded: false, rounds: 0 },
    });
    const res = await runGraphTurn(
      clarifyInput({ history: "Us: hi 125cc 3 days?\nShop: we have bikes" }),
      io,
      spec
    );
    expect(res.action).toBe("clarify");
    expect(sends.some((s) => s.text.includes("3500"))).toBe(false);
  });

  it("a clarify whose number the shop actually typed is still asked", async () => {
    const { io, sends } = makeIO({
      ...seed(),
      fields: { firmCount: 0, toneDegraded: false, rounds: 0 },
    });
    const res = await runGraphTurn(
      clarifyInput({ history: "Us: hi 125cc 3 days?\nShop: 3500 for the week maybe" }),
      io,
      spec
    );
    expect(res.action).toBe("clarify");
    expect(sends.length).toBe(1);
    expect(sends[0].text).toContain("3500");
  });

  it("a number read off a voice note is still confirmable (media is exempt)", async () => {
    const { io, sends } = makeIO({
      ...seed(),
      fields: { firmCount: 0, toneDegraded: false, rounds: 0 },
    });
    const res = await runGraphTurn(
      clarifyInput({
        history: "Us: hi 125cc 3 days?\nShop: (voice note)",
        transcript: { text: "(unintelligible)", source: "test", language: "th" },
      }),
      io,
      spec
    );
    expect(res.action).toBe("clarify");
    expect(sends.length).toBe(1);
    expect(sends[0].text).toContain("3500");
  });
});
