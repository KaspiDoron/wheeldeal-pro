// AN agent_events ROW ABOUT A PERSON IS KEYED BY THE COLUMN, NEVER THE PAYLOAD.
//
// The erasure registry finds a person's agent_events rows by `user_email`, and
// only by that. A writer that tucks the address inside the JSON `detail` string
// and leaves the column empty produces a row that names somebody and that
// neither the erase walker nor the DSAR export can find - it outlives the
// account. That exact defect was found three times in one audit (the
// consent-unrecorded breadcrumb, and both localize-fallback writers), which is
// what makes it a CLASS of bug rather than a typo, and a class gets a guard.
//
// A source grep, because the property is about every writer in the tree
// including ones not written yet.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

/** Every `sbInsert("agent_events", [ ... ])` call body in a file. */
function insertBlocks(src: string): string[] {
  const blocks: string[] = [];
  const marker = /sbInsert(?:Returning|Claim)?\(\s*"agent_events"\s*,/g;
  for (let m = marker.exec(src); m; m = marker.exec(src)) {
    let depth = 0;
    let i = src.indexOf("(", m.index);
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    blocks.push(src.slice(start, i + 1));
  }
  return blocks;
}

describe("agent_events rows about a person", () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const file of sourceFiles()) {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    for (const block of insertBlocks(src)) {
      seen++;
      const detail = /detail\s*:\s*JSON\.stringify\(\s*\{([\s\S]*?)\}\s*\)/.exec(block)?.[1] ?? "";
      // `email:` / `email,` / `userEmail:` as a KEY of the detail object.
      const namesSomeone = /(?:^|[\s,{])(?:user_?)?email\s*[:,]/i.test(detail);
      if (namesSomeone) offenders.push(file);
    }
  }

  it("finds the agent_events writers at all (the grep itself still works)", () => {
    expect(seen).toBeGreaterThan(10);
  });

  it("never carry the address inside `detail` - it goes in the user_email column", () => {
    expect(
      offenders,
      "put the address in `user_email` (which erase + export walk) and leave it OUT of the detail JSON"
    ).toEqual([]);
  });
});
