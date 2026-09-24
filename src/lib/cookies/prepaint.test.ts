// THE PRE-PAINT GATE, EXECUTED - not grepped.
//
// This script decides, before anything else on the page runs, whether Google's
// ad SDK is fetched. It used to live as a string inside layout.tsx where a test
// could only pattern-match its source. Here it is run for real in a sandbox
// with a fake document, so what is pinned is what it DOES.

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { encodeCookieConsent, makeConsent, type CookieGrants } from "./consent";
import { AD_SDK_MARKER, buildAdConsentScript } from "./prepaint";

const PUBLISHER = "ca-pub-0000000000000000";

function run(opts: { cookie?: string; gpc?: boolean }) {
  const appended: { src: string; attrs: Record<string, string> }[] = [];
  const sandbox: Record<string, unknown> = {
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    JSON,
    navigator: { globalPrivacyControl: opts.gpc === true },
    document: {
      cookie: opts.cookie ?? "",
      createElement: () => {
        const el = { src: "", async: false, crossOrigin: "", attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
        return el;
      },
      head: { appendChild: (el: { src: string; attrs: Record<string, string> }) => appended.push(el) },
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(buildAdConsentScript(PUBLISHER), sandbox);
  const layer = ((sandbox.dataLayer as unknown[]) ?? []).map((a) => Array.from(a as ArrayLike<unknown>));
  return { appended, layer };
}

const cookieFor = (grants: CookieGrants) =>
  `other=1; wd_cookie_prefs=${encodeCookieConsent(makeConsent(grants, "custom"))}; x=y`;

const DENIED = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" };

describe("the pre-paint advertising gate", () => {
  it("a visitor who has not answered: everything denied, nothing fetched", () => {
    const { appended, layer } = run({});
    expect(appended).toEqual([]);
    expect(layer).toEqual([["consent", "default", DENIED]]);
  });

  it("advertising granted: the default still goes first, then the grant, then the SDK", () => {
    const { appended, layer } = run({ cookie: cookieFor({ preferences: false, analytics: false, marketing: true }) });
    expect(layer[0][1]).toBe("default");
    expect(layer[0][2]).toMatchObject(DENIED);
    expect(layer[1]).toEqual(["consent", "update", { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" }]);
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe(`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${PUBLISHER}`);
    expect(appended[0].attrs[AD_SDK_MARKER]).toBe("1");
  });

  it("analytics only: analytics storage is granted, advertising is not, no SDK", () => {
    const { appended, layer } = run({ cookie: cookieFor({ preferences: true, analytics: true, marketing: false }) });
    expect(appended).toEqual([]);
    expect(layer).toHaveLength(2);
    expect(layer[1]).toEqual(["consent", "update", { analytics_storage: "granted" }]);
  });

  // Global Privacy Control is a legally recognised opt-out of sale/sharing in a
  // growing list of US states. A stored "yes" from months ago does not outrank
  // a browser that is saying "no" on this very request.
  it("a Global Privacy Control signal beats a stored yes", () => {
    const { appended, layer } = run({ cookie: cookieFor({ preferences: true, analytics: true, marketing: true }), gpc: true });
    expect(appended).toEqual([]);
    expect(layer.some((e) => e[1] === "update" && (e[2] as Record<string, string>).ad_storage === "granted")).toBe(false);
    // ...but it is an ADVERTISING signal. First-party analytics consent stands.
    expect(layer).toContainEqual(["consent", "update", { analytics_storage: "granted" }]);
  });

  it("fails closed on anything it cannot read", () => {
    for (const cookie of ["wd_cookie_prefs=", "wd_cookie_prefs=%%%", "wd_cookie_prefs=bm90LWpzb24", "wd_cookie_prefs=e30"]) {
      const { appended, layer } = run({ cookie });
      expect(appended, cookie).toEqual([]);
      expect(layer, cookie).toHaveLength(1);
      expect(layer[0][1]).toBe("default");
    }
  });

  it("does not grant on a truthy non-boolean - only `true` is a yes", () => {
    const forged = Buffer.from(JSON.stringify({ v: "x", t: 1, s: "custom", g: { marketing: "true" } })).toString("base64url");
    expect(run({ cookie: `wd_cookie_prefs=${forged}` }).appended).toEqual([]);
  });
});
