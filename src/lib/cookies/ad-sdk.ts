// THE MID-SESSION HALF OF THE ADVERTISING GATE.
//
// lib/cookies/prepaint.ts decides on every page LOAD. This decides when the
// choice CHANGES while a page is already open - the banner and the preferences
// panel call it right after a save.
//
//   granted  -> tell Google's tags (Consent Mode v2 `update`), then load the
//               SDK now. Waiting for the next page load would throw away the
//               landing pageview, which on a content page is the only one most
//               visitors ever generate.
//   withdrawn-> tell Google's tags, and ask the caller to RELOAD. There is no
//               API for getting a running third-party script, its timers and
//               its iframes back out of a page. A reload through the pre-paint
//               gate - which will now refuse to load it - is the one honest way
//               to make "off" mean off for the page in front of the person.
//
// NO "use client" directive, for the same reason as client.ts: plain browser
// utilities, every access guarded.

import type { CookieConsent } from "./consent";
import { gpcSignal } from "./client";
import { AD_SDK_MARKER, AD_SDK_SRC } from "./prepaint";

type ConsentSignal = "granted" | "denied";

function pushConsentUpdate(ads: ConsentSignal, analytics: ConsentSignal): void {
  try {
    const w = window as unknown as { dataLayer?: unknown[] };
    w.dataLayer = w.dataLayer || [];
    const layer = w.dataLayer;
    // gtag's contract is the `arguments` OBJECT, not an array - a tag reading
    // the data layer ignores a plain array pushed here.
    (function gtag(..._args: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      layer.push(arguments);
    })("consent", "update", {
      ad_storage: ads,
      ad_user_data: ads,
      ad_personalization: ads,
      analytics_storage: analytics,
    });
  } catch {
    /* a dead window must never break a save */
  }
}

/** The publisher id, from the verification meta tag every page already carries
 *  - so this module needs no server config and cannot disagree with the
 *  layout about which account it is. */
function publisherOnPage(): string | null {
  try {
    const value = document.querySelector('meta[name="google-adsense-account"]')?.getAttribute("content") ?? "";
    return /^ca-pub-\d{10,20}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Bring the page in line with a choice that was just saved.
 *
 * `wasMarketing` is whether advertising was in force BEFORE the save - read it
 * before writing the new cookie. Returns what the caller must do next.
 */
export function syncAdConsent(consent: CookieConsent, wasMarketing: boolean): "loaded" | "reload" | "none" {
  if (typeof window === "undefined" || typeof document === "undefined") return "none";
  const adsOn = consent.grants.marketing === true && !gpcSignal();
  pushConsentUpdate(adsOn ? "granted" : "denied", consent.grants.analytics === true ? "granted" : "denied");

  if (!adsOn) return wasMarketing ? "reload" : "none";

  try {
    if (document.querySelector(`script[${AD_SDK_MARKER}]`)) return "none";
    const client = publisherOnPage();
    if (!client) return "none";
    const s = document.createElement("script");
    s.async = true;
    s.crossOrigin = "anonymous";
    s.setAttribute(AD_SDK_MARKER, "1");
    s.src = `${AD_SDK_SRC}?client=${client}`;
    document.head.appendChild(s);
    return "loaded";
  } catch {
    return "none";
  }
}
