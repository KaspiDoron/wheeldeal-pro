import { normalizeDigits } from "../integrity/translation";
// A RATE HAS A DENOMINATOR.
//
// On 27 Jul a Chiang Mai shop sent a price board captioned:
//
//     Click 125cc 6 days discount 250/1day
//
// and the app put "฿1/day" on the traveller's card. Every price pattern in this
// codebase was shaped `AMOUNT ... UNIT` - money, then the word "day" - with the
// quantity of units always implicitly one. So the scanner walked past "250",
// found "1day", and read the ONE as the money.
//
// That is not a bad regex, it is a missing concept. A rate is
//
//     amount  /  (quantity x days-per-unit)
//
// and until the quantity existed as a thing the reader could see, any shop
// writing the denominator - "250/1day", "3000/7days", "4500 per 30 days" -
// handed us a number from the wrong side of the division. The same gap is why
// separate PRICE_DAY / PRICE_WEEK / PRICE_MONTH patterns were needed at all:
// they are one expression with three values of days-per-unit.
//
// This module is that expression, and only that. Pure, so the arithmetic is
// unit-tested rather than inferred from a transcript.

export type RateUnit = "day" | "week" | "month";

/** How many days one unit buys. A month is the rental-trade 30, not a calendar. */
export const UNIT_DAYS: Record<RateUnit, number> = { day: 1, week: 7, month: 30 };

export interface RateExpr {
  /** The money side, exactly as the shop wrote it. */
  amount: number;
  /** How many units that money buys. 1 unless the shop wrote a denominator. */
  quantity: number;
  unit: RateUnit;
  /** amount / (quantity x UNIT_DAYS[unit]), rounded. The only number callers use. */
  perDay: number;
  /** Index of the AMOUNT within the scanned string - callers read the words around it. */
  index: number;
  /** The whole matched expression, for evidence and for duration-condition checks. */
  matched: string;
  /** True when the shop named a currency inside the expression. */
  hasCurrency: boolean;
  /** True when the shop wrote an explicit denominator ("250/1day", "3000/7days"). */
  hasQuantity: boolean;
}

// ONE source for the currency vocabulary - price-extract.ts imports these
// instead of keeping a drifting copy (the two lists disagreeing is how a
// pattern fix lands in one engine and not the other).
export const CUR_SYM = "[$€฿₱₹₫]";
export const CUR_WORDS =
  "usd|idr|rp|eur|thb|rm|php|inr|vnd|myr|aud|nzd|sgd|mxn|try|ils|zar|brl|mad|egp|lkr|npr|twd|jpy|krw" +
  // The MISSPELLINGS shops actually type. "Special price 900 bath for 4 day"
  // (a real Krabi reply) extracted NOTHING: 'bath' is four letters, so even
  // the structural tail (capped at 3) could not save it, and the price
  // vanished from the card. Spelling is not meaning - the vocabulary's job is
  // to recognize what people write, not what dictionaries prefer.
  "|baht|bath|bht|pesos?|piso|rupiah|rupees?|dong|ringgit|dollars?|euros?|shekels?|dirhams?";
// Letter boundaries are not optional - "rp" in "airport", "mad" in "nomad".
export const CUR_LEAD = `${CUR_SYM}|\\b(?:${CUR_WORDS})(?![a-z])`;
export const CUR_TRAIL = `${CUR_SYM}|(?:${CUR_WORDS})(?![a-z])`;
export const NUM = "\\d{1,3}(?:[.,\\s]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?";

// A GLOBAL platform cannot enumerate every currency shorthand on earth. The
// Thai field test proved it: "1200b./6days" was invisible to every pattern
// because "b." is in no list - and the next market will write "500rs" or
// "700fr". STRUCTURE is the general signal: a short letter tail GLUED to an
// amount, that is not a reserved unit/measure word, is currency-marker
// EVIDENCE whatever the letters are. The reserved list below is closed and
// tiny (units, separators, measures, magnitudes) - everything else is treated
// as a marker, which is exactly how a human reads "1200b.".
const RESERVED_TAIL =
  "days?|d|per|each|a|w|wks?|weeks?|m|mths?|months?|h|hrs?|hours?|am|pm|min|mins?" +
  "|km|kms|kmh|mph|cc|kg|hp|gb|mm|cm|k|x|to|or|and|no|not|ok|for|the|of|is|at|on|in|up|it|by";
