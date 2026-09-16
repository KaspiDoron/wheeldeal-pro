// MOBILE CHECK - the one that renders.
//
// WHY THIS EXISTS. The G.6/G.7 fixes (status-header wrap, transcript
// follow-scroll, virtual-list offset) shipped with executed unit tests and were
// never put in front of a browser. This repo's own stated failure mode is that
// a fully green suite missed all five of the owner's reported symptoms, and
// every one of them was a LAYOUT fact: a chevron clipped off the end of a row,
// a list drawn at the wrong offset. jsdom has no layout engine, so no unit test
// in this repo can see any of that. This can.
//
// WHAT IS REAL HERE. The production Next build, the real React tree, the real
// compiled Tailwind CSS, real Chromium layout at real viewport widths. The only
// thing faked is the network: `/api/deals/restore` is answered with a seeded
// workspace, because the panel under test only exists once a hunt is live, and
// a live hunt needs Google Places, Supabase and inbound WhatsApp. Seeding that
// one route is what makes the check non-vacuous - visiting `/` signed out
// renders no status panel at all, so a naive "load the page and look for
// overflow" would pass while measuring nothing. That restore route is itself a
// real product path (it is how the app picks a hunt back up on a cold device).
//
// PROVEN TO GO RED, not merely written. A green check that cannot fail is
// worth nothing, so this was falsified against the actual pre-fix markup:
// putting the chevron back INSIDE the wrapping counter group reproduces the
// reported defect, and the check reports
//
//   FAIL  the chevron is inside the viewport (right edge 332 <= 320)
//   FAIL  the chevron's centre point actually hits the expander button
//   FAIL  nothing extends past the right edge (span.text-[10px] right=332)
//
// at 320px in the translated locale - and PASSES at 320px in English. That is
// exactly the asymmetry in the original report: the row fits in English and
// does not fit once the labels are translated, which is why the owner saw it
// and an English-only check never would. Worth knowing if you ever trim this
// file down: dropping the locale pass would silently disarm it.
//
// Also worth knowing: removing `flex-wrap` ALONE does not reproduce the bug.
// The fix had two halves and the chevron living outside the wrapping group is
// the half that carries it.
//
// NOT part of `npm test`: it needs a browser and a booted server. Run it before
// shipping anything that touches the funnel's layout:
//
//   npm run build && npm run check:mobile
//
// Chromium comes from PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers in CI images);
// set MOBILE_CHECK_CHROMIUM to point somewhere else. Set MOBILE_CHECK_URL to
// test an already-running server instead of booting one.

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

// 320 is the narrowest phone still in use (iPhone SE 1st gen); 375 is the
// single most common width; 430 is the current large iPhone. The repo rule is
// "test at 320-430px", so these are its ends and its middle.
const VIEWPORTS = [320, 375, 430];
const PORT = Number(process.env.MOBILE_CHECK_PORT || 3399);
const BASE = process.env.MOBILE_CHECK_URL || `http://127.0.0.1:${PORT}`;
const SECRET = "mobile-check-secret-not-a-real-one";

function chromiumPath() {
  if (process.env.MOBILE_CHECK_CHROMIUM) return process.env.MOBILE_CHECK_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(`${root}/chromium`)) return `${root}/chromium`;
  return undefined; // let Playwright resolve its own download
}

/**
 * An "essential only" cookie decision, encoded the way lib/cookies/consent does.
 *
 * The policy version is READ FROM THE SOURCE rather than pasted: a bump would
 * otherwise silently turn this into a stale record, the middleware would hold
 * every page at the gate, and the failure would look like a layout regression.
 */
