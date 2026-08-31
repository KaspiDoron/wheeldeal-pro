// THE LOSS-VS-HYGIENE SPLIT (W-beta30b).
//
// `inbound-dropped` is one kind carrying two opposite facts. On a personal
// WhatsApp number the privacy gate refusing the traveller's OWN chats fires all
// day and is the product working; a shop reply that never became a turn is the
// fleet going deaf. The admin health tile summed both into one integer, so "79
// in 24h" was unreadable - it could be either, and the owner had no way to ask.
//
// The reason has been persisted in `agent_events.detail` the whole time, and
// the benign/loud taxonomy already exists (safety-signals BENIGN_DROP_REASONS)
// and is already applied per-user and in the traveller's feed. This module is
// the PURE reducer that finally applies it fleet-wide, so it can be tested by
// EXECUTION rather than by grepping the route.

import { isLoudDrop } from "./safety-signals";

export interface DropRow {
  detail: string | null;
}

export interface DropReasonSummary {
  reason: string;
  /** agent_events rows carrying this reason. */
  rows: number;
  /** Underlying events: rows + the repeats the trace throttle collapsed. */
  events: number;
  loud: boolean;
}

export interface InboundDropSummary {
  /** The read failed. NEVER a confident zero - "we could not ask" is its own answer. */
  unreadable: boolean;
  benign: number;
  loud: number;
  events: number;
  /** The scan hit its row cap, so every count is a FLOOR. */
  truncated: boolean;
  reasons: DropReasonSummary[];
}

/** How many rows the health route scans, and the point past which counts are a floor. */
export const DROP_SCAN_LIMIT = 2000;

/** How many reason chips the tile renders - the tail is long and mostly zeroes. */
export const DROP_REASON_CHIPS = 12;

/**
 * Fold raw `inbound-dropped` rows into the benign/loud split plus a per-reason
 * histogram. `rows === null` means the read failed and every number is unknown.
 */
export function summarizeInboundDrops(
  rows: DropRow[] | null,
  limit: number = DROP_SCAN_LIMIT
): InboundDropSummary {
  if (rows === null) {
    return { unreadable: true, benign: 0, loud: 0, events: 0, truncated: false, reasons: [] };
  }
  const byReason = new Map<string, { rows: number; events: number; loud: boolean }>();
  let benign = 0;
  let loud = 0;
  let events = 0;
  for (const r of rows) {
    let reason = "";
    let also = 0;
    let notDropped = false;
    try {
      const d = JSON.parse(r.detail ?? "{}") as {
        reason?: unknown;
        alsoSuppressed?: unknown;
        notDropped?: unknown;
      };
      reason = String(d.reason ?? "");
      also = Math.max(0, Number(d.alsoSuppressed ?? 0) || 0);
      notDropped = d.notDropped === true;
    } catch {
      // An unparseable detail gets its OWN bucket. Silently folding it into a
      // benign count would be the same lie one level down.
    }
    if (!reason) reason = "(unparseable)";
    // `notDropped` rows ride this kind to report a data-integrity warning on a
    // turn that RAN (agent-loop's derived-unattributed). Nothing was lost, so
    // counting them as loss repeated the conflation this module exists to end.
    const loudOne = !notDropped && isLoudDrop(reason);
    const cur = byReason.get(reason) ?? { rows: 0, events: 0, loud: loudOne };
    cur.rows += 1;
    cur.events += 1 + also;
    byReason.set(reason, cur);
    events += 1 + also;
    if (loudOne) loud += 1;
    else benign += 1;
  }
  return {
    unreadable: false,
    benign,
    loud,
    events,
    truncated: rows.length >= limit,
    reasons: [...byReason.entries()]
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => b.rows - a.rows)
      .slice(0, DROP_REASON_CHIPS),
  };
}
