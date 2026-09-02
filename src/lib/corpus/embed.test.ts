import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// The fetch double is the whole point of several of these: "falls back to
// lexical without a network call" is a claim about what does NOT happen, so it
// has to be measured rather than asserted.
let fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

let reservation: "ok" | "over-cap" | "ungoverned" = "ungoverned";
vi.mock("../ai-budget", () => ({
  reserveAiCall: async () => reservation,
}));

let config: Record<string, string | null> = {};
vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => config[k] ?? null,
}));

import {
  EMBED_DIM,
  EMBED_PROVIDER,
  LEXICAL_MODEL,
  NEURAL_MODEL,
  contentHash,
  cosine,
  embedText,
  lexicalEmbed,
  neuralEmbed,
  normalizeSnippet,
  SNIPPET_MAX,
} from "./embed";
import { DEFAULT_RPD, DEFAULT_RPM, resetRpmBuckets, tryConsume } from "../ai-rpm";

beforeEach(() => {
  fetchCalls = [];
  reservation = "ungoverned";
  config = {};
  resetRpmBuckets();
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    fetchCalls.push(String(url));
    throw new Error("no network in tests");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const norm = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));

// Pinned from the shipped implementation - see the fingerprint test below.
const FINGERPRINT_BUCKETS = [47, 66, 160, 170, 220, 362];
const FINGERPRINT_FIRST = "0.229415734";

describe("the lexical rung is deterministic, unit-length and 768-wide", () => {
  it("returns byte-identical output twice", () => {
    const a = lexicalEmbed("450 baht per day, helmet included");
    const b = lexicalEmbed("450 baht per day, helmet included");
    expect(a).not.toBeNull();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("is 768-dimensional and L2-normalized", () => {
    const e = lexicalEmbed("scooter available tomorrow morning")!;
    expect(e.vector.length).toBe(EMBED_DIM);
    expect(EMBED_DIM).toBe(768);
    expect(norm(e.vector)).toBeCloseTo(1, 10);
    expect(e.dim).toBe(EMBED_DIM);
  });

  it("carries a model id that is NOT the neural one", () => {
    // The distinct id is the safety property: cosine across the two spaces is
    // meaningless rather than merely inaccurate, and it does not fail loudly.
    expect(lexicalEmbed("hello")!.model).toBe(LEXICAL_MODEL);
    expect(LEXICAL_MODEL).not.toBe(NEURAL_MODEL);
  });

  it("survives non-Latin script instead of deleting it", () => {
    // normalizeForSig's [^a-z0-9 ] class would erase this entirely - the same
    // ASCII-only trap documented for wa/similarity.ts. Two DIFFERENT Thai lines
    // must not collapse onto one vector.
    const a = lexicalEmbed("รถสกูตเตอร์ 300 บาทต่อวัน")!;
    const b = lexicalEmbed("มอเตอร์ไซค์ใหญ่ 900 บาทต่อวัน")!;
    expect(a.vector.length).toBe(EMBED_DIM);
    expect(cosine(a.vector, b.vector)).toBeLessThan(0.99);
  });

  it("is null rather than an all-zero vector when there is nothing to embed", () => {
    // A direction-less vector has cosine 0 against everything, so storing one
    // would be a row that silently matches nothing while counting as embedded.
    expect(lexicalEmbed("")).toBeNull();
    expect(lexicalEmbed("   \n  ")).toBeNull();
  });

  it("has a STABLE fingerprint - the vector space cannot drift under one model id", () => {
    // Every row in the corpus is stored under `lexical:v1` and compared only
    // against other `lexical:v1` rows. If the hashing changes - a different
    // salt, a different gram width, a stray edit - old rows and new rows stop
    // living in the same space, and cosine between them starts returning
    // plausible nonsense instead of failing. There is no runtime signal for
    // that, so the fingerprint is pinned here: change it deliberately, and
    // bump the model id to v2 in the same commit.
    const e = lexicalEmbed("we can do 400 per day")!;
    const nonZero = e.vector.map((x, i) => (x !== 0 ? i : -1)).filter((i) => i >= 0);
    expect(nonZero.slice(0, 6)).toEqual(FINGERPRINT_BUCKETS);
    expect(e.vector[FINGERPRINT_BUCKETS[0]].toFixed(9)).toBe(FINGERPRINT_FIRST);
  });

  it("spreads across many dimensions rather than clustering", () => {
    // The hand-rolled djb2 that shipped in this repo once clustered so hard a
    // seeded 50/50 rule fired 100/0 - implemented-looking and inert. Measure it.
    const e = lexicalEmbed(
      "good morning we have a Honda Click 125 available from Tuesday, 320 per day for a week"
    )!;
    const used = e.vector.filter((x) => x !== 0).length;
    expect(used).toBeGreaterThan(30);
  });
});

describe("normalization and hashing", () => {
  it("collapses whitespace and caps at SNIPPET_MAX", () => {
    expect(normalizeSnippet("  a\n\n  b  ")).toBe("a b");
    expect(normalizeSnippet("x".repeat(5000)).length).toBe(SNIPPET_MAX);
  });

  it("the hash is stable and follows the NORMALIZED text, not the raw text", () => {
    expect(contentHash("450 per day")).toBe(contentHash("  450   per\nday  "));
    expect(contentHash("450 per day")).not.toBe(contentHash("460 per day"));
    expect(contentHash("a")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cosine is only ever asked about same-model vectors", () => {
  it("a vector against itself is 1, and length mismatch is 0 rather than a throw", () => {
    const e = lexicalEmbed("same text")!;
    expect(cosine(e.vector, e.vector)).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});

describe("the neural rung fails closed, to lexical, never to an exception", () => {
  it("returns null with no key AND makes no network call", async () => {
    expect(await neuralEmbed("anything")).toBeNull();
    expect(fetchCalls).toEqual([]);
  });

  it("returns null on empty text with no network call", async () => {
    config = { GEMINI_TOKEN: "k" };
    expect(await neuralEmbed("   ")).toBeNull();
    expect(fetchCalls).toEqual([]);
  });

  it("a thrown fetch is null, not a rejection", async () => {
    config = { GEMINI_TOKEN: "k" };
    expect(await neuralEmbed("a real sentence")).toBeNull();
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]).toContain("text-embedding-004");
  });

  it("a wrong-dimension response is refused rather than stored", async () => {
    config = { GEMINI_TOKEN: "k" };
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    })) as unknown as typeof fetch;
    expect(await neuralEmbed("a real sentence")).toBeNull();
  });

  it("an all-zero response of the RIGHT length is refused too", async () => {
    config = { GEMINI_TOKEN: "k" };
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ embedding: { values: new Array(768).fill(0) } }),
    })) as unknown as typeof fetch;
    expect(await neuralEmbed("a real sentence")).toBeNull();
  });

  it("a well-formed response is accepted and stamped with the neural id", async () => {
    config = { GEMINI_TOKEN: "k" };
    const values = new Array(768).fill(0);
    values[3] = 1;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ embedding: { values } }),
    })) as unknown as typeof fetch;
    const e = await neuralEmbed("a real sentence");
    expect(e?.model).toBe(NEURAL_MODEL);
    expect(e?.vector.length).toBe(768);
  });
});

