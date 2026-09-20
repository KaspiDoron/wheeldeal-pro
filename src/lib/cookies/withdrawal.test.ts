// WITHDRAWING ADVERTISING HAS TO UNDO SOMETHING.
//
// The panel tells a person "Off means off - what is already stored on this
// device is deleted when you save". For preferences and analytics that was
// true. For advertising it was not: the purge skipped every Google cookie on
// the grounds that a third party's cookie "is on another domain and cannot be
// removed from here". That is right for IDE (doubleclick.net) and wrong for
// __gads, __gpi, __eoi and _gcl_au, which Google's script writes onto THIS
// site's own domain - exactly where this code can reach them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COOKIE_MANIFEST } from "./manifest";
import { makeConsent } from "./consent";
import { cookieDomainsFor, purgeDenied } from "./client";

const g = globalThis as unknown as Record<string, unknown>;
let writes: string[] = [];

function fakeBrowser(hostname: string) {
  writes = [];
  g.window = {};
  g.location = { protocol: "https:", hostname };
  g.document = {
    get cookie() {
      return "";
    },
    set cookie(v: string) {
      writes.push(v);
    },
  };
  const store = { length: 0, key: () => null, removeItem: () => undefined, getItem: () => null, setItem: () => undefined };
  g.localStorage = store;
  g.sessionStorage = store;
}

beforeEach(() => fakeBrowser("app.wheeldeal.pro"));
afterEach(() => {
  for (const k of ["window", "location", "document", "localStorage", "sessionStorage"]) delete g[k];
});

describe("which Domain= a cookie on this host may have been set with", () => {
  it("covers the host and every parent down to the registrable domain, dotted and not", () => {
    expect(cookieDomainsFor("app.wheeldeal.pro")).toEqual([
      "",
      "app.wheeldeal.pro",
      ".app.wheeldeal.pro",
      "wheeldeal.pro",
      ".wheeldeal.pro",
    ]);
  });

  it("never tries a bare TLD, and uses host-only for localhost and IPs", () => {
    expect(cookieDomainsFor("wheeldeal.pro")).toEqual(["", "wheeldeal.pro", ".wheeldeal.pro"]);
    expect(cookieDomainsFor("localhost")).toEqual([""]);
    expect(cookieDomainsFor("127.0.0.1")).toEqual([""]);
    expect(cookieDomainsFor("")).toEqual([""]);
  });
});

describe("turning advertising off", () => {
  it("the manifest says which of Google's cookies live on this site's own domain", () => {
    const google = COOKIE_MANIFEST.filter((e) => e.party === "Google");
    const onSite = google.flatMap((e) => e.siteCookies ?? []);
    expect(onSite).toEqual(expect.arrayContaining(["__gads", "__gpi", "__eoi", "_gcl_au"]));
    // IDE belongs to doubleclick.net. Claiming to delete it would be the same
    // lie in the other direction.
    expect(onSite).not.toContain("IDE");
  });

  it("expires each of them, on every domain they could have been set for", () => {
    purgeDenied(makeConsent({ preferences: true, analytics: true, marketing: false }, "custom"));
    for (const name of ["__gads", "__gpi", "__eoi", "_gcl_au"]) {
      const mine = writes.filter((w) => w.startsWith(`${name}=;`));
      expect(mine.length, `${name} was not expired`).toBe(5);
      expect(mine.every((w) => w.includes("Max-Age=0"))).toBe(true);
      expect(mine.some((w) => w.includes("Domain=.wheeldeal.pro"))).toBe(true);
      expect(mine.some((w) => !w.includes("Domain="))).toBe(true);
    }
  });

  it("touches none of them while advertising is still allowed", () => {
    purgeDenied(makeConsent({ preferences: false, analytics: false, marketing: true }, "custom"));
    expect(writes.some((w) => w.startsWith("__gads"))).toBe(false);
  });

  it("still never pretends to delete a cookie on somebody else's domain", () => {
    purgeDenied(makeConsent({ preferences: false, analytics: false, marketing: false }, "reject-all"));
    expect(writes.some((w) => w.startsWith("IDE="))).toBe(false);
  });
});
