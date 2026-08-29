import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the anti-herd + concurrency contracts:
//  - jittered holds NEVER produce a shared release instant
//  - batch stagger is strictly increasing, 45-75s per step
//  - the claim protocol serializes concurrent senders, is idempotent per
//    message, straddle-proof at bucket boundaries, and fails CLOSED on
//    unknown claim state (while degrading to today's behavior pre-migration)

vi.mock("server-only", () => ({}));

const state: {
  claims: Map<string, number>; // key -> created_at ms
  mode: "ok" | "missing" | "unavailable";
  nowMs: number;
} = { claims: new Map(), mode: "ok", nowMs: 1_700_000_000_000 };

vi.mock("../runtime-config", () => ({
  sbInsertClaim: async (_t: string, row: { sender_key: string; slot_key: string }) => {
    if (state.mode === "unavailable") return "error" as const;
    if (state.mode === "missing") return "error" as const;
    const key = `${row.sender_key}|${row.slot_key}`;
    if (state.claims.has(key)) return "lost" as const;
    state.claims.set(key, state.nowMs);
    return "won" as const;
  },
  sbDelete: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    state.claims.delete(`${sender}|${slot}`);
  },
  sbSelectStrict: async (_t: string, query: string) => {
    if (state.mode === "missing") return { error: "missing" as const };
    if (state.mode === "unavailable") return { error: "unavailable" as const };
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    if (slot) {
      const at = state.claims.get(`${sender}|${slot}`);
      return { rows: at ? [{ created_at: new Date(at).toISOString() }] : [] };
    }
    return { rows: [...state.claims.keys()].map(() => ({})) };
  },
}));

import {
  jitteredHold,
  batchStagger,
  HARD_MIN_GAP_SEC,
  gapBucket,
  claimSendSlots,
  messageSlotKey,
  gaussianUnit,
} from "./pacing";

beforeEach(() => {
  state.claims = new Map();
  state.mode = "ok";
  state.nowMs = 1_700_000_000_000;
});

describe("jitteredHold - no shared release instant", () => {
  it("stays inside [base, base+spread] minutes and varies per row", () => {
    const now = 1_700_000_000_000;
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const iso = jitteredHold(now, 15, 20);
      const offsetMin = (Date.parse(iso) - now) / 60_000;
      expect(offsetMin).toBeGreaterThanOrEqual(15);
      expect(offsetMin).toBeLessThanOrEqual(35);
      seen.add(iso);
    }
    // 50 draws over a 20-minute ms-precision window collapsing to ONE value
    // is what the old flat "+15 min" did - the herd signature.
    expect(seen.size).toBeGreaterThan(10);
  });
});

/** The batch promise, as the app declares it (lib/wa/capacity). */
const WINDOW = 15 * 60_000;

