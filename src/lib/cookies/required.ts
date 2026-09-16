// ESSENTIAL COOKIES ARE A CONDITION OF USING THE APP - and this is where that
// is DECIDED, once, for the middleware and the UI both.
//
// The distinction that makes this lawful rather than a cookie wall:
//
//   ESSENTIAL cookies are not optional and never were. `wd_session` is how the
//   app knows who you are; without it there is no signed-in product to deliver,
//   so "use the app without it" is not a state that exists. `wd_cookie_prefs`
//   is where a refusal is written down; without it every page would have to ask
//   again. Both are strictly necessary in the ePrivacy sense - exempt from
//   consent, required for a service the user requested.
//
//   EVERY OTHER CATEGORY STAYS GENUINELY OPTIONAL. Preferences, analytics and
//   advertising are all still off by default and "Essential only" is a
//   first-class, one-tap answer that gets you the whole product. That is the
//   line between a lawful condition of service and an unlawful cookie wall: we
//   require the acknowledgement, never the tracking.
//
// So what is mandatory is MAKING A DECISION, not making a particular one. The
// gate below asks only "has this person answered, against the current policy" -
// and a person who answered "essential only" passes it exactly as readily as
// one who accepted everything. A test pins that.
//
// PURE, AND EDGE-SAFE. `middleware.ts` runs on the Edge runtime and enforces
// this before a gated page is ever rendered; the `/cookies` screen renders the
// same predicate. Two copies of a rule this load-bearing would drift, so there
// is one, it takes a raw cookie header, and it imports nothing that needs Node.

import { CONSENT_COOKIE, cookieValueFrom, decodeCookieConsent, needsCookieChoice } from "./consent";

/**
 * The routes the app itself lives on - the ones the gate covers.
 *
 * Deliberately NOT the public surface. /welcome, /login, /pricing, /guides,
 * /terms, /privacy and /cookies stay reachable with no decision made, because a
 * person must be able to read what they are agreeing to BEFORE agreeing to it,
 * and because a marketing page that demands a cookie decision before it will
 * describe the product is the cookie wall this is careful not to be.
 *
 * Kept in step with `middleware.ts`'s matcher by a test.
 */
export const COOKIE_GATED_PATHS = ["/", "/deals", "/profile", "/admin"] as const;

/** Where an ungated person is sent to decide. Public, outside the matcher (so
 *  it can never loop), and the full policy is on the same screen. */
export const COOKIE_GATE_PATH = "/cookies";

/** Is this a path the gate covers? Exact match only - the matcher is exact. */
export function isCookieGatedPath(pathname: string): boolean {
  return (COOKIE_GATED_PATHS as readonly string[]).includes(pathname);
}

/**
 * May this request proceed into the app?
 *
 * TRUE once a current, readable decision exists, whatever that decision was.
 * FALSE when there is none, when it cannot be parsed, and when it was made
 * against a superseded policy version - the last one is what makes a policy
 * bump reach people who never open a settings screen.
 */
export function hasEssentialAcknowledgement(cookieHeader: string | null | undefined): boolean {
  const consent = decodeCookieConsent(cookieValueFrom(cookieHeader, CONSENT_COOKIE));
  return !needsCookieChoice(consent);
}

/**
 * The redirect target for a blocked request, carrying where they were going.
 *
 * `next` is validated on the way back OUT (see the /cookies screen): a return
 * path that came from a URL is attacker-controlled, and an open redirect on the
 * one screen everybody is forced through would be a gift.
 */
export function cookieGateRedirect(pathname: string): string {
  const next = safeNext(pathname);
  return `${COOKIE_GATE_PATH}?required=1${next ? `&next=${encodeURIComponent(next)}` : ""}`;
}

/**
 * Narrow a `next` parameter to a path this app actually serves.
 *
 * Only the gated paths themselves are allowed back. That is stricter than
 * "starts with a single slash" on purpose: `//evil.example` and
 * `/\evil.example` are both read as protocol-relative URLs by some browsers,
 * and the allow-list closes the whole class rather than the two spellings
 * somebody remembered.
 */
export function safeNext(next: string | null | undefined): string | null {
  const raw = String(next ?? "").trim();
  if (!raw) return null;
  return (COOKIE_GATED_PATHS as readonly string[]).includes(raw) ? raw : null;
}
