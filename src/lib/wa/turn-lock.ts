// NOTE: deliberately NOT `server-only`, and the DB layer is imported lazily
// below - the slot/bucket rules above are pure and must stay unit-testable
// (same shape as anchor-recovery.ts).
import { digitsOnly } from "../phone";

// ONE TURN AT A TIME, PER THREAD.
//
// A shop sent three messages in a row (price list, deposit terms, "which model
// would you like?"). Two of them arrived as separate webhook deliveries, each
// ran a complete turn, and the traveller's agent sent TWO bargain messages to
// the same shop inside the same minute:
//
//     16:52  "Hi again! Any chance of a better daily rate for the scooter?..."
//     16:52  "thanks! Any chance you can do a bit better for 8 days?"
//
// Every existing exactly-once mechanism was doing its job and none of them
// applied. The system has atomic claims for a MESSAGE ID (wa_processed), an
// OUTBOX ROW, a WAKEUP ROW and a MESSAGE BODY (a sha256 of the text) - but
// nothing that says "this (traveller, shop) thread is mid-turn". Two different
// inbound frames legitimately win their own message claims, and two
// independently composed drafts hash to two different bodies, so the body-level
// idempotency cannot see that they are the same conversational moment.
//
// Worse, the counters that WOULD have stopped the second draft - rounds so far,
// bargains already sent, the ledger's outstanding asks - are all derived from
// the outbound row, and that row is written only AFTER the network send. While
// turn A is composing, turn B reads a thread state identical to A's and reaches
// the same conclusion. Every read is correct; the reads are just concurrent.
//
// So the missing primitive is a per-thread lock. On Cloud Run no in-memory lock
// works (N instances), so it is a DB conditional insert - and `wa_send_claims`
// already is exactly that, which is why this needs no migration and no new
// table. Its GC already sweeps non-`msg:` slots.

/** A full compose is bounded by the turn deadline (~45s) - but the turn is
 *  more than the compose: comprehension, localization, the guard and the
 *  paced send ride the same invocation, and a 60s window let a slow-but-alive
 *  turn's sibling claim the NEXT bucket and run concurrently anyway. Two
 *  minutes covers the whole envelope; the straddle rule still frees the
 *  thread the moment the window rolls past a finished turn. */
export const TURN_WINDOW_SEC = 120;

/**
 * THE OTHER RACE, SAME PRIMITIVE: the traveller's own taps.
 *
 * In the field, every tap on "Push harder" / "Bargain" composed a FRESH draft
 * and sent it kind:"custom" - so the exact-text dedupe (a sha of the body)
 * never matched, and one impatient minute put three near-identical bargain
 * messages into a real shop's chat. The missing statement is not "this text
 * was sent" but "the traveller already made a move in this thread just now".
 * Three minutes is one human conversational beat: long enough that a second
 * tap inside it is the same intent, short enough that a genuine follow-up
 * (the shop answered, push again) is never blocked.
 */
export const USER_MOVE_WINDOW_SEC = 180;

/** The bucket a moment falls into. Same shape as the pacing gap buckets. */
export function turnBucket(nowMs: number, windowSec: number = TURN_WINDOW_SEC): number {
  return Math.floor(nowMs / (Math.max(1, windowSec) * 1000));
}

/** The slot a (thread, bucket) pair occupies. Deliberately NOT prefixed `msg:`
 *  so the existing 2h claim GC reclaims it. */
export function threadTurnSlot(toDigits: string, bucket: number): string {
  return `turn:${digitsOnly(toDigits)}:${bucket}`;
}

/** The slot ONE user-initiated move per (sender, shop) window occupies. Same
 *  non-`msg:` namespace, so the existing GC sweeps it too. */
export function userMoveSlot(toDigits: string, bucket: number): string {
  return `umove:${digitsOnly(toDigits)}:${bucket}`;
}

export type TurnClaim = "won" | "lost" | "error";

/**
 * Claim the right to run THIS thread's turn now.
 *
 * Straddle-proof in the same way the pacing gap is: winning the current bucket
 * also requires the PREVIOUS bucket to be free, so two turns that land either
 * side of a bucket boundary cannot both proceed.
 *
 * FAILS OPEN. A missing or unreachable claim table must never silence a shop -
 * a rare duplicate is a far smaller harm than a conversation going dead, and
 * that is the same call `claimInboundStore` and `claimSendSlots` already make
 * for a pre-migration deployment.
 */
export async function claimThreadTurn(
  senderKey: string,
  toDigits: string,
  nowMs: number = Date.now()
): Promise<TurnClaim> {
  return claimWindowSlot(senderKey, toDigits, nowMs, TURN_WINDOW_SEC, threadTurnSlot);
}

