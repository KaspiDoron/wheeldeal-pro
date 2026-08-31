import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyActs } from "../wa/dialogue-acts";
import { shopAskedLocation } from "../wa/detectors";

// THE OWNER'S ASK: "answer reply all the rental shops fast, efficient and with
// the best logic possible just like an intellect human being."
//
// A deep audit of the live reply path found the intelligence half defeated by
// one gate: the English gloss was produced only for NON-LATIN scripts, so half
// the markets this product runs in - Indonesia, Malaysia, Vietnam, the
// Philippines, Latin America - got no translation, and every deterministic
// detector downstream is English-only regex reading `gloss ?? raw`. The shop's
// question became invisible, and "answer" was not even a legal move.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the detectors are English-only - which is WHY the gloss matters", () => {
  // Not a criticism of the detectors: they are DESIGNED to read a gloss, and
  // live.ts feeds them `gloss ?? raw`. The defect was that for these languages
  // no gloss was ever produced, so they always read raw and always said no.
  const PAIRS: Array<[string, string]> = [
    ["Kamu nginap dimana? kirim lokasi ya", "Where are you staying? send your location"],
    ["Ban dang o dau? gui vi tri", "Where are you now? send your location"],
  ];

  it("EXECUTED: a location question is invisible in the local language and read in English", () => {
    // The shop is asking where to deliver. Unread, the agent never offers the
    // traveller's stay, never triggers the location share, and answers a
    // logistics question with another price ask.
    for (const [raw, glossed] of PAIRS) {
      expect(shopAskedLocation(raw), raw).toBe(false);
      expect(shopAskedLocation(glossed), glossed).toBe(true);
    }
  });

  it("EXECUTED: a local-language question does not register as an ask", () => {
    // `askedQuestion` gates whether `answer` is even a LEGAL move, so a shop
    // asking something in its own language cannot be answered - the ladder
    // falls through to bargain or clarify and the agent talks past them.
    const acts = classifyActs({ text: "Sewa berapa hari? Bisa antar ke hotel bos" });
    expect(acts.ask).toBe("none");
    expect(acts.shared).toEqual([]);
  });
});

describe("the composer finally sees the translation the app paid for", () => {
  it("TurnContext carries the gloss", () => {
    // Computed on the critical path at up to 8s a turn, stamped on the row,
    // threaded through the engine - and consumed only by comprehension and the
    // regex detectors. The model writing the reply never saw it.
    expect(readCode("src/lib/spte/types.ts")).toMatch(/english\?: string;/);
    expect(readCode("src/lib/spte/live.ts")).toMatch(
      /english: \(input\.inboundEnglish \?\? ""\)\.trim\(\) \|\| undefined/
    );
  });

  it("the prompt renders it beside the shop's own words, not instead of them", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/IN ENGLISH: \$\{ctx\.inbound\.english\}/);
    // Their verbatim message stays: a translation is the one place a digit can
    // quietly change, and the numbers are the thing being negotiated.
    expect(pass).toMatch(/SHOP JUST SAID: \$\{ctx\.inbound\.text/);
  });
});

describe("the deterministic fallbacks behave like a person, not a form letter", () => {
  it("the answer template answers before it asks", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    // This move is chosen BECAUSE the shop asked something - and on a provider
    // outage the fallback replied to "how many days?" with "what's your best
    // price per day?".
    expect(pass).toMatch(/asked === "vehicle-choice" \|\| asked === "substantive"/);
    expect(pass).toMatch(/I'm after a \$\{spec\} for \$\{nDays\(days\)\}/);
  });

  it("a firm refusal is caught even with every AI provider down", () => {
    const live = readCode("src/lib/spte/live.ts");
    // Firmness was single-sourced on the LLM - comprehension's verdict and the
    // extractor's, both on the SAME provider chain. Chain exhaustion is a
    // modelled production state, and in it the agent asked "any chance you can
    // do a bit better?" of a shop that had just said "last price".
    expect(live).toMatch(/const REFUSAL =/);
    expect(live).toMatch(/const deterministicFirm = quoteOnTable && REFUSAL\.test\(curInbound\)/);
    // It may only ever ADD firmness, never clear it.
    expect(live).toMatch(/curFirm \|\| deterministicFirm \? Math\.max\(facts\.firmCount, 1\)/);
    // And it needs a standing quote, so it cannot fire on an opening
    // "best price" - the exact failure that got the old FIRM_RX deleted.
    expect(live).toMatch(/const quoteOnTable =/);
  });
});

describe("a photo turn cannot outlive the request that carries it", () => {
  const loop = readCode("src/lib/agent-loop.ts");

  it("the whole turn has ONE wall clock, and every stage reads it", () => {
    // Per-stage budgets summed to 111s against Cloud Run's 90s: media retries
    // 7s + a 45s board read + a 14s failure re-read + a fresh 45s SPTE turn.
    // A kill there costs a 10-MINUTE claim lease, so a slow reply became a
    // lost one.
    expect(loop).toMatch(/const TURN_WALL_MS = 72_000/);
    expect(loop).toMatch(/const msLeft = \(\) => Math\.max\(0, turnDeadlineAt - Date\.now\(\)\)/);
    expect(loop).toMatch(/deadlineAt: Date\.now\(\) \+ Math\.max\(12_000, Math\.min\(45_000, msLeft\(\)\)\)/);
    expect(loop).not.toMatch(/deadlineAt: Date\.now\(\) \+ 45_000/);
  });

  it("the vision read and its re-read are bounded by what the turn has left", () => {
    const agents = readCode("src/lib/agents.ts");
    expect(agents).toMatch(/const VISION_TOTAL_BUDGET_CAP_MS = 30_000/);
    expect(agents).toMatch(/const VISION_REREAD_MIN_LEFT_MS = 26_000/);
    // The re-read fires exactly on the SLOW cases, so it is the one that must
    // stand down when the request is nearly out of time.
    expect(agents).toMatch(/if \(msLeft && msLeft\(\) < VISION_REREAD_MIN_LEFT_MS\) return null;/);
  });
});

describe("the reply lane stops paying for the same theatre twice", () => {
  it("the server-side hold is dropped on the fast (reply) path only", () => {
    const evo = readCode("src/lib/evolution.ts");
    // Evolution honours `delay` by HOLDING the send 1.2-4.5s - after we have
    // already performed the composing presence locally. On the reply lane that
    // is pure latency stacked on SPTE's 10s pause and the Poisson gap. The
    // cold-intro lane keeps it: an unhurried first contact costs nobody.
    expect(evo).toMatch(/\.\.\.\(fast \? \{\} : \{ delay: typingDelayForLength\(message\.length\) \}\)/);
    // The Poisson gap STAYS - it is the anti-uniformity signal, not theatre.
    expect(evo).toMatch(/await poissonPause\(\)/);
  });

  it("the launch gate names a number the product can hit while staying safe", () => {
    const runbook = readFileSync(join(process.cwd(), "RUNBOOK.md"), "utf8");
    expect(runbook).not.toMatch(/first reply < 10s/);
    expect(runbook).toMatch(/first reply 15-25s/);
    // And it says WHY, so nobody "fixes" the delay that is the feature.
    expect(runbook).toMatch(/A gate the product must fail to be safe is not a gate/);
  });
});
