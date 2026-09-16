import "server-only";

// THE SERVER SIDE OF THE CHOICE.
//
// Two jobs, and they are not the same job:
//
//   1. READ the choice on a request, so server code can refuse to do something
//      the traveller declined. `analyticsAllowed` is the one that matters -
//      the funnel projection writes a row per stage transition, and a person
//      who turned analytics off must stop generating rows on the SERVER too,
//      not only in the browser. A cookie banner that governs only the browser
//      is theatre.
//
//   2. WRITE the choice durably, twice. The cookie is what the app reads on
//      every later request; the `consent_events` ledger row is what proves the
//      choice was made, when, against which policy version, and through which
//      button - the same ledger every other consent in this product lands in,
//      for the same reason (see lib/consent.ts).
//
// The two halves fail independently and are reported independently. A ledger
// that is down must not stop a person rejecting cookies - refusing to record a
// "no" and therefore not applying it is the worst of both worlds - so the
// cookie is written regardless and the route tells the caller, honestly, that
// the durable record did not land. That is the house rule for writes here:
// report what PERSISTED, never optimistic success.

import { cookies } from "next/headers";
import { recordConsent, resetConsentCache, type ConsentKind } from "../consent";
import {
  ANALYTICS_COOKIE,
  CONSENT_COOKIE,
  CONSENT_MAX_AGE,
  allows,
  decodeCookieConsent,
  type CookieConsent,
  type CookieGrants,
} from "./consent";
import { COOKIE_POLICY_VERSION, type CookieCategory } from "./manifest";

/**
 * The ledger kind each optional category records against.
 *
 * `analytics` is NOT a new kind, and that is the important line here. The
 * product already had an `analytics` opt-in purpose (Profile -> Your data),
 * governing the server-side funnel projection. Giving the cookie banner its own
 * second "analytics" switch would have produced two controls with one name,
 * disagreeing - and the person's honest question ("is WheelDeal recording how I
 * use it?") would have had two answers. One purpose, two doors: the banner and
 * the profile toggle read and write the SAME consent.
 */
export const CATEGORY_CONSENT_KIND: Record<Exclude<CookieCategory, "necessary">, ConsentKind> = {
  preferences: "cookies_preferences",
  analytics: "analytics",
  marketing: "cookies_marketing",
};

/** The choice on THIS request, or null when there is none. */
export function readCookieConsent(): CookieConsent | null {
  try {
    return decodeCookieConsent(cookies().get(CONSENT_COOKIE)?.value);
  } catch {
    // Read-only render contexts can throw on cookies(). No record readable =
    // no consent, which is the safe direction.
    return null;
  }
}

/** Is this category granted on this request? Defaults to no. */
function serverAllows(category: CookieCategory): boolean {
  return allows(readCookieConsent(), category);
}

/**
 * The anonymous analytics id on this request, or null.
 *
 * Only ever returned while analytics is actually granted. The cookie could
 * survive a withdrawal in a browser that ignored the delete (or a request in
 * flight during the change), and an id read out in that window would stamp
 * rows on somebody who had just said no.
 */
export function readAnalyticsId(): string | null {
  if (!serverAllows("analytics")) return null;
  try {
    const raw = cookies().get(ANALYTICS_COOKIE)?.value ?? "";
    // Bounded and character-checked: this value reaches a database column and
    // arrives from a client that can put anything in a cookie.
    return /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Put the choice on the response. Not HttpOnly - the pre-paint script has to
 *  read it before React exists, which is what stops the ad script loading in
 *  the frames before the banner mounts. */
export function setConsentCookie(encoded: string): void {
  cookies().set(CONSENT_COOKIE, encoded, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: CONSENT_MAX_AGE,
  });
}

/** Mint or clear the anonymous analytics id to match the choice. Returns the
 *  id now in force, or null. */
export function syncAnalyticsCookie(grants: CookieGrants, existing: string | null): string | null {
  if (!grants.analytics) {
    try {
      cookies().delete(ANALYTICS_COOKIE);
    } catch {}
    return null;
  }
  const id = existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing) ? existing : newAnalyticsId();
  cookies().set(ANALYTICS_COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: CONSENT_MAX_AGE,
  });
  return id;
}

