// THE OUTBOUND LIFECYCLE: queued -> sending -> sent, with exactly one row.
//
// The failure this exists for: a shop disappeared from the queue AND from the
// status panel while its message was going out, then reappeared. It was not a
// rendering bug. Claiming a due message DELETED its outbox row, and the "sent"
// row in whatsapp_messages was only written after the network call returned.
// Between those two moments - a guard re-check, a cancellation re-check, a
// pacing claim and a live HTTP round trip, so seconds, not milliseconds - the
// shop existed in NEITHER table. Every surface derives its state from those two
// tables, so the shop had no state at all: `stage` fell through to "found",
// which matches no status bucket, and the card simply vanished.
//
// The missing capability was a LIFECYCLE. A message in flight is a real state
// the system had no way to represent, so it was represented as absence.
//
// Worse than the flicker: the delete had no lease. If the process died mid-send
// - a Cloud Run instance recycled, a timeout - the row was gone and the message
// was lost forever, with nothing to recover from.
//
// This claims by LEASE instead: an atomic conditional update that pushes
// `not_before` beyond now and stamps the claim into `meta`. Postgres serializes
// the two writers on the row lock, so exactly one drainer wins - the same
// exactly-once guarantee the delete gave - while the row stays visible the whole
// time. A crashed drainer's lease simply expires and the row becomes due again.
//
// MIGRATION-FREE by construction: `not_before` is the lease and `meta` is
// existing JSONB. No column, no schema change, nothing for the owner to run.

import "server-only";
import { sbSelect, sbUpdate, sbDelete, sbInsert } from "../runtime-config";

/**
 * How long a drainer may hold a claimed row. Long enough to cover a guard
 * re-check plus a slow WhatsApp round trip (the transport's own hard timeout is
 * 12s), short enough that a crashed drainer's message goes out on the next
 * drain rather than sitting for an hour.
 */
export const CLAIM_LEASE_MS = 3 * 60_000;

/** How many times a row may be blocked by a live idempotency claim before we
 * stop retrying it and say so. Bounded, because "another invocation is
 * delivering it" can also mean "an invocation died holding the slot". */
export const MAX_DUP_HOLDS = 5;

export interface OutboxMeta {
  reason?: string;
  vendorId?: string;
  vendorName?: string;
  kind?: string;
  /** Epoch ms of the claim that currently owns this row. */
  claimedAt?: number;
  /** Consecutive drains blocked by a live idempotency claim. */
  dupHolds?: number;
  /**
   * Epoch ms of the FIRST drain pass that found this row due and did not send
   * it. Stamped once and never rewritten, because it is the only thing that
   * separates "deliberately scheduled for tomorrow morning" from "has been
   * bouncing around the queue all day" - `not_before` is rewritten by every
   * re-park and therefore cannot tell them apart (wa/outbox-policy).
   *
   * `null` CLEARS it, and is written only by the guard when it issues a hold
   * that is a genuinely new schedule rather than another bounce (the slow
   * introductions ceilings: waiting on replies, the monthly non-replier meter).
   * Such a row is serving a wait we gave it, and outbox-policy's doctrine is
   * explicit that a deliberate wait must not be charged as age. The absolute
   * `created_at` wall in that module still bounds a cleared row.
   */
  firstDueAt?: number | null;
  /**
   * Epoch ms at which this row's WAVE closes (plan Part 11 F1).
   *
   * Stamped at enqueue by the mass route so the drain can clamp its re-stamps
   * without re-deriving a schedule it never saw. Absent on every legacy row,
   * and absence must keep behaving exactly as it does today.
   */
  waveEndsAt?: number;
  [k: string]: unknown;
}

export interface OutboxRow {
  id: number;
  sender_key: string;
  to_number: string;
  body: string;
  not_before: string;
  meta: OutboxMeta | null;
  /**
   * When the message was COMPOSED. Optional because the column is newer than
   * some databases this code can reach, so the drain asks for it only when the
   * schema probe says it is there (see wa/outbox-policy for why age must be
   * measured from it and never from `not_before`).
   */
  created_at?: string | null;
}

export type OutboxState = "due" | "waiting" | "sending";

/**
 * What a row is doing RIGHT NOW, purely from its own fields. This is the single
 * definition every surface reads - the queue viewer, the activity feed and the
 * status panel - so they cannot disagree about a message in flight.
 *
 * `sending` is claimed and inside its lease. Once the lease lapses the row is
 * honestly `due` again: whoever held it is gone.
 */
export function outboxState(
  notBefore: string | null | undefined,
  meta: OutboxMeta | null | undefined,
  nowMs: number
): OutboxState {
  const claimedAt = Number(meta?.claimedAt);
  if (Number.isFinite(claimedAt) && nowMs - claimedAt < CLAIM_LEASE_MS) return "sending";
  const at = Date.parse(String(notBefore ?? ""));
  if (!Number.isFinite(at)) return "due";
  return at <= nowMs ? "due" : "waiting";
}

/** The ISO instant a claim taken now expires at. */
export function leaseUntil(nowMs: number): string {
  return new Date(nowMs + CLAIM_LEASE_MS).toISOString();
}

/**
 * ATOMIC CLAIM. Returns the row only to the caller that actually won it.
 *
 * `not_before=lte.<now>` in the filter is the lock: two concurrent drainers
 * serialize on the row, and the loser re-evaluates the predicate against the
 * winner's committed row - where `not_before` is now the lease - so it matches
 * nothing and gets []. Exactly the guarantee delete-with-return provided, minus
 * the window where the row does not exist.
 */
