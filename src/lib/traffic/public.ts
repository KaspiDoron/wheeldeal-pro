// The shape of the traffic configuration the BROWSER may see. Isomorphic, and
// deliberately separate from config.ts: that module is server-only because it
// reads the Key Vault, and a client bundle importing a type from it would drag
// the server-only guard into the browser build.

import type { TcfCmp } from "./region";
import { DEFAULT_TRAFFIC_SETTINGS, type TrafficSettings } from "./settings";

export type TrafficMode = "off" | "test" | "live";

/** A link partner's template is absent on purpose - it stays on the server and
 *  the visitor reaches it through /api/traffic/go. */
export interface PublicTrafficConfig {
  mode: TrafficMode;
  cmp: TcfCmp;
  afs: { id: string; pubId: string; styleId: string; channel: string | null } | null;
  link: { id: string } | null;
  /** The owner-declared ad creative the landing URL's `rac` matched, or null.
   *  Never the caller's text - see lib/traffic/creatives.ts. */
  rac: string | null;
  /** The owner's knobs, already validated and clamped server-side. Present even
   *  when the module is off or consent is absent: which placements exist and
   *  which guide a market points at are not secrets and carry nothing personal. */
  settings: Pick<TrafficSettings, "relatedSearches" | "maxAds" | "placements" | "ignoredPageParams">;
  /** The guide this market's funnel card points at - always a real guide. The
   *  title rides along so the app bundle need not import twenty articles of
   *  text just to print one headline. */
  funnelGuide: { slug: string; title: string };
  /** The link partner's terms for this market + category, when one is live. */
  linkTerms: string[];
}

export const PUBLIC_TRAFFIC_OFF: PublicTrafficConfig = {
  mode: "off",
  cmp: "none",
  afs: null,
  link: null,
  rac: null,
  settings: {
    relatedSearches: DEFAULT_TRAFFIC_SETTINGS.relatedSearches,
    maxAds: DEFAULT_TRAFFIC_SETTINGS.maxAds,
    placements: DEFAULT_TRAFFIC_SETTINGS.placements,
    ignoredPageParams: DEFAULT_TRAFFIC_SETTINGS.ignoredPageParams,
  },
  funnelGuide: { slug: "scooter-rental-prices-southeast-asia", title: "What a scooter should actually cost in Southeast Asia" },
  linkTerms: [],
};
