// AUDIT F121 - the photo carousel must work in Hebrew and Arabic.
//
// PhotoGallery drove a scroll-snap track with a POSITIVE scrollLeft and derived
// the active dot from that same positive number. In an RTL scroll container
// scrollLeft runs from -(scrollWidth - clientWidth) up to 0, so:
//   - `scrollTo({ left: 1 * clientWidth })` clamps to 0 and the "Next" arrow is
//     inert on every press;
//   - a swipe feeds a negative offset into Math.round, so idx goes -1, -2, ...
//     and no dot is ever marked active.
// Both language switches really do set dir="rtl" on documentElement, and the
// gallery portals into document.body, so it inherits that direction. The bug is
// invisible to an English tester because the identical code is correct in LTR.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Track = { clientWidth: number; scrollTo(o: { left: number; behavior?: "smooth" | "auto" }): void };

async function api() {
  const mod = await import("./carousel-rtl");
  return mod as unknown as {
    scrollToSlide: (t: Track, i: number, rtl: boolean) => void;
    slideIndexFromScroll: (scrollLeft: number, width: number, count: number) => number;
    isRtlDirection: (d: string | null | undefined) => boolean;
  };
}

function fakeTrack(clientWidth: number) {
  const calls: { left: number; behavior?: string }[] = [];
  return {
    clientWidth,
    scrollTo(opts: { left: number; behavior?: "smooth" | "auto" }) {
      calls.push(opts);
    },
    calls,
  };
}

describe("F121 - scrolling to a slide honours the reading direction", () => {
  it("LTR is unchanged: slide 2 sits at +2 widths", async () => {
    const { scrollToSlide } = await api();
    const track = fakeTrack(400);
    scrollToSlide(track, 2, false);
    expect(track.calls[0].left).toBe(800);
    expect(track.calls[0].behavior).toBe("smooth");
  });

  it("RTL scrolls NEGATIVE - a positive offset clamps to 0 and the arrow dies", async () => {
    const { scrollToSlide } = await api();
    const track = fakeTrack(400);
    scrollToSlide(track, 1, true);
    expect(track.calls[0].left).toBe(-400);
    expect(track.calls[0].left).toBeLessThan(0);
  });

  it("slide 0 is the origin in both directions, never -0", async () => {
    const { scrollToSlide } = await api();
    const ltr = fakeTrack(400);
    const rtl = fakeTrack(400);
    scrollToSlide(ltr, 0, false);
    scrollToSlide(rtl, 0, true);
    expect(ltr.calls[0].left).toBe(0);
    expect(rtl.calls[0].left).toBe(0);
  });
});

describe("F121 - the dot indicator follows a swipe in either direction", () => {
  it("an RTL swipe's negative offset is still slide 2", async () => {
    const { slideIndexFromScroll } = await api();
    expect(slideIndexFromScroll(-800, 400, 5)).toBe(2);
  });

  it("LTR is unchanged", async () => {
    const { slideIndexFromScroll } = await api();
    expect(slideIndexFromScroll(800, 400, 5)).toBe(2);
  });

  it("a part-way swipe rounds to the nearest slide", async () => {
    const { slideIndexFromScroll } = await api();
    expect(slideIndexFromScroll(-780, 400, 5)).toBe(2);
    expect(slideIndexFromScroll(-620, 400, 5)).toBe(2);
  });

  it("never leaves the photo range, whatever the browser reports", async () => {
    const { slideIndexFromScroll } = await api();
    expect(slideIndexFromScroll(-99999, 400, 3)).toBe(2);
    expect(slideIndexFromScroll(99999, 400, 3)).toBe(2);
    expect(slideIndexFromScroll(-1, 400, 3)).toBe(0);
    // A zero width (an unmeasured track) must not produce NaN.
    expect(slideIndexFromScroll(-400, 0, 3)).toBe(0);
    expect(slideIndexFromScroll(0, 400, 0)).toBe(0);
  });

  it("reads the computed direction, not a guess", async () => {
    const { isRtlDirection } = await api();
    expect(isRtlDirection("rtl")).toBe(true);
    expect(isRtlDirection("RTL")).toBe(true);
    expect(isRtlDirection("ltr")).toBe(false);
    expect(isRtlDirection(undefined)).toBe(false);
  });
});

describe("F121 - the gallery uses them, and its chrome mirrors", () => {
  const gallery = readFileSync(join(process.cwd(), "src/components/PhotoGallery.tsx"), "utf8");

  it("no arithmetic on a raw scrollLeft is left in the component", () => {
    expect(gallery).not.toMatch(/left: next \* track\.clientWidth/);
    expect(gallery).not.toMatch(/scrollLeft \/ w/);
    expect(gallery).toMatch(/scrollToSlide\(/);
    expect(gallery).toMatch(/slideIndexFromScroll\(/);
  });

  it("the arrows point the way the content moves", () => {
    expect(gallery).toMatch(/rtl-flip/);
  });

  it("the arrow offsets are logical, not physical", () => {
    expect(gallery).not.toMatch(/absolute left-2/);
    expect(gallery).not.toMatch(/absolute right-2/);
    expect(gallery).toMatch(/absolute start-2/);
    expect(gallery).toMatch(/absolute end-2/);
  });
});
