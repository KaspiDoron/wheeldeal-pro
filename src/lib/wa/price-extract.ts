// Human-grade deterministic rental-price extraction.
//
// Shops rarely reply with a clean "350/day". They send a whole business
// template mixing services - airport/port transfers ("250 PHP/trip"), island
// tours, shuttle - with the actual vehicle rental line buried inside:
//
//   Welcome to Sun House Rental! ...
//   Airport <-> Sun House Rental: 250 PHP/trip
//   Balbagon Port <-> Sun House Rental: 350 PHP/trip
//   Benoni Port <-> Sun House Rental: 600 PHP/trip
//   Scooter: 350 PHP/day
//   Island tour available
//
// The rigid old regex missed this on two counts: it assumed the currency comes
// BEFORE the number ("PHP 350") so "350 PHP/day" never matched, and it had no
// notion of ignoring transfer/tour noise (so a "/trip" price could be grabbed).
//
// This reads the message LINE BY LINE like a person would: drop the transfer /
// tour / service lines, keep only genuine per-day rental lines, prefer the line
// that names the requested vehicle class, and return the cheapest matching
// daily rate. Pure + fully unit-tested; used as the deterministic fallback AND
// as a backstop that rescues a price the LLM missed.

import { parseRateLadder, tierForDays } from "./rate-ladder";
import {
  scanRates,
  CUR_SYM as RATE_CUR_SYM,
  CUR_WORDS as RATE_CUR_WORDS,
  CUR_TAIL_GENERIC,
  DAY_WORDS_NATIVE,
  MAGNITUDE_TAIL,
  applyMagnitude,
} from "./rate-expr";
import { normalizeDigits } from "../integrity/translation";
import { readShopDateRange, hasTotalScaleAmount } from "./shop-date-range";
import { CURRENCIES } from "../currency";

// The set of ISO codes the app can actually display and convert. A currency
// token that does not resolve to one of these must never become the currency
// of record - the traveller would see a bare code the converter cannot price.
const CUR_CODES = new Set(CURRENCIES.map((c) => c.code));

export type VehicleClassHint = "car" | "motorbike" | "scooter" | undefined;

export interface RentalPriceHit {
  pricePerDay: number;
  currency?: string;
  line: string;
  // true  = the line names the SAME class the traveller asked for
  // false = the line names a DIFFERENT class (car vs scooter)
  // undefined = the line names no class (a bare "350/day")
  classMatch?: boolean;
  // true when the number is a RESTATED list/regular price ("normally it's
  // 300/day"), not what the shop is offering right now. Never an offer.
  listPrice?: boolean;
  /** Where the amount sits in `line` - lets callers read the words around it. */
  index?: number;
  /**
   * When this price came off a DURATION LADDER ("3-7 days - 600"), the stretch
   * of days it applies to. Absent for an ordinary quote. Carrying it is what
   * lets a card say "600/day for 3-7 days" instead of pretending the board's
   * cheapest row is available to a 5-day traveller.
   */
  minDays?: number;
  maxDays?: number;
  /** The shop's own words for the range ("3-7 days", "Monthly"). */
  tierLabel?: string;
  /**
   * PROVENANCE: THIS NUMBER WAS DERIVED, NOT QUOTED (owner report 5 #2).
   *
   * A shop that types "500 for 3 days" has stated a TOTAL. Dividing it gives
   * 167/day - arithmetic on a real number, and useful - but no shop ever said
   * "167 a day", and nothing downstream could tell the difference. The field
   * failure is exactly that: a Thai draft citing "167 บาท/วัน สำหรับ 1 วัน"
   * (167/day for 1 day) against a shop that had quoted a 3-day package, with
   * the CURRENT rental's 1 day welded on by the composer.
   *
   * `derivedFromDays` is the span the original amount covered (3 here, 7 for a
   * weekly, 30 for a monthly). Absent = the shop stated a per-day rate. Every
   * surface that repeats a derived figure has to phrase it as arithmetic
   * ("their 3-day price works out to about 167/day"), and a rival whose span
   * exceeds the traveller's rental is not like-for-like at all.
   */
  derivedFromDays?: number;
}

// Currency CODES/symbols AND the spoken WORDS shops actually type ("400 baht
// per day", "4000 baht per month") - the word forms were missing, which made
// every "<n> baht ..." quote invisible to the day/month/week patterns (a live
// dropped-offer class).
// ONE vocabulary, owned by wa/rate-expr - a currency added there is instantly
// known to both engines (the two lists drifting apart is how a pattern fix
// landed in one reader and not the other).
const CUR_SYM = RATE_CUR_SYM;
const CUR_WORDS = RATE_CUR_WORDS;

// LETTER BOUNDARIES ARE NOT OPTIONAL. Without them "no-RM-ally" made every Thai
// shop that typed "normally it's 300/day" read as Malaysian Ringgit, and the app
// showed a traveller in Krabi "RM 300/day". Same class of bug: "rp" in "airport",
// "mad" in "nomad". A code may sit against a DIGIT ("350THB") but never against
// a LETTER, so the guard is letter-only, not \w-based.
//   CUR_LEAD  - currency BEFORE the number ("PHP 350"): needs a real word start.
//   CUR_TRAIL - currency AFTER the number ("350 PHP"): what precedes is already
//               a digit or space, so only the trailing guard is needed.
const CUR_LEAD = `${CUR_SYM}|\\b(?:${CUR_WORDS})(?![a-z])`;
// The STRUCTURAL tail joins the trail position: "1200b. for 6 days" was the
// documented field lesson in rate-expr, yet only scanRates ever learned it -
// the six patterns here kept the closed word list, so the exact same shorthand
// killed PRICE_TOTAL. The reserved-word guard inside CUR_TAIL_GENERIC keeps
// "for"/"in"/"or" and friends from being eaten as currency.
const CUR_TRAIL = `${CUR_SYM}|(?:${CUR_WORDS})(?![a-z])|${CUR_TAIL_GENERIC}`;

// Codes that are also ordinary English words. They may still let a price PATTERN
// match, but they must never NAME the currency - "I will try 300/day" is not a
// quote in Turkish lira.
const AMBIGUOUS_CUR = new Set(["try", "mad", "a"]);

/**
 * Currency WORDS that name a unit shared by many countries.
 *
 * "peso" is Philippine, Mexican, Colombian, Chilean and Argentine; "dollar" is
 * American, Australian, New Zealand, Singaporean and Canadian; "rupee" is
 * Indian, Sri Lankan, Nepali and Pakistani. codeForToken mapped each to ONE
 * code - PHP, USD, INR - and because the word was genuinely "mentioned",
 * reconcileCurrency then DEFENDED that answer and discarded the shop's actual
 * region. Executed across ten markets, eight rendered the wrong currency: "250
 * pesos per day" in Mexico came out as PHP 250 with a ₱ sign, and "45 dollars"
 * in Australia as USD.
 *
 * This is the same class as the owner's "bath became USD" - the earlier wave
 * fixed the MISSPELLING half and left the ambiguity half.
 *
 * The word still names the currency when the region agrees with it, and when
 * there is no region to consult. It just may not OVERRULE a known region.
 */
