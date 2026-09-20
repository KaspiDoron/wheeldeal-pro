// TRAFFIC CHECK - the sponsored-search placements, in a real browser.
//
// cookie-gate-check.mjs proves the NEGATIVE promise (nothing loads without
// consent). This proves the positive half is CORRECT when it does load, which
// matters just as much: a related-search integration that makes two ad
// requests on one page, passes its own search terms, or shows ads beside zero
// results does not fail loudly - it gets the AdSense account struck weeks
// later. None of that is visible to a unit test, because all of it is what the
// page SENDS to Google at runtime.
//
// GOOGLE'S SCRIPT IS REPLACED WITH A RECORDER. Every request to ads.js is
// fulfilled with a stub that writes down exactly what `_googCsa` was called
// with, paints a fake unit into each container and fires adLoadedCallback. So
// this never touches Google, never produces an impression, and can assert on
// the precise options object - which the real script would swallow silently.
//
//   npm run build && npm run check:traffic
//
// NOT part of `npm test`: it needs a browser and a booted server.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const PORT = Number(process.env.TRAFFIC_CHECK_PORT || 3402);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.TRAFFIC_CHECK_SHOTS || "";
const GUIDE = "/guides/thailand-scooter-rental-prices";
const VIEWPORTS = [320, 375, 430];

const AFS_ENV = {
  TRAFFIC_MODE: "live",
  TRAFFIC_PARTNERS: "gcheck|afs|Check AFS|on|partner-pub-0000000000000000:1234567890:4455667788||1",
};
const LINK_ENV = {
  TRAFFIC_MODE: "live",
  TRAFFIC_PARTNERS: "lcheck|link|Check Link|on|https://feed.example.test/s?q={q}&subid={subid}&src=wd||0.8",
};

const RECORDER = `
(function () {
  var fn = window._googCsa, q = (fn && fn.q) || [];
  window.__csa = window.__csa || [];
  q.forEach(function (args) {
    var a = [].slice.call(args), blocks = a.slice(2);
    window.__csa.push({ kind: a[0], page: a[1], blocks: blocks.map(function (b) {
      var o = {}; for (var k in b) if (typeof b[k] !== "function") o[k] = b[k];
      o.__hasCallback = typeof b.adLoadedCallback === "function";
      o.__inDom = !!document.getElementById(b.container);
      return o;
    }) });
    blocks.forEach(function (b) {
      var el = document.getElementById(b.container);
      if (el) el.innerHTML = '<div style="height:140px;background:#ddd">mock google unit</div>';
      if (typeof b.adLoadedCallback === "function") b.adLoadedCallback(b.container, true, false, {});
    });
  });
})();`;

