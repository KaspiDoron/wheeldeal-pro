import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// OWNER REPORT 11, WAVE F2 - two ways the funnel showed the traveller a lie.
//
// page.tsx is a 5000-line client component; these behaviours live inside event
// handlers and JSX that a unit test cannot mount, so they are pinned at the
// source (the repo's standing pattern for this file). Each pin fails if the fix
// is reverted.

const page = readFileSync("src/app/page.tsx", "utf8");

describe("F2.1 - a non-JSON error must not freeze 'Structuring your request'", () => {
  it("parses the profile body defensively, and only decides on ok AFTER", () => {
    // A 502/504 HTML page made `await pRes.json()` throw before the !ok branch
    // could reset the funnel, so the whole async startSearch rejected and the
    // spinner hung forever. The guarded parse + combined guard is the fix.
    expect(page).toMatch(/const pData = await pRes\.json\(\)\.catch\(\(\) => null\);/);
    expect(page).toMatch(/if \(!pRes\.ok \|\| !pData\) \{/);
    // The regression shape - parse THEN check ok - must be gone.
    expect(page).not.toMatch(/const pData = await pRes\.json\(\);\s*\n\s*if \(!pRes\.ok\) \{/);
  });
});

describe("F2.2 - the thread dashboard must render the LIVE vendor, not a snapshot", () => {
  it("re-derives the vendor from the live list by id at render", () => {
    // dashboardFor is frozen at open time, and ThreadDashboard hands its vendor
    // straight to onBook/onBargain - so a price that landed while it was open
    // was committed stale to booking/close-deal. Re-derive each render.
    expect(page).toMatch(
      /vendor=\{vendors\.find\(\(v\) => v\.id === dashboardFor\.id\) \?\? dashboardFor\}/
    );
    // The bare frozen-snapshot prop is gone.
    expect(page).not.toMatch(/<ThreadDashboard\s*\n\s*vendor=\{dashboardFor\}/);
  });
});
