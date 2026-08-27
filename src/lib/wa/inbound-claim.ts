// Store-level idempotency for inbound WhatsApp messages.
//
// Two DIFFERENT things need exactly-once semantics, and conflating them caused
// two separate bugs:
//
//   1. STORING the message row. Evolution redelivers webhooks and the recovery
//      sync pulls the same window, so an unconditional insert produced the
//      duplicate "[photo]" rows visible in the transcript. -> claimInboundStore
//
//   2. REPLYING to the message. Exactly one agent turn per message.
//      -> the existing wa_processed claim in agent-loop.
//
// They must stay separate: the reply claim is taken only once a thread actually
// resolves, so a message dropped as "no-rfq-thread" can still be replayed after
// the thread is repaired. If one claim served both, every dropped message would
// be permanently unrecoverable.
//
// Storage: a `wa_inbound_seen` row keyed by the provider message id. The table
// is created by schema.sql; when it is missing (un-migrated deployment) we FAIL
// OPEN - a duplicate row is far better than silently losing a shop's reply.

import "server-only";
import { sbInsertReturning, sbSelect } from "../runtime-config";

/**
 * RECEIVER-SCOPED CLAIM KEY (owner report 6, H4). Both claim tables are keyed
 * by the bare provider message id - which WhatsApp does NOT promise is unique
 * across RECEIVERS. A shop broadcasting one promo to two travellers delivers
 * the same id to both; whoever's webhook lands first claims it globally and
 * the second traveller's copy is silently dropped as a "duplicate" of a
 * message they never saw. Scoping the key by the receiving account makes the
 * claim mean what it always intended: "THIS user's copy is handled."
 *
 * Legacy rows carry the bare id; every reader below honors BOTH spellings so
 * a deploy never re-answers what an older instance already claimed.
 */
/**
 * A PostgREST `in.(...)` value list with every key URL-ENCODED (owner report 11).
 *
 * The claim key is `email:messageId`, and a `+`-address (Gmail's `you+tag@...`,
 * common among testers) is stored LITERALLY by the insert - it goes in a JSON
 * body - but read back through a QUERYSTRING filter, where `+` decodes to a
 * space. So `in.("doron+test@x.co:MSG")` asked PostgREST for
 * `"doron test@x.co:MSG"`, the release/dedup/stand-down reads all MISSED the
 * row the insert stored, and the recovery sweep re-answered an already-answered
 * shop (and a concurrent frame could double-reply). Encoding the value - and
 * ONLY the value, never the structural quotes - makes the querystring round-trip
 * to the exact stored key. The double quotes stay outside the encoding so the
 * in-list syntax is preserved.
 */
export function quotedInList(keys: string[]): string {
  return keys.map((k) => `"${encodeURIComponent(k)}"`).join(",");
}

export function claimKey(receiverEmail: string | null | undefined, waMessageId: string): string {
  const id = (waMessageId || "").trim();
  const who = (receiverEmail || "").trim().toLowerCase();
  return who && id ? `${who}:${id}` : id;
}

/**
 * Hand a reply claim BACK.
 *
 * The claim is a LEASE on "someone is answering this message", not a tombstone
 * meaning "this message is finished with". It was being used as the latter: the
 * row was inserted before the thread even resolved and was never removed, so a
 * turn that threw - an LLM outage, a Supabase blip, any exception between the
 * claim and the send - left the message permanently un-replyable AND
 * un-replayable. The recovery sweep could not help either, because it skips
 * anything already STORED and never asks whether a reply happened.
 *
 * That is one shop out of seven going quiet with nothing in any log.
 */
export async function releaseReplyClaim(
  waMessageId: string,
  receiverEmail?: string | null
): Promise<void> {
  const id = (waMessageId || "").trim();
  if (!id) return;
  try {
    const { sbDelete } = await import("../runtime-config");
    // Both spellings (H4): the claim may have been taken scoped or bare.
    const scoped = claimKey(receiverEmail, id);
    const keys = scoped === id ? [id] : [id, scoped];
    await sbDelete(
      "wa_processed",
      `wa_message_id=in.(${quotedInList(keys)})`
    );
  } catch {
    /* best effort - the next redelivery or sweep retries */
  }
}

/**
 * Hand a STORE claim back - taken when the winner's insert then FAILED. The
 * claim without a row behind it turned every redelivery into a silent no-op:
 * the message existed nowhere, and the dedup layer guaranteed it never would.
 */
export async function releaseInboundStore(
  waMessageId: string,
  receiverEmail?: string | null
): Promise<void> {
  const id = (waMessageId || "").trim();
  if (!id) return;
  try {
    const { sbDelete } = await import("../runtime-config");
    const scoped = claimKey(receiverEmail, id);
    const keys = scoped === id ? [id] : [id, scoped];
    await sbDelete(
      "wa_inbound_seen",
      `wa_message_id=in.(${quotedInList(keys)})`
    );
  } catch {
    /* best effort - the sweep can still re-pull the window */
  }
}

