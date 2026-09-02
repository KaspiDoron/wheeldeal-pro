// THE BASEMAP, AND WHY IT IS NOT CARTO BY DEFAULT ANY MORE.
//
// Both map surfaces hard-coded `{s}.basemaps.cartocdn.com` with no key. In late
// August 2026 CARTO started requiring an API key for its raster basemaps and
// began WATERMARKING unauthenticated tiles - so the traveller's map filled with
// a diagonal "API KEY REQUIRED / carto.com/basemaps/apikey" across every tile.
// Nothing was broken on our side and nothing alarmed: a third party changed its
// terms and our map degraded in the one way the app cannot see.
//
// The default is now KEYLESS OpenStreetMap, which cannot develop this failure
// mode because there is no key to be missing. Dark mode is the SAME tiles under
// the CSS filter openstreetmap.org itself uses, rather than a second tile
// source - one URL, one thing that can break.
//
// The owner can still have the old Voyager cartography back by pasting a free
// CARTO key in Admin -> Keys, and any future provider fits through the explicit
// URL overrides without a code change.
//
// A TILE KEY IS PUBLIC BY CONSTRUCTION. The browser fetches the tiles, so the
// key rides in a request anyone can read in devtools. These keys are therefore
// registered `secret: false` and published through /api/config/public exactly
// like the Google client id and the AdSense slot. The real protection is the
// provider-side domain restriction, not secrecy - claiming otherwise in the
// Keys panel would be the dishonest-UI failure this repo keeps fighting.

export interface MapTiles {
  /** Light-theme (and, when `filterDark`, dark-theme) raster template. */
  url: string;
  /** Dark-theme template, or null when dark is produced by `filterDark`. */
  darkUrl: string | null;
  /** Raw HTML credit. Deliberately NOT t()-wrapped: it is markup plus proper
   * nouns plus a licence URL that OSMF's attribution guidelines want legible
   * and linked, and the catalogue generator only harvests literal t() calls. */
  attribution: string;
  maxZoom: number;
  /** Leaflet only rotates the subdomains it is told about; its default is
   * "abc", so the CARTO templates' `d.` host was never used. */
  subdomains?: string;
  /** Invert the tile imagery for dark mode instead of loading a dark source. */
  filterDark: boolean;
}

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** The keyless default. OSMF's tile policy allows an app of this size; it
 * requires the exact host below (the `{s}.` form is retired), HTTPS, a visible
 * credit, and a referrer - which next.config.mjs's strict-origin-when-cross-
 * origin already sends. Do not tighten that header without checking here. */
export const OSM_TILES: MapTiles = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  darkUrl: null,
  attribution: OSM_ATTRIBUTION,
  maxZoom: 19,
  filterDark: true,
};

const CARTO_ATTRIBUTION = `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions">CARTO</a>`;

/** The class the dark filter hangs off. Leaflet puts `className` on the tile
 * images only, so the price bubbles, the origin pin and the zoom controls stay
 * their real colours. */
export const TILE_CLASS = "wd-map-tiles";

export interface MapTilesConfig {
  /** Full light template - wins over everything, for a provider we have not
   * met yet. */
  url?: string | null;
  /** Full dark template. Absent with `url` present means "filter the light
   * tiles", which is right for any single-source provider. */
  darkUrl?: string | null;
  attribution?: string | null;
  /** A CARTO basemaps key: fills the Voyager / dark_all templates. */
  key?: string | null;
}

const clean = (v: string | null | undefined): string =>
  typeof v === "string" ? v.trim() : "";

/**
 * Resolve the tile source. Precedence: explicit template > CARTO key > keyless
 * OpenStreetMap. Never throws and never returns a blank url - a map that fails
 * to a grey void is worse than a map with plainer cartography.
 */
export function resolveMapTiles(cfg: MapTilesConfig | null | undefined): MapTiles {
  const url = clean(cfg?.url);
  const attribution = clean(cfg?.attribution);
  if (url) {
    const darkUrl = clean(cfg?.darkUrl);
    return {
      url,
      darkUrl: darkUrl || null,
      // An unknown provider still owes SOMEBODY a credit; falling back to the
      // OSM line is the honest default because almost every raster provider
      // derives from OSM data.
      attribution: attribution || OSM_ATTRIBUTION,
      maxZoom: 19,
      // A single-source override gets the filter; a two-source one does not.
      filterDark: !darkUrl,
    };
  }

  const key = clean(cfg?.key);
  if (key) {
    const q = `?key=${encodeURIComponent(key)}`;
    return {
      url: `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png${q}`,
      darkUrl: `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${q}`,
      attribution: attribution || CARTO_ATTRIBUTION,
      maxZoom: 20,
      subdomains: "abcd",
      // dark_all is real dark cartography - inverting it would produce a
      // light map on a dark theme.
      filterDark: false,
    };
  }

  return attribution ? { ...OSM_TILES, attribution } : OSM_TILES;
}

/** The template Leaflet should draw for a theme, plus whether to filter it. */
export function tilesForTheme(t: MapTiles, theme: "light" | "dark"): {
  url: string;
  className: string;
} {
  const dark = theme === "dark";
  return {
    url: dark && t.darkUrl ? t.darkUrl : t.url,
    className: dark && t.filterDark ? TILE_CLASS : "",
  };
}
