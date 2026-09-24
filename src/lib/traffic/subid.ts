// THE SUB-ID: the one value about a visitor that leaves the building.
//
// Every search-feed partner takes a tracking parameter and hands it back in the
// revenue report, which is how a click here is matched to a payment there. It
// is also the only place in this app where something derived from a visitor is
// handed to a company whose logs, exports and retention this app does not
// control. Erasure cannot reach it. Retention cannot prune it.
//
// So the rule is not "be careful what you put in it". The rule is that personal
// data CANNOT enter it: every field is either a code looked up from a closed
// vocabulary in this file, or a truncated one-way hash. There is no code path
// from a caller's string to the output. A caller who passes an email as the
// market gets the neutral bucket back, not an echo - see subid.test.ts, which
// pins exactly that with hostile inputs.
//
// NO "server-only": the content page builds a sub-id in the browser for link
// placements, and the server builds one when it logs the click.

/** Where on the site a placement sits. The code is what the partner sees. */
export const PLACEMENTS = {
  "guide-inline": { code: "1", label: "Guide article, after the content" },
  "guide-hub": { code: "2", label: "Guides hub" },
  "search-results": { code: "3", label: "Search results page" },
  "no-coverage": { code: "4", label: "Search with no shops in the area" },
  "hunt-ended": { code: "5", label: "A hunt that ended with no deal" },
  unknown: { code: "0", label: "Unknown placement" },
} as const;

export type Placement = keyof typeof PLACEMENTS;

/** Vehicle / content category. Closed, so it cannot carry a query string. */
export const SUBID_CATEGORIES = ["scooter", "motorbike", "car", "insurance", "licence", "travel", "other"] as const;
export type SubIdCategory = (typeof SUBID_CATEGORIES)[number];

/** ISO 3166-1 alpha-2 of the markets the guides and the product cover. `xx` is
 *  the neutral bucket - an unknown market reports as unknown, never as text. */
export const SUBID_MARKETS = [
  "th", "vn", "id", "ph", "my", "kh", "la", "lk", "in", "np",
  "gr", "es", "it", "pt", "hr", "tr", "mx", "co", "br", "us",
  "gb", "de", "fr", "il", "au", "xx",
] as const;
export type SubIdMarket = (typeof SUBID_MARKETS)[number];

/** Partners cap tracking params at different lengths; 40 clears every one the
 *  registry knows about, and the format below tops out well under it. */
export const SUBID_MAX_LENGTH = 40;

export interface SubIdInput {
  placement: Placement | string;
  market: string;
  category: string;
  /** A random per-browser seed (the consented analytics id). Never sent. */
  sessionSeed: string;
  /** UTC day, YYYY-MM-DD. The hash rotates on it. */
  day: string;
}

export interface ParsedSubId {
  placement: Placement;
  market: SubIdMarket;
  category: SubIdCategory;
  session: string;
}

// The three normalisers are exported because the click log stores the same
// dimensions and must collapse hostile input the same way: one vocabulary, one
// neutral bucket, whether the value is leaving in a sub-id or landing in a row.
export function placementOf(value: string): Placement {
  return Object.prototype.hasOwnProperty.call(PLACEMENTS, value) ? (value as Placement) : "unknown";
}

export function marketOf(value: string): SubIdMarket {
  const v = String(value ?? "").toLowerCase();
  return (SUBID_MARKETS as readonly string[]).includes(v) ? (v as SubIdMarket) : "xx";
}

export function categoryOf(value: string): SubIdCategory {
  const v = String(value ?? "").toLowerCase();
  return (SUBID_CATEGORIES as readonly string[]).includes(v) ? (v as SubIdCategory) : "other";
}

/**
 * FNV-1a, 32-bit, as 8 hex characters.
 *
 * Not a cryptographic hash, and it does not need to be one: the input is a
 * random seed nobody outside this browser holds, so there is nothing to
 * brute-force back to. What it needs is to be synchronous (it runs in a click
 * handler, where `crypto.subtle` would turn the navigation async and lose the
 * click on Safari) and identical on both sides of the wire. 32 bits is a
 * DELIBERATELY small space - enough to de-duplicate one day's clicks, too few
 * to be a durable identifier for anyone.
 */
export function sessionHash(seed: string, day: string): string {
  const input = `${day}|${seed}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** `p<placement>-m<market>-c<category>-<hash8>`, e.g. `p1-mth-cscooter-9a3f01bc`. */
export function buildSubId(input: SubIdInput): string {
  const placement = PLACEMENTS[placementOf(String(input.placement))].code;
  const market = marketOf(input.market);
  const category = categoryOf(input.category);
  const session = sessionHash(String(input.sessionSeed ?? ""), String(input.day ?? ""));
  return `p${placement}-m${market}-c${category}-${session}`;
}

const SUBID_PATTERN = /^p([0-9])-m([a-z]{2})-c([a-z]+)-([0-9a-f]{8})$/;

/**
 * Read a sub-id back out of a partner's revenue report.
 *
 * Returns null for anything this module did not build. A report row whose
 * sub-id does not parse is reported as UNATTRIBUTED revenue, never guessed into
 * a placement - a reconciliation that invents attribution is worse than one
 * that admits a gap.
 */
export function parseSubId(value: string): ParsedSubId | null {
  const m = SUBID_PATTERN.exec(String(value ?? ""));
  if (!m) return null;
  const [, code, market, category, session] = m;
  const placement = (Object.keys(PLACEMENTS) as Placement[]).find((p) => PLACEMENTS[p].code === code);
  if (!placement) return null;
  if (!(SUBID_MARKETS as readonly string[]).includes(market)) return null;
  if (!(SUBID_CATEGORIES as readonly string[]).includes(category)) return null;
  return {
    placement,
    market: market as SubIdMarket,
    category: category as SubIdCategory,
    session,
  };
}