const MULTI_COUNTRY_WORD: Record<string, readonly string[]> = {
  peso: ["PHP", "MXN", "COP", "CLP", "ARS", "UYU", "DOP", "CUP"],
  pesos: ["PHP", "MXN", "COP", "CLP", "ARS", "UYU", "DOP", "CUP"],
  piso: ["PHP"],
  dollar: ["USD", "AUD", "NZD", "SGD", "CAD", "HKD", "TWD", "BND", "FJD"],
  dollars: ["USD", "AUD", "NZD", "SGD", "CAD", "HKD", "TWD", "BND", "FJD"],
  rupee: ["INR", "LKR", "NPR", "PKR", "MUR", "SCR"],
  rupees: ["INR", "LKR", "NPR", "PKR", "MUR", "SCR"],
  real: ["BRL"],
  kr: ["SEK", "NOK", "DKK", "ISK"],
  dinar: ["JOD", "TND", "DZD", "KWD", "BHD", "IQD", "RSD", "LYD"],
  riyal: ["SAR", "QAR", "OMR", "YER"],
  rial: ["IRR", "OMR", "YER"],
  franc: ["CHF", "XOF", "XAF", "XPF"],
  pound: ["GBP", "EGP", "LBP", "SDG", "SYP"],
  pounds: ["GBP", "EGP", "LBP", "SDG", "SYP"],
  krone: ["NOK", "DKK"],
  kroner: ["NOK", "DKK"],
  krona: ["SEK", "ISK"],
  shilling: ["KES", "TZS", "UGX", "SOS"],
};

/** Is this token a currency word several countries share? */
export function isMultiCountryCurrencyWord(token: string): boolean {
  return token.toLowerCase() in MULTI_COUNTRY_WORD;
}

/**
 * Could this multi-country word plausibly mean `code`? Used to keep a shop's
 * own word when it AGREES with the region ("pesos" in the Philippines is PHP)
 * while refusing to let it override one it disagrees with.
 */
export function multiCountryWordAllows(token: string, code: string): boolean {
  const list = MULTI_COUNTRY_WORD[token.toLowerCase()];
  return !list || list.includes(code);
}

// A money amount: either grouped thousands ("1,750" / "1.750" / "1 750") OR a
// plain run of digits ("1750", "350"), optional decimals. The old pattern only
// matched the grouped form, so a bare "1750" was truncated to "175".
const NUM = "(\\d{1,3}(?:[.,\\s]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";

// PER-DAY rates are read by `scanRates` (wa/rate-expr), which models the whole
// expression - amount, separator, QUANTITY, unit - instead of "a number, then
// the word day". The flat pattern that used to live here could not see a
// denominator, so "250/1day" handed it the 1.
// A total for the whole rental ("1750 in 5 days", "900 for 3 days") - divided.
const PRICE_TOTAL = new RegExp(
  `(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:for|in|=|:)?\\s*(\\d{1,2})\\s*(?:days?\\b|${DAY_WORDS_NATIVE})`,
  "i"
);
// The day count BEFORE the total ("3 days 900", "5 days is 1750") - also divided.
//
// The glue between the day token and the amount is CONNECTIVE ONLY (whitespace,
// a copula/colon, a currency lead). The old `[^\d]{0,10}` wildcard bridged a day
// token to an unrelated number across a noun - "minimum 3 days rental 500
// deposit" read 500/3 = 167/day off a DEPOSIT, and "open 7 days a week 8am" read
// 8/7 = 1/day - phantom offers that could beat the shop's real quote. A word
// like "rental"/"deposit"/"a week" between the two now breaks the match, which
// is exactly the human reading: those numbers are not a rental total.
const PRICE_TOTAL_REV = new RegExp(
  // The native day words too - "เช่า 3 วัน 900 บาท" and "sewa 3 hari 200rb" are
  // the SAME sentence as "3 days 900 baht", and were read as nothing.
  `(\\d{1,2})\\s*(?:days?\\b|${DAY_WORDS_NATIVE})\\s*(?:is|are|=|:|-|~|for|at|cost|costs|price)?\\s*(?:${CUR_LEAD})?\\s*${NUM}`,
  "i"
);
// A whole-rental total stated WITHOUT the day count ("1000 or 1250 total",
// "2500 altogether") - the shop already knows how many days we asked for, so it
// quotes the trip. Divided by the RFQ duration. Requires the explicit total word
// so a bare number is never mistaken for a trip price.
// Amount-then-word ("1250 total") OR word-then-amount ("total 1250"). Only the
// first spelling was matched, so a shop that leads with the word - which is how
// it reads in most of the languages this app meets in translation - had its
// stated total dropped entirely.
const PRICE_TOTAL_WORD = new RegExp(
  `(?:(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:in\\s+)?(?:total|altogether|all together|all in|in all|for everything|for the whole|for all)\\b` +
    `|(?:total|altogether|all in|in all|in total)\\s*(?:is|:|=)?\\s*(?:${CUR_LEAD})?\\s*${NUM}(?:\\s*(?:${CUR_TRAIL}))?)`,
  "i"
);
// A MONTHLY quote ("4000 per month", "4000/month", "monthly 4000") - the format
// long-rental shops actually use, which the day-only patterns silently dropped
// (the live "3 of 4 offers vanished" failure on a 30-day search).
const PRICE_MONTH = new RegExp(
  `(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:[-/]|per\\s*|a\\s+)\\s*month|month(?:ly)?\\s*(?:rate|price|rental)?\\s*(?:is|:|=)?\\s*(?:${CUR_LEAD})?\\s*${NUM}`,
  "i"
);
// A WEEKLY quote ("1500 a week", "weekly 1500").
const PRICE_WEEK = new RegExp(
  `(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:[-/]|per\\s*|a\\s+)\\s*week|week(?:ly)?\\s*(?:rate|price)?\\s*(?:is|:|=)?\\s*(?:${CUR_LEAD})?\\s*${NUM}`,
  "i"
);
// A BARE price answer: the whole (short) message is just an amount + optional
// currency ("400", "400 baht", "PHP 350 only") - the natural reply to "what's
// your best price per day?". Strict shape so times/phone numbers never match.
const BARE_PRICE = new RegExp(
  `^\\s*(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:only|net|\\.|!)?\\s*$`,
  "i"
);

/** Normalize k-notation ("150k", "1.5k") into full numbers before matching. */
function expandK(line: string): string {
  return line.replace(/(\d+(?:\.\d+)?)\s*k\b/gi, (_, n) => String(Math.round(parseFloat(n) * 1000)));
}

// A URL NEVER contains a rate. Shops paste Maps/Waze links constantly, and the
// per-day pattern happily matched inside one: "maps.app.goo.gl/FRqAc4day2rY4mF49"
// read as "4/day" and put a 4-peso scooter on the traveller's card. Stripped
// before any scanning, so neither the price nor the label can come from a link.
const URL_RX = /\b(?:https?:\/\/|www\.)\S+/gi;

// A QUALIFYING DURATION is not a rate. "Discounted Rates for Rentals of 8 Days
// or More" is a condition on the prices that follow, and it was being read as an
// 8-per-day offer. The tell is the words around the day token, never the amount.
// WORD ORDER DEFEATED THIS. The cue had to sit IMMEDIATELY before the day
// token (`\s*$`), so "minimum 3 days rental 500 deposit" was caught and
// "Minimum RENTAL 3 days 500 deposit" - the same sentence, one word moved -
// divided to 167/day. The cue anywhere in the 24-char window is the same
// claim; only the intervening words changed. `\s*$` becomes a short tolerance
// for those words, still tight enough that a cue from a previous clause cannot
// reach across.
const DURATION_BEFORE =
  /\b(?:rentals?\s+of|minimum|min\.?|at\s+least|more\s+than|over|from)\b(?:\s+\w+){0,3}\s*$/i;
const DURATION_AFTER = /^\s*(?:or\s+(?:more|longer|above|up)|\+|and\s+(?:up|above|over)|plus)\b/i;

// A LEADING "N/Days" (or "N Days:") is a HEADER naming which duration the row
// prices - "4/Days 110cc 220฿ 125cc 270฿" - never a 4-currency rate. The RATE
// scanner happens to match it (amount 4, separator '/', unit Days); until this
// guard the phantom stayed latent only because the traveller's own duration
// equalled the header's. On any mismatch it became a 4-baht/day "offer" AND
// poisoned the explicit-daily contradiction check.
const DURATION_HEADER = /^\s*\d{1,2}\s*(?:\/\s*)?days?\b/i;

