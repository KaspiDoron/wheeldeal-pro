"use client";

// SCROLL-SNAP ARITHMETIC THAT SURVIVES HEBREW AND ARABIC (audit F121).
//
// A horizontal scroll container is not symmetric: in a spec-compliant RTL port
// `scrollLeft` runs from -(scrollWidth - clientWidth) up to 0, so the obvious
// code is silently LTR-only.
//
//   track.scrollTo({ left: next * track.clientWidth })  // clamps to 0 in RTL
//   setIdx(Math.round(track.scrollLeft / w))            // -1, -2, ... in RTL
//
// The photo gallery shipped both, which made "Next" inert on every press and
// left no dot ever highlighted for a traveller reading right-to-left - and the
// identical code is correct in English, so no English tester could see it.
//
// scrollIntoView() would also be direction-agnostic, but inside a fixed
// full-screen portal it can scroll ANCESTOR scroll ports too and fight the body
// scroll lock, so the sign correction stays here where it can be executed by a
// test.

export interface CarouselTrack {
  clientWidth: number;
  scrollTo(options: { left: number; behavior?: "smooth" | "auto" }): void;
}

/** Is this computed `direction` right-to-left? */
export function isRtlDirection(direction: string | null | undefined): boolean {
  return String(direction ?? "").trim().toLowerCase() === "rtl";
}

/** The track's own reading direction, falling back to the document's. */
export function trackDirection(el: Element | null | undefined): string {
  if (!el || typeof window === "undefined") return "ltr";
  try {
    const computed = window.getComputedStyle(el).direction;
    if (computed) return computed;
  } catch {
    /* jsdom-less runtimes and detached nodes: fall through to the document */
  }
  return document.documentElement.getAttribute("dir") || "ltr";
}

/** Scroll `track` so slide `index` fills it, in either reading direction. */
export function scrollToSlide(track: CarouselTrack, index: number, rtl: boolean): void {
  const offset = Math.max(0, index) * track.clientWidth;
  // `-0` is a real value in JS and reads oddly in logs and tests; keep it at 0.
  const left = offset === 0 ? 0 : rtl ? -offset : offset;
  track.scrollTo({ left, behavior: "smooth" });
}

/**
 * Which slide a scroll offset is showing. `Math.abs` is what makes it
 * direction-agnostic: an RTL port reports the same distance with the opposite
 * sign. Clamped to the photos that actually exist, so a rubber-band overscroll
 * or an unmeasured (zero-width) track can never produce a NaN or a dot index
 * nothing renders.
 */
export function slideIndexFromScroll(scrollLeft: number, width: number, count: number): number {
  if (!Number.isFinite(scrollLeft) || !Number.isFinite(width) || width <= 0) return 0;
  const last = Math.max(0, Math.floor(count) - 1);
  const idx = Math.round(Math.abs(scrollLeft) / width);
  return Math.max(0, Math.min(last, idx));
}
