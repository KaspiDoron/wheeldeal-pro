import { describe, it, expect } from "vitest";
import type { ThreadDigest, TurnContext } from "./types";
import { emptyDigest, persistableDigest, digestFromStored } from "./digest";
import { askTargetFor } from "./pass";
import { citesPrice, findNumerals } from "../integrity/money-context";
import { normalizeDigits } from "../integrity/translation";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE LIVE ENGINE'S ASK WAS A FLAT PERCENTAGE.
//
// `Math.round(quoteNow * 0.85)` - 15% off whatever the shop had just said,
// recomputed from scratch on every turn. So a shop that held firm at 300 was
// asked for 255, then 255, then 255: identical numbers that read as a bot, no
// concession for the shop to reciprocate, and an ugly figure no person says out
// loud. `graph/math.computeRoundTarget` - the ladder the FAILOVER engine has
// always used - was pure, reachable, and never called by the engine that
// actually answers shops.

function ctx(p: {
  quoted?: number;
  round?: number;
  lastAskPerDay?: number;
  floorPerDay?: number;
  rivals?: Array<{ pricePerDay: number }>;
  sheetPricePerDay?: number;
  sheetAnchor?: number;
}): TurnContext {
  const digest: Partial<ThreadDigest> = {
    quotedPricePerDay: p.quoted,
    round: p.round ?? 0,
    lastAskPerDay: p.lastAskPerDay,
    sheetPricePerDay: p.sheetPricePerDay,
  };
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
      currency: "THB",
      benchmark: null,
      lowest: null,
      rivals: (p.rivals ?? []) as TurnContext["session"]["rivals"],
    },
    thread: {
      threadKey: "t@x.com:66812345678",
      vendorId: "v1",
      shop: "Krabi Bikes",
      digest: { ...emptyDigest(), ...digest },
    },
    tail: [],
    inbound: { text: "", verified: { found: false } },
    legalMoves: ["bargain"],
    guards: { maxRounds: 4, floorPerDay: p.floorPerDay, sheetAnchor: p.sheetAnchor },
    event: "shop-message",
  };
}

describe("EXECUTED: a firm shop never gets the same number twice", () => {
  const quoted = 300;
  it("three rounds against an unmoving 300 produce three DIFFERENT asks", () => {
    const r0 = askTargetFor(ctx({ quoted, round: 0 }))!;
    const r1 = askTargetFor(ctx({ quoted, round: 1, lastAskPerDay: r0 }))!;
    const r2 = askTargetFor(ctx({ quoted, round: 2, lastAskPerDay: r1 }))!;
    expect(new Set([r0, r1, r2]).size).toBe(3);
    // The flat 15% that this replaces would have said 255 every single time.
    expect([r0, r1, r2]).not.toEqual([255, 255, 255]);
  });

  it("the ladder CONCEDES - each round asks for more than the last, never less", () => {
    const r0 = askTargetFor(ctx({ quoted, round: 0 }))!;
    const r1 = askTargetFor(ctx({ quoted, round: 1, lastAskPerDay: r0 }))!;
    const r2 = askTargetFor(ctx({ quoted, round: 2, lastAskPerDay: r1 }))!;
    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeGreaterThanOrEqual(r1);
    // ...and it never asks for more than the shop already quoted, which would
    // not be a bargain at all.
    for (const r of [r0, r1, r2]) expect(r).toBeLessThan(quoted);
  });

  it("every ask is a number a person would actually say", () => {
    // niceRound was never reached by the flat-percentage arm: 300 * 0.85 = 255.
    for (const round of [0, 1, 2, 3]) {
      const t = askTargetFor(ctx({ quoted, round }))!;
      expect(t % 5).toBe(0);
    }
  });
});

describe("EXECUTED: a cheaper rival still beats, never matches", () => {
  it("shop A at 200 makes the ask to shop B strictly below 200", () => {
    // The owner's own case: A quoted 200, B quoted 300.
    const t = askTargetFor(ctx({ quoted: 300, rivals: [{ pricePerDay: 200 }] }))!;
    expect(t).toBeLessThan(200);
  });

  it("a floor ABOVE the rival cannot push the ask past the price being cited", () => {
    const t = askTargetFor(
      ctx({ quoted: 300, floorPerDay: 250, rivals: [{ pricePerDay: 200 }] })
    )!;
    expect(t).toBeLessThan(200);
  });

  it("a rival that is not cheaper than the standing quote is not leverage", () => {
    const withRival = askTargetFor(ctx({ quoted: 300, rivals: [{ pricePerDay: 400 }] }));
    const without = askTargetFor(ctx({ quoted: 300 }));
    expect(withRival).toBe(without);
  });
});

describe("EXECUTED: the ladder respects the floor and the absent quote", () => {
  it("never asks below the floor", () => {
    for (const round of [0, 1, 2]) {
      const t = askTargetFor(ctx({ quoted: 300, floorPerDay: 240, round }))!;
      expect(t).toBeGreaterThanOrEqual(240);
    }
  });
  it("no standing quote means no number to name", () => {
    expect(askTargetFor(ctx({}))).toBeUndefined();
    expect(askTargetFor(ctx({ quoted: 0 }))).toBeUndefined();
  });
});

