import { NextResponse } from "next/server";
import { getConfig, getGoogleClientId } from "@/lib/runtime-config";
import { sessionSecretReady } from "@/lib/session";
import { authMethods, methodById } from "@/lib/auth/methods";
import { ADSENSE_PUBLISHER } from "@/lib/site";
import { resolveMapTiles } from "@/lib/map-tiles";

// Must resolve at request time so Key-Vault values apply without a redeploy.
export const dynamic = "force-dynamic";

// Browser-safe configuration only. The Google OAuth client ID is public by
// design; secret keys are never exposed here.
export async function GET() {
  const [
    methods,
    mapsKey,
    adsense,
    testMode,
    scaleMode,
    adsenseSlot,
    tileUrl,
    tileUrlDark,
    tileAttribution,
    tilesKey,
  ] = await Promise.all([
    // The provider list is built by the ONE registry (src/lib/auth/methods.ts)
    // that /api/auth/methods also uses, so this endpoint and the login screen
    // can no longer disagree about whether Google sign-in exists. The legacy
    // `googleClientId` field is derived from it rather than resolved separately -
    // two independent resolutions were how they drifted apart in the first place.
    authMethods({ sessionReady: sessionSecretReady, googleClientId: getGoogleClientId }),
    getConfig("GOOGLE_MAPS_API_KEY"),
    getConfig("ADSENSE_CLIENT"),
    getConfig("TEST_MODE"),
    getConfig("SCALE_MODE"),
    // THE AD UNIT ID, WITHOUT WHICH NOTHING SERVES.
    //
    // The publisher id says whose account this is; the SLOT id says which ad
    // unit to fill. AdBanner rendered `data-ad-slot` only when a caller passed
    // one and no caller ever did, so every banner reserved its 100px, showed
    // its placeholder, and could never be filled - the ad surface looked
    // complete and earned nothing. It is a Key Vault value like every other
    // integration, so the owner pastes it in Admin -> Keys with no redeploy.
    getConfig("ADSENSE_SLOT"),
    // THE BASEMAP. Both maps hard-coded keyless CARTO raster tiles; in late
    // August 2026 CARTO began requiring a key and WATERMARKING unauthenticated
    // tiles, so the traveller's map filled with "API KEY REQUIRED" and nothing
    // in the app could see it. The default is keyless OpenStreetMap now (see
    // lib/map-tiles); these four let the owner upgrade the cartography from
    // Admin -> Keys with no redeploy. All four are PUBLIC by construction -
    // the browser fetches the tiles - and are registered secret:false.
    getConfig("MAP_TILE_URL"),
    getConfig("MAP_TILE_URL_DARK"),
    getConfig("MAP_TILE_ATTRIBUTION"),
    getConfig("MAP_TILES_KEY"),
  ]);
  const clientId = methodById(methods, "google")?.config?.clientId;
  // The ONE flag dialect (config-flags) - this route used to hand-roll a third
  // copy of on|1|true, so "yes" meant off here and on elsewhere.
  const { parseFlag } = await import("@/lib/config-flags");
  const on = (v: string | undefined | null) => parseFlag(v, false);
  const scaled = on(scaleMode);
  return NextResponse.json({
    // Kept for back-compat with any client still reading this field. New code
    // should use /api/auth/methods; this is the migration shim.
    googleClientId: clientId ?? null,
    // The full registry, so a consumer never has to re-derive "is Google on".
    authMethods: methods,
    mapsEnabled: Boolean(mapsKey),
    // The Key Vault can point the app at a DIFFERENT publisher without a
    // redeploy; with nothing set it falls back to the site's own account
    // rather than to null, so ad slots are live from the first deploy.
    adsenseClient: adsense || ADSENSE_PUBLISHER,
    // Null until the owner creates a display unit in the AdSense console. The
    // banner still reserves its space (so enabling it shifts no layout), it
    // just cannot be filled yet - and now says so honestly.
    adsenseSlot: (adsenseSlot ?? "").trim() || null,
    testMode: on(testMode),
    // Client polling cadence: SCALE_MODE stretches intervals to cut function
    // invocations under load (a single instance has no workers to add).
    map: resolveMapTiles({
      url: tileUrl,
      darkUrl: tileUrlDark,
      attribution: tileAttribution,
      key: tilesKey,
    }),
    // Client polling cadence. `pulseMs` is the cheap change-detector (one
    // indexed row per source) that makes the heavy polls event-driven instead
    // of periodic - see /api/pulse. The activity/replies intervals below it are
    // now a SAFETY FLOOR, not the freshness mechanism: they still carry the
    // opportunistic drain and the missed-webhook reconciler, which is why they
    // do not go to zero.
    poll: scaled
      ? { activityMs: 30000, repliesMs: 45000, tagsMs: 300000, pulseMs: 5000 }
      : { activityMs: 20000, repliesMs: 30000, tagsMs: 120000, pulseMs: 2500 },
  });
}
