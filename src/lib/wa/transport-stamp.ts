// THE THREAD'S TRANSPORT STAMP - written once, at first delivered contact.
//
// resolveTransport (wa/transports) reads negotiation_threads.fields.transport
// as its HIGHEST authority: a conversation never changes wire mid-thread. That
// only means anything if something actually writes the stamp - and writes it
// exactly once. This is that writer.
//
// Write-once is enforced in the FILTER (`fields->>transport=is.null` - which
// also matches a row whose whole fields column is null, since NULL->>x is
// NULL), not in application code, so two racing contacts cannot both stamp.
// The engine's own persist spreads the prior fields forward
// (`{ ...base.fields }` in spte/live persistThreadOutcome), so the stamp
// survives every later turn.
//
// Why "first DELIVERED contact" and not selection time: until a message is on
// the wire the transport is a plan, and plans may still fall back (a WABA
// dry-run rehearsal falls through to Evolution; a refused lead does too).
// Stamping the wire that actually carried the RFQ is the only stamp that can
// never contradict the anchor row.

import { sbSelect, sbUpdateReturning } from "../runtime-config";

export type WireTransport = "evolution" | "waba" | "cloud";

export function isWireTransport(v: unknown): v is WireTransport {
  return v === "evolution" || v === "waba" || v === "cloud";
}

/** Stamp the thread's transport, write-once. Returns true only when THIS call
 *  landed the stamp; false covers already-stamped, row-absent and unreadable
 *  alike (callers treat the stamp as best-effort bookkeeping, never control
 *  flow). */
export async function stampThreadTransport(
  threadKey: string,
  kind: WireTransport
): Promise<boolean> {
  try {
    const rows = await sbSelect<{ fields: Record<string, unknown> | null }>(
      "negotiation_threads",
      `select=fields&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
    );
    if (!rows.length) return false;
    const fields = rows[0].fields;
    if (fields && typeof fields.transport === "string") return false;
    const updated = await sbUpdateReturning<{ thread_key: string }>(
      "negotiation_threads",
      `thread_key=eq.${encodeURIComponent(threadKey)}&fields->>transport=is.null`,
      { fields: { ...(fields ?? {}), transport: kind } }
    );
    return updated.length > 0;
  } catch {
    return false;
  }
}
