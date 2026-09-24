// THE LADDER HAD NO MEMORY. Measured on production (2026-09-21): Cerebras
// answered 402 "payment required" on 274 of 274 calls in 30 days, SambaNova 429
// on 32 of 32, OpenRouter failed 74%, Mistral 68% - and every one of those was
// tried again on the very next call. With a 14s ceiling per rung and several AI
// calls per turn, reply turns took 45-56s to compose and every measured turn
// ended "parked" at the wall; the shop waited a median 81s.
//
// The RPM/RPD budgets are PREDICTIONS of a quota. This is the other half: what
// a provider actually SAID, remembered.

import { beforeEach, describe, expect, it } from "vitest";
import { breakerPlan, breakerSkips, breakerStatus, noteProviderFailure, noteProviderSuccess, parseBreakerSettings, resetBreaker, DEFAULT_BREAKER } from "./ai-breaker";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

beforeEach(() => resetBreaker());

describe("a refusal is remembered for as long as that KIND of refusal lasts", () => {
  it("payment required is not transient - the rung is skipped for hours, not retried per call", () => {
    noteProviderFailure("cerebras", 'cerebras 402 - {"message":"Payment required to access this resource"}', T0);
    expect(breakerSkips("cerebras", T0 + 1)).toBe(true);
    expect(breakerSkips("cerebras", T0 + 5 * 60 * MIN)).toBe(true);
    expect(breakerSkips("cerebras", T0 + 6 * 60 * MIN + 1)).toBe(false);
  });

  it("a bad key is the same story", () => {
    noteProviderFailure("groq", "groq 401 - invalid api key", T0);
    expect(breakerSkips("groq", T0 + 60 * MIN)).toBe(true);
  });

  it("a rate limit is short, and doubles while it keeps happening", () => {
    noteProviderFailure("groq", "groq 429 - rate_limit_exceeded", T0);
    expect(breakerSkips("groq", T0 + 59_000)).toBe(true);
    expect(breakerSkips("groq", T0 + 61_000)).toBe(false);
    // Tried again after the cool-down, refused again: 2 minutes this time.
    noteProviderFailure("groq", "groq 429 - rate_limit_exceeded", T0 + 61_000);
    expect(breakerSkips("groq", T0 + 61_000 + 119_000)).toBe(true);
    expect(breakerSkips("groq", T0 + 61_000 + 121_000)).toBe(false);
  });

  it("the doubling is capped - a busy provider is re-tried within 15 minutes, always", () => {
    let now = T0;
    for (let i = 0; i < 12; i++) {
      noteProviderFailure("openrouter", "openrouter 429", now);
      now += 20 * MIN;
    }
    noteProviderFailure("openrouter", "openrouter 429", now);
    expect(breakerSkips("openrouter", now + 15 * MIN + 1)).toBe(false);
  });

  it("honours a Retry-After the provider gave, within bounds", () => {
    noteProviderFailure("mistral", "mistral 429 - slow down (retry-after: 300)", T0);
    expect(breakerSkips("mistral", T0 + 299_000)).toBe(true);
    expect(breakerSkips("mistral", T0 + 301_000)).toBe(false);
    // ...but a provider cannot bench itself for a day.
    noteProviderFailure("sambanova", "sambanova 429 (retry-after: 999999)", T0);
    expect(breakerSkips("sambanova", T0 + 15 * MIN + 1)).toBe(false);
  });

  it("a model that no longer exists is benched for a while", () => {
    noteProviderFailure("openrouter", "primary openai/gpt-oss-20b:free: openrouter 404 - model not found", T0);
    expect(breakerSkips("openrouter", T0 + 29 * MIN)).toBe(true);
    expect(breakerSkips("openrouter", T0 + 31 * MIN)).toBe(false);
  });

  // One slow answer is weather. The breaker must not bench a healthy provider
  // for a single timeout.
  it("ONE timeout opens nothing; a second in a row does", () => {
    noteProviderFailure("deepseek", "deepseek timed out after 3360ms (no response)", T0);
    expect(breakerSkips("deepseek", T0 + 1)).toBe(false);
    noteProviderFailure("deepseek", "deepseek timed out after 3360ms (no response)", T0 + 5_000);
    expect(breakerSkips("deepseek", T0 + 6_000)).toBe(true);
    expect(breakerSkips("deepseek", T0 + 5_000 + 31_000)).toBe(false);
  });

  it("an unclassifiable failure opens nothing - do not bench on a mystery", () => {
    noteProviderFailure("gemini", "something odd happened", T0);
    noteProviderFailure("gemini", "something odd happened", T0 + 1);
    expect(breakerSkips("gemini", T0 + 2)).toBe(false);
  });
});

