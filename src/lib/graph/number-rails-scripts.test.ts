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
