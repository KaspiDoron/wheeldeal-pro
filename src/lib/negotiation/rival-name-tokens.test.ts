// AUDIT F074 - the rival-disclosure rail must not reject a draft over an
// ordinary word that happens to sit in a rival shop's name.
//
// `rivalIdentityTokens` emitted every >=4-character non-GENERIC word of a
// rival's name as a rejection token, and GENERIC covered vehicle/shop nouns
// only. So a hunt that contained "Best Price Rental" refused every draft with
// "best" or "price" in it - including the deterministic templates the ladder
// falls back to - and "7 Days Rental" refused every draft that said "days".
// The thread went mute for the rest of the hunt.
//
// The fix is identity-shaped tokens: a multi-word name matches as a PHRASE,
// and a single word of it is a token only when it is distinctive - not a word
// the engine's own outbound copy uses. The drift guarantee at the bottom runs
// the REAL templates and reflexes and fails the moment a template word is
// missing from that vocabulary, so the list cannot rot silently.
import { describe, it, expect } from "vitest";
import { rivalIdentityTokens, namesRival } from "./leverage";
import type { MoveKind, ThreadDigest, TurnContext, VerifiedExtraction } from "../spte/types";
import { emptyDigest } from "../spte/digest";
import { fallbackArtifact, templateFor } from "../spte/pass";
import { reflexTurn } from "../spte/policy";
import { runPostRails } from "../spte/rails";

function ctx(p: {
  threadKey?: string;
  quoted?: number;
  rivals?: Array<{ pricePerDay: number; shop: string }>;
  verified?: Partial<VerifiedExtraction>;
  digest?: Partial<ThreadDigest>;
  legalMoves?: MoveKind[];
  floorPerDay?: number;
}): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: {
        vehicleClass: "scooter",
        engineSizeCc: 125,
        transmission: "automatic",
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
        shop: r.shop,
        pricePerDay: r.pricePerDay,
        currency: "THB",
      })),
    },
    thread: {
      threadKey: p.threadKey ?? "t@x.com:66812345678",
      vendorId: "v1",
      shop: "This Shop",
      digest: { ...emptyDigest(), quotedPricePerDay: p.quoted, ...p.digest },
    },
    tail: [],
    inbound: {
      text: p.quoted ? `${p.quoted} per day` : "how many days?",
      verified: {
        found: Boolean(p.quoted),
        pricePerDay: p.quoted,
        currency: "THB",
        ...p.verified,
      },
    },
    legalMoves: p.legalMoves ?? ["bargain"],
    guards: { maxRounds: 4, floorPerDay: p.floorPerDay },
    event: "shop-message",
  };
}

