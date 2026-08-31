// Pure negotiation math - no IO, no server-only, so tests and the client-side
// Studio preview can import it freely.

/**
 * CREDIBILITY CLAMP (the Bargained-0 kill): a market "floor" at or above the
 * shop's own LIVE quote is not credible - shops quote above their floor, never
 * below it. A wrong-high seed (PH 350 vs live 300 quotes) used to flip
 * priceAtOrBelowFloor true and silently paralyze ALL bargaining. Clamp the
 * effective floor below the quote (10% headroom) so the engine always has room
 * to counter; callers emit a `suspect-floor` event when the clamp fires so bad
 * data gets fixed, not hidden. Lives HERE (pure module) so the engine imports
 * it statically - test mocks of ./market never hide it.
 */
export function credibleFloor(
  floor: number | null | undefined,
  liveQuote: number | null | undefined
): { floor: number | undefined; clamped: boolean } {
  if (typeof floor !== "number" || !(floor > 0)) return { floor: undefined, clamped: false };
  if (typeof liveQuote !== "number" || !(liveQuote > 0)) return { floor, clamped: false };
  // CRITICAL discriminator: quote AT the floor (within 2%) is the SETTLED
  // state - the shop was bargained down to it, and reopening the push forever
  // would be the aggressive-lowball failure mode. Only a floor STRICTLY above
  // the quote beyond that tolerance is impossible-bad-data (a shop never
  // opens below the true market floor).
  if (floor <= liveQuote * 1.02) return { floor, clamped: false };
  return { floor: Math.max(1, Math.round(liveQuote * 0.9)), clamped: true };
}

export function niceRound(x: number): number {
  if (x >= 1000) return Math.round(x / 50) * 50;
  if (x >= 200) return Math.round(x / 10) * 10;
  if (x >= 50) return Math.round(x / 5) * 5;
  return Math.round(x);
}

/**
 * The nicest round number STRICTLY BELOW `ceiling`.
 *
 * `niceRound` rounds to the nearest step, so an ask of 199 against a rival of
 * 200 rounds back up ONTO the rival - turning a beating ask into a match at the
 * last arithmetic step. Where a value must stay under a bound, round down into
 * it instead of nearest-and-hope.
 */
export function niceRoundBelow(x: number, ceiling: number): number {
  const step = ceiling >= 1000 ? 50 : ceiling >= 200 ? 10 : ceiling >= 50 ? 5 : 1;
  const capped = Math.min(x, ceiling - 1);
  const down = Math.floor(capped / step) * step;
  return Math.max(1, down > 0 && down < ceiling ? down : Math.max(1, Math.ceil(ceiling) - 1));
}

/**
 * The target price for the current bargain round - the owner's launch
 * playbook, made GAP-AWARE so the ladder keeps chasing the floor whenever
 * realistic room remains (it used to dead-end when the shop's concession
 * landed just under the fixed round-1 formula):
 *   round 0: ask the REAL market floor itself ("300 is really expensive for
 *            me... can you give me 160 a day my friend?") - the days are the
 *            leverage, the floor is the anchor. No floor known: 60% of quote.
 *   round 1: concede the SMALLER of 15% above the floor or a quarter of the
 *            remaining gap - so a shop already close to the floor gets a
 *            proportionate micro-ask instead of no ask at all.
 *   round 2: push to halfway between the current quote and the floor (never
 *            above a 5% trim), always a clean round number.
 *   round 3+: a tiny final nudge (usually fails the real-saving test -> close)
 * A cheaper REAL rival offer caps the ask (honest leverage, never invented).
 * Returns undefined when no ask below the quote is possible.
 */
import { beatRivalTarget } from "../negotiation/beat-rival";

export function computeRoundTarget(args: {
  quoted: number;
  floorPrice?: number;
  rivalPrice?: number;
  rounds: number;
  lastTarget?: number;
}): number | undefined {
  const { quoted, floorPrice, rivalPrice, rounds, lastTarget } = args;
  const gap = floorPrice ? Math.max(0, quoted - floorPrice) : 0;
  let base: number;
  if (rounds <= 0) {
    base = floorPrice ?? Math.round(quoted * 0.6);
  } else if (rounds === 1) {
    base = floorPrice
      ? Math.round(floorPrice + Math.min(0.15 * floorPrice, 0.25 * gap))
      : lastTarget && lastTarget < quoted
      ? Math.round((quoted + lastTarget) / 2)
      : Math.round(quoted * 0.9);
  } else if (rounds === 2 && floorPrice && gap > 0) {
    base = Math.round(Math.min(quoted * 0.95, floorPrice + 0.5 * gap));
  } else {
    base = Math.round(quoted * 0.95);
  }
  if (floorPrice) base = Math.max(base, floorPrice);
  // Never re-ask BELOW an earlier ask (the ladder concedes upward, it does not
  // zigzag), and a cheaper real rival caps the ask.
  if (lastTarget && rounds > 0 && base < lastTarget) base = lastTarget;
  // BEAT THE RIVAL, NEVER MATCH IT.
  //
  // `Math.max(floorPrice, rivalPrice)` had no strict-below clamp, so with a
  // floor of 250 and a rival at 200 the ladder recorded 250 - an ask ABOVE the
  // price it was simultaneously citing - and with no floor it recorded exactly
  // the rival, a match. The message number was rescued downstream by
  // composeBargain's beatRivalTarget, but this value is what the ladder banks
  // as lastTarget and what the next round builds on, so the ladder drifted
  // upward against its own leverage. beat-rival.ts owns this arithmetic; use
  // it rather than a second, weaker copy.
  let target = base;
  if (rivalPrice && rivalPrice > 0 && rivalPrice < base) {
    const beat = beatRivalTarget({
      rivalPricePerDay: rivalPrice,
      quotePerDay: quoted,
      floorPerDay: floorPrice,
    });
    target = beat > 0 ? Math.min(beat, base) : rivalPrice;
  }
  let nice = niceRound(target);
  if (rivalPrice && rivalPrice > 0 && nice >= rivalPrice) {
    // niceRound rounds to the NEAREST step, so a beating ask of 199 against a
    // rival of 200 rounded straight back onto it. Round down into the bound.
    nice = niceRoundBelow(target, rivalPrice);
  }
  return nice >= quoted ? undefined : nice;
}
