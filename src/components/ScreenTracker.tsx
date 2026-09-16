"use client";

// ONE SCREEN VIEW PER SCREEN, AND ONLY WITH CONSENT.
//
// Mounted once in the root layout. It watches the App Router pathname and
// records a `screen_view` on each change - including the client-side
// navigations that a naive page-load tracker misses entirely, which in this app
// is most of them (the whole funnel is one route with pushes off it).
//
// It renders nothing, it never blocks, and `track()` drops the event before
// allocating anything when analytics consent is absent - so for a traveller who
// said no this component is a `usePathname()` subscription and a no-op.
//
// SEARCH PARAMS ARE DELIBERATELY NOT READ. `useSearchParams` would opt every
// page under this layout into client-side rendering unless wrapped in Suspense,
// and the query string is the one part of a URL an analytics row must never
// carry anyway (see normalizePath in lib/analytics/events).

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { trackScreen } from "@/lib/client/analytics";

export function ScreenTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    trackScreen(pathname);
  }, [pathname]);

  return null;
}
