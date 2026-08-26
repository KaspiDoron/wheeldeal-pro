// NEGOTIATION-INTEGRITY GUARDRAILS - the deterministic pre-send validation an
// LLM draft must survive before it can reach a real rental shop. These catch
// the three catastrophic failure classes an autoregressive model produces no
// matter how carefully it is prompted:
//
//   1. FABRICATED LEVERAGE  - "another shop quoted 220" when NO rival exists.
//   2. INVERTED / SUB-FLOOR MATH - proposing MORE than the shop's live price
//      (600 when they offered 500), or LESS than the real market floor (200
//      when the floor is 280) - both breach the negotiation's basic arithmetic.
//   3. HARD-CONSTRAINT BREACH - bargaining on / accepting a vehicle that
//      violates the traveller's immutable filter (a manual was requested, the
//      shop pivoted to an automatic scooter).
//
// Pure + fully unit-tested: no IO, no server-only, so the engine, the
// playground and the tests all exercise byte-for-byte identical logic.

import type { ExtractedOffer } from "../agents";
import type { StructuredRFQ } from "../types";
// The ONE digit fold (18 scripts). See the note beside extractPriceNumbers
// for why this file must not keep its own.
import { normalizeDigits } from "../integrity/translation";

// ---------------------------------------------------------------------------
// Money-number extraction (the hard part: telling a PRICE from a cc / day / %)
// ---------------------------------------------------------------------------

// A unit suffix that proves a number is NOT a price (immediately trailing it,
// optionally after one space). "125cc", "45,000 km", "4 days", "50 %".
const UNIT_SUFFIX =
  /^(?:\s?)(cc|km|kmh|km\/h|kg|%|percent|hp|cm|mm|mins?|minutes?|hrs?|hours?|days?|day|nights?|weeks?|months?|seats?|people|persons?|pax|yo|years?|am|pm|:\d)/i;

// A deposit / bond / insurance figure is money, but NOT the daily-rate ask -
// so it must never be judged against the floor/ceiling. Matched within a short
// window on either side of the number.
const DEPOSIT_CTX = /(deposit|bond|caution|down\s?payment|security|passport|insurance)/i;
// A temporal cue right before a 4-digit number means it is a YEAR, not a price.
const TEMPORAL = /(in|by|until|till|since|around|before|after|come|back|return|year|month)\s*$/i;

// ONE DIGIT RULE, NOT TWO. This file used to carry its OWN fold, covering four
// scripts (Arabic-Indic, Persian, Thai, Devanagari) while `integrity/translation`
// covered eighteen. That is not a style difference - it decided whether these
// rails could READ the message they were validating.
//
// Owner report 8.1 F4 already found this exact bug class once, in `citedRival`,
// and fixed it by wiring the 18-script fold into `spte/*`. The fix never reached
// here, and `spte/rails.ts` ended up importing BOTH: the 18-script fold on line
// 15 for cite-the-rival, and this file's 4-script one on line 9 for
// checkOutboundNumbers, correctDuration and verbatimNumerals. One file, two
// strengths of the same rule.
//
// The reason nobody saw it for ten audit rounds is mechanical: this file
// contained raw control bytes, so `grep`, ripgrep and `git diff` all treated it
// as binary and silently skipped it (fixed in the commit before this one).
//
// It failed OPEN, which is the worst direction. Reproduced against the live
// modules with the thread grounded at 250 and the model inventing 180:
//
//   ASCII / Thai            rail ok=false  ungrounded-number   <- correct
//   Lao / Khmer / Myanmar   rail ok=TRUE   sees no numbers     <- price SENT
//   Bengali / Fullwidth     rail ok=TRUE   sees no numbers     <- price SENT
//
// ...in three markets this app explicitly supports (855/856/95 have had
// business-hours gating since owner report 8 wave D), and the comment at
// `spte/rails.ts:496` names Lao, Khmer and Myanmar three lines after asserting a
// draft is "already validated as real by checkOutboundNumbers below".
// The fold itself is imported at the top of this file. NOT re-exported:
// nothing imports `normalizeDigits` from here, and leaving a second door open is
// how a codebase grows a second copy again.

