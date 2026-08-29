// GLOSS BEFORE DETECTORS (the audit's P1: every deterministic inbound
// detector read the shop's RAW local-language text; the English gloss reached
// only the comprehension pass). WIRING CHECK - the detectors themselves are
// unit-tested in their own files; these pins hold the FEED: the gloss must
// reach them, concatenated (never substituted, so English words in raw text
// keep their hits), on both the current message and the priors.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the English gloss reaches every deterministic scanner", () => {
  const live = read("src/lib/spte/live.ts");

  it("mapVerified's detectors read the concatenated text, not the raw alone", () => {
    expect(live).toMatch(/const detText = gloss && text/);
    for (const call of [
      "classifyActs({\n    text: detText",
      "shopAskedQuestion(detText)",
      "signalsVariance(detText)",
      "shopAskedLocation(detText)",
      "shopAskedLicense(detText)",
      "shopAskedLicensePhoto(detText)",
    ]) {
      expect(live).toContain(call);
    }
  });

  it("the ledger / thread-facts / options feed carries the current gloss", () => {
    expect(live).toMatch(/const curGloss = \(input\.inboundEnglish \?\? ""\)\.trim\(\)/);
    expect(live).toMatch(/\$\{curRaw\}\\n\$\{curGloss\}/);
  });

  it("prior inbound messages arrive as their gloss when one was stamped", () => {
    const loop = read("src/lib/agent-loop.ts");
    expect(loop).toMatch(/english\?: string \} \| null\)\?\.english \?\? m\.body/);
  });
});
