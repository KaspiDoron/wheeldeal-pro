import { describe, it, expect } from "vitest";
import { OSM_TILES, TILE_CLASS, resolveMapTiles, tilesForTheme } from "../map-tiles";
import { readFileSync } from "fs";
import { join } from "path";

// DARK THEME ACTIVATION (owner report 3, item 1).
//
// The dark theme largely EXISTED - [data-theme="dark"] token blocks, a
// Profile control, a prehydrate script - and still the owner's phone showed a
// white Find-deals screen inside an otherwise dark app. The failures were all
// wiring: tailwind's `dark:` utilities keyed on the OS while the tokens keyed
// on the attribute (split-brain), the `warn` color classes compiled to
// nothing, the prehydrate could be skipped whole by a storage exception, and
// no toggle was reachable outside Profile. These pins hold the wiring.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("one switch drives both theme systems", () => {
  it("tailwind dark: utilities key on data-theme, not the OS", () => {
    expect(read("tailwind.config.ts")).toMatch(
      /darkMode: \["selector", '\[data-theme="dark"\]'\]/
    );
  });

  it("the warn color exists everywhere its classes are already used", () => {
    expect(read("tailwind.config.ts")).toMatch(
      /warn: \{ DEFAULT: "var\(--warn\)", soft: "var\(--warn-soft\)" \}/
    );
    const css = read("src/app/globals.css");
    // Once per theme surface: light root, dark attribute, dark media fallback.
    expect(css.match(/--warn:/g)?.length).toBe(3);
    expect(css.match(/--warn-soft:/g)?.length).toBe(3);
  });

  it("the hand-rolled amber pair is gone from the components", () => {
    // 60+ occurrences of `text-[#8a6100] dark:text-brandyellow` became
    // text-warn. The one survivor (WabaConsole) sits on SOLID bg-brandyellow
    // where the dark warn yellow would vanish - deliberate, and bounded to 1.
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync(
      `grep -rc 'dark:text-brandyellow' src --include='*.tsx' | grep -v ':0' || true`,
      { cwd: process.cwd(), encoding: "utf8" }
    ).trim();
    expect(hits).toBe("");
  });

  it("native widgets follow the app theme (color-scheme on both blocks)", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/color-scheme: light;/);
    expect(css.match(/color-scheme: dark;/g)?.length).toBe(2);
  });

  it("the no-JS media fallback mirrors the dark block EXACTLY", () => {
    const css = read("src/app/globals.css");
    const decls = (block: string) =>
      Object.fromEntries(
        [...block.matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
      );
    const darkStart = css.indexOf('[data-theme="dark"] {');
    const darkBlock = css.slice(darkStart, css.indexOf("}", darkStart));
    const mediaStart = css.indexOf(":root:not([data-theme]) {");
    const mediaBlock = css.slice(mediaStart, css.indexOf("}", mediaStart));
    expect(mediaStart).toBeGreaterThan(-1);
    expect(decls(mediaBlock)).toEqual(decls(darkBlock));
  });

  it("nothing selects the html.dark class nothing ever sets", () => {
    expect(read("src/app/globals.css")).not.toMatch(/html\.dark/);
  });
});

describe("the prehydrate survives a blocked localStorage", () => {
  const layout = read("src/app/layout.tsx");

  it("the storage read is isolated; the stamp always runs", () => {
    // One shared try/catch made a storage exception skip the attribute
    // entirely - a dark-OS private-mode visitor landed on the light theme.
    expect(layout).toMatch(/var t = null;\s*\n\s*try \{ t = localStorage\.getItem\("wd_theme"\); \} catch \(e\) \{\}/);
    expect(layout).toMatch(/if \(t !== "dark" && t !== "light"\)/);
    expect(layout).toMatch(/prefers-color-scheme: dark/);
    expect(layout).toMatch(/setAttribute\("data-theme", t\)/);
  });
});

