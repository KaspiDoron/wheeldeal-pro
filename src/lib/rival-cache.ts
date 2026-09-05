// SESSION OFFER HOT STATE (Module 2 of the GCP migration).
//
// The lowest-rival read used to be a Postgres query on every negotiation turn;
// on the VM it becomes an O(log n) Redis ZSET read, and the dashboard's
// OFFERS IN / BARGAINED tiles become an HSET the SSE stream pushes instantly.
//
// This file is the CANONICAL implementation (the "brain in src/lib, packages
// re-export" pattern - @wheeldeal/redis/offers re-exports from here) because
// the same code runs in BOTH runtimes during the dual-run:
//   - With no REDIS_URL: every function is an instant no-op /
//     null. Zero behavior change, zero connection attempts, build unaffected.
//   - On the VM (workers/gateway): REDIS_URL is set -> full hot path.
//
// DUAL-RUN CORRECTNESS RULE: Redis is authoritative ONLY for sessions whose
// offers were written through the worker path. The first worker-side write
// sets a `live` flag; the cached-rival read returns null unless that flag
// exists, so a keyless-era session can never read a stale or incomplete cache
// - it silently falls through to the Postgres path.
//
// Never throws: a Redis hiccup degrades to "no cache" (callers fall back).

export type RedisLike = {
  /**
   * The cheapest possible proof of life. Optional on the TYPE (the test doubles
   * in daily-cap-atomic.test.ts and budget-cache.test.ts implement only the
   * commands they exercise), required in practice - ioredis has it - so the
   * admin probe checks for it before calling rather than assuming.
   */
  ping?(): Promise<string>;
  /**
   * Plain read of a string key. Optional on the type for the same reason as
   * ping: the test doubles implement only what they exercise. rateLimitPeek
   * (rate-limit.ts) uses it to READ a window without counting a hit, and falls
   * back to the per-instance window when a double lacks it.
   */
  get?(key: string): Promise<string | null>;
  set(...args: (string | number)[]): Promise<unknown>;
  exists(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  zadd(key: string, score: string, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number, withScores?: "WITHSCORES"): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<unknown>;
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<unknown>;
  zcard(key: string): Promise<number>;
  hset(key: string, ...fieldValues: (string | number)[]): Promise<unknown>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
};

let client: RedisLike | null | undefined; // undefined = not tried, null = unavailable

/** The shared lazy, REDIS_URL-gated hot-state client - null when REDIS_URL is unset /
 * Redis is down. Exported so sibling hot-state modules (the copy-uniqueness
 * signature window) reuse ONE connection instead of opening their own. */
export async function hotStateClient(): Promise<RedisLike | null> {
  return cacheClient();
}

async function cacheClient(): Promise<RedisLike | null> {
  if (client !== undefined) return client;
  const url = process.env.REDIS_URL;
  if (!url) {
    client = null;
    return null;
  }
  try {
    const { default: Redis } = await import("ioredis");
    const c = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      commandTimeout: 2000,
      lazyConnect: false,
    });
    c.on("error", () => {}); // degrade silently; callers fall back to Postgres
    client = c as unknown as RedisLike;
  } catch {
    client = null;
  }
  return client;
}

/**
 * IS THE HOT-STATE TIER ACTUALLY THERE? (Wave 7)
 *
 * Redis is a real dependency of four subsystems - the atomic daily caps
 * (`usage.ts`), the AI budget cache, the copy-uniqueness window and the SSE
 * session fan-out - and it was the ONE dependency with no surface anywhere:
 * not on the Keys page, not in the health roll-call, not in a probe. That
 * matters more than a missing tile, because `REDIS_URL` is the documented
 * difference between an ATOMIC daily cap and a per-process counter that
 * `--max-instances 20` multiplies by twenty. "Nothing is enforcing the cap"
 * and "everything is fine" looked identical.
 *
 * Three states, and they are genuinely different:
 *   off  - REDIS_URL unset. Not a fault; it is the documented degraded mode,
 *          and the detail says exactly what that costs.
 *   ok   - a real PING round-tripped, with the milliseconds it took.
 *   down - configured and NOT answering, which is the state where the caps
 *          silently fall back to per-process counting.
 */
