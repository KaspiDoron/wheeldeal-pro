// WHICH NUMERALS IN A DRAFT ARE ACTUALLY PRICES.
//
// Two places ask "does this message name the rival's price": the cite-the-rival
// RAIL (spte/rails.ts), which obliges a bargain to play the strongest card in
// the hand, and the citedRival INSTRUMENT (spte/live.ts), which feeds the
// owner's "do the agents actually use other shops' prices" KPI.
//
// Both used to count ANY numeral in the draft within 1 unit of a real rival.
// That is a coincidence detector, not a citation check:
//
//   rival at 17/day   + "can you do it for the 17 Aug?"     -> "cited"
//   rival at 5/day    + "we need it for 5 days"             -> "cited"
//   rival at 125/day  + "the 125cc one"                     -> "cited"
//   rival at 2/day    + "2 people, 2 helmets"               -> "cited"
//
// So the rail built to GUARANTEE the rival is named could be satisfied by a
// draft that never mentions it, and the KPI built to measure leverage counted
// dates. This module answers the narrower question the two callers actually
// mean: is this numeral being used as MONEY here?
//
// Deliberately a NEGATIVE test, not a positive one. Requiring an adjacent
// currency token would reject "another shop offered 200, can you do 180?" -
// the exact sentence the owner asked for, and the shape the deterministic
// bargain template emits. So a numeral is money unless its immediate context
// marks it as something else: a date, a time, a duration, a count, or a
// measurement.

/** Month names in the languages the composer writes, short and long forms. */
const MONTH =
  "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|" +
  "january|february|march|april|june|july|august|september|october|november|december";

/**
 * Units that make a number NOT a price. Per-unit price suffixes ("/day") are
 * handled separately below, because "200/day" IS money while "for 5 days" is
 * not - the difference is the slash, not the word.
 */
const NON_MONEY_UNIT =
  "days?|nights?|weeks?|months?|years?|yrs?|hours?|hrs?|mins?|minutes?|" +
  "am|pm|o'clock|" +
  "people|persons?|pax|passengers?|seaters?|seats?|doors?|wheels?|helmets?|" +
  "pcs|pieces?|units?|bikes?|scooters?|cars?|" +
  "km|kms|kilometers?|kilometres?|miles?|cc|litres?|liters?|ltr|kg|" +
  "star|stars|%";

const AFTER_UNIT = new RegExp(`^\\s{0,2}(?:${NON_MONEY_UNIT})\\b`, "i");
const AFTER_MONTH = new RegExp(`^\\s{0,2}(?:st|nd|rd|th)?\\s{0,2}(?:${MONTH})\\b`, "i");
const BEFORE_MONTH = new RegExp(`\\b(?:${MONTH})\\.?\\s{0,2}$`, "i");
/** A per-unit price suffix: "200/day", "200 / night", "200 per day". */
const PER_UNIT = new RegExp(`^\\s{0,2}(?:/|per\\b)\\s{0,2}(?:${NON_MONEY_UNIT})`, "i");

/**
 * Is the numeral at [start, end) in `text` being used as money?
 *
 * `text` must already be digit-normalised (integrity/translation `normalizeDigits`)
 * so the offsets line up - that fold is a 1:1 code-point map, so they do.
 */
export function isMoneyContext(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 16), start);
  const after = text.slice(end, end + 16);

  // "200/day" and "200 per day" are prices. Check this BEFORE the unit test,
  // which would otherwise read the "day" and reject the price.
  if (PER_UNIT.test(after)) return true;

  // A digit glued to another digit group by a date/time separator: 17/08,
  // 12:30, 2026-04-20. Not "200-250", which is a price range, so a hyphen only
  // disqualifies when a month-shaped group follows.
  if (/^\s{0,1}[/:.]\s{0,1}\d/.test(after) && !PER_UNIT.test(after)) return false;
  if (/\d\s{0,1}[/:.]\s{0,1}$/.test(before)) return false;

  // "for the 17 Aug", "Aug 17".
  if (AFTER_MONTH.test(after)) return false;
  if (BEFORE_MONTH.test(before)) return false;

  // "5 days", "2 people", "125cc", "150 km".
  if (AFTER_UNIT.test(after)) return false;

  // A bare ordinal is a date, not a price: "the 17th".
  if (/^(?:st|nd|rd|th)\b/i.test(after)) return false;

  return true;
}

/** One numeral found in a draft, with the offsets `isMoneyContext` needs. */
export interface FoundNumeral {
  value: number;
  start: number;
  end: number;
  money: boolean;
}

/**
 * Every numeral in `normalized` (which MUST be digit-normalised), each tagged
 * with whether it reads as money. Thousands separators are folded the same way
 * the rest of the integrity layer folds them, so "1,200" is 1200 and "3.5" is
 * 3.5.
 */
export function findNumerals(normalized: string): FoundNumeral[] {
  const out: FoundNumeral[] = [];
  for (const m of normalized.matchAll(/\d[\d,.]*/g)) {
    const raw = m[0].replace(/[.,]+$/, ""); // a sentence period is not a decimal
    if (!raw) continue;
    const value = Number(raw.replace(/[,.](?=\d{3}\b)/g, "").replace(/,/g, "."));
    if (!Number.isFinite(value)) continue;
    const start = m.index ?? 0;
    out.push({ value, start, end: start + raw.length, money: false });
  }
  for (const n of out) n.money = isMoneyContext(normalized, n.start, n.end);
  return out;
}

/**
 * Does `text` cite any of `prices` as MONEY, within `tolerance` units?
 *
 * The tolerance stays: the composer may round, localize digits, or write
 * "200฿". What changes is that the numeral has to be a price in the sentence
 * it appears in.
 */
export function citesPrice(
  text: string,
  prices: number[],
  tolerance = 1
): boolean {
  const wanted = prices.filter((p) => Number.isFinite(p) && p > 0).map((p) => Math.round(p));
  if (!wanted.length) return false;
  return findNumerals(text).some(
    (n) => n.money && wanted.some((q) => Math.abs(n.value - q) <= tolerance)
  );
}
