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
  sambanova: 20,
  openrouter: 20,
  mistral: 60,
  huggingface: 15,
  gemini: 15, // free tier; paid raises this (scale #5) - owner overrides
  // PAID providers MUST have entries: "unknown -> unlimited" would silently
  // disable the pre-429 spillover for exactly the rungs that cost money per
  // call. Entry-paid-tier ceilings with headroom (Anthropic Start 1000 RPM,
  // OpenAI T1 ~500, Moonshot T1 ~200).
  anthropic: 300,
  openai: 200,
  kimi: 100,
};

const buckets = new Map<string, Bucket>();

/** Reset - test hook only. */
export function resetRpmBuckets(): void {
  buckets.clear();
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
