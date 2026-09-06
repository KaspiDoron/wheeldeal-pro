import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F018: A DELIVERED GRAPH WAKEUP NEVER RELEASED ITS PER-THREAD TURN CLAIM.
//
// drainGraphWakeups takes the same `turn:` lock the inbound path takes
// (claimThreadTurn inserts the current bucket AND the previous one), but gave
// it back only when the tick was silent / engine-less or threw. A wakeup that
// actually DELIVERED left both slots in wa_send_claims until the 2h GC, so a
// shop answering inside the next 120-240s lost claimThreadTurn and was dropped
// as "turn-in-flight" - against a 15-25s first-reply target. The lock's
// contract is one COMPOSE at a time; message spacing is owned by the
// per-recipient pacing in claimSendSlots, not by a leaked lock.
//
// EXECUTED: the real drain, the real claim/release helpers and a Map-backed
// wa_send_claims. The thread resolver and the engine ladder are the two
// collaborators stubbed - the drain's lock handling is the subject.

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

const RFQ = {
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "pickup",
} as unknown as import("../types").StructuredRFQ;

vi.mock("../wa/thread-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wa/thread-context")>();
  return {
    ...actual,
    resolveThreadContext: async (digits: string, senderEmail: string) => ({
      ok: true,
      reason: "active-thread" as const,
      rfq: RFQ,
      ctx: { sender: senderEmail, vendorId: "v1", vendorName: "Shop", round: 1, rfq: RFQ },
      anchors: 1,
      newestAt: null,
      vendorId: "v1",
    }),
  };
});

const engine = { delivered: "sent" as "sent" | "silent", turns: 0 };
vi.mock("../engine-route", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine-route")>();
  return {
    ...actual,
    runThreadTurn: async () => {
      engine.turns += 1;
      return {
        engine: "v3" as const,
        spte: { ran: true as const, move: "bargain", tier: "R" as const, delivered: engine.delivered },
      };
    },
  };
});

vi.mock("../ai-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-budget")>();
  return { ...actual, runWithAiBudget: async (_who: string, fn: () => Promise<unknown>) => fn() };
});

import { store } from "../privacy/postgrest-store.test-helper";
import { drainGraphWakeups } from "./engine";
import { turnBucket, threadTurnSlot, TURN_WINDOW_SEC } from "../wa/turn-lock";

const EMAIL = "traveller@x.co";
const DIGITS = "66812345678";
const THREAD = `${EMAIL}:${DIGITS}`;

const turnSlots = () =>
  store.rows("wa_send_claims").filter((r) => String(r.slot_key).startsWith("turn:"));

beforeEach(() => {
  store.reset();
  engine.delivered = "sent";
  engine.turns = 0;
  store.seed("graph_wakeups", [
    { id: 42, kind: "tick", thread_key: THREAD, not_before: "2020-01-01T00:00:00.000Z", payload: null },
  ]);
});

describe("EXECUTED (F018): a wakeup gives the thread turn back however it ends", () => {
  it("a DELIVERED tick releases both claimed turn slots, so the shop's next message can take the turn", async () => {
    const ran = await drainGraphWakeups(async () => ({ ok: true }), { userEmail: EMAIL });
    expect(ran).toBe(1);
    expect(engine.turns).toBe(1);
    // The compose happened and the wakeup was retired...
    expect(store.rows("graph_wakeups")).toHaveLength(0);
    // ...and the thread is FREE: no turn: slot survives the delivered tick.
    expect(turnSlots()).toEqual([]);
  });

  it("a silent tick still releases (the pre-existing early-release path is kept)", async () => {
    engine.delivered = "silent";
    await drainGraphWakeups(async () => ({ ok: true }), { userEmail: EMAIL });
    expect(engine.turns).toBe(1);
    expect(turnSlots()).toEqual([]);
  });

  it("a tick that LOSES the claim to a live sibling turn leaves the sibling's slots alone and re-parks", async () => {
    // A sibling (the inbound path) holds this thread right now.
    const bucket = turnBucket(Date.now(), TURN_WINDOW_SEC);
    store.seed("wa_send_claims", [
      { sender_key: EMAIL, slot_key: threadTurnSlot(DIGITS, bucket) },
      { sender_key: EMAIL, slot_key: threadTurnSlot(DIGITS, bucket - 1) },
    ]);
    const ran = await drainGraphWakeups(async () => ({ ok: true }), { userEmail: EMAIL });
    expect(ran).toBe(0);
    expect(engine.turns).toBe(0);
    // The sibling's live claim survives - releasing a lock we never won would
    // let two turns compose against one thread.
    expect(turnSlots()).toHaveLength(2);
    // The wakeup was re-parked (still present, pushed into the future), not lost.
    const row = store.rows("graph_wakeups")[0];
    expect(row).toBeTruthy();
    expect(new Date(String(row.not_before)).getTime()).toBeGreaterThan(Date.now());
  });
});
