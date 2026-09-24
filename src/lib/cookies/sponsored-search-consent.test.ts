// A YES TO ONE PURPOSE IS NOT A YES TO A LATER ONE.
//
// The cookie layer deliberately honours a STALE-version choice until the person
// answers the re-prompt: "their last word stands in both directions". That is
// right while the purpose is unchanged - silently revoking a yes to display ads
// misrepresents the person as much as silently honouring a no would.
//
// It is wrong for a purpose that did not exist when they answered. Sponsored
// search arrived WITH the 2026-09-20 policy; the version was bumped precisely
// because "a yes given to display ads was not a yes to this". Gating it on a
// check that ignores the version would load the new unit for every returning
// visitor, under a consent given before anyone had told them about it, while
// the banner asking the question was still on screen.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allows, allowsSponsoredSearch, type CookieConsent } from "./consent";
import { COOKIE_POLICY_VERSION, SPONSORED_SEARCH_SINCE } from "./manifest";

const consent = (version: string, marketing: boolean): CookieConsent => ({
  version,
  at: Date.now(),
  source: "custom",
  grants: { preferences: false, analytics: false, marketing },
});

describe("sponsored search needs a consent that was told about it", () => {
  it("a yes made against the current policy covers it", () => {
    expect(allowsSponsoredSearch(consent(COOKIE_POLICY_VERSION, true))).toBe(true);
    expect(allowsSponsoredSearch(consent(SPONSORED_SEARCH_SINCE, true))).toBe(true);
  });

  it("a yes made BEFORE it was disclosed does not - even though display ads still honour it", () => {
    const old = consent("2026-09-16", true);
    expect(allows(old, "marketing")).toBe(true);
    expect(allowsSponsoredSearch(old)).toBe(false);
  });

  it("a later policy version keeps covering it", () => {
    expect(allowsSponsoredSearch(consent("2027-03-01", true))).toBe(true);
  });

  it("fails closed on a no, a missing record, or a version that is not a date", () => {
    expect(allowsSponsoredSearch(consent(COOKIE_POLICY_VERSION, false))).toBe(false);
    expect(allowsSponsoredSearch(null)).toBe(false);
    expect(allowsSponsoredSearch(undefined)).toBe(false);
    // "zzzz" sorts AFTER every date as a string. Comparing unvalidated versions
    // would make garbage the strongest consent there is.
    for (const v of ["zzzz", "", "9999", "2026-9-20", "latest"]) expect(allowsSponsoredSearch(consent(v, true)), v).toBe(false);
  });

  it("the disclosure version is a real policy version, not in the future", () => {
    expect(SPONSORED_SEARCH_SINCE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SPONSORED_SEARCH_SINCE <= COOKIE_POLICY_VERSION).toBe(true);
  });
});

// The property is about every file in the module, including ones not written
// yet - so it is a grep, not a list of call sites somebody has to maintain.
describe("nothing in the traffic module is gated on the bare marketing grant", () => {
  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(join(process.cwd(), dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(process.cwd(), rel)).isDirectory()) out.push(...files(rel));
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
    }
    return out;
  }
  const scope = [...files("src/lib/traffic"), ...files("src/components/traffic"), ...files("src/app/api/traffic"), "src/app/search/page.tsx"];

  it("finds the module's files (the walk itself still works)", () => {
    expect(scope.length).toBeGreaterThan(10);
  });

  it("uses the sponsored-search gate everywhere, never clientAllows(\"marketing\") or marketingAllowed()", () => {
    const offenders = scope.filter((f) => {
      const src = readFileSync(join(process.cwd(), f), "utf8").replace(/\/\/.*$/gm, "");
      return /clientAllows\(\s*["']marketing["']\s*\)|marketingAllowed\(/.test(src);
    });
    expect(offenders, "gate these on clientAllowsSponsoredSearch() / sponsoredSearchAllowed()").toEqual([]);
  });
});
