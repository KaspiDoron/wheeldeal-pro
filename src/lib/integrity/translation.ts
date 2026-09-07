// A TRANSLATION THAT LOSES A PRICE IS NOT A TRANSLATION.
//
// localizeMessage hands the composed English to an LLM and sends whatever comes
// back, in a script the traveller usually cannot read. Everything else in this
// codebase treats a numeral as load-bearing - the provenance rail, the duration
// rail, the rate algebra - and then the last hop before the wire had no check at
// all. A dropped "180", or a "180" that came back as "150", is a wrong offer
// sent in the traveller's name to a real shop.
//
// This is deliberately a FIDELITY check, not a quality one: it asks only whether
// the numbers survived. Anything more would need a second model call on the
// critical path, which is the latency this file exists to protect.

// Local scripts render digits in their own code points, and a correct Thai or
// Arabic translation may well use them. Fold them to ASCII before comparing, or
// the check would reject exactly the translations it is meant to accept.
const DIGIT_BASES: number[] = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic (Persian/Urdu)
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0e50, // Thai
  0x0ed0, // Lao
  0x0f20, // Tibetan
  0x1040, // Myanmar
  0x17e0, // Khmer
  0x1810, // Mongolian
  0xff10, // Fullwidth (CJK input methods)
];

/** Fold every non-ASCII digit script this app can plausibly meet into 0-9. */
export function normalizeDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    let mapped: string | null = null;
    for (const base of DIGIT_BASES) {
      if (cp >= base && cp <= base + 9) {
        mapped = String(cp - base);
        break;
      }
    }
    out += mapped ?? ch;
  }
  return out;
}

// Thousands separators differ by locale (1,200 / 1.200 / 1 200 / 1'200) and a
// translator is free to change them. Strip one only when it sits between digits
// AND is followed by exactly three of them - which is what makes the ambiguous
// "." safe to include: "1.200" is a European thousand, while "3.5" (one digit)
// and "12.50" (two) are decimals and keep their punctuation. A sentence-ending
// period never glues two numbers together, because a space follows it.
const SEPARATOR_BETWEEN_DIGITS = /(?<=\d)[,.  '’](?=\d{3}\b)/g;

/**
 * The numbers a translation MUST carry through.
 *
 * Only 3+ digit runs count. Prices are the fact that causes real-world harm
 * when it drifts, and no chat translation spells out "one hundred and eighty" -
 * whereas small counts ("3 days" -> "three days" in the local language) are
 * perfectly idiomatic, and rejecting those would flip the whole hunt to English
 * for a translation that was actually correct. A guarantee that fires on
 * correct output is not a guarantee; it is a downgrade.
 */
export function significantNumbers(s: string): string[] {
  const flat = normalizeDigits(s).replace(SEPARATOR_BETWEEN_DIGITS, "");
  const found = flat.match(/\d{3,}/g) ?? [];
  return Array.from(new Set(found));
}

/**
 * EVERY numeral the text asserts, price-scale or not.
 *
 * `significantNumbers` ignores 1-2 digit runs because a correct translation may
 * spell a small count out in words, and rejecting that would downgrade the hunt
 * to English for output that was right. That reasoning holds only in the DROP
 * direction: a numeral the translation ADDED was never spelled out anywhere -
 * it is new text asserting a new fact.
 */
export function allNumerals(s: string): string[] {
  const flat = normalizeDigits(s).replace(SEPARATOR_BETWEEN_DIGITS, "");
  return Array.from(new Set(flat.match(/\d+/g) ?? []));
}

/** Which way a translation broke fidelity, or null when it did not. */
export type NumberDrift = "dropped" | "added";

/**
 * THE CHECK IS SYMMETRIC (F142).
 *
 * On the primary engine every number rail - `checkOutboundNumbers`,
 * `correctDuration` - runs over the ENGLISH draft, and the LOCALIZED string is
 * what actually reaches WhatsApp. This function was the only thing standing
 * between the two, and it was a one-directional subset test over 3+ digit runs:
 * a translation could invent "ปกติ 800" (a price the thread never held, shown
 * back to the traveller as their own words) or turn the 4-day rental every
 * prior message asserted into 7, and both passed. The graph failover has no
 * such gap - it localizes first and rails afterwards - so the two engines
 * disagreed about which text the rails guard.
 *
 * Deliberately still a FIDELITY check and not the grounded provenance rail:
 * re-running a basis tuned on English drafts over Thai or Vietnamese wire text
 * would produce false rejections, and a false rejection flips that shop to
 * English for the rest of the hunt - the exact downgrade this file argues
 * against. An INVENTED numeral is unambiguous in any script.
 *
 * Fails CLOSED on the caller's side (the caller retries, then keeps the English
 * source) because sending an English message the shop can read beats sending a
 * local-language message that quotes the wrong price.
 */
export function numberDrift(source: string, translated: string): NumberDrift | null {
  const want = significantNumbers(source);
  const have = new Set(significantNumbers(translated));
  if (!want.every((n) => have.has(n))) return "dropped";
  const known = new Set(allNumerals(source));
  if (!allNumerals(translated).every((n) => known.has(n))) return "added";
  return null;
}

/** True when the translation carries the source's numbers and invents none. */
export function numbersPreserved(source: string, translated: string): boolean {
  return numberDrift(source, translated) === null;
}
