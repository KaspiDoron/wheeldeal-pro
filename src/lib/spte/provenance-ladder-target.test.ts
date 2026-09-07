// AUDIT F141 - the provenance basis must carry the ladder's OWN target.
//
// With `guards.floorPerDay` undefined (a real production shape: agent-loop
// leaves it unset on a floor-row currency mismatch), `insideAskRange` cannot
// ground anything, and the basis rails.ts hands to checkOutboundNumbers held
// only the model's self-reported counterPricePerDay - never askTargetFor(ctx)
// and never the figure the deterministic bargain template actually printed.
// So the engine's own number was rejected as "ungrounded", the orchestrator
// re-composed the same template, and the shop that had just quoted a price got
// silence. Everything below runs the REAL composer and the REAL rails.
import { describe, it, expect } from "vitest";
import type { ThreadDigest, TurnArtifact, TurnContext } from "./types";
import { emptyDigest } from "./digest";
import { askTargetFor, fallbackArtifact, templateFor } from "./pass";
import { runPostRails } from "./rails";

function ctx(p: {
  quoted: number;
  rivals?: Array<{ pricePerDay: number }>;
  floorPerDay?: number;
  digest?: Partial<ThreadDigest>;
}): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: {
        vehicleClass: "scooter",
        transmission: "any",
        durationDays: 4,
        accessories: [],
        fulfillment: "any",
        vendorMessage: "",
      },
      currency: "THB",
      benchmark: null,
      lowest: null,
      rivals: (p.rivals ?? []).map((r, i) => ({
        vendorId: `rival-${i}`,
        shop: `Rival ${i}`,
        pricePerDay: r.pricePerDay,
        currency: "THB",
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
    guards: { maxRounds: 4, floorPerDay: p.floorPerDay },
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

describe("EXECUTED: the deterministic bargain template passes its own rails with no floor", () => {
  it("quote 250, rival 200, floor undefined - the template's ask is grounded", () => {
    const c = ctx({ quoted: 250, rivals: [{ pricePerDay: 200 }] });
    const fb = fallbackArtifact(c);
    expect(fb.move).toBe("bargain");
    // The ask clause is a family now (F111 - a fixed sentence made the second
    // deterministic turn a byte-identical duplicate); the beat target it names
    // is the arithmetic, and that is what this file is about.
    expect(fb.message).toMatch(/could you do|would .+ work|any chance of|is .+ possible/i);
    const rail = runPostRails(c, fb);
    expect(rail.rejected?.rule, rail.rejected?.detail).not.toBe("ungrounded-number");
    expect(rail.ok).toBe(true);
    expect(rail.finalText).toBe(fb.message);
  });

  it("the control: the same context WITH a floor already passed (isolates the cause)", () => {
    const c = ctx({ quoted: 250, rivals: [{ pricePerDay: 200 }], floorPerDay: 150 });
    const rail = runPostRails(c, fallbackArtifact(c));
    expect(rail.ok).toBe(true);
  });

  it("the no-rival template (a soft ask with no number) is unaffected", () => {
    const c = ctx({ quoted: 250 });
    const rail = runPostRails(c, fallbackArtifact(c));
    expect(rail.ok).toBe(true);
  });
});

describe("EXECUTED: a model draft naming the prompt's own ladder target is grounded", () => {
  it("the target askTargetFor computed, printed without counterPricePerDay, passes", () => {
    const c = ctx({ quoted: 250 });
    const target = askTargetFor(c)!;
    expect(target).toBeGreaterThan(0);
    expect(target).toBeLessThan(250);
    const rail = runPostRails(c, draft(`Thanks! Could you do ${target}/day for 4 days?`));
    expect(rail.rejected?.rule, rail.rejected?.detail).not.toBe("ungrounded-number");
    expect(rail.ok).toBe(true);
  });

  it("the guarantee itself is intact: an invented number is still refused", () => {
    // 300 is neither the quote, the rival, a target nor a derivation of any of
    // them on a 4-day rental - the field's "Your price 300 is too much".
    const c = ctx({ quoted: 250, rivals: [{ pricePerDay: 200 }] });
    const rail = runPostRails(c, draft("Your price 300 is too much, could you do 190/day for 4 days?"));
    expect(rail.ok).toBe(false);
    expect(rail.rejected?.rule).toBe("ungrounded-number");
  });

  it("...and a target below a KNOWN floor is still refused by the bounds rung", () => {
    const c = ctx({ quoted: 250, floorPerDay: 200 });
    const rail = runPostRails(c, draft("Could you do 150/day for 4 days?", 150));
    expect(rail.ok).toBe(false);
  });
});

describe("the template's printed figure and the ladder's figure are BOTH in the basis", () => {
  it("the rival-beating template prints a figure the ladder alone would not", () => {
    // The two ladders (computeRoundTarget with the sheet clamp vs. the
    // template's niceRound over beatRivalTarget) need not agree - so grounding
    // askTargetFor alone would leave the template's own number rejected.
    const c = ctx({ quoted: 250, rivals: [{ pricePerDay: 200 }] });
    const printed = templateFor(c, "bargain")!.match(/(?:do|of|is|would) ฿?(\d+)\/day/)?.[1];
    expect(printed).toBeTruthy();
    const rail = runPostRails(c, draft(templateFor(c, "bargain")!));
    expect(rail.ok, rail.rejected?.detail).toBe(true);
  });
});
