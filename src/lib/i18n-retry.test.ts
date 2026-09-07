import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { translateOutcome, unavailableNote, retriable, missedFrom } from "./i18n-retry";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE SWEEP THAT COULD NOT STOP.
//
// t() records every untranslatable string in `pending`; a 1.5-second interval
// drains it to /api/translate. Nothing ever removed a string that came back
// UNTRANSLATED - so the next render put it straight back, and the loop ran for
// as long as the page was open, on a feature that in both failure modes could
// not work at all.

describe("REPRODUCTION: a retry needs a reason to expect a different answer", () => {
  it("the DAILY CAP is terminal - it resets tomorrow, not in 1.5 seconds", () => {
    // The route answers 429 with {map:{}} and NO error field, so even the one
    // `break` the client had never fired. Just a request every 1.5s, forever.
    expect(translateOutcome(429, { map: {} })).toBe("stop");
  });

  it("NO AI PROVIDER is terminal - nothing about this session will change it", () => {
    expect(translateOutcome(200, { map: {}, error: "AI translation needs a key" })).toBe("stop");
  });

  it("signed out, or a rejected language, is terminal", () => {
    expect(translateOutcome(401, { map: {} })).toBe("stop");
    expect(translateOutcome(400, null)).toBe("stop");
  });

  it("a server blip IS worth retrying", () => {
    expect(translateOutcome(502, null)).toBe("retry");
    expect(translateOutcome(200, null)).toBe("retry");
  });

  it("a good answer is a good answer", () => {
    expect(translateOutcome(200, { map: { hello: "shalom" } })).toBe("ok");
    expect(translateOutcome(200, { map: {} })).toBe("ok");
  });
});

describe("a declined string is retired, not re-queued forever", () => {
  it("retriable skips what the server already said no to", () => {
    const failed = new Set(["b"]);
    expect(retriable(["a", "b", "c"], failed)).toEqual(["a", "c"]);
  });

  it("everything asked for and absent from the map is a miss", () => {
    expect(missedFrom(["a", "b"], { a: "A" })).toEqual(["b"]);
    expect(missedFrom(["a", "b"], {})).toEqual(["a", "b"]);
    expect(missedFrom(["a"], null)).toEqual(["a"]);
  });

  it("nothing is a miss when everything came back", () => {
    expect(missedFrom(["a"], { a: "A" })).toEqual([]);
  });
});

describe("a stop is TOLD, never silent", () => {
  it("each terminal reason has its own plain sentence", () => {
    expect(unavailableNote(429, { map: {} })).toMatch(/budget/i);
    expect(unavailableNote(401, null)).toMatch(/Sign in/);
    expect(unavailableNote(200, { error: "no provider" })).toBe("no provider");
    expect(unavailableNote(500, null)).toMatch(/unavailable/i);
  });

  it("it is never blank", () => {
    for (const s of [400, 401, 429, 500, 200]) {
      expect(unavailableNote(s, null).length).toBeGreaterThan(10);
    }
  });
});