/**
 * Every PRICE-scale number in a message, with the non-price numbers removed:
 *  - numbers glued to a unit ("125cc", "4 days", "45,000 km")
 *  - the caller's known spec numbers (duration, engine cc, seats, ...)
 *  - clock times ("10:30")
 * Thousands separators (",", ".", spaces between 3-digit groups) are tolerated
 * and stripped so "1,200" and "1200" read identically. Deliberately
 * conservative: when in doubt a number is KEPT (a real price wrongly dropped is
 * a missed guard; a stray non-price kept only risks an over-cautious re-compose).
 */
export function extractPriceNumbers(text: string, excludeExact: number[] = []): number[] {
  if (!text) return [];
  const src = normalizeDigits(text);
  const exclude = new Set(excludeExact.filter((n) => Number.isFinite(n) && n > 0));
  const out: number[] = [];
  // Match a run of digits with optional thousands grouping. Capture where it
  // ends so we can inspect the immediately-following unit suffix.
  const rx = /(\d{1,3}(?:[.,  ]\d{3})+|\d+)(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) {
    const raw = m[1];
    const after = src.slice(rx.lastIndex);
    const before = src.slice(0, m.index);
    // A clock time ("10:30") - the ":" guard, or a unit suffix -> not a price.
    if (UNIT_SUFFIX.test(after)) continue;
    // A time like "10:30" leaves ":30" after the "10" (caught above) but also
    // guard a leading ratio "1:200".
    if (/^\s?:/.test(after)) continue;
    // The minute half of a time ("...10:30") or a ratio's tail is preceded by
    // a colon - not a standalone price.
    if (/:$/.test(before)) continue;
    // A deposit / bond / insurance figure is money but NOT the daily-rate ask,
    // so it must never be judged against the floor/ceiling ("the 3000 deposit
    // is ok, can you do 400?" must pass).
    if (DEPOSIT_CTX.test(before.slice(-16)) || DEPOSIT_CTX.test(after.slice(0, 16))) continue;
    const n = Number(raw.replace(/[.,  ]/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    // A 4-digit calendar year after a temporal cue ("come back in 2025") is a
    // date, not a price - never let it trip the inverted-ask ceiling.
    if (n >= 1990 && n <= 2099 && raw.length === 4 && TEMPORAL.test(before)) continue;
    if (exclude.has(n)) continue;
    out.push(n);
  }
  return out;
}

/**
 * The VERBATIM half of the provenance basis: every price-scale numeral a
 * stretch of the conversation actually contains, read by the exact same
 * extractor the outbound check itself uses - so a numeral the check would
 * flag in a draft is, by construction, recognisable here whenever the thread
 * already holds it (a shop-stated deposit, a repeated ask, a posted tier).
 */
export function verbatimNumerals(texts: Array<string | undefined | null>): number[] {
  const out: number[] = [];
  for (const t of texts) if (t) out.push(...extractPriceNumbers(t));
  return out;
}

// A phrase that CLAIMS a competing shop's price ("another shop quoted ...",
// "other guy gave me ...", "elsewhere it's ..."). Paired with a number this is
// leverage the message is ASSERTING as fact - it must be a real rival, never
// invented. Vague comparisons WITHOUT a number ("I'm comparing a few shops")
// are honest and deliberately NOT matched.
// TIGHT on purpose: only a phrase that asserts a COMPETING VENDOR gave a price
// counts. A bare "another"/"other"/"nearby" is NOT enough - "do you have
// another price?", "any other price?", "i'm staying nearby" are ordinary
// haggling and must never be mistaken for a fabricated rival. A competitor
// NOUN (shop / place / guy / vendor / ...) or an unambiguous locative
// (elsewhere / next door / down the road / competitor) is required.
const RIVAL_CLAIM =
  /(?:\b(?:another|other|different|nearby|competing|rival)\s+(?:shop|place|store|guy|dude|vendor|rental|dealer|company|owner|man|lady|seller)\b|\belse\s?where\b|\bnext\s?door\b|\bdown\s+the\s+(?:road|street)\b|\bcompetitor\b)/i;

/**
 * The specific competing PRICE a message asserts, if any. Scans a window around
 * every rival-claim phrase for a price-scale number. Returns the first such
 * number, or undefined when the message makes no numeric rival claim.
 */
export function claimedRivalNumber(text: string, excludeExact: number[] = []): number | undefined {
  const all = rivalClaimNumbers(text, excludeExact);
  return all.length ? all[0] : undefined;
}

/**
 * EVERY price-scale number that appears inside a rival-claim window (the ~40
 * chars around each "another shop ..." phrase). Used to decide whether a
 * claim is BACKED by a real rival: only a number the claim itself references
 * counts - a number that is merely our own ask, sitting elsewhere in the
 * message, must never launder a fabricated rival past the guard.
 */
export function rivalClaimNumbers(text: string, excludeExact: number[] = []): number[] {
  if (!text || !RIVAL_CLAIM.test(text)) return [];
  const exclude = new Set(excludeExact.filter((n) => Number.isFinite(n) && n > 0));
  const rx = new RegExp(RIVAL_CLAIM.source, "gi");
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const start = Math.max(0, m.index - 12);
    const window = text.slice(start, m.index + m[0].length + 40);
    out.push(...extractPriceNumbers(window, [...exclude]));
  }
  return out;
}

/**
 * Remove any sentence that asserts a competing shop's PRICE ("another shop
 * quoted 220") - used to repair a NON-bargain draft that fabricated a rival
 * (a bargain draft is instead rebuilt into a clean safe ask). Returns the
 * scrubbed text, or null when scrubbing left nothing meaningful.
 */
export function stripRivalClaims(text: string): string | null {
  if (!text) return null;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => claimedRivalNumber(s) === undefined);
  const out = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  return out.length >= 8 ? out : null;
}