describe("gaussianUnit - bell-curve jitter that never breaks the pacing bounds", () => {
  it("always returns a value inside [0,1] (so 45+rand*30 stays 45-75s)", () => {
    for (let i = 0; i < 5000; i++) {
      const v = gaussianUnit();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("clusters around the mean (a bell, not a flat uniform)", () => {
    let inMiddle = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const v = gaussianUnit(0.5, 0.22);
      if (v > 0.35 && v < 0.65) inMiddle += 1;
    }
    // A uniform draw would put ~30% in the middle 30% of the range; the
    // Gaussian concentrates clearly more mass there.
    expect(inMiddle / N).toBeGreaterThan(0.45);
  });

  it("is a drop-in rand for batchStagger - gaps stay inside the fitted band", () => {
    const { offsets, gapSecUsed } = batchStagger({
      count: 40,
      hourCap: 40,
      gapSec: 12,
      windowMs: WINDOW,
      rand: gaussianUnit,
    });
    for (let i = 1; i < offsets.length; i++) {
      const step = offsets[i] - offsets[i - 1];
      expect(step).toBeGreaterThanOrEqual(gapSecUsed * 1000);
      expect(step).toBeLessThanOrEqual(gapSecUsed * 1250);
    }
    expect(new Set(offsets).size).toBe(40); // still no shared timestamp
  });
});

// THE BATCH TOOK THREE HOURS.
//
// A traveller picked 8 shops at 16:26 and the app scheduled the last one for
// 19:17. Nothing was broken in the sense of a crash: the schedule was built
// bottom-up from a per-message gap and an hourly cap, every input was
// individually defensible, and NOTHING was responsible for the total. So when
// one input drifted - an owner-raised min-gap, or the hourly cap failing to
// read and falling back to a literal 3, smaller than every plan's own budget -
// the batch quietly stretched across an afternoon.
//
// `batchStagger` starts from the promise instead (lib/wa/capacity
// BATCH_WINDOW_MINUTES) and works back to a gap.
describe("batchStagger - schedules to a deadline, not to a gap", () => {

  it("first item is immediate", () => {
    expect(batchStagger({ count: 6, hourCap: 10, gapSec: 12, windowMs: WINDOW }).offsets[0]).toBe(0);
  });

  it("THE REPORTED CASE: 8 shops are all on their way inside the window", () => {
    const { offsets } = batchStagger({ count: 8, hourCap: 10, gapSec: 12, windowMs: WINDOW });
    expect(offsets[7]).toBeLessThanOrEqual(WINDOW);
    // ...and nothing jumped an hour.
    expect(offsets.every((o) => o < 3600_000)).toBe(true);
  });

  it("a full 40-intro ultra batch still fits, strictly in order", () => {
    const { offsets } = batchStagger({ count: 40, hourCap: 40, gapSec: 12, windowMs: WINDOW });
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    expect(offsets[39]).toBeLessThanOrEqual(WINDOW);
  });

  it("compresses a slow policy gap rather than break the promise", () => {
    // An owner-raised min-gap (or any drift) can no longer stretch the batch:
    // the gap is fitted to the window, and `compressed` says it happened.
    const s = batchStagger({ count: 40, hourCap: 40, gapSec: 600, windowMs: WINDOW });
    expect(s.compressed).toBe(true);
    expect(s.gapSecUsed).toBeLessThan(600);
    expect(s.offsets[39]).toBeLessThanOrEqual(WINDOW);
  });

  it("...but NEVER below the hard ban-safety floor", () => {
    // The one thing the deadline may not buy. 500 shops cannot fit in 15 min at
    // 8s apart, so the schedule runs long instead of sending faster.
    const s = batchStagger({ count: 500, hourCap: 500, gapSec: 12, windowMs: WINDOW });
    expect(s.gapSecUsed).toBe(HARD_MIN_GAP_SEC);
    for (let i = 1; i < s.offsets.length; i++) {
      expect(s.offsets[i] - s.offsets[i - 1]).toBeGreaterThanOrEqual(HARD_MIN_GAP_SEC * 1000);
    }
  });

  it("...and never SLOWER than the policy asked for", () => {
    // A small batch under a deliberately slow policy stays slow - compression
    // is only ever a rescue, never a speed-up nobody asked for.
    const s = batchStagger({ count: 3, hourCap: 10, gapSec: 60, windowMs: WINDOW });
    expect(s.gapSecUsed).toBe(60);
    expect(s.compressed).toBe(false);
  });

  it("items beyond the hourly ceiling overflow HONESTLY, and are counted", () => {
    // A real hourly limit cannot be compressed away - so it is reported rather
    // than hidden inside a schedule that looks normal.
    const s = batchStagger({ count: 6, hourCap: 3, gapSec: 12, windowMs: WINDOW });
    expect(s.overflow).toBe(3);
    expect(s.offsets[2]).toBeLessThan(3600_000);
    expect(s.offsets[3]).toBeGreaterThanOrEqual(3600_000);
  });

  it("within a group the sends are spaced - never a shared timestamp", () => {
    const s = batchStagger({ count: 3, hourCap: 3, gapSec: 12, windowMs: WINDOW });
    expect(new Set(s.offsets).size).toBe(3);
  });

  it("a batch of one is simply immediate", () => {
    expect(batchStagger({ count: 1, hourCap: 10, gapSec: 12, windowMs: WINDOW }).offsets).toEqual([0]);
  });
});

describe("claimSendSlots - lock-free serialization", () => {
  const base = {
    senderKey: "a@x.com",
    toDigits: "66812345678",
    text: "hello shop",
    auto: true,
    gapSeconds: 60,
  };

  it("two concurrent invocations in the same gap window: exactly one wins", async () => {
    const first = await claimSendSlots({ ...base, nowMs: state.nowMs });
    const second = await claimSendSlots({ ...base, text: "different text", nowMs: state.nowMs + 1000 });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, kind: "pacing" });
  });

  it("identical message: the loser is a duplicate, not a pacing hold", async () => {
    const first = await claimSendSlots({ ...base, nowMs: state.nowMs });
    const dup = await claimSendSlots({ ...base, nowMs: state.nowMs + 1000 });
    expect(first.ok).toBe(true);
    expect(dup).toEqual({ ok: false, kind: "duplicate" });
  });

  it("bucket-boundary straddle is refused (send at gap*0.98 then gap*1.02)", async () => {
    const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 60_000); // bucket-aligned
    state.nowMs = t0 + 59_000;
    const first = await claimSendSlots({ ...base, nowMs: t0 + 59_000 });
    expect(first.ok).toBe(true);
    state.nowMs = t0 + 61_000; // next bucket, but only 2s later
    const second = await claimSendSlots({ ...base, text: "other", nowMs: t0 + 61_000 });
    expect(second).toMatchObject({ ok: false, kind: "pacing" });
  });

  it("a FULL gap after the previous send passes across the boundary", async () => {
    const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
    state.nowMs = t0 + 10_000;
    expect((await claimSendSlots({ ...base, nowMs: t0 + 10_000 })).ok).toBe(true);
    state.nowMs = t0 + 75_000; // 65s later, next bucket
    expect((await claimSendSlots({ ...base, text: "other", nowMs: t0 + 75_000 })).ok).toBe(true);
  });

  it("manual sends take no LANE pacing - different shops never serialize", async () => {
    // The point of exempting human sends from the lanes: the traveller is not
    // an automated burst, and two shops they message back to back must not
    // queue behind each other the way agent traffic does.
    const a = await claimSendSlots({ ...base, auto: false, nowMs: state.nowMs });
    const b = await claimSendSlots({
      ...base,
      auto: false,
      toDigits: "66899999999",
      text: "second manual",
      nowMs: state.nowMs + 500,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("...but two manual sends to ONE shop inside the floor are still a burst", async () => {
    // This block used to assert the opposite. The recipient mutex is not a
    // pacing lane - it is the shop's own inbox, and half a second apart is two
    // messages at once however they were typed. The caller surfaces it as
    // "your agent is mid-message with this shop" and the floor is 8 seconds.
    const a = await claimSendSlots({ ...base, auto: false, nowMs: state.nowMs });
    const b = await claimSendSlots({
      ...base,
      auto: false,
      text: "second manual",
      nowMs: state.nowMs + 500,
    });
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, kind: "recipient-busy" });
  });

  it("fails CLOSED on unknown claim state, degrades OPEN pre-migration", async () => {
    state.mode = "unavailable";
    expect(await claimSendSlots({ ...base, nowMs: state.nowMs })).toEqual({
      ok: false,
      kind: "error",
    });
    state.mode = "missing";
    expect((await claimSendSlots({ ...base, nowMs: state.nowMs })).ok).toBe(true);
  });

  it("a pacing loser releases its message claim so the retry can re-claim", async () => {
    await claimSendSlots({ ...base, nowMs: state.nowMs });
    const lost = await claimSendSlots({ ...base, text: "retry me", nowMs: state.nowMs + 1000 });
    expect(lost).toMatchObject({ ok: false, kind: "pacing" });
    // The loser's msg slot must be free again for the queued retry.
    expect(state.claims.has(`a@x.com|${messageSlotKey("66812345678", "retry me")}`)).toBe(false);
  });
});

describe("claimSendSlots - per-recipient REPLY lane (concurrent negotiations)", () => {
  const common = { senderKey: "u@x.com", auto: true, gapSeconds: 12 };
  const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 12_000); // bucket-aligned

  it("two DIFFERENT engaged shops both send in the same window", async () => {
    const a = await claimSendSlots({
      ...common,
      toDigits: "111111",
      text: "reply to shop A",
      perRecipient: true,
      nowMs: t0,
    });
    const b = await claimSendSlots({
      ...common,
      toDigits: "222222",
      text: "reply to shop B",
      perRecipient: true,
      nowMs: t0 + 500,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true); // distinct recipients no longer serialize
  });

  it("the SAME shop is STILL min-gap serialized in the reply lane", async () => {
    const a = await claimSendSlots({
      ...common,
      toDigits: "111111",
      text: "first to A",
      perRecipient: true,
      nowMs: t0,
    });
    const b = await claimSendSlots({
      ...common,
      toDigits: "111111",
      text: "second to A too soon",
      perRecipient: true,
      nowMs: t0 + 500,
    });
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, kind: "pacing" });
  });

  it("cold intros (no perRecipient) still serialize across recipients", async () => {
    const a = await claimSendSlots({
      ...common,
      toDigits: "111111",
      text: "cold intro A",
      nowMs: t0,
    });
    const b = await claimSendSlots({
      ...common,
      toDigits: "222222",
      text: "cold intro B",
      nowMs: t0 + 500,
    });
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, kind: "pacing" }); // per-sender velocity lane
  });
});

