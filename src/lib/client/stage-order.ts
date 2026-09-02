// THE RANK THE CARD ADVANCES BY - AND THE RUNG IT WAS MISSING.
//
// The activity poll advances a card forward-only: a target stage is applied
// only when it outranks the current one. That rank table lived inline in
// page.tsx and did NOT contain "replied" - the very stage the funnel ledger was
// taught to report, and the one the traveller's Tracker was taught to draw.
//
// So `STAGE_ORDER["replied"] ?? -1` was -1, `-1 > 4` was false, and the advance
// was refused FOREVER. Worse: because trackerStageForLedger returned a
// non-null "replied", it SHADOWED the legacy vendorStates rollup that would
// otherwise have moved the card to "negotiating". A shop that answered was
// pinned on "Awaiting reply" until the AI turn finished and stamped
// `understood`/`price_received` - 20 to 85 seconds later, and forever if that
// turn failed.
//
// That is exactly what the owner photographed: three shops visibly replied in
// WhatsApp while the app still listed all six under "AWAITING REPLY (6)". The
// replied COUNTER moved (it keys off lastInboundAt) while the cards did not,
// which is why the screen contradicted itself.
//
// The table is a module now, and `Tracker.tsx`'s own ORDER is derived from it,
// so the two cannot disagree again. Tests execute both.

import type { TrackerStage } from "../types";

/**
 * Forward-only card ranking. Every stage `trackerStageForLedger` can return
 * MUST appear here or the ledger silently stops reaching the card - that is the
 * defect this module exists to make impossible, and `stage-order.test.ts`
 * asserts the coverage by execution.
 *
 * Equal ranks are deliberate: "found" / "no-response" / "sending" are the same
 * rung, so the DB rollup can advance past them but never rewind between them.
 */
export const STAGE_ORDER: Record<string, number> = {
  queued: 0,
  "locating-contact": 1,
  found: 2,
  "no-response": 2,
  // In flight: past "found", not yet delivered. Ranked so the DB rollup can
  // advance it once the send lands but can never rewind it to "found".
  sending: 2,
  "rfq-sent": 3,
  "awaiting-response": 4,
  // The shop answered and nothing is being haggled yet. Its own rung, between
  // waiting and negotiating, because collapsing it into either one is a lie in
  // one direction or the other.
  replied: 5,
  negotiating: 6,
  "offer-received": 7,
  "counter-offer": 8,
};

/** The visible flow, ordered. `Tracker` draws from this so the dots and the
 * advance rule are the same list. */
export const TRACKER_ORDER: TrackerStage[] = (
  Object.keys(STAGE_ORDER) as TrackerStage[]
).sort((a, b) => STAGE_ORDER[a] - STAGE_ORDER[b]);

/** Rank of a card stage; -1 for anything unranked (terminals, unknown). */
export function stageRank(stage: string | undefined | null): number {
  return STAGE_ORDER[stage ?? "queued"] ?? -1;
}
