// The shape of the traffic configuration the BROWSER may see. Isomorphic, and
// deliberately separate from config.ts: that module is server-only because it
// reads the Key Vault, and a client bundle importing a type from it would drag
// the server-only guard into the browser build.

import type { TcfCmp } from "./region";

export type TrafficMode = "off" | "test" | "live";

/** A link partner's template is absent on purpose - it stays on the server and
 *  the visitor reaches it through /api/traffic/go. */
export interface PublicTrafficConfig {
  mode: TrafficMode;
  cmp: TcfCmp;
  afs: { id: string; pubId: string; styleId: string; channel: string | null } | null;
  link: { id: string } | null;
}

export const PUBLIC_TRAFFIC_OFF: PublicTrafficConfig = { mode: "off", cmp: "none", afs: null, link: null };
