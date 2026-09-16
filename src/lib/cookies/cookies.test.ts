import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// THE COOKIE LAYER, PINNED.
//
// The tests that matter here are not the round-trip ones (though those are
// below). They are the three that stop this feature rotting the way every
// cookie banner rots:
//
//   1. THE MANIFEST IS COMPLETE. A grep of src/ for every browser-storage write
//      in the app, checked against COOKIE_MANIFEST. A new
//      `localStorage.setItem("wd_something")` fails the build until somebody
//      declares what it is for. This is the test that keeps the /cookies page
//      true a year from now.
//
//   2. THE WRITES GO THROUGH THE GATE. Declaring a key is not enough - it has
//      to be written through rememberLocal/rememberSession or the consent has
//      no effect. The same grep asserts no raw setItem survives.
//
//   3. REJECT IS AS EASY AS ACCEPT. The two banner buttons are pinned to
//      identical classes. This is the dark pattern that makes a banner
//      unlawful, and it is reintroduced by restyling, not by intent.

vi.mock("server-only", () => ({}));

import {
  COOKIE_MANIFEST,
  COOKIE_POLICY_VERSION,
  CATEGORY_COPY,
  COOKIE_CATEGORIES,
  OPTIONAL_CATEGORIES,
  categoryForKey,
  entriesFor,
} from "./manifest";
import {
  ALLOW_ALL,
  ANALYTICS_COOKIE,
  CONSENT_COOKIE,
  DENY_ALL,
  allows,
  cookieValueFrom,
  decodeCookieConsent,
  deniedCategories,
  encodeCookieConsent,
  makeConsent,
  needsCookieChoice,
  normalizeGrants,
} from "./consent";
import { normalizePath, sanitizeProps, isAnalyticsEvent, ANALYTICS_EVENTS } from "../analytics/events";
import { CONSENT_KINDS, OPT_IN_KINDS } from "../consent";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Every .ts/.tsx under src/, excluding tests and the cookie layer itself. */
function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) {
      out.push(...sourceFiles(rel));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(rel);
  }
  return out;
}

// ---- 1 + 2: the manifest is complete, and the gate is the only door ---------

describe("every browser-storage write in the app is declared and gated", () => {
  // The cookie layer itself is the implementation of the gate, so it is the one
  // place raw storage calls are correct. Everything else must go through it.
  const GATE_FILES = new Set(["src/lib/cookies/client.ts"]);

  const hits: { file: string; key: string; raw: boolean }[] = [];
  for (const file of sourceFiles()) {
    if (GATE_FILES.has(file)) continue;
    const src = stripComments(read(file));
    // Raw writes - the thing that must not exist outside the gate.
    for (const m of src.matchAll(
      /(?:local|session)Storage\.setItem\(\s*(?:"([^"]+)"|`([^`$]*)\$\{|'([^']+)')/g
    )) {
      hits.push({ file, key: m[1] ?? m[2] ?? m[3] ?? "", raw: true });
    }
    // Gated writes - these are correct, but the KEY still has to be declared.
    for (const m of src.matchAll(
      /remember(?:Local|Session)\(\s*(?:"([^"]+)"|`([^`$]*)\$\{|'([^']+)')/g
    )) {
      hits.push({ file, key: m[1] ?? m[2] ?? m[3] ?? "", raw: false });
    }
  }

  it("finds the storage writes at all (the grep itself still works)", () => {
    // A regex that silently stops matching turns this whole file into a suite
    // that passes by finding nothing. Pin a floor.
    expect(hits.length).toBeGreaterThan(10);
  });

  it("no raw localStorage/sessionStorage write survives outside the gate", () => {
    const raw = hits.filter((h) => h.raw);
    expect(
      raw.map((h) => `${h.file}: ${h.key}`),
      "these bypass the consent gate - use rememberLocal/rememberSession from lib/cookies/client"
    ).toEqual([]);
  });

  it("every key written is declared in COOKIE_MANIFEST", () => {
    const undeclared = hits
      .filter((h) => h.key && !categoryForKey(h.key))
      .map((h) => `${h.file}: ${h.key}`);
    expect(
      undeclared,
      "declare these in src/lib/cookies/manifest.ts with a category, a purpose and a duration - " +
        "they appear on the /cookies policy page and in the consent panel"
    ).toEqual([]);
  });

  it("the template-literal families resolve through the prefix rule", () => {
    // `wd_i18n_${lang}` greps as `wd_i18n_` and must match the declared
    // `wd_i18n_*` family rather than falling through as undeclared.
    expect(categoryForKey("wd_i18n_")).toBe("preferences");
    expect(categoryForKey("wd_i18n_th")).toBe("preferences");
  });

  it("an undeclared key fails closed rather than defaulting to allowed", () => {
    expect(categoryForKey("wd_brand_new_thing")).toBeNull();
    expect(categoryForKey("")).toBeNull();
  });
});

