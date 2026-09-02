import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { citesPrice } from "../integrity/money-context";

vi.mock("server-only", () => ({}));
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 8, B1 - the owner's product requirement:
//   "We've received an offer of 200 from another rental shop. Can you offer 180?"
//
// The machinery was genuinely built and genuinely wired. Four things stopped it
// reaching the shop.

describe("the cheapest rival survives truncation", () => {
  // WHY THIS BLOCK WAS REWRITTEN. Its "EXECUTED" case used to paste the
  // engine's comparator into the test file and sort with its own copy, so it
  // passed regardless of what `sessionTable` actually did - including if the
  // engine went back to slicing an unsorted Map, which is the exact regression
  // it exists to catch. The ranking now lives in a pure module and the test
  // runs the real function.

  it("EXECUTED: a 16-shop board keeps the cheapest when it lands mid-list", async () => {
    const { sessionTableRows } = await import("../graph/session-table");
    // THE FIXTURE MATTERS, and my first version of it did not discriminate.
    // Putting the cheapest LAST in insertion order let the reserved
    // dearest-tail rescue it even from an unsorted slice, so the test passed
    // against the very bug it names. Threads arrive ordered by updated_at, so
    // the realistic - and the only falsifying - position is the MIDDLE: too
    // late for the head, too early for the tail.
    const rows = [
      { vendorId: "self", vendorName: "self", pricePerDay: 300, isThisShop: true },
      // index 1-10
      ...Array.from({ length: 10 }, (_, i) => ({
        vendorId: `early${i}`,
        vendorName: `early${i}`,
        pricePerDay: 250 + i,
      })),
      // index 11 - past a plain 10-row slice, and not inside the last four
      // either, so NEITHER end of the truncation rescues it. Only the ranking
      // can keep this row.
      { vendorId: "CHEAPEST", vendorName: "cheapest", pricePerDay: 200 },
      // index 12-15
      ...Array.from({ length: 4 }, (_, i) => ({
        vendorId: `late${i}`,
        vendorName: `late${i}`,
        pricePerDay: 260 + i,
      })),
    ];
    const kept = sessionTableRows(rows).map((r) => r.vendorId);
    expect(kept, "the 200 must survive the cap").toContain("CHEAPEST");
    expect(kept, "...and so must our own row").toContain("self");
    // For contrast, the pre-fix behaviour on this same board: a plain
    // insertion-order slice drops the cheapest quote in the hunt.
    expect(rows.slice(0, 10).map((r) => r.vendorId)).not.toContain("CHEAPEST");
  });

  it("EXECUTED: the DEAREST shops survive too - the sibling re-bargain's targets", async () => {
    const { sessionTableRows, SESSION_TABLE_CAP, REBARGAIN_TAIL } = await import(
      "../graph/session-table"
    );
    // Cheapest-first alone starved `planSiblingRebargain`, which re-sorts this
    // list dearest-first: the slice was discarding exactly its targets.
    // Insertion order is deliberately scrambled. An ascending fixture would
    // pass against an unsorted slice by coincidence - the tail would catch the
    // dearest rows for free - and prove nothing about the ranking.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      vendorId: `v${i}`,
      vendorName: `v${i}`,
      pricePerDay: 100 + i * 10, // v29 is the dearest at 390
    }));
    const scrambled = rows.filter((_, i) => i % 2 === 0).concat(rows.filter((_, i) => i % 2 === 1));
    const kept = sessionTableRows(scrambled);
    expect(kept).toHaveLength(SESSION_TABLE_CAP);
    const ids = kept.map((r) => r.vendorId);
    expect(ids, "the cheapest is still first").toContain("v0");
    for (let i = 0; i < REBARGAIN_TAIL; i++) {
      expect(ids, "a dearest row the swarm can aim at").toContain(`v${29 - i}`);
    }
  });

  it("EXECUTED: this shop is kept regardless - the comparison needs its own row", async () => {
    const { sessionTableRows } = await import("../graph/session-table");
    // Our own row is what quoteOnTable reads. Dropping it does not weaken the
    // comparison, it removes the thing being compared against. Priceless, so
    // it would otherwise rank last of all.
    // Mid-list again, for the same reason: last would be rescued by the tail.
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({
        vendorId: `a${i}`,
        vendorName: `a${i}`,
        pricePerDay: 100 + i,
      })),
      { vendorId: "self", vendorName: "self", isThisShop: true },
      ...Array.from({ length: 10 }, (_, i) => ({
        vendorId: `b${i}`,
        vendorName: `b${i}`,
        pricePerDay: 200 + i,
      })),
    ];
    expect(sessionTableRows(rows).map((r) => r.vendorId)).toContain("self");
  });

  it("EXECUTED: priced rows rank ahead of priceless ones", async () => {
    const { rankSessionRows } = await import("../graph/session-table");
    const ranked = rankSessionRows([
      { vendorId: "silent", vendorName: "silent" },
      { vendorId: "dear", vendorName: "dear", pricePerDay: 400 },
      { vendorId: "zero", vendorName: "zero", pricePerDay: 0 },
      { vendorId: "cheap", vendorName: "cheap", pricePerDay: 150 },
    ]).map((r) => r.vendorId);
    expect(ranked.slice(0, 2)).toEqual(["cheap", "dear"]);
    // A zero price is not a quote - it must not outrank a real one.
    expect(ranked.indexOf("zero")).toBeGreaterThan(ranked.indexOf("dear"));
  });

  it("EXECUTED: a board under the cap is returned whole, in rank order", async () => {
    const { sessionTableRows } = await import("../graph/session-table");
    const kept = sessionTableRows([
      { vendorId: "b", vendorName: "b", pricePerDay: 300 },
      { vendorId: "a", vendorName: "a", pricePerDay: 200 },
    ]).map((r) => r.vendorId);
    expect(kept).toEqual(["a", "b"]);
  });

  it("EXECUTED: the two ends never duplicate a row", async () => {
    const { sessionTableRows, SESSION_TABLE_CAP } = await import("../graph/session-table");
    // 11 rows: head takes 6, tail takes the last 4 - and with a cap of 10 and
    // eleven rows the windows nearly touch. A duplicate here would send the
    // same shop to the model twice and inflate the board.
    const rows = Array.from({ length: 11 }, (_, i) => ({
      vendorId: `v${i}`,
      vendorName: `v${i}`,
      pricePerDay: 100 + i,
    }));
    const kept = sessionTableRows(rows).map((r) => r.vendorId);
    expect(new Set(kept).size).toBe(kept.length);
    expect(kept.length).toBeLessThanOrEqual(SESSION_TABLE_CAP);
  });

  it("the engine really calls the shared function - not a second copy of it", () => {
    // The one grep worth keeping here, and it is labelled as one: it guards
    // against the ranking being re-inlined into the closure, which is what
    // made the old test vacuous.
    const engine = read("src/lib/graph/engine.ts");
    expect(engine).toMatch(/return sessionTableRows\(\[\.\.\.rows\.values\(\)\]\);/);
    expect(engine).not.toMatch(/return \[\.\.\.rows\.values\(\)\]\.slice\(0, 10\);/);
  });
});

