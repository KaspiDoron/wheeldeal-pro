// PER-PROVIDER RPM BUDGETER (owner report 4, scale #5).
//
// The free/paid AI tiers all publish a requests-per-minute ceiling. The failover
// chain only learned it had hit one by RECEIVING a 429 - so at hundreds of
// concurrent turns the first provider in the chain absorbed the whole fleet,
// 429'd, and every turn paid a wasted round trip before spilling to the next
// rung. This is a token bucket per provider that spills BEFORE the 429: a
// provider whose minute is spent is skipped, and the chain moves straight to a
// rung that still has budget.
//
// Deliberately in-process. Like the send-side stop-loss, a per-instance bucket
// under-counts across a serverless fleet - but it still smooths the dominant
// case (one instance handling a burst) and NEVER over-restricts: an empty
// bucket only reorders the chain, it never fails a call the provider would have
// accepted. The durable ceiling is still the provider's own 429, which the
// chain already handles. When REDIS_URL lands (scale #2) this same interface
// can back onto a shared bucket with no caller change.
//
// Pure core (refill math) + a thin global-state wrapper, same split as
// wa/turn-latency and wa/jitter, so the arithmetic is unit-testable.

export interface Bucket {
  /** Tokens available right now (fractional between refills). */
  tokens: number;
  /** Last refill time, ms. */
  updatedAt: number;
  /** Ceiling = the provider's per-minute allowance. */
  capacity: number;
}

/** Refill a bucket to `now` at capacity-per-minute, capped at capacity. Pure. */
export function refill(b: Bucket, now: number): Bucket {
  if (now <= b.updatedAt) return b;
  const perMs = b.capacity / 60_000;
  const tokens = Math.min(b.capacity, b.tokens + (now - b.updatedAt) * perMs);
  return { ...b, tokens, updatedAt: now };
}

/**
 * Conservative per-minute ceilings, drawn from the providers' published free/dev
 * tiers with headroom (the goal is to spill one request early, never to model
 * the tier exactly). A provider absent here is treated as unlimited - the chain
 * behaves exactly as before for it. Owner-tunable later via a config row.
 */
export const DEFAULT_RPM: Record<string, number> = {
  groq: 30,
  cerebras: 30,
  deepseek: 60, // paid tier per owner budget
  together: 60,
  // 10, not 20: the owner's live probe (2026-08-31) found the free tier
  // saturated (429 on both model pools). Spilling the fleet off it EARLIER
  // is the cheap half of the fix; the ladder demotion is the other half.
  sambanova: 10,
  openrouter: 20,
  mistral: 60,
  huggingface: 15,
  gemini: 15, // free tier; paid raises this (scale #5) - owner overrides
  // The corpus embedder (lib/corpus/embed.ts), DISTINCT from the chat `gemini`
  // counter on purpose: one shared counter would let a backfill starve the
  // negotiation chain, which is the wrong trade in every case. An entry here is
  // mandatory rather than tidy - tryConsume returns true for an unknown ceiling
  // ("never our place to refuse"), so a counter with no entry is ungoverned BY
  // CONSTRUCTION. A deliberate under-shoot of the published free tier.
  gemini_embed: 60,
  // PAID providers MUST have entries: "unknown -> unlimited" would silently
  // disable the pre-429 spillover for exactly the rungs that cost money per
  // call. Entry-paid-tier ceilings with headroom (Anthropic Start 1000 RPM,
  // OpenAI T1 ~500, Moonshot T1 ~200).
  anthropic: 300,
  openai: 200,
  kimi: 100,
};

/**
 * PER-PROVIDER REQUESTS-PER-DAY (W-beta30). The minute bucket above smooths
 * bursts; the free tiers' REAL ceiling is daily, and nothing modeled it - the
 * code's own comments conceded the RPD is "roughly an order of magnitude
 * tighter" than what the per-user caps permit, and once a provider's day was
 * spent every chain pass still paid it a 429 round trip (x2 with the model
 * rescue) for the rest of the day.
 *
 * CONSERVATIVE GUESSES, deliberately: free-tier RPDs are unpublished or churn,
 * so these under-shoot rather than model exactly - a day-spent rung is merely
 * SKIPPED (like a spent minute), never refused outright, and the last rung is
 * always tried. Owner-tunable per provider via AI_RPD_<PROVIDER> in the vault.
 * A provider absent here has no daily ceiling we track (deepseek/anthropic/
 * openai are paid balances - their ceiling is money, which the ladder ordering
 * already respects).
 */
export const DEFAULT_RPD: Record<string, number> = {
  groq: 7000,
  gemini: 250, // free flash tier is a few hundred RPD - the tightest rung
  gemini_embed: 1500, // the backfill's daily ceiling, separate from chat
  openrouter: 200, // :free models: ~50/day bare, ~1000 with a $10 balance
  mistral: 2000,
  huggingface: 500,
  together: 1500,
  sambanova: 300,
};

const buckets = new Map<string, Bucket>();
// Day counters: provider -> { day: "YYYY-MM-DD", n }. In-process fallback for
// the Redis-backed fleet counter (same split as the minute bucket).
const dayCounts = new Map<string, { day: string; n: number }>();

/** Reset - test hook only. */
export function resetRpmBuckets(): void {
  buckets.clear();
  dayCounts.clear();
}

/** The UTC day key a daily window rolls on. */
export function dayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Would a call to `provider` fit its DAY right now? Consumes one unit when it
 * does. Same contract as tryConsume: unknown ceiling always fits, and a
 * refusal only reorders the chain (the caller never skips the last rung).
 */
export function tryConsumeDay(
  provider: string,
  now: number = Date.now(),
  capacityOverride?: number
): boolean {
  const capacity = capacityOverride ?? DEFAULT_RPD[provider];
  if (!capacity) return true;
  const today = dayKey(now);
  const prev = dayCounts.get(provider);
  const n = prev?.day === today ? prev.n : 0;
  if (n >= capacity) return false;
  dayCounts.set(provider, { day: today, n: n + 1 });
  return true;
}

/**
 * Would a call to `provider` fit its minute right now? Consumes one token when
 * it does. `now` is injectable for tests. A provider with no known ceiling
 * always fits (returns true, consumes nothing).
 */
export function tryConsume(
  provider: string,
  now: number = Date.now(),
  /** Owner override (AI_RPM_<PROVIDER>) resolved by the caller; falls back to
   *  the published-tier defaults below. */
  capacityOverride?: number
): boolean {
  const capacity = capacityOverride ?? DEFAULT_RPM[provider];
  if (!capacity) return true; // unknown ceiling -> never our place to refuse
  const prev = buckets.get(provider) ?? { tokens: capacity, updatedAt: now, capacity };
  const b = refill(prev, now);
  if (b.tokens >= 1) {
    buckets.set(provider, { ...b, tokens: b.tokens - 1 });
    return true;
  }
  buckets.set(provider, b);
  return false;
}

/** How many providers are currently spent (for the KPI card / spillover count). */
export function spentProviders(now: number = Date.now()): string[] {
  const out: string[] = [];
  for (const [name, b] of buckets) {
    if (refill(b, now).tokens < 1) out.push(name);
  }
  return out;
}