describe("the manifest is a usable disclosure, not a list of names", () => {
  it("every entry carries a purpose and a duration a person can read", () => {
    for (const e of COOKIE_MANIFEST) {
      expect(e.name, "a nameless cookie cannot be disclosed").toBeTruthy();
      expect(e.purpose.length, `${e.name} needs a real purpose`).toBeGreaterThan(20);
      expect(e.duration.length, `${e.name} needs a real duration`).toBeGreaterThan(3);
      expect(COOKIE_CATEGORIES).toContain(e.category);
    }
  });

  it("no entry is declared twice in the same medium", () => {
    const seen = new Set<string>();
    for (const e of COOKIE_MANIFEST) {
      const key = `${e.medium}:${e.name}`;
      expect(seen.has(key), `${key} declared twice`).toBe(false);
      seen.add(key);
    }
  });

  it("every category has copy, and the optional ones say what turning them off costs", () => {
    for (const c of COOKIE_CATEGORIES) {
      expect(CATEGORY_COPY[c].title).toBeTruthy();
      expect(CATEGORY_COPY[c].blurb.length).toBeGreaterThan(20);
      expect(CATEGORY_COPY[c].consequence.length).toBeGreaterThan(8);
    }
    for (const c of OPTIONAL_CATEGORIES) {
      expect(CATEGORY_COPY[c].consequence.toLowerCase()).toContain("off");
    }
  });

  it("the session cookie and the consent record are NECESSARY, never optional", () => {
    // If either were ever recategorised, "reject all" would sign people out or
    // forget the rejection - the two failure modes that make a banner absurd.
    expect(categoryForKey("wd_session")).toBe("necessary");
    expect(categoryForKey(CONSENT_COOKIE)).toBe("necessary");
    expect(OPTIONAL_CATEGORIES).not.toContain("necessary");
  });

  it("the analytics id is in the analytics category, so rejecting analytics drops it", () => {
    expect(categoryForKey(ANALYTICS_COOKIE)).toBe("analytics");
    expect(entriesFor("analytics").some((e) => e.name === ANALYTICS_COOKIE)).toBe(true);
  });

  it("third-party cookies are named as third-party", () => {
    const thirdParty = COOKIE_MANIFEST.filter((e) => e.party !== "first");
    expect(thirdParty.length).toBeGreaterThan(0);
    for (const e of thirdParty) {
      expect(e.category, "a third-party tracker is never 'necessary'").not.toBe("necessary");
    }
  });
});

// ---- the consent value ------------------------------------------------------

