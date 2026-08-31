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

// ---------------------------------------------------------------------------
// THE TRANSPORT ABSTRACTION (design piece: ONE canonical negotiation engine,
// interchangeable WhatsApp adapters). Pure types here - this module imports
// nothing, so the engine can depend on the contract without depending on
// Evolution, and a second transport registers without touching the engine.
// ---------------------------------------------------------------------------

export type TransportKind = "evolution" | "cloud" | "waba";

export interface SendOpts {
  lane?: SendLane;
  /** Skip the multi-second presence simulation (drains set this). */
  fast?: boolean;
  /** Skip the sub-3s Poisson gap - ONLY where a person watches a spinner. */
  skipJitter?: boolean;
}

/**
 * WHAT A TRANSPORT CAN DO. The pacing/guard layer branches on THIS, never on
 * the transport id - that is how a 24h-service-window company number coexists
 * with the anti-ban lane without either one carrying the other's rules.
 */
export interface TransportCapabilities {
  /** Presence mimicry (typing/paused) exists. Evolution: yes (anti-ban);
   *  WABA/Cloud: no such wire concept. */
  presence: boolean;
  readReceipts: boolean;
  /**
   * May this transport open a conversation with a shop that never wrote to
   * us? Evolution: yes (the traveller's own number, guarded by the anti-ban
   * budgets). WABA: NO - cold first contact is the template lane with shop
   * opt-in, a different machine entirely (waba/dispatch).
   */
  coldFirstContact: boolean;
  /** Meta's customer-service window (hours), or null where none exists. */
  serviceWindowHours: number | null;
  media: boolean;
  /** Can recent history be re-fetched from the provider (wa-sync recovery)? */
  historyFetch: boolean;
  /** Whose name the message arrives under. */
  identity: "per-traveller" | "company-number";
}

/**
 * The normalized inbound union - what a webhook body becomes before anything
 * consumes it. Evolution's ingest produces these; the WABA/Cloud webhooks map
 * into the same union (Wave 6), so the funnel has ONE inbound shape.
 */
export type InboundEvent =
  | {
      kind: "message";
      /** The receiving identity: instance name (Evolution) / our WABA. */
      senderKey: string;
      /** The shop's digits. */
      from: string;
      chatId?: string;
      /** The provider's raw frame, for media redemption and audit. */
      frame: unknown;
      text: string;
      media?: { type: string; bytes?: number };
      providerId?: string;
      at: string;
    }
  | { kind: "receipt"; senderKey: string; providerId: string; state: "delivered" | "read" | "error"; code?: number }
  | { kind: "connection"; senderKey: string; state: "open" | "connecting" | "close"; reason?: string }
  | { kind: "call"; senderKey: string; from: string }
  | { kind: "credential-rotated"; senderKey: string };

/**
 * A WhatsApp transport. `sendText` is the one required surface; everything
 * else is optional and feature-tested by callers (`t.sendPresence?.(...)`),
 * because pretending a capability exists is exactly the lie the capabilities
 * descriptor exists to prevent.
 */
export interface Transport {
  kind: TransportKind;
  capabilities: TransportCapabilities;
  sendText(senderKey: string, to: string, text: string, opts?: SendOpts): Promise<SendResult>;
  sendPresence?(senderKey: string, to: string, state: "composing" | "paused", delayMs?: number): Promise<void>;
  markRead?(senderKey: string, messageKey: unknown): Promise<void>;
  fetchMedia?(senderKey: string, frame: unknown, opts?: { maxBytes?: number }): Promise<{ mime: string; base64: string } | null>;
  fetchProfilePicture?(senderKey: string, digits: string): Promise<string | null>;
  resolveChatId?(senderKey: string, digits: string): Promise<string | null>;
  connectionState?(senderKey: string): Promise<"open" | "connecting" | "close" | "unknown">;
}
