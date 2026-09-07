import { describe, it, expect, vi } from "vitest";

// AUDIT A3 - the graph FAILOVER had no beat-not-match rail.
//
// "Could you match the 200 THB/day offer" is the draft the owner photographed
// (report 5 #2). SPTE refuses it: `citesAMatch` runs in `spte/rails.ts` on the
// bargain and momentum moves. The graph engine - the live failover, and the
// sole engine on both user-action routes - imports only checkCommitment and
// stripCommitment from that file, so the same sentence sails through: the 200
// is a GENUINE grounded rival, `checkOutboundNumbers` therefore passes it, and
// nothing else looks at the phrasing.
//
// Matching is not bargaining. It spends the traveller's single strongest card -
// that a real competitor already quoted less - and the best outcome it can
// produce is the price they already had.
//
// These tests RUN runGraphTurn with the poisoned draft coming back from the
// composer, exactly as engine-integrity.test.ts does.

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async (msgs?: { role: string; content: string }[]) => {
    const sys = msgs?.[0]?.content ?? "";
    if (typeof sys === "string" && sys.includes("real human traveller")) return POISON;
    return null;
  },
  chatDetailed: async () => ({ text: null }),
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
  vehicleKeyFor: () => "scooter-125",
  regionKeysFor: () => ["krabi"],
}));

import { runGraphTurn } from "./engine";
import { newThreadState } from "./state";
import { citesAMatch } from "../negotiation/beat-rival";
import { DEFAULT_OVERLAY } from "../ops/overlay";
import type { ExtractedOffer } from "../agents";
import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "./types";
import type { StructuredRFQ } from "../types";

let POISON = "";

const RFQ: StructuredRFQ = {
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays: 5,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
  engineSizeCc: 125,
};

/** A REAL rival: another shop in this same hunt quoted 200. */
const RIVAL = 200;

function makeIO(seed: NegotiationThreadState) {
  const sends: string[] = [];
  let saved = seed;
  const io: GraphIO = {
    loadState: async () => ({ ...saved }),
    saveState: async (s) => {
      saved = s;
    },
    cheapestRival: async () => RIVAL,
    sessionTable: async () => [],
    insertWakeup: async () => {},
    clearWakeups: async () => {},
    queueOutbox: async () => {},
    guardAndSend: async ({ text }) => {
      sends.push(text);
      return { delivered: "sent", detail: "sent", finalText: text };
    },
    markPresentable: async () => {},
    insertBargainDraft: async () => {},
    recentOutboundGlobal: async () => [],
    writeTrace: async () => {},
    recordEvent: async () => {},
    llmAllowed: true,
    now: () => 1_700_000_000_000,
  };
  return { io, sends };
}

const extraction: ExtractedOffer = {
  found: true,
  matchesSpec: true,
  confidence: "high",
  currency: "THB",
  pricePerDay: 250,
} as ExtractedOffer;

function turnInput(over: Partial<GraphTurnInput>): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "u@x:66111",
      userEmail: "u@x",
      toDigits: "66111",
      shopMessage: "250 per day for the automatic scooter",
      images: [],
      audios: [],
    },
    ctx: {
      sender: "u@x",
      vendorId: "v1",
      vendorName: "Krabi Wheels",
      rfq: RFQ,
      region: "Krabi, Thailand",
      plan: "free",
    },
    rfq: RFQ,
    currency: "THB",
    floorPrice: 150,
    floorTypical: 240,
    sessionClosed: false,
    history: "Us: automatic scooter 125cc for 5 days, best price?\nShop: 250 per day",
    priorOutbound: ["automatic scooter 125cc for 5 days, best price?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    transcript: null,
    deadlineAt: 1_700_000_000_000 + 60_000,
    ...over,
  } as GraphTurnInput;
}

const seed = () =>
  newThreadState({
    threadKey: "u@x:66111",
    userEmail: "u@x",
    vendorId: "v1",
    vendorName: "Krabi Wheels",
    toNumber: "66111",
  });

const runBargain = async () => {
  const { io, sends } = makeIO({ ...seed(), fields: { firmCount: 0, toneDegraded: false, rounds: 0 } });
  const result = await runGraphTurn(
    turnInput({ extraction, usablePrice: 250, overlay: { ...DEFAULT_OVERLAY } }),
    io
  );
  return { result, sends };
};

describe("A3 - the graph failover asks the shop to BEAT, never to match", () => {
  it("a match ask citing a REAL rival never reaches the shop", async () => {
    POISON = `Another shop quoted ${RIVAL} a day - could you match the ${RIVAL}? 🙏`;
    const { result, sends } = await runBargain();
    // Whatever the engine decides to do with it, the match ask is not sent.
    for (const sent of sends) expect(citesAMatch(sent)).toBeNull();
    if (sends.length) {
      // A repair, not silence: the ask is still a real, below-quote number.
      expect(result.delivered?.delivered).toBe("sent");
      const nums = (sends[0].match(/\d{2,4}/g) ?? []).map(Number);
      expect(nums.some((n) => n < 250 && n >= 150)).toBe(true);
    } else {
      expect(result.delivered?.delivered).toBe("blocked");
    }
  });

  it("the near-miss phrasings are refused too, not just the word match", async () => {
    POISON = `The other shop is at ${RIVAL}. Can you do the same price for me? 🙏`;
    const { sends } = await runBargain();
    for (const sent of sends) expect(citesAMatch(sent)).toBeNull();
  });

  it("an honest BEAT ask is untouched (no false positive)", async () => {
    POISON = "Another shop offered me 200 a day. Could you do 185 a day for the 5 days? 🙏";
    const { result, sends } = await runBargain();
    expect(result.delivered?.delivered).toBe("sent");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("185");
  });
});