// ---------------------------------------------------------------------------
// The outbound numeric check
// ---------------------------------------------------------------------------

export type NumberViolation =
  | "fabricated-rival"
  | "below-floor"
  | "above-quote"
  | "ungrounded-number";

export interface NumberCheckArgs {
  text: string;
  /** The shop's own current/live price - our ask must never EXCEED it. */
  ceiling?: number;
  /** The real market floor (same currency) - our ask must never go BELOW it. */
  floor?: number;
  /** The ONE real rival price, when a cheaper same-session offer exists. */
  rivalPrice?: number;
  /**
   * EVERY real rival price this turn was allowed to see. The prompt shows the
   * model up to four rivals, but the rail used to back only `rivalPrice` - so
   * citing rival #2 was scored as a fabrication and the whole draft was thrown
   * away for a rival-free template. A number is backed if it matches ANY real
   * rival; `rivalPrice` stays the one used for the sub-floor exemption.
   */
  rivalPrices?: number[];
  /** Non-price numbers to ignore (duration days, engine cc, seats, ...). */
  excludeExact?: number[];
  /** Numbers that may legitimately appear ABOVE the ceiling (e.g. a posted
   * list/sheet price the ask references) - excluded from the inverted check so
   * "your board says 1200, can you do 900?" is not mistaken for an inverted ask,
   * while an ACTUAL inverted ask (600 above a 500 quote) is still caught. */
  allowAbove?: number[];
  /**
   * PROVENANCE (grounded numerals). Every price-scale number the structured
   * state actually holds for this thread: the shop's quotes, our ladder
   * target, the list/sheet price, the benchmark, real rivals. When provided,
   * every price-scale numeral in the draft must be PROVABLE - equal to a
   * grounded numeral, or a CLOSED ARITHMETIC DERIVATION of one with role
   * compatibility (total/days, daily*days, rounded variants). "1200 for 6
   * days" grounds "200/day" even though 200 never appeared verbatim; a
   * hallucinated "300" with no derivation path is rejected. Bounds alone
   * could never catch that - an invented number BETWEEN floor and quote (or
   * with no known ceiling at all, the field's "Your price 300 is too much"
   * against a 250B greeting) sailed through.
   */
  grounded?: number[];
  /** The rental length - the denominator/multiplier derivations are legal over. */
  durationDays?: number;
  /** Only the ask-a-price node needs the floor/ceiling checks. */
  checkAskBounds: boolean;
}

