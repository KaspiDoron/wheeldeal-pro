// A CHOICE MADE MID-SESSION HAS TO TAKE EFFECT MID-SESSION.
//
// The pre-paint gate only runs on a page load. Two things fell through that:
//   - tapping "Accept" loaded nothing until the NEXT full page load, so the
//     landing pageview - the one that matters for a content page - never
//     carried an ad;
//   - tapping advertising OFF left Google's script and its iframes running in
//     the page, because nothing removed them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConsent } from "./consent";
import { syncAdConsent } from "./ad-sdk";
import { AD_SDK_MARKER } from "./prepaint";

const g = globalThis as unknown as Record<string, unknown>;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let appended: { src: string; attrs: Record<string, string> }[] = [];
let existingSdk = false;
let publisherMeta: string | null = "ca-pub-0000000000000000";

function fakePage(opts: { gpc?: boolean } = {}) {
  appended = [];
  const win: Record<string, unknown> = { dataLayer: [] };
  g.window = win;
  // Node defines `navigator` as a getter-only global, so a plain assignment
  // throws. Redefine it, and put the original back afterwards.
  Object.defineProperty(globalThis, "navigator", {
    value: { globalPrivacyControl: opts.gpc === true },
    configurable: true,
    writable: true,
  });
  g.document = {
    querySelector: (sel: string) => {
      if (sel.includes(AD_SDK_MARKER)) return existingSdk ? {} : null;
      if (sel.includes("google-adsense-account")) return publisherMeta ? { getAttribute: () => publisherMeta } : null;
      return null;
    },
    createElement: () => ({ src: "", attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } }),
    head: { appendChild: (el: { src: string; attrs: Record<string, string> }) => appended.push(el) },
  };
}

const layer = () => ((g.window as { dataLayer: unknown[] }).dataLayer).map((a) => Array.from(a as ArrayLike<unknown>));
const yes = makeConsent({ preferences: true, analytics: true, marketing: true }, "accept-all");
const no = makeConsent({ preferences: false, analytics: false, marketing: false }, "reject-all");

beforeEach(() => {
  existingSdk = false;
  publisherMeta = "ca-pub-0000000000000000";
  fakePage();
});
afterEach(() => {
  for (const k of ["window", "document"]) delete g[k];
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
});

describe("granting advertising mid-session", () => {
  it("tells Google's tags, then loads the SDK once - no reload needed", () => {
    expect(syncAdConsent(yes, false)).toBe("loaded");
    expect(layer()).toContainEqual([
      "consent",
      "update",
      { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted", analytics_storage: "granted" },
    ]);
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toContain("client=ca-pub-0000000000000000");
    expect(appended[0].attrs[AD_SDK_MARKER]).toBe("1");
  });

  // Loading the AdSense SDK twice is a policy violation and breaks slot fill.
  it("never loads a second copy when the pre-paint gate already loaded one", () => {
    existingSdk = true;
    expect(syncAdConsent(yes, true)).toBe("none");
    expect(appended).toEqual([]);
  });

  it("loads nothing under a Global Privacy Control signal, and says denied", () => {
    fakePage({ gpc: true });
    expect(syncAdConsent(yes, false)).toBe("none");
    expect(appended).toEqual([]);
    expect(layer()[0][2]).toMatchObject({ ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  });

  it("loads nothing when the page carries no valid publisher id", () => {
    publisherMeta = "not-a-publisher";
    expect(syncAdConsent(yes, false)).toBe("none");
    expect(appended).toEqual([]);
  });
});

describe("withdrawing advertising mid-session", () => {
  it("says denied and asks for a reload - the only way to get a running SDK out of a page", () => {
    existingSdk = true;
    expect(syncAdConsent(no, true)).toBe("reload");
    expect(layer()).toContainEqual([
      "consent",
      "update",
      { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" },
    ]);
  });

  it("does not reload a page that never had advertising on", () => {
    expect(syncAdConsent(no, false)).toBe("none");
  });
});
