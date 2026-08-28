import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readFileSync } from "fs";
import { join } from "path";
import {
  decideSubstitution,
  retargetForAlternative,
  CHOICE_TTL_MS,
  MIN_CONFIDENCE,
  type AlternativeOffer,
} from "./substitution";

// A SHOP THAT OFFERS SOMETHING ELSE IS NOT A SHOP THAT SAID NO.
//
// `wrongVehicle` made `redirect-close` the only legal move, so the agent
// thanked the shop and ended the thread. Correct for "we only rent cars";
// completely wrong for "no 125 today, but I have a 150 for 220" - the same
// ride, twenty baht more, from a shop trying to do business. A traveller would
// decide that in one second. The app closed the conversation and then reported
// the search as having fewer options.

const NOW = 1_700_000_000_000;

const alt = (o: Partial<Parameters<typeof decideSubstitution>[0]["alternative"] & object> = {}) => ({
  offered: true,
  vehicle: "Yamaha Nmax 155",
  engineSizeCc: 155,
  pricePerDay: 220,
  closeness: "acceptable" as const,
  reason: "A slightly bigger automatic, same kind of ride.",
  confidence: 0.9,
  ...o,
});

describe("REPRODUCTION: a near-equivalent substitute stops ending the thread", () => {
  it("an acceptable alternative becomes a question, not a goodbye", () => {
    const d = decideSubstitution({ wrongVehicle: true, alternative: alt(), now: NOW, currency: "THB" });
    expect(d.kind).toBe("offer-choice");
    if (d.kind !== "offer-choice") return;
    expect(d.offer.vehicle).toBe("Yamaha Nmax 155");
    expect(d.offer.pricePerDay).toBe(220);
    expect(d.offer.currency).toBe("THB");
    expect(d.offer.at).toBe(NOW);
  });

  it("so does an equivalent one", () => {
    expect(
      decideSubstitution({ wrongVehicle: true, alternative: alt({ closeness: "equivalent" }), now: NOW }).kind
    ).toBe("offer-choice");
  });
});

describe("...but the bar for interrupting the traveller stays high", () => {
  it("a different CLASS closes exactly as before", () => {
    // "Do you want a car instead of a scooter?" for every car-only shop is the
    // noise that makes people stop reading the app.
    expect(
      decideSubstitution({ wrongVehicle: true, alternative: alt({ closeness: "different-class" }), now: NOW })
        .kind
    ).toBe("close");
  });

  it("an UNCLEAR read is not a substitution offer", () => {
    expect(
      decideSubstitution({ wrongVehicle: true, alternative: alt({ closeness: "unclear" }), now: NOW }).kind
    ).toBe("close");
  });

  it("a low-confidence read closes rather than asking about a guess", () => {
    expect(
      decideSubstitution({
        wrongVehicle: true,
        alternative: alt({ confidence: MIN_CONFIDENCE - 0.01 }),
        now: NOW,
      }).kind
    ).toBe("close");
  });

  it("nothing offered, or nothing named, closes", () => {
    expect(decideSubstitution({ wrongVehicle: true, alternative: alt({ offered: false }), now: NOW }).kind).toBe(
      "close"
    );
    expect(decideSubstitution({ wrongVehicle: true, alternative: alt({ vehicle: null }), now: NOW }).kind).toBe(
      "close"
    );
    // No semantic read ran at all (no provider): behave exactly as before.
    expect(decideSubstitution({ wrongVehicle: true, alternative: null, now: NOW }).kind).toBe("close");
  });

  it("a matching vehicle is not this module's business", () => {
    expect(decideSubstitution({ wrongVehicle: false, alternative: alt(), now: NOW }).kind).toBe("continue");
  });
});

describe("a pending choice holds the thread, but not forever", () => {
  const pending: AlternativeOffer = {
    vehicle: "Nmax 155",
    pricePerDay: 220,
    closeness: "acceptable",
    at: NOW,
  };

  it("the same choice is never asked twice", () => {
    const d = decideSubstitution({
      wrongVehicle: true,
      alternative: alt({ vehicle: "Something else" }),
      pending,
      now: NOW + 60_000,
    });
    expect(d.kind).toBe("offer-choice");
    if (d.kind === "offer-choice") expect(d.offer.vehicle).toBe("Nmax 155");
  });

  it("REPRODUCTION: a stale choice does not hold a thread silent forever", () => {
    // The F6 lesson applied to a new state: a shop that offered a 150 two days
    // ago has rented it, and a thread waiting on a tap that is never coming is
    // a dead thread the traveller cannot see.
    const d = decideSubstitution({
      wrongVehicle: true,
      alternative: null,
      pending,
      now: NOW + CHOICE_TTL_MS + 1,
    });
    expect(d.kind).toBe("close");
  });
});

