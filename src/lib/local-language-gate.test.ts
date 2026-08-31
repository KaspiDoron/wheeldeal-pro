import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { localLanguageAllowed } from "./entitlements";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// ONE RULE, THREE SPELLINGS (W-11).
//
// The reported defect was "any account can POST {localLang:true}". That did not
// survive checking - every surface did gate it. What they did NOT share was HOW:
//
//   can(session.plan, "local-language")   outreach, mass (x3), graph nodes+engine
//   isUltra                               bargain-draft (a feature check named
//                                         after the tier that happens to satisfy it)
//   ctx.plan === "ultra"                  agent-loop - the reply composer
//
// The third is the one that would have bitten. It is a hardcoded tier literal on
// the single path that actually writes the message to the shop. The day `can()`
// learns a new tier - a grandfathered plan, an annual SKU, a trial - every
// surface follows it except the send path, which keeps refusing. The gate still
// passes every test it has, and is quietly wrong where it matters.

describe("the predicate itself", () => {
  it("an entitled plan asking for it gets it", () => {
    expect(localLanguageAllowed({ requested: true, plan: "ultra" })).toBe(true);
  });

  it("an unentitled plan never gets it, however it asks", () => {
    for (const plan of ["free", "pro", null, undefined, "enterprise-tier-9"]) {
      expect(localLanguageAllowed({ requested: true, plan }), String(plan)).toBe(false);
    }
  });

  it("not asking is not asking", () => {
    for (const requested of [false, undefined, null, 0, ""]) {
      expect(localLanguageAllowed({ requested, plan: "ultra" }), String(requested)).toBe(false);
    }
  });

  it("a truthy non-boolean from a JSON body still reads as a request", () => {
    // The input is `body.localLang` off the wire - it is not typed at the edge.
    expect(localLanguageAllowed({ requested: "true", plan: "ultra" })).toBe(true);
    expect(localLanguageAllowed({ requested: 1, plan: "ultra" })).toBe(true);
  });

  it("the owner switch can only ever SUBTRACT", () => {
    // An owner who turns the feature off must not be overridden by a plan.
    expect(localLanguageAllowed({ requested: true, plan: "ultra", enabled: false })).toBe(false);
    // ...and turning it "on" grants nothing an unentitled plan did not have.
    expect(localLanguageAllowed({ requested: true, plan: "free", enabled: true })).toBe(false);
  });

  it("an unset switch behaves exactly like an enabled one", () => {
    expect(localLanguageAllowed({ requested: true, plan: "ultra", enabled: undefined })).toBe(
      localLanguageAllowed({ requested: true, plan: "ultra", enabled: true })
    );
  });
});

describe("every surface speaks the one dialect", () => {
  // agent-loop left this list when the legacy orchestrator (its only composer)
  // was deleted - the reply composers are the engines now, and both are here.
  const files = [
    "src/lib/spte/live.ts",
    "src/lib/graph/nodes.ts",
    "src/lib/graph/engine.ts",
    "src/app/api/outreach/route.ts",
    "src/app/api/outreach/mass/route.ts",
    "src/app/api/bargain-draft/route.ts",
  ];

  it("all of them call the shared predicate", () => {
    for (const f of files) {
      expect(readCode(f), `${f} does not use localLanguageAllowed`).toMatch(
        /localLanguageAllowed\(/
      );
    }
  });

  it("the hardcoded tier literal is gone from the send path", () => {
    // This is the whole finding. agent-loop composes the message that reaches
    // the shop; it must not carry its own idea of who is entitled.
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).not.toMatch(/ctx\.plan === "ultra"/);
  });

  it("...and no surface re-derives the entitlement inline", () => {
    for (const f of files) {
      expect(readCode(f), `${f} still spells the rule itself`).not.toMatch(
        /Boolean\([^)]*[Ll]ocalLang[^)]*\) && can\(/
      );
    }
  });

  it("the owner switch fails ON, not off", () => {
    // It exists to STOP the feature, not to be the reason a reply is composed
    // in the wrong language during a config outage.
    const loop = readCode("src/lib/agent-loop.ts");
    const fn = /async function localLanguageEnabled[\s\S]*?\n\}/.exec(loop);
    expect(fn, "localLanguageEnabled moved").toBeTruthy();
    expect(fn![0]).toMatch(/if \(!raw\) return true;/);
    expect(fn![0]).toMatch(/catch \{\s*return true;/);
  });
});
