// AUDIT F039 - the "your best price just fell through" push was a detached
// async IIFE on the primary engine's reply path.
//
// `void (async () => { ... })()` starts the work and nobody awaits it. On Cloud
// Run (deployed without --no-cpu-throttling, on purpose) the container's CPU is
// throttled to ~0 the instant the HTTP response is flushed, so the promise
// stops wherever it happens to be: mid Supabase read, mid https request to the
// push service. The traveller is never told the cheapest shop dropped out and
// `markPushSent` never spends the notification budget, so the ledger disagrees
// with reality too. src/lib/after.ts documents exactly this platform behaviour
// and graph/engine.ts already wraps its own push in finishBeforeResponse - the
// SPTE site, the engine that actually answers shops, did not.
//
// EXECUTED: the real runSpteLiveTurn, with a push mock that takes 60ms. If the
// block is detached, the turn resolves first and nothing has been called yet.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "../graph/types";

vi.mock("server-only", () => ({}));
vi.mock("../funnel/stages", () => ({
  advanceThreadStage: vi.fn(async () => ({ advanced: true })),
}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async () => ({ text: null }),
  extractJson: (t: string) => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  },
}));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sendPushToUser = vi.fn(async () => {
  // A real push is two reads plus one https request per device - never
  // instantaneous, which is the whole point of the finding.
  await delay(60);
  return { attempted: 1, delivered: 1, pruned: 0, results: [] };
});
const markPushSent = vi.fn(async () => {});
let pushHangs = false;

vi.mock("../push", () => ({
  sendPushToUser: (...args: unknown[]) =>
    pushHangs ? new Promise(() => {}) : (sendPushToUser as unknown as (...a: unknown[]) => unknown)(...args),
}));
vi.mock("../notify/state", () => ({
  notifyState: async () => ({ sentInWindow: 0 }),
  markPushSent: (...args: unknown[]) => (markPushSent as unknown as (...a: unknown[]) => unknown)(...args),
}));
vi.mock("../notify/significance", () => ({
  worthAnInterruption: () => ({ notify: true, reason: "the session's cheapest shop withdrew" }),
}));

async function harness() {
  const { newThreadState } = await import("../graph/state");
  const seed = newThreadState({
    threadKey: "user@x.com:63999",
    userEmail: "user@x.com",
    vendorId: "v1",
    vendorName: "Shop LLL",
    toNumber: "63999",
  });
  let stored: NegotiationThreadState | null = seed;
  const io = {
    now: () => 1_000_000,
    // THIS shop is the session's cheapest: 180, the best of the hunt.
    sessionTable: async () => [
      {
        vendorId: "v1",
        vendorName: "Shop LLL",
        pricePerDay: 180,
        currency: "THB",
        vehicleKey: "motorbike-125",
      },
      {
        vendorId: "v2",
        vendorName: "Shop B",
        pricePerDay: 260,
        currency: "THB",
        vehicleKey: "motorbike-125",
      },
    ],
    loadState: async () => (stored ? { ...stored, fields: { ...stored.fields } } : null),
    saveState: async (s: NegotiationThreadState) => {
      stored = s;
    },
    guardAndSend: async ({ text }: { text: string }) => ({
      delivered: "sent" as const,
      detail: "ok",
      finalText: text,
    }),
    queueOutbox: async () => {},
    insertWakeup: async () => {},
    markPresentable: async () => {},
    recordEvent: async () => {},
    writeTrace: async () => {},
  } as unknown as GraphIO;
  return { io };
}

function input(): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "user@x.com:63999",
      userEmail: "user@x.com",
      toDigits: "63999",
      shopMessage: "sorry, all rented out",
      images: [],
      audios: [],
    },
    ctx: { sender: "user@x.com", vendorId: "v1", vendorName: "Shop LLL", rfq: null },
    rfq: {
      vehicleClass: "motorbike",
      engineSizeCc: 125,
      transmission: "any",
      durationDays: 4,
      accessories: [],
      fulfillment: "any",
      vendorMessage: "",
    },
    extraction: {
      found: false,
      matchesSpec: true,
      confidence: "high",
      shopDeclined: true,
    },
    usablePrice: undefined,
    currency: "THB",
    floorPrice: 150,
    sessionClosed: false,
    history: "",
    priorInbound: ["180 per day"],
    priorOutbound: ["Hi! Do you have a 125cc for 4 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    deadlineAt: 1_045_000,
  } as unknown as GraphTurnInput;
}

describe("F039 - the lost-best push finishes before the turn returns", () => {
  beforeEach(() => {
    sendPushToUser.mockClear();
    markPushSent.mockClear();
    pushHangs = false;
  });

  it("the cheapest shop withdrawing pushes, and the push is awaited", async () => {
    const { runSpteLiveTurn } = await import("./live");
    const { io } = await harness();
    await runSpteLiveTurn(input(), io);
    // No extra tick of the event loop: whatever has not happened by now is what
    // Cloud Run throws away.
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(markPushSent).toHaveBeenCalledTimes(1);
  });

  it("a stalled push service still cannot hold the webhook open", async () => {
    const { runSpteLiveTurn } = await import("./live");
    const { io } = await harness();
    pushHangs = true;
    const started = Date.now();
    await runSpteLiveTurn(input(), io);
    // Bounded by the block's own small budget - the point of the budget is that
    // one dead endpoint never spends the whole reply path.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(markPushSent).not.toHaveBeenCalled();
  });
});
