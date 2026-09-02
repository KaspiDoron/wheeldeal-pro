import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { voiceProfileFor, voiceDirectives } from "../voice";
import { compileStyleDirectives } from "../copy/promptCompiler";
import { enforceEmojiTone, hasEmoji } from "../graph/uniqueness";

// A HUNDRED "DIFFERENT CUSTOMERS" WHO ALL WRITE IDENTICALLY.
//
// That is voice.ts's own opening line, and it describes exactly what the app
// was doing. `voiceProfileFor` (per-user persona) and `compileStyleDirectives`
// (per-turn structural draw) both existed, were tested, and had ZERO callers
// under src/lib/spte - the PRIMARY engine, the one every traveller is actually
// served by. Only the FAILOVER got them. On a beta of 25 personal WhatsApp
// numbers that is the loudest tell the fleet can emit.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("EXECUTED: two travellers do not sound like one traveller", () => {
  it("different people draw different personas", () => {
    const a = voiceProfileFor("alice@example.com");
    const b = voiceProfileFor("bob@example.com");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("the same person is the same person, forever", () => {
    expect(voiceProfileFor("alice@example.com")).toEqual(voiceProfileFor("ALICE@example.com"));
  });

  it("across a 25-tester fleet the voices genuinely spread", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) seen.add(JSON.stringify(voiceProfileFor(`t${i}@beta.test`)));
    // Not a demand for 25 distinct draws - the pools are finite - but a fleet
    // that collapses to one or two voices is the defect restated.
    expect(seen.size).toBeGreaterThan(8);
  });

  it("the persona block never smuggles a greeting into a mid-thread reply", () => {
    // Two contradictory rules in one prompt, and a model obeys the concrete
    // one - which is how "Hey there!" kept appearing on turn four.
    for (let i = 0; i < 25; i++) {
      const d = voiceDirectives(voiceProfileFor(`t${i}@beta.test`), { greeting: false });
      expect(d).toContain("MID-CONVERSATION");
      expect(d).not.toMatch(/usually opens with/);
    }
  });
});

describe("EXECUTED: two turns of one thread do not share a skeleton", () => {
  const seed = (nonce: number) => ({ threadId: "t@x.com:66812345678", vendorId: "v1", nonce });

  it("the structural draw moves with the round", () => {
    const shapes = [0, 1, 2, 3].map((n) => compileStyleDirectives(seed(n)));
    expect(new Set(shapes).size).toBeGreaterThan(1);
  });

  it("...and is stable for the same round, so a re-park composes the same bytes", () => {
    expect(compileStyleDirectives(seed(2))).toBe(compileStyleDirectives(seed(2)));
  });

  it("every draw still forbids a mid-thread greeting", () => {
    for (let n = 0; n < 12; n++) {
      expect(compileStyleDirectives(seed(n))).toContain("NO greeting at all");
    }
  });
});

describe("EXECUTED: the emoji is no longer on every single message", () => {
  const plain = "Any chance you can do a bit better for 5 days?";

  it("a 'never' persona never gets one - not even one the model wrote", () => {
    expect(enforceEmojiTone(plain, true, { appetite: "never", seed: "s" })).toBe(plain);
    expect(hasEmoji(enforceEmojiTone("Thanks! 🙂", true, { appetite: "never", seed: "s" }))).toBe(
      false
    );
  });

  it("across many threads it is SOMETIMES, not always - the pattern is the tell", () => {
    // personaHumanize adds one ~45% of the time and says why: "not every
    // message (that is itself a pattern)". This ran first and appended one
    // unconditionally, so that deliberate variation never fired once.
    let withEmoji = 0;
    for (let i = 0; i < 60; i++) {
      const out = enforceEmojiTone(plain, true, { appetite: "sometimes", seed: `thread-${i}` });
      if (hasEmoji(out)) withEmoji++;
    }
    expect(withEmoji).toBeGreaterThan(5);
    expect(withEmoji).toBeLessThan(55);
  });

  it("a shop that uses emoji with us gets them back more often - people mirror", () => {
    const count = (shopUsesEmoji: boolean) => {
      let n = 0;
      for (let i = 0; i < 80; i++) {
        if (hasEmoji(enforceEmojiTone(plain, true, { shopUsesEmoji, seed: `t-${i}` }))) n++;
      }
      return n;
    };
    expect(count(true)).toBeGreaterThan(count(false));
  });

  it("SEEDED, not random - a re-park must compose byte-identical text", () => {
    // Math.random() here was the only non-seeded step in the whole send chain,
    // and everything around it is seeded so the idempotency hash is stable.
    const t = { appetite: "sometimes" as const, seed: "fixed-seed" };
    const a = enforceEmojiTone(plain, true, t);
    for (let i = 0; i < 10; i++) expect(enforceEmojiTone(plain, true, t)).toBe(a);
  });

  it("still never a stack of them", () => {
    const out = enforceEmojiTone("Great 🙂🙏🤙 thanks", true, { appetite: "sometimes", seed: "s" });
    expect([...out.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu)].length).toBe(1);
  });

  it("disabled is still a pass-through", () => {
    expect(enforceEmojiTone("Thanks! 🙂🙏", false, { appetite: "never" })).toBe("Thanks! 🙂🙏");
  });
});

describe("the primary engine actually carries them now", () => {
  const pass = readCode("src/lib/spte/pass.ts");
  const live = readCode("src/lib/spte/live.ts");

  it("the persona and the per-turn shape are in the SPTE system prompt", () => {
    expect(pass).toMatch(/voiceDirectives\(voiceProfileFor\(ctx\.userKey\)/);
    expect(pass).toMatch(/compileStyleDirectives\(/);
    expect(pass).toMatch(/\n    persona \+\n    styleShape \+/);
  });

  it("the traveller and their region reach the turn context", () => {
    expect(live).toMatch(/userKey: input\.ctx\.sender \?\? undefined,/);
    expect(live).toMatch(/region: input\.ctx\.region \|\| undefined,/);
  });

  it("a replay has no traveller, so the golden cases stay byte-identical", () => {
    // Both blocks are gated on ctx.userKey, which simulate.ts does not set.
    expect(pass).toMatch(/const persona = ctx\.userKey/);
    expect(pass).toMatch(/const styleShape = ctx\.userKey/);
  });

  it("the emoji gate is fed the persona, the shop's usage and a seed", () => {
    expect(live).toMatch(/enforceEmojiTone\(fresh\.text, spec\.settings\.emojiTone, emojiTone\)/);
    expect(live).toMatch(/enforceEmojiTone\(send, spec\.settings\.emojiTone, emojiTone\)/);
    expect(live).toMatch(/shopUsesEmoji = \(input\.priorInbound \?\? \[\]\)\.some\(\(m\) => hasEmoji\(m\)\)/);
  });

  it("no Math.random survives in the emoji rule's seeded path", () => {
    const uniq = readCode("src/lib/graph/uniqueness.ts");
    expect(uniq).toMatch(/function seededUnit\(seed: string\): number/);
    expect(uniq).toMatch(/if \(tone\?\.appetite === "never"\) return strip\(text\);/);
  });
});
