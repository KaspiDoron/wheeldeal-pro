import type { StructuredRFQ } from "../types";
import { normalizeDigits } from "../integrity/translation";

// WHAT WE PROMISED THE SHOP IS THE AUTHORITY.
//
// A traveller asked eight shops for an 8-day scooter. Mid-thread the agent
// wrote: "what's your best price per day for the 30 days?" - a number no shop
// had ever mentioned, which invalidated every quote already on the table.
//
// It was not a hallucination. The rental parameters were re-derived on EVERY
// turn from whichever outbound row most recently happened to carry an `rfq`,
// and that field is client-posted and re-stampable by any later send. Start a
// second search for a month, and every live 8-day thread quietly became a
// 30-day thread. Worse, the duration guard validated the draft against that
// same swapped value, so it confirmed "30 days" as truth - and would have
// REWRITTEN a correct "8 days" into "30 days".
//
// The missing concept is PROVENANCE. A thread is a promise made to a specific
// shop, and the promise is fixed at the moment we made it: the opening message.
// Later state can add to it, but it cannot rewrite what the shop was told. That
// is what this module owns, and it is pure so both the resolver and the
// outbound rail can share one answer.

/** The parameters a shop was actually quoted on. Nothing else may change them. */
export interface RentalPromise {
  durationDays: number;
  vehicleClass: StructuredRFQ["vehicleClass"];
}

/**
 * The day-count a message states, if it states one.
 *
 * Deliberately narrow: only a number that is explicitly counted in days. A
 * price ("250/day") is a RATE and names no duration; "125cc" is a vehicle. Both
 * used to be reachable by a looser pattern, and both would corrupt the promise.
 */
export function citedDurationDays(text: string | null | undefined): number | null {
  // FOLD THE DIGITS FIRST. This matched raw text, so it read ASCII and nothing
  // else: "for the 4 days" gave 4 while the same sentence localized into Thai,
  // Lao, Khmer or any of the other fifteen scripts this app meets gave null -
  // a promise the thread silently stopped carrying the moment it was translated.
  //
  // That made the duration rule read digits at THREE different strengths across
  // the codebase (18 scripts in integrity/translation, 4 in graph/guardrails,
  // 0 here). One fold now, imported.
  const s = normalizeDigits(String(text ?? ""));
  // "8 days", "for 8 days", "8-day", "8 day rental"
  const m = s.match(/\b(\d{1,3})\s*[-–]?\s*days?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 365 ? n : null;
}

/** Does this RFQ carry enough to be a promise at all? */
export function isUsablePromise(rfq: StructuredRFQ | null | undefined): boolean {
  return Boolean(
    rfq && typeof rfq.durationDays === "number" && rfq.durationDays > 0 && rfq.vehicleClass
  );
}

/**
 * The promise this thread carries: the opener's terms if we have them, else the
 * anchor's. `openerText` is a fallback for threads whose opening row lost its
 * structured rfq but still contains the sentence we sent.
 */
export function promiseOf(
  opener: StructuredRFQ | null | undefined,
  openerText?: string | null,
  fallback?: StructuredRFQ | null
): RentalPromise | null {
  if (isUsablePromise(opener)) {
    return { durationDays: opener!.durationDays, vehicleClass: opener!.vehicleClass };
  }
  const cited = citedDurationDays(openerText);
  if (cited && fallback?.vehicleClass) {
    return { durationDays: cited, vehicleClass: fallback.vehicleClass };
  }
  if (isUsablePromise(fallback)) {
    return { durationDays: fallback!.durationDays, vehicleClass: fallback!.vehicleClass };
  }
  return null;
}

/**
 * Reconcile the RFQ a turn will run on.
 *
 * The anchor (newest rfq-bearing row) supplies everything - dates, accessories,
 * notes, whatever the traveller has since refined. The PROMISE supplies the two
 * fields the shop was quoted on and can therefore never be edited underneath
 * them. This is deliberately a safety `if`, not a strategy one: code decides
 * which duration is legal to say, the model still decides what to say.
 */
export function reconcileRfq(
  anchor: StructuredRFQ | null | undefined,
  promise: RentalPromise | null
): StructuredRFQ | null {
  if (!anchor) return null;
  if (!promise) return anchor;
  const driftedDuration = anchor.durationDays !== promise.durationDays;
  const driftedVehicle = anchor.vehicleClass !== promise.vehicleClass;
  if (!driftedDuration && !driftedVehicle) return anchor;
  return {
    ...anchor,
    durationDays: promise.durationDays,
    vehicleClass: promise.vehicleClass,
    // A returnDate computed from the wrong duration is the same lie in another
    // field, so it goes rather than contradicting the promise.
    ...(driftedDuration ? { returnDate: undefined } : {}),
  };
}

/** True when the anchor disagrees with the promise - worth recording, because
 *  it means some other surface wrote an rfq into this thread. */
export function rfqDrifted(
  anchor: StructuredRFQ | null | undefined,
  promise: RentalPromise | null
): boolean {
  if (!anchor || !promise) return false;
  return (
    anchor.durationDays !== promise.durationDays || anchor.vehicleClass !== promise.vehicleClass
  );
}
