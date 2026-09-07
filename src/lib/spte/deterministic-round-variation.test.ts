// AUDIT F111 - the deterministic composer must not be turn-invariant.
//
// `seededFamily` seeded on `threadKey|salt` alone and the rival-cite bargain
// was a single fixed sentence, so a second provider-failure / rail-rejected
// turn on the same thread composed byte-identical text. `guardOutbound`'s
// idempotency gate then drops a byte-identical body to the same shop inside 6h
// with `terminal: true`, and only NON-terminal verdicts are re-parked - so the
// composed reply is discarded and the shop's second message is never answered.
// The path is reachable whenever the downstream re-variation cannot help: a
// localized thread skips `ensureGloballyUnique` entirely, and a voice profile
// that never uses emoji makes `enforceEmojiTone` a deterministic no-op.
//
// Everything below runs the REAL composer.
import { describe, it, expect } from "vitest";
import type { ThreadDigest, TurnContext } from "./types";
import { emptyDigest } from "./digest";
import { templateFor } from "./pass";
import { isRepetitive } from "../wa/similarity";

function ctx(p: {
  quoted?: number;
  round?: number;
  rivals?: Array<{ pricePerDay: number; derivedFromDays?: number }>;
  threadKey?: string;
  legalMoves?: TurnContext["legalMoves"];
  digest?: Partial<ThreadDigest>;
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
      threadKey: p.threadKey ?? "t@x.com:66812345678",
      vendorId: "v1",
      shop: "Krabi Bikes",
      digest: {
        ...emptyDigest(),
        quotedPricePerDay: p.quoted,
        round: p.round ?? 0,
        ...p.digest,
      },
    },
    tail: [],
    inbound: p.quoted
      ? {
          text: `${p.quoted} per day`,
          verified: { found: true, pricePerDay: p.quoted, currency: "THB" },
        }
      : { text: "", verified: { found: false } },
    legalMoves: p.legalMoves ?? ["bargain"],
    guards: { maxRounds: 4, floorPerDay: 150 },
    event: "shop-message",
  };
}

describe("EXECUTED: two deterministic turns on one thread are not the same message", () => {
  it("the rival-cite bargain varies between rounds", () => {
    // The finder's executed case: turn 1 the shop quotes 300, turn 2 it quotes
    // 280, the AI chain is down both times. The rival and the beat target are
    // unchanged, so the old composer emitted the same sentence twice.
    const t1 = templateFor(ctx({ quoted: 300, round: 0, rivals: [{ pricePerDay: 200 }] }), "bargain")!;
    const t2 = templateFor(ctx({ quoted: 280, round: 1, rivals: [{ pricePerDay: 200 }] }), "bargain")!;
    expect(t2).not.toBe(t1);
    expect(isRepetitive(t2, [t1]), `${t1}\n${t2}`).toBe(false);
  });

  it("the no-rival soft ask varies across every round the cap allows", () => {
    const seen = [0, 1, 2, 3].map(
      (round) => templateFor(ctx({ quoted: 300, round }), "bargain")!
    );
    expect(new Set(seen).size, seen.join("\n")).toBe(4);
    for (let i = 1; i < seen.length; i++) {
      expect(isRepetitive(seen[i], [seen[i - 1]]), `${seen[i - 1]}\n${seen[i]}`).toBe(false);
    }
  });

  it("the priceless ask varies across every round the cap allows", () => {
    const seen = [0, 1, 2, 3].map((round) => templateFor(ctx({ round }), "bargain")!);
    expect(new Set(seen).size, seen.join("\n")).toBe(4);
  });

  it("the momentum nudge varies between rounds, with and without a rival", () => {
    const bare = [0, 1].map(
      (round) => templateFor(ctx({ round, legalMoves: ["momentum"] }), "momentum")!
    );
    expect(bare[1]).not.toBe(bare[0]);
    const withRival = [0, 1].map(
      (round) =>
        templateFor(ctx({ round, rivals: [{ pricePerDay: 200 }], legalMoves: ["momentum"] }), "momentum")!
    );
    expect(withRival[1]).not.toBe(withRival[0]);
  });
});

describe("EXECUTED: the thread axis survives - the composer is still deterministic", () => {
  it("the same thread at the same round composes the same message twice", () => {
    const a = templateFor(ctx({ quoted: 300, round: 2, rivals: [{ pricePerDay: 200 }] }), "bargain")!;
    const b = templateFor(ctx({ quoted: 300, round: 2, rivals: [{ pricePerDay: 200 }] }), "bargain")!;
    expect(b).toBe(a);
  });

  it("the hunt still hears more than one phrasing at the same round", () => {
    // The thread axis is what stops twenty-five travellers' agents sending one
    // sentence to every shop. Folding the round in must not collapse it.
    const drawn = new Set(
      Array.from({ length: 40 }, (_, i) =>
        templateFor(ctx({ quoted: 300, round: 0, threadKey: `t@x.com:6681234${1000 + i}` }), "bargain")!
      )
    );
    expect(drawn.size).toBeGreaterThan(1);
  });
});
