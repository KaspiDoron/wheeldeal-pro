import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { CONSENT_COOKIE, encodeCookieConsent, makeConsent } from "./consent";
import { hasEssentialAcknowledgement, isCookieGatedPath } from "./required";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// THE BROWSER SUITE MUST CLEAR THE COOKIE GATE, AND A TEST HAS TO SAY SO.
//
// The cookie-consent merge added a middleware gate (a signed-in visitor with no
// current decision is sent to /cookies) and updated scripts/mobile-check.mjs to
// set the decision cookie - but not tests/e2e/fixtures/session.ts, the fixture
// sixteen Playwright specs sign in through. Every signed-in journey that opened
// a gated path was then measuring the cookie policy page; with two CI retries
// at 40s per spec the suite ground on until the job's 20-minute timeout
// CANCELLED it, which is neither red nor green, so nothing named the cause and
// master stopped deploying. This file makes the next such drift a unit failure
// with the fixture's name on it.

describe("the e2e session fixture clears the cookie gate", () => {
  it("the payload the fixture builds passes the SAME predicate the middleware runs", () => {
    // Executed against the real encoder and the real gate: if the policy
    // version bumps, makeConsent stamps the new one and this still passes; if
    // the gate's idea of "answered" ever changes, this is what fails.
    const value = encodeCookieConsent(
      makeConsent({ preferences: false, analytics: false, marketing: false }, "reject-all")
    );
    expect(hasEssentialAcknowledgement(`${CONSENT_COOKIE}=${value}`)).toBe(true);
    // ...and the gate is real: no cookie, no entry.
    expect(hasEssentialAcknowledgement(null)).toBe(false);
    expect(hasEssentialAcknowledgement("wd_session=abc")).toBe(false);
  });

  it("signIn() sets the decision cookie through the app's own encoder, not a pasted literal", () => {
    const fixture = read("tests/e2e/fixtures/session.ts");
    expect(fixture).toMatch(/from "\.\.\/\.\.\/\.\.\/src\/lib\/cookies\/consent"/);
    expect(fixture).toMatch(/name: CONSENT_COOKIE/);
    expect(fixture).toMatch(/makeConsent\(/);
    expect(fixture).toMatch(/encodeCookieConsent\(/);
    // A regex over manifest.ts (what mobile-check does) would be the second
    // copy of the format this module's header says must not exist.
    expect(fixture).not.toMatch(/COOKIE_POLICY_VERSION\\s\*=/);
  });

  it("the root the specs open is a gated path, so the fixture is load-bearing", () => {
    // If "/" ever leaves the gate this pin is moot and should be deleted with
    // it; while it is gated, a fixture without the cookie measures /cookies.
    expect(isCookieGatedPath("/")).toBe(true);
  });

  it("a spec can still opt OUT to observe the gate itself", () => {
    expect(read("tests/e2e/fixtures/session.ts")).toMatch(/choice === false/);
  });

  it("the default is the STRICTER choice, and only persistence specs widen it", () => {
    // The product must behave identically under "essential only" except for
    // MEMORY of a preference, which rememberLocal gates on the `preferences`
    // category. So the default stays essential-only, and exactly the specs
    // that assert persistence across a reload say "accept-all" - anything else
    // widening it would be hiding a layout or behaviour difference the default
    // exists to catch.
    expect(read("tests/e2e/fixtures/session.ts")).toMatch(/\?\? "essential-only"/);
    const widened = ["horizontal-rail", "theme-toggle"];
    for (const name of widened) {
      expect(read(`tests/e2e/${name}.spec.ts`), name).toMatch(/cookieChoice: "accept-all"/);
    }
  });
});
