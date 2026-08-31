import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { ADSENSE_PUBLISHER, ADSENSE_PUB_ID } from "./site";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// AN AD SURFACE THAT LOOKED FINISHED AND EARNED NOTHING.
//
// The free tier reserved 100px on three screens, rendered "Sponsored", showed a
// placeholder, and loaded the AdSense SDK site-wide. Everything an ad needs
// except the one field that says WHICH ad: `data-ad-slot` was rendered only
// when a caller passed a `slot` prop, and none of the three call sites ever
// did. Google had a publisher and no unit, so nothing could ever fill.
//
// The symptom is indistinguishable from "still under review", which is exactly
// what the placeholder said, so the failure could sit there indefinitely.

describe("REPRODUCTION: the banner had a publisher but no ad unit", () => {
  const ad = readCode("src/components/AdBanner.tsx");

  it("the slot comes from configuration, not from a prop nobody passes", () => {
    expect(ad).toMatch(/const adSlot = slot \?\? unit;/);
    // W8 #19: the value now arrives through the shared single-flight loader
    // (lib/client/public-config) instead of a third independent fetch of the
    // same force-dynamic endpoint - but it is still the CONFIGURED slot.
    expect(ad).toMatch(/setUnit\(d\.adsenseSlot\)/);
    expect(ad).toMatch(/loadPublicConfig\(\)/);
  });

  it("data-ad-slot is always rendered when there is a unit", () => {
    expect(ad).toMatch(/data-ad-slot=\{adSlot\}/);
    // The old shape: undefined unless a caller opted in.
    expect(ad).not.toMatch(/data-ad-slot=\{slot !== "auto"/);
  });

  it("no <ins> is claimed without a unit - an empty claim cannot fill", () => {
    expect(ad).toMatch(/\{client && adSlot && \(/);
    expect(ad).toMatch(/if \(!client \|\| !adSlot \|\| pushed\.current\) return;/);
  });

  it("...and an unconfigured banner renders NOTHING rather than an empty frame", () => {
    // This used to assert that the placeholder distinguished "waiting on
    // Google" from "waiting on the owner". W-4 removed the placeholder
    // entirely, and that is the stronger answer to the same problem: a
    // labelled, permanently unfilled 100px slot is itself an AdSense rejection
    // signal, and the distinction it was drawing is an OWNER diagnostic that
    // belongs in Admin -> Keys (asserted below), not in a traveller's results
    // list. No client or no unit now means no frame at all.
    expect(ad).toMatch(/if \(!client \|\| !adSlot\) return null;/);
    expect(ad).not.toMatch(/Ad space/);
  });

  it("the space is reserved either way, so configuring the unit shifts no layout", () => {
    // CLS: the 100px is on the wrapper, not on the <ins>, so it exists before
    // the config fetch resolves and before Google fills.
    expect(ad).toMatch(/style=\{\{ minHeight: 100 \}\}/);
  });
});

describe("the owner can set it without a redeploy, like every other integration", () => {
  it("ADSENSE_SLOT is an editable Key Vault entry with a help link", () => {
    // The registry and its help-url map are module-private, so this reads the
    // source rather than widening config.ts's surface for a test.
    const cfg = readCode("src/lib/config.ts");
    // secret: false - an ad-unit id ships in the page source; masking it in
    // the vault only made it uncorrectable.
    expect(cfg).toMatch(
      /\{ name: "ADSENSE_SLOT", label: "[^"]+", scope: "billing", editable: true, secret: false \}/
    );
    // NB: readCode strips `//`, which eats a URL's own protocol slashes - so
    // this reads the raw file for the help link.
    const raw = readFileSync(join(process.cwd(), "src/lib/config.ts"), "utf8");
    expect(raw).toMatch(/ADSENSE_SLOT: "https:\/\/www\.google\.com\/adsense\//);
  });

  it("the public config serves it, trimmed, and null rather than empty", () => {
    const route = readCode("src/app/api/config/public/route.ts");
    expect(route).toMatch(/getConfig\("ADSENSE_SLOT"\)/);
    expect(route).toMatch(/adsenseSlot: \(adsenseSlot \?\? ""\)\.trim\(\) \|\| null,/);
  });
});

describe("the publisher side was already right and stays that way", () => {
  it("one SDK load, site-wide, with the publisher the ads.txt names", () => {
    expect(ADSENSE_PUBLISHER).toBe("ca-pub-4965894186804157");
    expect(ADSENSE_PUB_ID).toBe("pub-4965894186804157");
    const adsTxt = readFileSync(join(process.cwd(), "public/ads.txt"), "utf8");
    expect(adsTxt).toContain(`google.com, ${ADSENSE_PUB_ID}, DIRECT, f08c47fec0942fa0`);
  });

  it("paid plans see no ad markup at all", () => {
    const ad = readCode("src/components/AdBanner.tsx");
    expect(ad).toMatch(/const free = !plan \|\| plan === "free";/);
    expect(ad).toMatch(/if \(!free\) return null;/);
    // ...and the config fetch does not even fire for them.
    expect(ad).toMatch(/if \(!free\) return;/);
  });
});