export interface NumberCheckResult {
  ok: boolean;
  violation?: NumberViolation;
  detail: string;
  offending?: number;
}

const RIVAL_TOLERANCE = 0.05; // a claimed rival within 5% of the real one is fine
const BOUND_TOLERANCE = 0.02; // 2% rounding slack on floor/ceiling comparisons

/**
 * The CLOSED derivation set over the grounded numerals: each grounded number
 * itself, its total<->daily conversions over the rental length, and the
 * human-rounded variants of each (an agent asking "180" against a 183 target
 * is honest rounding, not invention). Closed on purpose - sums, products of
 * two prices, or free arithmetic would let almost anything through.
 */
export function groundedDerivations(grounded: number[], durationDays?: number): number[] {
  const out = new Set<number>();
  const add = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return;
    out.add(n);
    for (const step of [5, 10, 50]) out.add(Math.round(n / step) * step);
  };
  for (const g of grounded) {
    if (!Number.isFinite(g) || g <= 0) continue;
    add(g);
    if (durationDays && durationDays > 1) {
      add(g / durationDays); // a stated total grounds its daily rate
      add(g * durationDays); // a stated daily grounds the trip total
    }
  }
  return [...out];
}

/** Is `n` provable from the derivation basis (±2% or ±1, whichever is wider)? */
export function isGroundedNumber(n: number, basis: number[]): boolean {
  return basis.some((b) => Math.abs(n - b) <= Math.max(1, b * BOUND_TOLERANCE));
}

// ---------------------------------------------------------------------------
// Duration integrity - the outbound must state the traveller's REAL rental days
// ---------------------------------------------------------------------------
//
// The single most damaging LLM slip observed in production: the traveller
// searched for 5 days, the opener correctly said "5 days", but the bargain
// message told the shop "for 3 days" (a hallucinated number, contaminated by
// few-shot examples that happened to use 3). Beyond looking incoherent, it
// SABOTAGES the deal - a shop that gives a discount "for long term" is told a
// shorter rental. checkOutboundNumbers can NEVER catch this: it deliberately
// strips every "N days" token as a non-price. So duration gets its own
// deterministic gate: any rental-length the message names that is not the real
// duration is re-templated to the truth. Pure, so both the engine and the
// legacy path share byte-identical behaviour.

// A number glued to a duration unit, tolerating a hyphen ("3-day rental"),
// a space ("3 days") or nothing. Weeks are normalised to days (x7); "night(s)"
// counts as days (a 5-night rental is 5 rental-days here).
const DURATION_TOKEN = /(\d{1,3})\s*-?\s*(day|days|night|nights|week|weeks)\b/gi;

/** Day counts the message asserts as the rental length (weeks x7), in order. */
export function citedDurationDays(text: string): number[] {
  if (!text) return [];
  const src = normalizeDigits(text);
  const out: number[] = [];
  const rx = new RegExp(DURATION_TOKEN.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) {
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = m[2].toLowerCase();
    out.push(/week/.test(unit) ? n * 7 : n);
  }
  return out;
}

/**
 * Rewrite any wrong rental-length the message states to the REAL duration.
 * "For 3 days tho..." with a 5-day rental -> "For 5 days tho...". Only touches
 * a token whose resolved day-count differs from durationDays AND is a plausible
 * rental length (1..90) - a stray "open 3 days a week" style number outside that
 * band is left alone. Returns the corrected text and whether anything changed.
 */
