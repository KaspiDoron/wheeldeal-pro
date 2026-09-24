// REVENUE IMPORT AND RECONCILIATION: their numbers, held against ours.
//
// A feed partner pays on ITS count of clicks, not on ours. The two never agree
// exactly - the partner discards what it judges invalid, drops double clicks,
// and reports on its own clock - and a small gap is normal. A large gap is the
// most valuable signal in the business: it means a placement is sending traffic
// the partner will not pay for, which is the pattern that ends in a clawback or
// a closed account. It has to be seen in week one, per placement and per
// market, and not discovered at payout.
//
// Pure functions, no I/O: the route parses an uploaded report, reads our own
// click counts, and hands both here. That is also what makes the money maths
// testable without a database.

import { parseSubId, type Placement } from "./subid";

export interface RevenueRow {
  day: string;
  subId: string;
  clicks: number;
  revenue: number;
}

export interface ClickCount {
  day: string;
  placement: Placement;
  market: string;
  clicks: number;
}

export const REVENUE_MAX_ROWS = 50_000;

/** Below this many clicks a gap is noise, and flagging it teaches the owner to
 *  ignore the flag. */
const FLAG_MIN_CLICKS = 10;
/** Partner counting under 60% of what we sent. */
const UNDER_COUNT_GAP = 0.4;
/** Partner counting over 150% of what we logged - our own logging is losing clicks. */
const OVER_COUNT_GAP = -0.5;

const HEADER_ALIASES: Record<keyof RevenueRow, RegExp> = {
  day: /^(date|day|report ?date)$/,
  subId: /^(sub ?-?_?id\d?|subid|sub|channel|tracking ?id|tq)$/,
  clicks: /^(clicks|paid ?clicks|ad ?clicks|monetized ?clicks)$/,
  revenue: /^(revenue|est\.? ?revenue|estimated ?revenue|earnings|net ?revenue|amount)(\s*\(.*\))?$/,
};

/** One CSV line into fields, honouring quotes and doubled quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

function toNumber(value: string): number {
  const cleaned = String(value ?? "").replace(/[$€£,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return Number.NaN;
  return Number(cleaned);
}

export function parseRevenueCsv(csv: string): { rows: RevenueRow[]; errors: string[] } {
  const rows: RevenueRow[] = [];
  const errors: string[] = [];
  const lines = String(csv ?? "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length === 0) return { rows, errors: ["the file is empty"] };
  if (lines.length - 1 > REVENUE_MAX_ROWS) {
    return { rows, errors: [`too many rows (${lines.length - 1}) - the limit is ${REVENUE_MAX_ROWS}; split the report by month`] };
  }

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = {} as Record<keyof RevenueRow, number>;
  for (const key of Object.keys(HEADER_ALIASES) as (keyof RevenueRow)[]) {
    col[key] = header.findIndex((h) => HEADER_ALIASES[key].test(h));
    if (col[key] < 0) {
      const name = key === "subId" ? "sub-id" : key;
      errors.push(`no ${name} column found in the header (saw: ${header.join(", ")})`);
    }
  }
  if (errors.length) return { rows, errors };

  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const day = f[col.day] ?? "";
    const subId = f[col.subId] ?? "";
    const clicks = toNumber(f[col.clicks] ?? "");
    const revenue = toNumber(f[col.revenue] ?? "");
    const where = `line ${i + 1}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) {
      errors.push(`${where}: "${day}" is not a YYYY-MM-DD date`);
      continue;
    }
    if (!Number.isInteger(clicks) || clicks < 0) {
      errors.push(`${where}: clicks is not a whole number`);
      continue;
    }
    if (Number.isNaN(revenue) || revenue < 0) {
      errors.push(`${where}: revenue is not a non-negative amount`);
      continue;
    }
    rows.push({ day, subId, clicks, revenue });
  }
  return { rows, errors };
}

export interface ReconciliationLine {
  placement: Placement;
  market: string;
  ourClicks: number;
  partnerClicks: number;
  /** 1 - partner/ours. Positive = the partner counted fewer than we sent. */
  clickGap: number;
  gross: number;
  net: number;
  netPerThousandClicks: number;
  flag: "under-counted" | "over-counted" | null;
}

export interface Reconciliation {
  lines: ReconciliationLine[];
  unattributed: { clicks: number; gross: number };
  totals: { ourClicks: number; partnerClicks: number; gross: number; net: number };
}

/**
 * `flagGaps` is for LINK partners only. There, our `link_click` and the
 * partner's click are the same event seen from two ends, so a gap means
 * something. For Google's in-page unit they are different events - we can see a
 * visitor REACH the results page, Google counts a click on an AD there - so
 * "their clicks / ours" is the results page's ad click-through rate, which is
 * normally well under 60% and would flag every healthy row.
 */
export function reconcile(
  report: RevenueRow[],
  ours: ClickCount[],
  revenueShare: number,
  options: { flagGaps?: boolean } = {}
): Reconciliation {
  const flagGaps = options.flagGaps !== false;
  const share = Number.isFinite(revenueShare) && revenueShare > 0 && revenueShare <= 1 ? revenueShare : 1;
  const buckets = new Map<string, { placement: Placement; market: string; ourClicks: number; partnerClicks: number; gross: number }>();
  const bucket = (placement: Placement, market: string) => {
    const key = `${placement}|${market}`;
    let b = buckets.get(key);
    if (!b) {
      b = { placement, market, ourClicks: 0, partnerClicks: 0, gross: 0 };
      buckets.set(key, b);
    }
    return b;
  };

  for (const c of ours) bucket(c.placement, c.market).ourClicks += c.clicks;

  const unattributed = { clicks: 0, gross: 0 };
  for (const row of report) {
    const parsed = parseSubId(row.subId);
    if (!parsed) {
      unattributed.clicks += row.clicks;
      unattributed.gross += row.revenue;
      continue;
    }
    const b = bucket(parsed.placement, parsed.market);
    b.partnerClicks += row.clicks;
    b.gross += row.revenue;
  }

  const lines: ReconciliationLine[] = [...buckets.values()]
    .map((b) => {
      const clickGap = b.ourClicks > 0 ? 1 - b.partnerClicks / b.ourClicks : b.partnerClicks > 0 ? -1 : 0;
      const net = b.gross * share;
      const sample = Math.max(b.ourClicks, b.partnerClicks);
      let flag: ReconciliationLine["flag"] = null;
      if (flagGaps && sample >= FLAG_MIN_CLICKS) {
        if (clickGap >= UNDER_COUNT_GAP) flag = "under-counted";
        else if (clickGap <= OVER_COUNT_GAP) flag = "over-counted";
      }
      return {
        placement: b.placement,
        market: b.market,
        ourClicks: b.ourClicks,
        partnerClicks: b.partnerClicks,
        clickGap,
        gross: b.gross,
        net,
        netPerThousandClicks: b.ourClicks > 0 ? (net / b.ourClicks) * 1000 : 0,
        flag,
      };
    })
    .sort((a, b) => b.gross - a.gross || b.ourClicks - a.ourClicks);

  const attributedGross = lines.reduce((s, l) => s + l.gross, 0);
  return {
    lines,
    unattributed,
    totals: {
      ourClicks: lines.reduce((s, l) => s + l.ourClicks, 0),
      partnerClicks: lines.reduce((s, l) => s + l.partnerClicks, 0) + unattributed.clicks,
      gross: attributedGross + unattributed.gross,
      net: (attributedGross + unattributed.gross) * share,
    },
  };
}
