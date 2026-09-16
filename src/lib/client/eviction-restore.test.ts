import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { readWaCache, writeWaCache } from "./wa-cache";
import { ALLOW_ALL, encodeCookieConsent, makeConsent } from "../cookies/consent";

/** A `wd_cookie_prefs` value granting every category, built by the real
 *  encoder so the fixture cannot drift from the format the gate reads. */
const grantingConsent = () => encodeCookieConsent(makeConsent(ALLOW_ALL, "accept-all"));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const page = readCode("src/app/page.tsx");
const deals = readCode("src/app/deals/page.tsx");
const route = readCode("src/app/api/deals/restore/route.ts");
const waConnect = readCode("src/components/WaConnect.tsx");

// iOS KILLS BACKGROUND PWAs, AND sessionStorage GOES WITH THEM.
//
// The live hunt lived in exactly one place - sessionStorage "wd_search" - so a
// traveller who put the phone down mid-negotiation re-opened the app to the
// search screen, as if nothing had ever run. Every shop, offer and thread was
// still on the server. Only the device had forgotten, and the one thing that
// could rebuild it (/api/deals/restore) had to be found by hand in another tab.

describe("REPRODUCTION: a cold mount with nothing stored rebuilds itself", () => {
  it("the home screen asks for the newest hunt back", () => {
    expect(page).toMatch(/fetch\("\/api\/deals\/restore\?ts=latest", \{ cache: "no-store" \}\)/);
  });

  it("...only when there is genuinely nothing to show", () => {
    expect(page).toMatch(/if \(!restored \|\| vendors\.length \|\| phase !== "idle"\) return;/);
  });

  it("...and it never stomps a search the traveller just started", () => {
    // The fetch is a round trip; a fast typist can be mid-hunt when it lands.
    expect(page).toMatch(/if \(sessionStorage\.getItem\("wd_search"\)\) return;/);
  });

  it("the traveller is told what happened, not silently teleported", () => {
    expect(page).toMatch(/Picked your hunt back up - the agents never stopped\./);
  });
});

describe("the route can be asked for 'whatever I was on'", () => {
  it("ts=latest resolves to the newest session", () => {
    expect(route).toMatch(/const wantLatest = ts === "latest";/);
    expect(route).toMatch(/const gi = wantLatest\s*\?\s*0/);
  });

  it("and it opens no paid door - index 0 was always ungated", () => {
    // The gate is `gi > 0 && !hasHistory`; latest pins gi to 0 by construction.
    expect(route).toMatch(/if \(gi > 0 && !hasHistory\)/);
    expect(route).toMatch(/if \(!wantLatest && !Number\.isFinite\(startMs\)\)/);
  });
});

describe("REPRODUCTION: the manual restore could land an empty workspace", () => {
  it("it writes through the budget ladder, like every other search write", () => {
    // A raw setItem threw on a big restored hunt and the catch swallowed it -
    // so the traveller was navigated home to nothing, with no error at all.
    //
    // The pin used to name `d.payload` literally. It is now `payload`, a local
    // copy of the same object with the re-open epoch clamped forward (see
    // reopenEpoch: the server's stamp is the fix, this is the belt to it) -
    // which does not touch the fact this test is about, so the assertion tracks
    // the ladder rather than the variable name.
    expect(deals).toMatch(/const saved = saveSearch\(sessionStorage, "wd_search", payload\);/);
    expect(deals).not.toMatch(/sessionStorage\.setItem\("wd_search"/);
  });

  it("...and a failed write says so instead of navigating", () => {
    expect(deals).toMatch(/if \(!saved\.ok\) \{/);
    expect(deals).toMatch(/That hunt is too big to hold on this device\./);
  });
});

describe("the link state stops asserting the negative while it is still asking", () => {
  it("REPRODUCTION: a null probe no longer falls through to 'connect your WhatsApp'", () => {
    const guard = waConnect.indexOf("if (wa === null) {");
    const pitch = waConnect.indexOf("if (wa && !wa.available) {");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(pitch);
    expect(waConnect).toMatch(/<Skeleton className="h-\[46px\] w-full"/);
  });

  it("a remembered link shows dimmed, and says it is still checking", () => {
    expect(waConnect).toMatch(/setCached\(readWaCache\(\)\);/);
    expect(waConnect).toMatch(/writeWaCache\(s\.connected\);/);
    expect(waConnect).toMatch(/Checking the link\.\.\./);
  });
});

describe("the cache is a hint, never authority", () => {
  const store = (() => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  })();
  vi.stubGlobal("localStorage", store);
  // THE CACHE IS A `preferences` COOKIE NOW, so writing to it needs consent -
  // `wd_wa_linked` is declared in COOKIE_MANIFEST and `writeWaCache` goes
  // through rememberLocal like every other browser-storage write in the app.
  // These tests are about the cache's own semantics, so they grant the
  // category and get on with it; the refusal path has its own test below.
  vi.stubGlobal("document", { cookie: `wd_cookie_prefs=${grantingConsent()}` });

  it("a remembered YES is returned, a remembered NO is not", () => {
    // A stale "connected" costs one dimmed line. A stale "disconnected" would
    // cost the traveller a pointless re-link, so it is simply never asserted.
    writeWaCache(true, 1_000);
    expect(readWaCache(1_000)).toBe(true);
    writeWaCache(false, 1_000);
    expect(readWaCache(1_000)).toBe(null);
  });

  it("an old memory is not worth having", () => {
    writeWaCache(true, 1_000);
    expect(readWaCache(1_000 + 15 * 24 * 60 * 60 * 1000)).toBe(null);
  });

  it("garbage and a missing entry both read as 'do not know'", () => {
    store.setItem("wd_wa_linked", "not json");
    expect(readWaCache()).toBe(null);
    store.removeItem("wd_wa_linked");
    expect(readWaCache()).toBe(null);
  });

  it("without preference consent nothing is written, and that degrades to a probe", () => {
    // Exactly the shape a blocked-storage device already produced - which this
    // cache was built to survive - so a traveller who declined preference
    // cookies pays one extra probe per load and never a wrong verdict.
    store.removeItem("wd_wa_linked");
    vi.stubGlobal("document", { cookie: "" });
    writeWaCache(true, 1_000);
    expect(store.getItem("wd_wa_linked")).toBe(null);
    expect(readWaCache(1_000)).toBe(null);
    vi.stubGlobal("document", { cookie: `wd_cookie_prefs=${grantingConsent()}` });
  });
});