export async function redisDiagnostics(): Promise<{
  configured: boolean;
  ok: boolean;
  latencyMs: number | null;
  detail: string;
}> {
  if (!process.env.REDIS_URL) {
    return {
      configured: false,
      ok: false,
      latencyMs: null,
      detail:
        "REDIS_URL is not set. Daily AI/send caps fall back to a per-process counter, so with --max-instances 20 each cap can be exceeded up to 20x. Session hot state and the copy-uniqueness window are no-ops.",
    };
  }
  const r = await cacheClient();
  if (!r || typeof r.ping !== "function") {
    return {
      configured: true,
      ok: false,
      latencyMs: null,
      detail: "REDIS_URL is set but no client could be created - check the URL and that ioredis can reach it.",
    };
  }
  const t0 = Date.now();
  try {
    const pong = await r.ping();
    const ms = Date.now() - t0;
    return {
      configured: true,
      ok: String(pong).toUpperCase() === "PONG",
      latencyMs: ms,
      detail:
        String(pong).toUpperCase() === "PONG"
          ? `PONG in ${ms}ms - atomic caps and session hot state are live.`
          : `Unexpected reply to PING: ${String(pong).slice(0, 40)}`,
    };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - t0,
      detail: `PING failed: ${e instanceof Error ? e.message : "unreachable"}. The atomic caps are silently back to per-process counting.`,
    };
  }
}

// 18h, matching search-session's STALE_CAP_MS EXACTLY. At 24h the cache
// outlived the window the Postgres path considers current, so a rival that
// Postgres had aged out was still citable from Redis for six more hours.
const TTL_S = 18 * 3600;

// ---------------------------------------------------------------------------
// Key schema - pure builders, exported for tests and the packages re-export.
// The offers ZSET is scoped by vehicleKey + currency so a rival can NEVER
// cross vehicle classes or currencies (mirrors pickCheapestRival's rules).
// ---------------------------------------------------------------------------

export function offersKey(searchId: string | number, vehicleKey: string, currency: string): string {
  return `session:${searchId}:${vehicleKey}:${currency}:offers`;
}
export function listPriceKey(searchId: string | number, vehicleKey: string, currency: string): string {
  return `session:${searchId}:${vehicleKey}:${currency}:list`;
}
/**
 * The set of currencies this session/vehicle has ever filed an offer under.
 *
 * WHY IT EXISTS: every offers ZSET is scoped by currency, so evicting a shop
 * requires knowing which currency its quote was filed under - and the turn that
 * needs to evict is usually the one with NO price ("sorry, we have nothing"),
 * where the only currency in hand is the one reconciled from the shop's region.
 * A shop that quoted in USD earlier and then declines would keep its USD row
 * for the rest of the TTL. This is a tiny HSET (a session realistically holds
 * one or two currencies) so the eviction can sweep every space the shop could
 * be in, using only commands `RedisLike` already declares.
 */
export function currenciesKey(searchId: string | number, vehicleKey: string): string {
  return `session:${searchId}:${vehicleKey}:currencies`;
}
export function aggKey(searchId: string | number): string {
  return `session:${searchId}:agg`;
}
export function liveFlagKey(searchId: string | number): string {
  return `session:${searchId}:live`;
}
export function eventsChannel(searchId: string | number): string {
  return `session:${searchId}:events`;
}

export interface SessionOfferWrite {
  searchId: string | number;
  vendorId: string;
  vehicleKey: string;
  currency: string;
  /** The shop's CURRENT per-day price (latest round). */
  pricePerDay: number;
  /** The FIRST quote - savings anchor. Only set on the first write per vendor. */
  listPricePerDay: number;
  durationDays: number;
  /**
   * The span this price was DERIVED over, when it was derived at all.
   *
   * THE CACHE MUST NOT HOLD WHAT POSTGRES REFUSES TO AUTHORIZE. The Postgres
   * rival path deliberately stores `effective_daily_rate: packageApplies ?
   * price : null` alongside `quote_basis_days`, so a 500-for-3-days package is
   * never cited at 167/day to a traveller renting one day. This write had no
   * such field and a comment asserting - wrongly - that a cache hit "is by
   * construction not package arithmetic". It was: agent-loop wrote every
   * usablePrice here unconditionally, so the exact wrong-number class the
   * Postgres filters exist for came straight back through the hot path, which
   * short-circuits them.
   */
  priceBasisDays?: number;
}

