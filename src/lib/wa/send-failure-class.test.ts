import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THREE DEAD NUMBERS COULD PAUSE A HEALTHY ACCOUNT.
//
// recordSendFailure had two outcomes, and one regex decided between them:
//
//     /not.*whatsapp|invalid|exist|blocked|forbidden/i  ->  "block"
//
// So "this number is not on WhatsApp" - a fact about a stale scraped listing -
// was recorded as a recipient BLOCK, which is a human deciding they do not want
// to hear from this traveller. blocks_total scores +12 each toward a +30
// ceiling on a 100-point risk score that AUTO-PAUSES at 70, so three bad
// numbers in one batch could stop a traveller's entire search for something no
// recipient ever did.
//
// The classifier is replicated here rather than imported because it lives
// inline in the send path; the source assertions below pin that it stays there.

const classify = (text: string): "invalid" | "block" | "fail" => {
  const notOnWhatsApp =
    /not.*(?:on\s*)?whatsapp|does ?n[o']?t exist|invalid.*number|no.*account/i.test(text);
  const trueBlock = /\bblocked\b|forbidden/i.test(text);
  return notOnWhatsApp ? "invalid" : trueBlock ? "block" : "fail";
};

describe("a listing problem is not a reputation problem", () => {
  it.each([
    "Number is not on WhatsApp",
    "the number does not exist",
    "recipient doesn't exist",
    "invalid number format",
    "no WhatsApp account for this number",
  ])("%s -> invalid", (text) => {
    expect(classify(text)).toBe("invalid");
  });

  it.each([
    "recipient has blocked this sender",
    "Forbidden",
    "403 forbidden: blocked",
  ])("%s -> block", (text) => {
    expect(classify(text)).toBe("block");
  });

  it.each([
    "Evolution API 500",
    "socket hang up",
    "timeout after 12000ms",
    "internal server error",
  ])("%s -> fail", (text) => {
    expect(classify(text)).toBe("fail");
  });

  it("REPRODUCTION: the old single regex called every one of these a block", () => {
    const old = (t: string) => /not.*whatsapp|invalid|exist|blocked|forbidden/i.test(t);
    const listingProblems = [
      "Number is not on WhatsApp",
      "the number does not exist",
      "invalid number format",
    ];
    for (const text of listingProblems) {
      expect(old(text)).toBe(true); // scored +12 toward an auto-pause
      expect(classify(text)).toBe("invalid"); // now scores nothing
    }
  });

  it("a real block is still caught - the fix must not go the other way", () => {
    expect(classify("recipient has blocked this sender")).toBe("block");
  });
});

describe("only a real block reaches blocks_total", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("recordSendFailure has a distinct invalid branch", () => {
    const fn = guard.slice(
      guard.indexOf("export async function recordSendFailure"),
      guard.indexOf("export async function recordSendFailure") + 1400
    );
    expect(fn).toMatch(/kind === "invalid"/);
    expect(fn).toMatch(/invalid_numbers_total/);
  });

  it("blocks_total is incremented ONLY under the block branch", () => {
    const fn = guard.slice(
      guard.indexOf("export async function recordSendFailure"),
      guard.indexOf("export async function recordSendFailure") + 1400
    );
    const blockIdx = fn.indexOf('kind === "block"');
    // The counter moved from a read-modify-write absolute value to an atomic
    // delta (owner report 8 M3), so the anchor is the COLUMN NAME rather than
    // the old `blocks_total: (rep.blocks_total ...)` arithmetic. What this test
    // guards - that the block counter is only ever touched under the block
    // branch, never under the invalid one - is unchanged.
    const blocksTotalIdx = fn.indexOf("blocks_total:");
    const invalidIdx = fn.indexOf('kind === "invalid"');
    expect(blockIdx).toBeGreaterThan(-1);
    expect(blocksTotalIdx).toBeGreaterThan(blockIdx);
    expect(blocksTotalIdx).toBeLessThan(invalidIdx);
    // ...and it is a DELTA now, so two concurrent failures cannot collapse
    // into one recorded block.
    expect(fn).toMatch(/\{ blocks_total: 1 \}/);
  });

  it("the send path passes three kinds, not two", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/notOnWhatsApp \? "invalid" : trueBlock \? "block" : "fail"/);
  });
});

