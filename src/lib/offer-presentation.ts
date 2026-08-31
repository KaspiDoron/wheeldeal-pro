// The ONE rule for whether a shop's quoted price may be presented to the
// traveller as a real, lockable offer - shared by the results page, Will's
// compare sheet and any future surface so the rule can never drift between them.
//
// Two field incidents shaped it, in opposite directions:
//
//  - An e-bike quoted at a low price (the shop answered about the WRONG
//    vehicle - matchesSpec === false) was surfaced as "Best price - Lock it".
//    A price for a different vehicle is a signal for the agent to clarify,
//    never the traveller's best deal. That exclusion stays absolute.
//
//  - Thailand: "unconfirmed is not presentable" hid EVERYTHING. A shop
//    answering our question about a 125cc automatic with "6 days 180 per day"
//    can never name the vehicle, so its live ฿180 was invisible - BEST PRICE
//    showed a dash over the cheapest real quote on the board. NEVER HIDE,
//    NEVER MISLEAD is the rule now: only a positively WRONG vehicle is barred;
//    an unestablished one presents as an honest UNVERIFIED offer and flips to
//    verified when the thread-level confirmation (vehicle/confirmation.ts)
//    lands - automatically, with no button.

export interface PresentableOffer {
  pricePerDay: number;
  currency: string;
  // false = the shop quoted a DIFFERENT vehicle. undefined (legacy rows from
  // before this field existed) is treated as matching, so old data still shows.
  matchesSpec?: boolean;
  /**
   * The vehicle-identity verdict for this price, THREAD-state merged
   * (src/lib/vehicle + negotiation_threads.fields.vehicleConfirmation):
   *
   *   confirmed - hard evidence or the shop answered our confirm question
   *   assumed   - a direct price answer to our spec'd request; unverified
   *   needs-confirmation - nothing ties the price to the vehicle yet
   *   wrong-vehicle - positively a different machine; never presentable
   */
  vehicleStatus?: "confirmed" | "assumed" | "needs-confirmation" | "wrong-vehicle";
  /**
   * A SUBSTITUTE the shop offered, waiting on the traveller's Yes/No.
   *
   * The substitution read runs ~700 lines after the offers row is written, so
   * its verdict never reached the price: a shop that answered "no Click today,
   * but I have an Nmax for 220" had 220 stored as the requested vehicle's
   * price, wearing UNVERIFIED, and eligible to win BEST PRICE. The traveller
   * compared it against real Click quotes.
   *
   * A price for a machine nobody has agreed to is not a comparable price. It
   * stays on the card - with the Similar-vehicle label - and never ranks.
   */
  alternativeOffer?: { vehicle?: string | null } | null;
}

/**
 * May this price be shown/locked as a real offer? Only a positively wrong
 * vehicle is barred. Everything else shows - with `offerConfidence` telling
 * the surface how to LABEL it, which is the honest half of the contract.
 */
export function isPresentableOffer(offer: PresentableOffer | undefined | null): boolean {
  if (!offer) return false;
  if (offer.vehicleStatus === "wrong-vehicle") return false;
  return offer.matchesSpec !== false;
}

/** How a surface must caption a presentable offer: verified or unverified. */
export function offerConfidence(
  offer: PresentableOffer | undefined | null
): "verified" | "unverified" {
  return offer?.vehicleStatus === "confirmed" || offer?.vehicleStatus === undefined
    ? "verified"
    : "unverified";
}

/**
 * WHAT WE MAY SAY OUT LOUD about a quote's vehicle.
 *
 * On 27 Jul a Chiang Mai shop quoted the exact 125cc scooter the traveller had
 * asked for and the card told them "this price is for a different vehicle".
 * Nothing had gone wrong in the gate - the gate had said `needs-confirmation`.
 * The card was reading `matchesSpec`, a BOOLEAN, which agent-loop sets to false
 * for BOTH "it is the wrong bike" and "we cannot tell yet". Two states, one bit,
 * and the surface had to guess which story to tell. It guessed the accusation.
 *
 * So the stance is derived once, here, and every surface renders it:
 *
 *   ok         - the gate confirmed the traveller's vehicle
 *   confirming - nobody has established it yet (never an accusation); covers
 *                both "assumed" (honest unverified offer) and raw unknown
 *   mismatch   - the gate positively identified a DIFFERENT vehicle
 *
 * The default matters more than the mapping: an unresolved signal reads as
 * "confirming". Telling a shop's customer they were quoted the wrong bike is a
 * claim, and a claim needs evidence, not the absence of it.
 */
export type VehicleStance = "ok" | "confirming" | "mismatch";

export function vehicleStance(offer: PresentableOffer | undefined | null): VehicleStance {
  if (!offer) return "ok";
  if (offer.vehicleStatus === "wrong-vehicle") return "mismatch";
  // A parked substitution is a mismatch the traveller has not resolved yet -
  // the price is real, the vehicle is not the one they asked for.
  if (offer.alternativeOffer) return "mismatch";
  if (offer.vehicleStatus === "needs-confirmation" || offer.vehicleStatus === "assumed") {
    return "confirming";
  }
  if (offer.vehicleStatus === "confirmed") return "ok";
  return offer.matchesSpec === false ? "confirming" : "ok";
}

/**
 * The cheapest offer that may be presented, within a single currency
 * (mixed-currency comparison is dishonest). Positively-wrong quotes are
 * excluded entirely; unverified ones compete - the caller labels them via
 * offerConfidence so the traveller is never misled about confidence.
 */
export function cheapestPresentable<
  T extends { offer?: PresentableOffer; stage?: string },
>(vendors: T[], dominantCurrency: string | null): T | undefined {
  return rankPresentable(vendors, dominantCurrency)[0];
}

/**
 * ONE RANKING RULE FOR EVERY "BEST" SURFACE (owner report 6, D4).
 *
 * The rollup, the quotes rail, Will's answers and the compare list each had a
 * private idea of which quote leads - and only THIS file knew that a
 * wrong-vehicle price is not an offer, that an out-of-stock (or walked-away)
 * shop's price is not takeable today, and that comparing raw numbers across
 * currencies is dishonest. Rank here, render anywhere: presentable quotes in
 * the dominant currency, cheapest first. Copies before sorting - callers hand
 * in the array their feed is rendering.
 */
export function rankPresentable<
  T extends { offer?: PresentableOffer; stage?: string },
>(vendors: T[], dominantCurrency: string | null): T[] {
  return vendors
    .filter(
      (v) =>
        isPresentableOffer(v.offer) &&
        v.offer!.pricePerDay > 0 &&
        (dominantCurrency === null || v.offer!.currency === dominantCurrency) &&
        // A price from a shop with nothing to rent is not a deal the traveller
        // can take today. It stays on the card (with the honest state); it just
        // never wears BEST PRICE.
        v.stage !== "out-of-stock" &&
        v.stage !== "declined" &&
        // Nor is a price for a DIFFERENT machine the traveller has not accepted.
        // Ranking it made a substitute the cheapest "deal" in the hunt, which is
        // the comparison this whole product exists to get right.
        !v.offer!.alternativeOffer
    )
    .slice()
    .sort((a, b) => a.offer!.pricePerDay - b.offer!.pricePerDay);
}
