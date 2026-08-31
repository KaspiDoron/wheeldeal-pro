// IS THIS PRICE GROUNDED IN SOMETHING THE SHOP ACTUALLY SAID?
//
// The model can return found=true with a number that appears NOWHERE - a
// hallucination on an automated / no-price template reply (owner problem #4).
// A displayed quote must be traceable to real information, so before we show a
// price with no photo behind it, it has to be grounded in the conversation.
//
// THE FIRST VERSION WAS WEAKEST EXACTLY WHERE THE PROBLEM IS STRONGEST.
//
// It grounded a price against one flat bag of numerals built from the shop's
// message AND the history window - and that window renders our OWN turns as
// "Us: ...". So a figure we proposed grounded itself. The doc comment claimed
// the third source was "a figure WE proposed and the shop then AGREED to", and
// nothing tested the agreeing. Since our ask is anchored to the market floor, a
// model hallucinating on a template reply hallucinates precisely the anchored
// number - and the rail waved it through. (The LLM prompt itself carries the
// correct rule: never attribute a number to the shop unless they explicitly
// agreed. The deterministic backstop was weaker than the thing it backstops.)
//
// Two more leaks, both executed: an address grounded a price ("We are at 55/1
// Moo 3" grounds 55) and so did a phone number ("Call us 66812345678").
//
// So: the shop's own words ground unconditionally. Our words ground ONLY when
// the shop's current message actually agrees. Address- and phone-shaped
// numerals ground nothing. Pure, so the judgement is unit-tested rather than
// inferred from a transcript.

import { verbatimNumerals } from "../graph/guardrails";

/**
 * A numeral that is structurally not money: a street number followed by a
 * sub-unit ("55/1 Moo 3"), or a run long enough to be a phone number.
 */
const ADDRESS_SHAPED = /\b\d{1,4}\s*\/\s*\d/;
const PHONE_SHAPED = /\b\d{9,}\b/;

/** Strip the spans that are structurally not prices before harvesting numerals. */
function withoutNonMoney(text: string): string {
  return text.replace(ADDRESS_SHAPED, " ").replace(PHONE_SHAPED, " ");
}

/**
 * Does this inbound message ACCEPT something? Deliberately narrow and
 * multilingual-lite: it gates whether a number WE said may be treated as the
 * shop's. A false positive here re-opens the exact hole this rail exists to
 * close, so ambiguous enthusiasm ("nice!", "sure?") does not count.
 */
const AGREEMENT =
  /\b(ok(ay)?|okey|deal|agree[ds]?|confirm(ed|s)?|accept(ed|s)?|fine|good|sounds good|no problem|works?|yes|yep|yeah|sure|can|possible|done)\b|✅|👍|🤝/i;

export function agreesWithUs(inbound: string | undefined | null): boolean {
  if (!inbound) return false;
  const t = inbound.trim();
  if (!t) return false;
  // A question is not an acceptance, however agreeable its vocabulary
  // ("ok what about 300?" is a counter, not a yes).
  if (/\?\s*$/.test(t)) return false;
  return AGREEMENT.test(t);
}

export interface GroundingSources {
  /** The shop's message this price was read from. Grounds unconditionally. */
  shopText?: string | null;
  /** Earlier INBOUND turns - also the shop's own words. */
  shopHistory?: Array<string | undefined | null>;
  /**
   * Turns WE sent. These ground a price only when `shopText` agrees, which is
   * the "ok, 250 is fine" case the original comment described and never
   * checked.
   */
  ourHistory?: Array<string | undefined | null>;
}

export function isPriceGrounded(
  price: number,
  durationDays: number | undefined,
  sources: GroundingSources
): boolean {
  if (!(price > 0)) return true; // nothing to ground
  const dur = durationDays && durationDays > 0 ? durationDays : 1;

  const shopNumerals = new Set(
    verbatimNumerals(
      [sources.shopText, ...(sources.shopHistory ?? [])].map((t) =>
        t ? withoutNonMoney(t) : t
      )
    )
  );
  if (shopNumerals.has(price)) return true;
  // A stated TOTAL divided by the rental duration is still the shop's number.
  if (dur > 1 && shopNumerals.has(price * dur)) return true;

  // Only now, and only if they said yes.
  if (!agreesWithUs(sources.shopText)) return false;
  const ourNumerals = new Set(
    verbatimNumerals((sources.ourHistory ?? []).map((t) => (t ? withoutNonMoney(t) : t)))
  );
  return ourNumerals.has(price) || (dur > 1 && ourNumerals.has(price * dur));
}
