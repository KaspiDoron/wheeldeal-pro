import "server-only";
import { sbSelect, sbSelectStrict } from "./runtime-config";

// The SEARCH-SESSION boundary + the ONE rival-selection predicate.
//
// "Use the best competing offer from THIS search session" was implemented as
// a flat 18-hour window - which leaked yesterday's offers into today's
// leverage (stale numbers the traveller is no longer comparing) and, being
// duplicated across the engine / agent-loop / bargain-draft / simulator,
// meant the playground never exercised the real selection logic at all.
//
// The boundary is server-derived (the user's latest `searches` row - the
// same signal the deals dashboard and the mass-bargain session cap already
// group by), clamped to 18h so an ancient still-open session cannot
// resurrect stale leverage either. The predicate is PURE and shared: the
// live engine and the playground filter through the exact same function, so
// what the owner tests is what production runs.

const STALE_CAP_MS = 18 * 3600_000;

/** ISO boundary: offers at/after this moment belong to the CURRENT session. */
export async function sessionSinceIso(userEmail: string): Promise<string> {
  return (await currentSession(userEmail)).sinceIso;
}

/**
 * The traveller's CURRENT search session: its id (for exact rival scoping) and
 * an ISO time boundary (the belt-and-suspenders fallback). The id is the single
 * source of truth - it is the SAME id offers are stamped with (agent-loop
 * search_id), so a rival scoped by id can never be an offer from a DIFFERENT
 * search that merely happens to fall inside an 18h window.
 */
export async function currentSession(
  userEmail: string
): Promise<{ id?: number; sinceIso: string }> {
  const fallback = new Date(Date.now() - STALE_CAP_MS).toISOString();
  const rows = await sbSelect<{ id: number; created_at: string }>(
    "searches",
    `select=id,created_at&user_email=eq.${encodeURIComponent(
      userEmail
    )}&order=created_at.desc&limit=1`
  ).catch(() => []);
  const start = rows[0]?.created_at;
  return {
    id: rows[0]?.id,
    // The LATER bound wins: never before this session started, never staler
    // than 18h even inside a long-running session.
    sinceIso: start && start > fallback ? start : fallback,
  };
}

/**
 * The one server-side rival lookup every surface shares (engine IO,
 * legacy agent-loop, bargain-draft). Fetches this session's offers and runs
 * them through the pure predicate below.
 */
export async function cheapestRivalFor(
  userEmail: string,
  args: { vendorId: string; currency: string; vehicleKey: string; belowPrice: number; durationDays?: number }
): Promise<number | undefined> {
  return (await cheapestRivalQuoteFor(userEmail, args))?.pricePerDay;
}

/**
 * The same lookup, WITH provenance - what a message composer needs.
 *
 * `cheapestRivalFor` returns a bare number, which is exactly how a per-day we
 * derived from someone's 3-day package became a sentence claiming a shop quoted
 * it. This returns the span too, so the composer can say "their 3-day price
 * works out to about 167/day" or drop the card entirely.
 */
