import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F069: THE OPS AUTO-FLAG RULES READ fields.lastLeverage AND
// fields.lastTarget, WHICH ONLY THE FAILOVER ENGINE WRITES.
//
// graph/nodes.ts's bargain node is the one writer of both keys, and
// engine-route makes it unreachable on ordinary turns - so on every thread
// the live engine served, `!f.lastLeverage` was unconditionally true (R3
// "no leverage was used" fired against threads whose own outbound cited the
// rival) and `f.lastTarget &&` was unconditionally false (R5 "one last price
// stopped the push" could never fire). A false R3 plus any weight-1 rule
// reached FLAG_THRESHOLD and wrote an agent_reviews row carrying a claim the
// thread contradicts. R5 now reads the ask where the live engine keeps it
// (digest.lastAskPerDay, measured on the wire); R3 is gated on a POSITIVE
// signal - a turn of this thread that cited the rival on the wire - and
// skipped when that record cannot be read. Executed against the real sweep
// over a Map-backed store.

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { detectWeakConversations } from "./detect";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const USER = "a@x.com";

function thread(n: number, fields: Record<string, unknown>, updatedHoursAgo: number) {
  return {
    thread_key: `${USER}:6690000000${n}`,
    user_email: USER,
    vendor_id: `v${n}`,
    vendor_name: `Shop ${n}`,
    to_number: `6690000000${n}`,
    phase: "bargain",
    fields,
    waiting_until: null,
    updated_at: hoursAgo(updatedHoursAgo),
  };
}
/** A judge scoring one move's tone at the floor: the weight-1 rule (R6). */
function lowTone(n: number) {
  return { thread_key: `${USER}:6690000000${n}`, scorer: "tone-judge", scores: { tone: 1 }, created_at: hoursAgo(1) };
}
function citedTurn(n: number) {
  return {
    kind: "engine-v3-turn",
    user_email: USER,
    to_number: `6690000000${n}`,
    vendor_id: `v${n}`,
    detail: JSON.stringify({ move: "bargain", rivals: 1, citedRival: true, quote: 300 }),
    created_at: hoursAgo(2),
  };
}

const reviewsFor = (n: number) =>
  store.rows("agent_reviews").filter((r) => r.thread_key === `${USER}:6690000000${n}`);

beforeEach(() => {
  store.reset();
  // A cheaper same-user offer from a DIFFERENT shop (v9 at 250 vs quotes of 300).
  store.seed("offers", [
    { user_email: USER, vendor_id: "v9", price_per_day: 250, currency: "THB", simulated: false, created_at: hoursAgo(3) },
  ]);
});

describe("EXECUTED (F069): R3 reads the citation the live engine measured on the wire", () => {
  it("a thread whose own turn cited the rival is NOT flagged for missed leverage", async () => {
    store.seed("negotiation_threads", [
      thread(1, { pricePerDay: 300, rounds: 2, digest: { round: 2, lastAskPerDay: 240 } }, 1),
    ]);
    store.seed("agent_scores", [lowTone(1)]);
    store.seed("agent_events", [citedTurn(1)]);
    const out = await detectWeakConversations();
    expect(out.scanned).toBe(1);
    // THE ASSERTION THAT FAILED BEFORE: R3 (2) + R6 (1) reached the threshold
    // and wrote "no leverage was used" against a thread that used it.
    expect(reviewsFor(1)).toHaveLength(0);
  });

  it("a thread that never cited the rival still IS flagged (the true positive survives)", async () => {
    store.seed("negotiation_threads", [
      thread(2, { pricePerDay: 300, rounds: 2, digest: { round: 2, lastAskPerDay: 255 } }, 1),
    ]);
    store.seed("agent_scores", [lowTone(2)]);
    store.seed("agent_events", [
      {
        kind: "engine-v3-turn",
        user_email: USER,
        to_number: "66900000002",
        vendor_id: "v2",
        detail: JSON.stringify({ move: "bargain", rivals: 1, citedRival: false, quote: 300 }),
        created_at: hoursAgo(2),
      },
    ]);
    await detectWeakConversations();
    const rows = reviewsFor(2);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].auto_reason)).toContain("[R3]");
  });

  it("an unreadable turn record skips R3 rather than flagging blind", async () => {
    store.seed("negotiation_threads", [
      thread(3, { pricePerDay: 300, rounds: 2, digest: { round: 2, lastAskPerDay: 255 } }, 1),
    ]);
    store.seed("agent_scores", [lowTone(3)]);
    store.unavailable.add("agent_events");
    await detectWeakConversations();
    expect(reviewsFor(3)).toHaveLength(0);
  });
});

describe("EXECUTED (F069): R5 reads the ask where the live engine keeps it", () => {
  it("one firm 'last price' 25% above our wire-measured ask, left for 13h, is an early stop", async () => {
    store.seed("negotiation_threads", [
      thread(4, { pricePerDay: 300, rounds: 2, firmCount: 1, digest: { round: 2, lastAskPerDay: 200 } }, 13),
    ]);
    store.seed("agent_scores", [lowTone(4)]);
    await detectWeakConversations();
    const rows = reviewsFor(4);
    // THE ASSERTION THAT FAILED BEFORE: R5 short-circuited on fields.lastTarget.
    expect(rows).toHaveLength(1);
    expect(String(rows[0].auto_reason)).toContain("[R5]");
    expect(String(rows[0].auto_reason)).toContain("our target was 200");
  });

  it("the failover engine's own fields.lastTarget still counts", async () => {
    store.seed("negotiation_threads", [
      thread(5, { pricePerDay: 300, rounds: 2, firmCount: 1, lastTarget: 200 }, 13),
    ]);
    store.seed("agent_scores", [lowTone(5)]);
    await detectWeakConversations();
    expect(reviewsFor(5)).toHaveLength(1);
  });
});
