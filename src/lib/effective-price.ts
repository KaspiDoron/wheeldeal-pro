// THE EFFECTIVE PRICE, IN ONE PLACE (owner report 6, D2).
//
// "No price yet" used to be a report on ONE boolean (vendor_replies.found),
// not on the shop: the thread's standing price, the photographed board and
// the derived option menu were all invisible to whichever surface happened
// not to re-implement the lookup. /api/replies had the resolver inline;
// /api/deals (Trips) rebuilt its rows from offers alone and knew none of it.
// One resolver, imported by both, so every surface answers "what price do we
// know for this shop" the same way - each source tagged so the UI can say
// WHERE the number came from and keep it honestly unverified until the agent
// confirms it.
//
// Trust order (a confirmed row always wins - callers pass found/rowPrice):
//   1. thread      - the engine's durable per-thread price field
//   2. menu-photo  - the photographed board (cc + duration-tier aware, and
//                    never a crossed-out row: pickBoardPrice owns those rules)
//   3. menu        - the option menu derived from the shop's own text

import { pickBoardPrice } from "./media/reading";

export interface EffectivePrice {
  pricePerDay: number;
  currency: string | null;
  source: "thread" | "menu-photo" | "menu";
  vehicle: string | null;
}

export interface BoardPriceRow {
  pricePerDay?: number | null;
  available?: boolean | null;
  vehicle?: string | null;
  line?: string | null;
  tierLabel?: string | null;
  currency?: string | null;
}

export interface MenuOptionRow {
  pricePerDay: number;
  currency?: string | null;
  label?: string | null;
}

export function effectivePriceFor(args: {
  /** The row's own confirmed read - when true+price, no effective price is needed. */
  found: boolean;
  rowPrice: number | null;
  /** Currency context for the thread tier (the row's, or the search's). */
  rowCurrency?: string | null;
  /** negotiation_threads.fields.pricePerDay - the durable standing price. */
  threadPrice?: number | null;
  /** raw.reading.prices rows from the shop's photographed board(s). */
  boardPrices?: readonly BoardPriceRow[] | null;
  /** optionsFromThread output - the menu derived from the shop's text. */
  options?: readonly MenuOptionRow[] | null;
  engineSizeCc?: number;
  durationDays?: number;
}): EffectivePrice | null {
  if (args.found && args.rowPrice) return null; // the row has the real thing

  // 1. The thread's own standing price (the engine's durable field).
  if (typeof args.threadPrice === "number" && args.threadPrice > 0) {
    return {
      pricePerDay: args.threadPrice,
      currency: args.rowCurrency ?? null,
      source: "thread",
      vehicle: null,
    };
  }

  // 2. The photographed board, preferring a row naming the declared cc.
  // Crossed-out rows and non-covering duration tiers never become the number
  // (pickBoardPrice owns those rules - they stay visible in the proof panel).
  const board = pickBoardPrice(
    args.boardPrices ?? undefined,
    args.engineSizeCc ?? 0,
    args.durationDays ?? 0
  );
  if (board && Number(board.pricePerDay) > 0) {
    return {
      pricePerDay: Number(board.pricePerDay),
      // A board row with no currency of its own borrows the ROW's (F097): the
      // reading is stamped from the same reconciliation the offer used, and a
      // null here is what the card turns into "$" through its own last-resort
      // default - a baht board rendered as dollars.
      currency: board.currency ?? args.rowCurrency ?? null,
      source: "menu-photo",
      vehicle: board.vehicle ?? null,
    };
  }

  // 3. The option menu derived from the shop's own text. A SINGLE option is
  // still a price - the old `length >= 2` gate meant a shop that named
  // exactly one model with one price stayed "No price yet" forever.
  const opts = args.options;
  if (opts?.length) {
    const pick = opts.reduce((a, b) => (a.pricePerDay <= b.pricePerDay ? a : b));
    return {
      pricePerDay: pick.pricePerDay,
      currency: pick.currency ?? args.rowCurrency ?? null,
      source: "menu",
      vehicle: pick.label ?? null,
    };
  }
  return null;
}