describe("claimSendSlots - reply FLEET ceiling (atomic total-velocity cap)", () => {
  const common = { senderKey: "u@x.com", auto: true, gapSeconds: 12, perRecipient: true, fleetGapSeconds: 6 };
  const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 12_000); // aligned to 12s (and 6s)

  it("two DIFFERENT shops do NOT both send in the same fleet window (no burst)", async () => {
    const a = await claimSendSlots({ ...common, toDigits: "111111", text: "A", nowMs: t0 });
    const b = await claimSendSlots({ ...common, toDigits: "222222", text: "B", nowMs: t0 + 500 });
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, kind: "pacing" }); // fleet slot atomically serialized them
  });

  it("once the fleet gap passes, the next shop sends", async () => {
    // The mock stamps claim rows with state.nowMs, so it has to advance with
    // the simulated clock: the fleet lane now runs the SAME previous-bucket
    // straddle check the gap lane always had, and that check reads the stored
    // created_at. (Before, nothing read it, so a frozen mock clock went
    // unnoticed.)
    state.nowMs = t0;
    const a = await claimSendSlots({ ...common, toDigits: "111111", text: "A", nowMs: t0 });
    state.nowMs = t0 + 7000;
    const b = await claimSendSlots({ ...common, toDigits: "222222", text: "B", nowMs: t0 + 7000 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true); // next 6s fleet bucket, a full fleet gap later
  });

  // THE HOLE THIS COMMIT CLOSES. A bucket is a window, not a spacing promise:
  // one send at the very end of fleet bucket N and another at the very start of
  // N+1 both WIN their claims and land milliseconds apart - two shops answered
  // simultaneously, the exact bulk-sender signature the ceiling exists to stop.
  // Tightening the engaged lane makes that boundary far easier to hit.
  it("REFUSES a send that straddles the fleet bucket boundary", async () => {
    state.nowMs = t0 + 5_900; // last moment of fleet bucket N
    const a = await claimSendSlots({ ...common, toDigits: "111111", text: "A", nowMs: state.nowMs });
    state.nowMs = t0 + 6_100; // first moment of N+1 - 200ms later
    const b = await claimSendSlots({ ...common, toDigits: "222222", text: "B", nowMs: state.nowMs });
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, kind: "pacing" });
    // ...and the loser frees its message slot so its own retry is not a dupe.
    expect(state.claims.has(`u@x.com|${messageSlotKey("222222", "B")}`)).toBe(false);
  });

  it("N parallel replies to N shops come out spaced by at least the fleet gap", async () => {
    // 20 shops answering at once is the realistic load, and the property that
    // matters is not "some were refused" but that everything ACCEPTED is
    // pairwise >= fleetGap apart. Walk a simulated window in 1s steps.
    const accepted: number[] = [];
    for (let i = 0; i < 20; i++) {
      const at = t0 + i * 1_000;
      state.nowMs = at;
      const r = await claimSendSlots({
        ...common,
        toDigits: `55555${i}`,
        text: `reply ${i}`,
        nowMs: at,
      });
      if (r.ok) accepted.push(at);
    }
    expect(accepted.length).toBeGreaterThan(1);
    for (let i = 1; i < accepted.length; i++) {
      expect(accepted[i] - accepted[i - 1]).toBeGreaterThanOrEqual(6_000);
    }
  });

  it("a fleet loser frees its message + recipient slots for the retry", async () => {
    await claimSendSlots({ ...common, toDigits: "111111", text: "A", nowMs: t0 });
    const lost = await claimSendSlots({ ...common, toDigits: "222222", text: "B", nowMs: t0 + 500 });
    expect(lost).toMatchObject({ ok: false, kind: "pacing" });
    expect(state.claims.has(`u@x.com|${messageSlotKey("222222", "B")}`)).toBe(false);
  });
});

describe("gapBucket", () => {
  it("is stable within a window and increments across it", () => {
    expect(gapBucket(120_000, 60)).toBe(2);
    expect(gapBucket(179_999, 60)).toBe(2);
    expect(gapBucket(180_000, 60)).toBe(3);
  });
});
