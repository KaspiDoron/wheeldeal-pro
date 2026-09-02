import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// The four PostgREST reads are doubled by QUERY, so each pool can be steered
// independently - the point of several assertions is which pool an exemplar
// came from and where it ended up.
let rows: Record<string, { text: string }[]> = {};
let selectCalls = 0;
vi.mock("../runtime-config", () => ({
  sbSelect: async (_t: string, q: string) => {
    selectCalls++;
    if (q.includes("ops-lesson")) return rows.lessons ?? [];
    if (q.includes("eq.distilled")) return rows.distilled ?? [];
    if (q.includes("ops-exemplar,ops-correction)")) return rows.ops ?? [];
    return rows.classic ?? [];
  },
}));
vi.mock("../ops/learning", () => ({ getOpsLearning: async () => null }));

import { bustCoachingCache, loadCoaching } from "./coaching";
import { NUMBER_PLACEHOLDER } from "../corpus/retrieve";

beforeEach(() => {
  bustCoachingCache();
  rows = {};
  selectCalls = 0;
});

const POOL = {
  distilled: [
    { text: "When the shop sends a price board photo, quote the tier that matches the stay." },
    { text: "If they say the scooter is out of stock, ask what else is free on those dates." },
  ],
  ops: [{ text: "A weekly package divided by seven is not a daily rate - say so plainly." }],
  classic: [{ text: "Greet briefly, then ask the price for the exact dates." }],
};

describe("the exemplars are ordered by what this turn is actually about", () => {
  it("a stock question surfaces the stock exemplar first", async () => {
    rows = POOL;
    const out = await loadCoaching([], "sorry the scooter is out of stock this week");
    const first = out.slice(out.indexOf("LEARNED STYLE")).split("\n")[1];
    expect(first).toMatch(/out of stock/i);
  });

  it("a price-board question surfaces the price-board exemplar first", async () => {
    // Same pool, same order in the database - a different turn, a different
    // first line. Under pure recency both turns got the same block.
    rows = POOL;
    const out = await loadCoaching([], "here is a photo of our price board for the week");
    const first = out.slice(out.indexOf("LEARNED STYLE")).split("\n")[1];
    expect(first).toMatch(/price board/i);
  });

  it("with NO query the order is exactly the recency order, unchanged", async () => {
    rows = POOL;
    const out = await loadCoaching([]);
    const first = out.slice(out.indexOf("LEARNED STYLE")).split("\n")[1];
    expect(first).toMatch(/price board photo/i); // the first distilled row
  });
});

describe("retrieval cannot invent, and cannot empty the block", () => {
  it("every line shown came from the pool - nothing is constructed", async () => {
    rows = POOL;
    const out = await loadCoaching([], "out of stock");
    const shown = out
      .slice(out.indexOf("LEARNED STYLE"))
      .split("\n")
      .slice(1)
      .map((l) => l.replace(/^- /, "").trim())
      .filter(Boolean);
    const poolWords = [...POOL.distilled, ...POOL.ops, ...POOL.classic].map((r) =>
      r.text.replace(/[\d]+/g, NUMBER_PLACEHOLDER)
    );
    for (const line of shown) {
      expect(poolWords.some((p) => p.includes(line.slice(0, 25)))).toBe(true);
    }
  });

  it("a query that matches NOTHING still returns exemplars, not silence", async () => {
    // An over-tight relevance floor would be a silent regression from five
    // recent exemplars to none - worse than the recency it replaced.
    rows = POOL;
    const out = await loadCoaching([], "zzzz qqqq xxxx");
    expect(out).toContain("LEARNED STYLE");
    expect(out.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThan(0);
  });

  it("an empty pool stays empty - ranking adds nothing", async () => {
    rows = {};
    expect(await loadCoaching([], "anything at all")).toBe("");
  });
});

describe("a ranked exemplar carries no number into the prompt", () => {
  it("prices in exemplars are replaced", async () => {
    rows = { distilled: [{ text: "Counter at 250 when they open at 300 for a week" }] };
    const out = await loadCoaching([], "how much for a week");
    expect(out).toContain(NUMBER_PLACEHOLDER);
    expect(out).not.toMatch(/250|300/);
  });

  it("but the OWNER'S LESSONS keep their numbers - the number is the lesson", async () => {
    // "a 7-day quote is not a daily rate" is ABOUT the figure. Stripping it
    // would turn a correction into a riddle.
    rows = {
      lessons: [{ text: "A 7 day quote divided by 7 is not the daily rate" }],
      distilled: POOL.distilled,
    };
    const out = await loadCoaching(["option-menu"], "we do 7 days for 2000");
    expect(out).toMatch(/A 7 day quote divided by 7/);
  });

  it("the tactics survive the stripping - that is what an exemplar is for", async () => {
    rows = { distilled: [{ text: "Offer 250 only if they include the helmet and delivery" }] };
    const out = await loadCoaching([], "what can you do on price");
    expect(out).toMatch(/include the helmet and delivery/);
  });
});

describe("the ranking is per-turn, the READS are not", () => {
  it("two different turns reuse one set of database reads", async () => {
    rows = POOL;
    await loadCoaching([], "out of stock");
    const afterFirst = selectCalls;
    await loadCoaching([], "price board photo");
    expect(selectCalls).toBe(afterFirst); // cached candidates, fresh ordering
  });

  it("and they still get DIFFERENT blocks from that one read", async () => {
    rows = POOL;
    const a = await loadCoaching([], "out of stock this week");
    const b = await loadCoaching([], "photo of our price board");
    expect(a).not.toBe(b);
  });

  it("the 1400-character cap is unchanged", async () => {
    rows = { distilled: Array.from({ length: 10 }, (_, i) => ({ text: `${"x".repeat(280)}${i}` })) };
    const out = await loadCoaching([], "x");
    expect(out.length).toBeLessThanOrEqual(1400);
  });
});
