// TWO RENTAL WINDOWS IN ONE MESSAGE.
//
// The request builder's "anything else?" field is free text, and whatever is
// typed there is appended VERBATIM to an opener that already states the
// picker's window. So a traveller who types "27 to 1" - the dates they actually
// want - sends a shop:
//
//   "...for 16 Aug to 19 Aug (3 days) ... Also: 27 to 1"
//
// Two different rentals, in one message, from an agent that is supposed to be
// precise. And on the free-text SEARCH path the same collision is resolved
// SILENTLY - the picker beats the typed number with nothing anywhere saying so,
// while the summary bar prints the raw request text and the reconciled dates
// side by side and lets the traveller spot the difference themselves.
//
// This module is the pure reader both surfaces were missing: does this free
// text state a rental window of its own, and does it disagree with the picker?
// Pure so the answer is tested by running it.

import { readShopDateRange } from "./wa/shop-date-range";

export interface TypedWindow {
  /** Nights the typed text describes. */
  days: number;
  /** How it was written, for the chip that quotes the traveller back. */
  text: string;
  kind: "range" | "count";
}

/** "5 days", "for 10 days", "3 hari", "3 วัน" - a bare duration. */
const COUNT = /\b(\d{1,3})\s*(?:days?|nights?|วัน|ngày|ngay|hari|araw|d)\b/i;

/**
 * The rental window this free text states, if it states one.
 *
 * Deliberately narrow. The extras field is for accessories ("2 helmets", "a
 * phone holder"), and reading "2 helmets" as a two-day rental would be a worse
 * bug than the one this fixes - so a count only counts when its unit word is a
 * time word, and a range only counts in the shapes shop-date-range recognises.
 */
export function readTypedWindow(custom: string): TypedWindow | null {
  const t = (custom ?? "").trim();
  if (!t) return null;

  const range = readShopDateRange(t, { requireTotalNear: true });
  if (range && range.spanDays >= 1 && range.spanDays <= 90) {
    return { days: range.spanDays, text: range.matched, kind: "range" };
  }
  const count = COUNT.exec(t);
  if (count) {
    const n = parseInt(count[1], 10);
    if (n >= 1 && n <= 90) return { days: n, text: count[0].trim(), kind: "count" };
  }
  return null;
}

export interface WindowConflict {
  typed: TypedWindow;
  /** What the picker says, and what the shops are therefore being told. */
  pickerDays: number;
}

/**
 * Does the free text disagree with the picker?
 *
 * Null when it says nothing about dates, or when it AGREES - a traveller who
 * types "3 days" alongside a 3-day picker has repeated themselves, not
 * contradicted themselves, and a chip there would be noise.
 */
export function windowConflict(custom: string, pickerDays: number): WindowConflict | null {
  const typed = readTypedWindow(custom);
  if (!typed) return null;
  if (!(pickerDays > 0)) return null;
  if (typed.days === pickerDays) return null;
  return { typed, pickerDays };
}

/**
 * Strip a stated window from the extras the shops are told about.
 *
 * The dates are not an accessory. Once the conflict is surfaced, sending the
 * typed range as an "also:" line is what puts two rentals in one message.
 */
export function withoutWindowText(custom: string): string {
  const typed = readTypedWindow(custom);
  if (!typed) return custom ?? "";
  return (custom ?? "").replace(typed.text, " ").replace(/\s{2,}/g, " ").trim();
}
