import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import {
  SITE_DOMAIN,
  SITE_ORIGIN,
  ADSENSE_PUBLISHER,
  ADSENSE_PUB_ID,
  normalizeOrigin,
  envSiteOrigin,
} from "./site";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the site has exactly one identity", () => {
  it("the brand domain is a single constant", () => {
    expect(SITE_DOMAIN).toBe("wheeldeal.pro");
    expect(SITE_ORIGIN).toBe("https://wheeldeal.pro");
  });

  it("no module carries a hard-coded domain of its own", () => {
    // This is the failure that made a domain change an audit: the same brand
    // host was a literal in the root layout, in push identity and in the
    // geocoder User-Agent, in three different shapes. One place knows it now.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk("src");
    for (const f of files) {
      if (f === "src/lib/site.ts") continue; // the one owner
      expect(readCode(f), `${f} hard-codes a brand domain`).not.toMatch(
        /wheeldeal\.(app|pro|com|io|co)/i
      );
    }
  });

  it("anything an owner might paste normalises to one origin", () => {
    for (const raw of [
      "wheeldeal.pro",
      "wheeldeal.pro/",
      "https://wheeldeal.pro",
      "https://wheeldeal.pro/",
      "  https://wheeldeal.pro  ",
    ]) {
      expect(normalizeOrigin(raw)).toBe(SITE_ORIGIN);
    }
  });

  it("...and nonsense normalises to null rather than to a broken URL", () => {
    for (const raw of ["", "   ", null, undefined, "https://"]) {
      expect(normalizeOrigin(raw)).toBeNull();
    }
  });

  it("the env chain still overrides the default, in order", () => {
    const prev = { site: process.env.NEXT_PUBLIC_SITE_URL, app: process.env.APP_DOMAIN };
    try {
      delete process.env.NEXT_PUBLIC_SITE_URL;
      delete process.env.APP_DOMAIN;
      expect(envSiteOrigin()).toBe(SITE_ORIGIN);

      process.env.APP_DOMAIN = "staging.example.com";
      expect(envSiteOrigin()).toBe("https://staging.example.com");

      // NEXT_PUBLIC_SITE_URL is the build-time inlined one and wins.
      process.env.NEXT_PUBLIC_SITE_URL = "https://preview.example.com/";
      expect(envSiteOrigin()).toBe("https://preview.example.com");
    } finally {
      if (prev.site) process.env.NEXT_PUBLIC_SITE_URL = prev.site;
      else delete process.env.NEXT_PUBLIC_SITE_URL;
      if (prev.app) process.env.APP_DOMAIN = prev.app;
      else delete process.env.APP_DOMAIN;
    }
  });

  it("every domain consumer asks the owner instead of re-deriving", () => {
    expect(readCode("src/app/layout.tsx")).toMatch(/resolveSiteOrigin\(\)/);
    expect(readCode("src/lib/push.ts")).toMatch(/resolveSiteHost\(\)/);
    expect(readCode("src/lib/google.ts")).toMatch(/resolveSiteHost\(\)/);
    expect(readCode("src/app/robots.ts")).toMatch(/resolveSiteOrigin\(\)/);
    expect(readCode("src/app/sitemap.ts")).toMatch(/resolveSiteOrigin\(\)/);
  });
});

describe("AdSense is verifiable on a cold, anonymous fetch", () => {
  // Google's reviewer is not signed in and has not set any of our env vars. If
  // any of the three proofs of ownership is conditional on configuration, the
  // review fails on a site that looks unverifiable.
  it("the publisher id is a constant, and ads.txt drops the ca- prefix", () => {
    expect(ADSENSE_PUBLISHER).toBe("ca-pub-4965894186804157");
    expect(ADSENSE_PUB_ID).toBe("pub-4965894186804157");
  });

  it("the site tag is unconditional", () => {
    // "Unconditional" here means: not hostage to an ENV VAR. The tag is built
    // from the ADSENSE_PUBLISHER constant, so a deploy with no ADSENSE_CLIENT
    // set still carries the right account. (Whether it LOADS is the visitor's
    // consent, which is a different question and lib/cookies/prepaint.ts's.)
    //
    // The gate moved out of the layout into that module so it could be run
    // under test, so this pin follows it: the layout hands the constant over,
    // and the module owns the URL. Read raw - the comment stripper would eat
    // the `//` in the URL.
    const l = read("src/app/layout.tsx");
    expect(l).toMatch(/buildAdConsentScript\(ADSENSE_PUBLISHER\)/);
    const gate = read("src/lib/cookies/prepaint.ts");
    expect(gate).toMatch(/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/);
    expect(gate).toMatch(/\?client=\$\{client\}/);
    // The old shape: `{process.env.ADSENSE_CLIENT && <script .../>}`.
    expect(l).not.toMatch(/process\.env\.ADSENSE_CLIENT\s*&&/);
    expect(gate).not.toMatch(/process\.env/);
  });

  it("the account meta tag is on every page", () => {
    expect(readCode("src/app/layout.tsx")).toMatch(
      /"google-adsense-account":\s*ADSENSE_PUBLISHER/
    );
  });

  it("ads.txt is a static file with exactly the line Google expects", () => {
    expect(read("public/ads.txt").trim()).toBe(
      `google.com, ${ADSENSE_PUB_ID}, DIRECT, f08c47fec0942fa0`
    );
    // A dynamic route at the same path would shadow it ambiguously, and served
    // a "# Set ADSENSE_CLIENT" comment whenever the env var was missing - which
    // is a failed verification, not a graceful degradation.
    expect(existsSync(join(process.cwd(), "src/app/ads.txt/route.ts"))).toBe(false);
  });

  it("the SDK is loaded exactly once - a second copy is a policy violation", () => {
    expect(readCode("src/components/AdBanner.tsx")).not.toMatch(
      /createElement\("script"\)/
    );
  });

  it("a slot still falls back to the site's own account, never to null", () => {
    expect(readCode("src/app/api/config/public/route.ts")).toMatch(
      /adsenseClient:\s*adsense \|\| ADSENSE_PUBLISHER/
    );
  });
});

describe("the crawler is given a map, and only of pages it can reach", () => {
  it("robots points at the sitemap and closes the gated surfaces", () => {
    const r = readCode("src/app/robots.ts");
    expect(r).toMatch(/sitemap:/);
    for (const gated of ["/admin", "/profile", "/deals", "/login", "/api/"]) {
      expect(r).toContain(`"${gated}"`);
    }
    expect(r).toMatch(/Mediapartners-Google/);
  });

  it("the sitemap lists only paths OUTSIDE the auth middleware matcher", () => {
    const mw = readCode("src/middleware.ts");
    const matcher = mw.slice(mw.indexOf("matcher:"));
    const listed = [...readCode("src/app/sitemap.ts").matchAll(/path:\s*"([^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(listed.length).toBeGreaterThan(0);
    for (const p of listed) expect(matcher).not.toContain(`"${p}"`);
  });
});