/**
 * Drop both first-party cookies this module owns.
 *
 * Called on erasure. The consent record is deleted along with the choice it
 * recorded - which sounds like it would re-prompt an erased person, and it
 * does, correctly: they are a new visitor now, and the right thing for a new
 * visitor is to be asked rather than to inherit the preferences of an account
 * that no longer exists.
 */
export function clearCookieConsentCookies(): void {
  for (const name of [CONSENT_COOKIE, ANALYTICS_COOKIE]) {
    try {
      cookies().delete(name);
    } catch {
      /* best-effort: never fail an erasure on a cookie write */
    }
  }
}

/**
 * A fresh analytics id: 128 random bits, base64url, and NOTHING derived from
 * the person. Not a hash of their email, not a fingerprint of their device -
 * either would make the id a pseudonym that survives sign-out, which is a
 * different and much larger promise than "count this visit as one visit".
 */
function newAnalyticsId(): string {
  const bytes = new Uint8Array(16);
  // Web Crypto is present in every runtime this ships on (Node 18+, the Edge
  // runtime, browsers). The fallback is only reached in an exotic test shim.
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Write the ledger rows for a signed-in person's choice - one per optional
 * category, each carrying the policy version and how the choice was made.
 *
 * ONE ROW PER CATEGORY, always, including the ones that did not change. A
 * ledger of deltas cannot answer "what was this person's marketing consent on
 * the 3rd of March" without replaying every row before it, and that is the only
 * question a consent ledger is ever asked. Rows are cheap; a reconstruction
 * argument in front of a regulator is not.
 *
 * Returns whether EVERY row landed. Partial is reported as false - a caller
 * that says "saved" over a half-written ledger is making the exact claim this
 * module exists to stop.
 */
export async function recordCookieConsent(
  email: string,
  consent: CookieConsent
): Promise<boolean> {
  const who = String(email ?? "").trim().toLowerCase();
  if (!who) return false;
  const results = await Promise.all(
    (Object.keys(CATEGORY_CONSENT_KIND) as (keyof typeof CATEGORY_CONSENT_KIND)[]).map((category) =>
      recordConsent({
        email: who,
        kind: CATEGORY_CONSENT_KIND[category],
        version: COOKIE_POLICY_VERSION,
        granted: consent.grants[category] === true,
        context: { source: "cookie-banner", choice: consent.source, category },
      }).catch(() => false)
    )
  );
  // The ledger is what `consentFor` reads, and it caches for a minute. A
  // withdrawal that keeps being honoured as a grant for another 60 seconds is
  // the difference between "off" and "off shortly", so drop the cache here.
  resetConsentCache();
  return results.every(Boolean);
}

/**
 * MAY WE RECORD BEHAVIOUR FOR THIS PERSON, ON THIS REQUEST?
 *
 * Both gates, and both must pass:
 *
 *   - the ledger (`consentFor(email, "analytics")`), which is durable, follows
 *     the account across devices, and is what a DSAR answer is written from;
 *   - the cookie on THIS device, which is what the person actually clicked on
 *     the screen in front of them.
 *
 * They can disagree honestly - a second phone that has never seen the banner
 * carries no cookie while the account says yes - and when they do, the answer
 * is no. Requiring both means a traveller can stop collection from the device
 * in their hand without hunting for an account setting, which is the situation
 * the banner exists for.
 *
 * Signed-out callers have no ledger to consult and get the cookie alone.
 *
 * REQUEST-SCOPED ONLY. This is for collection that happens while the traveller
 * is on the other end of an HTTP request - the browser beacon. The funnel
 * projection (`projectProductEvent`) deliberately does NOT use it: stage
 * transitions fire from webhooks, cron drains and worker paths where there is
 * no traveller and therefore no cookie, and reading "no cookie" as "no consent"
 * there would silently kill the very collection the ledger row authorises. That
 * path is ledger-gated, which is the account-level authority, and the banner
 * writes that same ledger row - so rejecting analytics in the banner still
 * stops the server-side funnel record for a signed-in person.
 */
export async function analyticsAllowed(email?: string | null): Promise<boolean> {
  if (!serverAllows("analytics")) return false;
  const who = String(email ?? "").trim().toLowerCase();
  if (!who) return true;
  try {
    const { consentFor } = await import("../consent");
    return await consentFor(who, "analytics");
  } catch {
    return false;
  }
}
