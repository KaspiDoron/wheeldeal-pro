import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

let embedResult: { model: string; vector: number[]; dim: number } | null = null;
vi.mock("./embed", async (importOriginal) => {
  const real = await importOriginal<typeof import("./embed")>();
  return { ...real, embedText: async () => embedResult };
});

import {
  NUMBER_PLACEHOLDER,
  freeQueryVector,
  queryVector,
  rankBySimilarity,
  stripNumbers,
} from "./retrieve";
import { EMBED_DIM, LEXICAL_MODEL, lexicalEmbed } from "./embed";

beforeEach(() => {
  embedResult = null;
});

/** A unit vector pointing along one axis - trivially orderable by construction. */
const axis = (i: number) => {
  const v = new Array(EMBED_DIM).fill(0);
  v[i] = 1;
  return v;
};

type Item = { id: string; v?: number[] | null };
const vecOf = (x: Item) => x.v;

describe("THE INVARIANT: the output is a subsequence of the input, by identity", () => {
  it("returns the SAME objects, never copies or new ones", () => {
    const items: Item[] = [
      { id: "a", v: axis(0) },
      { id: "b", v: axis(1) },
    ];
    const out = rankBySimilarity(items, axis(1), vecOf);
    expect(out.map((s) => s.item)).toHaveLength(2);
    // Object identity, not deep equality: a copy would pass toEqual and would
    // mean retrieval had CONSTRUCTED a candidate rather than selected one.
    expect(out.some((s) => s.item === items[0])).toBe(true);
    expect(out.some((s) => s.item === items[1])).toBe(true);
  });

  it("can never grow the set, on any input shape", () => {
    const shapes: { items: Item[]; q: number[] | null }[] = [
      { items: [], q: axis(0) },
      { items: [{ id: "a" }], q: null },
      { items: [{ id: "a", v: null }, { id: "b", v: axis(2) }], q: axis(2) },
      { items: [{ id: "a", v: axis(0) }], q: new Array(EMBED_DIM).fill(NaN) },
      { items: [{ id: "a", v: axis(0) }], q: new Array(EMBED_DIM).fill(0) },
      { items: [{ id: "a", v: [1, 2] }], q: axis(0) }, // wrong-width item vector
      { items: [{ id: "a", v: axis(0) }], q: [1, 2, 3] }, // wrong-width query
    ];
    for (const { items, q } of shapes) {
      const out = rankBySimilarity(items, q, vecOf);
      expect(out.length).toBeLessThanOrEqual(items.length);
      for (const s of out) expect(items).toContain(s.item);
    }
  });

  it("a limit only ever removes", () => {
    const items: Item[] = [0, 1, 2, 3, 4].map((i) => ({ id: String(i), v: axis(i) }));
    const out = rankBySimilarity(items, axis(3), vecOf, { limit: 2 });
    expect(out).toHaveLength(2);
    for (const s of out) expect(items).toContain(s.item);
  });
});

describe("an unscored row behaves exactly as today - it is never refused", () => {
  it("keeps items with no vector, scored null", () => {
    // Refusing them would silently disable the feature the moment a backfill
    // lagged - the corpus fills asynchronously by design.
    const items: Item[] = [{ id: "scored", v: axis(1) }, { id: "unscored", v: null }];
    const out = rankBySimilarity(items, axis(1), vecOf);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.item.id === "unscored")!.score).toBeNull();
  });

  it("minScore drops WEAK matches but never UNMEASURED ones", () => {
    // "not measured" must not read as "not relevant".
    const items: Item[] = [
      { id: "near", v: axis(1) },
      { id: "far", v: axis(2) },
      { id: "none", v: null },
    ];
    const out = rankBySimilarity(items, axis(1), vecOf, { minScore: 0.5 });
    expect(out.map((s) => s.item.id).sort()).toEqual(["near", "none"]);
  });

  it("scored items come first, unscored keep their relative order", () => {
    const items: Item[] = [
      { id: "u1", v: null },
      { id: "hit", v: axis(4) },
      { id: "u2", v: null },
    ];
    const out = rankBySimilarity(items, axis(4), vecOf).map((s) => s.item.id);
    expect(out).toEqual(["hit", "u1", "u2"]);
  });
});

describe("a query with no direction has no opinion", () => {
  it("a null query leaves the input order untouched", () => {
    const items: Item[] = [{ id: "a", v: axis(0) }, { id: "b", v: axis(1) }];
    expect(rankBySimilarity(items, null, vecOf).map((s) => s.item.id)).toEqual(["a", "b"]);
  });

  it("a NaN-bearing query scores nothing rather than ordering by garbage", () => {
    const q = axis(0);
    q[5] = NaN;
    const items: Item[] = [{ id: "a", v: axis(0) }, { id: "b", v: axis(1) }];
    const out = rankBySimilarity(items, q, vecOf);
    expect(out.every((s) => s.score === null)).toBe(true);
    expect(out.map((s) => s.item.id)).toEqual(["a", "b"]);
  });

  it("real ordering happens when the query IS usable", () => {
    // The guard above must not be so broad that it disables the feature.
    const items: Item[] = [{ id: "far", v: axis(9) }, { id: "near", v: axis(3) }];
    const out = rankBySimilarity(items, axis(3), vecOf);
    expect(out[0].item.id).toBe("near");
    expect(out[0].score).toBeCloseTo(1, 10);
  });
});

describe("retrieved text carries no numbers into a prompt", () => {
  it("strips prices, whatever the script of the digits", () => {
    expect(stripNumbers("400 baht per day")).toBe(`${NUMBER_PLACEHOLDER} baht per day`);
    expect(stripNumbers("٤٠٠ باهت")).toBe(`${NUMBER_PLACEHOLDER} باهت`);
    expect(stripNumbers("๓๐๐ บาท")).toBe(`${NUMBER_PLACEHOLDER} บาท`);
  });

  it("a separated number collapses to ONE placeholder, not three", () => {
    // "1,500" reading as three numbers would be worse than leaving it alone.
    expect(stripNumbers("1,500 per week")).toBe(`${NUMBER_PLACEHOLDER} per week`);
    expect(stripNumbers("1 500.50")).toBe(NUMBER_PLACEHOLDER);
  });

  it("leaves the tactics, which is the whole point of an exemplar", () => {
    const out = stripNumbers("I can do 350 if you take it for the whole week");
    expect(out).toBe(`I can do ${NUMBER_PLACEHOLDER} if you take it for the whole week`);
    expect(out).toContain("whole week");
  });

  it("no digit survives, on a nasty mixed string", () => {
    const out = stripNumbers("Honda Click 125i, 2 bikes, 300-350/day, call 0812345678");
    expect(out).not.toMatch(/[\d٠-٩۰-۹๐-๙]/);
  });
});

describe("the query vector carries its model, and the free one is free", () => {
  it("queryVector passes the embedder's model through", async () => {
    embedResult = { model: "gemini:text-embedding-004", vector: axis(1), dim: EMBED_DIM };
    expect((await queryVector("a shop reply"))?.model).toBe("gemini:text-embedding-004");
  });

  it("queryVector is null rather than throwing when the embedder gives nothing", async () => {
    embedResult = null;
    expect(await queryVector("a shop reply")).toBeNull();
  });

  it("freeQueryVector is the lexical rung - deterministic and keyless", () => {
    const a = freeQueryVector("400 a day for the scooter");
    expect(a?.model).toBe(LEXICAL_MODEL);
    expect(JSON.stringify(a)).toBe(JSON.stringify(lexicalEmbed("400 a day for the scooter")));
  });
});
