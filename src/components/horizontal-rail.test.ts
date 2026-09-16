import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// THE REAL HORIZONTAL MODE (owner report 3, item 12).
//
// "There is still not a horizontal scroll of the vendor cards!" - because
// what shipped was QuotesRail, a compact strip of price quotes, not the
// cards. This is the actual thing: the SAME VendorCard the vertical feed
// renders, one per snap stop, with a persisted toggle between the two axes.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the rail is a real horizontal scroller", () => {
  const rail = readCode("src/components/HorizontalVendorRail.tsx");

  it("the STRIP scrolls, never the page (the 320px rule)", () => {
    expect(rail).toMatch(/overflow-x-auto/);
    expect(rail).toMatch(/overscroll-x-contain/);
    expect(rail).toMatch(/no-scrollbar/);
  });

  it("cards snap, one per stop, phone-width capped", () => {
    expect(rail).toMatch(/snap-x snap-mandatory/);
    expect(rail).toMatch(/w-\[85vw\] max-w-\[360px\] shrink-0 snap-center/);
  });

  it("it renders whatever card the page hands it - no second card implementation", () => {
    expect(rail).toMatch(/renderCard\(v, i\)/);
    expect(rail).not.toMatch(/VendorCard/);
  });
});

describe("both axes render the identical card", () => {
  const page = readCode("src/app/page.tsx");

  it("ONE renderVendorCard closure feeds both lists", () => {
    expect(page).toMatch(/const renderVendorCard = \(v: Vendor, i: number\) =>/);
    expect(page).toMatch(/<HorizontalVendorRail vendors=\{filtered\} renderCard=\{renderVendorCard\} \/>/);
    expect(page).toMatch(/renderCard=\{renderVendorCard\}\s*\n\s*\/>/);
    // The old inline duplicate is gone - VendorCard is mounted through the
    // shared closure only (map strip and dashboards render their own
    // surfaces, not VendorCard).
    expect((page.match(/<VendorCard/g) ?? []).length).toBe(1);
  });

  it("the choice is remembered like the language is", () => {
    expect(page).toMatch(/localStorage\.getItem\("wd_list_axis"\)/);
    // The WRITE goes through the cookie-consent gate now (rememberLocal), like
    // every other browser-storage write in the app - `wd_list_axis` is a
    // declared `preferences` key, so a traveller who declined that category
    // still gets the axis they tapped, it just is not kept for next time. The
    // READ is deliberately ungated: see the note in lib/cookies/client.ts.
    expect(page).toMatch(/rememberLocal\("wd_list_axis", a\)/);
    // Default stays the vertical feed - the axis only flips on an explicit
    // stored choice.
    expect(page).toMatch(/useState<"vertical" \| "horizontal">\("vertical"\)/);
  });

  it("a status-panel jump centres the card INSIDE the rail, not the page", () => {
    expect(page).toMatch(/inline: "center", block: "nearest"/);
    // The vertical branch keeps its virtualizer pre-scroll.
    expect(page).toMatch(/setScrollRequest\(\{ index: idx/);
  });

  it("the toggle lives in the STICKY views bar, list view only (owner report 4)", () => {
    // It used to ride the end of the sort row's horizontal scroller - behind
    // five sort chips, off-screen at 320px. The views bar is always visible;
    // the pair is its second row, rendered only when the list view is active.
    expect(page).toMatch(/setListAxis\("vertical"\)/);
    expect(page).toMatch(/setListAxis\("horizontal"\)/);
    const views = page.indexOf('data-tour="views"');
    const axisRow = page.indexOf('setListAxis("vertical")');
    const filtersMount = page.indexOf("<Filters");
    expect(views).toBeGreaterThan(0);
    expect(axisRow, "the axis pair renders inside the views bar").toBeGreaterThan(views);
    expect(axisRow, "the axis pair renders BEFORE the filters strip").toBeLessThan(filtersMount);
    expect(page).toMatch(/\{view === "list" && \(\s*\n\s*<div className="mt-1 flex items-center gap-1 border-t/);
    // And the sort row no longer carries it - one home, not two.
    const filters = readCode("src/components/Filters.tsx");
    expect(filters).not.toMatch(/onAxis/);
  });

  it("the quotes strip yields in horizontal mode - two stacked rails is not a layout", () => {
    expect(page).toMatch(/\{listAxis === "vertical" && \(\s*\n\s*<QuotesRail/);
  });
});
