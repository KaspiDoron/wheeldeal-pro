// A RENTAL PRICE BOARD IS A LADDER, NOT A LIST OF NUMBERS.
//
// The live failure (Siargao, 26 Jul). The shop sent a photo board:
//
//     • 1-2 days   - ₱ 650
//     • 3-7 days   - ₱ 600
//     • 8-14 days  - ₱ 550
//     • 15-29 days - ₱ 500
//     • Monthly    - ₱ 450
//
// The traveller asked for FIVE days. The agent replied "just to confirm, your
// best rate for the Honda Click 125cc is 500/day for 5 days, correct?" - the
// 15-29 day rate, quoted for a 5-day rental, off a board that was headed 155 CC
// when the traveller had asked for 125. The shop had to correct us twice.
//
// Nothing in the reader understood that each row is a RANGE OF DAYS. The
// generic patterns saw "3-7 days ... 600" and read it as a whole-rental total
// over 7 days (86/day); the vision half just picked a plausible-looking number.
// Both were guessing at a structure that is completely deterministic.
//
// This module is that structure. Pure, so it is unit-tested against the real
// boards rather than discovered in a screenshot.
//
// Two shapes exist in the wild and they are told apart by direction, not by
// wording - which is what makes this robust across languages:
//
//   PER-DAY ladder  - the price FALLS as the stay grows (650, 600, 550, 500).
//                     Every row is already a daily rate.
//   TOTAL ladder    - the price RISES as the stay grows (900, 1600, 3000).
//                     Every row is the whole-period price; divide by the days.
//
// A rental board is never priced so that a longer stay costs less per day AND
// less in total, so the direction of the sequence identifies the unit with no
// dictionary of phrasings at all.

import { mentionedCurrencies } from "./price-extract";
import { normalizeDigits } from "../integrity/translation";

export interface RateTier {
  /** Smallest stay this row covers. */
  minDays: number;
  /** Largest stay this row covers; Infinity for an open-ended "30+ / monthly". */
  maxDays: number;
  /** Always PER DAY, whichever shape the board was written in. */
  pricePerDay: number;
  /** The amount exactly as the shop wrote it, before any division. */
  statedAmount: number;
  /** "per-day" when the row was already a daily rate, else "total". */
  unit: "per-day" | "total";
  currency?: string;
  /** The shop's own words for the range ("3-7 days", "Monthly"). */
  label: string;
  /** The whole line, so callers can read the vehicle words around it. */
  line: string;
}

// A number with optional thousands separators. Deliberately narrow: a board row
// has one price, and a greedy pattern would swallow the day range.
const AMOUNT = "(\\d{1,3}(?:[.,\\s]\\d{3})+|\\d{2,7})(?:\\.\\d{1,2})?";

// "1-2 days", "3 to 7 days", "8 – 14 day", "15-29days"
const RANGE_RX = new RegExp(
  `\\b(\\d{1,3})\\s*(?:-|–|—|to|until|\\+?\\s*-\\s*)\\s*(\\d{1,3})\\s*days?\\b`,
  "i"
);
// "1 day", "7 days" (a single point, not a range)
const SINGLE_RX = /\b(\d{1,3})\s*days?\b/i;
// "8 days or more", "15+ days", "30 days and up"
const OPEN_RX = /\b(\d{1,3})\s*(?:\+|days?\s*(?:or\s+(?:more|above|longer|up)|and\s+(?:up|above|over)|plus|onwards?))/i;
// Named periods. A board that says "Monthly" means "a month or longer".
const WEEKLY_RX = /\b(?:weekly|per\s+week|a\s+week|1\s*week|one\s+week)\b/i;
const MONTHLY_RX = /\b(?:monthly|per\s+month|a\s+month|1\s*month|one\s+month)\b/i;

const AMOUNT_RX = new RegExp(AMOUNT, "g");

/** Rows that are conditions or headings, never a priced tier. */
const NOT_A_TIER =
  /\b(deposit|requirements?|driver'?s?\s+licen[cs]e|passport|waiver|helmet|insurance|contact|address|open|hours?|facebook|whats\s?app|call|viber)\b/i;

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/[,\s]/g, "").replace(/\.(?=\d{3}\b)/g, ""));
}

/**
 * The day range this row covers, or null when the row names no duration at all.
 * Ranges are inclusive on both ends, the way a shop means them.
 */
export function rangeOf(line: string): { minDays: number; maxDays: number; label: string } | null {
  const text = line || "";
  const open = text.match(OPEN_RX);
  if (open) {
    const n = parseInt(open[1], 10);
    if (n > 0 && n <= 400) return { minDays: n, maxDays: Infinity, label: open[0].trim() };
  }
  const range = text.match(RANGE_RX);
  if (range) {
    const a = parseInt(range[1], 10);
    const b = parseInt(range[2], 10);
    if (a > 0 && b >= a && b <= 400) return { minDays: a, maxDays: b, label: range[0].trim() };
  }
  if (MONTHLY_RX.test(text)) {
    // A month is where a board stops; anything longer still pays the month rate.
    return { minDays: 30, maxDays: Infinity, label: (text.match(MONTHLY_RX) ?? ["Monthly"])[0] };
  }
  if (WEEKLY_RX.test(text)) {
    return { minDays: 7, maxDays: 13, label: (text.match(WEEKLY_RX) ?? ["Weekly"])[0] };
  }
  const single = text.match(SINGLE_RX);
  if (single) {
    const n = parseInt(single[1], 10);
    if (n > 0 && n <= 400) return { minDays: n, maxDays: n, label: single[0].trim() };
  }
  return null;
}

