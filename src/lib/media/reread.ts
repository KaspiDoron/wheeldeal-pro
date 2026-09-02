import type { MediaReading, ReadingOutcome, RereadState } from "./reading";

// THE DEFERRED RE-READ - the honest answer to "we need offline OCR".
//
// Only three providers accepted images and only ONE accepted PDFs, so a
// deployment with no Gemini key - or a Gemini 429 during a busy minute - meant a
// price board went unread and stayed unread for ever. The owner's instinct was
// to add a local OCR library; this repo bans `sharp`, `jimp`, `canvas` and
// `tesseract.js` from package.json on memory grounds, and `agents.ts` states
// outright that there is no image library in this runtime.
//
// Two cheaper things meet the same goal:
//
//   1. A FOURTH VISION RUNG (OpenAI - already a configured provider, already a
//      token in the vault, absent from the vision ladder entirely). That is in
//      ai.ts.
//   2. THIS: retry the read later. Every one of these failures is a statement
//      about the MINUTE, not the photo - a 429, a timeout, a provider blip -
//      and the per-minute budgets reset. The reply already went out (nothing
//      about media ever blocks a reply), so the retry costs the traveller
//      nothing and can turn an unreadable board into a real price.
//
// It is deliberately NOT a queue table. The failed reading is already durable
// on `whatsapp_messages.raw.reading` (retention-exempt), and it now carries the
// two things a retry needs - the RFQ and the message text the first read used -
// so the sweep is self-contained and needs no thread context re-resolved. The
// cron that drives it already fires every minute.
//
// The policy is pure and lives here, separately from the IO, because the
// question "should this photo be retried" is exactly the kind of thing a test
// must be able to answer without a database, a provider or a storage bucket.

/** Retries per photo. Two, because a third has never been the one that works. */
export const REREAD_MAX_ATTEMPTS = 2;
/** Wait between attempts. Longer than any provider's per-minute window. */
export const REREAD_COOLDOWN_MS = 15 * 60_000;
/** A board older than this is not worth a paid retry - the negotiation moved on. */
export const REREAD_MAX_AGE_MS = 12 * 3_600_000;
/** Photos re-read per sweep. Bounded because vision is the expensive call. */
export const REREAD_BATCH = 4;

/**
 * The failures worth retrying.
 *
 * `unavailable` (no rung produced a reading), `truncated` (our ceiling, not
 * their photo) and `parse-failed` (the model answered in a shape we could not
 * read) are all about the attempt.
 *
 * `sanity-nulled` is NOT here: we read the board perfectly and REFUSED the
 * number as implausible, and reading it again returns the same number. Nor is
 * `empty`: the photo genuinely had no price on it, and asking a fourth provider
 * to confirm an empty photo is spending money to learn nothing.
 */
export const REREADABLE: ReadonlySet<ReadingOutcome> = new Set<ReadingOutcome>([
  "unavailable",
  "truncated",
  "parse-failed",
]);

export interface RereadCandidate {
  reading: MediaReading | null | undefined;
  /** ISO - when the shop sent the media. */
  receivedAt: string | null | undefined;
  /** The message id the bytes are archived under. No id, no retry. */
  waMessageId: string | null | undefined;
}

/** Why a candidate was skipped - so the sweep can be explained, not guessed. */
export type RereadSkip =
  | "no-reading"
  | "not-retryable"
  | "no-message-id"
  | "attempts-spent"
  | "cooling-down"
  | "too-old"
  | "burst-follower";

/**
 * Should this photo be read again now? `null` means yes; anything else is the
 * reason it was skipped.
 */
export function rereadSkipReason(c: RereadCandidate, nowMs: number): RereadSkip | null {
  const r = c.reading;
  if (!r) return "no-reading";
  if (!REREADABLE.has(r.outcome)) return "not-retryable";
  if (!c.waMessageId) return "no-message-id";
  // A burst follower carries the LEADER's reading, not its own. Retrying it
  // would re-read a photo the leader already owns and then stamp a second,
  // competing answer onto the same album.
  if (r.fromBurstLeader) return "burst-follower";
  const state = r.reread;
  if ((state?.attempts ?? 0) >= REREAD_MAX_ATTEMPTS) return "attempts-spent";
  const last = state?.lastAt ? Date.parse(state.lastAt) : NaN;
  if (Number.isFinite(last) && nowMs - last < REREAD_COOLDOWN_MS) return "cooling-down";
  const sent = c.receivedAt ? Date.parse(c.receivedAt) : NaN;
  if (!Number.isFinite(sent)) return "too-old"; // an undatable row cannot be bounded
  if (nowMs - sent > REREAD_MAX_AGE_MS) return "too-old";
  return null;
}

export function rereadDue(c: RereadCandidate, nowMs: number): boolean {
  return rereadSkipReason(c, nowMs) === null;
}

/**
 * The state to write BEFORE an attempt runs.
 *
 * Written first, always, so a crash mid-attempt still burns the try. Without
 * that, a photo whose retry kills the invocation is retried for ever at every
 * sweep - the shape of every runaway-retry incident.
 */
export function attemptStarted(prev: RereadState | undefined, nowIso: string): RereadState {
  const attempts = (prev?.attempts ?? 0) + 1;
  return {
    ...prev,
    attempts,
    lastAt: nowIso,
    exhausted: attempts >= REREAD_MAX_ATTEMPTS ? true : prev?.exhausted,
  };
}

/**
 * The reading to store when an attempt did NOT recover it.
 *
 * The original failure is kept verbatim - a retry that failed does not change
 * WHAT went wrong the first time, and overwriting the outcome would erase the
 * one fact the panel is telling the traveller.
 */
export function withAttempt(reading: MediaReading, state: RereadState): MediaReading {
  return { ...reading, reread: state };
}

/**
 * Did the retry actually recover something? A reading that came back with the
 * same failure is not a recovery, and storing it as one would make the panel
 * claim an answer it does not have.
 */
export function recovered(next: MediaReading | null | undefined): boolean {
  return Boolean(next) && !REREADABLE.has(next!.outcome);
}