/**
 * True when THIS caller owns the message and should store it. False when
 * another delivery already stored it (skip). Fails open (true) if the claim
 * store is unavailable.
 *
 * (This doc block used to sit sixty lines up, immediately above
 * `releaseReplyClaim`, so every IDE hover on that function showed the contract
 * of a different one - "fails open (true)" for a function that returns void.)
 */
export async function claimInboundStore(
  waMessageId: string,
  receiverEmail?: string | null
): Promise<boolean> {
  const id = (waMessageId || "").trim();
  if (!id) return true; // no id to dedupe on - store it
  const key = claimKey(receiverEmail, id);
  try {
    // Legacy first (H4): a bare-id row from before scoping means THIS message
    // was already stored by an older instance - honor it before writing a
    // scoped claim beside it would double-store the row.
    if (key !== id) {
      const legacy = await sbSelect<{ wa_message_id: string }>(
        "wa_inbound_seen",
        `select=wa_message_id&wa_message_id=eq.${encodeURIComponent(id)}&limit=1`
      );
      if (legacy.length > 0) return false;
    }
    const claimed = await sbInsertReturning<{ wa_message_id: string }>("wa_inbound_seen", [
      { wa_message_id: key },
    ]);
    if (claimed.length > 0) return true; // we won the race
    // Insert returned nothing: either a duplicate-key conflict (someone else
    // owns it) or the table is missing. Distinguish, so a missing table never
    // silences inbound.
    const existing = await sbSelect<{ wa_message_id: string }>(
      "wa_inbound_seen",
      `select=wa_message_id&wa_message_id=eq.${encodeURIComponent(key)}&limit=1`
    );
    return existing.length === 0; // present => already stored => skip
  } catch {
    return true; // store unreachable - never drop a real shop reply
  }
}

/**
 * THE LAST-RESORT WINNER ELECTION, WHEN `wa_processed` IS GONE.
 *
 * The reply claim above is the normal path. When its table is missing or
 * unreachable, something still has to decide which of two concurrent webhook
 * deliveries composes the answer - and the fallback that used to do it COUNTED
 * stored inbound rows and stood down when it saw more than one.
 *
 * That is symmetric, which makes it the one answer that cannot work: both
 * deliveries read the same two rows, both conclude "the other one has this",
 * and the shop gets ZERO replies. A traveller watching a dead thread is a far
 * worse outcome than the duplicate the rule was written to prevent.
 *
 * So: elect, don't count. `wa_send_claims` is an atomic conditional insert in
 * a DIFFERENT table, so the outage that took `wa_processed` out does not take
 * the election with it, and exactly one caller is told it won.
 *
 * FAILS OPEN, like every other claim here: if that table is unreachable too,
 * the answer is "you won". A rare duplicate beats a silent conversation, and
 * the per-thread turn lock still stands in front of the common case.
 */
export async function electReplyOwner(
  senderEmail: string | null | undefined,
  replyKey: string
): Promise<boolean> {
  if (!replyKey) return true;
  try {
    const { sbInsertClaim } = await import("../runtime-config");
    const claim = await sbInsertClaim("wa_send_claims", {
      sender_key: senderEmail ?? "",
      slot_key: `inbound:${replyKey}`,
    });
    return claim !== "lost";
  } catch {
    return true; // claims unreachable - never silence a shop
  }
}


/** How long an unsettled claim is honored before it is treated as a dead turn.
 *  A whole turn is bounded at ~60s, so ten minutes is far past any live one -
 *  and every failed turn releases its claim explicitly, so reaching this
 *  threshold means the process itself went away mid-turn. */
export const CLAIM_LEASE_MS = 10 * 60_000;

/**
 * Mark a claim as SETTLED: a reply actually went out for this message.
 *
 * Without this the claim was a tombstone that could not tell "answered" from
 * "the instance died holding it", so the recovery sweep skipped a dead turn's
 * message forever. Best-effort by design - on a pre-migration deployment the
 * column is absent and everything behaves exactly as it did before.
 */
export async function settleReplyClaim(
  waMessageId: string,
  receiverEmail?: string | null
): Promise<void> {
  const id = (waMessageId || "").trim();
  if (!id) return;
  const { sbUpdate } = await import("../runtime-config");
  const key = claimKey(receiverEmail, id);
  await sbUpdate(
    "wa_processed",
    `wa_message_id=eq.${encodeURIComponent(key)}`,
    { settled_at: new Date().toISOString() }
  ).catch(() => {});
}

/**
 * Is this claim a dead turn's leftover - held past the lease, never settled?
 *
 * Deliberately conservative: anything settled, anything young, and anything we
 * cannot read is treated as a LIVE claim. Re-answering a message that was in
 * fact answered would put a second message into a real shop's chat, which is a
 * worse failure than the silence this repairs.
 */
export function claimIsDeadTurn(
  row: { created_at?: string | null; settled_at?: string | null } | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!row) return false;
  if (row.settled_at) return false; // a reply really did go out
  const started = Date.parse(row.created_at ?? "");
  if (!Number.isFinite(started)) return false; // unreadable - assume live
  return nowMs - started > CLAIM_LEASE_MS;
}