export function correctDuration(
  text: string,
  durationDays: number | undefined
): { text: string; changed: boolean; from: number[] } {
  if (!text || !durationDays || durationDays < 1) return { text, changed: false, from: [] };
  const from: number[] = [];
  const canonical = `${durationDays} ${durationDays === 1 ? "day" : "days"}`;
  // MATCH ON THE FOLDED TEXT, SPLICE INTO THE ORIGINAL.
  //
  // This used to run `.replace()` straight over `text`, so it only ever saw
  // ASCII digits: on a message localized into Thai, Lao, Khmer or Myanmar it
  // matched nothing and the wrong rental length went out untouched. Folding the
  // digits fixes DETECTION, but folding the text we SEND would also rewrite the
  // price's script - so the fold is used to find the span and the original
  // string is what gets edited.
  //
  // Safe because `normalizeDigits` is a 1:1 code-point map: every digit becomes
  // exactly one ASCII character and everything else (emoji, flags, astral-plane
  // symbols) passes through unchanged, so the two strings share indices. Pinned
  // by a test, because the whole splice rests on it.
  const folded = normalizeDigits(text);
  const rx = new RegExp(DURATION_TOKEN.source, "gi");
  let out = "";
  let cursor = 0;
  for (const m of folded.matchAll(rx)) {
    const whole = m[0];
    const n = parseInt(m[1], 10);
    const at = m.index ?? 0;
    if (!Number.isFinite(n) || n <= 0) continue;
    const resolved = /week/i.test(m[2]) ? n * 7 : n;
    // Same length (allowing weeks==days-equivalent) or an implausible length ->
    // leave untouched.
    if (resolved === durationDays) continue;
    if (resolved < 1 || resolved > 90) continue;
    from.push(resolved);
    out += text.slice(cursor, at) + canonical;
    cursor = at + whole.length;
  }
  out += text.slice(cursor);
  return { text: from.length > 0 ? out : text, changed: from.length > 0, from };
}

/**
 * Validate the numbers a drafted message is about to assert. Deterministic and
 * order-stable: fabricated-rival is checked first (a lie is the worst), then
 * the floor, then the inverted-ask ceiling.
 */
