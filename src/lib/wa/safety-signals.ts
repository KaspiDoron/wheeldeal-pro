// HEALTH THAT CAN BE RED.
//
// During the live incident the banner said "Messaging: All good" while the
// webhook was dropping every reply and the guard was terminally deleting
// queued sends: "healthy" was derived from reputation + `queue length == 0`,
// so CANCELLING the queue forced the banner green. The missing capability was
// a health verdict computed from the signals that actually fail in production
// - connection state, drop events, inbound liveness - with the queue length
// demoted to what it really is (a pacing detail).
//
// This module is the PURE half: the drop-reason taxonomy (which drops are
// deliberate vs which mean the user is losing messages), the state
// classification, and the traveller-safe feed copy for surfaced drops. The
// impure half (collecting the signals from the DB) lives in wa-guard's
// senderSafety, which feeds this and returns the verdict.

/** Drops that are DELIBERATE outcomes of a working system - a privacy gate
 * doing its job, a user's own pause, a coalesced duplicate turn. They must
 * never turn the banner red or spam the feed. Everything NOT listed here is
 * loud by default: an unknown new reason is a problem until proven benign. */
export const BENIGN_DROP_REASONS: ReadonlySet<string> = new Set([
  "vendor-gate", // not a shop thread (drill/personal chat) - blocking is the feature
  "takeover-hold", // the user is typing themselves
  "pause-hold", // the user paused the agents
  "session-terminated", // the search was closed
  "turn-in-flight", // coalesced into the sibling turn that owns the thread
  "store-claim-lost", // another delivery already ingested it
  "batch-truncated", // deferred to the recovery sweep, not lost
  // A frame of a photo BURST whose LEADER runs the single coalesced turn
  // (wa/ingest.ts image-burst). Its row is stored and its bytes ride the
  // leader's call - only the duplicate turn stands down. ingest.ts's own
  // comment already called it "never mistaken for a dropped one"; the taxonomy
  // had simply never been told, so a photo that WAS read raised "a shop reply
  // needs attention" in the traveller's feed.
  "image-coalesced",
  // Group / status-broadcast / newsletter JIDs. Never a shop by definition
  // (wa/phone-key.ts waIdKind), and on a personal number this fires all day.
  "non-chat-jid",
  // The traveller's hunt TTL simply ran out. Its sibling "session-terminated"
  // (a hunt the user cleared) has always been benign; the expiry spelling was
  // invented later and never added, so the SAME outcome was silent when the
  // user closed the search and loud when the clock did.
  "session-expired",
]);

export function isLoudDrop(reason: string): boolean {
  return !BENIGN_DROP_REASONS.has(reason);
}

/** What senderSafety measured for one sender. All fields degrade to null/0
 * when a read fails - classification only ever FLAGS on positive evidence. */
export interface SafetySignals {
  /** wa_sessions.status - "open" | "connecting" | "close" | null. */
  connection: string | null;
  lastWebhookOkAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  /** LOUD inbound-dropped events in the last 24h (benign reasons excluded). */
  inboundDropped24h: number;
  /** send-dropped events in the last 24h (every one is a message the user
   * expected to go out and did not). */
  sendDropped24h: number;
}

const LIVE_THREAD_WINDOW_MS = 48 * 3600_000;

export interface SafetyFlag {
  state: "disconnected" | "attention";
  reason: string;
  publicReason: string;
}

/**
 * The verdict layer between "paused" (reputation, strongest) and "pacing"
 * (queue). Returns null when nothing is wrong - POSITIVE evidence only, so a
 * failed signal read can never paint a healthy number red.
 */
