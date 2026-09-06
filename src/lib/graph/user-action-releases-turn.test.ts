import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT M40: THE USER-ACTION TURN NEVER RELEASED THE THREAD TURN IT CLAIMED.
//
// runUserAction (close-deal / pickup-consent) takes the same per-thread
// `turn:` lock every other entry takes - and was the only one that never gave
// it back. A traveller tapping "Close the deal" at t0 pinned the thread for the
// rest of the 120s window and, through the straddle rule, into the next one:
// the shop's reply 10s later lost claimThreadTurn and was dropped as
// "turn-in-flight" with no answer. Proceeding on a LOST claim is the documented
// design (a deliberate traveller action outranks an automated turn); the leak
// of a WON claim is the defect.
//
// EXECUTED against the real runUserAction, the real claim/release helpers and
// a Map-backed wa_send_claims. The thread resolver and the engine ladder are
// stubbed - the lock handling is the subject.

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

const engine = { turns: 0 };
vi.mock("../engine-route", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine-route")>();
  return {
    ...actual,
    runThreadTurn: async () => {
      engine.turns += 1;
      return {
        engine: "graph" as const,
        graph: { decisionId: "d1", action: "closing-message", traces: [] },
        fallbackReason: "user-action",
      };
    },
  };
});

import { store } from "../privacy/postgrest-store.test-helper";
import { runUserAction } from "./engine";
import { turnBucket, threadTurnSlot, TURN_WINDOW_SEC } from "../wa/turn-lock";

const EMAIL = "traveller@x.co";
const DIGITS = "66812345678";

const turnSlots = () =>
  store.rows("wa_send_claims").filter((r) => String(r.slot_key).startsWith("turn:"));

const act = () =>
  runUserAction({
    userEmail: EMAIL,
    toDigits: DIGITS,
    kind: "user-close-deal",
    payload: {},
    send: async () => ({ ok: true }),
  });

beforeEach(() => {
  store.reset();
  engine.turns = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EXECUTED (M40): the user-action turn releases the turn it won", () => {
  it("a WON claim is released when the action finishes, so the shop's next reply can take the turn", async () => {
    const out = await act();
    expect(out).not.toBeNull();
    expect(engine.turns).toBe(1);
    expect(turnSlots()).toEqual([]);
  });

  it("a LOST claim still proceeds (the documented design) and does NOT delete the sibling's live slots", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const bucket = turnBucket(Date.now(), TURN_WINDOW_SEC);
    const sibling = [
      { sender_key: EMAIL, slot_key: threadTurnSlot(DIGITS, bucket) },
      { sender_key: EMAIL, slot_key: threadTurnSlot(DIGITS, bucket - 1) },
    ];
    store.seed("wa_send_claims", sibling);
    const pending = act();
    // The one-beat wait before the retry.
    await vi.advanceTimersByTimeAsync(3_100);
    const out = await pending;
    expect(out).not.toBeNull();
    expect(engine.turns).toBe(1);
    // Exactly the sibling's two rows, untouched: releasing a lock we never
    // won would let two turns compose against one thread.
    expect(turnSlots()).toHaveLength(2);
    expect(turnSlots().map((r) => r.slot_key).sort()).toEqual(sibling.map((r) => r.slot_key).sort());
  });
});
