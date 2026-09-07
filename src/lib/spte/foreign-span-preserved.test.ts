// AUDIT F106 - the duration rail must not rewrite a RIVAL's package span into
// the traveller's own rental length.
//
// `correctDuration` runs over every composed SPTE draft before the number rail
// and rewrites any day-count that differs from the RFQ duration. The leverage
// card explicitly orders the model to state the rival's OWN span ("another
// shop's 7-day price works out to about 200/day"), and session-rivals stamps
// `derivedFromDays` precisely so that figure is never presented as a per-day
// quote. The blind rewrite inverted that honesty chain at the last hop: the
// message that reached the shop asserted a 10-day rival price no rival gave.
//
// Everything below runs the REAL helper and the REAL rails.
import { describe, it, expect } from "vitest";
import type { ThreadDigest, TurnArtifact, TurnContext } from "./types";
import { emptyDigest } from "./digest";
import { correctDuration } from "../graph/guardrails";
import { runPostRails } from "./rails";

function ctx(p: {
  quoted: number;
  durationDays?: number;
  rivals?: Array<{ pricePerDay: number; derivedFromDays?: number }>;
  floorPerDay?: number;
  digest?: Partial<ThreadDigest>;
}): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: {
        vehicleClass: "scooter",
        transmission: "any",
        durationDays: p.durationDays ?? 10,
        accessories: [],
        fulfillment: "any",
        vendorMessage: "",
      },
      currency: "THB",
      benchmark: null,
      lowest: null,
      rivals: (p.rivals ?? []).map((r, i) => ({
        vendorId: `rival-${i}`,
        shop: `Harbour Wheels ${i}`,
        pricePerDay: r.pricePerDay,
        currency: "THB",
        ...(r.derivedFromDays ? { derivedFromDays: r.derivedFromDays } : {}),
      })),
    },
    thread: {
      threadKey: "t@x.com:66812345678",
      vendorId: "v1",
      shop: "Krabi Bikes",
      digest: { ...emptyDigest(), quotedPricePerDay: p.quoted, ...p.digest },
    },
    tail: [],
    inbound: {
      text: `${p.quoted} per day`,
      verified: { found: true, pricePerDay: p.quoted, currency: "THB" },
    },
    legalMoves: ["bargain"],
    guards: { maxRounds: 4, floorPerDay: p.floorPerDay ?? 150 },
    event: "shop-message",
  };
}

const draft = (message: string, counter?: number): TurnArtifact => ({
  read: { intent: "bargain" },
  think: "",
  move: "bargain",
  message,
  counterPricePerDay: counter,
  leverageUsed: [],
  digestPatch: [],
});

describe("EXECUTED: correctDuration protects a foreign span", () => {
  it("a protected day-count survives the rewrite", () => {
    const text = "Another shop's 7-day price works out to about 200 THB/day - could you do 190/day?";
    const fixed = correctDuration(text, 10, [7]);
    expect(fixed.changed).toBe(false);
    expect(fixed.text).toContain("7-day");
    expect(fixed.text).not.toContain("10 days");
  });

  it("a hallucinated span with NO provenance is still rewritten to the truth", () => {
    // The production case duration-guard.test.ts pins: a 5-day rental whose
    // bargain message drifted to "for 3 days". Nothing protects 3 here.
    const fixed = correctDuration("Could you do 200 a day for 3 days?", 5, [7]);
    expect(fixed.changed).toBe(true);
    expect(fixed.from).toEqual([3]);
    expect(fixed.text).toContain("5 days");
  });

  it("with no protected set the old behaviour is byte-identical", () => {
    const text = "Another shop's 7-day price works out to about 200 THB/day.";
    expect(correctDuration(text, 10).text).toBe(correctDuration(text, 10, []).text);
    expect(correctDuration(text, 10).changed).toBe(true);
  });
});

describe("EXECUTED: the SPTE rails keep the rival's own span on the wire", () => {
  it("a derived-rival draft on a 10-day rental is not rewritten to 10 days", () => {
    const c = ctx({ quoted: 250, durationDays: 10, rivals: [{ pricePerDay: 200, derivedFromDays: 7 }] });
    const rail = runPostRails(
      c,
      draft(
        "Thanks! Another shop's 7-day price works out to about 200 THB/day - could you do 190/day for 10 days?",
        190
      )
    );
    expect(rail.ok, rail.rejected?.detail).toBe(true);
    expect(rail.finalText).toContain("7-day");
    // The rival's span must NOT have been laundered into the traveller's.
    expect(rail.finalText).not.toMatch(/10[\s-]?day price works out/);
  });

  it("a bare hallucinated span in the same draft is still corrected", () => {
    const c = ctx({ quoted: 250, durationDays: 10, rivals: [{ pricePerDay: 200, derivedFromDays: 7 }] });
    const rail = runPostRails(
      c,
      draft("Thanks! Could you do 190/day for 3 days? Another shop's 7-day price works out to about 200 THB/day.", 190)
    );
    expect(rail.ok, rail.rejected?.detail).toBe(true);
    expect(rail.finalText).toContain("for 10 days");
    expect(rail.finalText).toContain("7-day");
  });
});
