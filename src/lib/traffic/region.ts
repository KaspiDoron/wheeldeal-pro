// WHICH CONSENT REGIME IS THIS VISITOR UNDER - and therefore whether Google's
// search ads may be requested for them at all.
//
// This app's cookie banner is a real consent mechanism, and it is NOT a
// Google-certified CMP. For most of the world that distinction does not matter.
// For visitors in the EEA, the UK and Switzerland it decides everything:
// Google's search-ads products read an IAB TCF consent string from a certified
// CMP, and Google's own help centre says that without one they "will not serve
// any ads". A hand-built banner cannot mint that string however good its
// consent is.
//
// So there are two honest options and no third: install a certified CMP, or do
// not request search ads in those regions. This module implements the second
// as the DEFAULT and leaves a switch for the first (`TRAFFIC_TCF_CMP=google`,
// once Google's own free "Privacy and messaging" CMP is published from the
// AdSense account). What it never does is request ads that cannot serve from a
// visitor whose consent Google cannot read - that earns nothing and is the kind
// of misconfiguration that costs the account.
//
// NO "server-only": the unit decides in the browser, where the time zone is.

/** 27 EU member states + Iceland, Liechtenstein, Norway (EEA) + UK + CH. */
export const TCF_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO",
  "GB", "CH",
]);

/**
 * Time zones outside `Europe/` that are nonetheless EU territory, where the
 * same rules apply: Spain's and Portugal's Atlantic islands, Iceland, the
 * Faroes, Svalbard, Cyprus, and France's overseas departments.
 */
const TCF_ZONES_OUTSIDE_EUROPE: ReadonlySet<string> = new Set([
  "Atlantic/Canary", "Atlantic/Madeira", "Atlantic/Azores", "Atlantic/Reykjavik", "Atlantic/Faroe",
  "Arctic/Longyearbyen", "Asia/Nicosia", "Asia/Famagusta",
  "Indian/Reunion", "Indian/Mayotte", "America/Cayenne", "America/Guadeloupe", "America/Martinique", "America/Marigot",
]);

export type ConsentRegion = "tcf" | "other" | "unknown";

/** Which certified CMP is installed, if any. Set by the owner, never inferred. */
export type TcfCmp = "none" | "google";

/**
 * A country code from the edge wins when there is one. Cloud Run supplies
 * none, so the usual input is the browser's IANA time zone - which is about
 * where the visitor IS rather than where they are from, and that is what the
 * rule turns on.
 *
 * EVERY `Europe/*` zone counts, including ones outside the EEA (Istanbul,
 * Belgrade, Moscow). Over-including costs a little revenue in a few countries;
 * under-including means requesting ads without a TC string inside the EEA. The
 * two mistakes are not the same size.
 */
export function consentRegion(input: { country?: string | null; timeZone?: string | null }): ConsentRegion {
  const country = String(input.country ?? "").trim().toUpperCase();
  // XX, T1 and friends are edge placeholders for "could not resolve".
  if (/^[A-Z]{2}$/.test(country) && country !== "XX" && country !== "ZZ") {
    return TCF_COUNTRIES.has(country) ? "tcf" : "other";
  }
  const zone = String(input.timeZone ?? "").trim();
  if (!/^[A-Za-z_]+\/[A-Za-z_+\-/0-9]+$/.test(zone)) return "unknown";
  if (zone.startsWith("Europe/") || TCF_ZONES_OUTSIDE_EUROPE.has(zone)) return "tcf";
  const area = zone.split("/")[0];
  const known = ["Africa", "America", "Antarctica", "Arctic", "Asia", "Atlantic", "Australia", "Indian", "Pacific"];
  return known.includes(area) ? "other" : "unknown";
}

/** `unknown` is handled as `tcf`: a visitor who cannot be placed gets the
 *  stricter rule, never the convenient one. */
export function searchAdsPermitted(region: ConsentRegion, cmp: TcfCmp): boolean {
  if (region === "other") return true;
  return cmp === "google";
}

/** The browser's IANA zone, or null where Intl is unavailable. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