function encode(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function currentVersion() {
  const fs = await import("node:fs/promises");
  const m = (await fs.readFile("src/lib/cookies/manifest.ts", "utf8")).match(/COOKIE_POLICY_VERSION\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("COOKIE_POLICY_VERSION not found");
  return m[1];
}

async function boot(env) {
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, NODE_ENV: "production", SESSION_SECRET: "traffic-check-not-a-real-secret", ...env },
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/guides`, { redirect: "manual" });
      if (r.status > 0) return server;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  stop(server);
  throw new Error("the server never came up");
}

function stop(server) {
  if (!server?.pid) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    try {
      server.kill();
    } catch {}
  }
}

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail });

async function open(browser, path, { consent, width = 390, timezoneId = "Asia/Bangkok" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, timezoneId });
  if (consent) await ctx.addCookies([{ name: "wd_cookie_prefs", value: consent, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const state = { adsJs: 0, beacons: [], dialogs: 0, errors: [] };
  page.on("dialog", (d) => {
    state.dialogs++;
    void d.dismiss();
  });
  page.on("pageerror", (e) => state.errors.push(String(e)));
  await page.route("**/adsense/search/ads.js", (r) => {
    state.adsJs++;
    return r.fulfill({ contentType: "application/javascript", body: RECORDER });
  });
  await page.route("**googlesyndication.com**", (r) => r.abort());
  page.on("request", (r) => {
    if (r.url().includes("/api/traffic/event")) state.beacons.push(r.postDataJSON?.() ?? null);
  });
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_400);
  return { ctx, page, state };
}

const overflow = (page) =>
  page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));

async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** The placement in context: the 500px of article above it, and what follows.
 *  A guide is ~4,600px tall, so a full-page shot makes the one part under
 *  review illegible. */
async function shotPlacement(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  const box = await page.locator("[data-traffic-placement]").first().boundingBox().catch(() => null);
  if (!box) return;
  const width = page.viewportSize()?.width ?? 390;
  const y = Math.max(0, box.y - 500);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, clip: { x: 0, y, width, height: box.height + 900 } });
}

async function afsSuite(browser, YES, NO) {
  // ---- a guide, consented ---------------------------------------------------
  {
    const { ctx, page, state } = await open(browser, GUIDE, { consent: YES });
    const csa = await page.evaluate(() => window.__csa || []);
    ok("guide · exactly ONE ad request in the document", csa.length === 1 && state.adsJs === 1, `calls=${csa.length} script=${state.adsJs}`);
    const c = csa[0] ?? { page: {}, blocks: [] };
    ok("guide · it is a related-search request", c.kind === "relatedsearch", c.kind);
    ok("guide · targeted at the CONTENT, with no query", c.page.relatedSearchTargeting === "content" && !("query" in c.page));
    // Supplying our own terms is a Restricted Access Feature this account lacks.
    ok("guide · NO publisher-supplied terms", !("terms" in c.page), JSON.stringify(Object.keys(c.page)));
    ok("guide · pubId is the short form the tag takes", c.page.pubId === "pub-0000000000000000", c.page.pubId);
    ok("guide · the channel is the owner's AdSense channel, not a sub-id", c.page.channel === "4455667788", String(c.page.channel));
    ok("guide · results go to our own /search", String(c.page.resultsPageBaseUrl).startsWith(`${BASE}/search?`), c.page.resultsPageBaseUrl);
    ok("guide · live mode sends no adtest flag", !("adtest" in c.page));
    ok("guide · no undefined / empty option leaked through", Object.values(c.page).every((v) => v !== undefined && v !== null && v !== ""));
    ok("guide · exactly ONE related-search unit, max 5 suggestions", c.blocks.length === 1 && c.blocks[0].relatedSearches === 5, JSON.stringify(c.blocks));
    ok("guide · its container existed in the DOM when requested", c.blocks[0]?.__inDom === true);
    ok("guide · the unit's heading and disclosure appear once it fills",
      (await page.getByRole("heading", { name: "Related searches" }).isVisible().catch(() => false)) &&
        (await page.getByText(/WheelDeal may earn money/).isVisible().catch(() => false)));
    // The unit comes AFTER the article: "complementary, not the focus".
    const order = await page.evaluate(() => {
      const unit = document.querySelector("[data-traffic-placement]");
      const lastSection = [...document.querySelectorAll("main section")].find((s) => s.textContent?.includes("Common questions"));
      return unit && lastSection ? Boolean(lastSection.compareDocumentPosition(unit) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
    });
    ok("guide · the unit sits after the article body", order === true, String(order));
    const b = state.beacons[0];
    ok("guide · one first-party beacon: unit_loaded", state.beacons.length === 1 && b?.kind === "unit_loaded", JSON.stringify(state.beacons));
    ok("guide · the beacon carries only closed-vocabulary fields",
      b && Object.keys(b).sort().join(",") === "category,kind,market,partner,placement,session" && /^[0-9a-f]{8}$/.test(b.session) && b.market === "th" && b.category === "scooter",
      JSON.stringify(b));
    ok("guide · no page errors", state.errors.length === 0, state.errors[0]);

    // ---- guide -> related guide: a REAL page load, so one request each -------
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator('main a[href^="/guides/"]').last().click()]);
    await page.waitForTimeout(2_000);
    const second = await page.evaluate(() => (window.__csa || []).length);
    ok("guide -> guide · the next document makes its OWN single request", second === 1, `calls in new document=${second}`);
    await ctx.close();
  }

  // ---- layout, with the unit filled ------------------------------------------
  for (const width of VIEWPORTS) {
    const { ctx, page } = await open(browser, GUIDE, { consent: YES, width });
    const o = await overflow(page);
    ok(`guide · ${width}px: no horizontal overflow with the unit filled`, o.doc <= o.win, `${o.doc} <= ${o.win}`);
    await shot(page, `guide-${width}`);
    if (width === 375) await shotPlacement(page, "placement-google");
    await ctx.close();
  }

  // ---- /search: real results, ads capped by them -----------------------------
  {
    const q = "thailand scooter rental price";
    const { ctx, page, state } = await open(browser, `/search?q=${encodeURIComponent(q)}&m=th&c=scooter&afdToken=abc123`, { consent: YES });
    const hits = await page.locator('main ol a[href^="/guides/"]').count();
    ok("search · real organic results are rendered", hits > 0, `${hits} results`);
    const csa = await page.evaluate(() => window.__csa || []);
    ok("search · exactly ONE ad request", csa.length === 1, `calls=${csa.length}`);
    const c = csa[0] ?? { page: {}, blocks: [] };
    ok("search · the query is the exact, unencoded term", c.kind === "ads" && c.page.query === q, c.page.query);
    ok("search · targeted at the QUERY", c.page.relatedSearchTargeting === "query");
    const adBlock = c.blocks.find((b) => "number" in b);
    const rsBlocks = c.blocks.filter((b) => "relatedSearches" in b);
    ok("search · ads never outnumber results", adBlock && adBlock.number <= hits && adBlock.number <= 3, `ads=${adBlock?.number} results=${hits}`);
    ok("search · maxTop is set (the block sits above the results)", adBlock?.maxTop === adBlock?.number);
    ok("search · exactly one related-search unit", rsBlocks.length === 1);
    ok("search · every container existed in the DOM when requested", c.blocks.every((b) => b.__inDom), JSON.stringify(c.blocks.map((b) => [b.container, b.__inDom])));
    ok("search · the box is NOT pre-filled with the query", (await page.locator('input[name="q"]').inputValue()) === "");
    const view = state.beacons.find((b) => b?.kind === "serp_view");
    ok("search · serp_view carries the term ONLY because Google's token was present", view?.term === q && view?.termFromUnit === true, JSON.stringify(view));
    ok("search · the page is noindex", (await page.locator('meta[name="robots"]').getAttribute("content"))?.includes("noindex"));
    await shot(page, "search-results");
    await ctx.close();
  }
  {
    // TYPED, not clicked: no Google token, so the words must not leave the page.
    const { ctx, state } = await open(browser, `/search?q=${encodeURIComponent("john smith scooter rental")}`, { consent: YES });
    const view = state.beacons.find((b) => b?.kind === "serp_view");
    ok("search · a TYPED query is never sent in the beacon", view && !("term" in view) && view.termFromUnit === false, JSON.stringify(view));
    await ctx.close();
  }
  {
    const { ctx, page, state } = await open(browser, `/search?q=${encodeURIComponent("cheap flights to new york")}`, { consent: YES });
    const csa = await page.evaluate(() => window.__csa || []);
    ok("search · ZERO results means ZERO ad requests", csa.length === 0 && state.adsJs === 0, `calls=${csa.length} script=${state.adsJs}`);
    ok("search · and says so honestly", await page.getByText("Nothing in the guides matches that").isVisible().catch(() => false));
    await ctx.close();
  }
  {
    const payload = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
    const { ctx, page, state } = await open(browser, `/search?q=${encodeURIComponent(payload)}`, { consent: YES });
    const injected = await page.evaluate(() => document.querySelectorAll("main img, main script:not([type])").length);
    ok("search · a hostile query is rendered as text, never as markup", state.dialogs === 0 && injected === 0, `dialogs=${state.dialogs} nodes=${injected}`);
    await ctx.close();
  }
  for (const width of VIEWPORTS) {
    const { ctx, page } = await open(browser, `/search?q=scooter%20rental%20deposit`, { consent: YES, width });
    const o = await overflow(page);
    ok(`search · ${width}px: no horizontal overflow`, o.doc <= o.win, `${o.doc} <= ${o.win}`);
    const font = await page.locator('input[name="q"]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    ok(`search · ${width}px: the input is >= 16px (no iOS zoom)`, font >= 16, `${font}px`);
    await ctx.close();
  }

  // ---- and with a NO, none of it ----------------------------------------------
  {
    const { ctx, page, state } = await open(browser, `/search?q=scooter%20rental`, { consent: NO });
    const csa = await page.evaluate(() => window.__csa || []);
    ok("search · reject-all: results still render", (await page.locator('main ol a[href^="/guides/"]').count()) > 0);
    ok("search · reject-all: no ad request and no beacon", csa.length === 0 && state.adsJs === 0 && state.beacons.length === 0, `calls=${csa.length} beacons=${state.beacons.length}`);
    await ctx.close();
  }
}

async function linkSuite(browser, YES) {
  const { ctx, page, state } = await open(browser, GUIDE, { consent: YES });
  const links = page.locator('[data-traffic-placement] a[href^="/api/traffic/go"]');
  const n = await links.count();
  ok("link partner · labelled sponsored links render", n === 3 && (await page.getByText("Sponsored", { exact: true }).isVisible().catch(() => false)), `links=${n}`);
  ok("link partner · Google's script is never requested", state.adsJs === 0);
  const rel = await links.first().getAttribute("rel");
  ok("link partner · rel says sponsored + nofollow", rel?.includes("sponsored") && rel.includes("nofollow"), rel);
  const href = await links.first().getAttribute("href");
  ok("link partner · the link carries an INDEX, never the search words", /[?&]i=0(&|$)/.test(href ?? "") && !/[?&]q=/.test(href ?? ""), href);
  const o = await overflow(page);
  ok("link partner · no horizontal overflow", o.doc <= o.win);
  await shot(page, "guide-link-partner");
  await shotPlacement(page, "placement-link");

  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const go = await fetch(`${BASE}${href}`, { redirect: "manual", headers: { cookie } });
  const loc = go.headers.get("location") ?? "";
  ok("go · redirects to the OWNER-configured host", go.status === 302 && new URL(loc).host === "feed.example.test", `${go.status} ${loc}`);
  ok("go · with a term this app generated and a sub-id it built",
    new URL(loc).searchParams.get("q") === "scooter rental Thailand" && /^p1-mth-cscooter-[0-9a-f]{8}$/.test(new URL(loc).searchParams.get("subid") ?? ""), loc);
  ok("go · the redirect is noindex", (go.headers.get("x-robots-tag") ?? "").includes("noindex"));

  const evil = await fetch(`${BASE}/api/traffic/go?p=guide-inline&m=th&c=scooter&i=0&s=9a3f01bc&q=x&next=https://evil.example&url=https://evil.example`, { redirect: "manual", headers: { cookie } });
  ok("go · extra parameters cannot steer it elsewhere", new URL(evil.headers.get("location") ?? BASE).host === "feed.example.test", evil.headers.get("location"));
  const badIndex = await fetch(`${BASE}/api/traffic/go?p=guide-inline&m=th&c=scooter&i=99&s=9a3f01bc`, { redirect: "manual", headers: { cookie } });
  // The Location must be RELATIVE: an absolute one built from req.url names the
  // server's internal host behind a proxy (this check caught exactly that).
  ok("go · an out-of-range term index goes home, not to the partner", badIndex.status === 303 && badIndex.headers.get("location") === "/guides", `${badIndex.status} ${badIndex.headers.get("location")}`);
  const noConsent = await fetch(`${BASE}${href}`, { redirect: "manual" });
  ok("go · WITHOUT a consent cookie it refuses to leave the site", noConsent.status === 303 && noConsent.headers.get("location") === "/cookies", `${noConsent.status} ${noConsent.headers.get("location")}`);
  await ctx.close();
}

async function run() {
  if (!existsSync(".next")) {
    console.error("No .next build found. Run `npm run build` first.");
    process.exit(2);
  }
  const version = await currentVersion();
  const YES = encode({ v: version, t: Date.now(), s: "accept-all", g: { preferences: true, analytics: true, marketing: true } });
  const NO = encode({ v: version, t: Date.now(), s: "reject-all", g: { preferences: false, analytics: false, marketing: false } });

  let server = null;
  let browser = null;
  try {
    browser = await chromium.launch();
    console.log("Booting with a Google in-page partner ...");
    server = await boot(AFS_ENV);
    await afsSuite(browser, YES, NO);
    stop(server);
    await new Promise((r) => setTimeout(r, 1_500));
    console.log("Booting with a link partner ...");
    server = await boot(LINK_ENV);
    await linkSuite(browser, YES);
  } finally {
    await browser?.close().catch(() => undefined);
    stop(server);
  }

  console.log("");
  for (const r of results) console.log(`  ${r.pass ? "ok  " : "FAIL"}  ${r.name}${r.detail ? ` - ${r.detail}` : ""}`);
  const failed = results.filter((r) => !r.pass);
  console.log("");
  if (failed.length) {
    console.error(`${failed.length} traffic check(s) FAILED.`);
    process.exit(1);
  }
  console.log(`All ${results.length} traffic checks passed.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
