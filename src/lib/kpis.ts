// Durable field KPIs (Module 7.1).
//
// The legacy analytics() (memory.ts) is in-memory and resets on restart. These
// KPIs compute from the durable tables so they survive redeploys and reflect the
// real fleet: discount margin (from offers), lead->booking conversion (bookings /
// searches), and human-escalation rate (takeover events / active threads). All
// bounded to a recent window and a row cap - cheap enough for an admin panel.
//
// Honest scope: response-latency p50/p95 needs a dedicated per-turn latency log
// (a fast-follow); it is deliberately not faked here. Token-cost efficiency and
// the telemetry safety score already exist (api/admin/costs, senderSafety).

import "server-only";
import { sbSelectDark, pgTimestamp } from "./runtime-config";

export interface OfferMargin {
  price_per_day: number | string | null;
  list_price_per_day: number | string | null;
}

/** Pure, testable: the p-th percentile of a numeric array (nearest-rank). */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(xs.length - 1, Math.max(0, rank - 1))];
}

/** Pure, testable: average realized discount % across offers (list -> paid). */
export function avgDiscountPct(offers: OfferMargin[]): { pct: number | null; sampled: number } {
  let sum = 0;
  let n = 0;
  for (const o of offers) {
    const list = Number(o.list_price_per_day);
    const paid = Number(o.price_per_day);
    if (list > 0 && paid > 0 && paid <= list) {
      sum += (list - paid) / list;
      n += 1;
    }
  }
  return { pct: n ? Number(((sum / n) * 100).toFixed(1)) : null, sampled: n };
}

export interface FieldKpis {
  discountMarginPct: number | null;
  offersSampled: number;
  conversionPct: number | null;
  searches30d: number;
  bookings30d: number;
  escalationPct: number | null;
  responseLatencyMs: { p50: number | null; p95: number | null; samples: number };
  windowDays: number;
  note: string;
  /**
   * Inputs that could not be READ this run, by name. Non-empty means the
   * numbers above are computed from a partial view and must be rendered as
   * unknown rather than as a quiet month.
   *
   * Every read here used to be `sbSelect(...).catch(() => [])` - a permissive
   * reader whose catch could never fire, chained to a fallback identical to
   * what the reader already returns. So a total Supabase outage produced a
   * complete, confident KPI page: 0 searches, 0 bookings, null conversion, and
   * an escalation rate of null that reads as "no humans needed". The one page
   * whose job is to say how the fleet is doing answered "quietly" when it could
   * not answer at all.
   */
  degraded: string[];
}

const sinceIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * How many distinct CONVERSATIONS a set of agent_events rows covers.
 *
 * A thread is one traveller talking to one shop, so the key is the pair. Rows
 * missing either half are pre-attribution legacy and are counted once, under a
 * single bucket, rather than dropped - dropping them would understate the
 * denominator and inflate the rate all over again.
 */
export function distinctThreads(
  rows: { user_email?: string | null; vendor_id?: string | null }[]
): number {
  const seen = new Set<string>();
  for (const r of rows) {
    const email = (r.user_email ?? "").trim().toLowerCase();
    const vendor = (r.vendor_id ?? "").trim();
    seen.add(email && vendor ? `${email}|${vendor}` : "unattributed");
  }
  return seen.size;
}

export async function fieldKpis(windowDays = 30): Promise<FieldKpis> {
  const since = sinceIso(windowDays);
  const [offersRead, searchesRead, bookingsRead, takeoversRead, threadsRead] = await Promise.all([
    sbSelectDark<OfferMargin>(
      "offers",
      `select=price_per_day,list_price_per_day&created_at=gte.${pgTimestamp(since)}&limit=10000`
    ),
    sbSelectDark<{ id: number }>("searches", `select=id&created_at=gte.${pgTimestamp(since)}&limit=10000`),
    sbSelectDark<{ id: number }>("bookings", `select=id&created_at=gte.${pgTimestamp(since)}&limit=10000`),
    // human-takeover is the ONE kind setThreadTakeover writes (the marker's
    // agent_events twin). The old in-list also read `takeover` and
    // `takeover-detected` - names NO writer ever emitted, so they were dead
    // filter weight that hid the real question ("does anything write this?")
    // from the reader/writer reconcile test.
    sbSelectDark<{ user_email: string | null; vendor_id: string | null }>(
      "agent_events",
      `select=user_email,vendor_id&kind=eq.human-takeover&created_at=gte.${pgTimestamp(since)}&limit=10000`
    ),
    // engine-v3-turn events are the response-latency source (each carries
    // `latencyMs` on a delivered reply) AND, once reduced to distinct threads,
    // the escalation denominator.
    sbSelectDark<{ detail: string; user_email: string | null; vendor_id: string | null }>(
      "agent_events",
      `select=detail,user_email,vendor_id&kind=eq.engine-v3-turn&created_at=gte.${pgTimestamp(since)}&limit=20000`
    ),
  ]);
  // null = unreadable. Name it, then compute from [] so the shape stays whole -
  // but every derived number that depended on an unreadable input is forced to
  // null below rather than to the flattering zero.
  const degraded: string[] = [];
  const take = <T,>(rows: T[] | null, label: string): T[] => {
    if (rows === null) {
      degraded.push(label);
      return [];
    }
    return rows;
  };
  const offers = take(offersRead, "offers");
  const searches = take(searchesRead, "searches");
  const bookings = take(bookingsRead, "bookings");
  const takeovers = take(takeoversRead, "takeover events");
  const threads = take(threadsRead, "engine turns");

  const { pct: discountMarginPct, sampled } = avgDiscountPct(offers);
  // A ratio is only as trustworthy as BOTH of its sides. If either read failed,
  // the answer is unknown - not a rate computed against a zero we invented.
  const conversionPct =
    searchesRead === null || bookingsRead === null
      ? null
      : searches.length
        ? Number(((bookings.length / searches.length) * 100).toFixed(1))
        : null;
  // ESCALATION IS PER CONVERSATION, NOT PER TURN.
  //
  // The denominator was the raw count of engine-v3-turn EVENTS - one row per
  // agent turn - so a thread that ran twelve turns counted twelve times. The
  // rate was therefore divided by the average conversation length: a product
  // where one negotiation in five needs a human read as "4% escalation", and
  // the number that decides whether the agents are trusted to run unattended
  // was wrong by an order of magnitude, in the flattering direction.
  //
  // The numerator has the same shape: a thread a human took over twice is ONE
  // escalation, not two.
  const escalated = distinctThreads(takeovers);
  const conversations = distinctThreads(threads);
  const escalationPct =
    takeoversRead === null || threadsRead === null
      ? null
      : conversations
        ? Number(((escalated / conversations) * 100).toFixed(1))
        : null;

  // Response latency p50/p95 from the per-turn stamps (delivered replies only).
  const latencies: number[] = [];
  for (const t of threads) {
    try {
      const ms = (JSON.parse(t.detail) as { latencyMs?: number | null }).latencyMs;
      if (typeof ms === "number" && ms >= 0) latencies.push(ms);
    } catch {
      /* skip unparseable rows */
    }
  }

  return {
    discountMarginPct: offersRead === null ? null : discountMarginPct,
    offersSampled: sampled,
    conversionPct,
    searches30d: searches.length,
    bookings30d: bookings.length,
    escalationPct,
    responseLatencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      samples: latencies.length,
    },
    windowDays,
    note: "Durable, last 30 days (sampled to 10k rows). Latency = per-turn engine response time on delivered replies.",
    degraded,
  };
}
