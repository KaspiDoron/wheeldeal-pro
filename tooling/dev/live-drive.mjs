// THE LIVE DRIVE: a visible browser walks the whole product, end to end.
//
//   ./tooling/dev/local-db.sh && npm run dev:sim      (in one terminal)
//   npm run drive                                    (in another)
//
// A real Chromium window opens on your screen and USES the app the way a
// traveller does: answers the cookie banner, signs in, sets a hotel, describes
// a rental, runs the search against the real geocoder and shop discovery,
// messages the shops (which the simulator answers, in character), walks the
// sponsored-search funnel from a dead end into a guide and on to /search,
// then reads the owner's screens. Every step is a tap on the real UI; the two
// places an API is called directly are marked, with the reason.
//
// It is a DRIVE, not a test suite: it reports what it saw and keeps going,
// because the point is to watch the product behave with real services behind
// it (OpenStreetMap geocoding, Google's real search-ads script in test mode),
// not to fail fast on the first surprise. Screenshots land in
// DRIVE_SHOTS (default: ./test-results/drive).
//
// Set DRIVE_HEADLESS=1 to run it without a window (CI, or a laptop you are
// not looking at). DRIVE_CITY picks the stay; the default is chosen for a
// market whose shops are OPEN right now, because the anti-ban guard holds
// cold messages until the recipient's business hours - which is correct, and
// makes for a very quiet demo at night.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.env.DRIVE_APP_URL || "http://127.0.0.1:3000";
const SIM = process.env.DRIVE_SIM_URL || "http://127.0.0.1:8788";
const SHOTS = process.env.DRIVE_SHOTS || "test-results/drive";
const HEADLESS = process.env.DRIVE_HEADLESS === "1";

function openMarketNow() {
  const hour = (tz) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date()));
  const candidates = [
    { tz: "Asia/Bangkok", city: "Chiang Mai, Thailand", region: "Chiang Mai, Thailand" },
    { tz: "Europe/Lisbon", city: "Lisbon, Portugal", region: "Lisbon, Portugal" },
    { tz: "America/Mexico_City", city: "Playa del Carmen, Mexico", region: "Playa del Carmen, Mexico" },
    { tz: "Asia/Bangkok", city: "Chiang Mai, Thailand", region: "Chiang Mai, Thailand" },
  ];
  return candidates.find((c) => hour(c.tz) >= 9 && hour(c.tz) <= 19) ?? candidates[0];
}

