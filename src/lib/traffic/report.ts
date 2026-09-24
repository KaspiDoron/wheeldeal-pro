import "server-only";

// THE NUMBERS BEHIND Admin -> Traffic.
//
// Honest reads throughout (`sbSelectDark`): an unreachable table is reported
// as UNKNOWN and named in `degraded`, never rendered as a confident zero - a
// revenue screen that shows 0 because the database is down is telling its
// owner that a bad week happened when nothing of the kind is known.
//
// NO SQL VIEW, ON PURPOSE. A grouped view would be the obvious way to count,
// but the production anon-probe alarms on any object in the database that is
// not one of this app's registered tables, and a view owned by `postgres` also
// bypasses the row-level security underneath it. So this reads bounded pages
// of the five narrow columns it needs and groups them here, and says so
// plainly when the ceiling was hit.

import { sbSelectDark } from "@/lib/runtime-config";
import { placementOf, type Placement } from "./subid";
import { reconcile, type ClickCount, type Reconciliation, type RevenueRow } from "./revenue";
import type { TrafficPartner } from "./partners";

const PAGE = 1000;
const MAX_PAGES = 20;

interface EventRow {
  day: string;
  kind: string;
  placement: string;
  market: string;
  partner: string;
}

export interface TrafficReport {
  days: number;
  since: string;
  /** Rows read hit the ceiling: the totals cover only the most recent events. */
  truncated: boolean;
  degraded: string[];
  totals: { unitLoaded: number; unitEmpty: number; serpViews: number; linkClicks: number; fillRate: number | null };
  byPlacement: { placement: Placement; market: string; unitLoaded: number; unitEmpty: number; followed: number }[];
  partners: { id: string; label: string; kind: "afs" | "link"; enabled: boolean; reconciliation: Reconciliation | null }[];
}

export async function buildTrafficReport(days: number, partners: TrafficPartner[]): Promise<TrafficReport> {
  const span = Math.max(1, Math.min(90, Math.round(days) || 7));
  const since = new Date(Date.now() - span * 86_400_000).toISOString().slice(0, 10);
  const degraded: string[] = [];

  const events: EventRow[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await sbSelectDark<EventRow>(
      "traffic_events",
      `select=day,kind,placement,market,partner&day=gte.${encodeURIComponent(since)}&order=id.desc&limit=${PAGE}&offset=${page * PAGE}`
    );
    if (rows === null) {
      degraded.push("traffic_events");
      break;
    }
    events.push(...rows);
    if (rows.length < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  const revenue = await sbSelectDark<{ partner: string; day: string; sub_id: string; clicks: number; revenue: number | string }>(
    "traffic_revenue",
    `select=partner,day,sub_id,clicks,revenue&day=gte.${encodeURIComponent(since)}&order=day.desc&limit=5000`
  );
  if (revenue === null) degraded.push("traffic_revenue");

  const count = (kind: string) => events.filter((e) => e.kind === kind).length;
  const unitLoaded = count("unit_loaded");
  const unitEmpty = count("unit_empty");

  const buckets = new Map<string, TrafficReport["byPlacement"][number]>();
  for (const e of events) {
    const key = `${e.placement}|${e.market}`;
    const b = buckets.get(key) ?? { placement: placementOf(e.placement), market: e.market, unitLoaded: 0, unitEmpty: 0, followed: 0 };
    if (e.kind === "unit_loaded") b.unitLoaded++;
    else if (e.kind === "unit_empty") b.unitEmpty++;
    else b.followed++;
    buckets.set(key, b);
  }

  return {
    days: span,
    since,
    truncated,
    degraded,
    totals: {
      unitLoaded,
      unitEmpty,
      serpViews: count("serp_view"),
      linkClicks: count("link_click"),
      // Of the units that asked Google for suggestions, how many got any.
      fillRate: unitLoaded + unitEmpty > 0 ? unitLoaded / (unitLoaded + unitEmpty) : null,
    },
    byPlacement: [...buckets.values()].sort((a, b) => b.followed + b.unitLoaded - (a.followed + a.unitLoaded)),
    partners: partners.map((partner) => {
      if (revenue === null) return { id: partner.id, label: partner.label, kind: partner.kind, enabled: partner.enabled, reconciliation: null };
      const followedKind = partner.kind === "link" ? "link_click" : "serp_view";
      const ours: ClickCount[] = [];
      const seen = new Map<string, ClickCount>();
      for (const e of events) {
        if (e.partner !== partner.id || e.kind !== followedKind) continue;
        const key = `${e.day}|${e.placement}|${e.market}`;
        let c = seen.get(key);
        if (!c) {
          c = { day: e.day, placement: placementOf(e.placement), market: e.market, clicks: 0 };
          seen.set(key, c);
          ours.push(c);
        }
        c.clicks++;
      }
      const rows: RevenueRow[] = revenue
        .filter((r) => r.partner === partner.id)
        .map((r) => ({ day: r.day, subId: r.sub_id, clicks: Number(r.clicks) || 0, revenue: Number(r.revenue) || 0 }));
      return {
        id: partner.id,
        label: partner.label,
        kind: partner.kind,
        enabled: partner.enabled,
        reconciliation: reconcile(rows, ours, partner.revenueShare, { flagGaps: partner.kind === "link" }),
      };
    }),
  };
}
