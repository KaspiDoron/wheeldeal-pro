// WHICH AD CREATIVES THIS SITE MAY DECLARE TO GOOGLE.
//
// When a visitor reaches a guide from a paid source the owner controls, Google
// requires the ad's creative text to be passed verbatim as `referrerAdCreative`
// (mandatory since 2025-11-01), and an INACCURATE one is a named strike
// category. The landing URL carries the text as `?rac=...`.
//
// The first version forwarded whatever `rac` the URL held. That is an open door:
// anyone can link to a guide with `?rac=<anything>`, and this site would then
// declare that text to Google as its own ad. A competitor could earn the account
// a strike with a hyperlink.
//
// So a creative is forwarded only if the OWNER declared it, in the Key Vault
// (`TRAFFIC_AD_CREATIVES`, one per line). The match runs on the server and
// returns only the matched text, so the list is never handed to a browser
// wholesale. No list configured - the normal case for organic traffic - means
// `rac` is ignored entirely.
//
// Pure, no I/O: config.ts reads the vault and hands the lines here.

export const CREATIVE_MAX_LENGTH = 300;

const normalise = (text: string) => String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

/** The vault value into a clean list. Blank lines and `#` comments are dropped. */
export function parseCreatives(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const line of String(raw ?? "").split("\n")) {
    const text = normalise(line);
    if (!text || text.startsWith("#") || text.length > CREATIVE_MAX_LENGTH) continue;
    seen.add(text);
  }
  return [...seen];
}

/**
 * The owner's creative that `candidate` IS, or null.
 *
 * Exact after whitespace normalisation, and case-sensitive on purpose: Google
 * asks for the text verbatim, so "close enough" is precisely the inaccuracy the
 * policy punishes. What is returned is the OWNER'S string, never the caller's -
 * so even a match cannot smuggle a variant through.
 */
export function matchCreative(allowed: readonly string[], candidate: string | null | undefined): string | null {
  const text = normalise(candidate ?? "");
  if (!text || text.length > CREATIVE_MAX_LENGTH) return null;
  return allowed.find((a) => a === text) ?? null;
}
