// IS THIS PRICE GROUNDED IN SOMETHING THE SHOP ACTUALLY SAID?
//
// The model can return found=true with a number that appears NOWHERE - a
// hallucination on an automated / no-price template reply (owner problem #4).
// A displayed quote must be traceable to real information, so before we show a
// price with no photo behind it, it has to be grounded in the conversation:
//   - the number is verbatim in the shop's message, OR
//   - the number x the rental duration is verbatim (a stated TOTAL), OR
//   - the number appears in the recent conversation (a figure WE proposed and
//     the shop then agreed to - "ok, 250 is fine").
// Pure, so the judgement is unit-tested instead of inferred from a transcript.

import { verbatimNumerals } from "../graph/guardrails";

export function isPriceGrounded(
  price: number,
  durationDays: number | undefined,
  texts: Array<string | undefined | null>
): boolean {
  if (!(price > 0)) return true; // nothing to ground
  const grounded = new Set(verbatimNumerals(texts));
  if (grounded.has(price)) return true;
  const dur = durationDays && durationDays > 0 ? durationDays : 1;
  if (dur > 1 && grounded.has(price * dur)) return true;
  return false;
}