describe("accepting changes the vehicle, not the rental", () => {
  const offer: AlternativeOffer = {
    vehicle: "Yamaha Nmax 155",
    engineSizeCc: 155,
    pricePerDay: 220,
    closeness: "acceptable",
    at: NOW,
  };

  it("the engine target moves and the acceptance is written down", () => {
    const rfq = { engineSizeCc: 125, durationDays: 3, accessories: ["helmet"], notes: "airport pickup" };
    const next = retargetForAlternative(rfq, offer);
    expect(next.engineSizeCc).toBe(155);
    expect(next.notes).toMatch(/airport pickup\. Traveller accepted the shop's alternative: Yamaha Nmax 155/);
  });

  it("everything else about the request is untouched", () => {
    // They agreed to a different bike, not to a different rental.
    const rfq = { engineSizeCc: 125, durationDays: 3, accessories: ["helmet"] };
    const next = retargetForAlternative(rfq, offer);
    expect(next.durationDays).toBe(3);
    expect(next.accessories).toEqual(["helmet"]);
  });

  it("an unstated engine size does not overwrite the traveller's with nothing", () => {
    const rfq = { engineSizeCc: 125 };
    expect(retargetForAlternative(rfq, { ...offer, engineSizeCc: null }).engineSizeCc).toBe(125);
  });

  it("the identity gate keeps working - against the NEW target", () => {
    // This is why acceptance RETARGETS rather than relaxing the gate: a third
    // substitution is caught exactly the same way.
    const rfq = { engineSizeCc: 125 };
    const next = retargetForAlternative(rfq, offer);
    expect(next.engineSizeCc).toBe(155);
    expect(next).not.toHaveProperty("skipVehicleGate");
  });
});

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the pause is real, not just a data field", () => {
  it("REPRODUCTION: a pending choice makes the thread SILENT, not closed", () => {
    // redirect-close was the only legal move on wrongVehicle, so the agent
    // thanked a shop that was actively trying to do business.
    const policy = readCode("src/lib/spte/policy.ts");
    expect(policy).toMatch(/if \(ctx\.thread\.digest\.alternativeOffer\) \{\s*moves\.push\("silent"\);/);
  });

  it("every entry point sees the same pending choice", () => {
    // Read in buildTurnContext, which runThreadTurn reaches for an inbound
    // reply, a scheduled wakeup and a user action alike.
    // W4.5 folded this into the SINGLE state read the turn now makes (the
    // persisted digest rides on the same row), so the pin follows the read
    // rather than the old inline call - same fact, one round trip.
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/io\.loadState\(input\.event\.threadKey\)/);
    expect(live).toMatch(/const stored = \(state\?\.fields as \{ alternativeOffer/);
    expect(live).toMatch(/Date\.now\(\) - stored\.at < CHOICE_TTL_MS/);
  });

  it("the read is off the reply path and fires on a substitution SUSPICION (union), not matchesSpec alone", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    // Owner problem #6: matchesSpec alone missed "no Click, only Nmax" (both
    // scooters). The gate is now the union of matchesSpec===false, an unconfirmed
    // assessment, and a substitution hint in the reply.
    expect(loop).toMatch(/substitutionSuspected =\s*[\s\S]{0,120}?extraction\?\.matchesSpec === false/);
    expect(loop).toMatch(/if \(substitutionSuspected && ctx\.sender && ctx\.vendorId\)/);
    // wrongVehicle is now DERIVED (from the class mismatch, the assessment, or
    // the classifier's own "a different vehicle was offered"), never hardcoded.
    expect(loop).toMatch(/const wrongVehicle =/);
    expect(loop).not.toMatch(/wrongVehicle: true,/);
    expect(loop).toMatch(/finishBeforeResponse\("substitution-offer"/);
  });
});

describe("asking once, and answering once", () => {
  it("a repeat or a redelivery never replaces a choice on screen", () => {
    // The price on the card would change under the traveller's thumb.
    const store = readCode("src/lib/vehicle/substitution-store.ts");
    expect(store).toMatch(/if \(row\.fields\?\.alternativeOffer\) return false;/);
  });

  it("accepting retargets the thread; declining ends it", () => {
    const store = readCode("src/lib/vehicle/substitution-store.ts");
    expect(store).toMatch(/next\.acceptedVehicle = offer\.vehicle;/);
    expect(store).toMatch(/vehicleConfirmation = \{ status: "confirmed"/);
    expect(store).toMatch(/next\.declined = true;/);
    // Either way the pause clears.
    expect(store).toMatch(/alternativeOffer: null/);
  });

  it("the decision endpoint sends NOTHING to the shop", () => {
    // A decision made in the app is not a licence to bypass pacing, the
    // recipient mutex or any rail. The next ordinary turn does the talking.
    const route = readCode("src/app/api/negotiate/alternative/route.ts");
    expect(route).not.toMatch(/guardOutbound|sendFromUser|outreach/);
    expect(route).toMatch(/resolveAlternativeOffer/);
  });

  it("a choice that is already gone answers 409, not a silent no-op", () => {
    const route = readCode("src/app/api/negotiate/alternative/route.ts");
    expect(route).toMatch(/stale: true/);
    expect(route).toMatch(/status: 409/);
  });

  it("the card asks with the shop's own words and both answers", () => {
    const card = readCode("src/components/VendorCard.tsx");
    expect(card).toMatch(/This shop offered a different vehicle/);
    expect(card).toMatch(/decideAlternative\(true\)/);
    expect(card).toMatch(/decideAlternative\(false\)/);
    expect(card).toMatch(/offer\.alternativeOffer\.reason/);
  });
});