describe("EXECUTED: a rival named with the engine's own words does not mute the thread", () => {
  it('"Best Price Rental" does not reject "what would your best price per day be?"', () => {
    const tokens = rivalIdentityTokens(["Best Price Rental"]);
    expect(tokens).not.toContain("best");
    expect(tokens).not.toContain("price");
    expect(namesRival("Could you share your best price for 5 days?", tokens)).toBeNull();
    expect(namesRival("What would your best price per day be?", tokens)).toBeNull();
  });

  it('"7 Days Rental" does not reject "...for 5 days?"', () => {
    const tokens = rivalIdentityTokens(["7 Days Rental"]);
    expect(tokens).not.toContain("days");
    expect(namesRival("Could you do 190/day for 5 days?", tokens)).toBeNull();
  });

  it("...while the NAME itself, written out, is still a disclosure", () => {
    const tokens = rivalIdentityTokens(["Best Price Rental"]);
    expect(namesRival("Best Price Rental quoted me 200", tokens)).toBeTruthy();
    // Punctuation between the words does not hide the name.
    expect(namesRival("best-price rental has it at 200", tokens)).toBeTruthy();
  });

  it("a genuinely distinctive word still rejects on its own", () => {
    const tokens = rivalIdentityTokens(["Marlin Krabi Motorbike Rental", "Joh's Matics", "Sunrise Bikes"]);
    expect(namesRival("Another shop, Marlin, quoted me 250", tokens)).toBe("marlin");
    expect(namesRival("I saw 250 at Matics", tokens)).toBe("matics");
    expect(namesRival("the sunrise is at 6am", tokens)).toBe("sunrise");
    expect(namesRival("sunrisers are nice", tokens)).toBeNull();
  });

  it("a name made only of generic nouns has no identity to leak", () => {
    expect(rivalIdentityTokens(["Scooter Rental"])).toEqual([]);
    expect(rivalIdentityTokens(["Scooter"])).toEqual([]);
  });

  it('a name made only of our own words, with no shop noun, cannot become a phrase: "Best Price"', () => {
    // The phrase of this name IS the bargain ask. A phrase token for it would
    // mute the thread exactly as the single word "best" did, one word longer.
    const tokens = rivalIdentityTokens(["Best Price"]);
    expect(tokens).toEqual([]);
    expect(namesRival("Could you share your best price for 5 days?", tokens)).toBeNull();
  });

  it("a deictic plus a shop noun is how WE point at a rival - never an identity", () => {
    // The golden coherence seed "a real rival licenses the push" names its
    // synthetic rival "Another shop", and the rival-cite template says exactly
    // that phrase - so the anchored rule muted the bargain it was replaying.
    expect(rivalIdentityTokens(["Another shop"])).toEqual([]);
    expect(rivalIdentityTokens(["A nearby place"])).toEqual([]);
    const t = rivalIdentityTokens(["Another shop"]);
    expect(namesRival("Another shop offered 220/day - could you do 210?", t)).toBeNull();
    // ...and a real name that merely STARTS with one still is an identity.
    expect(rivalIdentityTokens(["Another Marlin Rental"])).toContain("marlin");
  });

  it("...but a shop noun anchors ordinary words into a phrase no template says", () => {
    expect(rivalIdentityTokens(["Best Price Rental"])).toEqual(["best price rental"]);
    // A digit-bearing word is ordinary (prices, day-counts and "125cc" are in
    // every line), so it is never a token on its own - the anchored phrase is
    // what catches the name.
    const a1 = rivalIdentityTokens(["A1 Rental"]);
    expect(a1).toEqual(["a1 rental"]);
    expect(namesRival("A1 Rental has it at 200", a1)).toBe("a1 rental");
    expect(namesRival("Could you do 190/day for 5 days?", a1)).toBeNull();
  });
});

describe("EXECUTED end to end: the deterministic ask survives its own rails", () => {
  it("the refuter's reproduction - no price yet, a rival called Best Price Rental", () => {
    const c = ctx({ rivals: [{ pricePerDay: 250, shop: "Best Price Rental" }] });
    const fb = fallbackArtifact(c);
    expect(fb.move).toBe("bargain");
    expect(fb.message).toMatch(/best (price|rate)/i);
    const rail = runPostRails(c, fb);
    expect(rail.rejected?.rule, rail.rejected?.detail).not.toBe("rival-disclosure");
    expect(rail.ok).toBe(true);
  });

  it('"Best Price" - the two-word name whose phrase is the bargain ask itself', () => {
    const c = ctx({ rivals: [{ pricePerDay: 250, shop: "Best Price" }] });
    const fb = fallbackArtifact(c);
    expect(fb.message).toMatch(/best price/i);
    const rail = runPostRails(c, fb);
    expect(rail.rejected?.rule, rail.rejected?.detail).not.toBe("rival-disclosure");
    expect(rail.ok).toBe(true);
  });

  it('"7 Days Rental" - the rival-cite bargain template names the duration', () => {
    const c = ctx({
      quoted: 300,
      floorPerDay: 150,
      rivals: [{ pricePerDay: 200, shop: "7 Days Rental" }],
    });
    const fb = fallbackArtifact(c);
    expect(fb.message).toMatch(/5 days/);
    const rail = runPostRails(c, fb);
    expect(rail.rejected?.rule, rail.rejected?.detail).not.toBe("rival-disclosure");
    expect(rail.ok).toBe(true);
  });

  it("the guarantee is intact: a draft that names the rival is still refused", () => {
    const c = ctx({ quoted: 300, floorPerDay: 150, rivals: [{ pricePerDay: 200, shop: "Marlin Rental" }] });
    const rail = runPostRails(c, {
      read: { intent: "" },
      think: "",
      move: "bargain",
      message: "Marlin offered 200/day - could you do 190/day for 5 days?",
      leverageUsed: [],
      digestPatch: [],
    });
    expect(rail.ok).toBe(false);
    expect(rail.rejected?.rule).toBe("rival-disclosure");
  });
});

