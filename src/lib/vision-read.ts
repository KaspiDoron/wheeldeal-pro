// THE PROVENANCE OF A MACHINE READ.
//
// A vision call has three outcomes, not two: it read the picture, it read the
// picture and there was nothing usable in it, or IT NEVER RAN. The third one had
// no representation anywhere in this codebase - `chatVision` returned
// `string | null`, and `null` meant a rejected key, a quota, a timeout, a safety
// block AND a genuinely blank board. Everything downstream had to guess, so it
// guessed the flattering way: an outage was reported to the traveller as
// "Nothing readable in this one" under a photo they could read perfectly well.
//
// This module is the vocabulary that makes the third outcome sayable. It is
// deliberately PURE (no `server-only`, no fetch, no config) so the classification
// rules are unit-testable without a provider in the loop - the same discipline
// as lib/wa/turn-lock and lib/wa/anchor-recovery.

/**
 * WHY a read produced nothing. Every member is an OPERATIONAL failure: the image
 * was never looked at. A successful read that found nothing usable is NOT in
 * here - that is a `VisionRead` with `ok:true` and empty content.
 */
export type VisionFailure =
  | "unconfigured" // no vision provider usable for this input (no key, wrong media)
  | "auth" // 401/403 - the key is rejected
  | "rate-limit" // 429 - quota, this minute
  | "bad-model" // 400/404 - the model id drifted
  | "blocked" // 200 with no content - safety filter / empty generation
  | "truncated" // the generation hit OUR token ceiling - a cut-off answer, not a read
  | "timeout" // our own budget aborted the call
  | "network" // fetch threw
  | "upstream"; // 5xx and anything else

/** Every provider that can be a rung on the vision ladder. */
export type VisionProvider = "gemini" | "groq" | "anthropic" | "openai";

export interface VisionAttempt {
  provider: VisionProvider;
  model: string;
  ok: boolean;
  /** Exact upstream error (status + body excerpt) when the attempt failed. */
  error?: string;
  /** WHAT KIND of failure this was - the machine-readable half of `error`. */
  failure?: VisionFailure;
}

/** A vision read, with its provenance. `ok:false` means WE NEVER SAW THE IMAGE. */
export type VisionRead =
  | {
      ok: true;
      text: string;
      provider: VisionProvider;
      model: string;
      attempts: VisionAttempt[];
    }
  | {
      ok: false;
      failure: VisionFailure;
      /** Worth trying again later (quota/timeout/outage) vs never (bad key). */
      retryable: boolean;
      /** The last few verbatim upstream errors - safe, never carries a key. */
      detail: string;
      attempts: VisionAttempt[];
    };

/**
 * Failures that are a statement about this MOMENT, not about the image.
 *
 * This set is the whole retry policy: a rejected key, a decommissioned model id
 * and a safety block cannot succeed on a second attempt, so retrying them only
 * burns the turn's time budget and delays the reply to the shop.
 */
export const RETRYABLE_VISION: ReadonlySet<VisionFailure> = new Set<VisionFailure>([
  "rate-limit",
  "timeout",
  "network",
  "upstream",
  // A CUT-OFF ANSWER IS THE ONE FAILURE WE CAN FIX OURSELVES. The 17-row board
  // that came back "unreadable" had actually been read - the generation just
  // ran past maxOutputTokens and ended mid-JSON, which the ladder then handed
  // on as good text. It is retried ONCE at a raised ceiling (readImages).
  "truncated",
]);

/** Most-actionable first: what an operator should be told when several differ. */
const FAILURE_RANK: VisionFailure[] = [
  "auth",
  "rate-limit",
  // Ranked above "blocked" because it is ACTIONABLE and specific: it names our
  // own ceiling rather than a provider mood, and it is what the panel must say.
  "truncated",
  "blocked",
  "bad-model",
  "timeout",
  "upstream",
  "network",
  "unconfigured",
];

export function visionFailureFromStatus(status: number): VisionFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 400 || status === 404) return "bad-model";
  return "upstream";
}

export function visionFailureFromThrown(e: unknown): VisionFailure {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  // AbortController fires "The operation was aborted" / AbortError - that is OUR
  // budget expiring, which is a timeout, not a network fault. The distinction
  // matters: a timeout means "try a smaller/faster model", a network error means
  // "the host is unreachable".
  return /abort|timed? ?out/i.test(m) ? "timeout" : "network";
}

/** The one failure that best explains a whole ladder of attempts. */
export function summariseVisionFailure(attempts: VisionAttempt[]): VisionFailure {
  const kinds = new Set(attempts.filter((a) => !a.ok && a.failure).map((a) => a.failure!));
  for (const k of FAILURE_RANK) if (kinds.has(k)) return k;
  return "unconfigured";
}

/** The last few upstream errors, joined - what the Ops feed and the vault show. */
export function visionFailureDetail(attempts: VisionAttempt[]): string {
  return (
    attempts
      .filter((a) => !a.ok && a.error)
      .map((a) => a.error!)
      .slice(-3)
      .join(" | ") || "no vision provider produced a reading"
  );
}