export function checkOutboundNumbers(args: NumberCheckArgs): NumberCheckResult {
  const { text, ceiling, floor, rivalPrice, excludeExact = [], checkAskBounds } = args;

  // 1) FABRICATED LEVERAGE - a numeric rival claim with no matching real rival.
  const realRivals = [
    ...(args.rivalPrices ?? []),
    ...(rivalPrice !== undefined ? [rivalPrice] : []),
  ].filter((n) => typeof n === "number" && n > 0);
  const claimed = claimedRivalNumber(text, excludeExact);
  if (claimed !== undefined) {
    const near = (n: number) =>
      realRivals.some((r) => Math.abs(n - r) <= Math.max(1, r * RIVAL_TOLERANCE));
    // Backed ONLY when the number ATTRIBUTED to the rival (the one the claim
    // names, right after "another shop gave me ...") matches a real rival.
    // The old rule backed the claim if the real rival appeared ANYWHERE among
    // the message numbers - so our own ask, sitting near a real rival, laundered
    // a DIFFERENT fabricated rival ("another shop gave me 260, can you do 200?"
    // with a real 205 rival). Only the claimed number itself can vouch for it.
    const backed = near(claimed);
    if (!backed) {
      return {
        ok: false,
        violation: "fabricated-rival",
        offending: claimed,
        detail: realRivals.length
          ? `message claims a rival at ${claimed} but the real rivals are ${realRivals.join(", ")}`
          : `message claims a rival price of ${claimed} but no competing offer exists in this session`,
      };
    }
  }

  // 1.5) PROVENANCE - every price-scale numeral must be provable from the
  // structured state: a grounded numeral or a closed derivation over it.
  // DERIVED RATES ARE GROUNDED ("1200 for 6 days" makes "200/day" legal even
  // though 200 never appeared verbatim); an invented "300" is not, whatever
  // the bounds say. Runs whenever the caller supplied grounded state; a
  // thread with no known numbers cannot ground anything and is skipped
  // (fail-open - the bounds checks below still apply).
  if (args.grounded && args.grounded.length > 0) {
    const basis = groundedDerivations(
      [
        ...args.grounded,
        ...realRivals,
        ...(args.allowAbove ?? []),
        ...(ceiling && ceiling > 0 ? [ceiling] : []),
        ...(floor && floor > 0 ? [floor] : []),
      ],
      args.durationDays
    );
    // An ask that sits strictly inside a KNOWN [floor, ceiling] is the
    // ladder's own legal range - the bounds ground it even when the composer
    // forgot to stamp its counter. The field's "Your price 300" had no such
    // range: the extractor had missed the quote, so nothing grounded a 300.
    const insideAskRange = (n: number) =>
      Boolean(checkAskBounds && floor && ceiling && n >= floor && n <= ceiling);
    // A URL's digits are an address, not an assertion (a maps link is
    // separately verified by the location rail).
    const prose = text.replace(/https?:\/\/\S+/gi, " ");
    // Sub-20 numerals are counts/ordinals territory ("2 helmets"), not prices.
    const offender = extractPriceNumbers(prose, excludeExact).find(
      (n) => n >= 20 && !isGroundedNumber(n, basis) && !insideAskRange(n)
    );
    if (offender !== undefined) {
      return {
        ok: false,
        violation: "ungrounded-number",
        offending: offender,
        detail: `message names ${offender}, which is neither a number this thread holds nor a derivation of one (grounded: ${args.grounded.join(", ")})`,
      };
    }
  }

  if (!checkAskBounds) return { ok: true, detail: "no price bounds to check" };

  // Every price-scale number the message names (excluding the known non-price
  // spec numbers and any real rival, which is legitimately below the floor-safe
  // band only when it genuinely undercuts - but a real rival is by construction
  // >= floor, so it never trips the floor check).
  const nums = extractPriceNumbers(text, excludeExact);

  // 2) SUB-FLOOR - never name OUR OWN ask below the real market floor. A REAL
  // competitor price (rivalPrice) is exempt: a genuine rival can legitimately
  // sit below our stale floor, and we are quoting THEM, not lowballing.
  if (floor && floor > 0) {
    const rival = rivalPrice && rivalPrice > 0 ? rivalPrice : undefined;
    // EXACT (±1) match only - a distinct sub-floor OWN ask near the rival must
    // still be caught, so the exemption is not a 5% band here.
    const isRival = (n: number) => rival !== undefined && Math.abs(n - rival) <= 1;
    const asks = nums.filter((n) => !isRival(n));
    const lowest = Math.min(...(asks.length ? asks : [Infinity]));
    if (Number.isFinite(lowest) && lowest < floor * (1 - BOUND_TOLERANCE)) {
      return {
        ok: false,
        violation: "below-floor",
        offending: lowest,
        detail: `message names ${lowest}, below the market floor of ${floor}`,
      };
    }
  }

  // 3) INVERTED ASK - never name a price ABOVE the shop's live quote (we are
  // asking for LESS, always). Catches "can you do 600?" after they offered 500.
  // A whitelisted reference (a posted list price the ask legitimately cites) is
  // excluded so it is not mistaken for the ask itself.
  if (ceiling && ceiling > 0) {
    const allow = (args.allowAbove ?? []).filter((n) => n > 0);
    const isRef = (n: number) =>
      allow.some((a) => Math.abs(n - a) <= Math.max(1, a * BOUND_TOLERANCE));
    const asks = nums.filter((n) => !isRef(n));
    const highest = Math.max(...(asks.length ? asks : [-Infinity]));
    if (Number.isFinite(highest) && highest > ceiling * (1 + BOUND_TOLERANCE)) {
      return {
        ok: false,
        violation: "above-quote",
        offending: highest,
        detail: `message names ${highest}, above the shop's current price of ${ceiling} (an inverted ask)`,
      };
    }
  }

  return { ok: true, detail: "numbers within [floor, quote]" };
}

