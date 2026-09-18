// WHEN A COMPETITOR'S PRICE MAY BE PLAYED, AND WHEN A NEW LOW IS WORTH
// TELLING THE OTHER SHOPS ABOUT.
//
// The owner's rule, in his words: use a rival's number "only after we have 2
// prices from 2 different rental shops, or more" - then go back to the dearer
// shops and ask them to beat the cheaper one.
//
// Both halves of that were broken, in ways that could only be seen from
// outside:
//
// 1. THE PROACTIVE HALF NEVER FIRED FOR A NEW CHEAPEST SHOP. The swarm that
//    re-opens the dearer threads was gated on `materialDrop`, which compares
//    the arriving quote against `session.lowest` - and `session.lowest`
//    deliberately INCLUDES this shop's own row (it is what the ask is clamped
//    against, so that the agent never argues a shop below the best price the
//    traveller already has). The offers row for the arriving quote is written
//    before the engine runs, so by the time the comparison happened the new
//    price was already inside the number it was being compared to:
//    `new < lowest * 0.95` could not be true. A shop quoting the best price in
//    the hunt therefore told nobody. Only a shop RE-quoting more than 5% below
//    its own earlier price ever triggered the fan-out.
//
// 2. THE SILENT-THREAD NUDGE COULD PLAY A CARD WE DID NOT HOLD. `momentum` is
//    the move for a thread that has gone quiet, and it cited the rival board
//    whenever it held a single priced row. With one price in the whole hunt
//    there are not two shops to compare, and "another shop quoted X" is then a
//    fact about the only quote we have.
//
// Pure, so the rules are reviewable in one screen and testable without a
// database - the same reason planSiblingRebargain is a pure planner.

/**
 * How many DISTINCT shops must hold a live price before a competitor's number
 * may be named to anyone. Two, exactly as the owner specified: one to be
 * cheaper, one to be argued with.
 */
export const MIN_PRICED_SHOPS_FOR_RIVAL = 2;

/**
 * How far below the cheapest other shop a quote must land to be worth
 * re-opening the dearer threads for. A 1% improvement is not news; it spends a
 * message on every dearer shop to move nobody.
 */
export const NEW_LOW_MARGIN = 0.05;

/**
 * Did this quote just become the hunt's cheapest live price?
 *
 * `cheapestOtherPerDay` must be computed over the OTHER shops only - passing a
 * figure that already includes this quote is the defect this module exists to
 * fix, and it cannot be detected from in here.
 *
 * With no other priced shop the answer is true (it is trivially the cheapest),
 * and the fan-out planner then finds no dearer sibling to message, which is the
 * correct outcome without a second rule to keep in step.
 */
export function isNewSessionLow(args: {
  quotePerDay?: number | null;
  cheapestOtherPerDay?: number | null;
}): boolean {
  const q = Number(args.quotePerDay);
  if (!Number.isFinite(q) || q <= 0) return false;
  const other = Number(args.cheapestOtherPerDay);
  if (!Number.isFinite(other) || other <= 0) return true;
  return q < other * (1 - NEW_LOW_MARGIN);
}

/**
 * May a thread that holds NO quote of its own cite a rival?
 *
 * Only once two different shops have priced - which, on a thread with no quote,
 * means two rivals. On a thread that HAS its own quote the pair is this shop
 * plus one cheaper rival, and that path is gated by `cheapestCheaperRival`
 * (negotiation/leverage), which structurally requires both.
 */
export function canCiteRivalOnSilentThread(pricedRivalCount: number): boolean {
  return Number(pricedRivalCount) >= MIN_PRICED_SHOPS_FOR_RIVAL;
}

/**
 * The general form, for any surface that holds the whole board: how many
 * distinct shops carry a live, comparable price (this shop included).
 */
export function pricedShopCount(
  rows: ReadonlyArray<{ vendorId?: string; pricePerDay?: number | null; currency?: string | null }>,
  currency: string
): number {
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.vendorId) continue;
    const p = Number(r.pricePerDay);
    if (!Number.isFinite(p) || p <= 0) continue;
    if (!r.currency || r.currency !== currency) continue;
    seen.add(r.vendorId);
  }
  return seen.size;
}
