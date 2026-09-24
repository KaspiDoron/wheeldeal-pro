// HOW LONG A SHOP MAY WAIT FOR ITS ANSWER.
//
// The owner's requirement: when 10-40 shops answer at once, every one of them
// gets our reply within ten seconds of sending theirs.
//
// WHAT WAS ACTUALLY SPENDING THE TIME. Not anti-ban pacing, and not the queue -
// measured on a live local hunt, `plannedDelayS` was 0 and `composeMs` was 17.5
// to 20.4 seconds. About half of that was one line: the reply path paused for
// `min(10s, remaining - 20s)`, which with a 45-second turn budget is a flat ten
// seconds on EVERY reply, regardless of how long the thinking had already
// taken. A pause that does not look at the clock it is padding cannot be part
// of a ten-second promise.
//
// WHY A PAUSE EXISTS AT ALL, AND WHY IT STAYS. An answer that lands
// milliseconds after a shop's message is not how a person types, and
// inhumanly fast replies are one of the behaviours that get a number
// restricted. The pause is real anti-ban work. What it must not be is blind:
// if the chain has already taken six seconds, a human has been "reading and
// typing" for six seconds and no padding is owed.
//
// So the floor is measured from the SHOP'S message, not from the end of our
// processing, and the ceiling is the promise itself. Note which way this cuts:
// it usually SHORTENS the pause, but on a fast turn it will still hold the
// reply back to the human floor.
//
// ANTI-BAN.md's own doctrine supports answering promptly: "the REPLY lane is
// deliberately left generous: reciprocal traffic is the protective signal, and
// refusing to answer a shop that just wrote to us would raise ban risk, not
// lower it." None of the cold-outreach constants are touched by anything here -
// the 8s per-recipient floor, the fleet gap and the intro caps are untouched
// and still enforced by wa-guard on every send.

/** The promise: a shop's message is answered within this, measured shop-side. */
export const REPLY_SLA_MS = 10_000;

/**
 * No reply leaves sooner than this after the shop's message, however fast the
 * chain was. A person picks up the phone, reads, and types.
 */
export const MIN_HUMAN_GAP_MS = 2_500;

/**
 * Held back for the send itself (presence, the claim round trip, the provider
 * call). Taken off the ceiling so the PAUSE never eats the budget the delivery
 * still needs.
 */
export const SEND_RESERVE_MS = 2_000;

/**
 * Never spend so much of the turn's own wall clock that the send has nowhere
 * left to run - the bound the previous implementation got right.
 */
export const TURN_TAIL_RESERVE_MS = 20_000;

export interface PauseInput {
  /** When the shop's message reached us (epoch ms). */
  inboundAt?: number | null;
  /** Now (epoch ms). */
  now: number;
  /** What is left of this turn's wall clock (ms). */
  remainingMs: number;
  /** Override for tests and for a future per-lane policy. */
  slaMs?: number;
  minGapMs?: number;
}

/**
 * How long to wait before sending the composed reply.
 *
 * - tops the elapsed time up to the human floor, so we are never instant;
 * - never pushes the answer past the SLA (minus what the send needs);
 * - never eats the turn's tail reserve;
 * - with no inbound timestamp (a scheduled tick answers nobody's message) it
 *   falls back to the human floor, which is the conservative reading.
 */
export function humanPauseMs(input: PauseInput): number {
  const sla = input.slaMs ?? REPLY_SLA_MS;
  const minGap = input.minGapMs ?? MIN_HUMAN_GAP_MS;
  const elapsed =
    typeof input.inboundAt === "number" && input.inboundAt > 0
      ? Math.max(0, input.now - input.inboundAt)
      : 0;
  // What the human floor still owes.
  const owed = Math.max(0, minGap - elapsed);
  // What the promise still allows.
  const allowed = Math.max(0, sla - SEND_RESERVE_MS - elapsed);
  // What this turn's own budget allows (the pre-existing safety bound).
  const budget = Math.max(0, input.remainingMs - TURN_TAIL_RESERVE_MS);
  return Math.min(owed, allowed, budget);
}

export type SlaVerdict = "within" | "breach" | "unknown";

/** Did this reply keep the promise? `unknown` when we never saw the inbound. */
export function slaVerdict(inboundToWireMs?: number | null, slaMs = REPLY_SLA_MS): SlaVerdict {
  // `== null` ON PURPOSE. `Number(null)` is 0, not NaN, so a missing reading
  // would score as the fastest reply we ever made - the same trap wa/outbox-
  // policy records for a cleared stamp. A measurement we do not have is not a
  // measurement we passed.
  if (inboundToWireMs == null) return "unknown";
  const ms = Number(inboundToWireMs);
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  return ms <= slaMs ? "within" : "breach";
}
