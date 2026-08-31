// WHEN THE SHOP STATES THE DATES, NOT THE TRAVELLER.
//
// "27 to 1 the is 1250" is a real reply: available the 27th to the 1st, twelve
// hundred and fifty for the lot. The readers made three different mistakes on
// it and none of them was "read the price":
//
//   "27 to 1 the is 1250"          -> nothing at all; the 1250 was lost
//   "27/12 to 1/1 total 1250"      -> THB 2/day and THB 5/day, from the DATES
//   "from 27 to 1 total 1250 baht" -> THB 5/day, from a date digit
//   "available 27 to 1, 250 per day" -> a THB 27 tier that won BEST PRICE
//
// The last one is fixed by the alternation guard; the rest need this. A stated
// date range is two facts at once: those digits are NOT money, and the total
// beside them is divided by THAT span - the shop's, not the traveller's.
//
// Pure, so the span arithmetic is tested by running it rather than inferred
// from a transcript.

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_WORD = Object.keys(MONTHS).join("|");

/** Days in a month, ignoring leap years - a rental span is not a calendar. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface ShopDateRange {
  /** Day of month the range starts on. */
  startDay: number;
  /** Day of month it ends on. */
  endDay: number;
  /** Nights between them - what a rental is actually priced by. */
  spanDays: number;
  /** Where the range sits in the text, so callers can blank it out. */
  index: number;
  length: number;
  /** The exact text matched, for traces. */
  matched: string;
}

/**
 * The nights from `startDay` to `endDay`.
 *
 * Same month: the plain difference. Crossing into the next month: the days
 * left in the start month plus the end day. `startMonth` is used when the shop
 * named or numbered it, and defaults to a 31-day month - the common case in the
 * high season these shops rent in, and the reading that makes "27 to 1" five
 * nights rather than four.
 */
export function spanBetween(startDay: number, endDay: number, startMonth?: number): number {
  if (endDay > startDay) return endDay - startDay;
  const len =
    startMonth && startMonth >= 1 && startMonth <= 12 ? MONTH_DAYS[startMonth - 1] : 31;
  return len - startDay + endDay;
}

// "27/12 to 1/1", "27.12 - 1.1", "27/12-1/1"
const NUMERIC_DATED = new RegExp(
  `\\b(\\d{1,2})\\s*[/.]\\s*(\\d{1,2})\\s*(?:to|until|till|-|–|~)\\s*(\\d{1,2})\\s*[/.]\\s*(\\d{1,2})\\b`,
  "i"
);
// "Dec 27 to Jan 1", "27 Dec - 1 Jan"
const WORD_DATED = new RegExp(
  `\\b(?:(${MONTH_WORD})\\w*\\s*(\\d{1,2})|(\\d{1,2})\\s*(${MONTH_WORD})\\w*)\\s*(?:to|until|till|-|–|~)\\s*` +
    `(?:(${MONTH_WORD})\\w*\\s*(\\d{1,2})|(\\d{1,2})\\s*(${MONTH_WORD})\\w*)`,
  "i"
);
// The bare shape - "27 to 1", "27-1". Only a range whose ends are both real
// days of the month, and only when the caller has confirmed a total sits
// beside it: two bare small numbers are far more often a price alternation
// ("250 or 300") than a date, and misreading one as a date would DROP a real
// tier. See `readShopDateRange`'s `requireTotalNear`.
const BARE = /\b(\d{1,2})\s*(?:to|until|till|-|–|~)\s*(\d{1,2})\b/i;

/**
 * A range FOLLOWED BY A DURATION UNIT is a price-board tier, not a date.
 *
 * "2-10 days - P 400" and "8 - 14 day 250" are rows on a rate card: the range
 * is how long you rent, and the number after it is the price for that tier.
 * Blanking them as dates deleted a whole tier from the board - the opposite of
 * this module's job, which is to stop digits being lost or invented.
 */
const TIER_UNIT_AFTER =
  /^\s*(?:days?|d\b|nights?|weeks?|wks?|months?|mths?|วัน|ngày|ngay|hari|araw|minggu|bulan|tuần)/i;

/** A day-of-month is 1-31; anything else is not a date, whatever it looks like. */
const isDay = (n: number) => Number.isFinite(n) && n >= 1 && n <= 31;

/**
 * The rental date range the SHOP stated, if it stated one.
 *
 * `requireTotalNear` gates the bare "27 to 1" shape: without a total-scale
 * amount elsewhere in the text, two small numbers joined by "to" are almost
 * always a price alternation, and calling them a date would discard a real
 * cheaper tier. The dated shapes (slashes, month names) need no such guard -
 * nobody quotes a price as "27/12".
 */
export function readShopDateRange(
  text: string,
  opts: { requireTotalNear?: boolean } = {}
): ShopDateRange | null {
  const t = text ?? "";
  if (!t.trim()) return null;

  const numeric = NUMERIC_DATED.exec(t);
  if (numeric) {
    const [whole, d1, m1, d2] = numeric;
    const startDay = parseInt(d1, 10);
    const endDay = parseInt(d2, 10);
    const startMonth = parseInt(m1, 10);
    if (isDay(startDay) && isDay(endDay)) {
      return {
        startDay,
        endDay,
        spanDays: spanBetween(startDay, endDay, startMonth),
        index: numeric.index ?? 0,
        length: whole.length,
        matched: whole,
      };
    }
  }

  const worded = WORD_DATED.exec(t);
  if (worded) {
    const whole = worded[0];
    const startDay = parseInt(worded[2] ?? worded[3] ?? "", 10);
    const endDay = parseInt(worded[6] ?? worded[7] ?? "", 10);
    const startMonthWord = (worded[1] ?? worded[4] ?? "").toLowerCase();
    if (isDay(startDay) && isDay(endDay)) {
      return {
        startDay,
        endDay,
        spanDays: spanBetween(startDay, endDay, MONTHS[startMonthWord]),
        index: worded.index ?? 0,
        length: whole.length,
        matched: whole,
      };
    }
  }

  if (opts.requireTotalNear) {
    const bare = BARE.exec(t);
    if (bare) {
      const startDay = parseInt(bare[1], 10);
      const endDay = parseInt(bare[2], 10);
      const after = t.slice((bare.index ?? 0) + bare[0].length);
      if (TIER_UNIT_AFTER.test(after)) return null;
      if (isDay(startDay) && isDay(endDay)) {
        const span = spanBetween(startDay, endDay);
        // A range longer than two months is not a rental somebody is quoting.
        if (span >= 1 && span <= 60) {
          return {
            startDay,
            endDay,
            spanDays: span,
            index: bare.index ?? 0,
            length: bare[0].length,
            matched: bare[0],
          };
        }
      }
    }
  }
  return null;
}

/**
 * A total-scale amount, for the bare-range gate.
 *
 * "Total scale" means an order of magnitude above a day of the month - which is
 * what distinguishes "27 to 1 ... 1250" (dates and a package) from "250 or 300"
 * (two prices). Deliberately the same 10x reasoning the alternation guard uses.
 */
export function hasTotalScaleAmount(text: string, aboveDay = 31): boolean {
  for (const m of (text ?? "").matchAll(/\b\d{1,3}(?:[.,]\d{3})+\b|\b\d{3,}\b/g)) {
    const n = Number(m[0].replace(/[.,]/g, ""));
    if (Number.isFinite(n) && n > aboveDay * 10) return true;
  }
  return false;
}