describe("deliveries are counted, never synthesized", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("REGRESSION: recordReadReceipt no longer invents a delivered_total", () => {
    // The Math.max ran the OPPOSITE way from its intent: when a read arrived
    // with no delivery event - exactly when the delivery webhook is broken -
    // delivered_total was invented, inflating delivRate so the engagement
    // breaker fired LESS. A meter that heals itself on paper is how the
    // breaker stayed unarmed through both restrictions.
    expect(guard).not.toMatch(
      /delivered_total:\s*Math\.max\(\(rep\.delivered_total \|\| 0\), \(rep\.reads_total \|\| 0\) \+ 1\)/
    );
  });

  it("both receipt kinds stamp a timestamp so the meter can go dark", () => {
    expect(guard).toMatch(/last_read_receipt_at: new Date\(\)\.toISOString\(\)/);
    expect(guard).toMatch(/last_delivery_receipt_at: new Date\(\)\.toISOString\(\)/);
  });

  it("the new columns are SELECTED, not just written", () => {
    expect(guard).toMatch(/invalid_numbers_total,last_delivery_receipt_at,last_read_receipt_at/);
  });
});

describe("the Command Center can go dark", () => {
  const route = readCode("src/app/api/admin/command/route.ts");

  it("REGRESSION: no read swallows a failure into an empty array", () => {
    expect(route).not.toMatch(/catch\(\(\) => \[\]\)/);
  });

  it("every row read uses the reader that can actually answer 'unknown'", () => {
    // The previous version of this counted nine `.catch(() => null)` handlers
    // and passed for months while every one of them was unreachable: `sbSelect`
    // returns [] on a missing connection, a non-2xx AND a thrown exception, so
    // it can never reject. `degraded` was therefore permanently empty and the
    // Command Center stayed green through a total outage - the exact failure
    // this file's own header describes.
    //
    // `sbSelectDark` returns `T[] | null`, so the null branch is reachable by
    // construction. The behaviour itself is executed in fail-dark.test.ts.
    // Six, down from nine: Wave 7 deleted the sessions/replies/offers ROW
    // reads that the sbCountDark tiles had superseded (nothing consumed them).
    expect((route.match(/sbSelectDark</g) ?? []).length).toBe(6);
    expect(route).not.toMatch(/catch\(\(\) => null\)/);
  });

  it("a failed read raises a critical alert rather than nothing at all", () => {
    expect(route).toMatch(/degraded\.length/);
    expect(route).toMatch(/unreadable/);
  });

  it("stats from a dark source are null, not 0", () => {
    // Since 3.5 the tiles are EXACT sbCountDark counts; a null count rides
    // through AND names itself in `degraded`, so a dashed tile is explained.
    expect(route).toMatch(/const countStat = \(n: number \| null, label: string\)/);
    expect(route).toMatch(/if \(n === null && !degraded\.includes\(label\)\) degraded\.push\(label\)/);
  });

  it("the UI renders a dash, not a zero", () => {
    // The dash contract moved into the SHARED StatTile/Num primitives (3.5) -
    // one implementation every management surface uses.
    const page = readCode("src/app/admin/page.tsx");
    expect(page).toMatch(/<StatTile help=\{COMMAND_HELP\}/);
    expect(page).not.toMatch(/command\.stats\[s\.k\] \?\? 0/);
    const prim = readCode("src/components/admin/primitives.tsx");
    expect(prim).toMatch(/v === null \|\| v === undefined/);
    expect(prim).toMatch(/&mdash;/);
  });
});
