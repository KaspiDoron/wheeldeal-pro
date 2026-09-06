import { describe, it, expect, vi, beforeEach } from "vitest";

// THE LOAD HARNESS THE ANTI-BAN INVARIANTS NEVER HAD.
//
// Every send-collision bug in this system's history has been a CONCURRENCY bug,
// and every test for them has been sequential. The Ko Tao 12:21 double-send was
// two dispatchers deciding independently; the drain and the webhook lane still
// race by design (that is what makes replies fast); and the heartbeat now fires
// a drain from two independent sources on purpose. So the question this file
// asks is the one the field asks: under a BURST - many shops replying at once,
// the drain and the inline lane both awake, the traveller tapping - does any
// shop receive two messages inside the hard floor?
//
// It runs against the real claim protocol with the same in-memory
// wa_send_claims store pacing.test.ts uses. The store is deliberately NOT
// atomic-by-luck: sbInsertClaim below has a real await inside it, so two racing
// callers genuinely interleave and a check-then-set bug would show up here.

vi.mock("server-only", () => ({}));

const state: {
  claims: Map<string, number>;
  nowMs: number;
  /** Every (sender, recipient) send the protocol ALLOWED, with its timestamp. */
  allowed: { to: string; at: number }[];
  errors: unknown[];
} = { claims: new Map(), nowMs: 1_700_000_000_000, allowed: [], errors: [] };

// A yield point inside the critical section. Without it every "concurrent"
// caller would run to completion before the next one started, and this whole
// file would be a sequential test wearing a costume.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

vi.mock("../runtime-config", () => ({
  sbInsertClaim: async (_t: string, row: { sender_key: string; slot_key: string }) => {
    const key = `${row.sender_key}|${row.slot_key}`;
    const taken = state.claims.has(key);
    await tick(); // interleave here - a unique index would not, but a bug would
    if (taken) return "lost" as const;
    if (state.claims.has(key)) return "lost" as const; // the index, modelled
    state.claims.set(key, state.nowMs);
    return "won" as const;
  },
  sbDelete: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    state.claims.delete(`${sender}|${slot}`);
  },
  sbSelectStrict: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    // Both the single-slot read and the gap-wide straddle read
    // (`slot_key=in.(...)&order=created_at.desc&limit=1`, audit F243).
    const eq = /slot_key=eq\.([^&]+)/.exec(query)?.[1];
    const inList = /slot_key=in\.\(([^)]*)\)/.exec(query)?.[1];
    const slots = eq
      ? [decodeURIComponent(eq)]
      : (inList ?? "").split(",").filter(Boolean).map((s) => decodeURIComponent(s));
    if (slots.length) {
      const at = slots
        .map((s) => state.claims.get(`${sender}|${s}`))
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => b - a)[0];
      return { rows: at ? [{ created_at: new Date(at).toISOString() }] : [] };
    }
    return { rows: [...state.claims.keys()].map(() => ({})) };
  },
}));

import { claimSendSlots, HARD_MIN_GAP_SEC } from "./pacing";

const SENDER = "owner@wheeldeal.pro";

beforeEach(() => {
  state.claims = new Map();
  state.nowMs = 1_700_000_000_000;
  state.allowed = [];
  state.errors = [];
});

/** One attempted send through the real protocol. Records what it was allowed. */
async function attempt(opts: {
  to: string;
  text: string;
  auto: boolean;
  atMs: number;
  perRecipient?: boolean;
}) {
  const res = await claimSendSlots({
    senderKey: SENDER,
    toDigits: opts.to,
    text: opts.text,
    auto: opts.auto,
    gapSeconds: opts.auto ? 12 : HARD_MIN_GAP_SEC,
    perRecipient: opts.perRecipient,
    nowMs: opts.atMs,
  });
  if (res.ok) state.allowed.push({ to: opts.to, at: opts.atMs });
  return res;
}

/** Did any shop get two messages inside the hard floor? The only question. */
function collisions(): { to: string; gapMs: number }[] {
  const byShop = new Map<string, number[]>();
  for (const a of state.allowed) {
    byShop.set(a.to, [...(byShop.get(a.to) ?? []), a.at]);
  }
  const out: { to: string; gapMs: number }[] = [];
  for (const [to, times] of byShop) {
    const sorted = [...times].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap < HARD_MIN_GAP_SEC * 1000) out.push({ to, gapMs: gap });
    }
  }
  return out;
}

