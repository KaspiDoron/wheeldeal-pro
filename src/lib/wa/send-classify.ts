// Classify a failed WhatsApp send. A RECIPIENT failure (the number is not on
// WhatsApp / invalid / blocked) is the recipient's fault and counts toward the
// give-up cap. Everything else is treated as a TRANSIENT infra failure (the
// Evolution host waking/restarting/timed-out, a 5xx, a reconnect, or an unknown/
// empty error from a dead host) - it must NOT burn the retry cap or creep the
// ETA, so a batch resumes the moment the host recovers instead of stalling.

export function isRecipientSendFailure(error?: string | null): boolean {
  return /not.*whatsapp|invalid|exist|blocked|forbidden|no-?phone/i.test(String(error ?? ""));
}

export function isTransientSendFailure(error?: string | null): boolean {
  return !isRecipientSendFailure(error);
}

// A TRANSIENT failure retries fast without burning the attempt cap, so a batch
// resumes the moment the host recovers. But the total lifetime is bounded: a
// PERMANENTLY dead host (or a stale days-old RFQ) must not loop in the outbox
// forever, invisibly re-probing a dead host every ~minute. Age lives in meta
// (each re-queue is a fresh row, so created_at would reset).
export const TRANSIENT_MAX_LIFETIME_MS = 24 * 3600_000;
export const TRANSIENT_MAX_ATTEMPTS = 60;

// A RECIPIENT failure (not on WhatsApp / invalid / blocked) is terminal after a
// few backoff retries - the number is very unlikely to become reachable.
export const RECIPIENT_MAX_ATTEMPTS = 5;

export type RetryDecision =
  | { drop: true }
  | { drop: false; attempts: number; delayMs: number };

// Decide what to do with a TRANSIENT send failure. `firstQueuedAt` is the ms
// timestamp the row was FIRST parked (carried in meta across re-queues so it
// survives the fresh-row reset); `priorAttempts` is meta.transientAttempts.
// Returns either drop (give up - dead host / stale) or a fast re-queue whose
// delay never burns the recipient cap.
export function transientRetryDecision(
  firstQueuedAt: number,
  priorAttempts: number,
  now: number,
  jitter = 0,
): RetryDecision {
  const attempts = priorAttempts + 1;
  if (now - firstQueuedAt > TRANSIENT_MAX_LIFETIME_MS || attempts > TRANSIENT_MAX_ATTEMPTS) {
    return { drop: true };
  }
  // 45-120s: fast enough to resume promptly, jittered so a stalled batch does
  // not re-converge onto one timestamp.
  const delayMs = (45 + Math.max(0, Math.min(1, jitter)) * 75) * 1000;
  return { drop: false, attempts, delayMs };
}

// Decide what to do with a RECIPIENT-level send failure. Backoff creeps but is
// capped so it never pushes past ~20 min even on the last attempt; after
// RECIPIENT_MAX_ATTEMPTS the send is dropped.
export function recipientRetryDecision(priorAttempts: number): RetryDecision {
  const attempts = priorAttempts + 1;
  if (attempts > RECIPIENT_MAX_ATTEMPTS) return { drop: true };
  const delayMs = Math.min(attempts * 4, 20) * 60_000;
  return { drop: false, attempts, delayMs };
}

/**
 * STOP-LOSS classification of a FAILED send: is this an ACCOUNT-level
 * restriction signal ("hard", which counts toward the ban-recovery breaker in
 * `noteSendOutcome`) or not ("soft", which clears the streak)?
 *
 * Only two things are hard:
 *   - HTTP 429: an Evolution/WhatsApp RATE LIMIT. Volume is a property of the
 *     number, so a run of these is a real account-level signal.
 *   - error TEXT that reads as a WhatsApp restriction/ban/rate limit. This reads
 *     the response BODY, so a genuine restriction that arrives with some other
 *     status is still caught.
 *
 * DELIBERATELY NOT HARD (owner report 11 H2.1):
 *   - HTTP 401/403: the Evolution API GATEWAY rejecting OUR apikey - a wrong
 *     AUTHENTICATION_API_KEY on our side, NOT WhatsApp restricting the
 *     traveller's number. A single mistyped host key used to trip ban-recovery
 *     on every number placed on that host. These SHORT-CIRCUIT to soft BEFORE
 *     the text branch, because the gateway's own 401/403 body literally says
 *     "Unauthorized"/"Forbidden" and would otherwise false-match the regex and
 *     re-escalate the very failure we are trying to exonerate.
 *   - HTTP 0 / 5xx: evoFetch's own timeout or a crashing host - target infra,
 *     not the number. (Handled by falling through to the text branch, which a
 *     bare "Evolution API 500" does not match.)
 */
export function isHardSendFailure(status: number, errText?: string | null): boolean {
  if (status === 401 || status === 403) return false;
  if (status === 429) return true;
  return /forbidden|too many|rate.?limit|\bban\b|banned|restrict|not.?authoriz|spam/i.test(
    String(errText ?? ""),
  );
}
