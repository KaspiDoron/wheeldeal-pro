// EVERY SCRIPT THIS REPO TELLS PEOPLE TO RUN HAS TO AT LEAST PARSE.
//
// `npm run dev:sim` is how CLAUDE.md says to run the whole funnel locally. As
// committed it could not start: tooling/dev/dev-sim.mjs used `await` inside a
// plain arrow function, a SyntaxError at load. Nothing caught it, because the
// .mjs files under scripts/ and tooling/ are outside tsc, outside vitest and
// outside the build - they are only ever exercised by a human typing a command.
//
// `node --check` parses without running. It is the cheapest possible test, and
// it would have caught this.

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function scripts(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) out.push(...scripts(rel));
    else if (/\.(mjs|js)$/.test(name)) out.push(rel);
  }
  return out;
}

describe("runnable scripts parse", () => {
  const files = [...scripts("scripts"), ...scripts("tooling"), ...scripts("deploy/ping")];

  it("finds them at all", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file}`, () => {
      expect(() => execFileSync(process.execPath, ["--check", file], { cwd: process.cwd(), stdio: "pipe" })).not.toThrow();
    });
  }
});
