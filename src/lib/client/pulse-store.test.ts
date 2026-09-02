import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  subscribePulse,
  subscribePulseHealth,
  resetPulseStore,
  setPulsePeriod,
  pulseBlind,
  BLIND_LIMIT,
  PULSE_URL,
} from "./pulse-store";

// EXECUTED. The store is what makes a shop reply appear in ~3s instead of ~20s,
// and it is also what justified relaxing the heavy poll intervals - so its
// failure behaviour is load-bearing, not cosmetic.

const g = globalThis as unknown as {
  fetch: typeof fetch;
  window: unknown;
  document: { hidden: boolean; addEventListener: () => void; removeEventListener: () => void };
};

let answers: Array<{ ok: boolean; body?: { v?: number; degraded?: string[] } }> = [];
let calls = 0;

function installFetch() {
  calls = 0;
  g.fetch = (async () => {
    const a = answers[Math.min(calls, answers.length - 1)] ?? { ok: false };
    calls++;
    if (!a.ok) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => a.body ?? {} } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Let the in-flight tick settle. */
/** Drain the microtask queue a few times - a tick is fetch -> json -> notify. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  resetPulseStore();
  installFetch();
  g.window = {};
  g.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  resetPulseStore();
  vi.useRealTimers();
});

describe("the pulse fires only on a CHANGE", () => {
  it("the first observation is a baseline, not news", async () => {
    answers = [{ ok: true, body: { v: 1000, degraded: [] } }];
    const seen: number[] = [];
    subscribePulse((v) => seen.push(v));
    await settle();
    expect(calls).toBeGreaterThan(0);
    expect(seen).toEqual([]);
  });

  it("a higher version wakes every subscriber exactly once", async () => {
    answers = [
      { ok: true, body: { v: 1000, degraded: [] } },
      { ok: true, body: { v: 2000, degraded: [] } },
    ];
    setPulsePeriod(1000);
    const a: number[] = [];
    const b: number[] = [];
    subscribePulse((v) => a.push(v));
    subscribePulse((v) => b.push(v));
    await settle();
    await vi.advanceTimersByTimeAsync(1100);
    await settle();
    expect(a).toEqual([2000]);
    expect(b).toEqual([2000]);
  });

  it("an unchanged version wakes nobody - this is what keeps it cheap", async () => {
    answers = [
      { ok: true, body: { v: 1000, degraded: [] } },
      { ok: true, body: { v: 1000, degraded: [] } },
      { ok: true, body: { v: 1000, degraded: [] } },
    ];
    setPulsePeriod(1000);
    const seen: number[] = [];
    subscribePulse((v) => seen.push(v));
    await settle();
    await vi.advanceTimersByTimeAsync(2200);
    await settle();
    expect(seen).toEqual([]);
  });

  it("one throwing subscriber does not stop the others", async () => {
    answers = [
      { ok: true, body: { v: 1, degraded: [] } },
      { ok: true, body: { v: 2, degraded: [] } },
    ];
    setPulsePeriod(1000);
    const good: number[] = [];
    subscribePulse(() => {
      throw new Error("bad subscriber");
    });
    subscribePulse((v) => good.push(v));
    await settle();
    await vi.advanceTimersByTimeAsync(1100);
    await settle();
    expect(good).toEqual([2]);
  });
});

describe("a partial answer is not a version", () => {
  it("a degraded source marks the pulse blind rather than reporting no change", async () => {
    answers = [{ ok: true, body: { v: 1000, degraded: ["inbound"] } }];
    setPulsePeriod(1000);
    const seen: number[] = [];
    const health: boolean[] = [];
    subscribePulse((v) => seen.push(v));
    subscribePulseHealth((h) => health.push(h));
    await vi.advanceTimersByTimeAsync(BLIND_LIMIT * 1100);
    await settle();
    expect(seen).toEqual([]);
    expect(pulseBlind()).toBe(true);
    // Subscribed healthy, then told it went blind.
    expect(health[0]).toBe(true);
    expect(health.at(-1)).toBe(false);
  });

  it("one transient failure is NOT a verdict", async () => {
    answers = [{ ok: false }];
    subscribePulse(() => {});
    await settle();
    expect(pulseBlind()).toBe(false);
  });

  it("...but BLIND_LIMIT consecutive failures are", async () => {
    answers = [{ ok: false }];
    setPulsePeriod(1000);
    subscribePulse(() => {});
    await vi.advanceTimersByTimeAsync(BLIND_LIMIT * 1100);
    await settle();
    expect(pulseBlind()).toBe(true);
  });

  it("a good answer clears the streak", async () => {
    answers = [{ ok: false }, { ok: false }, { ok: false }, { ok: true, body: { v: 5, degraded: [] } }];
    setPulsePeriod(1000);
    const health: boolean[] = [];
    subscribePulse(() => {});
    subscribePulseHealth((h) => health.push(h));
    await vi.advanceTimersByTimeAsync(5 * 1100);
    await settle();
    expect(pulseBlind()).toBe(false);
    expect(health.at(-1)).toBe(true);
  });
});

describe("it costs what it claims to cost", () => {
  it("polls one URL, and stops entirely when the last subscriber leaves", async () => {
    answers = [{ ok: true, body: { v: 1, degraded: [] } }];
    setPulsePeriod(1000);
    const stop = subscribePulse(() => {});
    await settle();
    const seenUrl = PULSE_URL;
    expect(seenUrl).toBe("/api/pulse");
    const before = calls;
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(calls).toBe(before);
  });

  it("a hidden tab issues no requests at all", async () => {
    answers = [{ ok: true, body: { v: 1, degraded: [] } }];
    setPulsePeriod(1000);
    g.document.hidden = true;
    subscribePulse(() => {});
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(calls).toBe(0);
  });

  it("the period has a floor - no caller can turn this into a hot loop", async () => {
    setPulsePeriod(1);
    answers = [{ ok: true, body: { v: 1, degraded: [] } }];
    subscribePulse(() => {});
    await settle();
    const after = calls;
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(calls).toBe(after);
  });
});
