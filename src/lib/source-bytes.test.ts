import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// A SOURCE FILE THAT IS NOT TEXT IS A FILE NOBODY CAN REVIEW.
//
// `src/lib/graph/guardrails.ts` shipped with a raw NUL (0x00) and a raw DEL
// (0x7f) inside a regex character class, where the escape sequences were meant.
// The regex still MEANT the right thing, so every build, typecheck and test
// passed - for months.
//
// What it broke was every text tool at once:
//
//   file(1)   "data", not "ASCII text"
//   git diff  "Binary files a/... and b/... differ"  - no reviewable diff, ever
//   grep -rn  "binary file matches"                  - never a single line
//   ripgrep   skips it, so editor search skips it too
//
// That file holds `checkOutboundNumbers`, `correctDuration` and
// `verbatimNumerals` - the rails between a model's invented price and a real
// rental shop. It is also where a four-script digit fold sat beside an
// eighteen-script one in `integrity/translation.ts`, at two different strengths,
// through TEN audit rounds. Every one of those rounds grepped. None of them
// could see this file.
//
// So the cheapest possible guard against the whole class: no tracked source
// file may carry a control byte. It is not a style rule - it is what keeps a
// file visible to the tools the review process actually runs.

/** Control bytes that are legitimate in a text file. Everything else is not. */
const ALLOWED = new Set([0x09 /* tab */, 0x0a /* LF */, 0x0d /* CR */]);

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sql|css|scss|ya?ml|html|svg|txt|sh|toml)$/i;

function trackedTextFiles(): string[] {
  let out = "";
  try {
    out = execSync("git ls-files -z", { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return [];
  }
  return out
    .split("\0")
    .filter(Boolean)
    .filter((p) => TEXT_EXT.test(p))
    .filter((p) => existsSync(p));
}

describe("no tracked source file is secretly binary", () => {
  const files = trackedTextFiles();

  it("finds files to check (a silent zero here would make this test vacuous)", () => {
    // Without this the whole file passes on a checkout where git is unavailable,
    // which is precisely the fail-green shape it exists to prevent.
    expect(files.length).toBeGreaterThan(500);
  });

  it("carries no control byte outside tab, newline and carriage return", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const buf = readFileSync(f);
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b < 0x20 && !ALLOWED.has(b)) {
          offenders.push(`${f}: byte 0x${b.toString(16).padStart(2, "0")} at offset ${i}`);
          break;
        }
        if (b === 0x7f) {
          offenders.push(`${f}: byte 0x7f (DEL) at offset ${i}`);
          break;
        }
      }
    }
    expect(
      offenders,
      "a control byte makes the file binary to git diff, grep and ripgrep - " +
        "write the escape sequence (\\x00) instead of the literal character"
    ).toEqual([]);
  });

  it("guardrails.ts specifically is greppable - the file this rule was written for", () => {
    // Named explicitly so a regression is unmistakable rather than one entry in
    // a list. `grep -c` on a binary file reports "binary file matches" and a
    // count of 0 matching LINES, so a readable count proves it is text again.
    const out = execSync(
      "grep -c 'normalizeDigits' src/lib/graph/guardrails.ts 2>/dev/null || echo 0",
      { encoding: "utf8" }
    ).trim();
    expect(Number(out)).toBeGreaterThan(0);
  });
});
