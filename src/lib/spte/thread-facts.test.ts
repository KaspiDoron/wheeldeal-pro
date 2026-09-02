import { describe, it, expect } from "vitest";
import { deriveThreadFacts } from "./thread-facts";

// THE W10 LANDING (owner report 6 K): thread-facts no longer reads the shop's
// words. Six regexes used to decide firmness/deposit/handover here - FIRM_RX
// fired on the "best price" that OPENS a sale in every market this app serves,
// DEPOSIT_RX latched on the bare word "passport", and all six read raw
// local-language text they could not read at all on a Thai thread. Meaning now
// arrives as the model's durable reading (types.DurableComprehension); this
// file keeps only arithmetic over OUR OWN stamped moves.

describe("meaning projects from the model's durable reading", () => {
  it("the John Motor Rental escalation, as the model read it", () => {
    // The shop said "last price" twice; the model counted both.
    const f = deriveThreadFacts({
      outbound: [
        "thanks for the offer! Since I'm booking for 4 days, can you give me an even better deal, like 330 PHP/day?",
        "thanks for the offer! Since I'm booking for 4 days, can u give me an even better deal, like 320 PHP/day?",
        "thanks for the offer! Since I'm booking for 4 days, can you give me an even better deal, like 280 PHP/day?",
      ],
      comprehension: { firmTurns: 2, handoverMode: "delivery", handoverCostKnown: true },
    });
    expect(f.firmCount).toBe(2);
    expect(f.fulfillmentKnown).toBe(true);
    expect(f.deliveryOffered).toBe(true);
    expect(f.fulfillmentCostKnown).toBe(true); // "free delivery" - the model read it
    expect(f.bargainRounds).toBeGreaterThanOrEqual(3); // three real pushes, OUR side
    expect(f.lastOutbound.length).toBe(3);
  });

  it("a stated deposit is the model's verdict, never a keyword", () => {
    const f = deriveThreadFacts({
      outbound: [],
      comprehension: { depositStated: true, depositKind: "document", handoverMode: "pickup" },
    });
    expect(f.depositKnown).toBe(true);
    expect(f.fulfillmentKnown).toBe(true);
    expect(f.deliveryOffered, "pickup-only is not a delivery offer").toBe(false);
  });

  it("DOCTRINE REGRESSION: raw text alone decides NOTHING anymore", () => {
    // The exact strings that used to trip the regexes, passed as text with no
    // model reading: every meaning fact stays at its keep-negotiating zero.
    // (FIRM_RX read "best price for you" - the warmest opening line in these
    // markets - as a refusal, which retired bargaining on the spot.)
    const f = deriveThreadFacts({
      inbound: [
        "That's a last price sir 😊 I mean that's a best price for you",
        "We need a passport as deposit sir",
        "Yes we can deliver to your hotel, free",
      ],
      currentInbound: "cannot go lower",
      outbound: [],
    });
    expect(f.firmCount).toBe(0);
    expect(f.depositKnown).toBe(false);
    expect(f.fulfillmentKnown).toBe(false);
    expect(f.fulfillmentCostKnown).toBe(false);
  });

  it("is empty on a fresh thread", () => {
    expect(deriveThreadFacts({ outbound: [] })).toEqual({
      firmCount: 0,
      depositKnown: false,
      fulfillmentKnown: false,
      deliveryOffered: false,
      fulfillmentCostKnown: false,
      handoverAsks: 0,
      momentumNudges: 0,
      bargainRounds: 0,
      lastOutbound: [],
    });
  });
});

describe("arithmetic over our own stamped moves survives unchanged", () => {
  it("the stamp discriminates; the wording is only the unstamped fallback", () => {
    const f = deriveThreadFacts({
      outbound: [
        "is 250 THB/day the best you can do for 4 days?", // answer wording that LOOKS like a push
        "can you do 300/day?",
      ],
      outboundKinds: ["auto-answer", "bargain"],
    });
    expect(f.bargainRounds).toBe(1); // the stamped answer is not a round
  });

  it("honors the caller count when it is higher (mis-stamped history heals)", () => {
    const f = deriveThreadFacts({
      outbound: ["can you do 300/day?"],
      priorBargainCount: 5,
    });
    expect(f.bargainRounds).toBe(5);
  });

  it("counts handover asks from the stamped moves, not our prose", () => {
    expect(
      deriveThreadFacts({
        outbound: ["", "", ""],
        outboundKinds: ["rfq", "fulfillment-probe", "fulfillment-probe"],
      }).handoverAsks
    ).toBe(2);
  });
});
