// THE COOKIE CHOICE ITSELF: one value, encoded once, read identically on both
// sides of the wire.
//
// Isomorphic on purpose. The pre-paint script reads it from `document.cookie`
// before React exists, the banner reads it on mount, the API route writes it,
// and the AdSense gate reads it server-side. Four readers of one format is
// three chances to disagree, so the format lives here and nowhere else - and
// every one of them calls `decodeCookieConsent`.
//
// NOT SIGNED, AND THAT IS DELIBERATE. `wd_session` is HMAC-signed because
// forging it grants access. Forging this one grants a person... their own
// preference, on their own device. Signing it would buy nothing and cost the
// pre-paint read (an HMAC needs the server secret), and a pre-paint read is
// exactly what stops the ad script loading before the banner has mounted.
//
// THE DEFAULT IS NO. Every path that cannot produce a positive, current,
// parseable record answers "denied" for all three optional categories:
// absent, corrupt, truncated, from an older policy version, or from a browser
// that blocked the write. "We could not read it" is not consent.

import {
  COOKIE_POLICY_VERSION,
  OPTIONAL_CATEGORIES,
  type CookieCategory,
} from "./manifest";

/** The cookie the choice lives in. Declared in the manifest as `necessary`. */
export const CONSENT_COOKIE = "wd_cookie_prefs";

/** The analytics id cookie, set only while `analytics` is granted. */
export const ANALYTICS_COOKIE = "wd_aid";

/** 180 days. Long enough not to nag, short enough that a stale choice expires
 *  rather than following someone around for years (ICO/CNIL guidance). */
export const CONSENT_MAX_AGE = 60 * 60 * 24 * 180;

/** Which optional categories are granted. `necessary` is not in here - it is
 *  not a decision, and modelling it as one invites code that can switch it off. */
export type CookieGrants = Record<Exclude<CookieCategory, "necessary">, boolean>;

export interface CookieConsent {
  /** The policy version the person actually saw when they chose. */
  version: string;
  /** When they chose, epoch ms. */
  at: number;
  grants: CookieGrants;
  /** How the choice was made - proof of what the UI offered at the time. */
  source: "accept-all" | "reject-all" | "custom";
}

/** Everything off. The answer to every question this module cannot answer. */
export const DENY_ALL: CookieGrants = { preferences: false, analytics: false, marketing: false };
export const ALLOW_ALL: CookieGrants = { preferences: true, analytics: true, marketing: true };

/** Coerce anything into a complete, boolean-valued grant set. Unknown keys are
 *  dropped and missing ones default to false, so a hand-edited cookie widens
 *  nothing. */
export function normalizeGrants(input: unknown): CookieGrants {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out = { ...DENY_ALL };
  for (const c of OPTIONAL_CATEGORIES) {
    out[c as keyof CookieGrants] = raw[c] === true;
  }
  return out;
}

/** The cookie value: base64url JSON. Short keys because it rides on every
 *  request and a cookie budget is real. */
export function encodeCookieConsent(consent: CookieConsent): string {
  const payload = JSON.stringify({
    v: consent.version,
    t: Math.round(consent.at),
    s: consent.source,
    g: consent.grants,
  });
  // Buffer is not in the browser and btoa is not guaranteed in every server
  // runtime, so both are tried. TextEncoder (everywhere since Node 11) keeps a
  // non-ASCII byte from reaching btoa, which throws on one. base64URL at the
  // end so the value needs no cookie escaping and survives every proxy intact.
  const b64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(payload, "utf8").toString("base64")
      : btoa(String.fromCharCode(...new TextEncoder().encode(payload)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Read a cookie value back. Returns null for anything that is not a complete,
 * current, parseable record - see the default-is-no note at the top.
 *
 * A record from an OLDER policy version decodes fine and is returned with its
 * version intact; it is `needsCookieChoice` that decides it must be re-asked.
 * Keeping the two separate matters: the old grants still gate behaviour while
 * the banner is up, so a person who said no to advertising last version does
 * not get Google's script loaded in the seconds before they answer again.
 */
export function decodeCookieConsent(value: string | null | undefined): CookieConsent | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json =
      typeof Buffer !== "undefined"
        ? Buffer.from(pad, "base64").toString("utf8")
        : new TextDecoder().decode(
            Uint8Array.from(atob(pad), (ch) => ch.charCodeAt(0))
          );
    const parsed = JSON.parse(json) as {
      v?: unknown;
      t?: unknown;
      s?: unknown;
      g?: unknown;
    };
    const version = String(parsed.v ?? "");
    const at = Number(parsed.t);
    if (!version || !Number.isFinite(at) || at <= 0) return null;
    const source =
      parsed.s === "accept-all" || parsed.s === "reject-all" || parsed.s === "custom"
        ? parsed.s
        : "custom";
    return { version, at: at, source, grants: normalizeGrants(parsed.g) };
  } catch {
    return null;
  }
}

/**
 * Must the banner be shown?
 *
 * TRUE when there is no record, when the record cannot be read, and when it was
 * made against an older policy version - the last one is what makes a version
 * bump mean something rather than being a number in a file.
 */
export function needsCookieChoice(
  consent: CookieConsent | null | undefined,
  current: string = COOKIE_POLICY_VERSION
): boolean {
  if (!consent) return true;
  return consent.version !== current;
}

/**
 * Is this category allowed right now? THE one question the rest of the app
 * asks. `necessary` is always true; everything else defaults to false.
 */
export function allows(
  consent: CookieConsent | null | undefined,
  category: CookieCategory
): boolean {
  if (category === "necessary") return true;
  if (!consent) return false;
  return consent.grants[category] === true;
}

/** Build a complete record for a choice being made now. */
export function makeConsent(
  grants: CookieGrants,
  source: CookieConsent["source"],
  now: number = Date.now()
): CookieConsent {
  return { version: COOKIE_POLICY_VERSION, at: now, source, grants: normalizeGrants(grants) };
}

/**
 * Every optional category this record does NOT grant - what the purge deletes.
 *
 * Deliberately "not granted" rather than "just withdrawn". Withdrawing
 * `preferences` has to delete the keys already sitting on the device, not
 * merely stop writing new ones - a person who turns something off and watches
 * the value survive has been told no twice. Phrasing it as the full denied set
 * makes the purge idempotent, so it also cleans up after a write that failed
 * halfway, or after a key that was stored before this system existed.
 */
export function deniedCategories(
  consent: CookieConsent | null | undefined
): CookieCategory[] {
  return OPTIONAL_CATEGORIES.filter((c) => !allows(consent, c));
}

/** Parse a whole `Cookie:` header (or `document.cookie`) for one name. Written
 *  here so the pre-paint script, the client and the server all split it the
 *  same way - including the case where the value itself contains `=`. */
export function cookieValueFrom(header: string | null | undefined, name: string): string | null {
  const raw = String(header ?? "");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    return trimmed.slice(eq + 1);
  }
  return null;
}
