import { describe, it, expect } from "vitest";
import { holdsMediaReading, readingFrom } from "./reading";

// THE FIELD REGRESSION, EXECUTED.
//
// A shop sent a price board. The photo rendered in the conversation and the
// agent's reading of it never appeared - on EVERY production turn, because
// production does not run the inline path. The vision Flow reads the image in
// an isolated worker and the continuation composes the reply with `images: []`
// plus the finished extraction, so a stamp gated on "did bytes arrive?" could
// never fire. The string-matching pins all stayed green through it, which is
// precisely why this one runs the predicate instead of reading the source.

/** Exactly what services/workers/src/incoming.worker.ts hands the engine. */
const CONTINUATION_EXTRACTION = {
  found: true,
  pricePerDay: 250,
  currency: "THB",
  imageKind: "price_sheet" as const,
  imageSummary: "Board: CLICK 125cc 250B / 24 hrs, NMAX 350B",
  imageRead: { seen: true },
};

describe("the media stamp fires on the path production actually runs", () => {
  it("THE REGRESSION: a continuation with NO bytes still holds a reading", () => {
    expect(holdsMediaReading(0, CONTINUATION_EXTRACTION)).toBe(true);
  });

  it("...and the reading it produces is the real one, not an empty shell", () => {
    const reading = readingFrom(CONTINUATION_EXTRACTION, { usedPricePerDay: 250 });
    expect(reading.outcome).toBe("read");
    expect(reading.prices.map((p) => p.pricePerDay)).toContain(250);
    expect(reading.text).toMatch(/CLICK 125cc/);
  });

  it("a FAILED read on the same path is still stamped - that is the honest one", () => {
    // "Nobody could look at this photo" is the state a traveller most needs to
    // see; gating it away left them with a silent, unexplained blank.
    const blind = { found: false, imageRead: { seen: false, failure: "rate-limit" } };
    expect(holdsMediaReading(0, blind)).toBe(true);
    expect(readingFrom(blind).outcome).toBe("unavailable");
  });

  it("the inline path (bytes in hand) is unchanged", () => {
    expect(holdsMediaReading(1, undefined)).toBe(true);
    expect(holdsMediaReading(3, { found: false })).toBe(true);
  });

  it("a plain TEXT turn still stamps nothing", () => {
    expect(holdsMediaReading(0, { found: true, pricePerDay: 200 })).toBe(false);
    expect(holdsMediaReading(0, undefined)).toBe(false);
    expect(holdsMediaReading(0, { found: false, imageSummary: "" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the engine asks the shared question, and says so when it cannot answer", () => {
  it("agent-loop gates the stamp on holdsMediaReading, not on images.length", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/turnHoldsMedia\(images\.length, extraction as never\)/);
    expect(loop).not.toMatch(/if \(images\.length > 0 && ctx\.sender\)/);
  });

  it("a stamp that finds no row is an EVENT, not an empty catch", () => {
    expect(readCode("src/lib/agent-loop.ts")).toMatch(/reading-stamp-failed/);
  });

  it("the media route also looks for the worker's frame-indexed audit copy", () => {
    expect(readCode("src/app/api/wa/media/route.ts")).toMatch(/\$\{waMessageId\}-0/);
  });
});

describe("the vision ladder is current and hot-fixable", () => {
  const ai = readCode("src/lib/ai.ts");

  it("retired model ids are gone; the current ones lead", () => {
    expect(ai).toMatch(/qwen\/qwen3\.6-27b/);
    // Gemini pins are GONE entirely: the pinned 3.5-flash id failed live on
    // the owner's key (2026-08-21) while the rolling alias answered, so the
    // default and the vision ladder are aliases only - Google keeps those
    // valid across generations, which is the whole point.
    expect(ai).toMatch(/"gemini-flash-latest"/);
    expect(ai).toMatch(/"gemini-flash-lite-latest"/);
    expect(ai).not.toMatch(/"gemini-3\.5-flash"/);
    expect(ai).not.toMatch(/gemini-3-flash-preview/);
    // Google retired this one - a dead rung is pure wasted latency.
    expect(ai).not.toMatch(/"gemini-2\.0-flash"/);
  });

  it("vision ids are overridable from the Key Vault, like every text id", () => {
    expect(ai).toMatch(/getConfig\("GEMINI_VISION_MODEL"\)/);
    expect(ai).toMatch(/getConfig\("GROQ_VISION_MODEL"\)/);
  });

  it("a long board fits, and the extractor asks the provider for JSON", () => {
    // 2_048 covers ONE dense board; a coalesced burst scales the ceiling with
    // the frame count (owner report 4) so 8 boards cannot be truncated back
    // into the mid-JSON failure the base value fixed. Capped at 6_144.
    expect(ai).toMatch(/const base = Math\.min\(6_144, 2_048 \+ 512 \* Math\.max\(0, frames - 1\)\)/);
    // EVERY rung, not just Gemini's. The Groq rung claimed "same reason as the
    // Gemini ceiling above" over a flat 2_048 - the asymmetry survived because
    // this pin only ever asserted the Gemini formula (owner report 5).
    expect(ai).toMatch(/maxOutputTokens: visionCeiling\(images\.length, raiseCeiling\)/);
    expect(ai).toMatch(/max_tokens: visionCeiling\(images\.length, raiseCeiling\)/);
    expect(ai.match(/visionCeiling\(images\.length, raiseCeiling\)/g)?.length).toBe(3);
    expect(ai).toMatch(/responseMimeType: "application\/json"/);
    expect(ai).toMatch(/response_format: \{ type: "json_object" \}/);
    // W12g: the primary board read now also carries a budget derived from the
    // TURN's remaining wall clock, so the object is spread rather than a bare
    // literal. What matters here is unchanged - the extractor asks for JSON.
    expect(readCode("src/lib/agents.ts")).toMatch(/json: true/);
    expect(readCode("src/lib/agents.ts")).toMatch(/const visionBudget = msLeft/);
  });
});