/** How many price-scale amounts appear after `from` - one quote, or a table. */
function amountsAfter(line: string, from: number): number {
  const tail = line.slice(from);
  return (tail.match(/\d[\d.,]*/g) ?? []).filter((n) => parseAmount(n) > 0).length;
}

/**
 * Is the amount at `index` part of a duration CONDITION rather than a price?
 * Pure so the judgement is unit-tested instead of inferred from a transcript.
 */
export function isDurationConditionAt(line: string, index: number, matched: string): boolean {
  const header = line.match(DURATION_HEADER);
  // A HEADER PRICES A ROW; A TOTAL PRICES ONE THING. "4/Days 110cc 220 125cc
  // 270" is a menu header naming the duration its several prices are for. "3
  // days 900" is a shop quoting one package - and this guard swallowed it,
  // dropping the shop's real total on the floor. The tell is how many amounts
  // follow: one is a quote, several is a table.
  if (header && index < header[0].length && amountsAfter(line, header[0].length) !== 1) {
    return true;
  }
  const before = line.slice(Math.max(0, index - 24), index);
  if (DURATION_BEFORE.test(before)) return true;
  const after = line.slice(index + matched.length, index + matched.length + 24);
  return DURATION_AFTER.test(after);
}

// A line that is a transfer / tour / other service, NOT a vehicle rental.
const SERVICE_LINE =
  /\b(trip|transfer|shuttle|airport|port|pier|ferry|terminal|tour|drop\s?off service|pick\s?up service|boat|van service|habal)\b|↔|⇄|<->|<=>|<\s*-\s*>/i;

const SCOOTER_WORDS = /\b(scooter|scoopy|click|fino|filano|nmax|pcx|vespa|beat|mio|aerox|vario|moped|automatic)\b/i;
const MOTORBIKE_WORDS =
  /\b(motor\s?bike|motorcycle|manual|semi\s?auto|sportbike|dirt\s?bike|scrambler|cafe\s?racer|enduro|trail|xr|klx|crf|ttr|wr|raider|sniper)\b/i;
const CAR_WORDS = /\b(car|sedan|suv|hatchback|van|mpv|pickup|4x4|jeep|multicab)\b/i;

// ---------------------------------------------------------------------------
// LIST PRICE vs LIVE OFFER
//
// The live failure: a shop had already agreed 250/day, then wrote "That is a
// discount already, normally it's 300/day". The extractor read 300 as a fresh
// quote, so the app replaced a real ฿250 offer with a worse 300 - while the
// agent, reading the sentence properly, kept negotiating from 250. A restated
// regular / normal / usual / original price is an ANCHOR, never an offer.
//
// The cue must sit just before the number, and any "but / for you / now" style
// pivot BETWEEN the cue and the number cancels it - that is exactly the shape of
// "Normally 300 but for you 250", where 300 is the list and 250 is the offer.
// The cue must genuinely be about a PRICE. An adverb ("normally it's 300")
// always is; a bare adjective only counts when it modifies price/rate/cost -
// otherwise "Hi! Normal scooters? Some models 200 and some new 250/day" reads
// its own vehicle question as a list price and the whole menu disappears.
const LIST_CUE = new RegExp(
  "\\b(?:" +
    "normally|regularly|usually|originally|" +
    "(?:normal|regular|usual|standard|original|full|list|rack|sticker)\\s+(?:price|rate|cost|charge)s?|" +
    "list\\s+price|rack\\s+rate|before\\s+discount|without\\s+discount|was" +
    ")\\b",
  "i"
);
const OFFER_PIVOT =
  /\b(?:but|however|for\s+you|special|instead|now|today|i\s+can\s+(?:do|give|offer)|drop(?:ped)?\s+(?:it\s+)?to|discounted\s+to|final|make\s+it)\b/i;
/** How far back from the number the cue may sit and still govern it. */
const CUE_WINDOW = 60;

/**
 * Is the amount at `index` in `line` a restated LIST price rather than what the
 * shop is offering now? Pure, so the judgement is unit-tested rather than
 * inferred from a transcript.
 */
export function isListPriceAt(line: string, index: number): boolean {
  const before = line.slice(Math.max(0, index - CUE_WINDOW), index);
  const cue = [...before.matchAll(new RegExp(LIST_CUE.source, "gi"))].pop();
  if (!cue) return false;
  const between = before.slice((cue.index ?? 0) + cue[0].length);
  return !OFFER_PIVOT.test(between);
}

function lineClass(line: string): VehicleClassHint {
  // Car words win only when no 2-wheel word is present (a "car rental" shop line
  // that also lists a scooter must still classify the scooter line correctly).
  if (SCOOTER_WORDS.test(line)) return "scooter";
  if (MOTORBIKE_WORDS.test(line)) return "motorbike";
  if (CAR_WORDS.test(line)) return "car";
  return undefined;
}

function parseAmount(raw: string): number {
  // Strip thousands separators (",", ".", spaces) leaving one number.
  const cleaned = raw.replace(/[,\s]/g, "").replace(/\.(?=\d{3}\b)/g, "");
  return parseFloat(cleaned);
}

// A currency token anywhere in the line, letter-guarded on BOTH sides so a code
// buried inside an ordinary word can never name the money. `(?:^|[^a-z])` is a
// consuming stand-in for a lookbehind (kept out of the bundle for older Safari),
// which is why the token is captured in group 1. Ambiguous English words are
// skipped and the scan continues to the next candidate.
const CUR_ANYWHERE = new RegExp(`(${CUR_SYM})|(?:^|[^a-z])((?:${CUR_WORDS}))(?![a-z])`, "gi");

function codeForToken(t: string): string | undefined {
  // `baht` is canonical, but shops routinely type `bath`/`bht` (the Krabi
  // "Special price 900 bath for 4 day" is a real reply). Without these, the
  // fallthrough below produced the INVALID ISO codes "BATH"/"BHT", which
  // reconcileCurrency then defended (they were genuinely "mentioned"),
  // nulling floorSameCur downstream and silently disabling the whole
  // price-sanity net for that reply.
  if (/\$|usd|dollar/.test(t)) return "USD";
  if (/€|eur/.test(t)) return "EUR";
  if (/฿|thb|baht|bath|bht/.test(t)) return "THB";
  if (/₱|php|peso|piso/.test(t)) return "PHP";
  if (/₹|inr|rupee/.test(t)) return "INR";
  if (/₫|vnd|dong/.test(t)) return "VND";
  if (/\brp\b|idr|rupiah/.test(t)) return "IDR";
  if (/\brm\b|myr|ringgit/.test(t)) return "MYR";
  if (/ils|shekel/.test(t)) return "ILS";
  if (/dirham/.test(t)) return "AED";
  // An unrecognised token is NOT a currency. Inventing an ISO code from it
  // (the old `t.toUpperCase()`) is how "bath" became "BATH": a code no
  // converter knows, kept by reconcileCurrency because it was "mentioned".
  // Return undefined so the region's currency wins instead.
  return CUR_CODES.has(t.toUpperCase()) ? t.toUpperCase() : undefined;
}

/**
 * Every currency the text EXPLICITLY names, letter-guarded. Order preserved.
 *
 * `regionCurrency`, when known, disambiguates a shared word: "pesos" in a PHP
 * region is PHP, in an MXN region is MXN, and with no region at all falls back
 * to codeForToken's single guess. Without it this function confidently reported
 * PHP for a Mexican shop, and reconcileCurrency honoured the report.
 */