const seen = [];
const say = (line) => {
  seen.push(line);
  console.log(`  ${line}`);
};
let shotN = 0;
async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  const file = `${SHOTS}/${String(++shotN).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

/** A best-effort step: a surprise is reported, never fatal. */
async function step(name, fn) {
  try {
    const note = await fn();
    say(`ok    ${name}${note ? ` - ${note}` : ""}`);
  } catch (e) {
    say(`MISS  ${name} - ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`);
  }
}

async function run() {
  const city = process.env.DRIVE_CITY ? { city: process.env.DRIVE_CITY, region: process.env.DRIVE_CITY } : openMarketNow();
  console.log(`Live drive against ${BASE} (${HEADLESS ? "headless" : "watch the window"}), stay: ${city.city}\n`);

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 0 : 120 });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, timezoneId: "Asia/Bangkok", locale: "en-GB" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
  const googleRequests = [];
  page.on("request", (r) => {
    const u = r.url();
    if (/adsense\/search\/ads\.js|googlesyndication|syndicatedsearch|adsensecustomsearchads/.test(u)) googleRequests.push(u.slice(0, 90));
  });

  // ---- 1. the front door, as a stranger --------------------------------------
  await step("welcome page loads, the cookie banner asks", async () => {
    await page.goto(`${BASE}/welcome`, { waitUntil: "domcontentloaded" });
    const banner = page.getByRole("region", { name: /cookie choices/i });
    await banner.waitFor({ timeout: 15_000 });
    await shot(page, "welcome-banner");
    return `Google requests before consent: ${googleRequests.length}`;
  });
  await step("tap Accept all - display ads and sponsored search consented", async () => {
    await page.getByRole("region", { name: /cookie choices/i }).getByRole("button", { name: /^accept all$/i }).click();
    await page.waitForTimeout(1_500);
    return `Google's display SDK requested after consent: ${googleRequests.some((u) => u.includes("googlesyndication")) ? "yes" : "no"}`;
  });

  // ---- 2. sign in --------------------------------------------------------------
  await step("sign in as the owner (dev login - the one API call, there is no password to type locally)", async () => {
    const res = await page.request.post(`${BASE}/api/auth/dev`, { data: { persona: "owner" } });
    if (!res.ok()) throw new Error(`dev login ${res.status()} - is ENABLE_DEV_LOGIN set in .env.local?`);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    // Any first-run gate that stands in the way is answered through its own UI.
    for (let i = 0; i < 3; i++) {
      const gate = page.getByRole("button", { name: /I agree|I accept|Accept and continue|Got it|Let's go|Continue/i }).first();
      if (await gate.isVisible().catch(() => false)) {
        const box = page.locator('input[type="checkbox"]:visible').first();
        if (await box.isVisible().catch(() => false)) await box.check().catch(() => {});
        await gate.click().catch(() => {});
        await page.waitForTimeout(800);
      } else break;
    }
    await page.locator('[data-tour="request"]').waitFor({ timeout: 20_000 });
    await shot(page, "home-signed-in");
  });

  // ---- 3. a search, with the real geocoder and real shop discovery ---------
  await step(`set the stay: "${city.city}" (real OpenStreetMap geocoding)`, async () => {
    const box = page.getByPlaceholder(/Search hotel, address or area/i).first();
    await box.click();
    await box.fill(city.city);
    const suggestion = page.locator(".absolute.top-full button").first();
    await suggestion.waitFor({ timeout: 20_000 });
    const label = (await suggestion.innerText()).split("\n")[0];
    await suggestion.click();
    return label.slice(0, 60);
  });
  await step("describe the rental and run the search", async () => {
    const req = page.locator('[data-tour="request"]');
    await req.click();
    await req.fill("automatic scooter for 7 days from tomorrow, pickup");
    const consent = page.locator('[data-tour="find"]').locator("xpath=preceding::input[@type='checkbox'][1]");
    if (await consent.isVisible().catch(() => false)) await consent.check().catch(() => {});
    const find = page.locator('[data-tour="find"]');
    await find.click();
    await shot(page, "search-running");
    // Either shops, or the honest dead end - both are product states worth seeing.
    await Promise.race([
      page.locator('[data-tour="vendors"]').waitFor({ timeout: 90_000 }),
      page.getByText(/No rental shops found near your stay/i).waitFor({ timeout: 90_000 }),
    ]);
    await page.waitForTimeout(1_000);
    await shot(page, "search-result");
    const empty = await page.getByText(/No rental shops found near your stay/i).isVisible().catch(() => false);
    const count = empty ? 0 : await page.locator('[data-tour="vendors"] [id^="vendor-"]').count();
    return empty ? "no shops in radius - the funnel card should be on screen" : `${count} shops found (real discovery)`;
  });

  // ---- 4a. the dead end IS the funnel ----------------------------------------
  await step("dead end: the funnel card offers the price guide for this market + a guides search", async () => {
    const card = page.locator("[data-funnel-card]");
    if (!(await card.isVisible().catch(() => false))) return "not a dead end this time (shops were found) - see 4b";
    await card.scrollIntoViewIfNeeded();
    await shot(page, "funnel-card");
    const guide = card.locator('a[href^="/guides/"]').first();
    const title = await guide.innerText();
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), guide.click()]);
    await page.waitForTimeout(3_500);
    await page.locator("[data-traffic-placement]").first().scrollIntoViewIfNeeded().catch(() => {});
    await shot(page, "guide-from-funnel");
    return `opened "${title.replace(" →", "").slice(0, 50)}"; Google search-ads script requested: ${googleRequests.some((u) => u.includes("adsense/search")) ? "yes" : "no (module off)"}`;
  });

  // ---- 4b. the negotiation, against simulated shops ------------------------
  await step("message the best shops (the simulator answers in character)", async () => {
    if (!page.url().endsWith("/")) await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const cta = page.getByRole("button", { name: /Message the best shops/i }).first();
    if (!(await cta.isVisible().catch(() => false))) return "no shops to message on this run";
    await cta.click();
    for (let i = 0; i < 2; i++) {
      const wa = page.getByRole("button", { name: /Connect my WhatsApp|I understand|Continue|Send/i }).first();
      if (await wa.isVisible().catch(() => false)) {
        const box = page.locator('input[type="checkbox"]:visible').first();
        if (await box.isVisible().catch(() => false)) await box.check().catch(() => {});
        await wa.click().catch(() => {});
        await page.waitForTimeout(1_000);
      }
    }
    await page.waitForTimeout(4_000);
    await shot(page, "outreach-started");
    const status = page.locator('[data-tour="status"]');
    await status.waitFor({ timeout: 30_000 });
    return (await status.innerText()).replace(/\s+/g, " ").slice(0, 120);
  });
  await step("wait for the shops to answer and the agents to bargain (up to 3 min)", async () => {
    const started = Date.now();
    let last = "";
    while (Date.now() - started < 180_000) {
      const sla = await fetch(`${SIM}/sim/sla`).then((r) => r.json()).catch(() => null);
      const threads = await fetch(`${SIM}/sim/threads`).then((r) => r.json()).catch(() => []);
      const rows = Array.isArray(threads) ? threads : threads?.threads ?? [];
      const quoted = rows.filter((t) => t.lastQuote != null);
      last = `${sla?.samples ?? 0} replies measured, ${quoted.length}/${rows.length} shops quoted`;
      if ((sla?.samples ?? 0) >= 4) break;
      await page.waitForTimeout(10_000);
    }
    await page.locator('[data-tour="status"]').scrollIntoViewIfNeeded().catch(() => {});
    await shot(page, "negotiation-live");
    const sla = await fetch(`${SIM}/sim/sla`).then((r) => r.json()).catch(() => null);
    return `${last}; shop-to-reply p50 ${sla?.p50Ms ? Math.round(sla.p50Ms / 1000) + "s" : "-"}`;
  });

  // ---- 5. sponsored search, switched on the way the owner does it ---------
  await step("owner: switch sponsored search to TEST mode via Admin -> Keys (the second API call: the keys screen posts exactly this)", async () => {
    const set = async (name, value) => {
      const r = await page.request.post(`${BASE}/api/admin/config`, { data: { name, value } });
      if (!r.ok()) throw new Error(`${name}: ${r.status()}`);
    };
    await set("TRAFFIC_PARTNERS", "drive|afs|Drive (Google, test ads)|on|pub-0000000000000000:1234567890||1");
    await set("TRAFFIC_MODE", "test");
    return "TRAFFIC_MODE=test, a Google unit configured - real script, adtest on, earns nothing";
  });
  await step("a guide now ends with the related-search unit, requested from Google's real script", async () => {
    googleRequests.length = 0;
    await page.goto(`${BASE}/guides/thailand-scooter-rental-prices`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6_000);
    await page.locator("[data-traffic-placement]").first().scrollIntoViewIfNeeded().catch(() => {});
    await shot(page, "guide-unit-test-mode");
    const csa = await page.evaluate(() => (window._googCsa && window._googCsa.q ? window._googCsa.q.length : 0));
    return `ads.js requested: ${googleRequests.some((u) => u.includes("adsense/search")) ? "yes" : "no"}; _googCsa calls queued/made: ${csa}; heading visible: ${await page.getByRole("heading", { name: "Related searches" }).isVisible().catch(() => false)}`;
  });
  await step("guides hub -> type a search -> /search shows real results (+ ads in test mode)", async () => {
    await page.goto(`${BASE}/guides`, { waitUntil: "domcontentloaded" });
    const box = page.locator('form[action="/search"] input[name="q"]');
    await box.fill("cash deposit scooter");
    await Promise.all([page.waitForURL(/\/search\?/), box.press("Enter")]);
    await page.waitForTimeout(4_000);
    await shot(page, "search-results");
    return `${await page.locator('main ol a[href^="/guides/"]').count()} organic results`;
  });

  // ---- 6. the owner's screens ------------------------------------------------
  await step("Admin -> Traffic reports the mode, the partner and the fill rate", async () => {
    await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /traffic/i }).first().click();
    await page.waitForTimeout(2_500);
    await shot(page, "admin-traffic");
    return (await page.locator("main").innerText()).match(/mode[\s\S]{0,40}/i)?.[0].replace(/\s+/g, " ") ?? "";
  });
  await step("Admin -> Data: the consent register knows about this visit", async () => {
    await page.getByRole("button", { name: /^data$/i }).first().click();
    await page.waitForTimeout(2_500);
    await shot(page, "admin-data");
  });

  // ---- 7. withdrawing advertising really withdraws -------------------------
  await step("footer -> Cookies -> turn advertising OFF: the page reloads and Google's cookies are gone", async () => {
    await page.goto(`${BASE}/guides/thailand-scooter-rental-prices`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    const before = (await ctx.cookies()).filter((c) => /^(__gads|__gpi|__eoi|_gcl_au|__gsas)$/.test(c.name)).map((c) => c.name);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("wd:cookie-panel")));
    const panel = page.getByRole("dialog").first();
    await panel.waitFor({ timeout: 10_000 });
    await shot(page, "cookie-panel");
    const toggles = panel.locator('input[type="checkbox"], [role="switch"]');
    const n = await toggles.count();
    if (n) await toggles.nth(n - 1).click();
    await panel.getByRole("button", { name: /save/i }).first().click();
    await page.waitForTimeout(3_000);
    const after = (await ctx.cookies()).filter((c) => /^(__gads|__gpi|__eoi|_gcl_au|__gsas)$/.test(c.name)).map((c) => c.name);
    return `Google cookies before: [${before.join(",") || "none"}] after: [${after.join(",") || "none"}]`;
  });

  // ---- 8. put the switches back ----------------------------------------------
  await step("owner: sponsored search back to OFF", async () => {
    await page.request.post(`${BASE}/api/admin/config`, { data: { name: "TRAFFIC_MODE", value: "off" } });
  });

  await shot(page, "end");
  await browser.close();

  console.log("");
  console.log(`page errors: ${errors.length}${errors.length ? "\n  " + errors.join("\n  ") : ""}`);
  console.log(`screenshots: ${SHOTS}/`);
  const misses = seen.filter((l) => l.startsWith("MISS")).length;
  console.log(misses ? `${misses} step(s) did not go as expected - read them above.` : "Every step went as expected.");
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