// ---------------------------------------------------------------------------
// THE DRIFT GUARANTEE. The vocabulary list beside GENERIC is hand-maintained,
// and a hand-maintained list rots the moment a template is edited. This runs
// every template family and every reflex line the engine can emit and asserts
// that no word of them can become a rejection token: edit a template to say
// "cheapest" and this fails until "cheapest" joins the vocabulary.
// ---------------------------------------------------------------------------

const MOVES: MoveKind[] = [
  "bargain",
  "confirm-vehicle",
  "option-probe",
  "clarify",
  "redirect-close",
  "graceful-close",
  "confirm",
  "farewell",
  "answer",
  "deposit-probe",
  "restock-probe",
  "fulfillment-probe",
  "momentum",
  "verify-recap",
];

function corpus(): string[] {
  const out = new Set<string>();
  const keys = Array.from({ length: 12 }, (_, i) => `u${i}@x.com:6681234${i}`);
  const complete: Partial<ThreadDigest> = {
    quotedPricePerDay: 250,
    firmCount: 2,
    depositKnown: true,
    fulfillmentKnown: true,
    comprehension: { depositKind: "document", handoverMode: "delivery" },
  };
  const shapes: Array<Parameters<typeof ctx>[0]> = [
    {},
    { quoted: 300, floorPerDay: 150 },
    { quoted: 300, floorPerDay: 150, rivals: [{ pricePerDay: 200, shop: "Rival One" }] },
    { quoted: 250, digest: complete },
    { quoted: 250, digest: { quotedPricePerDay: 250, firmCount: 2 } },
    { verified: { askedQuestion: true, askedLicense: true }, legalMoves: ["answer"] },
    { verified: { askedQuestion: true, askedLicensePhoto: true }, legalMoves: ["answer"] },
    {
      verified: {
        options: [
          { label: "Click 125", pricePerDay: 250 },
          { label: "PCX 160", pricePerDay: 350 },
        ] as unknown as VerifiedExtraction["options"],
      },
    },
  ];
  for (const key of keys) {
    for (const shape of shapes) {
      const c = ctx({ ...shape, threadKey: key });
      for (const m of MOVES) {
        const t = templateFor(c, m);
        if (t) out.add(t);
      }
      const r = reflexTurn(c);
      if (r?.message) out.add(r.message);
    }
  }
  return [...out];
}

describe("the vocabulary cannot drift: every word the engine says is safe in a rival's name", () => {
  const lines = corpus();

  it("the corpus is real (templates and reflexes were actually composed)", () => {
    expect(lines.length).toBeGreaterThan(15);
    expect(lines.some((l) => /best price/i.test(l))).toBe(true);
    expect(lines.some((l) => /driving licen[cs]e/i.test(l))).toBe(true);
  });

  it("no word of any template or reflex line can become a rejection token", () => {
    const offenders = new Set<string>();
    for (const line of lines) {
      const words = line.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      for (const w of new Set(words)) {
        const tokens = rivalIdentityTokens([`${w} Rental`, `Krabi ${w} Motorbike`]);
        if (namesRival(line, tokens)) offenders.add(w);
      }
    }
    expect([...offenders].sort(), "add these words to OUTBOUND_VOCABULARY in leverage.ts").toEqual([]);
  });
});