describe("a burst of shops replying at once", () => {
  it("40 concurrent inbound replies produce at most one send per shop", async () => {
    // The realistic shape: a batch of introductions went out, the shops read
    // them over lunch, and forty webhooks arrive inside the same second.
    const shops = Array.from({ length: 40 }, (_, i) => `6612300${String(i).padStart(2, "0")}`);
    await Promise.all(
      shops.map((to, i) =>
        attempt({ to, text: `reply to ${i}`, auto: true, atMs: state.nowMs, perRecipient: true })
      )
    );
    expect(collisions()).toEqual([]);
    // Distinct shops must NOT serialize on one another - that is the whole
    // point of the per-recipient reply lane, and a regression here would look
    // like "the agents went quiet" in the field.
    expect(state.allowed.length).toBe(40);
  });

  it("REPRODUCTION: the drain and the inline lane racing ONE shop", async () => {
    // Both are awake at once by design - the webhook kicks the reply lane while
    // the heartbeat runs the drain. Two independent decisions, one inbox.
    const to = "66123456789";
    const racers = [
      attempt({ to, text: "inline reply", auto: true, atMs: state.nowMs, perRecipient: true }),
      attempt({ to, text: "drained reply", auto: true, atMs: state.nowMs + 1, perRecipient: true }),
      attempt({ to, text: "cold introduction", auto: true, atMs: state.nowMs + 2 }),
    ];
    await Promise.all(racers);
    expect(collisions()).toEqual([]);
    expect(state.allowed.length).toBe(1);
  });

  it("...and the traveller tapping while all of that happens", async () => {
    // The human lane used to skip the mutex entirely, which is exactly how a
    // tap could land on a shop the agent was mid-message with.
    const to = "66123456789";
    await Promise.all([
      attempt({ to, text: "agent reply", auto: true, atMs: state.nowMs, perRecipient: true }),
      attempt({ to, text: "hand-typed message", auto: false, atMs: state.nowMs + 3 }),
      attempt({ to, text: "hand-typed message", auto: false, atMs: state.nowMs + 4 }),
    ]);
    expect(collisions()).toEqual([]);
    expect(state.allowed.length).toBe(1);
  });
});

describe("the same message, sent twice, is sent once", () => {
  it("20 concurrent retries of ONE draft claim one slot", async () => {
    // A slow Evolution host, a re-queued row and a re-fired webhook can all
    // arrive at the same draft. Idempotency is per (sender, recipient, text).
    const to = "66123456789";
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        attempt({ to, text: "same exact draft", auto: true, atMs: state.nowMs, perRecipient: true })
      )
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.kind === "duplicate").length).toBe(19);
  });
});

describe("the burst is bounded and nothing escapes as a rejection", () => {
  it("200 attempts across 20 shops: no collisions, no unhandled errors", async () => {
    const shops = Array.from({ length: 20 }, (_, i) => `6699900${String(i).padStart(2, "0")}`);
    const started = Date.now();
    const jobs: Promise<unknown>[] = [];
    for (let round = 0; round < 10; round++) {
      for (const [i, to] of shops.entries()) {
        jobs.push(
          attempt({
            to,
            // Distinct text per attempt, so idempotency is NOT what saves us -
            // the recipient mutex has to be what does.
            text: `round ${round} shop ${i}`,
            auto: true,
            atMs: state.nowMs + round,
            perRecipient: true,
          }).catch((e) => state.errors.push(e))
        );
      }
    }
    await Promise.all(jobs);
    expect(state.errors).toEqual([]);
    expect(collisions()).toEqual([]);
    // One per shop for the whole burst - every round lands inside the floor.
    expect(state.allowed.length).toBe(shops.length);
    // A load test that takes a minute never gets run. This one is a gate.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("...and the floor releases: the next bucket is a fresh lane", async () => {
    const to = "66123456789";
    await attempt({ to, text: "first", auto: true, atMs: state.nowMs, perRecipient: true });
    const later = state.nowMs + HARD_MIN_GAP_SEC * 1000 * 2;
    await attempt({ to, text: "second", auto: true, atMs: later, perRecipient: true });
    expect(state.allowed.length).toBe(2);
    expect(collisions()).toEqual([]);
  });
});
