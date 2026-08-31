import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rankPresentable, vehicleStance, isPresentableOffer } from "../offer-presentation";
import { offerBadge } from "../offer-badges";

// OWNER PROBLEMS 6 AND 18: a shop that does not have the vehicle offers a
// different one, and the app shows its price as if it were the vehicle asked
// for.
//
// The substitution READ was widened in an earlier wave, and an audit found
// nothing downstream consumed its verdict. The substitute's price was written
// to the offers row ~700 lines BEFORE the read ran, so it wore UNVERIFIED, it
// was eligible for BEST PRICE, and the thread kept haggling for the original
// bike while the traveller's Yes/No sat unanswered on the card.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const offer = (pricePerDay: number, extra: Record<string, unknown> = {}) => ({
  pricePerDay,
  currency: "THB",
  ...extra,
});

describe("a substitute never wins BEST PRICE", () => {
  it("EXECUTED: the cheapest price is not the deal when it is another machine", () => {
    const vendors = [
      { id: "sub", offer: offer(220, { alternativeOffer: { vehicle: "Nmax 155" } }) },
      { id: "real", offer: offer(300) },
    ];
    const ranked = rankPresentable(vendors, "THB");
    // The 220 is real and it is on the card - it is simply not comparable, so
    // it cannot be the hunt's best deal.
    expect(ranked.map((v) => v.id)).toEqual(["real"]);
  });

  it("EXECUTED: once the traveller decides, the parked choice is gone and it ranks", () => {
    const vendors = [
      { id: "sub", offer: offer(220, { alternativeOffer: null }) },
      { id: "real", offer: offer(300) },
    ];
    expect(rankPresentable(vendors, "THB").map((v) => v.id)).toEqual(["sub", "real"]);
  });

  it("EXECUTED: it still SHOWS - excluded from ranking is not hidden", () => {
    expect(isPresentableOffer(offer(220, { alternativeOffer: { vehicle: "Nmax" } }))).toBe(true);
  });

  it("EXECUTED: out-of-stock and declined stay excluded too - the rule is unchanged", () => {
    const vendors = [
      { id: "gone", offer: offer(150), stage: "out-of-stock" },
      { id: "no", offer: offer(160), stage: "declined" },
      { id: "real", offer: offer(300) },
    ];
    expect(rankPresentable(vendors, "THB").map((v) => v.id)).toEqual(["real"]);
  });
});

describe("the label tells the truth about whose decision it is", () => {
  it("EXECUTED: a parked substitution reads as a MISMATCH, not as pending confirmation", () => {
    // vehicleStance drove UNVERIFIED, whose copy says "it resolves itself" -
    // over a choice only a person can make.
    expect(vehicleStance(offer(220, { alternativeOffer: { vehicle: "Nmax" } }))).toBe("mismatch");
    expect(vehicleStance(offer(220))).toBe("ok");
  });

  it("EXECUTED: the SIMILAR VEHICLE badge exists and is distinct from DIFFERENT VEHICLE", () => {
    // Two documents credited this tag as shipped and it did not exist.
    const similar = offerBadge({ stance: "mismatch", pendingChoice: true });
    const mismatch = offerBadge({ stance: "mismatch", pendingChoice: false });
    expect(similar.id).toBe("similar");
    expect(similar.label).toBe("SIMILAR VEHICLE");
    expect(mismatch.id).toBe("mismatch");
    // The difference that matters: one says the agent is handling it, the other
    // says the traveller has to answer.
    expect(similar.next).toMatch(/Say Yes or No/);
    expect(mismatch.next).toMatch(/asking the shop/i);
  });

  it("EXECUTED: with no parked choice the vocabulary is exactly as it was", () => {
    expect(offerBadge({ stance: "confirming" }).id).toBe("confirming");
    expect(offerBadge({ stance: "ok", verified: true }).id).toBe("verified");
    expect(offerBadge({}).id).toBe("quote");
  });
});

describe("the thread really does pause", () => {
  const policy = readCode("src/lib/spte/policy.ts");

  it("the pause is keyed on the parked choice, not on the pre-union signal", () => {
    // It lived INSIDE `if (v.wrongVehicle)`, which is the pre-union signal only
    // - so on exactly the case the union was added for ("no Click, only Nmax",
    // matchesSpec true, verdict unclear) the pause was unreachable and the
    // agent kept haggling. The shipped card copy promises the opposite.
    const pauseIdx = policy.indexOf("ctx.thread.digest.alternativeOffer");
    const wrongIdx = policy.indexOf("if (v.wrongVehicle)");
    expect(pauseIdx).toBeGreaterThan(0);
    expect(wrongIdx).toBeGreaterThan(0);
    expect(pauseIdx).toBeLessThan(wrongIdx);
  });
});

describe("the read can see a substitution in any language or medium", () => {
  const loop = readCode("src/lib/agent-loop.ts");

  it("the hint and the classifier both read the gloss and the transcript", () => {
    // The ASCII regex ran on opts.text alone: blind to Thai/Indonesian, blind
    // to a voice note (whose transcript lands in a sibling field), and blind to
    // a caption-less board (opts.text is "[photo]").
    expect(loop).toMatch(/const substitutionSource = `\$\{text\}/);
    expect(loop).toMatch(/inboundEnglish \?\? ""/);
    expect(loop).toMatch(/const inboundText = \(inboundEnglish \|\| substitutionSource \|\| opts\.text\) \?\? ""/);
  });

  it("accepting a substitution retargets the gate instead of switching it off", () => {
    // acceptedVehicleCc had no production reader; what WAS read was
    // `vehicleConfirmation: confirmed`, whose only effect is to silence the
    // identity gate - so a third substitution became undetectable.
    expect(loop).toMatch(/let acceptedCc: number \| undefined/);
    expect(loop).toMatch(/displacementCc: acceptedCc \?\? rfq\.engineSizeCc/);
  });
});