export function classifySafety(s: SafetySignals, nowMs: number): SafetyFlag | null {
  const lastOut = s.lastOutboundAt ? Date.parse(s.lastOutboundAt) : NaN;
  const liveThreads = Number.isFinite(lastOut) && nowMs - lastOut < LIVE_THREAD_WINDOW_MS;

  // A durably-unlinked WhatsApp while conversations are live means every shop
  // reply is bouncing. "close" is the state machine's genuine-unlink verdict;
  // "connecting" (pre-first-link) and null (no row / read failed) stay quiet.
  if (s.connection === "close" && liveThreads) {
    return {
      state: "disconnected",
      reason: "wa_sessions status is close while outbound threads are live",
      publicReason:
        "WhatsApp is disconnected, so shop replies cannot reach the app - reconnect in Profile to keep your conversations moving.",
    };
  }

  const drops = s.inboundDropped24h + s.sendDropped24h;
  if (drops > 0) {
    return {
      state: "attention",
      reason: `${s.inboundDropped24h} inbound-dropped / ${s.sendDropped24h} send-dropped in 24h`,
      publicReason:
        "Some messages needed attention in the last day - check the activity feed to see what happened to each one.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Feed copy for surfaced drops - the activity feed's honest voice.
// ---------------------------------------------------------------------------

export interface DropFeedItem {
  title: string;
  detail: string;
}

const INBOUND_DETAIL: Record<string, string> = {
  "no-rfq-thread":
    "A message arrived from a number your agent never contacted, so it was not linked to any shop.",
  "unresolved-identity":
    "A reply arrived from a hidden WhatsApp identity and couldn't be matched to a shop yet.",
  "empty-media": "The shop sent a photo or voice note that couldn't be downloaded.",
  "derived-unattributed": "A reply was saved but couldn't be linked to a shop card.",
  "vendor-gate-unavailable":
    "A reply couldn't be checked on the first try - it is retried automatically.",
  "store-failed": "A reply couldn't be saved on the first try - it is retried automatically.",
  "sync-turn-failed":
    "A recovered reply couldn't be answered on the first try - it is retried automatically.",
  "sync-error": "Checking this shop's thread failed once - it is retried automatically.",
  // The mirror image of the benign holds above: the agent stood down not
  // because the traveller was typing or had paused, but because OUR store could
  // not answer whether they were. That is a muted shop reply, and it is loud.
  "takeover-unreadable":
    "A reply couldn't be answered because your records were briefly unreadable - it retries automatically.",
  "pause-unreadable":
    "A reply couldn't be answered because your records were briefly unreadable - it retries automatically.",
  // Same family: the thread lookup itself could not be answered. Distinct from
  // `no-rfq-thread`, which is the deliberate "we never contacted this number".
  "thread-unreadable":
    "A reply couldn't be matched to its shop because your records were briefly unreadable - it retries automatically.",
  // The message's own chat JID did not match the number we were about to file
  // it under. Always a refusal to guess, never a lost shop reply - but it used
  // to leave no trace at all.
  "origin-mismatch":
    "A message arrived from a different chat than the one it appeared to belong to, so it was not filed against a shop.",
};

/**
 * The feed line for a drop event, or null when the drop is benign (deliberate
 * behavior never becomes an alert). `detailJson` is the raw agent_events
 * detail column.
 */
export function dropFeedItem(kind: string, detailJson: string | null): DropFeedItem | null {
  let reason = "";
  try {
    reason = String(JSON.parse(detailJson ?? "{}").reason ?? "");
  } catch {}

  if (kind === "inbound-dropped") {
    if (!isLoudDrop(reason)) return null;
    return {
      title: "A shop reply needs attention",
      detail: INBOUND_DETAIL[reason] ?? "A reply couldn't be processed automatically.",
    };
  }
  if (kind === "send-dropped") {
    const detail = reason.startsWith("duplicate")
      ? "A duplicate of a message this shop already received was skipped."
      : reason.startsWith("rfq-dedup")
        ? "This shop already got your request in the last day, so a repeat was skipped."
        : reason.startsWith("engagement-halt")
          ? "This shop hasn't answered earlier messages, so a repeat wasn't sent - this protects your WhatsApp number."
          : "A message was skipped by the safety guard.";
    return { title: "A message was not sent", detail };
  }
  return null;
}
