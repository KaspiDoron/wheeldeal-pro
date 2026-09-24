"use client";

// THE VENDOR LIST, WINDOWED.
//
// A busy hunt is forty shops, and every card is a heavy component: a photo, an
// avatar, a tracker pipeline, an option list, a composer, a thread peek with
// its own poll. All of it mounted, all of it re-rendering on every activity
// tick, on a phone. The "Show 20 more" button was the old defence, and it is a
// bad one twice over - it makes the traveller do work to see shops the app
// already has, and it does nothing at all once they have tapped it, which is
// exactly when the list is heaviest.
//
// Windowing fixes both: everything is scrollable immediately, and only the rows
// near the viewport exist in the DOM. The virtualizer measures each card, so
// cards of different heights (an offer, a queued chip, an options menu) do not
// need a guessed row height.
//
// WINDOW SCROLLING, not a scroll container. The page scrolls; wrapping the list
// in its own overflow box would break scroll restoration, the sticky status
// panel and iOS momentum all at once.

import { useEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { Vendor } from "@/lib/types";

/** Estimated card height before measurement. Wrong is fine; unset is not. */
const ESTIMATE_PX = 420;
/** Rows to keep mounted beyond the viewport, so scrolling never shows a gap. */
const OVERSCAN = 4;
/** Below this width the layout is one column - the mobile-first target. */
const TWO_COLUMN_MIN_PX = 768;

export function VirtualVendorList({
  vendors,
  renderCard,
  scrollRequest,
}: {
  vendors: Vendor[];
  renderCard: (vendor: Vendor, index: number) => React.ReactNode;
  /**
   * Bring a row into view even when it is not mounted.
   *
   * The status panel and the push deep-links jump straight to a shop, and a
   * windowed row far down the list has no DOM node to scroll to. The caller
   * bumps this and the virtualizer scrolls the page, mounting the row on the
   * way; `scrollIntoView` on the real element then does the fine positioning.
   */
  /** A scroll REQUEST - carries a nonce so jumping to the same row twice is two
   *  distinct requests. A bare index made the second jump a React bail-out. */
  scrollRequest?: { index: number; nonce: number } | null;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [lanes, setLanes] = useState(1);
  // The offset of the list from the top of the document. The window
  // virtualizer measures against the page, so it needs to know where we start.
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const measure = () => {
      setLanes(window.innerWidth >= TWO_COLUMN_MIN_PX ? 2 : 1);
      const top = parentRef.current?.getBoundingClientRect().top ?? 0;
      const next = top + window.scrollY;
      // Only on a real change: setState with the same number is a bail-out, but
      // the ResizeObserver below fires often enough that being explicit matters.
      setOffset((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    };
    measure();
    window.addEventListener("resize", measure);

    // EVERYTHING ABOVE THIS LIST CHANGES HEIGHT WHILE vendors.length DOES NOT.
    //
    // `offset` is the virtualizer's scrollMargin - where the list starts in the
    // document - and it was re-measured only when the vendor COUNT changed or
    // the window resized. During a live hunt the count is constant while the
    // page above keeps moving: the search card folds away, the Live Status
    // panel expands (easily 300-600px), QuotesRail appears once the second
    // quote lands, the queued-messages card, the kill switch, the
    // cheapest-offer banner.
    //
    // Overscan absorbs most of it for the render window, so the visible
    // symptom is not blank gaps - it is scrollToIndex landing hundreds of
    // pixels off target, because scrollMargin is what that call aims with. And
    // the status panel, the surface that triggers most jumps, is the biggest
    // offender.
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    if (ro && parentRef.current?.parentElement) ro.observe(parentRef.current.parentElement);
    if (ro && typeof document !== "undefined") ro.observe(document.body);

    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [vendors.length]);

  const virtualizer = useWindowVirtualizer({
    count: vendors.length,
    estimateSize: () => ESTIMATE_PX,
    overscan: OVERSCAN,
    lanes,
    scrollMargin: offset,
    // Cards change height as offers land, so measurement has to be dynamic
    // rather than a one-time read.
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  useEffect(() => {
    const index = scrollRequest?.index;
    if (typeof index !== "number" || index < 0) return;
    // AIM WITH A NUMBER MEASURED NOW, NOT ONE A RESIZEOBSERVER WILL DELIVER
    // LATER. The observer above keeps `offset` honest between jumps, but it
    // fires asynchronously - and the surface that triggers most jumps (the
    // Live Status panel) changes its own height in the same tap. So the render
    // this effect belongs to can carry the margin from BEFORE that change, the
    // virtualizer aims with it, its dynamic-mode retry loop then re-asserts the
    // same wrong target for a few frames, and the page settles a constant
    // ~165px short of the card at 320px. jump-to-vendor.spec.ts caught it 3-5
    // runs in 20; CI never did, because journeys retry twice there.
    const top = (parentRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY;
    if (Math.abs(top - virtualizer.options.scrollMargin) >= 1) {
      virtualizer.setOptions({ ...virtualizer.options, scrollMargin: top });
      setOffset(top);
    }
    virtualizer.scrollToIndex(index, { align: "center" });
    // Keyed on the NONCE, so a repeat jump to the same row re-runs. `virtualizer`
    // is recreated every render by design; depending on it here would scroll on
    // every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest?.nonce]);

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={parentRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {items.map((item) => {
        const vendor = vendors[item.index];
        if (!vendor) return null;
        return (
          <div
            key={vendor.id}
            data-index={item.index}
            ref={virtualizer.measureElement}
            // A windowed row is absolutely positioned, so it has no inline flow
            // for `dir="rtl"` to mirror - the lane offset has to be flipped by
            // hand. globals.css swaps `left` for `right` off this class and the
            // custom property below.
            className="wd-virtual-row"
            style={{
              position: "absolute",
              top: 0,
              // Two lanes share the width; one lane takes all of it. The gap is
              // baked into the width so the columns do not touch.
              left: lanes === 2 ? `calc(${item.lane * 50}% + ${item.lane * 6}px)` : 0,
              ["--wd-lane-offset" as string]:
                lanes === 2 ? `calc(${item.lane * 50}% + ${item.lane * 6}px)` : "0px",
              width: lanes === 2 ? "calc(50% - 6px)" : "100%",
              transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {renderCard(vendor, item.index)}
          </div>
        );
      })}
    </div>
  );
}
