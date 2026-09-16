// THE BROWSER TRACKER. Cheap, batched, and silent when consent is absent.
//
// The failure mode this is written against is the analytics snippet that costs
// the product it measures: a request per tap, on the critical path, on hotel
// wifi in Ko Tao, to record that somebody scrolled. So:
//
//   - `track()` costs a Map write and nothing else. No network, no JSON, no
//     await. It is safe to call from a render path.
//   - The buffer flushes on a 5s timer, on `visibilitychange` to hidden, and
//     when it fills. Navigation flushes go through `sendBeacon`, which the
//     browser delivers after the page is gone - a `fetch` there is cancelled by
//     the navigation and the event is simply lost.
//   - No consent, no buffer. Events are dropped at `track()`, before anything
//     is allocated, so a traveller who said no does not pay even the memory.
//
// The server refuses again anyway (both gates, in the route). This client check
// is an optimisation and a courtesy, never the enforcement - anything that
// treats a client-side check as the enforcement has no enforcement.

import { COOKIE_CONSENT_EVENT, clientAllows } from "@/lib/cookies/client";

/** Mirrors ANALYTICS_EVENTS in lib/analytics/events.ts, which is the authority
 *  - the server drops anything not on its own list. */
export type TrackName =
  | "screen_view"
  | "search_started"
  | "search_results"
  | "outreach_started"
  | "offer_opened"
  | "booking_opened"
  | "upgrade_viewed";

interface Buffered {
  name: TrackName;
  at: number;
  props?: Record<string, string | number | boolean>;
}

const ENDPOINT = "/api/analytics/collect";
const FLUSH_MS = 5000;
/** Matches MAX_EVENTS_PER_BATCH server-side - a bigger batch is truncated
 *  there, so filling past it would silently lose the tail. */
const MAX_BUFFER = 20;

let buffer: Buffered[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let wired = false;

function wire(): void {
  if (wired || typeof document === "undefined") return;
  wired = true;
  // THE ONLY FLUSH THAT RELIABLY LANDS. `beforeunload` does not fire on mobile
  // Safari when the app is backgrounded, and `unload` is worse; `hidden` is the
  // one signal both iOS and Android actually deliver.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
  // Turning analytics OFF mid-session must also drop what is already buffered -
  // those events were collected under a yes that no longer exists, and sending
  // them after the withdrawal is exactly the thing the withdrawal forbade.
  window.addEventListener(COOKIE_CONSENT_EVENT, () => {
    if (!clientAllows("analytics")) {
      buffer = [];
      if (timer) clearTimeout(timer);
      timer = null;
    }
  });
}

/**
 * Record one event. Returns whether it was buffered, so a test can assert the
 * consent gate without reaching into module state.
 *
 * Never throws and never awaits. A tracker that can break a tap is a tracker
 * that will, eventually, break the one tap that closes a deal.
 */
export function track(
  name: TrackName,
  props?: Record<string, string | number | boolean>
): boolean {
  try {
    if (typeof document === "undefined") return false;
    if (!clientAllows("analytics")) return false;
    wire();
    buffer.push({ name, at: Date.now(), props });
    if (buffer.length >= MAX_BUFFER) {
      flush();
      return true;
    }
    if (!timer) timer = setTimeout(() => flush(), FLUSH_MS);
    return true;
  } catch {
    return false;
  }
}

/** A screen view with the path already normalised server-side. */
export function trackScreen(path: string, props?: Record<string, string | number | boolean>): void {
  track("screen_view", { path, ...props });
}

/**
 * Send what is buffered. `viaBeacon` is used on the navigation path, where a
 * fetch would be cancelled by the navigation it is trying to outlive.
 */
function flush(viaBeacon = false): void {
  if (buffer.length === 0) return;
  const events = buffer;
  buffer = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const payload = JSON.stringify({ events });
  try {
    if (viaBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      // A Blob with an explicit type: sendBeacon's default content type is
      // text/plain, which the route's json() would still parse, but being
      // explicit keeps it readable in a network log.
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "application/json" }));
      return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {
      /* analytics is never worth a visible failure */
    });
  } catch {
    /* nor an invisible one */
  }
}
