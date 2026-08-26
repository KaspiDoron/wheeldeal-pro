import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkOutboundNumbers,
  correctDuration,
  citedDurationDays,
  verbatimNumerals,
  extractPriceNumbers,
} from "./guardrails";
import { citedDurationDays as promiseDuration } from "../wa/rental-params";
import { normalizeDigits } from "../integrity/translation";
import { extractQuotedPrices } from "../wa/price-extract";
import { scanRates } from "../wa/rate-expr";

// OWNER REPORT 11, B1 - THE NUMBER RAILS COULD NOT READ THE MESSAGE THEY GUARD.
//
// `graph/guardrails.ts` carried its OWN `normalizeDigits`, folding four digit
// scripts, while `integrity/translation.ts` folded eighteen. Owner report 8.1 F4
// had already found this exact bug class once - in `citedRival` - and fixed it by
// wiring the 18-script fold into `spte/*`. It never reached here, so
// `spte/rails.ts` imported BOTH: the wide fold on line 15 for cite-the-rival, the
// narrow one on line 9 for checkOutboundNumbers, correctDuration and
// verbatimNumerals. One file, two strengths of the same rule.
//
// It failed OPEN. On a message localized into Lao, Khmer or Myanmar - three
// markets this app has gated business hours for since owner report 8 wave D -
// `extractPriceNumbers` returned [], `.find()` returned undefined, and the
// provenance rail passed vacuously. A price the shop never said reached a real
// business in the traveller's name, with the guarantee reporting green.
//
// The reason ten audit rounds could not see it is mechanical and is pinned
// separately (source-bytes.test.ts): the file contained raw control bytes, so
// grep, ripgrep and `git diff` all treated it as binary and skipped it.
//
// THESE TESTS FAIL IF THE NARROW FOLD COMES BACK. Revert guardrails.ts to its
// own four-script NON_LATIN_DIGITS and every "rejects" case below goes green->red.

/** Rewrite the ASCII digits of `s` into another script's digits. */
const inScript = (s: string, base: number) =>
  s.replace(/[0-9]/g, (d) => String.fromCodePoint(base + Number(d)));

/** The scripts a WhatsApp negotiation in this app's markets actually meets. */
const SCRIPTS: [string, number][] = [
  ["ASCII", 0x0030],
  ["Thai", 0x0e50],
  ["Lao", 0x0ed0],
  ["Khmer", 0x17e0],
  ["Myanmar", 0x1040],
  ["Bengali", 0x09e6],
  ["Devanagari", 0x0966],
  ["Arabic-Indic", 0x0660],
  ["Fullwidth", 0xff10],
];

