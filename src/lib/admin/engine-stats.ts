// Pure, unit-testable aggregations for the Engine section overhaul (Module 3).
// The engine-inspector route reads recent engine-v3-turn rows and calls these to
// build the hand-rolled charts (turns/hour bars, move mix, provider mix) and the
// latency percentiles. No env, no I/O - deterministic given (rows, nowMs) so the
// tiers render the same numbers the tests assert.

export interface StatTurn {
  at?: string;
  move?: string;
  provider?: string | null;
  latencyMs?: number | null;
  /** Rivals on the table when the turn was composed (the live engine stamps it). */
  rivals?: number;
  /** Whether the outbound text cited one of them - measured on the wire. */
  citedRival?: boolean;
}

/** Nearest-rank p-th percentile of a numeric array (mirrors kpis.percentile). */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(xs.length - 1, Math.max(0, rank - 1))];
}

/**
 * Turns bucketed into the last `hours` one-hour windows, OLDEST first so a bar
 * chart reads left (older) -> right (now). Index `hours-1` is the current hour.
 * Rows outside the window or with an unparseable timestamp are ignored.
 */
export function bucketTurnsPerHour(turns: StatTurn[], nowMs: number, hours = 6): number[] {
  const buckets = new Array(hours).fill(0) as number[];
  for (const t of turns) {
    if (!t.at) continue;
    const ms = Date.parse(t.at);
    if (!Number.isFinite(ms)) continue;
    const ageH = Math.floor((nowMs - ms) / 3_600_000);
    if (ageH < 0 || ageH >= hours) continue;
    // ageH 0 = current hour -> last bucket; ageH hours-1 = oldest -> first.
    buckets[hours - 1 - ageH] += 1;
  }
  return buckets;
}

/** Counts per move, descending, so the biggest slice leads the mix chart. */
export function moveMix(turns: StatTurn[]): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of turns) {
    const k = t.move || "unknown";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/** Counts per model provider (null/absent -> "mock/local"), descending. */
export function providerMix(turns: StatTurn[]): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of turns) {
    const k = t.provider || "mock/local";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/** p50/p95 response latency (ms) over turns that carry a real latency sample. */
export function latencyStats(turns: StatTurn[]): { p50: number | null; p95: number | null; samples: number } {
  const xs: number[] = [];
  for (const t of turns) {
    if (typeof t.latencyMs === "number" && t.latencyMs >= 0) xs.push(t.latencyMs);
  }
  return { p50: percentile(xs, 50), p95: percentile(xs, 95), samples: xs.length };
}

/**
 * How often the agents used a REAL competing offer as leverage, out of the
 * bargains where one was available. The owner's complaint - "we had 250 and 300
 * and the 300 shop was never told" - was invisible because `leverageUsed` was
 * written every turn and read by nobody.
 */
export function leverageUsePct(turns: StatTurn[]): { pct: number | null; opportunities: number } {
  const chances = turns.filter((t) => t.move === "bargain" && (t.rivals ?? 0) > 0);
  if (!chances.length) return { pct: null, opportunities: 0 };
  const used = chances.filter((t) => t.citedRival).length;
  return { pct: Math.round((used / chances.length) * 100), opportunities: chances.length };
}

// ---------------------------------------------------------------------------
// Operations tiles (Tier-1): outcome + responsiveness numbers derived from the
// tables the app already writes. Pure so the route stays thin and the math is
// unit-tested against the same fixtures.
// ---------------------------------------------------------------------------

export interface MarginOffer {
  pricePerDay: number;
  listPricePerDay?: number | null;
}

/**
 * Average realized discount = mean of (list - final) / list over offers that
 * carry BOTH a list price and a final price no higher than it. This is the true
 * "how much did the agents shave off" number, not a benchmark estimate. Rounded
 * to a whole percent; null when no offer has a comparable list price.
 */
export function avgBargainMarginPct(offers: MarginOffer[]): { pct: number | null; samples: number } {
  const margins: number[] = [];
  for (const o of offers) {
    const list = o.listPricePerDay;
    if (typeof list === "number" && list > 0 && o.pricePerDay > 0 && list >= o.pricePerDay) {
      margins.push(((list - o.pricePerDay) / list) * 100);
    }
  }
  if (!margins.length) return { pct: null, samples: 0 };
  return {
    pct: Math.round(margins.reduce((a, b) => a + b, 0) / margins.length),
    samples: margins.length,
  };
}

export interface ReplyEvent {
  number: string;
  direction: "inbound" | "outbound";
  atMs: number;
}

/**
 * Median minutes a shop takes to reply: per shop number, pair each inbound with
 * the most recent UN-consumed prior outbound and take the gap. Gaps are bounded
 * to [0, 12h] so an overnight silence does not skew the median. Returns the p50
 * (rounded) and the sample count; null when nothing pairs.
 */
export function medianShopReplyMins(rows: ReplyEvent[]): { mins: number | null; samples: number } {
  const byNum = new Map<string, ReplyEvent[]>();
  for (const r of rows) {
    if (!Number.isFinite(r.atMs)) continue;
    const list = byNum.get(r.number);
    if (list) list.push(r);
    else byNum.set(r.number, [r]);
  }
  const gaps: number[] = [];
  for (const list of byNum.values()) {
    list.sort((a, b) => a.atMs - b.atMs);
    let lastOut: number | null = null;
    for (const r of list) {
      if (r.direction === "outbound") {
        lastOut = r.atMs;
      } else if (lastOut != null) {
        const mins = (r.atMs - lastOut) / 60_000;
        if (mins >= 0 && mins <= 720) gaps.push(mins);
        lastOut = null; // consume so several inbounds don't all pair to one send
      }
    }
  }
  const p = percentile(gaps, 50);
  return { mins: p == null ? null : Math.round(p), samples: gaps.length };
}
