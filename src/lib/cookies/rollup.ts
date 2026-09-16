import "server-only";

// WHAT THE FLEET ACTUALLY CONSENTED TO - the owner's view, and an HONEST one.
//
// The number a consent dashboard most wants to show is an acceptance rate, and
// it is the number most likely to be a lie. Three ways it goes wrong, all
// avoided here:
//
// 1. COUNTING ROWS INSTEAD OF PEOPLE. `consent_events` is append-only: every
//    save writes a row per category, so somebody who opens the panel four times
//    contributes four rows and a "62% accepted analytics" that is really "62%
//    of saves". This counts the NEWEST row per person per kind, which is the
//    only thing that means anything.
//
// 2. READING A DEAD TABLE AS A ZERO. `sbCountDark` returns null for "could not
//    read" and a number for "read it, and it was this" - the difference between
//    "nobody consented" and "we have no idea", which on a consent surface is
//    the difference between a finding and a bug. `degraded` names every read
//    that came back null, and the panel renders those as unknown, not as 0.
//
// 3. A DENOMINATOR THAT FLATTERS. The rate is over people who ANSWERED, and the
//    count of people who have never answered is reported separately rather than
//    quietly folded in as a rejection. They are not the same thing and an owner
//    deciding whether the banner is working needs both.
//
// Read-only and owner-gated at the route. No personal data leaves this module:
// it returns counts, never the addresses behind them.

import { sbSelectDark } from "../runtime-config";
import { CATEGORY_CONSENT_KIND } from "./server";
import { OPTIONAL_CATEGORIES, type CookieCategory } from "./manifest";

export interface CategoryRollup {
  category: CookieCategory;
  /** Distinct people whose newest row for this kind is a grant. */
  granted: number;
  /** Distinct people whose newest row is a withdrawal. */
  denied: number;
  /** granted / (granted + denied), or null when nobody has answered. */
  rate: number | null;
}

export interface ConsentRollup {
  categories: CategoryRollup[];
  /** Distinct people who have answered the banner at least once. */
  answered: number;
  /**
   * Reads that could not be performed. NOT an error - the caller renders these
   * as "unknown" rather than showing a zero it cannot stand behind.
   */
  degraded: string[];
  /** How far back the window reaches, in days. */
  windowDays: number;
}

interface LedgerRow {
  email: string;
  kind: string;
  granted: boolean | null;
  accepted_at: string;
}

/**
 * Newest-row-per-(person, kind), over the window.
 *
 * Deliberately one read of the raw rows rather than four counting queries: the
 * "newest per person" reduction cannot be expressed in a PostgREST count, and
 * four counts that each disagree about which row is newest is how a dashboard
 * ends up showing 1,400 grants and 1,600 denials over 1,200 people.
 *
 * Bounded at `limit` rows. Past that the answer is marked degraded rather than
 * silently truncated - a rollup computed from the first 5,000 of 40,000 rows is
 * a wrong number wearing a right number's clothes.
 */
export async function buildConsentRollup(
  windowDays = 90,
  limit = 5000
): Promise<ConsentRollup> {
  const degraded: string[] = [];
  const kinds = OPTIONAL_CATEGORIES.map((c) => CATEGORY_CONSENT_KIND[c as keyof typeof CATEGORY_CONSENT_KIND]);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const rows = await sbSelectDark<LedgerRow>(
    "consent_events",
    `select=email,kind,granted,accepted_at` +
      `&kind=in.(${kinds.map((k) => encodeURIComponent(k)).join(",")})` +
      `&accepted_at=gte.${encodeURIComponent(since)}` +
      `&order=accepted_at.desc&limit=${limit + 1}`
  );

  if (rows === null) {
    // Unreadable, not empty. Every category is unknown.
    return {
      categories: OPTIONAL_CATEGORIES.map((category) => ({
        category,
        granted: 0,
        denied: 0,
        rate: null,
      })),
      answered: 0,
      degraded: ["consent_events"],
      windowDays,
    };
  }
  if (rows.length > limit) {
    degraded.push(`consent_events (more than ${limit} rows in the window - counts are partial)`);
  }

  // Rows arrive newest-first, so the FIRST time a (person, kind) is seen is its
  // newest state. Everything after it is history.
  const newest = new Map<string, boolean>();
  const people = new Set<string>();
  for (const r of rows.slice(0, limit)) {
    const email = String(r?.email ?? "").trim().toLowerCase();
    const kind = String(r?.kind ?? "");
    if (!email || !kind) continue;
    const key = `${email}|${kind}`;
    if (newest.has(key)) continue;
    // A legacy row with no `granted` column has always meant an acceptance -
    // the same reading recordConsent's pre-migration fallback relies on.
    newest.set(key, r.granted !== false);
    people.add(email);
  }

  const categories: CategoryRollup[] = OPTIONAL_CATEGORIES.map((category) => {
    const kind = CATEGORY_CONSENT_KIND[category as keyof typeof CATEGORY_CONSENT_KIND];
    let granted = 0;
    let denied = 0;
    for (const [key, value] of newest) {
      if (!key.endsWith(`|${kind}`)) continue;
      if (value) granted++;
      else denied++;
    }
    const total = granted + denied;
    return { category, granted, denied, rate: total > 0 ? granted / total : null };
  });

  return { categories, answered: people.size, degraded, windowDays };
}
