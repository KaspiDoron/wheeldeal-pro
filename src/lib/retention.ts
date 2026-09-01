// RETENTION THAT RUNS ITSELF.
//
// `supabase/retention.sql` installs `prune_old_rows()` AND tries to schedule it
// nightly via pg_cron - but the schedule block degrades to a NOTICE nobody
// reads when the extension is absent, and a paused free-tier project runs no
// cron at all. Both outcomes look identical from here: the health tile said
// "NEVER RAN - no prune heartbeat exists" with no way to tell an unscheduled
// database from an unrun one, and no way for the app to do anything about it.
//
// The function is granted to `service_role`, which is exactly the key this app
// holds, and PostgREST exposes it at /rest/v1/rpc/prune_old_rows. So the app
// can simply CALL it from the cron ping it already runs every minute. pg_cron
// becomes a nice-to-have instead of a dependency.
//
// THE LOCK IS THE HEARTBEAT ITSELF. There is deliberately no claim row: the
// obvious candidate (`wa_send_claims`) is garbage-collected at 2h by
// `gcSendClaims`, so a daily claim would evaporate and the prune could fire a
// dozen times a day. Reading the newest heartbeat is self-consistent by
// construction - the row that proves it ran is the row that stops it running
// again - and it costs one indexed query.

import { sbSelectDark, sbRpc } from "@/lib/runtime-config";
import { noteAgentEvent } from "@/lib/events";

/** How stale the newest heartbeat must be before another prune is attempted.
 * Under a nightly pg_cron schedule this never fires (the heartbeat is always
 * < 24h old at the moment of interest); it only takes over when the schedule
 * is missing. Below 24h so a self-run drifts forward rather than skipping a
 * day, above the 48h the health tile calls stale so the tile never goes red
 * on a database this path is keeping current. */
export const RETENTION_MIN_GAP_MS = 20 * 3600_000;

/** Matches `supabase/retention.sql`'s own default and the pg_cron schedule it
 * writes (`select public.prune_old_rows(90)`) - the two paths must prune to the
 * same windows or the retention policy depends on who happened to run it. */
export const RETENTION_RETAIN_DAYS = 90;

/** Both kinds gate the next attempt: a database with no `prune_old_rows` would
 * otherwise re-attempt (and re-breadcrumb) on every single ping, because the
 * thing that would have gated it is the row the missing function never wrote. */
const GATE_KINDS = "retention-ran,retention-unavailable";

export type RetentionOutcome =
  /** The RPC confirmed. A fresh `retention-ran` row now exists. */
  | "ran"
  /** A heartbeat inside RETENTION_MIN_GAP_MS already exists - nothing to do. */
  | "recent"
  /** The heartbeat could not be READ. We do not know whether retention has run,
   * so we do not run it: an ungated prune on an unreadable store is exactly the
   * repeat-execution this gate exists to prevent. */
  | "unreadable"
  /** PostgREST answered 404: `prune_old_rows` has never been created, i.e. the
   * owner has not run supabase/retention.sql. Only the owner can fix this. */
  | "missing"
  /** The call did not confirm. Postgres may still have committed (the RPC
   * outlives sbRpc's client-side timeout on a big first prune), so this is
   * "unknown", not "failed to prune" - the next attempt re-reads the heartbeat
   * and will correctly skip if the work actually landed. */
  | "unconfirmed";

/**
 * Run the retention prune if nothing has run it recently. Best-effort and
 * never throws: this is called from the keep-awake cron, which must not fail
 * because housekeeping did.
 */
export async function maybeRunRetention(nowMs: number = Date.now()): Promise<RetentionOutcome> {
  let rows: { created_at: string; kind: string }[] | null = null;
  try {
    rows = await sbSelectDark<{ created_at: string; kind: string }>(
      "agent_events",
      `select=created_at,kind&kind=in.(${GATE_KINDS})&order=created_at.desc&limit=1`
    );
  } catch {
    return "unreadable";
  }
  if (rows === null) return "unreadable";

  const last = rows[0]?.created_at ? Date.parse(rows[0].created_at) : NaN;
  if (Number.isFinite(last) && nowMs - last < RETENTION_MIN_GAP_MS) return "recent";

  let res: { ok: true } | { ok: false; missing: boolean };
  try {
    res = await sbRpc("prune_old_rows", { retain_days: RETENTION_RETAIN_DAYS });
  } catch {
    return "unconfirmed";
  }
  if (res.ok) return "ran";

  if (res.missing) {
    // The breadcrumb is what lets the health tile say "the function does not
    // exist - run supabase/retention.sql" instead of the generic red, AND what
    // stops this from re-attempting every ping.
    await noteAgentEvent({
      kind: "retention-unavailable",
      userEmail: "",
      toNumber: "",
      detail: JSON.stringify({ reason: "prune_old_rows not found - run supabase/retention.sql" }),
    }).catch(() => false);
    return "missing";
  }
  return "unconfirmed";
}