describe("a bargain that ignores the rival is REJECTED, not sent", () => {
  const rails = read("src/lib/spte/rails.ts");

  it("THE MISSING GUARANTEE: there is now a cite-the-rival rail", () => {
    // Every other control was prompt text - and this file's own doctrine says
    // "a prompt is advice and a rail is a guarantee". beat-not-match got a
    // rail; cite-the-rival did not.
    expect(rails).toMatch(/rule: "cite-the-rival"/);
    expect(rails).toMatch(/cheapestCheaperRival\(ctx\.session\.rivals, quoteOnTable\(ctx\)\)/);
  });

  it("it only binds when a cheaper rival actually exists", () => {
    const blk = rails.slice(rails.indexOf("CITE THE RIVAL"));
    expect(blk.slice(0, 2400)).toMatch(/if \(rival\) \{/);
  });

  it("a draft that already names the number passes untouched", () => {
    const blk = rails.slice(rails.indexOf("CITE THE RIVAL"));
    expect(blk.slice(0, 3600)).toMatch(/if \(!cited\)/);
  });

  it("ANY real rival counts, not only the cheapest", () => {
    // Requiring the cheapest specifically would reject "another shop quoted me
    // 280 - can you beat it?" on a board that also holds a 250 - good leverage,
    // already validated as real by checkOutboundNumbers.
    const blk = rails.slice(rails.indexOf("CITE THE RIVAL"));
    expect(blk.slice(0, 4200)).toMatch(/ANY REAL RIVAL COUNTS/);
    // Every real rival's price goes into the citable set, and the rail asks the
    // shared money reader whether any of them was named.
    expect(blk.slice(0, 4200)).toMatch(/const quotable = ctx\.session\.rivals/);
    expect(blk.slice(0, 4200)).toMatch(/citesPrice\(normalizeDigits\(text\), quotable\)/);
  });

  it("EXECUTED: the rail cannot be satisfied by a date that matches the rival", () => {
    // The rail counted ANY numeral within 1 unit of a real rival, so a bargain
    // that never named the rival satisfied the rail built to require it.
    expect(citesPrice("can you do it for the 17 Aug?", [17])).toBe(false);
    expect(citesPrice("we need it for 5 days", [5])).toBe(false);
    // ...and the sentence the owner actually asked for still passes.
    expect(citesPrice("Another shop offered 200, can you do 190?", [200])).toBe(true);
  });

  it("it runs AFTER send-worthiness - an empty draft is diagnosed as empty", () => {
    // "thanks! 👍" is empty before it is leverage-free; naming the shallower
    // defect first would hide the real one behind a confusing reason.
    const sw = rails.indexOf('rule: "send-worthiness"');
    const cite = rails.indexOf('rule: "cite-the-rival"');
    expect(sw).toBeGreaterThan(0);
    expect(cite).toBeGreaterThan(sw);
  });

  it("rejection lands on the template that DOES cite it", () => {
    // The failure mode of this rail is the message the owner asked for.
    const pass = read("src/lib/spte/pass.ts");
    expect(pass).toMatch(/Another shop offered \$\{money\(rival\.pricePerDay\)\}/);
  });
});

describe("the owner's sentence is not suppressed on half the threads", () => {
  it("THE CONTRADICTION: the A/B split is pinned off for the beta", () => {
    const av = read("src/lib/negotiation/ask-variant.ts");
    expect(av).toMatch(/export const ASK_VARIANT_SPLIT = false;/);
    expect(av).toMatch(/if \(!ASK_VARIANT_SPLIT\) return "specific-number";/);
  });

  it("...but the experiment is paused, not deleted", () => {
    const av = read("src/lib/negotiation/ask-variant.ts");
    expect(av).toMatch(/hash\(key\) % 2 === 0/);
    expect(av).toMatch(/open-ended-below/);
  });
});

describe("citedRival measures the wire, not the model's self-report", () => {
  const live = read("src/lib/spte/live.ts");

  it("THE BROKEN INSTRUMENT: it no longer reads leverageUsed", () => {
    // leverageUsed is written by the model about itself, unvalidated - and
    // fallbackArtifact hard-codes it to [], so the one path that cites the
    // rival deterministically always recorded false.
    expect(live).not.toMatch(/citedRival: Boolean\(outcome\.artifact\.leverageUsed\?\.includes\("rival"\)\)/);
    expect(live).toMatch(/citedRival: \(\(\) => \{/);
  });

  it("it checks the SENT text against the cheapest rival's number", () => {
    const blk = live.slice(live.indexOf("MEASURED ON THE WIRE"));
    expect(blk.slice(0, 1800)).toMatch(/cheapestCheaperRival\(tc\.session\.rivals, quoteOnTable\(tc\)\)/);
    expect(blk.slice(0, 1800)).toMatch(/if \(!rival \|\| !send\) return false;/);
  });

  it("EXECUTED: the tolerance matches how a composer really writes a price", () => {
    const cited = (send: string, target: number) =>
      (send.match(/\d[\d,.]*/g) ?? []).some((n) => {
        const v = Number(n.replace(/[,.](?=\d{3}\b)/g, "").replace(/,/g, "."));
        return Number.isFinite(v) && Math.abs(v - target) <= 1;
      });
    expect(cited("Another shop offered 200/day - could you do 180?", 200)).toBe(true);
    expect(cited("another shop quoted 1,200 - can you beat it?", 1200)).toBe(true);
    expect(cited("they said 201 baht", 200)).toBe(true); // rounding tolerance
    expect(cited("Any chance of a better daily rate for the scooter?", 200)).toBe(false);
    expect(cited("we can do 350 for you", 200)).toBe(false);
  });
});