export interface SessionEventPayload {
  type: "offer" | "counter" | "state" | "message";
  vendorId?: string;
  pricePerDay?: number;
  at: string;
  detail?: string;
}

/** Publish a delta on the session channel (SSE fan-out subscribes). No-op when REDIS_URL is unset. */
export async function publishSessionEvent(
  searchId: string | number,
  event: SessionEventPayload
): Promise<void> {
  const r = await cacheClient();
  if (!r) return;
  try {
    await r.publish(eventsChannel(searchId), JSON.stringify(event));
  } catch {
    /* realtime is an enhancement - polling remains the fallback */
  }
}

/**
 * Record/refresh a shop's offer for a search session and recompute the
 * dashboard aggregates. Sets the `live` authority flag (worker-side writes
 * only reach here - a no-op when unset). BARGAINED mirrors the UI's truthful
 * calc: sum of max(0, list - current) * durationDays across vendors.
 */
export async function recordSessionOffer(w: SessionOfferWrite): Promise<void> {
  const r = await cacheClient();
  if (!r) return;
  try {
    const oKey = offersKey(w.searchId, w.vehicleKey, w.currency);
    const lKey = listPriceKey(w.searchId, w.vehicleKey, w.currency);
    // A PACKAGE RATE IS NOT A CITABLE RIVAL unless the traveller's own rental
    // covers the package. Same rule the Postgres path applies; it simply had no
    // way to reach here before. A basis the rental does not cover is EVICTED
    // rather than skipped, so a price that was citable and stopped being so
    // cannot linger for the TTL.
    const basis = w.priceBasisDays ?? 0;
    const packageApplies = basis <= 1 || (w.durationDays > 0 && w.durationDays >= basis);
    if (!packageApplies) {
      await r.zrem(oKey, w.vendorId).catch(() => {});
      return;
    }
    await r.zadd(oKey, String(w.pricePerDay), w.vendorId);
    // List price = FIRST quote only (NX semantics via manual exists check on
    // the hash field is racy; HSETNX isn't in our minimal type - read+set is
    // fine here because only ONE worker turn per thread runs at a time).
    const lists = await r.hgetall(lKey);
    if (!(w.vendorId in lists)) {
      await r.hset(lKey, w.vendorId, String(w.listPricePerDay));
      lists[w.vendorId] = String(w.listPricePerDay);
    }
    await r.set(liveFlagKey(w.searchId), "1", "EX", TTL_S);
    await r.expire(oKey, TTL_S);
    await r.expire(lKey, TTL_S);
    // Remember the currency space this offer lives in, so a later decline can
    // be evicted from it even when that turn carries no price of its own.
    const cKey = currenciesKey(w.searchId, w.vehicleKey);
    await r.hset(cKey, w.currency, "1");
    await r.expire(cKey, TTL_S);

    // Recompute aggregates from the full ZSET (cheap: a session holds <50 shops).
    const rows = await r.zrange(oKey, 0, -1, "WITHSCORES");
    let offersIn = 0;
    let bargained = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rows.length; i += 2) {
      const vendorId = rows[i];
      const current = Number(rows[i + 1]);
      if (!Number.isFinite(current)) continue;
      offersIn += 1;
      if (current < best) best = current;
      const list = Number(lists[vendorId] ?? current);
      if (Number.isFinite(list) && list > current) {
        bargained += Math.max(0, list - current) * Math.max(1, w.durationDays);
      }
    }
    const agg = aggKey(w.searchId);
    await r.hset(
      agg,
      "offersIn", String(offersIn),
      "bargained", String(Math.round(bargained)),
      "bestPricePerDay", Number.isFinite(best) ? String(best) : "",
      "currency", w.currency,
      "updatedAt", new Date().toISOString()
    );
    await r.expire(agg, TTL_S);

    await publishSessionEvent(w.searchId, {
      type: "offer",
      vendorId: w.vendorId,
      pricePerDay: w.pricePerDay,
      at: new Date().toISOString(),
    });
  } catch {
    /* cache write failure never breaks the turn - Postgres stays the truth */
  }
}

