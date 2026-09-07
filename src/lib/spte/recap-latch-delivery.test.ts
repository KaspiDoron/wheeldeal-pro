// AUDIT F073 - the once-per-thread recap latch is a fact about DELIVERY.
//
// mergeDigest latched `recapSent: true` from the artifact's MOVE, while live.ts
// stamped `recapSentAt` only when the message reached the wire. A recap that
// was blocked (human takeover, cancellation, a stale-draft drop) or failed
// therefore persisted the half-state {recapSent: true, recapSentAt: undefined}:
// policy.ts then never made `verify-recap` legal again (latched) and never made
// `present` legal either (no confirmation, and no clock to expire), so a
// completed deal froze in permanent silence and the traveller's card never
// showed it.
//
// Everything below drives the REAL live turn with a scripted send verdict.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeliverResult, GraphIO, GraphTurnInput, NegotiationThreadState } from "../graph/types";
import type { ThreadDigest } from "./types";
import { emptyDigest, persistableDigest } from "./digest";
import { legalMovesFor } from "./policy";

vi.mock("server-only", () => ({}));
vi.mock("../funnel/stages", () => ({
  advanceThreadStage: vi.fn(async () => ({ advanced: true })),
}));
vi.mock("../ai", () => ({
  chat: async () => null,
  extractJson: (t: string) => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  },
  // No provider answers anything: every judgement degrades to patience and
  // every composition falls to the deterministic template.
  chatDetailed: async () => ({ text: null }),
}));

const COMPLETE: ThreadDigest = {
  ...emptyDigest(),
  quotedPricePerDay: 250,
  firmCount: 2,
  depositKnown: true,
  fulfillmentKnown: true,
  comprehension: { depositStated: true, depositKind: "cash", handoverMode: "delivery", handoverCostKnown: true },
};

type Verdict = DeliverResult | "throw";

async function harness(verdicts: Verdict[], digest: ThreadDigest = COMPLETE) {
  const { newThreadState } = await import("../graph/state");
  const seed = newThreadState({
    threadKey: "user@x.com:63999",
    userEmail: "user@x.com",
    vendorId: "v1",
    vendorName: "Shop A",
    toNumber: "63999",
  });
  seed.fields.digest = persistableDigest(digest);
  const saved: NegotiationThreadState[] = [];
  const sent: string[] = [];
  let stored: NegotiationThreadState | null = seed;
  const io = {
    now: () => 1_000_000,
    sessionTable: async () => [],
    loadState: async () => (stored ? { ...stored, fields: { ...stored.fields } } : null),
    saveState: async (s: NegotiationThreadState) => {
      saved.push(s);
      stored = s;
    },
    guardAndSend: async ({ text }: { text: string }) => {
      const v = verdicts.shift() ?? { delivered: "sent" as const, detail: "ok", finalText: text };
      if (v === "throw") throw new Error("transport down");
      if (v.delivered === "sent") sent.push(text);
      return v;
    },
    queueOutbox: async () => {
      throw new Error("outbox down");
    },
    insertWakeup: async () => {},
    markPresentable: async () => {},
    recordEvent: async () => {},
    writeTrace: async () => {},
  } as unknown as GraphIO;
  const digestOf = (s: NegotiationThreadState) => s.fields.digest as Partial<ThreadDigest>;
  return { io, saved, sent, last: () => digestOf(saved[saved.length - 1]) };
}

function input(partial: Partial<GraphTurnInput> = {}): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "user@x.com:63999",
      userEmail: "user@x.com",
      toDigits: "63999",
      shopMessage: "ok see you",
      images: [],
      audios: [],
    },
    ctx: { sender: "user@x.com", vendorId: "v1", vendorName: "Shop A", rfq: null },
    rfq: {
      vehicleClass: "scooter",
      engineSizeCc: 125,
      transmission: "any",
      durationDays: 4,
      accessories: [],
      fulfillment: "any",
      vendorMessage: "",
    },
    extraction: { found: false, matchesSpec: true, confidence: "medium" },
    usablePrice: undefined,
    currency: "THB",
    floorPrice: 150,
    sessionClosed: false,
    history: "",
    priorInbound: ["250 per day. Deposit 2000 cash, free delivery to your hotel."],
    priorOutbound: ["Hi! Do you have a 125cc scooter for 4 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    deadlineAt: 1_045_000,
    ...partial,
  } as GraphTurnInput;
}

const TICK: Partial<GraphTurnInput> = {
  event: {
    kind: "tick",
    threadKey: "user@x.com:63999",
    userEmail: "user@x.com",
    toDigits: "63999",
    shopMessage: "",
    images: [],
    audios: [],
  },
  extraction: null,
};

