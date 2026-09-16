import { createHmac } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { E2E_SESSION_SECRET } from "../../../playwright.config";
import { CONSENT_COOKIE, encodeCookieConsent, makeConsent } from "../../../src/lib/cookies/consent";

// Session minting, lifted from scripts/mobile-check.mjs:69-73 - the same
// base64url + HMAC shape src/lib/session.ts writes. A dedicated guard spec
// (auth-redirects) proves a cookie signed with the WRONG secret bounces, so
// this fixture cannot silently drift into forging something the server would
// never accept.

export function mintSessionCookie(email: string, secret: string = E2E_SESSION_SECRET): string {
  const b64 = Buffer.from(JSON.stringify({ email, issuedAt: Date.now() })).toString("base64url");
  const sig = createHmac("sha256", secret).update(b64).digest("hex");
  return `${b64}.${sig}`;
}

/**
 * An "essential only" cookie decision, encoded by the app's own encoder.
 *
 * THE SIBLING HARNESS (scripts/mobile-check.mjs) sets this and this fixture did
 * not, which is how the cookie-consent merge turned the whole browser suite
 * red without touching a spec: middleware.ts now sends a signed-in visitor
 * with no current decision to /cookies, so every signed-in journey that opened
 * a gated path (`/`, `/deals`, `/profile`, `/admin`) was measuring the cookie
 * policy page - and, with two CI retries at 40s per spec, ground on until the
 * job's 20-minute timeout cancelled it. mobile-check regex-reads the policy
 * version out of manifest.ts; this file can do better and call the real
 * `makeConsent`, so a policy bump can never leave it holding a stale record.
 *
 * "Essential only" BY DEFAULT, not "accept all": what a privacy-minded
 * traveller picks, and the product must lay out and behave identically either
 * way - so the default is the stricter choice and a spec that passes on
 * "accept all" but fails on this has found a real bug.
 *
 * The one thing that legitimately differs is MEMORY. `rememberLocal` refuses
 * to persist a preference (theme, list axis) the traveller has not consented
 * to keeping, and purges it on withdrawal; the visible change still lands, only
 * the memory of it is gated. A spec that asserts persistence across a reload
 * is therefore a spec about the `preferences` category and signs in with
 * `{ cookieChoice: "accept-all" }`, saying so. A spec that wants to observe the
 * gate itself passes `{ cookieChoice: false }` and gets no decision cookie.
 */
export type CookieChoice = "essential-only" | "accept-all" | false;

export function consentCookieFor(choice: Exclude<CookieChoice, false>): string {
  const all = choice === "accept-all";
  return encodeCookieConsent(
    makeConsent(
      { preferences: all, analytics: all, marketing: all },
      all ? "accept-all" : "reject-all"
    )
  );
}

/** Kept for callers that want the default spelled out. */
export function essentialOnlyCookie(): string {
  return consentCookieFor("essential-only");
}

/** Sign the context in as `email` (default: an ordinary traveller). */
export async function signIn(
  context: BrowserContext,
  email = "traveller@e2e.test",
  opts?: { secret?: string; cookieChoice?: CookieChoice }
): Promise<void> {
  const choice: CookieChoice = opts?.cookieChoice ?? "essential-only";
  await context.addCookies([
    {
      name: "wd_session",
      value: mintSessionCookie(email, opts?.secret),
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
    },
    ...(choice === false
      ? []
      : [
          {
            name: CONSENT_COOKIE,
            value: consentCookieFor(choice),
            domain: "127.0.0.1",
            path: "/",
          },
        ]),
  ]);
}

/**
 * Make /api/auth/me report a PAID plan for this page.
 *
 * W6.1 gated Trips to Pro/Ultra on both sides - the route ships a free plan no
 * history at all, and the tab renders upgrade tier cards - so a spec about the
 * hunt LIST has to say which plan it is describing. Signing in mints a session
 * cookie; the plan comes from the app_users row, which an e2e run has no way to
 * write, so it is stubbed at the one endpoint the page reads it from.
 */
export async function asPlan(
  page: import("@playwright/test").Page,
  plan: "free" | "pro" | "ultra",
  email = "traveller@e2e.test"
): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/auth/me",
    (route) => route.fulfill({ json: { session: { email, plan, role: "user" } } })
  );
}
