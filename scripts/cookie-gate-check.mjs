// COOKIE GATE CHECK - the one that actually watches the network.
//
// WHY THIS EXISTS, AND WHY THE UNIT TESTS ARE NOT ENOUGH.
//
// The central promise of the cookie layer is negative: "we do not load Google's
// ad script unless you allow it". A negative promise about a THIRD-PARTY
// REQUEST cannot be proven by a unit test, and cookies.test.ts is honest about
// what it does instead - it greps src/app/layout.tsx and asserts the source
// text looks right. That is a proxy, and every way the gate can really fail
// slips straight past it:
//
//   - the inline script throws on a browser's real `document.cookie` (a stray
//     cookie with an `=` in its value, a base64 pad the hand-rolled decoder
//     gets wrong) and the tag is never injected AT ALL, so consenting users see
//     no ads and the revenue quietly goes to zero;
//   - or it throws the other way and injects unconditionally;
//   - or Next inlines the string somewhere the browser never executes;
//   - or a later refactor moves the cookie name and the grep still passes
//     because both copies moved together.
//
// So this boots the real production build, drives real Chromium, and COUNTS
// REQUESTS TO GOOGLE'S AD HOSTS - the display SDK on /welcome, and the search-
// ads script on a real guide - under each cookie state, region and GPC signal. It is the same
// discipline as scripts/mobile-check.mjs, applied to the one behaviour in this
// app that is a promise to a regulator rather than to a user's eyes.
//
// PROVEN TO GO RED, not merely written. Falsified against the pre-gate markup:
// restoring the unconditional <script async src="...adsbygoogle.js"> in the
// layout's <head> makes the first two cases report
//
//   FAIL  no cookie (never asked)            expected 0 ad requests, saw 1
//   FAIL  reject-all                         expected 0 ad requests, saw 1
//
// while the accept-all case still passes - which is exactly the asymmetry that
// matters, and exactly what a source-grep cannot see.
//
// NOT part of `npm test`: it needs a browser and a booted server.
//
//   npm run build && npm run check:cookies
//
// Chromium comes from PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers in CI images);
// set COOKIE_CHECK_CHROMIUM to point elsewhere. Set COOKIE_CHECK_URL to test an
// already-running server instead of booting one.

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const PORT = Number(process.env.COOKIE_CHECK_PORT || 3401);
const SESSION_SECRET = "cookie-gate-check-secret-not-a-real-one";
const BASE = process.env.COOKIE_CHECK_URL || `http://127.0.0.1:${PORT}`;
// The host the fixture cookies are planted for. This was the literal
// "127.0.0.1", which made every cookie case against a REMOTE target (the live
// site, via COOKIE_CHECK_URL) silently run with no cookie at all - the browser
// never sends a 127.0.0.1 cookie to wheeldeal.pro - and the report read as
// "nine failures" that were all the script's own.
const COOKIE_HOST = new URL(BASE).hostname;
const REMOTE = Boolean(process.env.COOKIE_CHECK_URL);
const AD_HOST = "googlesyndication.com";

// THE SECOND GOOGLE PRODUCT. Sponsored search (lib/traffic) loads a DIFFERENT
// script from a different host - google.com/adsense/search/ads.js, rendering
// through syndicatedsearch.goog - and only on content pages. A check that
// watched googlesyndication.com on /welcome alone would have reported "no ad
// requests without consent" while a guide page fetched Google's search script
// for every visitor. The same promise, so the same proof.
const SEARCH_AD_MARKERS = ["google.com/adsense/search", "syndicatedsearch.goog", "adsensecustomsearchads.com"];
const GUIDE_PATH = "/guides/thailand-scooter-rental-prices";
// A syntactically valid, obviously fake AFS partner, in TEST mode - Google's
// `adtest: on`, which can never count an impression. The requests are aborted
// before they leave anyway; what is measured is whether the browser TRIED.
const TRAFFIC_ENV = {
  TRAFFIC_MODE: "test",
  TRAFFIC_PARTNERS: "gatecheck|afs|Gate check|on|pub-0000000000000000:1234567890||1",
};
const isSearchAd = (url) => SEARCH_AD_MARKERS.some((m) => url.includes(m));