describe("recovery", () => {
  it("one success closes the breaker and forgets the streak", () => {
    noteProviderFailure("groq", "groq 429", T0);
    noteProviderFailure("groq", "groq 429", T0 + 61_000);
    noteProviderSuccess("groq");
    expect(breakerSkips("groq", T0 + 62_000)).toBe(false);
    // The next refusal starts from the short cool-down again, not the doubled one.
    noteProviderFailure("groq", "groq 429", T0 + 70_000);
    expect(breakerSkips("groq", T0 + 70_000 + 61_000)).toBe(false);
  });

  it("providers are independent", () => {
    noteProviderFailure("cerebras", "cerebras 402", T0);
    expect(breakerSkips("groq", T0 + 1)).toBe(false);
  });
});

describe("the owner's controls", () => {
  it("is on by default with the documented durations", () => {
    expect(parseBreakerSettings(null)).toEqual(DEFAULT_BREAKER);
    expect(parseBreakerSettings("")).toEqual(DEFAULT_BREAKER);
  });

  it("can be switched off entirely - a kill switch, like every other loop here", () => {
    const off = parseBreakerSettings("off");
    expect(off.enabled).toBe(false);
    noteProviderFailure("cerebras", "cerebras 402", T0, off);
    expect(breakerSkips("cerebras", T0 + 1, off)).toBe(false);
  });

  it("takes duration overrides, clamped so a typo cannot bench a provider for a week or never", () => {
    const s = parseBreakerSettings('{"busySeconds":5,"deadHours":500,"busyMaxMinutes":30}');
    expect(s.busyMs).toBe(10_000);
    expect(s.deadMs).toBe(24 * 60 * MIN);
    expect(s.busyMaxMs).toBe(30 * MIN);
    expect(parseBreakerSettings("{nope").enabled).toBe(true);
  });

  it("reports what is open, for the admin health screen", () => {
    noteProviderFailure("cerebras", "cerebras 402 payment required", T0);
    const status = breakerStatus(T0 + 1000);
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ provider: "cerebras", kind: "paywalled" });
    expect(status[0].reopensInS).toBeGreaterThan(3600);
    expect(breakerStatus(T0 + 7 * 60 * MIN)).toEqual([]);
  });
});

describe("what the ladder is told to try", () => {
  const LADDER = ["groq", "openrouter", "mistral", "cerebras"];

  it("drops the benched rungs and keeps the order of the rest", () => {
    noteProviderFailure("cerebras", "cerebras 402", T0);
    noteProviderFailure("openrouter", "openrouter 429", T0);
    const plan = breakerPlan(LADDER, T0 + 1000);
    expect(plan.order).toEqual(["groq", "mistral"]);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped.join(" ")).toMatch(/cerebras: skipped \(breaker: paywalled/);
  });

  // It may only ever make the ladder FASTER, never emptier.
  it("never returns nothing: with every rung benched it tries the one closest to reopening", () => {
    noteProviderFailure("groq", "groq 429", T0);
    noteProviderFailure("openrouter", "openrouter 429 (retry-after: 600)", T0);
    noteProviderFailure("mistral", "mistral 429 (retry-after: 300)", T0);
    noteProviderFailure("cerebras", "cerebras 402", T0);
    expect(breakerPlan(LADDER, T0 + 1000).order).toEqual(["groq"]);
  });

  it("a payment-required rung is the LAST resort - waiting cannot fix it", () => {
    noteProviderFailure("cerebras", "cerebras 402", T0);
    noteProviderFailure("groq", "groq 429 (retry-after: 800)", T0);
    expect(breakerPlan(["cerebras", "groq"], T0 + 1000).order).toEqual(["groq"]);
  });

  it("with everything dead it hands back the whole ladder, exactly as before this existed", () => {
    noteProviderFailure("cerebras", "cerebras 402", T0);
    noteProviderFailure("groq", "groq 401 invalid api key", T0);
    expect(breakerPlan(["groq", "cerebras"], T0 + 1000)).toEqual({ order: ["groq", "cerebras"], skipped: [] });
  });

  it("switched off, it changes nothing", () => {
    noteProviderFailure("cerebras", "cerebras 402", T0);
    expect(breakerPlan(LADDER, T0 + 1, parseBreakerSettings("off"))).toEqual({ order: LADDER, skipped: [] });
  });
});