export function mentionedCurrencies(text: string, regionCurrency?: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  for (const m of text.matchAll(CUR_ANYWHERE)) {
    const tok = (m[1] ?? m[2] ?? "").toLowerCase();
    if (!tok || AMBIGUOUS_CUR.has(tok)) continue;
    if (regionCurrency && isMultiCountryCurrencyWord(tok)) {
      // The shop's word and the shop's country agree - that IS the currency.
      // They disagree - the word is not specific enough to overrule the
      // country, so it names nothing and the region wins downstream.
      if (multiCountryWordAllows(tok, regionCurrency)) {
        if (!out.includes(regionCurrency)) out.push(regionCurrency);
      }
      continue;
    }
    const code = codeForToken(tok);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

function currencyIn(line: string): string | undefined {
  return mentionedCurrencies(line)[0];
}

/**
 * The currency to actually STORE for a reply. A foreign currency is honoured
 * only when the shop truly typed it: otherwise the shop's own region wins. This
 * is the backstop that keeps a Krabi quote in baht even if some upstream reader
 * hallucinates ringgit - a traveller must never see the wrong money.
 */
export function reconcileCurrency(
  extracted: string | undefined,
  regionCurrency: string | undefined,
  text: string
): string | undefined {
  if (!extracted) return regionCurrency;
  // An `extracted` code that is not a real, displayable ISO currency (a stray
  // "BATH"/"BHT" from an upstream reader) can never be the currency of record -
  // fall back to the shop's region rather than store a code nothing can price.
  if (!CUR_CODES.has(extracted)) return regionCurrency;
  if (!regionCurrency || extracted === regionCurrency) return extracted;
  // The region is passed IN now, so a word several countries share is read
  // against the country the shop is actually in rather than against one
  // hard-coded guess.
  return mentionedCurrencies(text, regionCurrency).includes(extracted)
    ? extracted
    : regionCurrency;
}

// SHARED-UNIT ALTERNATIVES.
//
// "Some models 200 and some new 250/day" carries ONE "/day" that governs BOTH
// numbers. Reading only the marked amount is how the live app lost the 200 tier
// entirely and showed the traveller a bare "250/day" for a shop that had two
// bikes. The unit is shared across an explicit alternation, so we walk left from
// a priced amount and adopt any number joined to it by "and / or / , / - / to",
// optionally through the words a shop puts between them.
//
// Deliberately tight: only an ALTERNATION token qualifies. "Click 125 at
// 250/day" has no such token before 250, so the 125 stays a model number and
// never becomes a price.
const ALT_TAIL = new RegExp(
  `${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:,|-|~|\\/|\\bor\\b|\\band\\b|\\bto\\b)\\s*` +
    `(?:(?:some|a|an|the|for|new|newer|old|older|used|second|hand|basic|normal|standard|models?|ones?|bikes?|scooters?|cars?|motorbikes?)\\s+){0,4}$`,
  "i"
);
const ALT_WINDOW = 70;
const MAX_ALTERNATES = 3;
// A number sitting right after a model or brand word is a MODEL, not a price -
// "a Click 125, 250/day" must not turn 125 into a second tier. Same for an
// explicit cc figure.
const MODEL_TAIL =
  /\b(?:click|scoopy|fino|filano|nmax|pcx|aerox|vario|beat|mio|vespa|forza|adv|xmax|wave|dream|raider|sniper|crf|klx|xr|honda|yamaha|suzuki|kawasaki|model|no\.?)\s*-?\s*$/i;
const CC_HEAD = /^\s*(?:cc\b|ccs\b)/i;

/**
 * The rental span the SHOP named on this line, if any ("5 days 1250 total").
 *
 * Only a plain day count counts - a month or a week is a different unit with
 * its own reader, and a bare number is not a span.
 */
function spanNamedIn(line: string): number | undefined {
  const m = line.match(/\b(\d{1,3})\s*(?:-|to)?\s*days?\b/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 1 && n <= 365 ? n : undefined;
}

/**
 * Amounts to the LEFT of `idx` that share its unit through an alternation.
 * Returns them with their own index in `line` so callers keep locality.
 */
/**
 * Is this "alternate" really a day-of-month from a date range?
 *
 * 1-31 AND at least an order of magnitude below the priced amount. Both halves
 * matter: 1-31 alone would reject a genuine "20 or 25 dollars" pair, and the
 * ratio alone would reject nothing in a currency where 27 is a real price.
 */
function isDayOfMonthAlternate(amount: number, priced: number): boolean {
  return amount >= 1 && amount <= 31 && priced >= amount * 10;
}

function alternatesBefore(
  line: string,
  idx: number,
  base = 0
): Array<{ amount: number; index: number }> {
  const out: Array<{ amount: number; index: number }> = [];
  let cursor = idx;
  for (let i = 0; i < MAX_ALTERNATES; i++) {
    const from = Math.max(0, cursor - ALT_WINDOW);
    const before = line.slice(from, cursor);
    const m = before.match(ALT_TAIL);
    if (!m || m.index === undefined) break;
    const amount = parseAmount(m[1]);
    const at = from + m.index + m[0].indexOf(m[1]);
    if (!(amount > 0)) break;
    // A model/brand number or a cc figure is not a price tier.
    if (MODEL_TAIL.test(line.slice(Math.max(0, at - 20), at))) break;
    if (CC_HEAD.test(line.slice(at + String(m[1]).length))) break;
    // A DATE RANGE IS NOT A PRICE ALTERNATION. "available 27 to 1, 250 per
    // day" is the shop stating when the vehicle is free, and this walked left
    // from the real 250 and harvested the 27 as a cheaper tier - which then
    // won BEST PRICE, because cheapest wins. The tell is scale: a
    // day-of-month sits in 1-31 and is an order of magnitude below the
    // amount it is supposedly competing with. A genuine two-tier quote
    // ("250 or 300") is nowhere near 10x apart.
    if (isDayOfMonthAlternate(amount, base)) break;
    out.push({ amount, index: at });
    cursor = at;
  }
  return out;
}

/** Where in `line` the amount captured by `m` starts. */
function amountIndex(line: string, m: RegExpMatchArray, group: number): number {
  const at = m.index ?? 0;
  const inner = m[0].indexOf(m[group] ?? "");
  return inner >= 0 ? at + inner : at;
}

// ---------------------------------------------------------------------------
// CC-KEYED PRICE LISTS.
//
// THE FIELD CASE (owner report 6, Buddy Motorbike, Krabi): the shop's whole
// negotiation was three text boards -
//
//     110cc 250฿ 125cc 300฿ 155cc 400฿ 160cc 500฿
//     4/Days 110cc 220฿ 125cc 270฿ 155cc 350฿ 160cc 450฿
//     4/Days 110cc 200฿ 125cc 250฿ 155cc 350฿ 160cc 450฿   (a SELF-DROP)
//
// - and every reader returned nothing: scanRates requires a day/week/month
// unit per expression, the rate-ladder wants a day range per ROW, and
// BARE_PRICE wants the line to be one lone amount. So the shop cut its 125cc
// price from 300 to 270 to 250 and the app never saw a single offer.
//
// The shape is its own grammar: pairs of <displacement>cc <amount>, keyed by
// ENGINE rather than by duration, with an optional leading "<N>/Days" header
// naming which stay the column prices (amounts are the shop's PER-DAY rates
// for that stay - 4x270 for a Click 125 matches the market's quoted totals;
// reading them as 4-day totals would price a scooter at 67/day, absurd).
const CC_PAIR = new RegExp(
  `\\b(\\d{2,4})\\s*cc\\b[\\s:=-]*(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?`,
  "gi"
);
const CC_LIST_HEADER = /^\s*(\d{1,2})\s*(?:\/\s*)?days?\b[:\s-]*/i;

/**
 * offer-options.ccMatches is the canonical badge-rounding rule; this local
 * twin exists only because importing it here would make price-extract and
 * offer-options mutually dependent. A test pins the two in lockstep.
 */
const ccClose = (want: number, got: number): boolean =>
  Math.abs(want - got) <= Math.max(5, want * 0.06);

/**
 * Every row of a cc-keyed list in `text`, as RentalPriceHits whose `line` is
 * the pair itself ("125cc 270฿") - so ccIn()/matchesSpec() resolve per ROW and
 * the existing option scoping picks the requested displacement. Returns [] for
 * anything that is not a genuine list (a single pair inside a sentence stays
 * with the general per-line reader).
 */
export function parseCcTierList(text: string, localCurrency?: string): RentalPriceHit[] {
  const lines = (text || "")
    .replace(URL_RX, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hits: RentalPriceHit[] = [];
  let carriedBasis: number | undefined;
  let sawCardRow = false;
  for (const raw of lines) {
    const line = expandK(raw);
    // A "[product card]" line is ingest's structural transcription of a
    // WhatsApp catalog card - provably a priced row, never prose, so a single
    // pair on it is accepted where a lone pair in a sentence would not be.
    const isCard = /^\[product card\]/i.test(line);
    const header = line.match(CC_LIST_HEADER);
    const rest = header ? line.slice(header[0].length) : line;
    const headerDays = header ? parseInt(header[1], 10) : undefined;
    if (header && !rest.trim()) {
      // A bare "4/Days" line governs the rows on the lines below it.
      carriedBasis = headerDays;
      continue;
    }
    const rows: { cc: number; amount: number; pair: string }[] = [];
    for (const m of rest.matchAll(CC_PAIR)) {
      const cc = parseInt(m[1], 10);
      const amount = parseFloat(String(m[2]).replace(/[,\s]/g, ""));
      // 50..1300cc is an engine; anything else is a price or a year. Amounts
      // under 10 are helmet counts and typos, not daily rates in any currency
      // a shop writes this way.
      if (!(cc >= 50 && cc <= 1300)) continue;
      if (!(amount >= 10) || amount === cc) continue;
      rows.push({ cc, amount: Math.round(amount), pair: m[0].trim() });
    }
    if (rows.length === 0) continue;
    // A LIST is >=2 pairs on one line, a line that is nothing but its pair, or
    // a product-card transcription (whose leftover is the model name).
    const leftover = rows
      .reduce((s, r) => s.replace(r.pair, ""), rest)
      .replace(/[\s,;|·•/-]+/g, "");
    if (rows.length < 2 && leftover.length > 6 && !isCard) continue;
    if (isCard) sawCardRow = true;
    const basis = headerDays ?? carriedBasis;
    const cur = currencyIn(line) ?? localCurrency;
    for (const r of rows) {
      hits.push({
        pricePerDay: r.amount,
        currency: cur,
        line: r.pair,
        listPrice: false,
        ...(basis ? { minDays: basis, tierLabel: `${basis} days` } : {}),
      });
    }
  }
  return hits.length >= 2 || (sawCardRow && hits.length > 0) ? hits : [];
}

export interface QuotedPrices {
  /** What the shop is offering right now (null when it quoted nothing new). */
  offer: RentalPriceHit | null;
  /** A restated regular/list price - an anchor for the negotiator, never an offer. */
  listPrice: RentalPriceHit | null;
  /**
   * EVERY live per-day amount the message named, cheapest-first. `offer` is just
   * the one this function would pick; a shop saying "some models 200 and some
   * new 250/day" is offering a MENU, and collapsing that to a single number is
   * what made the app hide the 200 tier and the agent haggle a price the
   * traveller had not chosen yet. List prices are excluded - they are anchors.
   */
  allOffers: RentalPriceHit[];
}

/**
 * Extract the traveller's rental DAILY price from a messy multi-line reply.
 * Returns null when no genuine per-day rental price is present (a transfer-only
 * template, a pure greeting, or a message that only restates the LIST price) so
 * the caller can clarify rather than book a worse number.
 */
export function extractRentalDailyPrice(
  text: string,
  opts: {
    vehicleClass?: VehicleClassHint;
    durationDays?: number;
    localCurrency?: string;
    engineSizeCc?: number;
  } = {}
): RentalPriceHit | null {
  return extractQuotedPrices(text, opts).offer;
}

/**
 * The full read: the live offer AND any restated list price, kept apart. The
 * split matters because "that is a discount already, normally it's 300/day"
 * must never overwrite an agreed 250 - it is the shop defending its discount,
 * not raising the price.
 */
export function extractQuotedPrices(
  text: string,
  opts: {
    vehicleClass?: VehicleClassHint;
    durationDays?: number;
    localCurrency?: string;
    /** The displacement the traveller declared - picks the row of a cc list. */
    engineSizeCc?: number;
  } = {}
): QuotedPrices {
  const none: QuotedPrices = { offer: null, listPrice: null, allOffers: [] };
  if (!text || !text.trim()) return none;
  // READ THE SHOP'S DIGITS, WHATEVER SCRIPT THEY ARE IN.
  //
  // Every pattern below is built on \d, which is ASCII-only, so a shop writing
  // "๒๕๐ บาท/วัน" or "២៥០ រៀល" produced offer:null - and this app's own
  // documented starvation chain then runs to its end: no deterministic price
  // hit, no vendor_replies.price, no offers row, found=false, and the card
  // renders "No price yet" while the shop is looking at the price it just sent.
  //
  // Folded for READING only; the original body is what the transcript stores
  // and shows, so the traveller still sees exactly what the shop wrote. The
  // fold is idempotent, so the nested scanRates/parseRateLadder calls below
  // folding again costs nothing.
  text = normalizeDigits(text);
  // QUOTING A NUMBER IS NOT STATING IT. Ingest appends "(quoting: ...)" so the
  // model sees a reply's referent; the deterministic rails must skip it - a
  // shop quoting OUR message would otherwise turn our numbers into its offer.
  text = text.replace(/\n?\(quoting: [\s\S]{0,320}?\)(?=\s*(?:\n|$))/g, " ");
  // THE SHOP'S OWN DATES ARE NOT MONEY, AND THEY SET THE DIVISOR.
  //
  // "27 to 1 the is 1250" is a real reply - available the 27th to the 1st,
  // 1250 for the lot - and the readers made three different mistakes on it,
  // none of them "read the price": the bare form lost the 1250 entirely, and
  // the dated forms turned the DATE digits into THB 2/day and THB 5/day tiers.
  //
  // Blanking the range does both jobs at once: those digits can no longer be
  // harvested by any pattern below, and the span they describe becomes the
  // divisor for a total the shop stated - THEIR span, not the traveller's, so
  // the derived rate is the one that shop would actually honour.
  const dateRange = readShopDateRange(text, {
    // The bare "27 to 1" shape needs a package-scale amount beside it, or a
    // genuine two-tier quote ("250 or 300") would be read as a date and a real
    // cheaper tier discarded.
    requireTotalNear: hasTotalScaleAmount(text),
  });
  if (dateRange) {
    text =
      text.slice(0, dateRange.index) +
      " ".repeat(dateRange.length) +
      text.slice(dateRange.index + dateRange.length);
  }
  const wantClass = opts.vehicleClass;
  const days = opts.durationDays && opts.durationDays > 0 ? opts.durationDays : 1;
  const lines = text
    // Links out first - a rate never lives inside a URL.
    .replace(URL_RX, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const hits: RentalPriceHit[] = [];

  // A DURATION LADDER wins outright. When the shop sent a board - "1-2 days
  // 650 / 3-7 days 600 / 8-14 days 550 / Monthly 450" - the generic patterns
  // below read "3-7 days ... 600" as a whole-rental total (86/day) and the
  // vision half simply picked a number it liked (500/day, quoted to a traveller
  // staying five days). Neither was reading the structure that is actually
  // there. rate-ladder does, so it goes first and the rest never sees the board.
  const ladder = parseRateLadder(text, { localCurrency: opts.localCurrency });
  if (ladder.length >= 2) {
    const chosen = tierForDays(ladder, days);
    const rows: RentalPriceHit[] = ladder.map((tier) => ({
      pricePerDay: tier.pricePerDay,
      currency: tier.currency ?? opts.localCurrency,
      line: tier.line,
      classMatch: lineClass(tier.line) ? lineClass(tier.line) === wantClass : undefined,
      minDays: tier.minDays,
      maxDays: tier.maxDays,
      tierLabel: tier.label,
    }));
    // The offer is the row that COVERS this stay - never the cheapest row on
    // the board. A five-day traveller cannot have the 15-29 day rate, and
    // handing the whole board to `pickCheapestOnSpec` is precisely how they
    // came to be quoted one.
    const offer = rows.find((r) => r.minDays === chosen?.minDays && r.maxDays === chosen?.maxDays);
    return {
      offer: offer ?? null,
      listPrice: null,
      // Every tier still reaches the caller so the card can show the real
      // ladder ("stay 8 days and it drops to 550") with each row's own range.
      allOffers: rows.slice().sort((a, b) => a.minDays! - b.minDays!),
    };
  }

  // A CC-KEYED LIST is the other board shape (see parseCcTierList). The offer
  // is the row whose displacement matches the request, at the most specific
  // duration tier that COVERS this stay - never the cheapest row on the board.
  const ccList = parseCcTierList(text, opts.localCurrency);
  if (ccList.length > 0) {
    const covering = ccList.filter((h) => !h.minDays || days >= h.minDays);
    const want = opts.engineSizeCc;
    const mine = want
      ? // The pair's own text starts with its displacement ("125cc 270฿").
        covering.filter((h) => {
          const cc = parseInt(h.line, 10);
          return Number.isFinite(cc) && ccClose(want, cc);
        })
      : [];
    const offer = mine.length
      ? mine.reduce((a, b) => ((b.minDays ?? 0) > (a.minDays ?? 0) ? b : a))
      : null;
    return {
      offer,
      listPrice: null,
      allOffers: ccList.slice().sort((a, b) => a.pricePerDay - b.pricePerDay),
    };
  }

  // Every EXPLICITLY per-day-marked amount in the whole message, before the
  // line loop. Division (a total split over the days) is a weaker reading than
  // a rate the shop marked "per day" - when the two contradict, the divided
  // reading loses. This is the algebra guard behind the field's ฿30/day: on a
  // coalesced message, "6 days 180" divided to 30 while "180 per day" sat one
  // line away.
  const explicitDailies: number[] = [];
  for (const l of lines) {
    for (const r of scanRates(expandK(l))) {
      if (r.unit === "day" && r.quantity === 1 && !isDurationConditionAt(expandK(l), r.index, r.matched)) {
        explicitDailies.push(r.perDay);
      }
    }
  }
  const contradictsExplicitDaily = (divided: number): boolean =>
    explicitDailies.length > 0 &&
    !explicitDailies.some((d) => Math.abs(d - divided) / d <= 0.35);

  for (const rawLine of lines) {
    if (SERVICE_LINE.test(rawLine)) continue; // transfer / tour / shuttle - skip
    const line = expandK(rawLine);
    const cls = lineClass(line);
    // A line that names a DIFFERENT displacement than requested is off-spec
    // even when the class word matches: "150 baht per day, but it's a Scoopy
    // 110cc" is a scooter, and it is still not the 125cc the traveller asked
    // for - reading it as on-spec is how a smaller bike's price wore the card.
    const lineCcM = line.match(/\b(\d{2,4})\s*cc\b/i);
    const lineCc = lineCcM ? parseInt(lineCcM[1], 10) : undefined;
    const ccMismatch =
      opts.engineSizeCc && lineCc && lineCc >= 50 && lineCc <= 1300
        ? !ccClose(opts.engineSizeCc, lineCc)
        : false;
    const classMatchOf = (): boolean | undefined =>
      ccMismatch ? false : cls ? cls === wantClass : undefined;
    // A line naming a DIFFERENT class than requested (e.g. a car line when a
    // scooter was asked) is a candidate only if nothing better is found.
    // EVERY per-day amount on the line, not just the first: shops routinely put
    // the anchor and the offer in one breath ("Normally 300/day but for you
    // 250/day"), and reading only the first left the traveller with the anchor.
    let tookDaily = false;
    // THE RATE READER (see wa/rate-expr). A rate is amount / (quantity x unit),
    // and reading only `amount ... "day"` is how "250/1day" became a 1-baht
    // offer: the ONE is the denominator, not the money. Week/month expressions
    // are left to the dedicated patterns below, whose per-day divisor follows
    // the traveller's real stay.
    for (const rate of scanRates(line)) {
      if (rate.unit !== "day") continue;
      const amt = rate.perDay;
      if (!(amt > 0) || amt === days) continue;
      const at = rate.index;
      // "...for Rentals of 8 Days or More:" states WHEN the rates below apply.
      if (isDurationConditionAt(line, at, rate.matched)) continue;
      hits.push({
        pricePerDay: amt,
        currency: currencyIn(line) ?? opts.localCurrency,
        line: rawLine,
        classMatch: classMatchOf(),
        listPrice: isListPriceAt(line, at),
        index: at,
      });
      // Numbers joined to this one by "and / or / ," share its per-day unit.
      for (const alt of alternatesBefore(line, at, amt)) {
        if (alt.amount === days) continue;
        hits.push({
          pricePerDay: alt.amount,
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: classMatchOf(),
          listPrice: isListPriceAt(line, alt.index),
          index: alt.index,
        });
      }
      tookDaily = true;
    }
    if (tookDaily) continue;
    // A trip total with no day count ("1000 or 1250 total") -> per-day over the
    // duration we actually asked for. Alternates share the unit here too, which
    // is what turns "1000 or 1250 total" into a real two-tier menu.
    const totalWord = days > 1 ? line.match(PRICE_TOTAL_WORD) : null;
    if (totalWord) {
      // PRICE_TOTAL_WORD is bidirectional ("1250 total" AND "total 1250"), so
      // the amount lands in group 1 or group 2 depending on which spelling
      // matched. Reading group 1 unconditionally crashed on the word-first
      // form the bidirectional pattern was added to support.
      const totalGroup = totalWord[1] != null ? 1 : 2;
      const totalAmount = parseAmount(totalWord[totalGroup]);
      const at = amountIndex(line, totalWord, totalGroup);
      // THE SHOP'S OWN SPAN DIVIDES THE SHOP'S OWN TOTAL.
      //
      // "5 days 1250 total" from a traveller asking for 4 divided 1250 by FOUR
      // and quoted 313/day - a number the shop never offered, for a package it
      // never priced. When the shop names the span in the same breath as the
      // total, that span is the divisor; the traveller's duration is only the
      // fallback for a bare "1250 total".
      // The shop's own words first: an explicit "5 days", then a date range it
      // stated, then - only if it named neither - the traveller's rental.
      const statedSpan = spanNamedIn(line) ?? dateRange?.spanDays;
      const span = statedSpan ?? days;
      const amounts = [
        { amount: totalAmount, index: at },
        ...alternatesBefore(line, at, totalAmount),
      ];
      let took = false;
      for (const a of amounts) {
        if (!(a.amount > span)) continue;
        if (contradictsExplicitDaily(Math.round(a.amount / span))) continue;
        hits.push({
          pricePerDay: Math.round(a.amount / span),
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
          listPrice: isListPriceAt(line, a.index),
          index: a.index,
          // A trip total divided over a span. When the shop named that span it
          // is theirs (a package that may not match the traveller's dates);
          // otherwise it is the traveller's own rental. Either way it is
          // DERIVED and says so, so the like-for-like guard can discount a
          // mismatched package downstream.
          derivedFromDays: span > 1 ? span : undefined,
        });
        took = true;
      }
      if (took) continue;
    }
    // A whole-rental total on this line ("1750 in 5 days", or reversed
    // "3 days 900") -> per-day. Try total-first phrasing, then day-count-first.
    const total = line.match(PRICE_TOTAL) ?? line.match(PRICE_TOTAL_REV);
    if (total) {
      // PRICE_TOTAL captures (amount, days); PRICE_TOTAL_REV captures (days, amount).
      const rev = !line.match(PRICE_TOTAL);
      const rawWhole = rev ? total[2] : total[1];
      const nDays = parseInt(rev ? total[1] : total[2], 10);
      // THE MAGNITUDE SUFFIX IS PART OF THE NUMBER HERE TOO. "sewa 3 hari
      // 200rb" is 200,000 over three days, not 200 - and reading it as 200 put
      // a 67-per-day phantom on the card that would have beaten every real
      // quote in the hunt.
      const wholeAt = line.indexOf(rawWhole, Math.max(0, amountIndex(line, total, rev ? 2 : 1) - 2));
      const magTail = new RegExp(`^\\s*(${MAGNITUDE_TAIL})(?![a-z])`, "i").exec(
        line.slice((wholeAt < 0 ? 0 : wholeAt) + rawWhole.length)
      );
      const whole = applyMagnitude(parseAmount(rawWhole), magTail?.[1]);
      // MISDIVISION GUARDS (the field's ฿30/day). Division is the WEAKER
      // reading: (a) an amount the shop marked per-day right after it ("6 days
      // 180 per day") is a rate, never a total - the reversed pattern must not
      // divide it; (b) a division that CONTRADICTS an explicitly marked daily
      // anywhere in the message loses to it (a consistent total - 1500 beside
      // 300/day for 5 days - still divides fine).
      const amtAt = amountIndex(line, total, rev ? 2 : 1);
      // The day token is group 1 for the reversed pattern, group 2 otherwise.
      const dayAt = amountIndex(line, total, rev ? 1 : 2);
      // A QUALIFYING DURATION is not a rental total: "minimum 3 days ..." states
      // a floor on the hire, not a price. And a number inside a deposit /
      // insurance / fine / bond clause is that charge, never the rental total.
      // Both are read as a total by the raw arithmetic, so guard the division.
      const subjectBefore = line.slice(Math.max(0, amtAt - 28), amtAt);
      // THE RAW TOKEN'S LENGTH, not the computed value's. These differ whenever
      // the amount was written with separators ("150.000") or a magnitude
      // suffix ("150 nghìn" -> 150000), and the slice below then started past
      // the text it meant to read - so the per-day marker and the charge words
      // were looked for in the wrong place.
      const amtLen = rawWhole.length + (magTail?.[0]?.length ?? 0);
      // BOTH SIDES. This looked only at the 28 chars BEFORE the amount, so
      // "500 deposit" - the charge word trailing its number, which is how
      // people actually write it - sailed through and divided to 167/day.
      // graph/guardrails' DEPOSIT_CTX has always checked both sides; this is
      // the same vocabulary, finally symmetric.
      const subjectAfter = line.slice(amtAt + amtLen, amtAt + amtLen + 16);
      const CHARGE_WORDS =
        /\b(?:deposit|deposits|down\s?payment|collateral|security|bond|insurance|excess|fine|fines|penalty|penalties|fee|fees|charge|surcharge)\b/i;
      const inChargeClause =
        /\b(?:deposit|deposits|down\s?payment|collateral|security|bond|insurance|excess|fine|fines|penalty|penalties|fee|fees|charge|surcharge)\b[^\d]{0,12}$/i.test(
          subjectBefore
        ) || CHARGE_WORDS.test(subjectAfter);
      // A CLOCK TIME OR A PERCENTAGE IS NOT A RENTAL TOTAL. "Reopen in 2 days
      // at 9" divided to 5/day; "back to you in 2 days 100%" to 50/day. The
      // tell is the token glued to the dividend, and nothing was reading it.
      const notMoneyTail = /^\s*(?:am|pm|%|:|h\b|hrs?\b|o'?clock\b)/i.test(subjectAfter);
      // ...and the same tell on the other side. "Reopen in 2 days AT 9" has
      // nothing after the 9 to give it away; the preposition before it is what
      // makes it a clock. A price is never introduced by "at" in this shape -
      // "at 250 per day" carries its unit, and that path is the rate scanner's,
      // not this division's.
      const clockCueBefore = /\b(?:at|until|till|til|before|after|from)\s*$/i.test(subjectBefore);
      if (
        isDurationConditionAt(line, dayAt, total[0]) ||
        inChargeClause ||
        notMoneyTail ||
        clockCueBefore
      )
        continue;
      const afterAmount = line.slice(amtAt + amtLen, amtAt + amtLen + 24);
      const markedPerDay = /^\s*(?:baht|thb|php|pesos?|[a-z]{1,3}\.?)?\s*(?:\/|per\b|a\b|each\b|-)?\s*day/i.test(
        afterAmount
      );
      const divided = nDays > 0 ? Math.round(whole / nDays) : 0;
      if (
        whole > 0 &&
        nDays > 0 &&
        whole > nDays &&
        !markedPerDay &&
        !contradictsExplicitDaily(divided)
      ) {
        hits.push({
          pricePerDay: divided,
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
          listPrice: isListPriceAt(line, amtAt),
          // THE "167" (owner report 5 #2). "500 for 3 days" -> 167, and the
          // span is the SHOP's 3 days, not the traveller's. When those differ
          // this is not a like-for-like daily rate and must never be repeated
          // to another shop as one.
          derivedFromDays: nDays,
        });
        continue;
      }
      // A per-day-marked amount the daily scanner somehow missed still counts
      // as a rate at face value rather than being silently dropped.
      if (whole > 0 && markedPerDay && !contradictsExplicitDaily(whole)) {
        hits.push({
          pricePerDay: Math.round(whole),
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
          listPrice: isListPriceAt(line, amtAt),
        });
        continue;
      }
    }
    // A BARE TOTAL BESIDE A DATE RANGE THE SHOP STATED.
    //
    // "27 to 1 the is 1250" and "Dec 27 to Jan 1 is 1250 baht" carry no "total"
    // word and no day COUNT, so every pattern above declines - and the shop's
    // real 1250 was simply lost. The dates were the count all along; they are
    // blanked from this text precisely because they are not money, and the span
    // they describe is what the amount beside them is divided by. THEIR span,
    // so the derived rate is one that shop would honour.
    if (dateRange && dateRange.spanDays > 1) {
      const bare = line.match(new RegExp(`(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?`, "i"));
      if (bare) {
        const at = amountIndex(line, bare, 1);
        const amount = parseAmount(bare[1]);
        const perDay = Math.round(amount / dateRange.spanDays);
        // Package-scale only, and never against an explicitly marked daily.
        if (
          amount > dateRange.spanDays * 10 &&
          perDay > 0 &&
          !isDurationConditionAt(line, at, bare[0]) &&
          !contradictsExplicitDaily(perDay)
        ) {
          hits.push({
            pricePerDay: perDay,
            currency: currencyIn(line) ?? opts.localCurrency,
            line: rawLine,
            classMatch: cls ? cls === wantClass : undefined,
            listPrice: isListPriceAt(line, at),
            // The SHOP's span, so the like-for-like rival guard can discount a
            // package the traveller's own rental does not cover.
            derivedFromDays: dateRange.spanDays,
          });
          continue;
        }
      }
    }
    // A MONTHLY quote -> per-day over the real rental length when it is a
    // month-scale request (a 30-day search is exactly where shops answer in
    // months), else a calendar month.
    const month = line.match(PRICE_MONTH);
    if (month) {
      const whole = parseAmount(month[1] ?? month[2]);
      const div = days >= 28 && days <= 31 ? days : 30;
      if (whole > 0 && whole > div) {
        hits.push({
          pricePerDay: Math.round(whole / div),
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
          listPrice: isListPriceAt(line, amountIndex(line, month, month[1] ? 1 : 2)),
          // A monthly rate spread over a month is the deepest package discount
          // a shop offers. Quoting it at a rival as a daily rate for a 2-day
          // rental is the same lie the 3-day package told, only larger.
          derivedFromDays: div,
        });
        continue;
      }
    }
    // A WEEKLY quote -> /7.
    const week = line.match(PRICE_WEEK);
    if (week) {
      const whole = parseAmount(week[1] ?? week[2]);
      const weekAt = amountIndex(line, week, week[1] ? 1 : 2);
      const afterWeekAmt = line.slice(weekAt + String(Math.round(whole)).length, weekAt + 6);
      // "open 7 days a week, 8am to 8pm" is an availability line, not a weekly
      // price: the "week" belongs to "days a week", and the number that follows
      // is a CLOCK TIME. Reject a clock time after the amount, and the whole
      // "N days a week" idiom, so it never mints an 8/7 = 1/day phantom.
      const looksLikeClock = /^\s*(?:am|pm|[:.]\d|\s*[-–]\s*\d{1,2}\s*(?:am|pm))/i.test(afterWeekAmt);
      const availabilityIdiom = /\bdays?\s+a\s+week\b/i.test(line);
      if (whole > 0 && whole > 7 && !looksLikeClock && !availabilityIdiom) {
        hits.push({
          pricePerDay: Math.round(whole / 7),
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
          listPrice: isListPriceAt(line, amountIndex(line, week, week[1] ? 1 : 2)),
          // A weekly package spread over 7 days - only a like-for-like rate for
          // a traveller actually renting a week.
          derivedFromDays: 7,
        });
      }
    }
  }

  if (!hits.length) {
    // No line broke out cleanly - try the WHOLE text once (single-line replies
    // like "350 php per day" with no newlines), still skipping if it is only a
    // transfer template.
    if (!SERVICE_LINE.test(text)) {
      const whole = expandK(text);
      for (const rate of scanRates(whole)) {
        if (rate.unit !== "day") continue;
        const amt = rate.perDay;
        if (!(amt > 0) || amt === days) continue;
        hits.push({
          pricePerDay: amt,
          currency: currencyIn(whole) ?? opts.localCurrency,
          line: text.slice(0, 120),
          classMatch: undefined,
          listPrice: isListPriceAt(whole, rate.index),
        });
      }
      // BARE-NUMBER answer to our price question ("400", "400 baht", "PHP 350
      // only"): the whole short message IS the daily price. Strict shape + a
      // sanity band so a time ("9"), a year, or a phone number never passes.
      const bare = hits.length === 0 && whole.length <= 40 ? whole.match(BARE_PRICE) : null;
      if (bare) {
        const amt = parseAmount(bare[1]);
        if (amt >= 20 && amt <= 5_000_000 && amt !== days) {
          hits.push({
            pricePerDay: amt,
            currency: currencyIn(whole) ?? opts.localCurrency,
            line: text.slice(0, 120),
            classMatch: undefined,
          });
        }
      }
    }
    // ...AND PER LINE, because burst coalescing broke the whole-text path.
    // The coalescer joins every unread frame with newlines, so a burst whose
    // one real answer is the line "200 baht" arrives as a text far over 40
    // chars and the rescue above never fires - the field failure where the
    // card said "No price yet" while the excerpt showed the price. Each LINE
    // gets the identical strict shape + band, so the rescue is exactly as
    // safe as before, applied at the granularity the message actually has.
    // Deliberately OUTSIDE the whole-text SERVICE_LINE guard above: one
    // "near the pier" pleasantry elsewhere in the burst must not suppress the
    // price line - service lines are skipped INDIVIDUALLY, exactly as the
    // main per-line loop does.
    if (hits.length === 0) {
      for (const rawLine of lines) {
        if (SERVICE_LINE.test(rawLine)) continue;
        const l = expandK(rawLine);
        if (l.length > 40) continue;
        const m = l.match(BARE_PRICE);
        if (!m) continue;
        const amt = parseAmount(m[1]);
        if (amt >= 20 && amt <= 5_000_000 && amt !== days) {
          hits.push({
            pricePerDay: amt,
            currency: currencyIn(l) ?? opts.localCurrency,
            line: rawLine.slice(0, 120),
            classMatch: undefined,
          });
          break;
        }
      }
    }
    if (!hits.length) return none;
  }

  // A restated LIST price is kept, but only as an anchor - it must never win the
  // offer slot, even when it is the ONLY number in the message. That is the
  // whole point: "normally it's 300/day" leaves an agreed 250 standing.
  const listOnly = hits.filter((h) => h.listPrice === true);
  const live = hits.filter((h) => h.listPrice !== true);
  return {
    offer: pickCheapestOnSpec(live),
    listPrice: pickCheapestOnSpec(listOnly),
    allOffers: dedupeByPrice(live).sort((a, b) => a.pricePerDay - b.pricePerDay),
  };
}

/** One entry per distinct price - the same amount restated is not a second tier. */
function dedupeByPrice(hits: RentalPriceHit[]): RentalPriceHit[] {
  // An ON-SPEC hit outranks everything; a bare number outranks a hit that
  // names the WRONG vehicle. The old rule ("defined beats undefined") let a
  // same-priced off-spec row swallow the on-spec one: Cee Moto's 110cc surf
  // bike at P450 masked the 125cc Click at P450 the traveller actually asked
  // for, once displacement-aware matching marked the surf row false.
  const rank = (h: RentalPriceHit): number =>
    h.classMatch === true ? 2 : h.classMatch === undefined ? 1 : 0;
  const seen = new Map<number, RentalPriceHit>();
  for (const h of hits) {
    const prev = seen.get(h.pricePerDay);
    if (!prev || rank(h) > rank(prev)) {
      seen.set(h.pricePerDay, h);
    }
  }
  return [...seen.values()];
}

/**
 * Prefer lines that MATCH the requested class; among those (or, failing that,
 * among class-agnostic lines) take the cheapest. Never pick a wrong-class line
 * when a matching or class-agnostic one exists.
 */
function pickCheapestOnSpec(hits: RentalPriceHit[]): RentalPriceHit | null {
  if (!hits.length) return null;
  const matching = hits.filter((h) => h.classMatch === true);
  const agnostic = hits.filter((h) => h.classMatch === undefined);
  const pool = matching.length ? matching : agnostic.length ? agnostic : hits;
  // A number the shop QUOTED beats one we DERIVED by dividing a total. Otherwise
  // a phantom division ("500 for 3 days" -> 167) could undercut and replace the
  // shop's real "250/day". Only fall back to derived hits when no quoted rate
  // exists in the pool.
  const quoted = pool.filter((h) => h.derivedFromDays === undefined);
  const choose = quoted.length ? quoted : pool;
  return choose.reduce((best, h) => (h.pricePerDay < best.pricePerDay ? h : best));
}