/**
 * Claim the right to make a USER-initiated move in this thread now.
 *
 * Identical mechanics to the turn claim (straddle-proof two-bucket insert on
 * wa_send_claims, fails open pre-migration) over the longer human window. The
 * caller that loses gets an HONEST refusal to show - never a silent drop and
 * never a second near-identical bargain in the same shop chat.
 */
export async function claimUserMove(
  senderKey: string,
  toDigits: string,
  nowMs: number = Date.now()
): Promise<TurnClaim> {
  return claimWindowSlot(senderKey, toDigits, nowMs, USER_MOVE_WINDOW_SEC, userMoveSlot);
}

async function claimWindowSlot(
  senderKey: string,
  toDigits: string,
  nowMs: number,
  windowSec: number,
  slotFor: (toDigits: string, bucket: number) => string
): Promise<TurnClaim> {
  if (!senderKey || !toDigits) return "won";
  const { sbInsertClaim, sbSelectStrict } = await import("../runtime-config");
  const bucket = turnBucket(nowMs, windowSec);
  const got = await sbInsertClaim("wa_send_claims", {
    sender_key: senderKey,
    slot_key: slotFor(toDigits, bucket),
  });
  if (got === "lost") return "lost";
  if (got === "error") {
    const probe = await sbSelectStrict("wa_send_claims", "select=slot_key&limit=1");
    if ("error" in probe && probe.error === "missing") return "won"; // pre-migration
    return "error";
  }
  // We hold the current bucket. If a sibling holds the previous one it is still
  // inside the window, so stand down and let it finish.
  const prev = await sbInsertClaim("wa_send_claims", {
    sender_key: senderKey,
    slot_key: slotFor(toDigits, bucket - 1),
  });
  if (prev === "lost") {
    // We hold ONLY the current bucket here - the SIBLING owns the previous
    // one. Hand back exactly our slot; releasing both (as the full release
    // does) would destroy the sibling's live claim and let two turns run.
    const { sbDelete } = await import("../runtime-config");
    await sbDelete(
      "wa_send_claims",
      `sender_key=eq.${encodeURIComponent(senderKey)}&slot_key=eq.${encodeURIComponent(
        slotFor(toDigits, bucket)
      )}`
    ).catch(() => {});
    return "lost";
  }
  return "won";
}

/**
 * Give the thread back early.
 *
 * A turn that ends without sending anything - silent, held, blocked - must not
 * freeze its thread for the rest of the window, or a shop's next message waits
 * a minute for nothing.
 *
 * RELEASES EXACTLY WHAT THE CLAIM TOOK. claimThreadTurn inserts TWO slots
 * (the current bucket and the previous one); this used to delete only the
 * bucket computed at RELEASE time - so a turn straddling the 60s boundary
 * deleted a slot it never held while leaving BOTH held rows behind, and the
 * leaked claims made a shop's next messages lose their turns (a 3-message
 * burst like Qui's price run could lose two of three). Callers pass the
 * CLAIM-time timestamp; both claimed slots are removed.
 */
export async function releaseThreadTurn(
  senderKey: string,
  toDigits: string,
  nowMs: number = Date.now()
): Promise<void> {
  return releaseWindowSlot(senderKey, toDigits, nowMs, TURN_WINDOW_SEC, threadTurnSlot);
}

/**
 * Give a user move back. ONLY for a move that did not happen - a failed send,
 * a guard refusal with nothing queued. A move that sent or queued keeps its
 * claim: the window IS the debounce.
 */
export async function releaseUserMove(
  senderKey: string,
  toDigits: string,
  nowMs: number = Date.now()
): Promise<void> {
  return releaseWindowSlot(senderKey, toDigits, nowMs, USER_MOVE_WINDOW_SEC, userMoveSlot);
}

async function releaseWindowSlot(
  senderKey: string,
  toDigits: string,
  nowMs: number,
  windowSec: number,
  slotFor: (toDigits: string, bucket: number) => string
): Promise<void> {
  if (!senderKey || !toDigits) return;
  const { sbDelete } = await import("../runtime-config");
  const bucket = turnBucket(nowMs, windowSec);
  const slots = [slotFor(toDigits, bucket), slotFor(toDigits, bucket - 1)];
  await sbDelete(
    "wa_send_claims",
    `sender_key=eq.${encodeURIComponent(senderKey)}&slot_key=in.(${slots
      .map((s) => `"${encodeURIComponent(s)}"`)
      .join(",")})`
  ).catch(() => {});
}
