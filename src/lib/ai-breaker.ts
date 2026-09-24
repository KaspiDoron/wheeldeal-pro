// THE LADDER'S MEMORY. What a provider actually SAID, remembered.
//
// lib/ai.ts walks a ladder of LLM providers and fails over when one refuses.
// It already had PREDICTIVE budgets (ai-rpm: "this rung's minute / day is
// probably spent, skip it"). What it did not have was any memory of a REAL
// refusal - so a provider that answered 402 "payment required" was tried again
// on the very next call, and again on the one after.
//
// Measured on production, 30 days to 2026-09-21:
//   cerebras   274 calls, 100% failed   (402 - its free tier ended in July)
//   sambanova   32 calls, 100% failed   (429)
//   openrouter 112 calls,  74% failed   (429, and a 404 on a delisted model)
//   mistral     38 calls,  68% failed   (429)
// With up to 14s per rung and several AI calls per turn, a reply turn took
// 45-56s to COMPOSE, every measured turn ended "parked" at the wall, and the
// shop waited a median 81s for an answer whose actual thinking took under 5.
//
// So: a refusal opens that rung's breaker for as long as that KIND of refusal
// lasts. Payment-required and a bad key are not weather - hours. A rate limit
// is - a minute, doubling while it keeps happening, never past a ceiling. One
// timeout is nothing; two in a row is a pattern. A success closes it.
//
// TWO RULES KEEP IT SAFE.
//   - It can only make the ladder FASTER, never emptier: lib/ai.ts never skips
//     its last remaining candidate, so with every breaker open a call is still
//     attempted. A wrong breaker costs one skipped rung, not an answer.
//   - It is a kill switch away from not existing (AI_BREAKER = off).
//
// In-process on purpose. Cloud Run keeps an instance warm (min-instances 1), so
// the memory survives between turns, which is where the waste was. A fleet-wide
// copy in Redis would be better and can come with REDIS_URL; nothing here
// depends on it.

import { providerFailureKind, type ProviderFailureKind } from "./provider-health";

export interface BreakerSettings {
  enabled: boolean;
  /** payment required / bad key: not transient. */
  deadMs: number;
  /** the model id no longer exists. */
  modelMs: number;
  /** rate limited: the first cool-down, doubled on each consecutive refusal. */
  busyMs: number;
  busyMaxMs: number;
  /** two timeouts in a row. */
  timeoutMs: number;
  timeoutMaxMs: number;
}

const MIN = 60_000;
export const DEFAULT_BREAKER: BreakerSettings = {
  enabled: true,
  deadMs: 6 * 60 * MIN,
  modelMs: 30 * MIN,
  busyMs: MIN,
  busyMaxMs: 15 * MIN,
  timeoutMs: 30_000,
  timeoutMaxMs: 5 * MIN,
};

const clampMs = (value: unknown, unitMs: number, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n * unitMs))) : fallback;
};

/**
 * `AI_BREAKER` in the Key Vault: blank = on with defaults, `off` = disabled, or
 * a JSON object of overrides. Every duration is clamped: a typo must be unable
 * to bench a provider for a week, or to make the breaker a no-op by accident.
 */
export function parseBreakerSettings(raw: string | null | undefined): BreakerSettings {
  const text = String(raw ?? "").trim();
  if (!text) return DEFAULT_BREAKER;
  if (/^(off|0|false|no)$/i.test(text)) return { ...DEFAULT_BREAKER, enabled: false };
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (!o || typeof o !== "object" || Array.isArray(o)) return DEFAULT_BREAKER;
    const d = DEFAULT_BREAKER;
    return {
      enabled: o.enabled !== false,
      deadMs: clampMs(o.deadHours, 60 * MIN, 10 * MIN, 24 * 60 * MIN, d.deadMs),
      modelMs: clampMs(o.modelMinutes, MIN, MIN, 6 * 60 * MIN, d.modelMs),
      busyMs: clampMs(o.busySeconds, 1000, 10_000, 10 * MIN, d.busyMs),
      busyMaxMs: clampMs(o.busyMaxMinutes, MIN, MIN, 60 * MIN, d.busyMaxMs),
      timeoutMs: clampMs(o.timeoutSeconds, 1000, 5_000, 10 * MIN, d.timeoutMs),
      timeoutMaxMs: clampMs(o.timeoutMaxMinutes, MIN, MIN, 30 * MIN, d.timeoutMaxMs),
    };
  } catch {
    return DEFAULT_BREAKER;
  }
}

