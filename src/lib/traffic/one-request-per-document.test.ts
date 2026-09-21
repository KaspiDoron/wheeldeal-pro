// ONE SEARCH-ADS REQUEST PER DOCUMENT - and no quiet way to lose the next one.
//
// Google: "Only ever make one ad request per page". `requestSearchAds` enforces
// it with a flag on `window`, which lives exactly as long as the document. A
// next/link hop KEEPS the document, so after it the flag is still set and the
// next page's unit silently never loads. That is compliant and invisible: no
// error, no failed test, just less revenue from the readers who browse most.
//
// So the two pages that make a request must leave by REAL page loads only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PAGES = ["src/app/guides/[slug]/page.tsx", "src/app/search/page.tsx"];

describe("pages that make a search-ads request leave by real page loads", () => {
  for (const page of PAGES) {
    const src = readFileSync(join(process.cwd(), page), "utf8");

    it(`${page} renders a placement at all (or this guard guards nothing)`, () => {
      expect(src).toMatch(/<TrafficPlacement|<SearchAds/);
    });

    it(`${page} uses no next/link`, () => {
      expect(src, "use a plain <a href> - a soft navigation keeps the one-request flag alive").not.toMatch(/from "next\/link"/);
      expect(src).not.toMatch(/<Link[\s>]/);
    });
  }
});
