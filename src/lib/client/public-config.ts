"use client";

// ONE FETCH OF /api/config/public PER PAGE LOAD.
//
// The endpoint is `force-dynamic` and awaits SIX unrelated config reads, the
// first of which is a Supabase round trip bounded at 8 seconds on a cold
// instance. Three independent components asked for it on mount - the ad banner,
// the test-mode strip and the main page's poll-cadence effect (and the admin
// page a fourth time) - each with a bare `fetch` and no coordination. So every
// cold load paid that cost three times, in parallel, for one small object whose
// value is identical in all three answers.
//
// This is a module-level single-flight: the first caller starts the request,
// every caller during it awaits the SAME promise, and the resolved value is
// cached for the life of the page. It is deliberately not a React context -
// the consumers are unrelated and mount at different times, and a context would
// force a provider around all of them for a value none of them owns.
//
// The cache is per page load, which is the correct lifetime: these values come
// from the Key Vault and change only when the owner edits them, and the app is
// a single-page client that reloads on deploy.

import { fetchJson } from "./fetch-json";
import { OSM_TILES, type MapTiles } from "../map-tiles";

export interface PublicConfig {
  googleClientId: string | null;
  mapsEnabled: boolean;
  adsenseClient: string | null;
  adsenseSlot: string | null;
  testMode: boolean;
  /** The basemap the two map surfaces draw. Resolved server-side from the Key
   *  Vault so the owner can change providers with no redeploy; the fallback
   *  below is keyless OpenStreetMap, so a dead config endpoint still draws a
   *  real map rather than a grey void. */
  map: MapTiles;
  poll: { activityMs: number; repliesMs: number; tagsMs: number; pulseMs: number };
}

/** What a caller gets when the endpoint cannot be reached. Never a throw, and
 *  never a blank object - a missing cadence must not stop the polls. */
export const PUBLIC_CONFIG_FALLBACK: PublicConfig = {
  googleClientId: null,
  mapsEnabled: false,
  adsenseClient: null,
  adsenseSlot: null,
  testMode: false,
  map: OSM_TILES,
  poll: { activityMs: 20000, repliesMs: 30000, tagsMs: 120000, pulseMs: 2500 },
};

export const PUBLIC_CONFIG_URL = "/api/config/public";

let inFlight: Promise<PublicConfig> | null = null;

/** Test seam - the single-flight is a module singleton. */
export function resetPublicConfigCache(): void {
  inFlight = null;
}

export function loadPublicConfig(): Promise<PublicConfig> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const res = await fetchJson<Partial<PublicConfig>>(PUBLIC_CONFIG_URL);
    if (!res.ok || !res.data) return PUBLIC_CONFIG_FALLBACK;
    const d = res.data;
    return {
      googleClientId: d.googleClientId ?? null,
      mapsEnabled: Boolean(d.mapsEnabled),
      adsenseClient: d.adsenseClient ?? null,
      adsenseSlot: d.adsenseSlot ?? null,
      testMode: Boolean(d.testMode),
      map: d.map?.url ? d.map : OSM_TILES,
      poll: {
        activityMs: d.poll?.activityMs ?? PUBLIC_CONFIG_FALLBACK.poll.activityMs,
        repliesMs: d.poll?.repliesMs ?? PUBLIC_CONFIG_FALLBACK.poll.repliesMs,
        tagsMs: d.poll?.tagsMs ?? PUBLIC_CONFIG_FALLBACK.poll.tagsMs,
        pulseMs: d.poll?.pulseMs ?? PUBLIC_CONFIG_FALLBACK.poll.pulseMs,
      },
    };
  })().catch(() => PUBLIC_CONFIG_FALLBACK);
  return inFlight;
}
