// Pure predicates for the inbound-ingestion gate (no server-only, no DB) so the
// isolation rules are unit-testable in isolation. drill.ts wraps these with the
// actual whatsapp_messages read.

// A drill/test rehearsal is a short interactive session - keep the window tight
// so a friend's private chatter is never ingested for long.
export const DRILL_INGEST_WINDOW_MS = 3 * 3600_000; // 3h
// A real shop thread stays ingestible while the negotiation is plausibly live,
// then retires - so a number messaged weeks ago can never re-open ingestion.
export const REAL_THREAD_INGEST_WINDOW_MS = 14 * 24 * 3600_000; // 14 days

export interface GateRaw {
  drill?: boolean;
  test?: boolean;
  vendorId?: string;
  rfq?: unknown;
  kind?: string;
}

/** Does this outbound anchor a REAL rental-shop conversation (an RFQ/agent
 *  send), as opposed to a stray/human-manual/personal message? */
export function isRfqAnchor(raw: GateRaw | null | undefined): boolean {
  if (!raw) return false;
  if (raw.rfq != null) return true;
  const vid = String(raw.vendorId ?? "");
  if (vid && !vid.startsWith("drill-") && !vid.startsWith("test-")) return true;
  const kind = String(raw.kind ?? "");
  return ["rfq", "bargain", "auto", "auto-reply", "custom", "close", "consent"].includes(kind);
}

/** Is this a drill/test rehearsal thread (owner testing against a real number)? */
export function isDrillAnchor(raw: GateRaw | null | undefined): boolean {
  if (!raw) return false;
  const vid = String(raw.vendorId ?? "");
  return (
    raw.drill === true ||
    raw.test === true ||
    vid.startsWith("drill-") ||
    vid.startsWith("test-")
  );
}

/**
 * Given this user's recent outbound rows to a number (newest-first), decide
 * whether inbound from that number is ingestible RIGHT NOW. Three rules:
 *   - drill/test rehearsal -> short window from the most recent send
 *   - real thread -> requires an RFQ anchor AND is within the active window
 *   - anything else (only stray/human-manual outbounds, or too old) -> no
 */
export function classifyIngest(
  rows: { received_at: string; raw: GateRaw | null }[],
  nowMs: number
): boolean {
  return classifyIngestDetailed(rows, nowMs).ok;
}

export type IngestReason =
  | "no-outbound" // we never messaged this number as a shop
  | "no-rfq-anchor" // outbounds exist but none is an RFQ/agent send
  | "thread-expired" // real thread, but the last send is past the 14d window
  | "drill-window-active" // a drill rehearsal still inside its 3h window (ingestible)
  | "drill-expired" // a drill rehearsal past its 3h window (retired)
  | "active-thread"; // a real RFQ thread inside the window (ingestible)

/** The same decision as classifyIngest, but reporting WHY - the load-bearing
 * signal the WA doctor shows so an operator can see exactly which gate dropped a
 * shop reply. `ok` matches classifyIngest exactly. */
export function classifyIngestDetailed(
  rows: { received_at: string; raw: GateRaw | null }[],
  nowMs: number
): { ok: boolean; reason: IngestReason } {
  if (!rows.length) return { ok: false, reason: "no-outbound" };
  const newestAge = nowMs - Date.parse(rows[0].received_at);
  if (!Number.isFinite(newestAge)) return { ok: false, reason: "no-outbound" };
  // THE NEWEST ANCHOR DECIDES, NOT "ANY ANCHOR ANYWHERE".
  //
  // This used to ask `rows.some(isDrillAnchor)`, so ONE drill-shaped row
  // anywhere in the history permanently demoted the thread to the 3-hour
  // window - even after a real RFQ had been sent since. During the beta that
  // was catastrophic: a bug upstream stamped `test-<digits>` on real shops (see
  // wa/identity.ts), and once stamped, a thread could never recover its 14-day
  // window no matter how many genuine RFQs followed. Shops that answered the
  // next morning were gated out and their replies were never stored.
  //
  // Reading the MOST RECENT anchor is both more correct and self-healing: the
  // current nature of a conversation is whatever we last did in it, so a fresh
  // real RFQ restores the real window, and a fresh drill still retires fast.
  // Rows arrive newest-first.
  const anchor = rows.find((r) => isDrillAnchor(r.raw) || isRfqAnchor(r.raw));
  if (!anchor) return { ok: false, reason: "no-rfq-anchor" };
  // A row that is BOTH keeps the tighter window - privacy wins the tie.
  if (isDrillAnchor(anchor.raw)) {
    return newestAge < DRILL_INGEST_WINDOW_MS
      ? { ok: true, reason: "drill-window-active" }
      : { ok: false, reason: "drill-expired" };
  }
  return newestAge < REAL_THREAD_INGEST_WINDOW_MS
    ? { ok: true, reason: "active-thread" }
    : { ok: false, reason: "thread-expired" };
}
