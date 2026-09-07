// WHICH NEVER-SILENT ASK DOES THIS FRAME NEED?
//
// The webhook decides this for every inbound frame whose media it could not
// read, and it used to decide it with three hard-coded string comparisons:
// `!syntheticText || syntheticText === "[photo]" || syntheticText === "[image]"`
// for the photo arm and `syntheticText === "[video]"` for the video one. But
// the shared reader (wa/message-text) also emits "[document]" for a captionless
// PDF rate card and "[video note]" for a round ptvMessage, so BOTH of those
// frames skipped both arms: the turn extracted from a bare bracket label, no
// reading was stamped, and the shop was left on read by an agent that had
// nothing to say (audit F154).
//
// The rule is not "which of two literals is this" - it is "is the label all we
// have to go on, and which media did we fail on". `isMediaPlaceholder` is this
// codebase's one answer to "did the shop actually say anything" (wa/coalesce
// exports it for exactly this reason - a second copy of that judgement is what
// broke the never-silent photo fallback the first time), so the decision is
// expressed in terms of it and cannot go stale when a new subtype is labelled.
//
// Pure and in its own module so the branch is EXECUTED under test rather than
// pinned by a regex over ingest.ts.

import { isMediaPlaceholder } from "./coalesce";

/** The ask a frame needs, or null when the turn has real words to work with. */
export type MediaClarifyKind = "photo" | "video" | "voice" | null;

export function mediaClarifyKind(input: {
  /** The text the turn will actually carry (caption, transcript, or a label). */
  text: string | null | undefined;
  /** Every image/document frame failed to download or fit the read budget. */
  mediaFetchFailed: boolean;
  /** A native video we could not watch (too large, exotic codec, no bytes). */
  videoUnreadable: boolean;
  /** A voice note we could not download or could not transcribe. */
  audioUnreadable: boolean;
}): MediaClarifyKind {
  // WORDS BEAT THE ASK. A caption carries the price far more often than a
  // clarify would win it back, so a frame the shop wrote on is a text turn
  // even when its media failed - exactly the old guard's intent, minus the
  // two-literal blind spot.
  if (!isMediaPlaceholder(input.text)) return null;
  if (input.mediaFetchFailed) return "photo";
  if (input.videoUnreadable) return "video";
  if (input.audioUnreadable) return "voice";
  return null;
}
