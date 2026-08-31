import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  historyLine,
  buildHistoryWindow,
  HISTORY_ELISION,
  HISTORY_HEAD_LINES,
  HISTORY_CHAR_BUDGET,
} from "./history-window";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// OWNER REPORT 4/W2.2: the engine's memory of the thread. Two amputations -
// a 12-row window that lost the RFQ head of long negotiations, and a line
// builder that rendered a voice note as the string "[voice note]" - made the
// agent re-ask what the shop had already answered.

describe("historyLine - a voice note carries its transcript, not a placeholder", () => {
  it("substitutes the stored transcript for the placeholder body", () => {
    const line = historyLine({
      direction: "inbound",
      body: "[voice note]",
      raw: { transcript: { text: "for you my friend 350 per day, helmet included" } },
    });
    expect(line).toContain("350 per day");
    expect(line.startsWith("Shop: [voice note]")).toBe(true);
  });

  it("a voice note with NO transcript keeps the honest placeholder", () => {
    expect(historyLine({ direction: "inbound", body: "[voice note]", raw: {} })).toBe(
      "Shop: [voice note]"
    );
  });

  it("a REAL body is never replaced by a transcript", () => {
    const line = historyLine({
      direction: "inbound",
      body: "ok 300 baht",
      raw: { transcript: { text: "something else entirely" } },
    });
    expect(line).toBe("Shop: ok 300 baht");
  });
});

describe("buildHistoryWindow - head preserved, elision marked", () => {
  const row = (i: number, text: string) => ({
    direction: i % 2 === 0 ? "outbound" : "inbound",
    body: text,
  });

  it("a thread within budget goes through whole, no marker", () => {
    const rows = [row(0, "hi, do you have a scooter?"), row(1, "yes 300 per day")];
    const out = buildHistoryWindow(rows);
    expect(out).toContain("Us: hi");
    expect(out).toContain("Shop: yes 300");
    expect(out).not.toContain(HISTORY_ELISION);
  });

  it("over budget: the RFQ head survives, the middle is elided, the tail is newest", () => {
    const rows = [
      row(0, "Hi! Do you have a Honda Click 125 for 5 days from Tuesday?"),
      row(1, "Yes we have Click 125, 300 baht per day"),
      ...Array.from({ length: 60 }, (_, i) => row(i, `filler message number ${i} ${"x".repeat(120)}`)),
      row(0, "ok can you do 250 for the 5 days?"),
      row(1, "deal, 250 per day, come tomorrow"),
    ];
    const out = buildHistoryWindow(rows);
    expect(out.length).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET + 50);
    // The head - the turns that anchor what "it" and a bare number refer to.
    expect(out).toContain("Honda Click 125 for 5 days");
    // The elision is MARKED, never silent.
    expect(out).toContain(HISTORY_ELISION);
    // The newest turns always survive - they are what this turn answers.
    expect(out).toContain("deal, 250 per day");
    // Head size is the constant the module promises.
    expect(out.split("\n").indexOf(HISTORY_ELISION)).toBe(HISTORY_HEAD_LINES);
  });
});

describe("the engines consume the shared window", () => {
  it("both history builders route through buildHistoryWindow with a wide slice", () => {
    expect(readCode("src/lib/agent-loop.ts")).toMatch(
      /buildHistoryWindow\(mine\.slice\(0, 40\)\.reverse\(\)\)/
    );
    expect(readCode("src/lib/graph/engine.ts")).toMatch(
      /buildHistoryWindow\(mine\.slice\(0, 40\)\.reverse\(\)\)/
    );
  });

  it("rival leverage reaches every quoted turn through the LIVE engines (legacy path deleted)", () => {
    // The legacy orchestrator - whose round-0-only rival fetch this pinned -
    // is gone (see speed-floors "the legacy pipeline is gone"). The live
    // engines consume rivals through the session snapshot every turn: SPTE's
    // buildSession fills session.rivals, and the leverage predicate reads it
    // on each pass.
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/cheapestCheaperRival\(/);
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/cheapestCheaperRival\(ctx\.session\.rivals/);
  });

  it("group/status frames leave a trace instead of vanishing", () => {
    expect(readCode("src/lib/wa/ingest.ts")).toMatch(/"non-chat-jid"/);
  });

  it("replay guards mirror live: spec-resolved maxRounds, accumulated firmness", () => {
    const sim = readCode("src/lib/simulate.ts");
    expect(sim).not.toMatch(/maxRounds: 6/);
    expect(sim).toMatch(/maxRoundsPerShop/);
    expect(sim).toMatch(/if \(verified\.firm\) firmSoFar\+\+/);
    // Wave 3: the stub accumulation is OR-ed (max) with the same text-derived
    // count live computes in deriveThreadFacts - whichever source saw more
    // firmness wins, exactly as live OR-s the extractor flag into the derived
    // count.
    expect(sim).toMatch(/firmCount: Math\.max\(firmSoFar, facts\.firmCount\)/);
  });
});