// The cookie VALUES are built here with the same encoding lib/cookies/consent
// uses, rather than pasted as literals: a fixture that drifts from the encoder
// would turn every case into "unparseable", which reads as reject-all, which
// would make this check pass for the wrong reason forever.
function encode(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// THE POLICY VERSION THE TARGET ENFORCES. Asked of the server itself
// (/api/cookies/consent returns it), because that is the only version that
// matters: a fixture built from the LOCAL manifest against a remote target that
// runs an older policy is a stale-version fixture, and every "accept" case
// then measures the re-prompt instead of the grant. The manifest is the
// fallback for a server that cannot answer.
async function currentVersion() {
  try {
    const res = await fetch(`${BASE}/api/cookies/consent`, { cache: "no-store" });
    const d = await res.json();
    if (typeof d?.version === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.version)) return d.version;
  } catch {
    /* fall through to the source */
  }
  const src = await import("node:fs/promises").then((fs) => fs.readFile("src/lib/cookies/manifest.ts", "utf8"));
  const m = src.match(/COOKIE_POLICY_VERSION\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("COOKIE_POLICY_VERSION not found in manifest.ts");
  return m[1];
}

/** A session cookie, minted exactly as src/lib/session.ts does. */
const SESSION_COOKIE = (() => {
  const b64 = Buffer.from(
    JSON.stringify({ email: "gate-check@example.test", issuedAt: Date.now(), firstIssuedAt: Date.now() })
  ).toString("base64url");
  return `${b64}.${createHmac("sha256", SESSION_SECRET).update(b64).digest("hex")}`;
})();

function chromiumPath() {
  if (process.env.COOKIE_CHECK_CHROMIUM) return process.env.COOKIE_CHECK_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(`${root}/chromium`)) return `${root}/chromium`;
  return undefined;
}

async function portIsBusy(url) {
  try {
    await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status > 0) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function stopServer(server) {
  if (!server?.pid) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    try {
      server.kill();
    } catch {
      /* nothing left to stop */
    }
  }
}

/**
 * Load /welcome with a given consent cookie and report what happened.
 *
 * Requests to Google are ABORTED rather than allowed out: this check must not
 * depend on the sandbox having egress, and what is being measured is whether
 * the browser TRIED - which `page.on("request")` sees before the route handler
 * runs.
 */
async function visit(browser, cookie, opts = {}) {
  const { path = "/welcome", timezoneId = "Asia/Bangkok", gpc = false } = opts;
  // The time zone is what the sponsored-search unit reads to decide whether
  // Google will serve at all (lib/traffic/region.ts), so it is part of the
  // fixture rather than whatever the CI box happens to be set to.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId });
  if (gpc) {
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    });
    await ctx.setExtraHTTPHeaders({ "Sec-GPC": "1" });
  }
  if (cookie) {
    await ctx.addCookies([
      { name: "wd_cookie_prefs", value: cookie, domain: COOKIE_HOST, path: "/" },
    ]);
  }
  const page = await ctx.newPage();
  const adRequests = [];
  const searchRequests = [];
  page.on("request", (r) => {
    if (r.url().includes(AD_HOST)) adRequests.push(r.url());
    if (isSearchAd(r.url())) searchRequests.push(r.url());
  });
  await page.route(`**${AD_HOST}**`, (r) => r.abort());
  await page.route((url) => isSearchAd(url.href), (r) => r.abort());

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  // The banner mounts on a 400ms timer; give the injected script time too. A
  // guide also has a config round trip before its unit may request anything.
  // A remote target adds a real network round trip to /api/cookies/consent
  // before the banner can know whether to show, so it gets longer.
  await page.waitForTimeout(REMOTE ? 5_000 : path === "/welcome" ? 1_600 : 2_600);

  const banner = await page
    .getByRole("region", { name: /cookie choices/i })
    .isVisible()
    .catch(() => false);

  await ctx.close();
  return { adRequests: adRequests.length, searchRequests: searchRequests.length, banner, errors };
}

/**
 * Ask the MIDDLEWARE, and nothing else, what it does with a signed-in request
 * to a gated path.
 *
 * A raw fetch with `redirect: "manual"`, not a browser navigation. The two are
 * not equivalent: following the redirect chain in a browser also runs the page,
 * which has its own reasons to bounce (the beta allowlist sends an unknown
 * account to /login), and a check that reports "landed on /login" cannot say
 * whether the cookie gate opened or the app simply refused for another reason.
 * The Location header on the FIRST response is the middleware's decision, alone.
 *
 * The session is signed with the same secret the server is booted with - the
 * middleware only checks presence today, but a real cookie keeps this honest if
 * that ever tightens.
 */