describe("EXECUTED: a recap that never reached the wire is not a recap sent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocked by a human takeover: the latch stays open and the next turn recaps", async () => {
    const { runSpteLiveTurn } = await import("./live");
    const h = await harness([
      { delivered: "blocked", detail: "human-takeover - the traveller is handling this thread" },
    ]);
    const first = await runSpteLiveTurn(input(), h.io);
    expect(first.move).toBe("verify-recap");
    expect(first.delivered).toBe("blocked");
    const after = h.last();
    expect(after.recapSent, "an undelivered recap must not latch").toBeFalsy();
    expect(after.recapSentAt).toBeUndefined();

    // The re-entry: verify-recap is legal again, and this time it goes out.
    const tick = await runSpteLiveTurn(input(TICK), h.io);
    expect(tick.move).toBe("verify-recap");
    expect(tick.delivered).toBe("sent");
    expect(h.sent).toHaveLength(1);
    const done = h.last();
    expect(done.recapSent).toBe(true);
    expect(done.recapSentAt).toBe(1_000_000);
  });

  it("a send that failed outright (and could not be parked) clears the latch too", async () => {
    const { runSpteLiveTurn } = await import("./live");
    const h = await harness(["throw"]);
    const first = await runSpteLiveTurn(input(), h.io);
    expect(first.move).toBe("verify-recap");
    expect(first.delivered).toBe("failed");
    expect(h.last().recapSent).toBeFalsy();
    expect(h.last().recapSentAt).toBeUndefined();
  });

  it("the half-state itself is the freeze: latched with no clock, nothing is ever legal again", () => {
    // What the bug persisted. Pinned so the policy half of the finding stays
    // visible: neither the recap nor present can be pushed from this shape.
    const frozen = legalMovesFor({
      session: {
        sessionId: "s1",
        rfq: { vehicleClass: "scooter", transmission: "any", durationDays: 4, accessories: [], fulfillment: "any", vendorMessage: "" },
        currency: "THB",
        benchmark: null,
        lowest: null,
        rivals: [],
      },
      thread: { threadKey: "u:1", vendorId: "v1", shop: "A", digest: { ...COMPLETE, recapSent: true } },
      tail: [],
      inbound: { text: "", verified: { found: false } },
      legalMoves: [],
      guards: { maxRounds: 4 },
      event: "tick",
      nowMs: 1_000_000 + 10 * 24 * 3_600_000,
    });
    expect(frozen).not.toContain("verify-recap");
    expect(frozen).not.toContain("present");
  });
});

describe("EXECUTED: a duplicate in flight IS being delivered - no second recap", () => {
  it("keeps the latch and stamps the clock, so present is still reachable", async () => {
    const { runSpteLiveTurn } = await import("./live");
    const h = await harness([
      {
        delivered: "blocked",
        detail: "duplicate in flight - another invocation is delivering this message",
        inFlight: true,
      } as DeliverResult,
    ]);
    const first = await runSpteLiveTurn(input(), h.io);
    expect(first.move).toBe("verify-recap");
    const after = h.last();
    expect(after.recapSent).toBe(true);
    expect(after.recapSentAt).toBe(1_000_000);
    // ...and the re-entry does NOT send the recap a second time.
    const tick = await runSpteLiveTurn(input(TICK), h.io);
    expect(tick.move).not.toBe("verify-recap");
    expect(h.sent).toHaveLength(0);
  });

  it("the engine marks that verdict structurally, not only in prose", () => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const engine = readFileSync(`${process.cwd()}/src/lib/graph/engine.ts`, "utf8");
    const at = engine.indexOf('detail: "duplicate in flight');
    expect(at).toBeGreaterThan(0);
    expect(engine.slice(at - 200, at + 300)).toMatch(/inFlight:\s*true/);
    // ...and it is the ONLY blocked verdict that carries it: every other block
    // is a drop, and a drop must re-open the latch.
    expect(engine.match(/inFlight:\s*true/g)).toHaveLength(1);
  });
});

describe("a delivered recap still latches and stamps exactly as before", () => {
  it("sent: recapSent + recapSentAt, and the tick does not repeat it", async () => {
    const { runSpteLiveTurn } = await import("./live");
    const h = await harness([]);
    const first = await runSpteLiveTurn(input(), h.io);
    expect(first.move).toBe("verify-recap");
    expect(first.delivered).toBe("sent");
    expect(h.last().recapSent).toBe(true);
    expect(h.last().recapSentAt).toBe(1_000_000);
    const tick = await runSpteLiveTurn(input(TICK), h.io);
    expect(tick.move).not.toBe("verify-recap");
    expect(h.sent).toHaveLength(1);
  });
});