describe("the consent record round-trips, and fails closed when it cannot", () => {
  it("encodes and decodes without loss", () => {
    const made = makeConsent({ preferences: true, analytics: false, marketing: true }, "custom", 1000);
    const back = decodeCookieConsent(encodeCookieConsent(made));
    expect(back).toEqual(made);
  });

  it("the encoded value is cookie-safe (base64url, no padding, no separators)", () => {
    const encoded = encodeCookieConsent(makeConsent(ALLOW_ALL, "accept-all"));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  for (const bad of ["", "   ", "not-base64!!", "e30", "YWJj", null, undefined]) {
    it(`refuses ${JSON.stringify(bad)} rather than inventing a consent`, () => {
      expect(decodeCookieConsent(bad as string | null)).toBeNull();
    });
  }

  it("a tampered grant set cannot widen beyond the three known categories", () => {
    const grants = normalizeGrants({
      preferences: true,
      analytics: "yes",
      marketing: 1,
      superuser: true,
    });
    expect(grants).toEqual({ preferences: true, analytics: false, marketing: false });
    expect(Object.keys(grants).sort()).toEqual(["analytics", "marketing", "preferences"]);
  });

  it("only a literal true is a grant - truthy is not consent", () => {
    expect(normalizeGrants({ analytics: "true" }).analytics).toBe(false);
    expect(normalizeGrants({ analytics: 1 }).analytics).toBe(false);
    expect(normalizeGrants({ analytics: true }).analytics).toBe(true);
  });
});

describe("allows(): no record means no", () => {
  it("necessary is always true, even with nothing recorded", () => {
    expect(allows(null, "necessary")).toBe(true);
  });

  it("every optional category is false with no record", () => {
    for (const c of OPTIONAL_CATEGORIES) expect(allows(null, c)).toBe(false);
    for (const c of OPTIONAL_CATEGORIES) expect(allows(undefined, c)).toBe(false);
  });

  it("a reject-all record denies all three", () => {
    const consent = makeConsent(DENY_ALL, "reject-all");
    for (const c of OPTIONAL_CATEGORIES) expect(allows(consent, c)).toBe(false);
    expect(deniedCategories(consent).sort()).toEqual([...OPTIONAL_CATEGORIES].sort());
  });

  it("an accept-all record grants all three and denies nothing", () => {
    const consent = makeConsent(ALLOW_ALL, "accept-all");
    for (const c of OPTIONAL_CATEGORIES) expect(allows(consent, c)).toBe(true);
    expect(deniedCategories(consent)).toEqual([]);
  });
});

describe("needsCookieChoice(): a version bump re-asks", () => {
  it("asks when there is no record", () => {
    expect(needsCookieChoice(null)).toBe(true);
  });

  it("does not ask when the record matches the current version", () => {
    expect(needsCookieChoice(makeConsent(DENY_ALL, "reject-all"))).toBe(false);
  });

  it("asks again when the policy version has moved", () => {
    const old = { ...makeConsent(ALLOW_ALL, "accept-all"), version: "1999-01-01" };
    expect(needsCookieChoice(old)).toBe(true);
  });

  it("...but the old grants still gate behaviour while the re-prompt is up", () => {
    // Otherwise a bump silently revokes a yes AND silently ignores a no for the
    // seconds before the person answers. Their last word stands until replaced.
    const oldNo = { ...makeConsent(DENY_ALL, "reject-all"), version: "1999-01-01" };
    const oldYes = { ...makeConsent(ALLOW_ALL, "accept-all"), version: "1999-01-01" };
    expect(allows(oldNo, "marketing")).toBe(false);
    expect(allows(oldYes, "marketing")).toBe(true);
  });
});

describe("cookieValueFrom parses a real Cookie header", () => {
  it("finds the value among others", () => {
    expect(cookieValueFrom("a=1; wd_cookie_prefs=abc; b=2", CONSENT_COOKIE)).toBe("abc");
  });

  it("does not match a name that merely ends with the one asked for", () => {
    expect(cookieValueFrom("not_wd_cookie_prefs=nope", CONSENT_COOKIE)).toBeNull();
  });

  it("survives a value containing '='", () => {
    expect(cookieValueFrom("wd_cookie_prefs=a=b=c", CONSENT_COOKIE)).toBe("a=b=c");
  });

  it("answers null for an absent cookie and an empty header", () => {
    expect(cookieValueFrom("", CONSENT_COOKIE)).toBeNull();
    expect(cookieValueFrom("other=1", CONSENT_COOKIE)).toBeNull();
  });
});

// ---- the advertising gate ---------------------------------------------------

describe("the ad SDK is not loaded without advertising consent", () => {
  const layout = read("src/app/layout.tsx");

  it("no unconditional <script src> for the AdSense SDK survives in the layout", () => {
    // The old shape: a bare tag in <head> that fetched on every page load.
    expect(layout).not.toMatch(/<script\s+async\s+src=\{`https:\/\/pagead2/);
  });

  it("the SDK is injected by the pre-paint gate, keyed on the marketing grant", () => {
    expect(layout).toMatch(/adConsentScript/);
    expect(layout).toMatch(/d\.g\.marketing !== true\) return;/);
    expect(layout).toMatch(/pagead2\.googlesyndication\.com/);
  });

  it("the gate reads the same cookie name the rest of the layer writes", () => {
    expect(layout).toContain("wd_cookie_prefs");
    expect(CONSENT_COOKIE).toBe("wd_cookie_prefs");
  });

  it("site VERIFICATION stays unconditional - the gate must not cost the account", () => {
    // google-adsense-account is the meta tag Google actually verifies with, and
    // it has nothing to do with consent. Removing it along with the script
    // would be the one way this change could genuinely break monetisation.
    expect(layout).toMatch(/"google-adsense-account": ADSENSE_PUBLISHER/);
  });

  it("the inline gate's base64 decode agrees with the real decoder", () => {
    // The gate cannot import decodeCookieConsent (it runs before modules), so
    // it hand-rolls the same parse. This runs the gate's exact expression
    // against a value produced by the real encoder.
    const encoded = encodeCookieConsent(
      makeConsent({ preferences: false, analytics: false, marketing: true }, "custom")
    );
    let b = encoded.replace(/-/g, "+").replace(/_/g, "/");
    b += "====".slice(b.length % 4 || 4);
    const parsed = JSON.parse(Buffer.from(b, "base64").toString("utf8"));
    expect(parsed.g.marketing).toBe(true);
    // ...and the padding expression the gate uses is the one tested here.
    expect(stripComments(layout)).toContain('b += "====".slice((b.length % 4) || 4);');
  });

  it("the ad slot itself also refuses without consent", () => {
    const banner = stripComments(read("src/components/AdBanner.tsx"));
    expect(banner).toMatch(/if \(adsAllowed !== true\) return null;/);
    expect(banner).toMatch(/clientAllows\("marketing"\)/);
  });
});

// ---- the banner's fairness --------------------------------------------------

describe("reject is exactly as easy as accept", () => {
  const banner = read("src/components/CookieConsent.tsx");

  it("both buttons exist and carry identical classes", () => {
    // Pull each button's className and compare. A restyle that makes "Accept
    // all" primary and "Reject all" a grey link is the dark pattern this
    // whole component is written against, and it arrives by restyling.
    const classesFor = (label: string) => {
      const out: string[] = [];
      const rx = new RegExp(
        `save\\("${label}"[\\s\\S]{0,400}?className="([^"]+)"`,
        "g"
      );
      for (const m of banner.matchAll(rx)) out.push(m[1]);
      return out;
    };
    const reject = classesFor("reject-all");
    const accept = classesFor("accept-all");
    expect(reject.length, "Reject all must be rendered").toBeGreaterThan(0);
    expect(accept.length).toBe(reject.length);
    for (let i = 0; i < reject.length; i++) expect(reject[i]).toBe(accept[i]);
  });

  it("neither one-tap button is styled as the preferred answer", () => {
    // btn-primary is the app's "this is the action" style. It belongs on
    // "Save my choices", which is neutral, and on neither of the other two.
    const oneTap = banner.slice(
      banner.indexOf('save("reject-all"'),
      banner.indexOf('save("custom"')
    );
    expect(oneTap).not.toMatch(/btn-primary/);
  });

  it("the banner has no dismiss that records nothing", () => {
    // No ✕ on the banner (the PANEL has one, and only because a recorded
    // choice already sits behind it).
    const bannerBlock = banner.slice(
      banner.indexOf("const banner ="),
      banner.indexOf("const panel =")
    );
    expect(bannerBlock).not.toMatch(/setShowBanner\(false\)/);
    expect(bannerBlock).not.toContain("✕");
  });

  // Comments stripped for the markup assertions: the file DISCUSSES the
  // layers it must not use ("below the terms gate (layer-veil)"), so a raw
  // search finds the prose rather than the class.
  const code = stripComments(banner);
  const bannerBlock = code.slice(code.indexOf("const banner ="), code.indexOf("const panel ="));
  const panelBlock = code.slice(code.indexOf("const panel ="));

  it("the banner does not lock the page behind it", () => {
    expect(bannerBlock).not.toMatch(/lockBodyScroll/);
    expect(bannerBlock).not.toMatch(/inset-0/);
  });

  it("the banner sits above the bottom chrome instead of on top of it", () => {
    // Pinned to bottom-0 it covered the tab bar and made the live-status
    // panel's expander chevron untappable (scripts/mobile-check.mjs caught
    // it). A banner that eats the app's own navigation gets dismissed to get
    // the app back, and a dismissal under pressure is not a choice.
    expect(bannerBlock).toMatch(/bottom: "var\(--stack-bottom-2\)"/);
    expect(bannerBlock).not.toMatch(/\bbottom-0\b/);
  });

  it("the banner is below every dialog, and the panel below the terms gate", () => {
    // layer-coach (900) < layer-overlay (1200) < layer-veil (1400). The terms
    // gate is the acceptance that actually blocks the app, and nothing this
    // component renders may cover it.
    expect(bannerBlock).toMatch(/className="layer-coach/);
    expect(panelBlock).toMatch(/className="layer-overlay/);
    expect(code).not.toMatch(/className="layer-veil/);
    expect(stripComments(read("src/components/FirstTouchTerms.tsx"))).toMatch(
      /className="layer-veil/
    );
  });

  it("the choice is applied locally before the network call, so it survives a dead connection", () => {
    const save = banner.slice(banner.indexOf("const save ="), banner.indexOf("if (!showBanner"));
    expect(save.indexOf("writeConsentCookie")).toBeLessThan(save.indexOf("await fetch"));
    expect(save.indexOf("purgeDenied")).toBeLessThan(save.indexOf("await fetch"));
  });

  it("withdrawal is reachable forever - the footer opens the same panel", () => {
    const footer = read("src/components/SiteFooter.tsx");
    expect(footer).toMatch(/openCookiePanel/);
  });
});

// ---- the ledger -------------------------------------------------------------

describe("the cookie choice is recorded in the same ledger as every other consent", () => {
  it("the two new kinds exist, and analytics is NOT duplicated", () => {
    expect(CONSENT_KINDS).toContain("cookies_preferences");
    expect(CONSENT_KINDS).toContain("cookies_marketing");
    // One purpose, two doors. A `cookies_analytics` kind would mean the banner
    // and Profile could disagree about whether analytics is on.
    expect(CONSENT_KINDS).not.toContain("cookies_analytics");
    expect(CONSENT_KINDS).toContain("analytics");
  });

  it("all three are opt-IN, so a withdrawal is togglable from Profile too", () => {
    for (const k of ["analytics", "cookies_preferences", "cookies_marketing"]) {
      expect(OPT_IN_KINDS).toContain(k);
    }
  });

  it("the route writes one row per category, including unchanged ones", () => {
    // A ledger of deltas cannot answer "what was this person's marketing
    // consent on a given date" without replaying everything before it.
    const server = stripComments(read("src/lib/cookies/server.ts"));
    expect(server).toMatch(/Object\.keys\(CATEGORY_CONSENT_KIND\)/);
    expect(server).toMatch(/results\.every\(Boolean\)/);
  });

  it("the profile toggle pulls the cookie along, so the two doors cannot disagree", () => {
    const route = stripComments(read("src/app/api/profile/consent/route.ts"));
    expect(route).toMatch(/CATEGORY_CONSENT_KIND/);
    expect(route).toMatch(/setConsentCookie/);
  });

  it("...but it never answers the banner on the person's behalf", () => {
    // Minting a fresh current-version cookie from a profile toggle would mean
    // they are never asked about preferences or advertising.
    const route = stripComments(read("src/app/api/profile/consent/route.ts"));
    expect(route).toMatch(/if \(category && current\)/);
    expect(route).not.toMatch(/makeConsent/);
  });

  it("an erasure clears the cookies, not only the rows", () => {
    const erase = stripComments(read("src/app/api/profile/erase/route.ts"));
    expect(erase).toMatch(/clearCookieConsentCookies\(\)/);
  });

  it("the analytics rows land in a table the erasure registry already walks", () => {
    const registry = read("src/lib/privacy/user-tables.ts");
    expect(registry).toMatch(/table: "product_events"/);
    expect(registry).toMatch(/table: "consent_events"/);
    const events = stripComments(read("src/lib/analytics/events.ts"));
    expect(events).toMatch(/sbInsert\("product_events"/);
  });
});

// ---- the collection itself --------------------------------------------------

describe("what the beacon is allowed to collect", () => {
  it("only names on the allow-list are events", () => {
    expect(isAnalyticsEvent("screen_view")).toBe(true);
    expect(isAnalyticsEvent("steal_everything")).toBe(false);
    expect(isAnalyticsEvent("")).toBe(false);
    expect(isAnalyticsEvent(null)).toBe(false);
    // Prototype keys are not events either.
    expect(isAnalyticsEvent("toString")).toBe(false);
    expect(isAnalyticsEvent("constructor")).toBe(false);
  });

  it("every event name published on /cookies is one the server accepts", () => {
    for (const name of Object.keys(ANALYTICS_EVENTS)) {
      expect(isAnalyticsEvent(name)).toBe(true);
    }
  });

  it("every advertised event is actually emitted somewhere in the app", () => {
    // THE DISCLOSURE MUST NOT OVERSTATE EITHER WAY. /cookies calls this list
    // "the complete list of what is recorded"; an event on it that nothing
    // ever fires makes the page describe collection that does not happen, and
    // a page that is wrong in the harmless direction today is a page nobody
    // trusts to be right in the other direction tomorrow. The allow-list and
    // the call sites have to be the same set.
    const app = sourceFiles()
      .filter((f) => !f.startsWith("src/lib/analytics/"))
      .map((f) => stripComments(read(f)))
      .join("\n");
    const unfired = Object.keys(ANALYTICS_EVENTS).filter(
      (name) => !new RegExp(`track(?:Screen)?\\(\\s*"${name}"`).test(app) && name !== "screen_view"
    );
    // screen_view is fired by trackScreen(path) with no literal name, so it is
    // checked directly rather than by the grep above.
    expect(stripComments(read("src/lib/client/analytics.ts"))).toMatch(
      /track\("screen_view"/
    );
    expect(
      unfired,
      "these are advertised on /cookies but nothing calls track() with them - " +
        "either wire them up or remove them from ANALYTICS_EVENTS"
    ).toEqual([]);
  });

  it("the query string never reaches the store", () => {
    // It is where a search term, a hotel name and a booking reference live.
    expect(normalizePath("/deals?q=Kata%20Beach&from=hotel")).toBe("/deals");
    expect(normalizePath("https://wheeldeal.app/deals?q=secret")).toBe("/deals");
    expect(normalizePath("/deals#frag")).toBe("/deals");
  });

  it("identifiers in the path are masked", () => {
    expect(normalizePath("/deals/7f3a9c21-aaaa")).toBe("/deals/:id");
    expect(normalizePath("/bookings/4821")).toBe("/bookings/:id");
    expect(normalizePath("/h/averyveryverylongopaqueslugvalue")).toBe("/h/:id");
  });

  it("ordinary route names survive so the data is still worth having", () => {
    expect(normalizePath("/profile")).toBe("/profile");
    expect(normalizePath("/admin")).toBe("/admin");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("welcome")).toBe("/welcome");
  });

  it("props are scalars only, bounded, and nested objects are dropped not flattened", () => {
    const props = sanitizeProps({
      count: 3,
      ok: true,
      label: "x".repeat(500),
      nested: { secret: "no" },
      list: [1, 2, 3],
      "bad key": "dropped",
      __proto__: { polluted: true },
    });
    expect(props.count).toBe(3);
    expect(props.ok).toBe(true);
    expect(String(props.label).length).toBeLessThanOrEqual(120);
    expect(props.nested).toBeUndefined();
    expect(props.list).toBeUndefined();
    expect(props["bad key"]).toBeUndefined();
    expect((props as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a path prop is normalised even when a caller passes a full URL", () => {
    expect(sanitizeProps({ path: "https://x.dev/deals/991?q=a" }).path).toBe("/deals/:id");
  });

  it("props are capped so one event cannot become a document", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 40; i++) wide[`k${i}`] = "v";
    expect(Object.keys(sanitizeProps(wide)).length).toBeLessThanOrEqual(8);
  });

  it("non-objects sanitize to nothing rather than throwing", () => {
    expect(sanitizeProps(null)).toEqual({});
    expect(sanitizeProps("string")).toEqual({});
    expect(sanitizeProps([1, 2])).toEqual({});
  });
});

describe("the beacon refuses before it writes", () => {
  const route = stripComments(read("src/app/api/analytics/collect/route.ts"));

  it("a session is required - there are no anonymous behavioural rows", () => {
    expect(route).toMatch(/if \(!session\?\.email\)/);
  });

  it("consent is checked through the both-gates helper, not re-derived", () => {
    expect(route).toMatch(/await analyticsAllowed\(session\.email\)/);
  });

  it("the refusals are 200s with a reason, so a normal 'no' is not console noise", () => {
    expect(route).toMatch(/reason: "no-consent"/);
    expect(route).toMatch(/reason: "no-session"/);
  });

  it("it reports whether the row actually STORED, rather than assuming", () => {
    expect(route).toMatch(/stored: result\.stored === true/);
  });

  it("the client tracker drops events at track() when consent is absent", () => {
    const tracker = stripComments(read("src/lib/client/analytics.ts"));
    expect(tracker).toMatch(/if \(!clientAllows\("analytics"\)\) return false;/);
    // ...and throws away what is already buffered on a withdrawal.
    expect(tracker).toMatch(/buffer = \[\];/);
    expect(tracker).toMatch(/COOKIE_CONSENT_EVENT/);
  });
});

// ---- the policy page cannot drift ------------------------------------------

describe("the published policy is generated, not written", () => {
  const page = read("src/app/cookies/page.tsx");

  it("the /cookies table renders the manifest itself", () => {
    expect(page).toMatch(/entriesFor\(category\)/);
    expect(page).toMatch(/COOKIE_CATEGORIES\.map/);
    // No hand-written cookie names in the page - that is the drift this avoids.
    for (const e of COOKIE_MANIFEST) {
      if (e.name.includes(",")) continue; // the Google family, named as a group
      expect(page, `${e.name} is hard-coded in the page instead of coming from the manifest`)
        .not.toContain(`"${e.name}"`);
    }
  });

  it("the collected-events list is the server's own allow-list", () => {
    expect(page).toMatch(/Object\.entries\(ANALYTICS_EVENTS\)/);
  });

  it("the privacy policy names cookies and points at the generated page", () => {
    const legal = read("src/lib/legal.ts");
    expect(legal).toMatch(/title: "Cookies and what is stored in your browser"/);
    expect(legal).toMatch(/\/cookies/);
    // The version bump is what puts every existing user through the new text.
    expect(legal).toMatch(/TERMS_VERSION = "2026-09-16"/);
  });

  it("the policy version is a date, so 'which text did they see' is answerable", () => {
    expect(COOKIE_POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("the disclosure is translated, not English-only", () => {
  // The manifest copy reaches the screen as t(e.purpose) / t(copy.blurb), so
  // the generator's grep for literal t("...") calls cannot find it. i18n-extras
  // is the declared-copy mechanism for exactly that case, and a banner that
  // shows a Thai traveller a wall of English is not a disclosure they can act
  // on - it is the thing they tap past.
  const extras = read("src/lib/i18n-extras.ts");
  const catalogue = read("src/lib/i18n-catalog.ts");

  const strings = [
    ...COOKIE_CATEGORIES.flatMap((c) => [
      CATEGORY_COPY[c].title,
      CATEGORY_COPY[c].blurb,
      CATEGORY_COPY[c].consequence,
    ]),
    ...COOKIE_MANIFEST.flatMap((e) => [e.purpose, e.duration]),
  ];

  it("every manifest string is declared in i18n-extras", () => {
    const missing = strings.filter((s) => !extras.includes(JSON.stringify(s)));
    expect(
      missing,
      "add these to I18N_EXTRAS and re-run `node scripts/gen-i18n-catalog.js`"
    ).toEqual([]);
  });

  it("...and has reached the generated catalogue", () => {
    const missing = strings.filter((s) => !catalogue.includes(JSON.stringify(s)));
    expect(missing, "run `node scripts/gen-i18n-catalog.js`").toEqual([]);
  });
});