describe("every control changes the theme through the one lib", () => {
  it("ThemeToggle and Profile both call applyTheme", () => {
    expect(read("src/components/ThemeToggle.tsx")).toMatch(
      /import \{ readTheme, applyTheme, type Theme \} from "@\/lib\/client\/theme"/
    );
    const profile = read("src/app/profile/page.tsx");
    expect(profile).toMatch(/import \{ readTheme, applyTheme \} from "@\/lib\/client\/theme"/);
    expect(profile).toMatch(/applyTheme\(t2\);/);
    // The old inline implementation is gone.
    expect(profile).not.toMatch(/localStorage\.setItem\("wd_theme"/);
  });

  it("applyTheme repaints the live theme-color meta", () => {
    const lib = read("src/lib/client/theme.ts");
    expect(lib).toMatch(/meta\[name="theme-color"\]/);
    // The two colors mirror the --bg tokens.
    expect(lib).toMatch(/#f4f6f9/);
    expect(lib).toMatch(/#17191d/);
  });

  it("the toggle is in every topbar, beside the language chip", () => {
    for (const p of [
      "src/app/page.tsx",
      "src/app/deals/page.tsx",
      "src/app/profile/page.tsx",
      "src/app/admin/page.tsx",
      "src/app/login/page.tsx",
    ]) {
      expect(read(p), p).toMatch(/<ThemeToggle \/>/);
    }
  });
});

describe("the map follows the theme", () => {
  it("both map surfaces read the live theme and re-key on a provider swap", () => {
    for (const p of ["src/components/MapView.tsx", "src/components/OriginPinPicker.tsx"]) {
      const map = read(p);
      expect(map, p).toMatch(/useAppTheme\(\)/);
      // Keyed on theme AND url: a keyless single-source basemap changes only
      // its className between themes, and a provider swap arriving from
      // /api/config/public must recreate the layer either way.
      expect(map, p).toMatch(/key=\{`\$\{theme\}\|\$\{tileUrl\}`\}/);
    }
  });

  it("dark tiles are produced for whichever provider is configured", () => {
    // EXECUTED, not grepped. The previous version pinned the literal CARTO
    // dark_all URL - which stopped being the default the day CARTO began
    // requiring a key and watermarking keyless tiles.
    const dark = tilesForTheme(OSM_TILES, "dark");
    const light = tilesForTheme(OSM_TILES, "light");
    // One source, two treatments: the filter class is the dark cartography.
    expect(dark.url).toBe(light.url);
    expect(dark.className).toBe(TILE_CLASS);
    expect(light.className).toBe("");

    // A keyed provider ships REAL dark cartography and must never be filtered.
    const carto = resolveMapTiles({ key: "abc123" });
    expect(carto.darkUrl).toMatch(/dark_all/);
    expect(carto.filterDark).toBe(false);
    const cartoDark = tilesForTheme(carto, "dark");
    expect(cartoDark.url).toMatch(/dark_all/);
    expect(cartoDark.className).toBe("");
    expect(tilesForTheme(carto, "light").url).toMatch(/voyager/);
  });

  it("the keyless default carries no api key and cannot be watermarked", () => {
    expect(OSM_TILES.url).not.toMatch(/\?|key=/);
    expect(OSM_TILES.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\//);
    // OSMF retired the {s}. subdomain form; using it now is a policy breach.
    expect(OSM_TILES.url).not.toContain("{s}");
    expect(OSM_TILES.attribution).toContain("OpenStreetMap");
  });

  it("an explicit url override wins, and a single-source override is filtered", () => {
    const one = resolveMapTiles({ url: "https://x/{z}/{x}/{y}.png" });
    expect(one.url).toBe("https://x/{z}/{x}/{y}.png");
    expect(one.filterDark).toBe(true);
    const two = resolveMapTiles({
      url: "https://x/{z}/{x}/{y}.png",
      darkUrl: "https://x/dark/{z}/{x}/{y}.png",
    });
    expect(two.filterDark).toBe(false);
    expect(tilesForTheme(two, "dark").url).toContain("/dark/");
  });

  it("the canvas behind the tiles, the filter, and the attribution all follow", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\[data-theme="dark"\] \.leaflet-container \{ background: #17191d !important; \}/);
    expect(css).toMatch(/\[data-theme="dark"\] \.leaflet-control-attribution \{/);
    expect(css).toContain(`.${TILE_CLASS} {`);
    expect(css).toMatch(/filter: invert\(100%\)/);
  });

  it("the pin picker credits the tile provider - it used to credit nobody", () => {
    const picker = read("src/components/OriginPinPicker.tsx");
    expect(picker).not.toMatch(/attributionControl=\{false\}/);
    expect(picker).toMatch(/attribution=\{tiles\.attribution\}/);
  });
});