export interface CachedRivalQuery {
  searchId: string | number;
  vehicleKey: string;
  currency: string;
  excludeVendorId: string;
  /** Only a rival STRICTLY cheaper than this quote is leverage. */
  belowPrice: number;
}

/**
 * The cheapest OTHER shop's live offer for this exact session/vehicle/currency,
 * or null. Null also when: no REDIS_URL, the session isn't flagged
 * `live` (legacy session - cache not authoritative), or Redis is down.
 * Callers ALWAYS fall back to the Postgres path on null.
 */
export async function cheapestCachedRival(q: CachedRivalQuery): Promise<number | null> {
  const r = await cacheClient();
  if (!r) return null;
  try {
    if ((await r.exists(liveFlagKey(q.searchId))) !== 1) return null;
    const rows = await r.zrange(offersKey(q.searchId, q.vehicleKey, q.currency), 0, 9, "WITHSCORES");
    for (let i = 0; i < rows.length; i += 2) {
      if (rows[i] === q.excludeVendorId) continue;
      const price = Number(rows[i + 1]);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (price >= q.belowPrice) return null; // sorted ascending - no cheaper rival exists
      return price;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Drop a shop from the citable-rival set for one session.
 *
 * NOTHING EVICTED FROM THIS CACHE BEFORE. A shop that declined, went out of
 * stock, was suppressed fleet-wide or whose thread died stayed a citable rival
 * for the whole TTL - so the agent could tell a shop to beat a price from a
 * shop that had already refused to rent. The Postgres path filters dead phases;
 * the hot path, which short-circuits it, had no way to know.
 */
export async function dropSessionOffer(q: {
  searchId: string | number;
  vendorId: string;
  vehicleKey: string;
  currency: string;
}): Promise<void> {
  const r = await cacheClient();
  if (!r) return;
  try {
    await r.zrem(offersKey(q.searchId, q.vehicleKey, q.currency), q.vendorId);
  } catch {
    // The cache is never the source of truth; a failed eviction only means the
    // Postgres path stays authoritative for this shop, which is the safe side.
  }
}

/**
 * Drop a shop from EVERY currency space of one session/vehicle.
 *
 * THE TURN THAT NEEDS THIS HAS NO PRICE. `dropSessionOffer` needs a currency,
 * and the only caller that had one sat inside `if (usablePrice && ...)` - so it
 * ran only on turns that carried a price, which is precisely the turn a decline
 * is NOT. "Sorry, we have nothing" therefore never evicted anything: the shop's
 * earlier quote stayed citable for the rest of the 18h TTL, and the hot path
 * short-circuits the Postgres query whose dead-phase filter would have excluded
 * it. The agent could tell one shop to beat a price from a shop that had
 * already refused to rent.
 *
 * `fallbackCurrency` covers sessions written before the currency hash existed
 * (and a Redis that answers the zrem but not the hgetall): the caller passes the
 * currency it reconciled for this shop, which is the space the offer is in
 * unless the shop explicitly named a different one earlier.
 */
export async function dropSessionOfferAnyCurrency(q: {
  searchId: string | number;
  vendorId: string;
  vehicleKey: string;
  fallbackCurrency?: string | null;
}): Promise<void> {
  const r = await cacheClient();
  if (!r) return;
  const spaces = new Set<string>();
  if (q.fallbackCurrency) spaces.add(q.fallbackCurrency);
  try {
    const known = await r.hgetall(currenciesKey(q.searchId, q.vehicleKey));
    for (const cur of Object.keys(known ?? {})) if (cur) spaces.add(cur);
  } catch {
    // Unreadable currency set - the fallback space is still worth evicting.
  }
  for (const cur of spaces) {
    try {
      await r.zrem(offersKey(q.searchId, q.vehicleKey, cur), q.vendorId);
    } catch {
      // The cache is never the source of truth; a failed eviction only means
      // the Postgres path stays authoritative for this shop - the safe side.
    }
  }
}

/** Current dashboard aggregates for a session ({} when absent/unavailable). */
export async function sessionAggregates(
  searchId: string | number
): Promise<Record<string, string>> {
  const r = await cacheClient();
  if (!r) return {};
  try {
    return await r.hgetall(aggKey(searchId));
  } catch {
    return {};
  }
}