export const CUR_TAIL_GENERIC = `(?!(?:${RESERVED_TAIL})(?![a-z]))[a-z]{1,3}\\.?(?![a-z])`;

// What can stand between the money and the unit. Up to three because shops type
// "600.-/DAY" as one token, and dropping any of them loses the whole rate.
const SEP = `(?:[-/.@]|per\\b|each\\b|a\\b)`;

const UNIT = `(days?|d(?![a-z])|24\\s*h(?:rs?|ours?)?|weeks?|wks?(?![a-z])|months?|mths?(?![a-z]))`;

// 1 currency-lead | 2 amount | 3 currency-trail (known word OR structural
// marker tail) | 4 separators | 5 quantity | 6 unit
const RATE = new RegExp(
  `(${CUR_LEAD})?\\s*(${NUM})\\s*(${CUR_TRAIL}|${CUR_TAIL_GENERIC})?\\s*((?:${SEP}\\s*){0,3})(?:(\\d{1,3})\\s*)?${UNIT}`,
  "gi"
);

/**
 * Where an amount actually appears in a message.
 *
 * Callers used to locate a price with `text.indexOf(String(amount))`, and that
 * is how a misread compounds: with the price wrongly read as 1, `indexOf("1")`
 * landed inside "Click 125cc", so the vehicle resolver then judged the price
 * against whatever vehicle happened to sit there. A number is only itself when
 * it is not part of a bigger number - that is the entire rule, and it belongs
 * in one place rather than at every call site.
 *
 * Written without a lookbehind: this runs in bundles that still reach older
 * Safari, which is why the leading guard is captured rather than asserted.
 */
export function amountIndexIn(text: string, amount: number): number {
  if (!text) return -1;
  const s = String(Math.round(amount));
  const m = new RegExp(`(^|[^\\d.,])(${s})(?![\\d])`).exec(text);
  if (m) return (m.index ?? 0) + m[1].length;
  return text.indexOf(s);
}

function unitOf(token: string): RateUnit {
  const t = token.toLowerCase();
  if (t.startsWith("w")) return "week";
  if (t.startsWith("m")) return "month";
  return "day";
}

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/[,\s]/g, "").replace(/\.(?=\d{3}\b)/g, ""));
}

/**
 * Every rate expression in `text`, left to right.
 *
 * A number that is merely FOLLOWED by a time word is not a rate - "6 days",
 * "minimum 3 days", "open 7 days" are durations, and reading them as money is
 * the other half of the same bug. A genuine rate always carries at least one
 * of: a currency, a separator, or an explicit quantity. That single condition
 * replaces a pile of "is this really a price?" special cases.
 */
export function scanRates(text: string): RateExpr[] {
  const out: RateExpr[] = [];
  if (!text) return out;
  // The RATE pattern is \d-based, so fold local numerals before matching -
  // otherwise a Thai, Lao, Khmer or Myanmar price is simply not a rate. Done in
  // the PRIMITIVE rather than in its callers: this has three of them, and a
  // guard that each caller has to remember is the shape that let the outbound
  // rails ship blind (owner report 11 B1).
  text = normalizeDigits(text);
  for (const m of text.matchAll(RATE)) {
    const [whole, curLead, rawAmount, curTrail, seps, rawQty, rawUnit] = m;
    const amount = parseAmount(rawAmount);
    if (!(amount > 0)) continue;

    const hasCurrency = Boolean(curLead || curTrail);
    const hasSeparator = Boolean(seps && seps.trim());
    const hasQuantity = Boolean(rawQty);
    if (!hasCurrency && !hasSeparator && !hasQuantity) continue; // a duration, not a rate

    const quantity = hasQuantity ? parseInt(rawQty, 10) : 1;
    if (!(quantity > 0)) continue;
    const unit = unitOf(rawUnit);
    const perDay = amount / (quantity * UNIT_DAYS[unit]);
    if (!(perDay > 0)) continue;

    const at = (m.index ?? 0) + whole.indexOf(rawAmount);
    out.push({
      amount,
      quantity,
      unit,
      perDay: Math.round(perDay),
      index: at,
      matched: whole,
      hasCurrency,
      hasQuantity,
    });
  }
  return out;
}