async function middlewareVerdict(consentCookie) {
  const jar = [`wd_session=${SESSION_COOKIE}`];
  if (consentCookie) jar.push(`wd_cookie_prefs=${consentCookie}`);
  const res = await fetch(`${BASE}/profile`, {
    redirect: "manual",
    headers: { cookie: jar.join("; ") },
  });
  const location = res.headers.get("location");
  if (!location) return { held: false, to: `${res.status} (no redirect - the app rendered)` };
  const to = new URL(location, BASE);
  return {
    held: to.pathname === "/cookies",
    to: `${to.pathname}${to.search}`,
  };
}

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

async function run() {
  let server = null;
  if (!process.env.COOKIE_CHECK_URL) {
    if (!existsSync(".next")) {
      console.error("No .next build found. Run `npm run build` first.");
      process.exit(2);
    }
    if (await portIsBusy(BASE)) {
      console.error(
        `Something is already listening on :${PORT}. This check would silently measure\n` +
          `THAT server's build instead of the one you just built.\n` +
          `Stop it first, or point COOKIE_CHECK_PORT somewhere free.`
      );
      process.exit(2);
    }
    console.log(`Booting the production build on :${PORT} ...`);
    server = spawn("npx", ["next", "start", "-p", String(PORT)], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, NODE_ENV: "production", SESSION_SECRET, ...TRAFFIC_ENV },
    });
    if (!(await waitForServer(BASE))) {
      stopServer(server);
      console.error("The server never came up.");
      process.exit(2);
    }
  }

  const version = await currentVersion();
  const at = Date.now();
  const COOKIES = {
    denyAll: encode({
      v: version,
      t: at,
      s: "reject-all",
      g: { preferences: false, analytics: false, marketing: false },
    }),
    allowAll: encode({
      v: version,
      t: at,
      s: "accept-all",
      g: { preferences: true, analytics: true, marketing: true },
    }),
    staleYes: encode({
      v: "1999-01-01",
      t: at,
      s: "accept-all",
      g: { preferences: true, analytics: true, marketing: true },
    }),
    corrupt: "not-a-real-consent-value",
  };

  // LAUNCHED INSIDE THE TRY. It used to sit one line above it, so a launch
  // failure (no Chromium installed - the first thing that happens on a fresh
  // laptop) threw past the `finally` and left the server this script booted
  // running on the port forever. The next run then refused to start because
  // "something is already listening", and blamed the wrong thing.
  let browser = null;
  try {
    browser = await chromium.launch({ executablePath: chromiumPath() });
    // 1. NEVER ASKED. The case that decides whether this feature is worth
    //    anything: a first-time visitor must cost Google nothing.
    const fresh = await visit(browser, null);
    ok("no cookie: no ad request", fresh.adRequests === 0, `saw ${fresh.adRequests}`);
    ok("no cookie: the banner appears", fresh.banner === true);
    ok("no cookie: no page errors", fresh.errors.length === 0, fresh.errors[0]);

    // 2. REJECTED. The promise itself.
    const rejected = await visit(browser, COOKIES.denyAll);
    ok("reject-all: no ad request", rejected.adRequests === 0, `saw ${rejected.adRequests}`);
    ok("reject-all: the banner stays down", rejected.banner === false);

    // 3. ACCEPTED. The gate must not be a permanent off switch - a check that
    //    only ever asserts "no ads" passes just as well with the feature
    //    removed and the revenue gone.
    const accepted = await visit(browser, COOKIES.allowAll);
    ok("accept-all: the SDK IS requested", accepted.adRequests > 0, `saw ${accepted.adRequests}`);
    ok("accept-all: the banner stays down", accepted.banner === false);

    // 4. STALE POLICY VERSION. Re-asks, but the last word still stands while
    //    the re-prompt is up - in both directions.
    const stale = await visit(browser, COOKIES.staleYes);
    ok("stale version: re-asks", stale.banner === true);
    ok("stale version: the old YES is still honoured", stale.adRequests > 0, `saw ${stale.adRequests}`);

    // 5. CORRUPT. The decoder must fail closed, not throw and not allow.
    const corrupt = await visit(browser, COOKIES.corrupt);
    ok("corrupt cookie: no ad request", corrupt.adRequests === 0, `saw ${corrupt.adRequests}`);
    ok("corrupt cookie: re-asks", corrupt.banner === true);
    ok("corrupt cookie: no page errors", corrupt.errors.length === 0, corrupt.errors[0]);

    // 5b. SPONSORED SEARCH, on a real guide. Same promise, second product.
    const guideFresh = await visit(browser, null, { path: GUIDE_PATH });
    ok("guide · no cookie: no search-ads request", guideFresh.searchRequests === 0, `saw ${guideFresh.searchRequests}`);
    ok("guide · no cookie: no display-ads request", guideFresh.adRequests === 0, `saw ${guideFresh.adRequests}`);
    ok("guide · no cookie: no page errors", guideFresh.errors.length === 0, guideFresh.errors[0]);

    const guideRejected = await visit(browser, COOKIES.denyAll, { path: GUIDE_PATH });
    ok("guide · reject-all: no search-ads request", guideRejected.searchRequests === 0, `saw ${guideRejected.searchRequests}`);

    // Accepting must actually TURN IT ON, or the feature is a permanent zero.
    // Only provable against the server this script booted, where the partner
    // config is known; an external COOKIE_CHECK_URL has whatever it has.
    if (!process.env.COOKIE_CHECK_URL) {
      const guideAccepted = await visit(browser, COOKIES.allowAll, { path: GUIDE_PATH });
      ok("guide · accept-all, outside the TCF regions: the search script IS requested", guideAccepted.searchRequests > 0, `saw ${guideAccepted.searchRequests}`);
      ok("guide · accept-all: no page errors", guideAccepted.errors.length === 0, guideAccepted.errors[0]);

      // Google serves no search ads in the EEA/UK/CH without a certified CMP,
      // and none is installed - so a consenting visitor in Berlin must cost
      // Google nothing either. Consent is necessary here, not sufficient.
      const guideBerlin = await visit(browser, COOKIES.allowAll, { path: GUIDE_PATH, timezoneId: "Europe/Berlin" });
      ok("guide · accept-all, in a TCF region with no certified CMP: no search-ads request", guideBerlin.searchRequests === 0, `saw ${guideBerlin.searchRequests}`);
    }

    // A YES TO DISPLAY ADS IS NOT A YES TO SPONSORED SEARCH. Case 4 above pins
    // that a stale-version yes is still honoured for the display SDK while the
    // re-prompt is up - their last word stands. Sponsored search arrived WITH
    // the newer policy, so that same old yes was never a yes to it: the search
    // script must NOT load until they have answered the banner describing it.
    const guideStale = await visit(browser, COOKIES.staleYes, { path: GUIDE_PATH });
    ok("guide · stale-version yes: NO search-ads request (never asked about it)", guideStale.searchRequests === 0, `saw ${guideStale.searchRequests}`);
    ok("guide · stale-version yes: the display SDK is still honoured", guideStale.adRequests > 0, `saw ${guideStale.adRequests}`);
    ok("guide · stale-version yes: and the banner re-asks", guideStale.banner === true);

    // A Global Privacy Control signal beats a stored yes - for BOTH products.
    const guideGpc = await visit(browser, COOKIES.allowAll, { path: GUIDE_PATH, gpc: true });
    ok("guide · accept-all + GPC: no search-ads request", guideGpc.searchRequests === 0, `saw ${guideGpc.searchRequests}`);
    ok("guide · accept-all + GPC: no display-ads request", guideGpc.adRequests === 0, `saw ${guideGpc.adRequests}`);

    // 6. THE MANDATORY-ESSENTIALS GATE, end to end through real middleware.
    //
    // A signed-in request to a gated path with no decision must land on
    // /cookies; the same request WITH a decision must not. Both directions
    // matter: a gate that never opens is as broken as one that never closes,
    // and the "essential only" case is the one that proves this is a condition
    // of service rather than a cookie wall.
    for (const [label, cookie, expectHeld] of [
      ["no decision", null, true],
      ["essential only", COOKIES.denyAll, false],
      ["accept all", COOKIES.allowAll, false],
      ["stale policy version", COOKIES.staleYes, true],
      ["corrupt record", COOKIES.corrupt, true],
    ]) {
      const verdict = await middlewareVerdict(cookie);
      ok(
        `gate · ${label}: ${expectHeld ? "held" : "passed"}`,
        verdict.held === expectHeld,
        verdict.to
      );
    }
    // The redirect carries the required flag AND where they were going, so the
    // screen can send them back rather than dumping them on the home page.
    const held = await middlewareVerdict(null);
    ok(
      "gate · the redirect asks for a decision and remembers the destination",
      held.to.includes("required=1") && held.to.includes("next=%2Fprofile"),
      held.to
    );
  } finally {
    await browser?.close().catch(() => undefined);
    stopServer(server);
  }

  console.log("");
  for (const r of results) {
    console.log(`  ${r.pass ? "ok  " : "FAIL"}  ${r.name}${r.detail ? ` - ${r.detail}` : ""}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log("");
  if (failed.length) {
    console.error(`${failed.length} cookie gate check(s) FAILED.`);
    process.exit(1);
  }
  console.log("All cookie gate checks passed.");
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
