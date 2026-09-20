// THE PARTNER REGISTRY: who search traffic may be sent to, and the only code
// that builds a URL pointing at one of them.
//
// Two kinds of partner, because there are two ways a search feed is delivered:
//
//   afs   Google AdSense for Search, direct. Nothing is linked to: Google's
//         script renders the related-search unit and the ads INSIDE our own
//         pages, from a publisher id and a style id.
//   link  A feed partner that hosts the results page. The visitor follows an
//         ordinary link built from the partner's template.
//
// The registry is one Key Vault value (`TRAFFIC_PARTNERS`), one partner per
// line, so a partner can be added, paused or re-pointed with no redeploy:
//
//   id | kind | label | on/off | target | markets | revenue share
//
//   feed-a|link|Feed A|on|https://feed.example/s?q={q}&subid={subid}|th,vn|0.8
//   google|afs|Google AFS|on|pub-1234567890123456:1234567890:9876543210||1
//
// An AFS target is  <pub id>:<style id>[:<channel id>]. The pub id may be
// pasted either way round - `partner-pub-...` as the AdSense console shows the
// client id, or `pub-...` as the tag wants it. Google's reference is explicit
// that the tag takes "the part of your client-ID that comes after 'partner-'",
// and a tag given the long form serves nothing and reports no error, so it is
// normalised here rather than left to be got right by hand.
//
// It is pasted by hand, so every line is validated and a bad one is REPORTED,
// not skipped in silence - a partner that quietly earns nothing looks exactly
// like a slow week until somebody reads the config.

import { SUBID_MAX_LENGTH, parseSubId } from "./subid";

export type PartnerKind = "afs" | "link";

interface PartnerBase {
  id: string;
  label: string;
  enabled: boolean;
  /** ISO alpha-2 markets this partner is for. Empty = every market. */
  markets: string[];
  /** Our share of what the partner reports, 0-1. Reporting only. */
  revenueShare: number;
}

export interface AfsPartner extends PartnerBase {
  kind: "afs";
  /** `pub-` + 16 digits, exactly as the tag takes it. NOT the `ca-pub-`
   *  display id, and with any `partner-` prefix already removed. */
  pubId: string;
  styleId: string;
  /** A channel id CREATED IN THE ADSENSE ACCOUNT, or null. Google only reports
   *  on channels that already exist there - an invented one is ignored - so
   *  this is never derived from a sub-id. */
  channel: string | null;
}

export interface LinkPartner extends PartnerBase {
  kind: "link";
  /** https URL containing `{q}` and `{subid}`. */
  template: string;
}

export type TrafficPartner = AfsPartner | LinkPartner;

export const QUERY_MAX_LENGTH = 200;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const AFS_PUB_PATTERN = /^(?:partner-)?(pub-\d{16})$/;
const STYLE_PATTERN = /^\d{6,12}$/;
const CHANNEL_PATTERN = /^[A-Za-z0-9_]{1,40}(\+[A-Za-z0-9_]{1,40}){0,4}$/;

function validTemplate(template: string): string | null {
  if (!template.includes("{q}")) return "the template has no {q} placeholder";
  if (!template.includes("{subid}")) return "the template has no {subid} placeholder - its revenue could never be attributed";
  let url: URL;
  try {
    url = new URL(template.replace("{q}", "q").replace("{subid}", "s"));
  } catch {
    return "the template is not a URL";
  }
  if (url.protocol !== "https:") return "the template must be https";
  if (url.username || url.password) return "the template must not carry credentials";
  // A placeholder in the host or path lets a VALUE choose where the visitor
  // goes. They belong in the query string, where they can only be data.
  const beforeQuery = template.split("?")[0];
  if (beforeQuery.includes("{q}") || beforeQuery.includes("{subid}")) {
    return "placeholders are only allowed in the query string";
  }
  return null;
}