describe("EXECUTED: lastAskPerDay survives the turn, or the ladder is a no-op", () => {
  it("persists and reads back through the durable digest", () => {
    const d: ThreadDigest = { ...emptyDigest(), round: 1, lastAskPerDay: 240 };
    const stored = persistableDigest(d);
    expect(stored.lastAskPerDay).toBe(240);
    expect(digestFromStored(stored).lastAskPerDay).toBe(240);
  });
  it("a row written before the field existed reads as no previous ask", () => {
    expect(digestFromStored({ facts: [], round: 2 }).lastAskPerDay).toBeUndefined();
    // ...and the ladder handles that: it still produces a target.
    expect(askTargetFor(ctx({ quoted: 300, round: 2 }))).toBeDefined();
  });
  it("a nonsense stored value is dropped rather than trusted", () => {
    expect(digestFromStored({ facts: [], lastAskPerDay: -5 }).lastAskPerDay).toBeUndefined();
    expect(digestFromStored({ facts: [], lastAskPerDay: "240" }).lastAskPerDay).toBeUndefined();
  });
});

describe("EXECUTED: the wire reading that feeds lastAskPerDay", () => {
  // live.ts derives the ask from the SENT text, not from the target it handed
  // the model - the model may have ignored it. The lowest money numeral
  // strictly below the standing quote is our ask; a cited rival sits above it
  // by construction, because the ladder beats a rival rather than matching it.
  const askFromWire = (send: string, standing: number) => {
    const asks = findNumerals(normalizeDigits(send))
      .filter((n) => n.money && n.value > 0 && n.value < standing)
      .map((n) => n.value);
    return asks.length ? Math.min(...asks) : undefined;
  };

  it("reads OUR number out of a message that also cites the rival's", () => {
    const send = "Thanks! Another shop offered 200/day for the same scooter - could you do 190/day for 5 days?";
    expect(askFromWire(send, 300)).toBe(190);
    // and the citation itself is still detected, by the same reader.
    expect(citesPrice(normalizeDigits(send), [200])).toBe(true);
  });

  it("a date in the message is not mistaken for our ask", () => {
    const send = "Could you do 250 for the 17 Aug pickup?";
    expect(askFromWire(send, 300)).toBe(250);
  });

  it("a message with no number below the quote leaves the ladder's memory alone", () => {
    expect(askFromWire("Any chance of a better rate?", 300)).toBeUndefined();
  });
});

describe("EXECUTED: a printed price board is a firmer anchor than a spoken quote", () => {
  // The graph engine has clamped against `fields.sheetPricePerDay` since the
  // overlay shipped. SPTE re-derived the sheet price per turn from the current
  // frame and persisted NOTHING, so from turn two the engine that actually
  // answers shops had no idea a board existed and the clamp was dead code on
  // the only path a traveller is served by.
  it("the ask bottoms out at the overlay's fraction of the printed price", () => {
    const t = askTargetFor(ctx({ quoted: 300, sheetPricePerDay: 300, sheetAnchor: 0.8 }))!;
    expect(t).toBeGreaterThanOrEqual(240);
    // ...and without the board the same round would have asked much lower.
    expect(askTargetFor(ctx({ quoted: 300 }))!).toBeLessThan(240);
  });

  it("a REAL floor above the board still wins - the clamp only ever raises", () => {
    const t = askTargetFor(
      ctx({ quoted: 400, sheetPricePerDay: 300, sheetAnchor: 0.8, floorPerDay: 280 })
    )!;
    expect(t).toBeGreaterThanOrEqual(280);
  });

  it("the overlay default applies when the guard is unset", () => {
    const withGuard = askTargetFor(ctx({ quoted: 300, sheetPricePerDay: 300, sheetAnchor: 0.8 }));
    const withoutGuard = askTargetFor(ctx({ quoted: 300, sheetPricePerDay: 300 }));
    expect(withoutGuard).toBe(withGuard);
  });

  it("no board, no clamp - an unposted quote keeps the ordinary ladder", () => {
    expect(askTargetFor(ctx({ quoted: 300, sheetPricePerDay: 0 }))).toBe(
      askTargetFor(ctx({ quoted: 300 }))
    );
  });
});

describe("the board survives the turn, or the clamp is dead code again", () => {
  it("SPTE persists sheetPricePerDay and mediaSummary onto fields", () => {
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/fields\.sheetPricePerDay = verified\.sheetPricePerDay/);
    expect(live).toMatch(/fields\.mediaSummary = digest\.mediaSummary/);
  });
  it("...and seeds them back from fields on the next turn", () => {
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/d\.sheetPricePerDay = f\.sheetPricePerDay/);
    expect(live).toMatch(/d\.mediaSummary = f\.mediaSummary/);
  });
  it("the composer is TOLD about the board, not only clamped by it", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/THEY POSTED A PRICE LIST showing/);
    expect(pass).toMatch(/THEIR PHOTO SHOWED:/);
    expect(pass).toMatch(/sheetPlay \+/);
    expect(pass).toMatch(/mediaPlay \+/);
  });
});
