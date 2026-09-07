// WHAT IS ALLOWED TO LEAVE THE DEVICE.
//
// This module owns the decision that closes the second cross-user leak, and it
// is deliberately separate from i18n.tsx: that file is a "use client" React
// module, so nothing in a plain test can execute it. The rule that matters here
// is not UI, it is a data-egress rule, and it has to be testable on its own.
//
// THE LEAK. A string handed to t() was added to `pending`, POSTed to
// /api/translate, and cached into `app_config` key `I18N_<lang>` - ONE ROW,
// served to every user of that language. t() is called with runtime values in
// 22 places (`t(offer.vehicleNote)`, `t(chip.text)`, `t(queueItem.reason)`), so
// shop names, WhatsApp transcript fragments and per-user reasons carrying the
// traveller's own trust score were uploaded into a shared dictionary.
//
// THE RULE. The catalogue is the closed set of app copy: every literal
// `t("...")` in src, plus the computed copy declared in i18n-extras.ts. If a
// string is not in it, it is not ours to upload. It still renders - unchanged,
// in English - it simply never travels.
//
// This also bounds the dictionary. Unbounded input is what made `app_config`
// grow without limit, which is the same defect that made every cold start
// download the entire translation corpus before it could read one vault key.

import { I18N_CATALOG } from "./i18n-catalog";

const CATALOG = new Set<string>(I18N_CATALOG);

/** Strings seen by t() that still need a translation (swept in batches). */
export const pending = new Set<string>();

/**
 * Strings the server has already declined to translate. WITHOUT THIS SET the
 * sweep is a loop: t() re-adds every untranslated string on the next render,
 * the sweep asks again 1.5s later, and nothing ever changes the answer.
 */
export const failed = new Set<string>();

/**
 * Strings a fetch is CURRENTLY asking the server about (audit F253).
 *
 * Without this set the 1.5s sweep re-POSTed the strings the initial catalogue
 * fetch was still holding: `setLang` commits an empty dict for a cold cache, so
 * every t() on screen re-queues its string into `pending` while those very
 * strings are in flight. Each re-post is a request, each request is charged
 * against LIMIT_TRANSLATE_PER_DAY, and the 429 that follows latches the
 * terminal stop that leaves the app in English for the rest of the day.
 */
export const inFlight = new Set<string>();

/** Claim these strings as in flight. Returns the ones this call actually
 *  claimed, so the caller releases exactly what it took. */
export function markInFlight(texts: Iterable<string>): string[] {
  const claimed: string[] = [];
  for (const s of texts) {
    if (inFlight.has(s)) continue;
    inFlight.add(s);
    claimed.push(s);
  }
  return claimed;
}

/** Release strings claimed by markInFlight - always from a `finally`. */
export function clearInFlight(texts: Iterable<string>): void {
  for (const s of texts) inFlight.delete(s);
}

/**
 * Put a batch back after a TRANSIENT failure. The sweep clears `pending` when
 * it takes a batch, so a 5xx or a dropped connection used to lose those strings
 * until some later render happened to re-queue them. A string the server has
 * already declined is never resurrected.
 */
export function requeueForTranslation(texts: Iterable<string>): void {
  for (const s of texts) if (!failed.has(s)) pending.add(s);
}

/** Is this string app copy - i.e. may it be sent to the translator at all? */
export function translatable(s: string): boolean {
  return CATALOG.has(s);
}

/** The full catalogue, for the up-front sweep on a language switch. */
export function catalogue(): string[] {
  return [...CATALOG];
}

/**
 * Queue a string for the next translation sweep. Returns whether it was
 * queued - false means it is not app copy and must never be uploaded.
 *
 * This is the ONLY way a string enters `pending`, so the payload of every
 * /api/translate request is exactly what this function admitted.
 */
export function queueForTranslation(s: string): boolean {
  if (!translatable(s)) return false;
  if (failed.has(s)) return false;
  pending.add(s);
  return true;
}

/**
 * Queue owner-authored GLOBAL text that is not in the catalogue - today only
 * the FAQ from /api/faq, which is written by the operator and identical for
 * every traveller, so caching it in the shared row is correct by construction.
 *
 * NEVER call this with a shop name, a message, a price, a search query or
 * anything else derived from one user's session.
 */
export function queueSharedText(s: string): boolean {
  if (!s || failed.has(s)) return false;
  pending.add(s);
  return true;
}