export async function cheapestRivalQuoteFor(
  userEmail: string,
  args: { vendorId: string; currency: string; vehicleKey: string; belowPrice: number; durationDays?: number }
): Promise<RivalPick | null> {
  const session = await currentSession(userEmail);

  // HOT PATH (Module 2): O(log n) Redis ZSET read, scoped to this exact
  // session + vehicle + currency. Only authoritative for sessions the worker
  // runtime ingested (the `live` flag) - for a keyless host or a legacy
  // session this returns null and the Postgres path below stays the truth.
  if (session.id != null) {
    const { cheapestCachedRival } = await import("./rival-cache");
    const cached = await cheapestCachedRival({
      searchId: session.id,
      vehicleKey: args.vehicleKey,
      currency: args.currency,
      excludeVendorId: args.vendorId,
      belowPrice: args.belowPrice,
    });
    // THAT COMMENT WAS FALSE, and it was load-bearing.
    //
    // It claimed the cache "stores quoted daily rates only, so a hit is by
    // construction not package arithmetic" - while agent-loop wrote every
    // usablePrice into it unconditionally, package divisions included. So a
    // 500-for-3-days quoted at 167/day was citable to a one-day traveller
    // through the hot path, which returns BEFORE the Postgres filters that
    // exist to catch exactly that. The write now refuses (and evicts) a basis
    // the rental does not cover, so the claim is finally true by construction
    // rather than by assertion - and the basis travels with the pick so the
    // caller can still see it is derived.
    if (cached != null) return { pricePerDay: cached };
  }

  const select =
    "vendor_id,price_per_day,currency,vehicle_key,effective_daily_rate,created_at,search_id,quote_basis_days";
  const where =
    `&user_email=eq.${encodeURIComponent(userEmail)}&simulated=eq.false&currency=eq.${encodeURIComponent(
      args.currency
    )}&vehicle_key=eq.${encodeURIComponent(args.vehicleKey)}&created_at=gte.${encodeURIComponent(
      session.sinceIso
    )}&order=price_per_day.asc&limit=24`;
  type OfferRow = {
    vendor_id: string;
    price_per_day: number;
    currency: string;
    vehicle_key: string | null;
    effective_daily_rate: number | null;
    created_at: string;
    search_id: number | null;
    quote_basis_days?: number | null;
  };
  // Schema-graceful, like every other read of a freshly-added column: a host
  // that has not re-run schema.sql gets the same selection minus provenance
  // rather than an empty rival set. `sbSelectStrict`, not `sbSelect`, precisely
  // because sbSelect collapses "the column does not exist" into [] - and an
  // empty rival set is indistinguishable from a hunt with no rivals yet, which
  // is how a missing migration would silently disable cross-shop leverage.
  const strict = await sbSelectStrict<OfferRow>("offers", `select=${select}${where}`);
  const rows =
    "rows" in strict
      ? strict.rows
      : await sbSelect<OfferRow>(
          "offers",
          `select=${select.replace(",quote_basis_days", "")}${where}`
        ).catch(() => []);
  return pickRival(
    rows.map((r) => ({
      vendorId: r.vendor_id,
      pricePerDay: r.price_per_day,
      currency: r.currency,
      vehicleKey: r.vehicle_key,
      effectiveDailyRate: r.effective_daily_rate,
      createdAt: r.created_at,
      searchId: r.search_id,
      quoteBasisDays: r.quote_basis_days ?? null,
    })),
    { ...args, sinceIso: session.sinceIso, searchId: session.id }
  );
}

export interface RivalOffer {
  vendorId: string;
  pricePerDay: number;
  currency: string;
  vehicleKey?: string | null;
  /** Duration-aware daily rate (discounted weekly deals etc.) when known. */
  effectiveDailyRate?: number | null;
  createdAt: string; // ISO
  /** The search this offer belongs to - the exact, leak-proof session key. */
  searchId?: number | null;
  /**
   * PROVENANCE: the span this per-day figure was DIVIDED out of, when it was
   * derived rather than quoted ("500 for 3 days" -> 167/day, basis 3). Null or
   * absent = the shop stated a daily rate. See offers.quote_basis_days.
   */
  quoteBasisDays?: number | null;
}

/** A chosen rival, with enough provenance to say it honestly. */
export interface RivalPick {
  /** The per-day figure to cite. */
  pricePerDay: number;
  /**
   * Set when `pricePerDay` is package arithmetic rather than a quoted daily
   * rate. Every surface that repeats it must say so ("their 3-day price works
   * out to about 167/day") - never "they quoted me 167 a day".
   */
  derivedFromDays?: number;
}

/**
 * The cheapest REAL rival for a negotiation - pure and deterministic.
 * Rules (each one deliberate):
 *  - same session only (createdAt >= sinceIso)
 *  - same currency EXACTLY (comparing across currencies without FX invents
 *    leverage - a mismatch is surfaced by the caller, never guessed through)
 *  - same vehicle class exactly
 *  - a DIFFERENT shop
 *  - duration-aware: the effective daily rate (when known) beats the sticker
 *    per-day price, so a weekly-deal rival is compared honestly
 *  - strictly cheaper than the quote being negotiated
 */
