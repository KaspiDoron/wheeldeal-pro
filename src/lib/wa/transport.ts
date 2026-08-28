// THE ONE SEND-RESULT CONTRACT.
//
// Every WhatsApp send in the app ultimately lands in `sendFromUser`
// (evolution.ts), which returns this full shape. But three seam types narrowed
// it independently - `SendFn` (agent-loop.ts), `LiveSend` (graph/engine.ts) and
// `drainOutbox`'s inline parameter - and the narrowing was a live defect:
// `ambiguous` (a status-0 send that MAY have landed) was dropped on every
// direct-send path, so those paths released the idempotency claim and could
// re-POST a message the shop already had, or misread our own echo as a human
// takeover. The drain honoured it; the routes that bypass the drain did not.
//
// This is the single source of truth for what a send returns. Widening the seam
// types to `SendResult` makes `ambiguous` visible everywhere it must be honoured
// - a type-level fix for the whole class - and it is the first piece of the
// Transport abstraction the future WABA lane plugs into.

export type SendLane = "intro" | "reply";

export interface SendResult {
  ok: boolean;
  error?: string;
  /** The rate limiter refused; `retryAfterSeconds` carries its wait. */
  rateLimited?: boolean;
  /** The send budget could not be READ - not a cap, not a host fault. Hold. */
  budgetUnreadable?: boolean;
  /** The limiter's own wait, present only on a cap refusal. */
  retryAfterSeconds?: number;
  /** Provider message id (Evolution wa_message_id / WABA messages[0].id). */
  messageId?: string;
  /** Accepted by the provider with no delivery confirmation. */
  unconfirmed?: boolean;
  /**
   * AMBIGUOUS (status-0 / abort-timeout): the message MAY have landed. The
   * contract every caller must honour: NEVER release the `msg:` idempotency
   * claim, NEVER blind-retry. The drain writes a provisional row; the direct
   * paths must at least keep the claim so a duplicate cannot follow.
   */
  ambiguous?: boolean;
  /** The resolved chat anchor, including @lid privacy chats (Evolution). */
  chatJid?: string;
}
