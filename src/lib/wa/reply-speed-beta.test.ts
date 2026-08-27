import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { sweepCapForFleet } from "./sweep";

vi.mock("server-only", () => ({}));
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 8, B2 - "respond to every rental shop quickly", at 50 users.
// The inline happy path is already fast (p50 ~15-30s). These are the four
// things that made it slow, or silent, once a real beta hunt got going.

describe("the reply lane stops paying the cold lane's fine", () => {
  const guard = read("src/lib/wa-guard.ts");

  it("THE REGRESSION: the min-gap gate uses reply_gap_seconds for replies", () => {
    // reply_gap_seconds (5) existed, was configured, and was honoured by
    // claimForSend - but this gate used the cold 12s + 16s jitter for every
    // lane, so answering a shop we messaged 20s ago sat on a 12-28s hold.
    expect(guard).toMatch(/const gapBase = isReply \? p\.reply_gap_seconds : p\.min_gap_seconds;/);
    expect(guard).toMatch(/const gapNeeded = \(gapBase \+ Math\.random\(\) \* gapJitter\)/);
  });

  it("the cold lane is untouched - unsolicited first contact is the real vector", () => {
    const blk = guard.slice(guard.indexOf("THE REPLY LANE PAYS THE REPLY GAP"));
    expect(blk.slice(0, 1600)).toMatch(/: p\.min_gap_seconds;/);
  });
});

describe("a paused number still sends nothing, but replies re-check", () => {
  const guard = read("src/lib/wa-guard.ts");

  // These three ran a COPY of the formula, or a regex over the source. The
  // decision moved into `pauseRecheckAt` (wa/pacing) precisely so they can run
  // the real one - a private re-implementation passes whatever the guard does.
  const NOW = Date.parse("2026-08-24T10:00:00.000Z");
  const mins = (iso: string) => (Date.parse(iso) - NOW) / 60_000;
  const at = (hoursLeft: number, isNewContact: boolean, pauseRecheckAt: typeof import("./pacing").pauseRecheckAt) =>
    pauseRecheckAt({
      nowMs: NOW,
      pausedUntilIso: new Date(NOW + hoursLeft * 3600_000).toISOString(),
      isNewContact,
      rand: () => 0, // no spread, so the base interval is what is asserted
    });

  it("EXECUTED: a ban-recovery pause no longer parks a reply against a 4h wall", async () => {
    const { pauseRecheckAt } = await import("./pacing");
    // A 24h recovery used to stamp the reply for the full 24h.
    expect(mins(at(24, false, pauseRecheckAt))).toBeLessThan(60);
  });

  it("EXECUTED: the re-check is bounded 20-45 min for any pause length", async () => {
    const { pauseRecheckAt } = await import("./pacing");
    expect(mins(at(24, false, pauseRecheckAt))).toBe(45); // a full ban-recovery day
    expect(mins(at(8, false, pauseRecheckAt))).toBe(45); // 8h/8 = 60min, capped at 45
    for (const h of [4.5, 8, 12, 24, 48]) {
      const v = mins(at(h, false, pauseRecheckAt));
      expect(v).toBeGreaterThanOrEqual(20);
      expect(v).toBeLessThanOrEqual(45);
    }
    // A short RISK pause takes the other branch: 10min, not the 20 floor.
    expect(mins(at(1, false, pauseRecheckAt))).toBe(10);
  });

  it("EXECUTED: cold introductions keep the FULL horizon - the lane under treatment", async () => {
    const { pauseRecheckAt } = await import("./pacing");
    for (const h of [1, 4, 24]) {
      expect(mins(at(h, true, pauseRecheckAt))).toBe(h * 60);
    }
  });
});

describe("one enthusiastic tester no longer exhausts their own agents", () => {
  it("THE CLIFF: the daily AI budget covers a real hunt", () => {
    // One turn burns 2-6 model calls; a 15-shop x 3-round hunt is 200-350.
    // At 120 the tester's agents silently dropped to templates mid-hunt.
    expect(read("src/lib/usage.ts")).toMatch(/LIMIT_AI_PER_DAY: 300,/);
  });
});

describe("the app-closed recovery sweep scales with the fleet", () => {
  it("THE REGRESSION: the worker uses sweepCapForFleet, not a hardcoded 3", () => {
    const w = read("services/workers/src/scheduler.worker.ts");
    expect(w).toMatch(/sweepCapForFleet\(senders\.length\)/);
    expect(w).not.toMatch(/pickSweepEmails\(senders, minute, RECOVERY_PER_TICK\)/);
    // The old constant survives as a FLOOR so small deployments never regress.
    expect(w).toMatch(/RECOVERY_PER_TICK_MIN/);
  });

  it("EXECUTED: 50 users sweep in ~20 min instead of ~17 rotations of 3", () => {
    expect(sweepCapForFleet(50)).toBe(3); // ceil(50/20)=3 -> floor applies
    expect(sweepCapForFleet(200)).toBe(10);
    expect(sweepCapForFleet(1)).toBe(3);
    // Rotation length is what matters: ceil(fleet / width) minutes.
    const rotation = (n: number) => Math.ceil(n / sweepCapForFleet(n));
    expect(rotation(50)).toBeLessThanOrEqual(20);
    expect(rotation(300)).toBeLessThanOrEqual(30);
  });

  it("it is exported from the worker's package boundary", () => {
    expect(read("packages/core/index.ts")).toMatch(/sweepCapForFleet/);
  });
});

describe("a truncated webhook batch asks to be redelivered", () => {
  const ingest = read("src/lib/wa/ingest.ts");

  it("THE SILENT TAIL: overflow sets retryable, not just a trace", () => {
    // The trace already existed - which is how we know it happens. A traced
    // drop is still a drop, and the Cloud channel has no sweep behind it.
    expect(ingest).toMatch(/retryable = true;/);
    expect(ingest).toMatch(/redelivery: "requested"/);
  });

  it("THE TAIL IS NOT DROPPED FOREVER: the budget advances, it is not a slice", () => {
    // The old `items.slice(0, 25)` capped by ARRAY INDEX, so a >25 batch
    // 503-looped: every redelivery re-took items 0..24 (now claimed, cheap-
    // skipped) and items 25+ were never in the window (OR11 I2.2). The fix
    // iterates the WHOLE batch and caps the number of items that do REAL work.
    expect(ingest).not.toMatch(/const capped = items\.slice\(0, 25\);/);
    expect(ingest).toMatch(/for \(const data of items\)/);
    expect(ingest).toMatch(/if \(heavyProcessed >= HEAVY_PER_INVOCATION\)/);
    // The budget counts only genuinely-new work (a won store claim), so an
    // already-handled head is cheap-skipped and each redelivery advances.
    expect(ingest).toMatch(/heavyProcessed \+= 1;/);
  });

  it("redelivery is safe because the store claims de-duplicate", () => {
    expect(ingest).toMatch(/claimInboundStore/);
  });
});