function consentCookie() {
  const src = readFileSync("src/lib/cookies/manifest.ts", "utf8");
  const version = src.match(/COOKIE_POLICY_VERSION\s*=\s*"([^"]+)"/)?.[1];
  if (!version) throw new Error("COOKIE_POLICY_VERSION not found in manifest.ts");
  const payload = JSON.stringify({
    v: version,
    t: Date.now(),
    s: "reject-all",
    g: { preferences: false, analytics: false, marketing: false },
  });
  return Buffer.from(payload, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A signed session cookie, minted the same way src/lib/session.ts does. */
function sessionCookie(email) {
  const b64 = Buffer.from(JSON.stringify({ email, issuedAt: Date.now() })).toString("base64url");
  return `${b64}.${createHmac("sha256", SECRET).update(b64).digest("hex")}`;
}

/**
 * A hunt with ALL FOUR counters live at once.
 *
 * That combination is the whole point: the clipped-chevron defect only appears
 * when the row is at its longest, and the four-counter row is the longest it
 * gets. One shop in each bucket, matching the partition in page.tsx's
 * statusGroups: an offer is a deal, an inbound is a reply, a live stage is
 * messaged, a queued send is queued.
 */
function seededWorkspace(now, nameFor) {
  const vendor = (id, name, extra) => ({
    id,
    name,
    lat: 7.8804,
    lng: 98.3923,
    rating: 4.6,
    reviews: 128,
    vehicleClasses: ["scooter"],
    fulfillment: ["pickup"],
    whatsapp: `+6612345${id}`,
    basePricePerDay: 300,
    partner: false,
    demo: true,
    address: "12 Beach Road",
    distanceKm: 0.8,
    ...extra,
  });
  return {
    vendors: [
      vendor("01", nameFor("messaged"), { stage: "awaiting-response", sentText: "Hi, do you have a scooter?" }),
      vendor("02", nameFor("replied"), {
        stage: "negotiating",
        sentText: "Hi, do you have a scooter?",
        lastInboundText: "Yes we have Click 125 available",
        lastInboundAt: new Date(now - 60_000).toISOString(),
      }),
      vendor("03", nameFor("queued"), {
        stage: "sending",
        queuedUntil: new Date(now + 600_000).toISOString(),
      }),
      vendor("04", nameFor("offers"), {
        stage: "negotiating",
        sentText: "Hi, do you have a scooter?",
        lastInboundAt: new Date(now - 30_000).toISOString(),
        offer: { pricePerDay: 250, currency: "THB", round: 1, vendorId: "04" },
      }),
    ],
    rfq: {
      vehicleClass: "scooter",
      transmission: "automatic",
      durationDays: 3,
      accessories: [],
      fulfillment: "pickup",
    },
    source: "demo",
    rawText: "scooter for 3 days",
    origin: { lat: 7.8804, lng: 98.3923, label: "Patong Beach Hotel" },
    radiusKm: 5,
    searchEpoch: now,
  };
}

const failures = [];
const notes = [];
function check(ok, label) {
  if (!ok) failures.push(label);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
}

/**
 * Is SOMETHING already answering on our port?
 *
 * THIS CHECK ONCE SPENT AN HOUR LYING. `server.kill()` below killed the `npx`
 * wrapper and left its `next-server` grandchild bound to the port. Every later
 * run then found the port answering, decided the boot had succeeded, and
 * measured a build from an hour earlier - while `npm run build` had already
 * replaced `.next` underneath it, so the stale process served 404s for chunk
 * names it no longer had. The visible result was a hydration error and a
 * missing panel that tracked NOTHING in the source, and an exact revert
 * "fixing" it only because a deterministic build reproduced the hashes the
 * orphan still had on disk.
 *
 * A check that silently measures the wrong build is worse than no check. So
 * this refuses to run rather than guess whose server it is talking to.
 */
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

/** Kill the booted server AND its children - see the spawn's `detached`. */
function stopServer(server) {
  if (!server?.pid) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // The group is already gone, or we never owned one.
    try {
      server.kill();
    } catch {
      /* nothing left to stop */
    }
  }
}

