// THREAD-DERIVED negotiation state (pure, unit-tested). The thread history IS
// the durable state - these facts are recomputed every turn from what the
// engine already holds, so nothing here can go stale.
//
// WHAT WAS HERE, AND WHY IT IS GONE (owner report 6 K, the w10 landing).
//
// Six regexes used to read MEANING off the shop's raw words in this file:
// FIRM_RX, DEPOSIT_RX, FULFILLMENT_RX, DELIVERY_OFFERED_RX, HANDOVER_FREE_RX
// and HANDOVER_AMOUNT_RX. Each one decided a thread-level fact, and each one
// was wrong in a way that cost a negotiation:
//
//   - FIRM_RX fired on a bare "best price" - the most common OPENING sales
//     phrase in these markets - so the engine retired bargaining exactly when
//     the shop was warmest, and missed the phrasings shops actually refuse
//     with. Firmness stops the pushing, so this IS the owner's "we are not
//     bargaining enough".
//   - DEPOSIT_RX latched on the bare word "passport" anywhere in any inbound
//     message, while `readDepositTerms` - a zod-validated model read of the
//     same sentence, running on every turn already - had its whole structured
//     answer thrown away except one ambiguity flag.
//   - FULFILLMENT_RX went true on the substring "deliver", which retired the
//     handover probe the instant a shop said "yes we can deliver" and meant
//     nobody ever asked what delivery COSTS.
//
// And all six read the shop's RAW LOCAL-LANGUAGE TEXT. The English gloss is
// computed on the reply path and handed to the model only, so on a Thai,
// Indonesian or Vietnamese thread - the product's whole premise - every one of
// them read zero and every fact above defaulted to false.
//
// All six now come from the model, once per turn, inside the comprehension
// pass that already runs (spte/comprehension + semantic/classifiers), carried
// across turns as durable thread facts (types.DurableComprehension) and
// PROJECTED here. What remains in this file is ARITHMETIC OVER OUR OWN
// STAMPED MOVES - how many times we pushed, how many handover questions we
// have put, what we last said - which is deterministic code doing what
// deterministic code is for, and reads our own English rather than the shop's
// language. When no model ever answered on a thread, every meaning fact below
// is its zero value: not firm, terms not known - the defaults that keep the
// negotiation alive and every question askable.

import type { DurableComprehension } from "./types";

/** The stamped moves that ARE a push on price. Anything else stamped - answer,
 *  clarify, close, a probe - is not a round, whatever its wording looks like. */
const BARGAIN_KINDS = new Set(["bargain", "auto-bargain", "counter", "auto-counter"]);

/** Fallback for UNSTAMPED history only. A message reads as a push when it asks
 *  for less; a bare daily-rate mention does not, which is why this is only
 *  consulted when no stamp exists. Our own English - never the shop's words. */
const BARGAIN_TEXT_RX =
  /\b(better (rate|deal|price)|lower|discount|cheaper|can (you|u) do|even better|multi-day|per day\??$|\/day\??)\b/i;

export interface ThreadFacts {
  /** Turns on which the model read an EXPLICIT refusal to go lower. */
  firmCount: number;
  /** The shop has stated its deposit terms (model-read, durable). */
  depositKnown: boolean;
  /** The shop has told us delivery-vs-pickup. THE MODE, not the price of it. */
  fulfillmentKnown: boolean;
  /**
   * The shop OFFERED to deliver (as opposed to only naming shop collection).
   * Separated because only this half can carry a fee worth asking about.
   */
  deliveryOffered: boolean;
  /**
   * The shop has said what the handover COSTS - a number, or that it is free.
   *
   * THE MODE AND ITS PRICE ARE TWO FACTS, AND ONE FLAG WAS ANSWERING FOR BOTH.
   * The old substring test retired the handover probe the instant a shop said
   * "yes we can deliver" - and the fee was never asked. The traveller compared
   * per-day rates, picked one, and met the delivery charge at handover: the
   * one number a comparison app exists to have found out first.
   */
  fulfillmentCostKnown: boolean;
  /** How many times WE pushed on price in this thread (the round counter). */
  bargainRounds: number;
  /**
   * How many handover questions WE have already put. Read from the stamped
   * moves, so it counts what we actually did rather than what our prose looks
   * like. Bounds the delivery-cost follow-up: the first ask settles the mode,
   * the second prices it, and there is no third.
   */
  handoverAsks: number;
  /**
   * HOW MANY TIMES WE HAVE NUDGED A QUIET THREAD - from our own stamped moves.
   *
   * The bound on this was a regex over our own prose
   * (`/hi again|checking in|just following up|any chance on that|any update/`),
   * which is the same mistake `bargainRounds` above already documents: our own
   * wording is not a verdict about what we did, the STAMP is. It was also a
   * trap for any future variation - the moment the nudge sentence is drawn from
   * a family rather than hard-coded, a variant that says "any word from you?"
   * silently voids the once-only guarantee and the thread gets nudged for ever.
   */
  momentumNudges: number;
  /** Our last N outbound bodies, oldest first - the anti-repetition memory. */
  lastOutbound: string[];
}

