import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  humanPauseMs,
  slaVerdict,
  REPLY_SLA_MS,
  MIN_HUMAN_GAP_MS,
  SEND_RESERVE_MS,
} from "./reply-sla";

const read = (p: string) => readFileSync(p, "utf8");
const BIG_BUDGET = 45_000;

describe("the pause is measured from the shop's message", () => {
  it("THE REGRESSION: a fast turn is not padded by a flat ten seconds", () => {
    // The chain took 1.2s. The old line paused 10s regardless, which is what
    // made every measured reply land at 17-20s.
    const pause = humanPauseMs({ inboundAt: 1_000, now: 2_200, remainingMs: BIG_BUDGET });
    expect(pause).toBe(MIN_HUMAN_GAP_MS - 1_200);
    expect(pause).toBeLessThan(2_000);
  });

  it("a turn that already took longer than the human floor waits no further", () => {
    const pause = humanPauseMs({ inboundAt: 1_000, now: 1_000 + 6_000, remainingMs: BIG_BUDGET });
    expect(pause).toBe(0);
  });

  it("never answers a shop instantly", () => {
    const pause = humanPauseMs({ inboundAt: 1_000, now: 1_050, remainingMs: BIG_BUDGET });
    expect(pause).toBeGreaterThan(2_000);
    expect(1_050 - 1_000 + pause).toBeGreaterThanOrEqual(MIN_HUMAN_GAP_MS);
  });

  it("never pushes the answer past the promise", () => {
    // A chain that took 5s of the 10s promise may still be topped up, but only
    // as far as the send's reserve allows.
    const pause = humanPauseMs({ inboundAt: 1_000, now: 1_000 + 5_000, remainingMs: BIG_BUDGET });
    expect(5_000 + pause).toBeLessThanOrEqual(REPLY_SLA_MS - SEND_RESERVE_MS);
  });

  it("adds nothing at all once the promise is already spent", () => {
    // 9s gone: the reply is late whatever we do, and padding it further would
    // only make a breach worse.
    expect(humanPauseMs({ inboundAt: 1_000, now: 1_000 + 9_000, remainingMs: BIG_BUDGET })).toBe(0);
    expect(humanPauseMs({ inboundAt: 1_000, now: 1_000 + 30_000, remainingMs: BIG_BUDGET })).toBe(0);
  });

  it("still respects the turn's own tail reserve", () => {
    // Almost no wall clock left: the pause must not eat the send's room.
    const pause = humanPauseMs({ inboundAt: 1_000, now: 1_100, remainingMs: 20_400 });
    expect(pause).toBeLessThanOrEqual(400);
  });

  it("a tick that answers nobody's message still pauses like a person", () => {
    const pause = humanPauseMs({ inboundAt: null, now: 5_000, remainingMs: BIG_BUDGET });
    expect(pause).toBe(MIN_HUMAN_GAP_MS);
  });
});

describe("the verdict", () => {
  it("reads ten seconds as the line", () => {
    expect(slaVerdict(9_999)).toBe("within");
    expect(slaVerdict(10_000)).toBe("within");
    expect(slaVerdict(10_001)).toBe("breach");
  });
  it("never invents a verdict it cannot support", () => {
    expect(slaVerdict(null)).toBe("unknown");
    expect(slaVerdict(undefined)).toBe("unknown");
    expect(slaVerdict(-1)).toBe("unknown");
  });
});

describe("the rule is wired into the reply path", () => {
  it("the live engine asks for the SLA-aware pause", () => {
    const live = read("src/lib/spte/live.ts");
    expect(live).toMatch(/humanPauseMs/);
    // The flat pause that made the promise impossible.
    expect(live).not.toMatch(/Math\.min\(10_000, remaining - 20_000\)/);
  });
});