describe("the provenance rail reads every script, and still fails closed", () => {
  it.each(SCRIPTS)("REJECTS an invented price written in %s numerals", (_name, base) => {
    // The thread holds 250. The model writes 180 - a number no shop ever said.
    const r = checkOutboundNumbers({
      text: `Could you do ${inScript("180", base)} per day for the 4 days?`,
      grounded: [250],
      durationDays: 4,
      checkAskBounds: false,
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("ungrounded-number");
  });

  it.each(SCRIPTS)("ACCEPTS a grounded price written in %s numerals", (_name, base) => {
    // The negative control, and it is the important half: a rail that rejects
    // everything would satisfy the test above and destroy every localized send.
    const r = checkOutboundNumbers({
      text: `Could you do ${inScript("250", base)} per day for the 4 days?`,
      grounded: [250],
      durationDays: 4,
      checkAskBounds: false,
    });
    expect(r.ok).toBe(true);
  });
});

describe("the ask-bounds rail reads every script", () => {
  it.each(SCRIPTS)("REJECTS an ask ABOVE the shop's own price in %s numerals", (_name, base) => {
    // An offer of 900 against a live quote of 300 - the inverted-ask class this
    // rail exists for. Blind, it read as "numbers within [floor, quote]".
    const r = checkOutboundNumbers({
      text: `can you do ${inScript("900", base)} per day?`,
      floor: 200,
      ceiling: 300,
      checkAskBounds: true,
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("above-quote");
  });
});

describe("the duration rail both SEES and REPAIRS a wrong rental length", () => {
  it.each(SCRIPTS)("detects a 7-day claim written in %s numerals", (_name, base) => {
    const text = `for the ${inScript("7", base)} days`;
    expect(citedDurationDays(text)).toEqual([7]);
    // ...and the promise reader, which folded NOTHING at all before this - a
    // third strength of the same rule.
    expect(promiseDuration(text)).toBe(7);
  });

  it.each(SCRIPTS)("rewrites 7 -> 4 in %s while leaving the PRICE's script alone", (_name, base) => {
    const price = inScript("250", base);
    const out = correctDuration(`could you do ${price}/day for the ${inScript("7", base)} days?`, 4);
    expect(out.changed).toBe(true);
    expect(out.from).toEqual([7]);
    expect(out.text).toContain("4 days");
    // The repair splices the original string, so the price is untouched. Folding
    // the whole message would silently switch its numerals to ASCII mid-send.
    expect(out.text).toContain(price);
  });

  it.each(SCRIPTS)("leaves a CORRECT duration alone in %s", (_name, base) => {
    const text = `for the ${inScript("4", base)} days`;
    const out = correctDuration(text, 4);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text);
  });
});

describe("grounding is built from local-script inbound too", () => {
  it.each(SCRIPTS)("a shop quoting 250 in %s numerals grounds the thread", (_name, base) => {
    // The compounding half: a local-script inbound used to contribute NOTHING to
    // what the thread was known to hold, so grounding got weaker for every later
    // turn in that conversation.
    expect(verbatimNumerals([inScript("our price is 250 per day", base)])).toEqual([250]);
    expect(extractPriceNumbers(inScript("250 per day", base))).toContain(250);
  });
});

describe("the invariant the duration repair rests on", () => {
  it("normalizeDigits is a 1:1 code-point map, so folded and original share indices", () => {
    // `correctDuration` matches on the folded text and splices the ORIGINAL by
    // index. That is only sound while the fold never changes the length -
    // including for surrogate pairs, which must pass through untouched.
    for (const s of [
      "for the ៧ days",
      "๗ วัน 250฿",
      "🛵 ໒໕໐/day 🇹🇭",
      "𝟟 days", // astral-plane mathematical digit: NOT folded, must survive
      "",
      "no digits here",
    ]) {
      expect(normalizeDigits(s).length, JSON.stringify(s)).toBe(s.length);
    }
  });

  it("there is exactly ONE digit fold left in the codebase", () => {
    // The defect was two implementations of one rule at different strengths.
    // guardrails.ts must import it, never redefine it.
    const g = readFileSync("src/lib/graph/guardrails.ts", "utf8");
    expect(g).toMatch(/import \{ normalizeDigits \} from "\.\.\/integrity\/translation"/);
    expect(g, "guardrails must not keep a second fold").not.toMatch(
      /export function normalizeDigits/
    );
    expect(g).not.toMatch(/NON_LATIN_DIGITS/);
    const rp = readFileSync("src/lib/wa/rental-params.ts", "utf8");
    expect(rp).toMatch(/import \{ normalizeDigits \} from "\.\.\/integrity\/translation"/);
  });

  it("the fold really does cover the markets this app gates business hours for", () => {
    // 855 Cambodia, 856 Laos, 95 Myanmar - added in owner report 8 wave D. If a
    // market is supported by the clock gate it must be readable by the rails.
    for (const [name, base] of [
      ["Khmer", 0x17e0],
      ["Lao", 0x0ed0],
      ["Myanmar", 0x1040],
    ] as const) {
      expect(normalizeDigits(inScript("250", base)), name).toBe("250");
    }
  });
});

// ---------------------------------------------------------------------------
// THE INBOUND HALF. Fixing the outbound rails exposed the same root cause one
// layer earlier: the app could not READ a price the shop wrote in its own
// numerals either. Every pattern in price-extract, rate-expr and rate-ladder is
// built on \d, which is ASCII-only.
//
// This repo has already documented where that ends, in owner report 6's
// starvation chain: no deterministic price hit -> no usablePrice -> no
// vendor_replies.price -> no offers row -> found=false -> no quotedPricePerDay
// -> the card renders "No price yet" while the shop is looking at the price it
// just sent. That is the exact complaint the owner photographed twice.
//
// The fold goes in the PRIMITIVES, not their callers. scanRates alone has three
// callers, and a guard each caller must remember is precisely the shape that let
// the outbound rails ship blind.
// ---------------------------------------------------------------------------
describe("the app reads a price the shop wrote in its own numerals", () => {
  it.each(SCRIPTS)("a plain daily quote in %s", (_name, base) => {
    const r = extractQuotedPrices(inScript("250 baht per day", base), { durationDays: 4 });
    expect(r.offer?.pricePerDay).toBe(250);
    expect(r.offer?.currency).toBe("THB");
  });

  it.each(SCRIPTS)("a PACKAGE price in %s still divides out to a daily rate", (_name, base) => {
    // "900 for 4 days" -> 225/day. The arithmetic runs on the folded digits, so
    // a package quote in local script must land on the same number as ASCII.
    const r = extractQuotedPrices(inScript("900 baht for 4 days", base), { durationDays: 4 });
    expect(r.offer?.pricePerDay).toBe(225);
  });

  it.each(SCRIPTS)("a cc tier list in %s parses to the same offers as ASCII", (_name, base) => {
    const ascii = extractQuotedPrices("4/Days 110cc 220 125cc 270 155cc 350", {
      durationDays: 4,
      engineSizeCc: 125,
    });
    const local = extractQuotedPrices(inScript("4/Days 110cc 220 125cc 270 155cc 350", base), {
      durationDays: 4,
      engineSizeCc: 125,
    });
    // Parity is the assertion, not a specific count: whatever ASCII does with a
    // tier list, local script must do identically.
    expect(local.allOffers.length).toBe(ascii.allOffers.length);
    expect(local.offer?.pricePerDay).toBe(ascii.offer?.pricePerDay);
  });

  it.each(SCRIPTS)("scanRates - the shared primitive - reads %s", (_name, base) => {
    // Fixed in the primitive because it has three callers (price-extract x3 and
    // vehicle/resolution), and one of them forgetting is how this class recurs.
    const rates = scanRates(inScript("250 baht per day", base));
    expect(rates.length).toBeGreaterThan(0);
    expect(rates[0].amount).toBe(250);
  });

  it("the shop's ORIGINAL text is never mutated - folding is for reading only", () => {
    // The transcript must still show what the shop actually wrote. The fold
    // happens on a local copy inside the reader; nothing writes it back.
    const original = inScript("250 baht per day", 0x0e50);
    extractQuotedPrices(original, { durationDays: 4 });
    expect(original).toBe(inScript("250 baht per day", 0x0e50));
    expect(original).not.toContain("250");
  });
});

// ---------------------------------------------------------------------------
// THE GUARD AGAINST MY OWN FIX. Folding digits makes MORE text match, so the
// risk it introduces is the opposite of the bug it fixes: a phone number, plate,
// address or odometer reading in local numerals now being read as a price.
//
// The claim is PARITY, not "extracts nothing": whatever the extractor decides
// about a sentence in ASCII, it must decide identically in every other script.
// Folding may only change whether a number is VISIBLE, never whether it is a
// price. Anything else is a regression dressed as a fix.
// ---------------------------------------------------------------------------
describe("folding did not loosen the extractor", () => {
  const NOT_PRICES = [
    "call me on 0812345678",
    "our address is 45/12 Moo 3",
    "open 08:30 to 20:00",
    "we have 125cc and 155cc",
    "sorry we are closed 2 days",
    "the year 2026 model",
    "45,000 km on it",
  ];

  it.each(SCRIPTS)("non-price numbers stay non-prices in %s", (_name, base) => {
    for (const sentence of NOT_PRICES) {
      const ascii = extractQuotedPrices(sentence, { durationDays: 4 });
      const local = extractQuotedPrices(inScript(sentence, base), { durationDays: 4 });
      expect(local.offer?.pricePerDay ?? null, `${sentence} in script ${base}`).toBe(
        ascii.offer?.pricePerDay ?? null
      );
    }
  });

  it("a real price is still found - the control that keeps the block above honest", () => {
    // Without this, "extracts nothing everywhere" would satisfy every assertion.
    expect(extractQuotedPrices("250 baht per day", { durationDays: 4 }).offer?.pricePerDay).toBe(
      250
    );
  });
});
