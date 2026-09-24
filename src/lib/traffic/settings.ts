// EVERY KNOB OF THE TRAFFIC MODULE, IN ONE VALIDATED VALUE.
//
// `TRAFFIC_SETTINGS` is a JSON object in the Key Vault. Anything it omits takes
// the default below, so an empty value is a complete, working configuration -
// and the defaults ARE the documentation of what can be changed:
//
//   {
//     "raf": false,
//     "relatedSearches": 5,
//     "maxAds": 3,
//     "placements": { "guide-inline": true, "search-results": true,
//                     "guide-hub": true, "no-coverage": true, "hunt-ended": true },
//     "ignoredPageParams": ["utm_source", "..."],
//     "linkTerms": { "th|scooter": ["scooter rental Thailand", "..."] },
//     "funnelGuides": { "th": "thailand-scooter-rental-prices" }
//   }
//
// CONFIGURABLE IS NOT THE SAME AS UNBOUNDED. Some of these numbers are limits
// Google sets, and a value outside them is not a preference, it is a policy
// violation that costs the account. So every number is CLAMPED to the range the
// account is allowed, and the clamp depends on `raf`: an account without
// Restricted Access Features is served at most 5 suggestions and may show at
// most 3 ads in a block, whatever the vault says. The owner turns `raf` on only
// after Google has granted it - the setting describes the account, it does not
// upgrade it.
//
// A value that cannot be parsed falls back to the defaults AND is reported, so
// Admin -> Traffic can say "your settings were ignored" instead of the module
// quietly running on something the owner did not choose.
//
// Pure, no I/O, isomorphic: the server parses, the browser receives the result.

import { PLACEMENTS, SUBID_CATEGORIES, SUBID_MARKETS, type Placement } from "./subid";

export interface TrafficSettings {
  /** The AdSense account holds Restricted Access Features. Describes, never grants. */
  raf: boolean;
  relatedSearches: number;
  maxAds: number;
  placements: Record<Exclude<Placement, "unknown">, boolean>;
  ignoredPageParams: string[];
  /** Override the generated link-partner terms, keyed `market|category`. */
  linkTerms: Record<string, string[]>;
  /** Which guide a market's funnel card points at, keyed by market code. */
  funnelGuides: Record<string, string>;
}

export const DEFAULT_IGNORED_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid", "msclkid", "ref", "rac"];

export const DEFAULT_TRAFFIC_SETTINGS: TrafficSettings = {
  raf: false,
  relatedSearches: 5,
  maxAds: 3,
  placements: { "guide-inline": true, "guide-hub": true, "search-results": true, "no-coverage": true, "hunt-ended": true },
  ignoredPageParams: DEFAULT_IGNORED_PARAMS,
  linkTerms: {},
  funnelGuides: {},
};