async function run() {
  let server = null;
  if (!process.env.MOBILE_CHECK_URL) {
    if (!existsSync(".next")) {
      console.error("No .next build found. Run `npm run build` first.");
      process.exit(2);
    }
    if (await portIsBusy(BASE)) {
      console.error(
        `Something is already listening on :${PORT}. This check would silently measure\n` +
          `THAT server's build instead of the one you just built - see portIsBusy.\n` +
          `Stop it first, or point MOBILE_CHECK_PORT somewhere free.`
      );
      process.exit(2);
    }
    console.log(`Booting the production build on :${PORT} ...`);
    // `detached` so the whole process GROUP can be signalled. Without it,
    // killing the npx wrapper orphans the next-server grandchild - which is the
    // exact failure portIsBusy exists to make loud.
    server = spawn("npx", ["next", "start", "-p", String(PORT)], {
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: "production",
        SESSION_SECRET: SECRET,
        // No Supabase, no Google, no Evolution: every integration in this app
        // has a no-key fallback, which is exactly what makes this runnable.
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
      },
      stdio: "ignore",
    });
    // A hard exit (Ctrl-C, a CI timeout) must not leave the port squatted for
    // the next run - that is how the stale-build lie starts.
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.once(sig, () => {
        stopServer(server);
        process.exit(130);
      });
    }
    if (!(await waitForServer(BASE))) {
      stopServer(server);
      console.error("Server did not come up.");
      process.exit(2);
    }
  }

  const exe = chromiumPath();
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});

  try {
    for (const width of VIEWPORTS) {
      // A TRANSLATED LOCALE IS THE REAL TEST, and it has to be the COUNTER
      // LABELS that get longer - the shop names live in the expanded body and
      // never touch the header row that clipped. English is the shortest this
      // row ever gets; the owner's report came from a translated screen.
      //
      // The German dict is seeded through the app's own localStorage cache
      // (`wd_lang` + `wd_i18n_<lang>`, src/lib/i18n.tsx) rather than by calling
      // a live LLM, so the check is deterministic and offline. "in
      // Warteschlange" against "queued" is the realistic worst case.
      for (const [localeLabel, nameFor, locale] of [
        ["en", (k) => `Shop ${k}`, null],
        [
          "de (longer labels)",
          (k) => `Motorradverleih Sonnenschein ${k}`,
          {
            messaged: "kontaktiert",
            replied: "geantwortet",
            queued: "in Warteschlange",
            offers: "Angebote",
          },
        ],
      ]) {
        console.log(`\n${width}px - ${localeLabel}`);
        const ctx = await browser.newContext({
          viewport: { width, height: 844 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
        });
        await ctx.addCookies([
          {
            name: "wd_session",
            value: sessionCookie("mobile-check@example.com"),
            domain: "127.0.0.1",
            path: "/",
            httpOnly: true,
          },
          // THE COOKIE DECISION. Essential cookies are a condition of using the
          // app, so a signed-in traveller has answered - and middleware.ts now
          // redirects a gated path to /cookies when they have not. Without this
          // the whole check measures the cookie policy page, which has no status
          // panel, and every layout assertion below fails for a reason that has
          // nothing to do with layout.
          //
          // "Essential only" on purpose: it is what a privacy-minded traveller
          // picks, and the funnel must lay out identically either way. If this
          // check ever passes on "accept all" and fails on this, that IS the
          // finding.
          {
            name: "wd_cookie_prefs",
            value: consentCookie(),
            domain: "127.0.0.1",
            path: "/",
          },
        ]);
        // Dismiss the first-run onboarding sheet. It is a real, correct overlay
        // (`layer-overlay fixed inset-0`) that covers the whole funnel on a
        // first visit - the first version of this script tried to tap the
        // chevron through it, which is a fair reminder that "visible" and
        // "reachable" are different questions and this file is about the second
        // one. The funnel behind it is what we are here to measure.
        await ctx.addInitScript((dict) => {
          try {
            localStorage.setItem("wd_onboarded", "1");
            if (dict) {
              localStorage.setItem("wd_lang", "de");
              localStorage.setItem("wd_i18n_de", JSON.stringify(dict));
            }
          } catch {
            /* private mode */
          }
        }, locale);
        const page = await ctx.newPage();
        const now = Date.now();
        await page.route("**/api/deals/restore**", (route) =>
          route.fulfill({ json: { payload: seededWorkspace(now, nameFor) } })
        );
        // Keep the poll loops quiet and deterministic - this check is about
        // layout, not about the polling protocol.
        await page.route("**/api/queue**", (route) => route.fulfill({ json: { items: [] } }));
        // The i18n provider sweeps for anything not in the seeded cache. Answer
        // it empty so the seeded labels are what renders and nothing waits on a
        // provider that is not configured here.
        await page.route("**/api/translate**", (route) => route.fulfill({ json: { translations: {} } }));

        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        const status = page.locator('[data-tour="status"]');
        await status.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});

        check(pageErrors.length === 0, `no uncaught page errors${pageErrors[0] ? ` (${pageErrors[0]})` : ""}`);
        check(await status.isVisible().catch(() => false), "the live status panel rendered");

        // 1. NO HORIZONTAL OVERFLOW. The repo's mobile rule, measured rather
        //    than asserted in a comment.
        const overflow = await page.evaluate(() => ({
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
        }));
        check(
          overflow.scrollW <= overflow.clientW,
          `no horizontal document overflow (${overflow.scrollW} <= ${overflow.clientW})`
        );

        // 2. ALL FOUR COUNTERS ARE LIVE. If the seed stopped producing four
        //    buckets, the row would be short and the chevron test below would
        //    pass without ever exercising the case that broke.
        const header = status.locator("button").first();
        const headerText = ((await header.textContent().catch(() => "")) || "").replace(/\s+/g, " ");
        const counters = (headerText.match(/[📤💬🕘💰]/gu) || []).length;
        check(counters === 4, `all four counters live (found ${counters}) - "${headerText.trim()}"`);
        if (locale) {
          // Without this the locale pass would silently render English and
          // "tested a translated screen" would be a claim, not a fact.
          check(
            headerText.includes(locale.queued),
            `the longer translated labels really rendered ("${locale.queued}")`
          );
        }

        // 3. THE CHEVRON IS HIT-TESTABLE. Visible is not enough: the reported
        //    defect was a chevron CLIPPED by an `overflow-hidden` parent, which
        //    still reports as visible with a box. Ask the browser what is
        //    actually at that point, and require it to be inside the button.
        const chevron = status.locator("span", { hasText: /^[▼▲]$/ }).first();
        const chevronOk = await chevron.count().then((n) => n > 0);
        check(chevronOk, "the expander chevron is present");
        if (chevronOk) {
          const box = await chevron.boundingBox();
          check(!!box && box.width > 0 && box.height > 0, "the chevron has a real box");
          if (box) {
            check(
              box.x >= 0 && box.x + box.width <= width,
              `the chevron is inside the viewport (right edge ${Math.round(box.x + box.width)} <= ${width})`
            );
            const hit = await page.evaluate(
              ([x, y]) => {
                const el = document.elementFromPoint(x, y);
                return !!el?.closest('[data-tour="status"] button');
              },
              [box.x + box.width / 2, box.y + box.height / 2]
            );
            check(hit, "the chevron's centre point actually hits the expander button");
          }

          // 4. AND TAPPING IT ACTUALLY TOGGLES THE PANEL, BOTH WAYS. An
          //    expander that toggles onto nothing is the other half of the same
          //    reported bug. The panel auto-opens when a shop writes back (that
          //    is deliberate - RC-4), and this seed contains a reply, so it
          //    arrives OPEN: collapse first, then expand, and require the
          //    height to move in both directions.
          const openH = (await status.boundingBox())?.height ?? 0;
          await header.click();
          await page.waitForTimeout(250);
          const closedH = (await status.boundingBox())?.height ?? 0;
          check(closedH < openH, `tapping collapses the panel (${Math.round(openH)} -> ${Math.round(closedH)}px)`);
          await header.click();
          await page.waitForTimeout(250);
          const reopenedH = (await status.boundingBox())?.height ?? 0;
          check(
            reopenedH > closedH,
            `tapping again expands it (${Math.round(closedH)} -> ${Math.round(reopenedH)}px)`
          );

          // 5. THE EXPANDED PANEL MUST NOT OVERFLOW EITHER. It carries the
          //    per-shop rows, which are the longest strings on the screen.
          const expanded = await page.evaluate(() => ({
            scrollW: document.documentElement.scrollWidth,
            clientW: document.documentElement.clientWidth,
          }));
          check(
            expanded.scrollW <= expanded.clientW,
            `no overflow with the panel open (${expanded.scrollW} <= ${expanded.clientW})`
          );
        }

        // 6. NO ELEMENT POKES PAST THE RIGHT EDGE. Document scrollWidth misses
        //    anything inside an `overflow-hidden` ancestor - which is precisely
        //    how the clipped chevron escaped notice: the page never scrolled,
        //    it silently cut the content off instead.
        const pokers = await page.evaluate((w) => {
          const bad = [];
          for (const el of document.querySelectorAll("body *")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none") continue;
            // Deliberately horizontally scrollable strips (carousels, chip
            // rows) are allowed to be wider than the screen - that is a
            // designed gesture, not a layout break.
            let scroller = false;
            for (let p = el.parentElement; p; p = p.parentElement) {
              const pcs = getComputedStyle(p);
              if (pcs.overflowX === "auto" || pcs.overflowX === "scroll") { scroller = true; break; }
            }
            if (scroller) continue;
            if (r.right > w + 1) bad.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 40)} right=${Math.round(r.right)}`);
          }
          return bad.slice(0, 5);
        }, width);
        check(pokers.length === 0, `nothing extends past the right edge${pokers.length ? ` (${pokers[0]})` : ""}`);

        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    stopServer(server);
  }

  console.log("");
  for (const n of notes) console.log(`note: ${n}`);
  if (failures.length) {
    console.error(`\n${failures.length} mobile check(s) FAILED:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("All mobile checks passed.");
}

// NOT COVERED HERE, and said out loud rather than left to be assumed: the
// transcript follow-scroll fix (useTranscriptScroll / reconcileMessages). It
// needs a live thread with inbound messages arriving across a poll cycle, which
// this seed cannot produce - the restore payload rebuilds the board, not a
// message stream. It keeps its unit coverage in
// src/lib/client/render-storm.test.ts and remains un-rendered.
notes.push(
  "transcript follow-scroll is NOT covered here - it needs a live message stream; see render-storm.test.ts"
);

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