export function parsePartners(raw: string | null | undefined): { partners: TrafficPartner[]; errors: string[] } {
  const partners: TrafficPartner[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = String(raw ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  lines.forEach((line, i) => {
    const where = `line ${i + 1}`;
    const f = line.split("|").map((x) => x.trim());
    if (f.length < 5) {
      errors.push(`${where}: expected id|kind|label|on/off|target|markets|share`);
      return;
    }
    const [id, kind, label, state, target, marketsRaw = "", shareRaw = "1"] = f;
    if (!ID_PATTERN.test(id)) {
      errors.push(`${where}: the id must be lowercase letters, digits and hyphens`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`${where}: duplicate id "${id}" - the first one is kept`);
      return;
    }
    const markets = marketsRaw
      .split(",")
      .map((m) => m.trim().toLowerCase())
      .filter((m) => /^[a-z]{2}$/.test(m));
    const share = Number(shareRaw);
    const base: PartnerBase = {
      id,
      label: label || id,
      enabled: state.toLowerCase() === "on",
      markets,
      revenueShare: Number.isFinite(share) && share > 0 && share <= 1 ? share : 1,
    };

    if (kind === "afs") {
      const [pubRaw = "", styleId = "", channelRaw = ""] = target.split(":");
      const pub = AFS_PUB_PATTERN.exec(pubRaw);
      if (!pub) {
        errors.push(`${where}: an AFS target is pub-<16 digits>:<style id>[:<channel id>] - a ca-pub- display id does not serve search ads`);
        return;
      }
      if (!STYLE_PATTERN.test(styleId)) {
        errors.push(`${where}: the AFS style id must be the numeric id from the AdSense search styles page`);
        return;
      }
      if (channelRaw && !CHANNEL_PATTERN.test(channelRaw)) {
        errors.push(`${where}: the AFS channel must be a channel id created in AdSense (letters, digits, underscore; join several with +)`);
        return;
      }
      seen.add(id);
      partners.push({ ...base, kind: "afs", pubId: pub[1], styleId, channel: channelRaw || null });
      return;
    }

    if (kind === "link") {
      const problem = validTemplate(target);
      if (problem) {
        errors.push(`${where}: ${problem}`);
        return;
      }
      seen.add(id);
      partners.push({ ...base, kind: "link", template: target });
      return;
    }

    errors.push(`${where}: unknown kind "${kind}" (afs or link)`);
  });

  return { partners, errors };
}

/**
 * The outbound URL for a link partner, or null.
 *
 * Null is the answer to every doubt: a disabled partner, an AFS partner (which
 * is rendered in-page and has nothing to link to), a query that is empty or
 * absurd, or a sub-id this app did not build. The sub-id check is the
 * important one - `parseSubId` only accepts the closed format from subid.ts, so
 * nothing but enum codes and a rotating hash can ride out in that parameter.
 */
export function buildDestination(partner: TrafficPartner, input: { q: string; subId: string }): string | null {
  if (!partner.enabled || partner.kind !== "link") return null;
  const q = String(input.q ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!q || q.length > QUERY_MAX_LENGTH) return null;
  const subId = String(input.subId ?? "");
  if (subId.length > SUBID_MAX_LENGTH || !parseSubId(subId)) return null;

  const filled = partner.template
    .split("{q}")
    .join(encodeURIComponent(q))
    .split("{subid}")
    .join(encodeURIComponent(subId));

  // Belt to the template check's braces: whatever was substituted, the visitor
  // goes to the host the OWNER configured, over https, or nowhere.
  try {
    const out = new URL(filled);
    const expected = new URL(partner.template.replace("{q}", "q").replace("{subid}", "s"));
    if (out.protocol !== "https:" || out.host !== expected.host) return null;
    return filled;
  } catch {
    return null;
  }
}

/** The partner for a market: one that targets it first, then a neutral one. */
export function partnerFor(partners: TrafficPartner[], market: string, kind: PartnerKind): TrafficPartner | null {
  const m = String(market ?? "").toLowerCase();
  const live = partners.filter((p) => p.enabled && p.kind === kind);
  return live.find((p) => p.markets.includes(m)) ?? live.find((p) => p.markets.length === 0) ?? null;
}