describe("the budget is honored, and over-cap costs nothing", () => {
  it("OVER-CAP takes the lexical rung with ZERO network calls", async () => {
    reservation = "over-cap";
    config = { GEMINI_TOKEN: "k" };
    const e = await embedText("shop says 400 a day");
    expect(e?.model).toBe(LEXICAL_MODEL);
    expect(fetchCalls).toEqual([]); // the whole mitigation, measured
  });

  it("a spent minute also degrades to lexical rather than refusing", async () => {
    reservation = "ok";
    config = { GEMINI_TOKEN: "k" };
    // Spent AT THE CURRENT INSTANT: the bucket refills with elapsed time, so
    // draining it at a fixed past timestamp would be fully refilled by the time
    // embedText asks - which is the bucket working, not a bug.
    const now = Date.now();
    for (let i = 0; i < DEFAULT_RPM[EMBED_PROVIDER]; i++) tryConsume(EMBED_PROVIDER, now);
    const e = await embedText("shop says 400 a day");
    expect(e?.model).toBe(LEXICAL_MODEL);
    expect(fetchCalls).toEqual([]);
  });

  it("empty text embeds to nothing at all", async () => {
    expect(await embedText("  ")).toBeNull();
    expect(fetchCalls).toEqual([]);
  });
});

describe("the embedder counter is GOVERNED, and separate from chat gemini", () => {
  it("has both a minute and a day ceiling", () => {
    // ai-rpm returns true for an unknown ceiling ("never our place to refuse"),
    // so a counter with no entry is ungoverned BY CONSTRUCTION.
    expect(DEFAULT_RPM[EMBED_PROVIDER]).toBeGreaterThan(0);
    expect(DEFAULT_RPD[EMBED_PROVIDER]).toBeGreaterThan(0);
  });

  it("the ceiling is real: tryConsume eventually returns false", () => {
    let allowed = 0;
    const now = Date.now();
    for (let i = 0; i < DEFAULT_RPM[EMBED_PROVIDER] + 5; i++) {
      if (tryConsume(EMBED_PROVIDER, now)) allowed++;
    }
    expect(allowed).toBeLessThan(DEFAULT_RPM[EMBED_PROVIDER] + 5);
  });

  it("spending the embedder does NOT spend the chat gemini rung", () => {
    // One shared counter would let a backfill starve the negotiation chain.
    const now = Date.now();
    for (let i = 0; i < DEFAULT_RPM[EMBED_PROVIDER] + 5; i++) tryConsume(EMBED_PROVIDER, now);
    expect(EMBED_PROVIDER).not.toBe("gemini");
    expect(tryConsume("gemini", now)).toBe(true);
  });
});
