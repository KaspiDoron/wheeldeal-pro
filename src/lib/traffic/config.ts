import "server-only";

// THE TRAFFIC MODULE'S SWITCHES. Three Key Vault values, so monetisation can be
// turned on, paused or re-pointed from Admin -> Keys with no redeploy:
//
//   TRAFFIC_MODE      off (default) | test | live
//                     `test` renders the units with Google's `adtest: on`, which
//                     serves real-looking ads that count no impressions and earn
//                     nothing - the ONLY safe way to look at a live unit, since
//                     a publisher clicking their own ads is invalid traffic.
//   TRAFFIC_PARTNERS  the registry (lib/traffic/partners.ts), one per line.
//   TRAFFIC_AD_CREATIVES  the ad texts the owner runs, one per line. Only a
//                     landing URL whose `rac` IS one of these is declared to
//                     Google as referrerAdCreative (lib/traffic/creatives.ts).
//                     Empty - the organic case - means `rac` is ignored.
//   TRAFFIC_TCF_CMP   none (default) | google - whether a Google-certified TCF
//                     CMP is installed. Decides whether search ads may be
//                     requested in the EEA, the UK and Switzerland at all
//                     (lib/traffic/region.ts explains why).
//
// OFF IS THE DEFAULT, AND UNREADABLE MEANS OFF. A module that spends a
// visitor's consent does not switch itself on because a config read failed.

import { getConfig } from "@/lib/runtime-config";
import { parsePartners, partnerFor, type TrafficPartner } from "./partners";
import { matchCreative, parseCreatives } from "./creatives";
import type { TcfCmp } from "./region";
import { PUBLIC_TRAFFIC_OFF, type PublicTrafficConfig, type TrafficMode } from "./public";

export { PUBLIC_TRAFFIC_OFF };
export type { PublicTrafficConfig, TrafficMode };

export interface TrafficConfig {
  mode: TrafficMode;
  cmp: TcfCmp;
  partners: TrafficPartner[];
  errors: string[];
  creatives: string[];
}

export async function getTrafficConfig(): Promise<TrafficConfig> {
  const [modeRaw, partnersRaw, cmpRaw, creativesRaw] = await Promise.all([
    getConfig("TRAFFIC_MODE").catch(() => null),
    getConfig("TRAFFIC_PARTNERS").catch(() => null),
    getConfig("TRAFFIC_TCF_CMP").catch(() => null),
    getConfig("TRAFFIC_AD_CREATIVES").catch(() => null),
  ]);
  const m = String(modeRaw ?? "").trim().toLowerCase();
  const mode: TrafficMode = m === "live" || m === "test" ? m : "off";
  const cmp: TcfCmp = String(cmpRaw ?? "").trim().toLowerCase() === "google" ? "google" : "none";
  const { partners, errors } = parsePartners(partnersRaw);
  return { mode, cmp, partners, errors, creatives: parseCreatives(creativesRaw) };
}

/** What the browser is allowed to know (the shape lives in ./public). A link
 *  partner's template stays on the server - the visitor reaches it through
 *  /api/traffic/go, so the browser only needs to know that one exists. */
export function toPublicTraffic(config: TrafficConfig, market = "xx", rac: string | null = null): PublicTrafficConfig {
  if (config.mode === "off") return PUBLIC_TRAFFIC_OFF;
  const afs = partnerFor(config.partners, market, "afs");
  const link = partnerFor(config.partners, market, "link");
  return {
    mode: config.mode,
    cmp: config.cmp,
    afs: afs && afs.kind === "afs" ? { id: afs.id, pubId: afs.pubId, styleId: afs.styleId, channel: afs.channel } : null,
    link: link ? { id: link.id } : null,
    rac: matchCreative(config.creatives, rac),
  };
}
