import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { similarity, isRepetitive } from "./similarity";

// THE REPETITION GUARD WAS COMPARING TWO DIFFERENT LANGUAGES.
//
// `spte/pass.ts` checks the model's draft against the thread's prior outbound
// messages and discards a near-duplicate - "a repeated line reads as a bot" is
// the whole point. But the draft is ENGLISH (localization happens later, in
// live.ts, after the pass has returned) while `priorOutbound` was built from
// `m.body`, the LOCALIZED wire text. So on a Thai thread the guard compared an
// English draft against Thai and found nothing in common, whatever the two
// messages actually said.
//
// The fix is one field: the same send that localized the message stamps its
// English gloss on the row as `raw.englishGloss`. `priorInbound` had done
// exactly this for turns, and said why; the outbound half had not.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("EXECUTED: the tokenizer cannot compare across scripts", () => {
  // `similarity.ts` strips every codepoint outside [a-z0-9\s] - ASCII-only
  // class, no `u` flag - so non-Latin script is DELETED, not preserved.

  it("an English draft against a Thai prior scores 0 - a real repeat passes", () => {
    const draft = "Thanks! Any chance you can do a bit better for 5 days?";
    const thaiSameMessage = "ขอบคุณ! พอจะลดราคาให้ได้ไหมสำหรับ 5 วัน";
    expect(similarity(draft, thaiSameMessage)).toBe(0);
    // ...so the guard waves through a message that says the same thing.
    expect(isRepetitive(draft, [thaiSameMessage])).toBe(false);
  });

  it("...and two DIFFERENT Thai lines can score 1.0, suppressing a good reply", () => {
    // The other failure direction, and the one a reviewer disproved the old
    // spec with: whatever Latin residue survives is the entire token set.
    const a = "ราคา 320/day";
    const b = "ราคา 280/day";
    expect(similarity(a, b)).toBe(1);
    expect(isRepetitive(a, [b])).toBe(true);
  });

  it("in ENGLISH - the units the guard is actually written in - it works", () => {
    const draft = "Thanks! Any chance you can do a bit better for 5 days?";
    const priorGloss = "Thanks! Any chance you could do a bit better for 5 days?";
    expect(similarity(draft, priorGloss)).toBeGreaterThanOrEqual(0.75);
    expect(isRepetitive(draft, [priorGloss])).toBe(true);
    // ...and a genuinely different message still passes.
    expect(isRepetitive("Do you deliver to the hotel?", [priorGloss])).toBe(false);
  });
});

describe("EXECUTED: the row carries the gloss, so the guard sees English", () => {
  // The exact projection both engines now perform, run over rows shaped the
  // way the DB returns them.
  const project = (rows: Array<{ body: string | null; raw: Record<string, unknown> | null }>) =>
    rows
      .map((m) => (m.raw as { englishGloss?: string } | null)?.englishGloss ?? m.body ?? "")
      .filter(Boolean);

  it("prefers the gloss when the send localized the message", () => {
    expect(
      project([{ body: "ขอบคุณ! ลดได้ไหม", raw: { englishGloss: "Thanks! Can you go lower?" } }])
    ).toEqual(["Thanks! Can you go lower?"]);
  });

  it("falls back to the body on an English thread - unchanged behaviour", () => {
    expect(project([{ body: "Thanks! Can you go lower?", raw: { localized: false } }])).toEqual([
      "Thanks! Can you go lower?",
    ]);
    expect(project([{ body: "Hi", raw: null }])).toEqual(["Hi"]);
  });

  it("drops empties, so the list stays what the guard expects", () => {
    expect(project([{ body: "", raw: null }, { body: null, raw: {} }])).toEqual([]);
  });

  it("END TO END: a localized repeat is now caught", () => {
    const priorRows = [
      { body: "ขอบคุณ! พอจะลดราคาให้ได้ไหมสำหรับ 5 วัน", raw: { englishGloss: "Thanks! Any chance you could do a bit better for 5 days?" } },
    ];
    const draft = "Thanks! Any chance you can do a bit better for 5 days?";
    // Before: the guard saw the Thai body and scored 0.
    expect(isRepetitive(draft, priorRows.map((m) => m.body))).toBe(false);
    // After: it sees the gloss and catches it.
    expect(isRepetitive(draft, project(priorRows))).toBe(true);
  });
});

describe("both engines build the list the same way", () => {
  it("the live path prefers raw.englishGloss", () => {
    expect(readCode("src/lib/agent-loop.ts")).toMatch(
      /priorOutbound: thread[\s\S]{0,200}englishGloss \?\? m\.body \?\? ""/
    );
  });
  it("the tick path does too - it had the identical defect", () => {
    expect(readCode("src/lib/graph/engine.ts")).toMatch(
      /const priorOutbound = outboundRows\.map\([\s\S]{0,160}englishGloss \?\? m\.body \?\? ""/
    );
  });
  it("the inbound half, which already did this, is untouched", () => {
    expect(readCode("src/lib/agent-loop.ts")).toMatch(
      /priorInbound: thread[\s\S]{0,200}\?\.english \?\? m\.body \?\? ""/
    );
  });
});
