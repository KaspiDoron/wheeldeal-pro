import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { poissonDelayMs, JITTER_MIN_MS, JITTER_MAX_MS } from "./wa/jitter";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE ANTI-BAN CENTREPIECE, APPLIED TO APPROXIMATELY NOTHING.
//
// jitter.ts is the most carefully argued file in the send path: uniform noise
// is still a signature, human message arrivals are Poisson, so the gap before
// the wire is drawn from a shifted exponential. All correct, and it was gated
// on `if (!fast)` - while EVERY drain caller passes `fast=true`, including
// /api/wa/ping (the heartbeat) and /api/wa/tick. The paths that send the
// overwhelming majority of real messages, and the two least interactive
// endpoints in the system, all skipped it.
//
// `fast` was doing two jobs. Skipping the 4-12s presence simulation is
// necessary in a drain - it would eat the whole 8s budget on one row. Skipping
// a sub-3s gap is not: MIN_GAP_MS is 20_000 per user and HARD_MIN_GAP_SEC is 8,
// so the draw is lost in pacing that already exists. Two jobs, two flags.

describe("REPRODUCTION: the Poisson gap was gated on the wrong flag", () => {
  const evo = readCode("src/lib/evolution.ts");

  it("the gap is gated on skipJitter, not on fast", () => {
    expect(evo).toMatch(/if \(!opts\?\.skipJitter\) \{\s*\n\s*const \{ poissonPause \}/);
    // The old gate must be gone, or a drain silently skips it again.
    expect(evo).not.toMatch(/if \(!fast\) \{\s*\n\s*const \{ poissonPause \}/);
  });

  it("...and `fast` still gates the presence simulation, which drains DO need", () => {
    // 4-12s per row against an 8s drain budget is one message per poll.
    const presence = evo.slice(0, evo.indexOf("skipJitter?: boolean"));
    expect(evo).toMatch(/fast = false,/);
    expect(presence.length).toBeGreaterThan(0);
  });

  it("every drain caller now gets the jitter", () => {
    // Enumerated from the routes rather than asserted in prose: any send that
    // is part of a drain must NOT be opting out.
    const drains = [
      "src/app/api/wa/ping/route.ts",
      "src/app/api/wa/tick/route.ts",
      "src/app/api/wa/reply-tick/route.ts",
      "src/app/api/wa/status/route.ts",
      "src/app/api/activity/route.ts",
      "src/app/api/replies/route.ts",
    ];
    for (const f of drains) {
      expect(readCode(f), `${f} is skipping the anti-ban jitter`).not.toMatch(/skipJitter/);
    }
  });

  it("ONLY the two paths with a person watching opt out", () => {
    const optedOut = readdirSync(join(process.cwd(), "src/app/api"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((d) => d.isFile() && d.name === "route.ts")
      // `parentPath` is already absolute here; joining it onto cwd again
      // produces /repo/repo/... and an ENOENT that looks like a missing route.
      .map((d) => join(String(d.parentPath ?? d.path), d.name))
      .filter((abs) => /skipJitter/.test(readFileSync(abs, "utf8")))
      .map((abs) => abs.slice(process.cwd().length + 1))
      .sort();

    // admin/drill was the third - deleted in Wave 7 (zero UI consumers; see
    // dead-code.test.ts). Both survivors have a human staring at the screen.
    expect(optedOut).toEqual([
      "src/app/api/admin/wa-queue/route.ts",
      "src/app/api/outreach/route.ts",
    ]);
  });
});

describe("the draw itself still has the shape the file argues for", () => {
  it("stays inside the band", () => {
    const seq = [0, 0.25, 0.5, 0.75, 0.999999];
    for (const u of seq) {
      const ms = poissonDelayMs(() => u);
      expect(ms).toBeGreaterThanOrEqual(JITTER_MIN_MS);
      expect(ms).toBeLessThanOrEqual(JITTER_MAX_MS);
    }
  });

  it("is not a constant - a fixed gap IS the fingerprint", () => {
    const draws = new Set(
      Array.from({ length: 200 }, (_, i) => poissonDelayMs(() => (i + 0.5) / 200))
    );
    expect(draws.size).toBeGreaterThan(50);
  });

  it("...and does not pile up on the floor, which a clamped exponential would", () => {
    const draws = Array.from({ length: 1000 }, (_, i) => poissonDelayMs(() => (i + 0.5) / 1000));
    const atFloor = draws.filter((d) => d === JITTER_MIN_MS).length;
    expect(atFloor / draws.length).toBeLessThan(0.05);
  });

  it("the mean is small enough that pacing, not jitter, sets throughput", () => {
    const draws = Array.from({ length: 1000 }, (_, i) => poissonDelayMs(() => (i + 0.5) / 1000));
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    // Against the DURABLE gaps this is noise, and the point of the assertion is
    // that jitter shapes arrival TIMES without setting throughput.
    expect(mean).toBeLessThan(2_000);
    // MIN_GAP_MS is deliberately gone: it lived in an in-memory globalThis map
    // that is per-instance on Cloud Run and empty after every cold start, so it
    // fired on a warm container and missed on a cold one. Nondeterministic
    // pacing is worse than either setting, and guardOutbound's jittered gap
    // plus the atomic wa_send_claims slot are both cross-instance.
    expect(readCode("src/lib/evolution.ts")).not.toMatch(/const MIN_GAP_MS = 20_000;/);
    expect(readCode("src/lib/wa/pacing.ts")).toMatch(/HARD_MIN_GAP_SEC = 8/);
  });
});
