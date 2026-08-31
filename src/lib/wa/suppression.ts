// FLEET-WIDE SHOP SUPPRESSION (owner decision: opt-out is fleet-wide and
// transport-agnostic).
//
// A shop that asked to stop hearing from WheelDeal asked WheelDeal - not one
// traveller. The old opt-out lived on wa_recipient_state, keyed per sender, so
// a shop that refused traveller A was cold-introduced by traveller B the next
// day: under Evolution that is an anti-ban signal and a courtesy failure; under
// the future single-company-number architecture a per-sender key is
// structurally wrong (there IS only one sender). One store, keyed on the
// shop's number tail (nationalTail - same canonical key as the recipient
// ledger and the WABA agencies), consulted by every lane: guardOutbound's cold
// gate, mass outreach admission, and the WABA admitLead.
//
// FAIL-OPEN ON READ, fail-closed nowhere: an unreadable store must not silence
// the whole product (the per-sender opt-out still stands underneath), but a
// WRITE failure is surfaced to the caller so a stop-intent is never silently
// dropped.

import { sbInsert, sbSelectStrict } from "../runtime-config";
import { nationalTail } from "./phone-key";

export interface Suppression {
  suppressed: boolean;
  reason?: string;
  /** True when the store could not be read - the caller may proceed (the
   *  per-sender opt-out still applies) but must not CACHE a "not suppressed". */
  unreadable?: boolean;
}

/** Is this shop fleet-suppressed? Keyed on the number tail. */
export async function shopSuppression(number: string): Promise<Suppression> {
  const tail = nationalTail(number);
  if (!tail) return { suppressed: false };
  const read = await sbSelectStrict<{ reason: string | null }>(
    "wa_suppressions",
    `select=reason&number_tail=eq.${encodeURIComponent(tail)}&limit=1`
  );
  if ("error" in read) {
    // "missing" = table not migrated yet -> genuinely nothing suppressed.
    return read.error === "missing" ? { suppressed: false } : { suppressed: false, unreadable: true };
  }
  const row = read.rows[0];
  return row ? { suppressed: true, reason: row.reason ?? undefined } : { suppressed: false };
}

/**
 * Record a fleet-wide suppression. Idempotent (tail is the primary key; a
 * second stop-intent keeps the first row). Returns whether the store now
 * definitely holds it.
 */
export async function suppressShop(
  number: string,
  reason: string,
  source: "stop-intent" | "owner" | "wrong-number" = "stop-intent"
): Promise<boolean> {
  const tail = nationalTail(number);
  if (!tail) return false;
  return sbInsert(
    "wa_suppressions",
    [
      {
        number_tail: tail,
        number,
        reason: reason.slice(0, 200),
        source,
      },
    ],
    "number_tail"
  ).catch(() => false);
}
