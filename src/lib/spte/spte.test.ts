import { describe, it, expect } from "vitest";
import { legalMovesFor, reflexTurn, coerceToLegal } from "./policy";
import { mergeDigest, emptyDigest } from "./digest";
import { runPostRails } from "./rails";
import type { TurnContext, TurnArtifact, VerifiedExtraction } from "./types";

function ctx(partial: Partial<TurnContext> & { verified: VerifiedExtraction }): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: { vehicleClass: "scooter", engineSizeCc: 125, transmission: "any", durationDays: 4, accessories: [], fulfillment: "any", vendorMessage: "" },
      currency: "PHP",
      benchmark: null,
      lowest: null,
      rivals: [],
      ...(partial.session ?? {}),
    },
    thread: {
      threadKey: "u:63",
      vendorId: "v1",
      shop: "Shop A",
      digest: emptyDigest(),
      ...(partial.thread ?? {}),
    },
    tail: [],
    inbound: { text: "", verified: partial.verified },
    legalMoves: [],
    guards: { maxRounds: 4, ...(partial.guards ?? {}) },
    event: "shop-message",
  };
}

describe("SPTE policy rails (legal move computation)", () => {
  it("a live price with rounds left makes bargain legal and FIRST (bargain-first)", () => {
    const c = ctx({ verified: { found: true, pricePerDay: 500, currency: "PHP", askedQuestion: false } });
    const legal = legalMovesFor(c);
    expect(legal[0]).toBe("bargain");
  });

  it("bargain-first: deposit/fulfillment probes are NOT legal while bargain is", () => {
    const c = ctx({ verified: { found: true, pricePerDay: 500 } });
    const legal = legalMovesFor(c);
    expect(legal).toContain("bargain");
    expect(legal).not.toContain("deposit-probe");
    expect(legal).not.toContain("fulfillment-probe");
  });

  it("a first-turn decline owes exactly one farewell then silence (B7 structural)", () => {
    const c = ctx({ verified: { found: false, declined: true } });
    const legal = legalMovesFor(c);
    expect(legal).toEqual(["farewell", "silent"]);
  });

  it("wrong vehicle -> redirect-close on first contact, never bare silence", () => {
    const c = ctx({ verified: { found: false, wrongVehicle: true } });
    const legal = legalMovesFor(c);
    expect(legal).toContain("redirect-close");
    expect(legal).not.toContain("silent");
  });

  // The live Marlin Krabi failure: "Hi! Normal scooters? Some models 200 and
  // some new 250/day" was scored wrong-vehicle, which made redirect-close the
  // ONLY legal move and ended a negotiation the shop was happy to have.
  describe("an UNCLEAR vehicle is not a wrong vehicle", () => {
    it("never terminates the thread", () => {
      const legal = legalMovesFor(
        ctx({ verified: { found: true, pricePerDay: 250, vehicleUnclear: true } })
      );
      expect(legal).not.toContain("redirect-close");
      expect(legal).toContain("bargain");
    });

    it("still terminates on a REAL mismatch", () => {
      const legal = legalMovesFor(
        ctx({ verified: { found: true, pricePerDay: 250, wrongVehicle: true } })
      );
      expect(legal).toEqual(["redirect-close"]);
    });
  });

  describe("a menu is resolved before it is haggled", () => {
    const menu = [
      { key: "tier-200", label: "Cheaper option", pricePerDay: 200, condition: "unknown" as const, photoRefs: [], source: "text" as const, gaps: ["condition" as const, "mileage" as const, "photo" as const] },
      { key: "tier-250", label: "Newer model", pricePerDay: 250, condition: "new" as const, photoRefs: [], source: "text" as const, gaps: ["mileage" as const, "photo" as const] },
    ];

    it("option-probe outranks bargain while the tiers are indistinguishable", () => {
      const legal = legalMovesFor(
        ctx({
          verified: { found: true, pricePerDay: 250 },
          thread: { threadKey: "u:63", vendorId: "v1", shop: "Shop A", digest: { ...emptyDigest(), options: menu } },
        })
      );
      expect(legal.indexOf("option-probe")).toBeLessThan(legal.indexOf("bargain"));
    });

    it("a shop that says the price depends on a choice gets probed, not clarified at", () => {
      const legal = legalMovesFor(ctx({ verified: { found: false, variance: true } }));
      expect(legal[0]).toBe("option-probe");
    });

    it("once every tier is fully known the menu stops blocking the bargain", () => {
      const known = menu.map((o) => ({ ...o, gaps: [] }));
      const legal = legalMovesFor(
        ctx({
          verified: { found: true, pricePerDay: 250 },
          thread: { threadKey: "u:63", vendorId: "v1", shop: "Shop A", digest: { ...emptyDigest(), options: known } },
        })
      );
      expect(legal).not.toContain("option-probe");
      expect(legal[0]).toBe("bargain");
    });
  });

  it("a shop asking our delivery location makes pickup-location legal", () => {
    const c = ctx({ verified: { found: false, askedLocation: true } });
    c.share = { addressText: "Ao Nang Beach Resort, Krabi" };
    expect(legalMovesFor(c)).toContain("pickup-location");
  });

  it("with NO verified stay, pickup-location is not even legal - we never improvise a location", () => {
    const c = ctx({ verified: { found: false, askedLocation: true } });
    expect(legalMovesFor(c)).not.toContain("pickup-location");
    // The shop still gets an answer; it just cannot contain an address.
    expect(legalMovesFor(c).length).toBeGreaterThan(0);
  });

  it("ANSWER precedes bargain when the shop asked a question (issue: ignored questions)", () => {
    // "Closed deal sir 300, free delivery. Around what time?" - price AND a
    // question. The reply must answer first, so answer must lead the ladder.
    const c = ctx({ verified: { found: true, pricePerDay: 300, askedQuestion: true } });
    const legal = legalMovesFor(c);
    expect(legal.indexOf("answer")).toBeLessThan(legal.indexOf("bargain"));
  });

  it("TWO firm refusals retire bargaining and unlock logistics probes", () => {
    const c = ctx({ verified: { found: true, pricePerDay: 300 } });
    c.thread.digest = { ...emptyDigest(), firmCount: 2 };
    const legal = legalMovesFor(c);
    expect(legal).not.toContain("bargain");
    expect(legal).toContain("deposit-probe");
    expect(legal).toContain("fulfillment-probe");
  });

  it("ONE firm refusal still allows a push WITH leverage (cheaper rival)", () => {
    const c = ctx({
      verified: { found: true, pricePerDay: 400 },
      session: {
        sessionId: "s1",
        rfq: { vehicleClass: "scooter", engineSizeCc: 125, transmission: "any", durationDays: 4, accessories: [], fulfillment: "any", vendorMessage: "" },
        currency: "PHP",
        benchmark: null,
        lowest: null,
        rivals: [{ vendorId: "v2", shop: "Shop B", pricePerDay: 300, currency: "PHP" }],
      },
    });
    c.thread.digest = { ...emptyDigest(), firmCount: 1 };
    expect(legalMovesFor(c)).toContain("bargain");
  });

  it("ONE firm refusal WITHOUT leverage retires bargaining (price near floor, no rival)", () => {
    const c = ctx({ verified: { found: true, pricePerDay: 300 }, guards: { maxRounds: 6, floorPerDay: 290 } });
    c.thread.digest = { ...emptyDigest(), firmCount: 1 };
    const legal = legalMovesFor(c);
    expect(legal).not.toContain("bargain");
    expect(legal).toContain("deposit-probe");
  });

  it("deposit + fulfillment known + price -> step 7: recap first, present only after the shop confirms", () => {
    const c = ctx({ verified: { found: true, pricePerDay: 300 } });
    c.thread.digest = { ...emptyDigest(), firmCount: 2, depositKnown: true, fulfillmentKnown: true, quotedPricePerDay: 300 };
    // A complete deal goes to the SHOP for confirmation first...
    expect(legalMovesFor(c)).toContain("verify-recap");
    expect(legalMovesFor(c)).not.toContain("present");
    // ...the recap never repeats (the once latch)...
    c.thread.digest.recapSent = true;
    expect(legalMovesFor(c)).not.toContain("verify-recap");
    // ...and once the shop confirmed it, `present` (state-only) becomes legal.
    c.thread.digest.recapConfirmedAt = 1_700_000_000_000;
    expect(legalMovesFor(c)).toContain("present");
    // Presented once, it never re-marks.
    c.thread.presented = true;
    expect(legalMovesFor(c)).not.toContain("present");
  });
});