interface Entry {
  kind: ProviderFailureKind;
  openUntil: number;
  /** consecutive failures of this kind - drives the doubling. */
  streak: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wd_ai_breaker__: Map<string, Entry> | undefined;
}
const state = (): Map<string, Entry> => (globalThis.__wd_ai_breaker__ ??= new Map());

/** A `retry-after: N` (seconds) the provider's error text carried, if any. */
function retryAfterMs(reason: string): number | null {
  const m = /retry[-_ ]?after["':\s]+(\d{1,7})/i.exec(reason);
  return m ? Number(m[1]) * 1000 : null;
}

export function noteProviderFailure(provider: string, reason: string, now: number = Date.now(), settings: BreakerSettings = DEFAULT_BREAKER): void {
  if (!settings.enabled) return;
  const kind = providerFailureKind(reason);
  const prev = state().get(provider);
  const streak = prev && prev.kind === kind ? prev.streak + 1 : 1;
  let openFor = 0;

  if (kind === "paywalled" || kind === "auth") openFor = settings.deadMs;
  else if (kind === "model") openFor = settings.modelMs;
  else if (kind === "busy") {
    const asked = retryAfterMs(reason);
    const backoff = settings.busyMs * 2 ** Math.min(streak - 1, 10);
    openFor = Math.min(settings.busyMaxMs, asked ?? backoff);
  } else if (kind === "timeout") {
    // One slow answer is weather; two in a row is a pattern.
    openFor = streak >= 2 ? Math.min(settings.timeoutMaxMs, settings.timeoutMs * 2 ** Math.min(streak - 2, 8)) : 0;
  }
  // "unknown": remembered for the streak, never opened. Do not bench on a mystery.

  state().set(provider, { kind, streak, openUntil: openFor > 0 ? now + openFor : 0 });
}

export function noteProviderSuccess(provider: string): void {
  state().delete(provider);
}

/** Should the ladder skip this rung right now? */
export function breakerSkips(provider: string, now: number = Date.now(), settings: BreakerSettings = DEFAULT_BREAKER): boolean {
  if (!settings.enabled) return false;
  const e = state().get(provider);
  return Boolean(e && e.openUntil > now);
}

/**
 * Which rungs to try, in order, given what is benched.
 *
 * Open breakers are dropped - that is the whole saving. But the ladder must
 * never be left with NOTHING to try, so when every rung is benched this returns
 * the one most likely to answer: the rate-limited or slow rung closest to
 * reopening. A rung benched for "payment required" or a bad key is the last
 * resort, because it is the one failure that waiting cannot fix. With everything
 * dead the full list comes back and the ladder behaves exactly as it did before
 * this module existed.
 *
 * `skipped` names what was dropped and why, for the chain-exhausted telemetry.
 */
export function breakerPlan(
  providers: readonly string[],
  now: number = Date.now(),
  settings: BreakerSettings = DEFAULT_BREAKER
): { order: string[]; skipped: string[] } {
  if (!settings.enabled) return { order: [...providers], skipped: [] };
  const open = providers.filter((p) => breakerSkips(p, now, settings));
  const describe = (p: string) => {
    const e = state().get(p)!;
    return `${p}: skipped (breaker: ${e.kind}, reopens in ${Math.max(1, Math.round((e.openUntil - now) / 1000))}s)`;
  };
  if (open.length < providers.length) {
    return { order: providers.filter((p) => !open.includes(p)), skipped: open.map(describe) };
  }
  const waitable = open.filter((p) => {
    const kind = state().get(p)!.kind;
    return kind !== "paywalled" && kind !== "auth";
  });
  if (waitable.length === 0) return { order: [...providers], skipped: [] };
  const soonest = [...waitable].sort((a, z) => state().get(a)!.openUntil - state().get(z)!.openUntil)[0];
  return { order: [soonest], skipped: open.filter((p) => p !== soonest).map(describe) };
}

/** What is open, for the admin health screen. */
export function breakerStatus(now: number = Date.now()): { provider: string; kind: ProviderFailureKind; reopensInS: number; streak: number }[] {
  return [...state().entries()]
    .filter(([, e]) => e.openUntil > now)
    .map(([provider, e]) => ({ provider, kind: e.kind, reopensInS: Math.round((e.openUntil - now) / 1000), streak: e.streak }))
    .sort((a, b) => b.reopensInS - a.reopensInS);
}

/** Test seam - the state is a process singleton. */
export function resetBreaker(): void {
  state().clear();
}
