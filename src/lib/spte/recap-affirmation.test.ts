// AUDIT F132 - shop_confirmed needs an AFFIRMATIVE, not merely an answer.
//
// Step 8 stamped `recapConfirmedAt`, advanced the funnel ledger to
// shop_confirmed ("shop confirmed the recap") and marked the offer presentable
// whenever readConfirmAnswer said `answered && !stillUnclear` - and that
// classifier's own instructions define a correction as an answer. So "no,
// deposit is 3000 and we do not deliver" (no per-day price in it, so the
// deterministic price-correction pre-check does not fire) confirmed the deal
// the shop had just rejected, and `present` became legal for it.
//
// The fix: the ConfirmAnswer read carries `affirmed`, live.ts confirms only on
// it, and a non-affirmative answer takes the amendment path the price
// correction already had - the latch re-opens ONCE (recapAmended bounds it) so
// one amended recap goes out. After the amendment is spent a refusal changes
// nothing, and the delivered recap's clock (F073) still releases `present`
// with the honest never-re-confirmed caveat, so no dead end is created.
// A null read (outage) is still "not confirmed yet".
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "../graph/types";
import type { ThreadDigest } from "./types";
import { emptyDigest, persistableDigest } from "./digest";

vi.mock("server-only", () => ({}));

const stages = vi.hoisted(() => ({
  advanceThreadStage: vi.fn(async () => ({ advanced: true })),
}));
vi.mock("../funnel/stages", () => ({ advanceThreadStage: stages.advanceThreadStage }));

const ai = vi.hoisted(() => ({ answer: null as unknown, calls: [] as string[] }));
vi.mock("../ai", () => ({
  chat: async () => null,
  extractJson: (t: string) => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  },
  chatDetailed: async (msgs: Array<{ role: string; content: string }>) => {
    const system = msgs[0]?.content ?? "";
    ai.calls.push(system);
    if (system.includes("waiting for their reply")) {
      return ai.answer ? { text: JSON.stringify(ai.answer), provider: "mock" } : { text: null };
    }
    return { text: null };
  },
}));

const RECAPPED: ThreadDigest = {
  ...emptyDigest(),
  quotedPricePerDay: 250,
  firmCount: 2,
  depositKnown: true,
  fulfillmentKnown: true,
  comprehension: { depositStated: true, depositKind: "cash", handoverMode: "delivery", handoverCostKnown: true },
  recapSent: true,
  recapSentAt: 900_000,
};

async function harness(digest: ThreadDigest) {
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
  const markPresentable = vi.fn(async () => {});
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
      sent.push(text);
      return { delivered: "sent" as const, detail: "ok", finalText: text };
    },
    queueOutbox: async () => {},
    insertWakeup: async () => {},
    markPresentable,
    recordEvent: async () => {},
    writeTrace: async () => {},
  } as unknown as GraphIO;
  return {
    io,
    saved,
    sent,
    markPresentable,
    last: () => saved[saved.length - 1].fields.digest as Partial<ThreadDigest>,
  };
}

function reply(shopMessage: string): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "user@x.com:63999",
      userEmail: "user@x.com",
      toDigits: "63999",
      shopMessage,
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
    priorOutbound: [
      "Hi! Do you have a 125cc scooter for 4 days?",
      "Perfect - just so I have it right: 250 THB/day for 4 days, 2000 cash deposit, delivered to my hotel. All correct?",
    ],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    deadlineAt: 1_045_000,
  } as GraphTurnInput;
}

const confirmedCalls = () =>
  stages.advanceThreadStage.mock.calls.filter((c) => (c as unknown[])[1] === "shop_confirmed");

