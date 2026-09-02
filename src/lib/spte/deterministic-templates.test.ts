import { describe, it, expect } from "vitest";
import type { ThreadDigest, TurnContext } from "./types";
import { emptyDigest } from "./digest";
import { templateFor } from "./pass";
import { beatRivalTarget } from "../negotiation/beat-rival";

// THE TEMPLATES ARE NOT A FALLBACK, THEY ARE THE FLOOR.
//
// `templateFor` is what actually goes out on every provider failure and every
// rail rejection, and `verify-recap` is deterministic BY DESIGN - so whatever
// it says, it says to every shop that reaches that state, unvaried. Three
// defects lived there: an ask no person would say out loud, a currency printed
// as an invoice code, and the one sentence in the engine that most sounds like
// a booking sailing through the rail built to stop exactly that.

function ctx(p: {
  quoted?: number;
  rivals?: Array<{ pricePerDay: number; currency?: string }>;
  currency?: string;
  floorPerDay?: number;
  digest?: Partial<ThreadDigest>;
  legalMoves?: TurnContext["legalMoves"];
}): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: {
        vehicleClass: "scooter",
        transmission: "any",
        durationDays: 5,
        accessories: [],
        fulfillment: "any",
        vendorMessage: "",
      },
      currency: p.currency ?? "THB",
      benchmark: null,
      lowest: null,
      rivals: (p.rivals ?? []).map((r, i) => ({
        vendorId: `v${i}`,
        shop: `Shop ${i}`,
        pricePerDay: r.pricePerDay,
        currency: r.currency ?? p.currency ?? "THB",
      })),
    },
    thread: {
      threadKey: "t@x.com:66812345678",
      vendorId: "me",
      shop: "This Shop",
      digest: { ...emptyDigest(), quotedPricePerDay: p.quoted, ...p.digest },
    },
    tail: [],
    inbound: { text: "", verified: { found: false } },
    legalMoves: p.legalMoves ?? ["bargain"],
    guards: { maxRounds: 4, floorPerDay: p.floorPerDay },
    event: "shop-message",
  };
}

describe("EXECUTED: the ask is a number a person would say out loud", () => {
  // beatRivalTarget solved DECIMALS ("189.5 reads as a machine wrote it") and
  // stopped there. niceRound existed the whole time and this path never called
  // it, so the deterministic ask emitted figures nobody haggles with.
  const cases: Array<[number, number]> = [
    [230, 300],
    [187, 220],
    [1450, 1800],
    [73, 90],
  ];

  it("the raw helper really does produce the ugly numbers - this is the bug", () => {
    const raw = cases.map(([rival, quote]) =>
      beatRivalTarget({ rivalPricePerDay: rival, quotePerDay: quote })
    );
    // 219, 178, 1378, 69 - none of them a figure anyone says.
    expect(raw.some((n) => n % 5 !== 0)).toBe(true);
  });

  it("...and the template no longer sends them", () => {
    for (const [rival, quote] of cases) {
      const t = templateFor(ctx({ quoted: quote, rivals: [{ pricePerDay: rival }] }), "bargain")!;
      const asked = [...t.matchAll(/(\d[\d,]*)/g)]
        .map((m) => Number(m[1].replace(/,/g, "")))
        .filter((n) => n > 0 && n < rival);
      expect(asked.length, t).toBeGreaterThan(0);
      for (const n of asked) expect(n % 5, `${t}`).toBe(0);
    }
  });

  it("BEAT, NEVER MATCH - rounding must not walk the ask back onto the rival", () => {
    // niceRound rounds to the NEAREST step, so 219 against a rival of 220 would
    // round straight onto it. niceRoundBelow is why that cannot happen.
    for (const [rival, quote] of [
      [220, 280],
      [200, 260],
      [1000, 1300],
    ] as Array<[number, number]>) {
      const t = templateFor(ctx({ quoted: quote, rivals: [{ pricePerDay: rival }] }), "bargain")!;
      const nums = [...t.matchAll(/(\d[\d,]*)/g)].map((m) => Number(m[1].replace(/,/g, "")));
      const asked = nums.filter((n) => n > 0 && n !== rival && n !== 5);
      for (const n of asked) expect(n, t).toBeLessThan(rival);
    }
  });
});

describe("EXECUTED: the shop's own money, in symbols", () => {
  it("THB prints as a symbol, not as an invoice code", () => {
    const t = templateFor(ctx({ quoted: 300, rivals: [{ pricePerDay: 200 }] }), "bargain")!;
    expect(t).toContain("฿");
    expect(t).not.toContain("THB 200");
  });

  it("a currency with no symbol still degrades to a readable code", () => {
    const t = templateFor(
      ctx({ quoted: 300, currency: "XYZ", rivals: [{ pricePerDay: 200, currency: "XYZ" }] }),
      "bargain"
    )!;
    expect(t).toContain("XYZ");
  });

  it("the owner's sentence still comes out whole", () => {
    const t = templateFor(ctx({ quoted: 300, rivals: [{ pricePerDay: 200 }] }), "bargain")!;
    expect(t).toContain("Another shop offered");
    expect(t).toMatch(/could you do/i);
  });
});

describe("EXECUTED: the recap no longer sounds like a booking", () => {
  const COMPLETE: Partial<ThreadDigest> = {
    quotedPricePerDay: 250,
    firmCount: 2,
    depositKnown: true,
    fulfillmentKnown: true,
    comprehension: { depositKind: "document", handoverMode: "delivery" },
  };

  it("the phrase is gone from the one deterministic template that carried it", () => {
    const t = templateFor(
      ctx({ digest: COMPLETE, legalMoves: ["verify-recap"] }),
      "verify-recap"
    )!;
    expect(t).not.toMatch(/lock it in/i);
    // ...and it still does its job: it recaps and asks for confirmation.
    expect(t).toContain("250");
    expect(t.toLowerCase()).toContain("correct");
  });

  it("the rail catches the phrase anyway - the model can reach for it alone", async () => {
    // The rail could not see it before: `lock` was in no alternative, and the
    // `confirm` branch needs a pronoun subject immediately before the verb,
    // which "just to confirm" does not have.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/spte/rails.ts", "utf8");
    const m = src.match(/const COMMIT_RX =\s*(\/[\s\S]*?\/i);/);
    expect(m).toBeTruthy();
    // eslint-disable-next-line no-eval
    const rx = eval(m![1]) as RegExp;
    expect(rx.test("just to confirm before we lock it in: 300/day")).toBe(true);
    expect(rx.test("ok lets lock it in")).toBe(true);
    expect(rx.test("I am locking this in now")).toBe(true);
    expect(rx.test("finalizing the booking today")).toBe(true);
    // The near-misses the rail already protected must stay passable.
    expect(rx.test("I agree that 300 is a fair list price, but can you move on it?")).toBe(false);
    expect(rx.test("We're finalizing our pick between a few shops today")).toBe(false);
    // ...including the replacement wording.
    expect(rx.test("Perfect - just so I have it right: 300/day for 5 days. All correct?")).toBe(
      false
    );
  });
});