describe("SPTE reflex tier (0-token)", () => {
  it("a lone silent legal move resolves reflexively, no LLM", () => {
    // A declined thread that already sent its goodbye owes only silence.
    const c = ctx({ verified: { found: false, declined: true } });
    c.thread.digest = {
      ...emptyDigest(),
      facts: ["closed - one goodbye sent"],
      // The STRUCTURED flag (K5): hasClosed() no longer greps prose. Rows
      // written before the flag migrate via digestFromStored's exact-match
      // (covered in durable-memory.test.ts) - a hand-built digest states it.
      comprehension: { closed: true },
    };
    c.legalMoves = legalMovesFor(c); // -> ['silent']
    expect(c.legalMoves).toEqual(["silent"]);
    expect(reflexTurn(c)?.move).toBe("silent");
  });
  it("a composable move set does NOT reflex (needs the single pass)", () => {
    const c = ctx({ verified: { found: true, pricePerDay: 500 } });
    c.legalMoves = legalMovesFor(c);
    expect(reflexTurn(c)).toBeNull();
  });
});

describe("SPTE move coercion (the B7 lesson generalized)", () => {
  it("an out-of-set LLM move is coerced to the top legal move", () => {
    const artifact = { move: "present" } as TurnArtifact;
    expect(coerceToLegal(artifact, ["farewell", "silent"])).toBe("farewell");
  });
  it("a legal LLM move is kept", () => {
    const artifact = { move: "bargain" } as TurnArtifact;
    expect(coerceToLegal(artifact, ["bargain", "answer"])).toBe("bargain");
  });
});

