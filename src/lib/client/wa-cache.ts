// THE LINK VERDICT, REMEMBERED BETWEEN VISITS.
//
// `probeWaStatus` is a network round trip. Until it lands the UI knows nothing,
// and "nothing" used to render as "your WhatsApp is not connected" - the exact
// opposite of the truth for every returning user, for as long as the request
// took. This is the device's memory of the last answer: a hint used only while
// the real one is in flight, and overwritten the moment it arrives.
//
// It is deliberately NOT authority. Nothing gated on it may send a message; the
// only thing it may do is choose which placeholder to draw. A stale "connected"
// costs a dimmed line for one round trip. A stale "disconnected" would cost the
// user a pointless re-link, so a MISSING entry renders a shimmer, never a
// negative.

import { rememberLocal } from "@/lib/cookies/client";

const KEY = "wd_wa_linked";
/** Older than this and the memory is not worth having. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** The remembered verdict, or null when there is none / it is too old. */
export function readWaCache(now = Date.now()): boolean | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { connected?: unknown; at?: unknown };
    if (typeof v?.connected !== "boolean" || typeof v?.at !== "number") return null;
    if (now - v.at > MAX_AGE_MS) return null;
    // Only a POSITIVE memory is useful (see the header): a remembered "not
    // connected" is exactly the assertion we refuse to make without a probe.
    return v.connected ? true : null;
  } catch {
    return null;
  }
}

/** Record what the probe just said. Quota/private-mode failures are ignored. */
export function writeWaCache(connected: boolean, now = Date.now()): void {
  // `preferences` category. Refused consent behaves exactly like blocked
  // storage, which this cache was already built to survive: the probe simply
  // runs on every load instead of once every few minutes.
  rememberLocal(KEY, JSON.stringify({ connected, at: now }));
}
