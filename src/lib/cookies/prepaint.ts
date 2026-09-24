// THE ADVERTISING GATE, AND WHY IT RUNS BEFORE PAINT.
//
// Google's ad SDK sets Google's cookies the moment it loads - before any ad is
// requested and whether or not a slot ever renders. So consent cannot be
// checked in a React effect: by the time a component mounts, a script tag in
// <head> has already been fetched and the cookies are already set. The only
// place the decision can be made is a synchronous inline script that runs
// before the browser reaches anything else. The root layout inlines the string
// this module builds.
//
// IT LIVES HERE, NOT IN THE LAYOUT, SO IT CAN BE EXECUTED BY A TEST. As a
// string literal inside layout.tsx the only thing a test could do was grep it.
// prepaint.test.ts runs it in a sandbox and pins what it does.
//
// THREE THINGS HAPPEN, IN THIS ORDER, AND THE ORDER IS THE POINT:
//
//   1. Consent Mode v2 `default`, all four signals DENIED. Unconditionally and
//      first, above every early return - so any Google tag that ever loads on
//      this page, by any route, starts from "no". A default that is only set on
//      the happy path is not a default.
//   2. The stored choice is decoded and the matching `update` is pushed.
//   3. Only with advertising granted - and no Global Privacy Control signal -
//      is the SDK injected.
//
// GLOBAL PRIVACY CONTROL BEATS A STORED YES. GPC is a legally recognised
// opt-out of sale and sharing in a growing list of US states, and Google
// itself treats it as restricted processing. A "yes" recorded months ago does
// not outrank a browser saying "no" on this very page load. It is an
// ADVERTISING signal, so first-party analytics consent is left alone.
//
// THIS DOES NOT BREAK ADSENSE REVIEW. Site ownership is verified by
// <meta name="google-adsense-account">, which the layout emits on every page,
// unconditionally. Loading the SDK for a visitor who has not consented is, in
// the EEA and the UK, a breach of Google's own EU user consent policy - so the
// gate is not a trade against monetisation, it is the condition of it.
//
// The parse is a hand-rolled copy of decodeCookieConsent because this runs
// before any module loads and cannot import one. It fails closed: any throw,
// any missing field, anything other than marketing === true, and no script is
// added. prepaint.test.ts runs it against the real encoder so the two cannot
// drift.
//
// A STALE POLICY VERSION STILL COUNTS. The version is not checked here, on
// purpose: a bump re-asks (the banner appears on this very load), and until the
// person answers, their last word stands in BOTH directions. Silently revoking
// a yes misrepresents their choice exactly as much as silently honouring a no
// would - and the re-prompt is already on screen.
//
// NO "server-only" and no imports: the layout (server) builds the string, and
// lib/cookies/ad-sdk.ts (browser) shares the marker.

/** Stamped on the injected <script>, so the mid-session loader in ad-sdk.ts
 *  can tell the SDK is already on the page. Loading it twice is an AdSense
 *  policy violation and makes slots fail to fill. */
export const AD_SDK_MARKER = "data-wd-ad-sdk";

export const AD_SDK_SRC = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";

export function buildAdConsentScript(publisher: string): string {
  // The publisher id is a build-time constant, but it is interpolated into
  // executable script - so it is held to its own format rather than trusted.
  const client = /^ca-pub-\d{10,20}$/.test(publisher) ? publisher : "";
  return `
(function () {
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  gtag("consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" });
  try {
    var m = document.cookie.match(/(?:^|;\\s*)wd_cookie_prefs=([^;]*)/);
    if (!m) return;
    var b = m[1].replace(/-/g, "+").replace(/_/g, "/");
    b += "====".slice((b.length % 4) || 4);
    var d = JSON.parse(atob(b));
    if (!d || !d.g) return;
    if (d.g.analytics === true) gtag("consent", "update", { analytics_storage: "granted" });
    if (navigator.globalPrivacyControl === true) return;
    if (!d || !d.g || d.g.marketing !== true) return;
    gtag("consent", "update", { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" });
    if (!"${client}") return;
    var s = document.createElement("script");
    s.async = true;
    s.crossOrigin = "anonymous";
    s.setAttribute("${AD_SDK_MARKER}", "1");
    s.src = "${AD_SDK_SRC}?client=${client}";
    document.head.appendChild(s);
  } catch (e) {}
})();
`;
}
