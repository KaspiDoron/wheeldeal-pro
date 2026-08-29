// THE NUMBERS THAT SAY WHETHER THE SYSTEM IS ALIVE.
//
// The health surface could report what had HAPPENED - services reachable,
// messages sent - and nothing at all about whether anything was still moving.
// So the two failures that actually took the product down in the field were
// both invisible:
//
//   - Nothing ever pinged the drain. The scheduler was never provisioned, so
//     queued sends and scheduled follow-ups simply waited, and every screen
//     looked healthy because everything that HAD been done was fine.
//   - No provider answered. The engine degraded to its fallbacks, kept
//     replying, and the only trace was a field on a per-turn event nobody
//     aggregated.
//
// All of it is derived from data the app already collects. Pure, so a tile that
// says "healthy" has to have earned it.

import { percentile } from "../kpis";

/** Older than this and a heartbeat is a lapse, not a rhythm. */
export const HEARTBEAT_STALE_MS = 10 * 60_000;

export type HeartbeatState = "beating" | "stale" | "never";

export interface Heartbeat {
  state: HeartbeatState;
  lastAt: string | null;
  ageMs: number | null;
  /** What the owner should DO. A red tile with no next step is just anxiety. */
  action: string | null;
}

/**
 * TWO RED HEARTBEATS MEAN DIFFERENT THINGS AND THE FIX IS DIFFERENT.
 *
 * "never" - nothing has EVER called the drain, so the schedule was never
 * created; "stale" - it ran and stopped, which is a lapse in something that
 * exists. Reporting both as "down" sent the owner looking in the wrong place.
 */
export function pulse(lastAt: string | null | undefined, now: number): Heartbeat {
  const at = lastAt ? Date.parse(lastAt) : NaN;
  if (!Number.isFinite(at)) {
    return {
      state: "never",
      lastAt: null,
      ageMs: null,
      action:
        "No ping has ever been recorded. The scheduler was never created - provision it, or check that the GitHub Actions heartbeat workflow is enabled.",
    };
  }
  const ageMs = Math.max(0, now - at);
  if (ageMs > HEARTBEAT_STALE_MS) {
    return {
      state: "stale",
      lastAt: new Date(at).toISOString(),
      ageMs,
      action:
        "The drain ran and stopped. The schedule exists but is failing - check the scheduler job's recent runs and the ping token.",
    };
  }
  return { state: "beating", lastAt: new Date(at).toISOString(), ageMs, action: null };
}

export interface QueueDepth {
  /** Rows waiting in the outbox (capped by the read). */
  waiting: number;
  /** Rows whose time has come and which are therefore genuinely late. */
  overdue: number;
  /** How long the oldest overdue row has been waiting, in ms. */
  oldestOverdueMs: number | null;
}

/**
 * How much is waiting, and how much of it is LATE.
 *
 * A deep queue is not a problem on its own - the pacing spreads a batch on
 * purpose. A queue full of rows whose `not_before` has already passed is,
 * because it means nothing is draining them.
 */
export function queueDepth(rows: { not_before: string }[], now: number): QueueDepth {
  let overdue = 0;
  let oldest: number | null = null;
  for (const r of rows) {
    const due = Date.parse(r.not_before);
    if (!Number.isFinite(due) || due > now) continue;
    overdue += 1;
    if (oldest === null || due < oldest) oldest = due;
  }
  return {
    waiting: rows.length,
    overdue,
    oldestOverdueMs: oldest === null ? null : Math.max(0, now - oldest),
  };
}

// ONE percentile definition (kpis.ts nearest-rank) for every admin surface.
// This file's floor-index variant disagreed with kpis.ts's ceil-rank on the
// same data, so the Engine tab, the Keys tab and the launch card could show
// three different "p95"s for one latency series.
function pct(sorted: number[], p: number): number | null {
  return percentile(sorted, p);
}

export interface Latency {
  p50: number | null;
  p95: number | null;
  samples: number;
}

/** Reply latency percentiles from the per-turn stamps. */
export function turnLatency(rows: { detail: string }[]): Latency {
  const values: number[] = [];
  for (const r of rows) {
    try {
      const ms = (JSON.parse(r.detail) as { latencyMs?: number | null }).latencyMs;
      if (typeof ms === "number" && ms >= 0) values.push(ms);
    } catch {
      /* an unparseable row is not a latency of zero */
    }
  }
  values.sort((a, b) => a - b);
  return { p50: pct(values, 50), p95: pct(values, 95), samples: values.length };
}

export interface ProviderErrors {
  /** Turns where NO provider answered and the engine fell back. */
  degraded: number;
  total: number;
  /** The distinct reasons, most frequent first - the actual error strings. */
  reasons: { reason: string; count: number }[];
}

/**
 * WHICH PROVIDER FAILED, AND WHY.
 *
 * `providerError` has been stamped on every turn since P1.8 precisely because
 * "no key configured" and "every key is failing" used to look identical. It was
 * never aggregated, so the distinction existed in the data and nowhere a human
 * would look.
 */
export function providerErrors(rows: { detail: string }[]): ProviderErrors {
  const counts = new Map<string, number>();
  let degraded = 0;
  for (const r of rows) {
    try {
      const d = JSON.parse(r.detail) as { providerError?: string | null; provider?: string | null };
      if (!d.providerError) continue;
      degraded += 1;
      const reason = String(d.providerError).slice(0, 120);
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    } catch {
      /* skip */
    }
  }
  return {
    degraded,
    total: rows.length,
    reasons: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

export interface PushBreadcrumbs {
  sent: number;
  failed: number;
  skipped: number;
  /** Share of ATTEMPTS that failed, or null when nothing was attempted. */
  failureRate: number | null;
}

/**
 * Where the notifications went.
 *
 * A skip is a decision (the significance gate did its job); a failure is a
 * traveller who was not told something. Counting them together would hide
 * exactly the one that matters.
 */
export function pushBreadcrumbs(rows: { kind: string }[]): PushBreadcrumbs {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.kind === "push-sent") sent += 1;
    else if (r.kind === "push-failed") failed += 1;
    else if (r.kind === "push-skipped") skipped += 1;
  }
  const attempts = sent + failed;
  return {
    sent,
    failed,
    skipped,
    failureRate: attempts ? Number(((failed / attempts) * 100).toFixed(1)) : null,
  };
}