// ---------------------------------------------------------------------------
// Hard feature constraints (transmission / class the traveller pinned)
// ---------------------------------------------------------------------------

/**
 * Did the traveller pin an IMMUTABLE vehicle feature? A specified transmission
 * (manual vs automatic) or a specific car body type is a hard filter - the
 * agent must never silently accept a vehicle that violates it.
 */
export function hasHardConstraint(rfq: StructuredRFQ | null | undefined): boolean {
  if (!rfq) return false;
  if (rfq.transmission === "manual" || rfq.transmission === "automatic") return true;
  if (rfq.vehicleClass === "car" && rfq.carType && rfq.carType !== "any") return true;
  return false;
}

/**
 * The shop's reply is for a vehicle that BREACHES a hard constraint. We trust
 * the extractor's matchesSpec verdict (it compares the shop's vehicle to the
 * exact request) and only escalate to "breach" when the traveller actually
 * pinned a hard feature - a soft cc/model mismatch is a clarify, a hard
 * transmission/type mismatch is a decline.
 */
export function hardConstraintBreached(
  rfq: StructuredRFQ | null | undefined,
  extraction: ExtractedOffer | null | undefined
): boolean {
  if (!extraction || extraction.matchesSpec !== false) return false;
  if (!hasHardConstraint(rfq)) return false;
  // A price for the wrong vehicle only matters once there IS a price to accept
  // or bargain on; a bare "sorry only automatic" with no number is handled by
  // the normal clarify path.
  return Boolean(extraction.found && extraction.pricePerDay);
}

const VEHICLE_WORD = (rfq: StructuredRFQ): string => {
  if (rfq.vehicleClass === "car") {
    const bits = [
      rfq.transmission !== "any" ? rfq.transmission : "",
      rfq.carType && rfq.carType !== "any" ? rfq.carType : "",
      "car",
    ].filter(Boolean);
    return bits.join(" ");
  }
  const cc = rfq.engineSizeCc ? `${rfq.engineSizeCc}cc ` : "";
  const trans = rfq.transmission === "manual" ? "manual " : rfq.transmission === "automatic" ? "automatic " : "";
  const base = rfq.vehicleClass === "scooter" ? "scooter" : "motorbike";
  return `${cc}${trans}${base}`.trim();
};

/**
 * The message the agent sends INSTEAD of bargaining on a wrong-vehicle offer:
 * a short, warm, non-native decline that restates the hard requirement and
 * asks if they have the right one - never accepts the pivot. Deterministic so
 * it never reintroduces a hallucinated price.
 */
export function hardConstraintDecline(rfq: StructuredRFQ): string {
  const want = VEHICLE_WORD(rfq);
  return `Ah sorry, i really need a ${want} - that is what i must have. Do you have that one? If not no problem, thank you 🙏`;
}

// ---------------------------------------------------------------------------
// Deterministic safe bargain (the graceful fallback when a draft is unsafe)
// ---------------------------------------------------------------------------

/**
 * A minimal, arithmetically-sane ask used ONLY when an LLM bargain draft failed
 * the numeric check but a valid target still exists. Never invents a rival;
 * names the target (which is already clamped to [floor, quote) by the ladder).
 * Returns null when no honest ask is possible (target missing / not below quote).
 */
export function buildSafeBargainAsk(args: {
  target?: number;
  ceiling?: number;
  floor?: number;
  durationDays?: number;
  currency: string;
  money: (n: number, cur: string) => string;
}): string | null {
  const { target, ceiling, floor, durationDays, currency, money } = args;
  if (!target || target <= 0) return null;
  if (ceiling && target >= ceiling) return null; // not actually a discount
  if (floor && target < floor) return null; // never below the floor
  const days = durationDays && durationDays > 1 ? ` for the ${durationDays} days` : "";
  return `Thank you my friend! For me is a bit too much. Can you do ${money(target, currency)}/day${days}? Then i book with you 🙏`;
}