export interface ThreadFactsInput {
  /** Every outbound (our) message body in this thread, chronological. */
  outbound: string[];
  /** The move stamped on each `outbound` entry, SAME ORDER, SAME LENGTH;
   *  `undefined` where the row carries no stamp. Supplying it is what stops our
   *  own `answer` template being counted as a bargain round. Omit it and every
   *  entry falls back to the wording. */
  outboundKinds?: (string | undefined)[];
  /** How many prior bargains the caller counted from message kinds - the
   *  computed value is max(this, derived) so a mis-stamped history still heals. */
  priorBargainCount?: number;
  /**
   * THE MODEL'S DURABLE READING OF THIS THREAD - the only legal source for the
   * meaning facts (firm/deposit/handover). Absent = "we never found out",
   * which projects every meaning fact to its keep-negotiating zero.
   */
  comprehension?: DurableComprehension;
  /** Accepted for caller compatibility; NO MEANING IS READ FROM THEM anymore -
   *  that is the whole point of this file's rewrite. */
  inbound?: string[];
  currentInbound?: string;
}

export function deriveThreadFacts(input: ThreadFactsInput): ThreadFacts {
  const c = input.comprehension;

  // MEANING: projected from the model's durable reading, never from words.
  const firmCount = typeof c?.firmTurns === "number" && c.firmTurns > 0 ? Math.floor(c.firmTurns) : 0;
  const depositKnown = c?.depositStated === true;
  const fulfillmentKnown = Boolean(c?.handoverMode && c.handoverMode !== "unstated");
  const deliveryOffered = c?.handoverMode === "delivery" || c?.handoverMode === "both";
  const fulfillmentCostKnown = c?.handoverCostKnown === true;

  // ARITHMETIC over our own stamped moves.
  //
  // WE WERE COUNTING OUR OWN ANSWERS AS PUSHES. The fallback regex cannot tell
  // a bargain from a confirmation, because our own templates share its
  // vocabulary: the `answer` template renders "is 250 THB/day the best you can
  // do for 4 days?" - which matches BOTH `/day` and `can you do`. The STAMP is
  // the discriminator; the regex is only the fallback for history written
  // before moves were stamped.
  const kinds = input.outboundKinds;
  const derivedRounds = input.outbound.filter((m, i) => {
    const kind = kinds && i < kinds.length ? kinds[i] : undefined;
    if (kind) return BARGAIN_KINDS.has(kind);
    return BARGAIN_TEXT_RX.test(m);
  }).length;
  const bargainRounds = Math.max(input.priorBargainCount ?? 0, derivedRounds);
  const handoverAsks = (kinds ?? []).filter((k) => k === "fulfillment-probe").length;
  // `auto-momentum` is the outbox meta kind; `momentum` is the raw move. Both
  // appear in history depending on which writer stamped the row.
  const momentumNudges = (kinds ?? []).filter(
    (k) => k === "momentum" || k === "auto-momentum"
  ).length;

  return {
    firmCount,
    depositKnown,
    fulfillmentKnown,
    deliveryOffered,
    fulfillmentCostKnown,
    bargainRounds,
    handoverAsks,
    momentumNudges,
    lastOutbound: input.outbound.slice(-5),
  };
}