describe("EXECUTED: an answer that is not a yes does not confirm the deal", () => {
  beforeEach(() => {
    ai.answer = null;
    ai.calls = [];
    stages.advanceThreadStage.mockClear();
  });

  it('"no, deposit is 3000 and we do not deliver" - a correction, not a confirmation', async () => {
    const { runSpteLiveTurn } = await import("./live");
    ai.answer = {
      answered: true,
      answer: "deposit is 3000 cash and no delivery",
      stillUnclear: false,
      affirmed: false,
      confidence: 0.92,
    };
    const h = await harness(RECAPPED);
    await runSpteLiveTurn(reply("no, deposit is 3000 and we do not deliver"), h.io);
    expect(confirmedCalls(), "the ledger must not say the shop confirmed").toHaveLength(0);
    expect(h.markPresentable).not.toHaveBeenCalled();
    const after = h.last();
    expect(after.recapConfirmedAt).toBeUndefined();
    // The amendment path: the latch re-opened once and the amended recap went
    // out, re-latching with a fresh clock.
    expect(after.recapAmended).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].toLowerCase()).toContain("correct");
    expect(after.recapSent).toBe(true);
    expect(after.recapSentAt).toBe(1_000_000);
  });

  it("a bare refusal is the same path", async () => {
    const { runSpteLiveTurn } = await import("./live");
    ai.answer = { answered: true, answer: "no", stillUnclear: false, affirmed: false, confidence: 0.95 };
    const h = await harness(RECAPPED);
    await runSpteLiveTurn(reply("no"), h.io);
    expect(confirmedCalls()).toHaveLength(0);
    expect(h.last().recapConfirmedAt).toBeUndefined();
  });

  it("after the one amendment is spent, a refusal changes nothing - and the clock still runs", async () => {
    const { runSpteLiveTurn } = await import("./live");
    ai.answer = { answered: true, answer: "no", stillUnclear: false, affirmed: false, confidence: 0.95 };
    const h = await harness({ ...RECAPPED, recapAmended: true });
    await runSpteLiveTurn(reply("no, still not right"), h.io);
    expect(confirmedCalls()).toHaveLength(0);
    const after = h.last();
    expect(after.recapConfirmedAt).toBeUndefined();
    expect(h.sent).toHaveLength(0);
    // Not the F073 shape: the delivered recap's clock survives, so the
    // wall-clock bound in policy.ts can still release the thread.
    expect(after.recapSent).toBe(true);
    expect(after.recapSentAt).toBe(900_000);
  });

  it("an outage is still 'not confirmed yet': nothing moves", async () => {
    const { runSpteLiveTurn } = await import("./live");
    ai.answer = null;
    const h = await harness(RECAPPED);
    await runSpteLiveTurn(reply("yes ok"), h.io);
    expect(confirmedCalls()).toHaveLength(0);
    expect(h.markPresentable).not.toHaveBeenCalled();
    const after = h.last();
    expect(after.recapConfirmedAt).toBeUndefined();
    expect(after.recapSent).toBe(true);
    expect(after.recapSentAt).toBe(900_000);
    expect(after.recapAmended).toBeFalsy();
  });
});

describe("EXECUTED: a real yes still confirms", () => {
  beforeEach(() => {
    ai.answer = null;
    ai.calls = [];
    stages.advanceThreadStage.mockClear();
  });

  it("'yes all correct' stamps the clock, the ledger and the presentable flag", async () => {
    const { runSpteLiveTurn } = await import("./live");
    ai.answer = { answered: true, answer: "yes all correct", stillUnclear: false, affirmed: true, confidence: 0.95 };
    const h = await harness(RECAPPED);
    await runSpteLiveTurn(reply("yes all correct, see you"), h.io);
    expect(confirmedCalls()).toHaveLength(1);
    expect(h.markPresentable).toHaveBeenCalledTimes(1);
    expect(h.last().recapConfirmedAt).toBe(1_000_000);
    // The read was asked for the affirmative, in so many words.
    const prompt = ai.calls.find((c) => c.includes("waiting for their reply")) ?? "";
    expect(prompt).toMatch(/affirmed/);
  });

  it("the schema carries the field, and the other consumer tolerates its absence", async () => {
    const { ConfirmAnswer } = await import("../semantic/classifiers");
    expect(ConfirmAnswer.parse({ answered: true, answer: "no", stillUnclear: false, affirmed: false, confidence: 0.9 }).affirmed).toBe(false);
    // The confirm-wait read (a "passport or cash?" question has no yes) keeps
    // working on an answer without it.
    expect(ConfirmAnswer.parse({ answered: true, answer: "cash", stillUnclear: false, confidence: 0.9 }).affirmed).toBeUndefined();
  });
});