export async function claimOutboxRow(
  id: number,
  meta: OutboxMeta | null,
  nowMs: number
): Promise<boolean> {
  const { sbUpdateReturning } = await import("../runtime-config");
  const rows = await sbUpdateReturning<{ id: number }>(
    "wa_outbox",
    `id=eq.${id}&not_before=lte.${encodeURIComponent(new Date(nowMs).toISOString())}`,
    { not_before: leaseUntil(nowMs), meta: { ...(meta ?? {}), claimedAt: nowMs } }
  ).catch(() => [] as { id: number }[]);
  return rows.length > 0;
}

/**
 * Hand a claimed row back to the queue: it is queued again, at a new time, with
 * an honest reason. The row never left, so there is nothing to re-insert and
 * nothing that can be lost by a failed insert - which is what made the old
 * re-queue paths need a retry-and-log dance of their own.
 */
export async function releaseOutboxRow(
  id: number,
  notBefore: string,
  meta: OutboxMeta | null
): Promise<boolean> {
  const next: OutboxMeta = { ...(meta ?? {}) };
  delete next.claimedAt;
  return await sbUpdate("wa_outbox", `id=eq.${id}`, { not_before: notBefore, meta: next }).catch(
    () => false
  );
}

/** The message left (or was deliberately dropped): retire its row. */
export async function completeOutboxRow(id: number): Promise<void> {
  await sbDelete("wa_outbox", `id=eq.${id}`).catch(() => {});
}

/**
 * THE SENT HALF OF THE LIFECYCLE, WRITTEN HONESTLY (audit F014).
 *
 * A delivered send is anchored by its outbound whatsapp_messages row: that row
 * is what resolveThreadContext finds when the shop answers, and without it the
 * reply dies as `no-rfq-thread` for the life of the thread. The drain, the mass
 * route and the price re-check all wrote it with a bare `await sbInsert(...)`
 * and discarded the boolean - and sbInsert never throws, it answers false on
 * any non-2xx or timed-out write. So one blip on that insert, after the shop
 * had already received the message, silently killed the conversation while
 * the card said "contacted".
 *
 * This retries the insert once and, if the anchor is still lost, writes the
 * existing `outbound-log-failed` breadcrumb with the join columns stamped as
 * COLUMNS (or it is invisible to every per-user surface) and the provider id
 * in the detail, so a later sweep can re-anchor the thread. It deliberately
 * does NOT defer the caller's retire of the outbox row: a delivered row left
 * pending is a second real WhatsApp message to the shop on the next drain,
 * which is worse than a lost log row. The common case costs exactly the one
 * insert it always did.
 */
export async function recordOutboundAnchor(
  row: Record<string, unknown> & { wa_message_id?: string | null; body?: string },
  who: {
    senderKey: string;
    toNumber: string;
    vendorId?: string;
    vendorName?: string;
    channel?: string;
  }
): Promise<boolean> {
  let ok = await sbInsert("whatsapp_messages", [row]).catch(() => false);
  if (!ok) ok = await sbInsert("whatsapp_messages", [row]).catch(() => false);
  if (ok) return true;
  const raw = (row.raw ?? {}) as { kind?: unknown };
  await sbInsert("agent_events", [
    {
      kind: "outbound-log-failed",
      user_email: who.senderKey,
      to_number: who.toNumber,
      vendor_id: String(who.vendorId ?? ""),
      vendor_name: String(who.vendorName ?? who.toNumber),
      detail: JSON.stringify({
        email: who.senderKey,
        channel: who.channel ?? "personal-wa",
        waMessageId: row.wa_message_id ?? null,
        kind: typeof raw.kind === "string" ? raw.kind : null,
        body: String(row.body ?? "").slice(0, 200),
        note: "the message reached the shop but its outbound row was lost twice - the thread has no anchor until it is re-anchored",
      }).slice(0, 800),
    },
  ]).catch(() => {});
  return false;
}

/**
 * ONE DEFINITION OF "THIS SEND WAS INTERRUPTED".
 *
 * A claim that never completed means a drainer died mid-send. The lease is its
 * own fix - the row is due again by definition - but the owner still needs to
 * SEE it, or an interrupted send stays folklore.
 *
 * Pure, and shared. The engine inspector had its own copy of this arithmetic
 * inline while `lapsedClaims` below held the other, so the rule that decides
 * whether the ops panel says "interrupted" existed twice and could disagree
 * with itself. Both now ask this.
 */
export function isLapsedClaim(meta: OutboxMeta | null | undefined, nowMs: number): boolean {
  const at = Number(meta?.claimedAt);
  return Number.isFinite(at) && nowMs - at >= CLAIM_LEASE_MS;
}

/**
 * Rows for ONE sender whose claim has lapsed - the per-thread answer to "where
 * is this message held", scoped so a user's ops view never reaches across
 * accounts. The inspector's global view filters with `isLapsedClaim` directly.
 */
export async function lapsedClaims(senderKey: string, nowMs: number): Promise<OutboxRow[]> {
  const rows = await sbSelect<OutboxRow>(
    "wa_outbox",
    `select=id,sender_key,to_number,body,not_before,meta&sender_key=eq.${encodeURIComponent(
      senderKey
    )}&meta->>claimedAt=not.is.null&limit=50`
  ).catch(() => [] as OutboxRow[]);
  return rows.filter((r) => isLapsedClaim(r.meta, nowMs));
}
