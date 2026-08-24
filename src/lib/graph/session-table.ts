import type { SessionShopRow } from "./types";

// THE RIVAL BOARD'S RANKING AND TRUNCATION, AS A PURE FUNCTION.
//
// Extracted from `sessionTable` in engine.ts, where it lived inside a closure
// that needs Supabase to reach. That placement had a specific cost: the test
// which was supposed to prove "the cheapest rival survives truncation"
// RE-IMPLEMENTED this comparator inside the test file and sorted with its own
// copy - so it passed whatever the engine did, including if the engine had
// gone back to slicing an unsorted Map. A test that cannot fail is not
// coverage, and this is the second most valuable line in the leverage path.
//
// Nothing here touches IO, so the real function is now what the test runs.

/**
 * How many session rows the rival board carries into a turn. It bounds the
 * PROMPT - a hunt can hold forty shops and the model does not need forty.
 */
export const SESSION_TABLE_CAP = 10;

/**
 * ...of which this many are reserved for the DEAREST shops.
 * `planSiblingRebargain` fans out to at most `MAX_FANOUT` (4) shops per price
 * drop, dearest first, so reserving exactly that many costs the prompt four
 * rows and is the difference between the swarm having targets and having none.
 */
export const REBARGAIN_TAIL = 4;

/**
 * Cheapest-first, priced ahead of priceless, THIS shop always kept.
 *
 * This shop's own row is never a rival - it is what `quoteOnTable` reads to
 * know what we are arguing against, so dropping it breaks the comparison
 * itself rather than merely weakening it.
 */
export function rankSessionRows(rows: SessionShopRow[]): SessionShopRow[] {
  return rows.slice().sort((a, b) => {
    if (a.isThisShop !== b.isThisShop) return a.isThisShop ? -1 : 1;
    const ap = typeof a.pricePerDay === "number" && a.pricePerDay > 0;
    const bp = typeof b.pricePerDay === "number" && b.pricePerDay > 0;
    if (ap !== bp) return ap ? -1 : 1;
    if (ap && bp) return (a.pricePerDay as number) - (b.pricePerDay as number);
    return 0;
  });
}

/**
 * Rank, then spend the cap FROM BOTH ENDS.
 *
 * Sorting cheapest-first fixed the leverage card and broke the sibling
 * re-bargain in the same stroke: `planSiblingRebargain` reads this same list
 * and immediately re-sorts it DEAREST-first, because the shops with the most
 * room to move are the ones worth re-approaching when a cheaper quote lands.
 * So on any hunt over ten shops the slice was handing the swarm precisely the
 * rows it had just discarded. One truncation cannot serve a "cheapest wins"
 * reader and a "dearest wins" reader, so it serves both: the cheapest fill the
 * cap minus a reserved tail of exactly `REBARGAIN_TAIL`.
 *
 * Order stays cheapest-first, so every existing reader is unchanged.
 */
export function sessionTableRows(rows: SessionShopRow[]): SessionShopRow[] {
  const ranked = rankSessionRows(rows);
  if (ranked.length <= SESSION_TABLE_CAP) return ranked;
  const head = ranked.slice(0, SESSION_TABLE_CAP - REBARGAIN_TAIL);
  const tail = ranked.slice(-REBARGAIN_TAIL);
  const seen = new Set(head.map((r) => r.vendorId));
  return [...head, ...tail.filter((r) => !seen.has(r.vendorId))];
}
