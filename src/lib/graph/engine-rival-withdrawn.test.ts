// AUDIT F136, the engine half - the graph turn's rival lookup was handed no
// idea which shops had withdrawn.
//
// `liveGraphIO.cheapestRival` selects from `offers`, and nothing retires an
// offers row when a shop declines or runs out of stock: only the Redis copy is
// evicted, and with REDIS_URL unset the Postgres path is the only path. So the
// comparator could hand the director - and the wire - a number from a shop
// that had already refused to rent.
//
// The engine must not pay a second read for this. The director already loads
// the session table on the same turn; this asserts that the SAME rows are what
// the comparator's exclusion set is built from (one sessionTable read per
// turn, not two), and that the withdrawn shops in it reach the rival lookup.
//
// EXECUTED: the real `runGraphTurn` with a stubbed IO that records what
// `cheapestRival` was actually asked for.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null, // deterministic director + composers
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
import type { GraphIO, GraphTurnInput, NegotiationThreadState, SessionShopRow } from "./types";
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

/** The session as the blackboard reads it: a withdrawn shop and a live one. */
const SESSION_ROWS: SessionShopRow[] = [
  {
    vendorId: "shop-declined",
    vendorName: "Shop that said no",
    pricePerDay: 200,
    currency: "THB",
    // A decline leaves the phase where the negotiation had got to.
    phase: "collecting_terms",
    declined: true,
  },
  {
    vendorId: "shop-empty",
    vendorName: "Shop with nothing left",
    pricePerDay: 210,
    currency: "THB",
    phase: "collecting_terms",
    outOfStock: true,
  },
  {
    vendorId: "shop-live",
    vendorName: "Shop still renting",
    pricePerDay: 260,
    currency: "THB",
    phase: "negotiating",
  },
];

function makeIO(seed: NegotiationThreadState) {
  const rivalCalls: { excludeVendorIds?: Iterable<string> }[] = [];
  let sessionTableCalls = 0;
  let saved = seed;
  const io: GraphIO = {
    loadState: async () => ({ ...saved }),
    saveState: async (s) => {
      saved = s;
    },
    cheapestRival: async (args) => {
      rivalCalls.push({ excludeVendorIds: args.excludeVendorIds });
      return 200;
    },
    sessionTable: async () => {
      sessionTableCalls += 1;
      return SESSION_ROWS.map((r) => ({ ...r }));
    },
    insertWakeup: async () => {},
    clearWakeups: async () => {},
    queueOutbox: async () => {},
    guardAndSend: async ({ text }) => ({ delivered: "sent", detail: "sent", finalText: text }),
    markPresentable: async () => {},
    insertBargainDraft: async () => {},
    recentOutboundGlobal: async () => [],
    writeTrace: async () => {},
    // The live path is llmAllowed:true (engine.ts liveGraphIO callers), which
    // is exactly when the director loads the session table.
    llmAllowed: true,
    now: () => 1_700_000_000_000,
  };
  return { io, rivalCalls, sessionTableReads: () => sessionTableCalls };
}

const extraction = (over: Partial<ExtractedOffer> = {}): ExtractedOffer => ({
  found: true,
  matchesSpec: true,
  confidence: "high",
  currency: "THB",
  ...over,
});

const input = (over: Partial<GraphTurnInput> & { extraction: ExtractedOffer }): GraphTurnInput =>
  ({
    event: {
      kind: "inbound-text",
      threadKey: "u@x:66111",
      userEmail: "u@x",
      toDigits: "66111",
      shopMessage: "500 baht per day",
      images: [],
      audios: [],
    },
    ctx: {
      sender: "u@x",
      vendorId: "shop-a",
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
    history: "Us: hi 125cc 3 days?\nShop: 500 per day",
    priorOutbound: ["hi 125cc 3 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    transcript: null,
    deadlineAt: 1_700_000_000_000 + 60_000,
    ...over,
  }) as GraphTurnInput;

const spec = defaultGraphSpec();
const seed = (): NegotiationThreadState => ({
  ...newThreadState({
    threadKey: "u@x:66111",
    userEmail: "u@x",
    vendorId: "shop-a",
    vendorName: "Shop A",
    toNumber: "66111",
  }),
  fields: {
    firmCount: 0,
    toneDegraded: false,
    rounds: 0,
    depositType: "cash",
    fulfillment: "on-shop",
  },
});

describe("EXECUTED (F136): the graph turn bars withdrawn shops from its leverage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("the rival lookup is told which shops have withdrawn", async () => {
    const { io, rivalCalls } = makeIO(seed());
    await runGraphTurn(
      input({ extraction: extraction({ pricePerDay: 500 }), usablePrice: 500 } as never),
      io,
      spec
    );
    expect(rivalCalls).toHaveLength(1);
    // THE ASSERTION THAT FAILED BEFORE THE FIX: nothing was passed, so the
    // offers query answered with the declined shop's 200.
    const barred = [...(rivalCalls[0].excludeVendorIds ?? [])].sort();
    expect(barred).toEqual(["shop-declined", "shop-empty"]);
    expect(barred).not.toContain("shop-live");
  });

  it("...and that costs the turn no extra read: one sessionTable call in all", async () => {
    const { io, sessionTableReads } = makeIO(seed());
    await runGraphTurn(
      input({ extraction: extraction({ pricePerDay: 500 }), usablePrice: 500 } as never),
      io,
      spec
    );
    expect(sessionTableReads()).toBe(1);
  });
});
