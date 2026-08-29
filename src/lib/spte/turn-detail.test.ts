// The engine-v3-turn blob must be VALID JSON at every size - the old
// stringify-then-slice cap silently dropped every big (i.e. degraded, i.e.
// interesting) turn out of all metrics. Round-trip, not source-grep.
import { describe, it, expect } from "vitest";
import { clampTurnDetail } from "./turn-detail";

const base = {
  move: "bargain",
  tier: "R",
  provider: "groq",
  providerError: null as string | null,
  reason: "router ok",
  legalMoves: ["bargain", "answer", "clarify"],
  floor: 200,
  lowest: 210,
  rivals: 3,
  quote: 250,
  materialDrop: false,
  delivered: "sent",
  outboxRowId: null,
  latencyMs: 4200,
  vehicleKey: "scooter:125",
  durationDays: 4,
  leverage: ["rival"],
  citedRival: true,
  askVariant: "name-number",
  counterPricePerDay: 210,
  variantOk: true,
  options: 0,
  hadImage: false,
  stance: "warm",
  deflected: false,
  unsure: ["deposit"],
  comprehension: "ok",
  comprehensionMs: 900,
  standingQuote: 250,
  think: "short scratchpad",
  text: "Can you do 210 for 4 days?",
};

describe("clampTurnDetail - bounded by field, never by slice", () => {
  it("a normal turn passes through verbatim", () => {
    const out = clampTurnDetail(base);
    expect(out).toBe(JSON.stringify(base));
    expect(JSON.parse(out).latencyMs).toBe(4200);
  });

  it("a degraded turn (long provider error, big lists, full scratchpad) stays parseable under the cap", () => {
    const degraded = {
      ...base,
      providerError: "x".repeat(600),
      reason: "y".repeat(300),
      legalMoves: Array.from({ length: 30 }, (_, i) => `move-${i}`),
      leverage: Array.from({ length: 20 }, (_, i) => `lever-${i}`),
      unsure: Array.from({ length: 20 }, (_, i) => `subject-${i}`),
      think: "t".repeat(180),
      text: "w".repeat(180),
    };
    const out = clampTurnDetail(degraded);
    expect(out.length).toBeLessThanOrEqual(1600);
    const parsed = JSON.parse(out); // the whole point: it MUST parse
    // The metrics survive; only the free-text tails shrank.
    expect(parsed.move).toBe("bargain");
    expect(parsed.latencyMs).toBe(4200);
    expect(parsed.durationDays).toBe(4);
  });

  it("a pathological turn falls to the minimal core - still JSON, and it says so", () => {
    const monstrous = Object.fromEntries(
      Object.entries(base).map(([k, v]) => [k, typeof v === "string" ? v + "z".repeat(400) : v])
    ) as typeof base;
    const out = clampTurnDetail(monstrous, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
    // Even the enum fields are clipped at this rung - nothing can bloat it.
    expect(String(parsed.delivered).startsWith("sent")).toBe(true);
    expect(String(parsed.delivered).length).toBeLessThanOrEqual(40);
    expect(parsed.latencyMs).toBe(4200);
  });

  it("the live blob no longer carries the mid-token slice", () => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const live = readFileSync(`${process.cwd()}/src/lib/spte/live.ts`, "utf8");
    expect(live).toContain("clampTurnDetail({");
    expect(live).not.toMatch(/\}\)\.slice\(0,\s*1600\)/);
  });
});
