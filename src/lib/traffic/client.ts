// THE BROWSER SIDE OF THE TRAFFIC MODULE.
//
// NO "use client" directive, for the reason lib/cookies/client.ts gives: plain
// browser utilities, every access guarded, importable from either tree.
//
// NOTHING HERE RUNS WITHOUT ADVERTISING CONSENT. Every entry point asks
// `clientAllows("marketing")` first - which also answers no under a Global
// Privacy Control signal - and returns the "nothing" value when the answer is
// no: no config fetch, no script, no beacon, no storage.

import { clientAllows, rememberSession } from "../cookies/client";
import { newReceiptId } from "../cookies/consent";
import { PUBLIC_TRAFFIC_OFF, type PublicTrafficConfig } from "./public";
import { sessionHash, type Placement, type SubIdCategory, type SubIdMarket } from "./subid";

/** Declared in the cookie manifest under `marketing`. */
const SEED_KEY = "wd_tsid";
let memorySeed: string | null = null;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Today's 8-hex session hash, or null without advertising consent.
 *
 * The SEED is a random value kept in sessionStorage - gone when the tab closes
 * - and it never leaves the browser. What leaves is a 32-bit hash of the seed
 * and today's date, so the value a partner or our own log sees changes every
 * day and cannot be walked back to the seed. If storage is blocked the seed
 * lives in memory for this page only, which degrades to "every page is a new
 * session": slightly worse de-duplication, and nothing worse than that.
 */
export function trafficSession(): string | null {
  if (typeof window === "undefined" || !clientAllows("marketing")) return null;
  let seed: string | null = null;
  try {
    seed = sessionStorage.getItem(SEED_KEY);
  } catch {}
  if (!seed || !/^[A-Za-z0-9_-]{16,32}$/.test(seed)) {
    seed = memorySeed ?? newReceiptId();
    memorySeed = seed;
    rememberSession(SEED_KEY, seed);
  }
  return sessionHash(seed, utcDay());
}

const configByMarket = new Map<string, Promise<PublicTrafficConfig>>();

/** Single-flight per market, cached for the life of the page. */
export function loadTrafficConfig(market: SubIdMarket): Promise<PublicTrafficConfig> {
  if (typeof window === "undefined" || !clientAllows("marketing")) return Promise.resolve(PUBLIC_TRAFFIC_OFF);
  const hit = configByMarket.get(market);
  if (hit) return hit;
  const p = fetch(`/api/traffic/config?m=${encodeURIComponent(market)}`, { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<PublicTrafficConfig>) : PUBLIC_TRAFFIC_OFF))
    .then((d) => (d && (d.mode === "test" || d.mode === "live") ? d : PUBLIC_TRAFFIC_OFF))
    .catch(() => PUBLIC_TRAFFIC_OFF);
  configByMarket.set(market, p);
  return p;
}

/** Test seam - the cache is a module singleton. */
export function resetTrafficClient(): void {
  configByMarket.clear();
  memorySeed = null;
}

export interface TrafficBeacon {
  kind: "unit_loaded" | "unit_empty" | "serp_view";
  placement: Placement;
  market: SubIdMarket;
  category: SubIdCategory;
  partner: string;
  term?: string;
  termFromUnit?: boolean;
}

/** Fire and forget. The server re-checks consent; this only avoids the call. */
export function trackTraffic(event: TrafficBeacon): void {
  const session = trafficSession();
  if (!session) return;
  try {
    const body = JSON.stringify({ ...event, session });
    // keepalive so a `serp_view` fired as the page settles survives a quick
    // navigation away; sendBeacon cannot set the JSON content type.
    void fetch("/api/traffic/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    /* a beacon must never break a page */
  }
}

// ---- Google's search-ads loader ---------------------------------------------

export const CSA_SCRIPT_SRC = "https://www.google.com/adsense/search/ads.js";

type CsaFn = ((...args: unknown[]) => void) & { q?: unknown[]; t?: number };

/**
 * Make THE ad request for this document. Returns false if one was already made.
 *
 * Google: "Only ever make one ad request per page no matter how many blocks
 * may be present." In a single-page app a soft navigation keeps the document
 * alive, so a second unit mounting after a client-side route change would be a
 * second request on the same page. The flag lives on `window`, which is exactly
 * as long-lived as the document: a real page load clears it, a soft navigation
 * does not. Pages that carry a unit link to each other with plain anchors so
 * the common path is a real load - this is the guard for every other path.
 */
export function requestSearchAds(kind: "relatedsearch" | "ads", pageOptions: Record<string, unknown>, ...blocks: Record<string, unknown>[]): boolean {
  if (typeof window === "undefined" || !clientAllows("marketing")) return false;
  const w = window as unknown as { _googCsa?: CsaFn; __wdCsaRequested?: boolean };
  if (w.__wdCsaRequested) return false;
  w.__wdCsaRequested = true;

  // Google's stub, transcribed: calls made before ads.js arrives queue on `.q`.
  if (!w._googCsa) {
    const stub: CsaFn = function (...args: unknown[]) {
      (stub.q = stub.q || []).push(args);
    };
    stub.t = Date.now();
    w._googCsa = stub;
  }
  if (!document.querySelector(`script[src="${CSA_SCRIPT_SRC}"]`)) {
    const s = document.createElement("script");
    s.async = true;
    s.src = CSA_SCRIPT_SRC;
    document.head.appendChild(s);
  }
  // Drop undefined options: Google's tag treats a present-but-undefined key
  // differently from an absent one for some parameters.
  const clean = Object.fromEntries(Object.entries(pageOptions).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  w._googCsa(kind, clean, ...blocks);
  return true;
}