export interface RivalArgs {
  vendorId: string;
  currency: string;
  vehicleKey: string;
  belowPrice: number;
  sinceIso: string;
  /** The current search's id. When known, a rival MUST belong to it -
   * exact-match scoping that a time window alone cannot guarantee. */
  searchId?: number | null;
  /**
   * How many days the traveller is actually renting. A rival per-day DERIVED
   * from a longer package is only like-for-like once the traveller stays long
   * enough to earn that package; below that it is arithmetic, not an offer.
   * Absent = unknown, and the conservative reading applies (see below).
   */
  durationDays?: number;
}

/**
 * The cheapest REAL rival for a negotiation, with its provenance - pure and
 * deterministic. Rules (each one deliberate):
 *  - same session only (createdAt >= sinceIso, or exact searchId)
 *  - same currency EXACTLY (comparing across currencies without FX invents
 *    leverage - a mismatch is surfaced by the caller, never guessed through)
 *  - same vehicle class exactly
 *  - a DIFFERENT shop
 *  - duration-aware: the effective daily rate (when known) beats the sticker
 *    per-day price, so a weekly-deal rival is compared honestly
 *  - DERIVED prices carry their span out with them, so the caller can phrase
 *    them as arithmetic instead of as a quote
 *  - strictly cheaper than the quote being negotiated
 */
export function pickRival(offers: RivalOffer[], args: RivalArgs): RivalPick | null {
  let best: RivalPick | null = null;
  for (const o of offers) {
    if (o.vendorId === args.vendorId) continue;
    if (o.currency !== args.currency) continue;
    // FAIL CLOSED on an unknown vehicle: a null vehicle_key must NEVER be
    // treated as "matches anything" - that let a wrong-vehicle offer qualify as
    // a rival. A rival must POSITIVELY match the requested vehicle bucket.
    if (!o.vehicleKey || o.vehicleKey !== args.vehicleKey) continue;
    // EXACT SESSION SCOPING: when we know this negotiation's search id, a rival
    // must belong to the SAME search. This is leak-proof where the 18h time
    // window is not - two searches minutes apart no longer cross-contaminate.
    // Only when the session id is unknown do we fall back to the time boundary.
    if (args.searchId != null) {
      if (o.searchId !== args.searchId) continue;
    } else if (o.createdAt < args.sinceIso) {
      continue;
    }
    // DURATION AWARENESS, THE HALF THAT WAS MISSING (owner report 5 #2).
    //
    // `offers.duration_days` was written and never read here, and the per-day
    // figure carried no marker for having been divided out of a package - so a
    // 167 that only exists because a shop quoted 500 for THREE days was handed
    // to the composer as a rival for a ONE-day rental, which then welded the
    // current duration onto it: "167/day for 1 day", a price no shop ever said,
    // and the prompt forbade the model from softening it.
    //
    // A package basis longer than the traveller's rental is not leverage. It is
    // dropped rather than discounted, because we do not know what that shop
    // would charge for one day - guessing a markup would invent a second number
    // on top of the first.
    const basis = typeof o.quoteBasisDays === "number" && o.quoteBasisDays > 0 ? o.quoteBasisDays : undefined;
    if (basis && basis > 1) {
      // Unknown duration is treated as the shortest possible rental: the whole
      // point of this guard is that we must not assert a package rate applies.
      const renting = typeof args.durationDays === "number" && args.durationDays > 0 ? args.durationDays : 1;
      if (basis > renting) continue;
    }
    const rate =
      typeof o.effectiveDailyRate === "number" && o.effectiveDailyRate > 0
        ? Math.min(o.effectiveDailyRate, o.pricePerDay)
        : o.pricePerDay;
    if (!(rate > 0) || rate >= args.belowPrice) continue;
    if (best === null || rate < best.pricePerDay) {
      best = { pricePerDay: rate, derivedFromDays: basis };
    }
  }
  return best;
}

/** The cheapest rival's NUMBER. Thin wrapper over `pickRival` for the callers
 *  that only need the figure; anything that repeats it in a message should use
 *  `pickRival` so it can phrase a derived price honestly. */
export function pickCheapestRival(offers: RivalOffer[], args: RivalArgs): number | undefined {
  return pickRival(offers, args)?.pricePerDay;
}