describe("SPTE post-rails (deterministic number + protocol integrity)", () => {
  const base = ctx({ verified: { found: true, pricePerDay: 500, currency: "PHP" } });

  it("rejects a fabricated rival price (anti-hallucination)", () => {
    const a = { move: "bargain", message: "Another shop offered 200, can you match?", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    const r = runPostRails({ ...base, session: { ...base.session, rivals: [] }, guards: { maxRounds: 4, floorPerDay: 300 } }, a);
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("fabricated-rival");
  });

  it("rejects an ask below the market floor", () => {
    const a = { move: "bargain", message: "Can you do 100 per day?", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    const r = runPostRails({ ...base, guards: { maxRounds: 4, floorPerDay: 300 } }, a);
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("below-floor");
  });

  // A shop asking "where are you staying?" is answered on the PRIMARY engine
  // now, and only ever with what the consent gate resolved.
  describe("location integrity (the one disclosure gate)", () => {
    const stay = { addressText: "Ao Nang Beach Resort, Krabi" };
    const share = (message: string, s: TurnContext["share"] = stay) =>
      runPostRails({ ...base, share: s }, {
        move: "pickup-location",
        message,
        leverageUsed: [],
        digestPatch: [],
        read: { intent: "" },
        think: "",
      } as TurnArtifact);

    it("passes a draft that carries the verified address verbatim", () => {
      const r = share("I'm at Ao Nang Beach Resort, Krabi - can you deliver there?");
      expect(r.ok).toBe(true);
    });

    it("rejects a paraphrased address (a nearby landmark is not our address)", () => {
      const r = share("I'm near the beach in Ao Nang - can you deliver?");
      expect(r.ok).toBe(false);
      expect(r.rejected?.rule).toBe("location");
    });

    it("rejects a maps link we did not approve", () => {
      const r = share("I'm at Ao Nang Beach Resort, Krabi (https://evil.example/x)");
      expect(r.ok).toBe(false);
      expect(r.rejected?.rule).toBe("location");
    });

    it("keeps the approved maps link when consent produced one", () => {
      const link = "https://maps.google.com/?q=8.032000,98.822000";
      const r = share(`I'm at Ao Nang Beach Resort, Krabi (${link})`, {
        ...stay,
        mapsLink: link,
      });
      expect(r.ok).toBe(true);
      expect(r.finalText).toContain(link);
    });

    it("rejects raw coordinates - those are never ours to write", () => {
      const r = share("I'm at Ao Nang Beach Resort, Krabi - 8.032000, 98.822000");
      expect(r.ok).toBe(false);
      expect(r.rejected?.rule).toBe("location");
    });
  });

  it("passes a clean bargain and never finalizes a time", () => {
    const a = { move: "bargain", message: "Thanks! Any chance you can do 400 for 4 days?", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    const r = runPostRails({ ...base, guards: { maxRounds: 4, floorPerDay: 300 } }, a);
    expect(r.ok).toBe(true);
    expect(r.finalText).toContain("400");
  });

  // The live failure: two offers existed (250 and 300) and the 300 shop was
  // never told about the 250. The rail only ever backed rivals[0], so a draft
  // citing any OTHER real rival was thrown away for a rival-free template.
  it("backs EVERY real rival the prompt showed, not just the cheapest", () => {
    const withRivals = {
      ...base,
      session: {
        ...base.session,
        rivals: [
          { vendorId: "v2", shop: "Marlin", pricePerDay: 250, currency: "PHP" },
          { vendorId: "v3", shop: "Sak", pricePerDay: 280, currency: "PHP" },
        ],
      },
      guards: { maxRounds: 4, floorPerDay: 200 },
    };
    const a = { move: "bargain", message: "Another shop quoted me 280 - can you beat it?", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    expect(runPostRails(withRivals, a).ok).toBe(true);
  });

  it("still rejects a rival number that matches NO real offer", () => {
    const withRivals = {
      ...base,
      session: {
        ...base.session,
        rivals: [{ vendorId: "v2", shop: "Marlin", pricePerDay: 250, currency: "PHP" }],
      },
      guards: { maxRounds: 4, floorPerDay: 200 },
    };
    const a = { move: "bargain", message: "Another shop quoted me 210 - can you beat it?", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    expect(runPostRails(withRivals, a).ok).toBe(false);
  });

  // "Your board says 300, can you do 250?" is a legitimate ask, not an inverted
  // one - the shop posted the 300 itself.
  it("lets the shop's own posted board price be quoted back", () => {
    const withSheet = {
      ...base,
      inbound: { text: "", verified: { found: true, pricePerDay: 250, currency: "PHP", sheetPricePerDay: 300 } },
      guards: { maxRounds: 4, floorPerDay: 200 },
    };
    const a = { move: "bargain", message: "Your list says 300 - any chance of 240 for 4 days?", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    expect(runPostRails(withSheet, a).ok).toBe(true);
  });

  it("strips a concrete time commitment and appends the defer line", () => {
    const a = { move: "closing-message", message: "Great, see you tomorrow at 9am!", leverageUsed: [], digestPatch: [], read: { intent: "" }, think: "" } as TurnArtifact;
    const r = runPostRails(base, a);
    expect(r.ok).toBe(true);
    expect(r.finalText).toMatch(/confirm the exact time/i);
    expect(r.finalText).not.toMatch(/9am/);
  });
});

describe("SPTE digest merge (memory consolidation)", () => {
  it("banks a verified quote deterministically and bumps round on bargain", () => {
    const a = { move: "bargain", digestPatch: ["shop is friendly"], leverageUsed: [], read: { intent: "" }, think: "" } as TurnArtifact;
    const d = mergeDigest(emptyDigest(), a, { found: true, pricePerDay: 450, currency: "PHP" });
    expect(d.quotedPricePerDay).toBe(450);
    expect(d.round).toBe(1);
    expect(d.facts.some((f) => /450/.test(f))).toBe(true);
    expect(d.facts).toContain("shop is friendly");
  });
  it("caps durable facts and evicts oldest", () => {
    let d = emptyDigest();
    const a = (f: string) => ({ move: "answer", digestPatch: [f], leverageUsed: [], read: { intent: "" }, think: "" }) as TurnArtifact;
    for (let i = 0; i < 15; i++) d = mergeDigest(d, a(`fact ${i}`), { found: false });
    expect(d.facts.length).toBeLessThanOrEqual(10);
    expect(d.facts).not.toContain("fact 0");
    expect(d.facts).toContain("fact 14");
  });
});