describe("the provider actually uses all of it", () => {
  const i18n = readCode("src/lib/i18n.tsx");

  it("REPRODUCTION: the interval no longer asks about failed strings", () => {
    // `pending` and `failed` moved into src/lib/i18n-gate.ts when t() stopped
    // uploading arbitrary user text (the sets and the admission rule belong
    // together). The provider still drives the sweep from them...
    // Audit F253 added the in-flight set as the third argument, so a sweep
    // cannot re-ask for the strings a fetch is still holding. The pin follows
    // the fix; the "declined once, never asked again" half is unchanged.
    expect(i18n).toMatch(/const batch = retriable\(pending, failed, inFlight\);/);
    expect(i18n).toMatch(/from "\.\/i18n-gate"/);
    // ...and the "declined once, never asked again" rule is now EXECUTED in
    // i18n-leak.test.ts against queueForTranslation, not pinned as source.
    const gate = readCode("src/lib/i18n-gate.ts");
    expect(gate).toMatch(/export const failed = new Set<string>\(\);/);
    expect(gate).toMatch(/if \(failed\.has\(s\)\) return false;/);
  });

  it("a terminal answer stops the sweep for the session", () => {
    expect(i18n).toMatch(/if \(stoppedRef\.current\) return;/);
    expect(i18n).toMatch(/stoppedRef\.current = true;/);
  });

  it("...and a NEW language clears it - the old verdict says nothing about it", () => {
    expect(i18n).toMatch(/failed\.clear\(\);/);
    expect(i18n).toMatch(/stoppedRef\.current = false;/);
  });

  it("batches run in parallel and commit ONCE, not once per batch", () => {
    // Sequential batches meant a language switch was N round trips end to end,
    // and each setDict re-rendered every consumer of the context.
    expect(i18n).toMatch(/const results = await Promise\.all\(/);
    expect(i18n.match(/setDict\(\(prev\) => \{/g)?.length).toBe(1);
  });

  it("the traveller is told, on the button as well as in the picker", () => {
    const btn = readCode("src/components/LanguageButton.tsx");
    expect(btn).toMatch(/unavailable/);
    expect(btn).toMatch(/\{unavailable \?\? error\}/);
    expect(btn).toMatch(/unavailable && !open/);
  });
});

describe("RTL is mirrored where it is load-bearing", () => {
  const css = readCode("src/app/globals.css");

  it("physical alignment flips", () => {
    expect(css).toMatch(/\[dir="rtl"\] \.text-left \{ text-align: right; \}/);
    expect(css).toMatch(/\[dir="rtl"\] \.text-right \{ text-align: left; \}/);
  });

  it("the windowed rows flip - absolute position has no inline flow to mirror", () => {
    expect(css).toMatch(/\[dir="rtl"\] \.wd-virtual-row/);
    const list = readCode("src/components/VirtualVendorList.tsx");
    expect(list).toMatch(/className="wd-virtual-row"/);
    expect(list).toMatch(/"--wd-lane-offset" as string/);
  });

  it("numbers and transcripts stay LEFT-to-right inside an RTL page", () => {
    // A phone number rendered right-to-left puts the country code at the wrong
    // end; a price puts the currency on the wrong side.
    expect(css).toMatch(/\[dir="rtl"\] \.ltr-island/);
    expect(css).toMatch(/unicode-bidi: isolate;/);
  });

  it("nothing leaks into the LTR app - every rule is scoped", () => {
    const block = css.slice(css.indexOf("RIGHT-TO-LEFT"));
    const selectors = block.match(/^\S[^{]*\{/gm) ?? [];
    for (const sel of selectors) {
      if (sel.startsWith("@")) continue;
      expect(sel, sel).toMatch(/\[dir="rtl"\]/);
    }
  });
});

describe("the way back to the status panel", () => {
  const fab = readCode("src/components/StatusFab.tsx");

  it("it watches the PANEL, not a scroll offset", () => {
    // A scroll threshold is a guess about where the panel is, and it is wrong
    // the moment the header collapses or the list re-flows.
    expect(fab).toMatch(/new IntersectionObserver\(/);
    expect(fab).toMatch(/setShow\(!entry\.isIntersecting\)/);
  });

  it("it waits for a panel that mounts with the results", () => {
    expect(fab).toMatch(/timer = setTimeout\(attach, 400\);/);
  });

  it("it disconnects and clears its timer on unmount", () => {
    expect(fab).toMatch(/observer\?\.disconnect\(\);/);
    expect(fab).toMatch(/if \(timer\) clearTimeout\(timer\);/);
  });

  it("it respects the safe area and sits above the tab bar", () => {
    // The FAB parks on a NAMED slot of the bottom-right stack now; the slot
    // token (globals.css) is what carries the safe-area inset, so the claim
    // is pinned across both files.
    expect(fab).toMatch(/bottom: "var\(--stack-bottom-1\)"/);
    expect(fab).toMatch(/layer-chrome/);
    const css = readCode("src/app/globals.css");
    expect(css).toMatch(/--stack-bottom-1: calc\(env\(safe-area-inset-bottom, 0px\)/);
  });

  it("the glass has an honest fallback where color-mix is unsupported", () => {
    const css = readCode("src/app/globals.css");
    expect(css).toMatch(/\.wd-status-fab \{/);
    expect(css).toMatch(/backdrop-filter: blur\(14px\) saturate\(160%\);/);
    expect(css).toMatch(/@supports not \(background: color-mix/);
  });

  it("it is mounted on the vertical list view only", () => {
    // listAxis joined the gate in owner report 6 G2: in swipe mode the pill
    // painted over the rail cards' action row.
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(
      /vendors\.length > 0 && view === "list" && listAxis !== "horizontal" && \(\s*<StatusFab/
    );
  });
});