/** The priced amount on a row - the last number that is not part of the range. */
function amountOf(line: string, label: string): number | undefined {
  // Blank out the duration words first so "1-2 days - 650" cannot yield 1 or 2.
  const masked = label ? line.replace(label, " ".repeat(label.length)) : line;
  let best: number | undefined;
  for (const m of masked.matchAll(AMOUNT_RX)) {
    const n = parseAmount(m[0]);
    // A rental rate is never under 10 in any currency a shop quotes in, and a
    // board never runs into the millions.
    if (Number.isFinite(n) && n >= 10 && n <= 5_000_000) best = n;
  }
  return best;
}

/**
 * Read every duration tier on a board. Returns [] unless at least TWO rows
 * genuinely form a ladder - a single "5 days 1750" is an ordinary total and the
 * existing readers handle it better than a one-row ladder ever could.
 */
export function parseRateLadder(
  text: string,
  opts: { localCurrency?: string } = {}
): RateTier[] {
  if (!text || !text.trim()) return [];
  // Same reason as scanRates: every row pattern here is \d-based, so a tier
  // list written in local numerals parses as no tiers at all.
  text = normalizeDigits(text);
  const rows: Array<Omit<RateTier, "pricePerDay" | "unit">> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || NOT_A_TIER.test(line)) continue;
    const range = rangeOf(line);
    if (!range) continue;
    const amount = amountOf(line, range.label);
    if (amount === undefined) continue;
    rows.push({
      minDays: range.minDays,
      maxDays: range.maxDays,
      statedAmount: amount,
      currency: mentionedCurrencies(line)[0] ?? opts.localCurrency,
      label: range.label,
      line,
    });
  }
  if (rows.length < 2) return [];

  // Rows must describe DIFFERENT stretches of time - a shop restating one
  // duration twice is not a ladder.
  rows.sort((a, b) => a.minDays - b.minDays);
  const spans = new Set(rows.map((r) => `${r.minDays}-${r.maxDays}`));
  if (spans.size < 2) return [];

  // THE DISCRIMINATOR. Longer stay, smaller number => the numbers are already
  // per-day rates. Longer stay, bigger number => they are period totals.
  let falling = 0;
  let rising = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].statedAmount < rows[i - 1].statedAmount) falling += 1;
    else if (rows[i].statedAmount > rows[i - 1].statedAmount) rising += 1;
  }
  const perDay = falling >= rising;

  return rows.map((r) => {
    if (perDay) {
      return { ...r, pricePerDay: r.statedAmount, unit: "per-day" as const };
    }
    // A total is spread over the row's own span. An open-ended row ("30+") is
    // divided by where it starts, which is the only length it is certain to
    // cover.
    const span = Number.isFinite(r.maxDays) ? r.maxDays : r.minDays;
    const over = Math.max(1, Math.round((r.minDays + span) / 2));
    return { ...r, pricePerDay: Math.round(r.statedAmount / over), unit: "total" as const };
  });
}

/**
 * The row that actually applies to a stay of `days`.
 *
 * Exact containment first. When nothing contains it (a board that starts at
 * "3-7 days" for a 1-day ask), fall back to the NEAREST row rather than
 * inventing a rate - and never to the cheapest, which is how a 5-day rental
 * came to be quoted at the 15-29 day price.
 */
export function tierForDays(tiers: RateTier[], days: number): RateTier | null {
  if (!tiers.length) return null;
  const d = days > 0 ? days : 1;
  const exact = tiers.find((t) => d >= t.minDays && d <= t.maxDays);
  if (exact) return exact;
  let best = tiers[0];
  let bestGap = Infinity;
  for (const t of tiers) {
    const gap = d < t.minDays ? t.minDays - d : Number.isFinite(t.maxDays) ? d - t.maxDays : 0;
    if (gap < bestGap) {
      bestGap = gap;
      best = t;
    }
  }
  return best;
}

/**
 * The one number to quote for this stay, straight off the board. Null when the
 * message holds no ladder, so callers fall through to the ordinary readers.
 */
export function ladderRateFor(
  text: string,
  days: number,
  opts: { localCurrency?: string } = {}
): { pricePerDay: number; tier: RateTier; tiers: RateTier[] } | null {
  const tiers = parseRateLadder(text, opts);
  const tier = tierForDays(tiers, days);
  if (!tier) return null;
  return { pricePerDay: tier.pricePerDay, tier, tiers };
}

/** "₱600/day for 3-7 days" - what the agent may state without inventing a word. */
export function describeTier(tier: RateTier): string {
  return `${tier.pricePerDay}/day (${tier.label})`;
}