/** Google shows nothing under 3 suggestions; a non-RAF account is served at most 5. */
const RELATED_MIN = 3;
const RELATED_MAX = { standard: 5, raf: 10 };
/** Ads in one block. 3 is the desktop ceiling for a results page. */
const ADS_MIN = 1;
const ADS_MAX = 3;

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const TERM_OK = /^[\p{L}\p{N} '&.-]{2,60}$/u;
const PARAM_OK = /^[A-Za-z0-9_.-]{1,40}$/;
const SLUG_OK = /^[a-z0-9-]{3,80}$/;

export function parseTrafficSettings(raw: string | null | undefined): { settings: TrafficSettings; errors: string[] } {
  const errors: string[] = [];
  const text = String(raw ?? "").trim();
  if (!text) return { settings: DEFAULT_TRAFFIC_SETTINGS, errors };

  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    input = parsed as Record<string, unknown>;
  } catch {
    return { settings: DEFAULT_TRAFFIC_SETTINGS, errors: ["TRAFFIC_SETTINGS is not a JSON object - every setting is on its default"] };
  }

  const known = new Set(Object.keys(DEFAULT_TRAFFIC_SETTINGS));
  for (const key of Object.keys(input)) if (!known.has(key)) errors.push(`unknown setting "${key}" was ignored`);

  const raf = input.raf === true;
  const relatedMax = raf ? RELATED_MAX.raf : RELATED_MAX.standard;
  const relatedSearches = clamp(input.relatedSearches, RELATED_MIN, relatedMax, DEFAULT_TRAFFIC_SETTINGS.relatedSearches);
  if (input.relatedSearches !== undefined && Number(input.relatedSearches) !== relatedSearches) {
    errors.push(`relatedSearches was set to ${relatedSearches}: the allowed range is ${RELATED_MIN}-${relatedMax}${raf ? "" : " without Restricted Access Features"}`);
  }
  const maxAds = clamp(input.maxAds, ADS_MIN, ADS_MAX, DEFAULT_TRAFFIC_SETTINGS.maxAds);
  if (input.maxAds !== undefined && Number(input.maxAds) !== maxAds) errors.push(`maxAds was set to ${maxAds}: the allowed range is ${ADS_MIN}-${ADS_MAX}`);

  const placements = { ...DEFAULT_TRAFFIC_SETTINGS.placements };
  if (input.placements && typeof input.placements === "object" && !Array.isArray(input.placements)) {
    for (const [name, on] of Object.entries(input.placements as Record<string, unknown>)) {
      if (name !== "unknown" && Object.prototype.hasOwnProperty.call(PLACEMENTS, name) && typeof on === "boolean") {
        placements[name as keyof typeof placements] = on;
      } else errors.push(`placement "${name}" was ignored (unknown placement, or not true/false)`);
    }
  }

  let ignoredPageParams = DEFAULT_TRAFFIC_SETTINGS.ignoredPageParams;
  if (Array.isArray(input.ignoredPageParams)) {
    const clean = input.ignoredPageParams.filter((p): p is string => typeof p === "string" && PARAM_OK.test(p)).slice(0, 40);
    // `rac` is always ignored for crawling: it varies per ad, and without it
    // every creative would make the same article a different page to Google.
    ignoredPageParams = [...new Set([...clean, "rac"])];
  }

  const linkTerms: Record<string, string[]> = {};
  if (input.linkTerms && typeof input.linkTerms === "object" && !Array.isArray(input.linkTerms)) {
    for (const [key, list] of Object.entries(input.linkTerms as Record<string, unknown>)) {
      const [market, category] = key.split("|");
      const okKey = (SUBID_MARKETS as readonly string[]).includes(market) && (SUBID_CATEGORIES as readonly string[]).includes(category);
      const terms = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && TERM_OK.test(x.trim())).map((x) => x.trim()) : [];
      if (!okKey || terms.length === 0) {
        errors.push(`linkTerms "${key}" was ignored (the key is market|category, the value a list of plain search terms)`);
        continue;
      }
      linkTerms[key] = [...new Set(terms)].slice(0, 5);
    }
  }

  const funnelGuides: Record<string, string> = {};
  if (input.funnelGuides && typeof input.funnelGuides === "object" && !Array.isArray(input.funnelGuides)) {
    for (const [market, slug] of Object.entries(input.funnelGuides as Record<string, unknown>)) {
      if ((SUBID_MARKETS as readonly string[]).includes(market) && typeof slug === "string" && SLUG_OK.test(slug)) funnelGuides[market] = slug;
      else errors.push(`funnelGuides "${market}" was ignored (a market code, then a guide slug)`);
    }
  }

  return { settings: { raf, relatedSearches, maxAds, placements, ignoredPageParams, linkTerms, funnelGuides }, errors };
}

/** Is this placement switched on? `unknown` never is. */
export function placementEnabled(settings: TrafficSettings, placement: Placement): boolean {
  return placement !== "unknown" && settings.placements[placement] === true;
}
