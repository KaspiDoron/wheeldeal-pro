import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// A RECORDING DOUBLE, not a stub: several of these assertions are about which
// tables are written and with what filter, which cannot be checked by looking
// at a return value.
let claimResult: "won" | "lost" | "error" = "won";
let claimRows: { table: string; row: Record<string, unknown> }[] = [];
let claimHangs = false;
let insertCalls: string[] = [];
let selectDark: { id: number; snippet: string | null }[] | null = [];
let updates: { table: string; filter: string; values: Record<string, unknown> }[] = [];
let updateOk = true;

vi.mock("../runtime-config", () => ({
  // Present so a call is RECORDED rather than silently unresolvable: the
  // upsert helper must never be reached from either stage.
  sbInsert: async (table: string) => {
    insertCalls.push(table);
    return true;
  },
  sbInsertClaim: async (table: string, row: Record<string, unknown>) => {
    claimRows.push({ table, row });
    if (claimHangs) return new Promise(() => {});
    return claimResult;
  },
  sbSelectDark: async () => selectDark,
  sbUpdate: async (table: string, filter: string, values: Record<string, unknown>) => {
    updates.push({ table, filter, values });
    return updateOk;
  },
}));

let gate: "ready" | "missing" | "unavailable" = "ready";
vi.mock("./gate", () => ({ corpusReady: async () => gate }));

let embedResult: { model: string; vector: number[]; dim: number } | null = null;
vi.mock("./embed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embed")>()),
  embedText: async () => embedResult,
}));

let events: { kind: string; detail: string }[] = [];
vi.mock("../events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../events")>()),
  noteAgentEvent: async (e: { kind: string; detail: string }) => {
    events.push(e);
    return true;
  },
}));

import { BACKFILL_BATCH, enqueueCorpus, runCorpusBackfill } from "./sidecar";
import { EMBED_DIM, LEXICAL_MODEL, NEURAL_MODEL, contentHash } from "./embed";

beforeEach(() => {
  claimResult = "won";
  claimRows = [];
  claimHangs = false;
  insertCalls = [];
  selectDark = [];
  updates = [];
  updateOk = true;
  gate = "ready";
  embedResult = { model: NEURAL_MODEL, vector: new Array(EMBED_DIM).fill(0.1), dim: EMBED_DIM };
  events = [];
});

const args = (over: Partial<Parameters<typeof enqueueCorpus>[0]> = {}) => ({
  sourceTable: "whatsapp_messages",
  sourceId: "WA123",
  text: "we can do 400 per day for a week",
  userEmail: "t@example.com",
  ...over,
});

describe("stage A writes ONE row, to ONE table, with no vector", () => {
  it("enqueues with embedding null - the queue entry IS the un-embedded row", async () => {
    expect(await enqueueCorpus(args())).toBe("queued");
    expect(claimRows.length).toBe(1);
    expect(claimRows[0].table).toBe("corpus_embeddings");
    expect(claimRows[0].row.embedding).toBeNull();
    expect(claimRows[0].row.embed_model).toBe(NEURAL_MODEL);
    expect(claimRows[0].row.dim).toBe(EMBED_DIM);
    expect(claimRows[0].row.user_email).toBe("t@example.com");
    expect(claimRows[0].row.content_hash).toBe(contentHash("we can do 400 per day for a week"));
  });

  it("touches NOTHING but corpus_embeddings - the offers ladder is untouched", async () => {
    await enqueueCorpus(args());
    await runCorpusBackfill();
    const tables = new Set([...claimRows.map((c) => c.table), ...updates.map((u) => u.table)]);
    expect([...tables]).toEqual(["corpus_embeddings"]);
    // agent_events is the only other table this module may write, and only
    // through noteAgentEvent.
    expect(events.every((e) => e.kind.startsWith("corpus-"))).toBe(true);
  });

  it("a second enqueue of the same identity is 'already', not a second row", async () => {
    // The 409 only exists because of the unique index on
    // (embed_model, source_table, source_id) - load-bearing, not hygiene.
    claimResult = "lost";
    expect(await enqueueCorpus(args())).toBe("already");
  });

  it("uses a CLAIM and never the upsert helper, on either stage", async () => {
    // sbInsert(..., onConflict) sends resolution=merge-duplicates, i.e. an
    // UPSERT - which on a re-enqueue would overwrite an already-computed vector
    // with null. Measured rather than grepped: the double records every call,
    // so this is about what the code DOES, not what the file says.
    claimResult = "lost";
    await enqueueCorpus(args());
    selectDark = [{ id: 1, snippet: "a" }];
    await runCorpusBackfill();
    expect(insertCalls).toEqual([]);
    expect(claimRows.length).toBe(1);
  });
});

describe("stage A cannot cost the turn anything", () => {
  it("skips entirely below the remaining-turn floor, with no write at all", async () => {
    expect(await enqueueCorpus(args({ remainingMs: 500 }))).toBe("skipped");
    expect(claimRows).toEqual([]);
  });

  it("skips when the gate is not ready, with no write at all", async () => {
    gate = "missing";
    expect(await enqueueCorpus(args())).toBe("skipped");
    expect(claimRows).toEqual([]);
  });

  it("a NEVER-RESOLVING insert still returns, inside its own ceiling", async () => {
    vi.useFakeTimers();
    try {
      claimHangs = true;
      const p = enqueueCorpus(args());
      let settled = false;
      void p.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_400);
      expect(settled).toBe(false); // still inside the ceiling
      await vi.advanceTimersByTimeAsync(400);
      expect(await p).toBe("skipped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("empty text and a missing id are refused before any network call", async () => {
    expect(await enqueueCorpus(args({ text: "   " }))).toBe("skipped");
    expect(await enqueueCorpus(args({ sourceId: "" }))).toBe("skipped");
    expect(claimRows).toEqual([]);
  });

  it("an insert error is reported, never breadcrumbed", async () => {
    // sbInsertClaim folds a missing table into "error" along with every network
    // failure, so an error here cannot be read as a migration signal.
    claimResult = "error";
    expect(await enqueueCorpus(args())).toBe("error");
    expect(events).toEqual([]);
  });
});

describe("stage B is where the embedding happens, bounded and concurrent-safe", () => {
  it("writes the vector back filtered on embedding=is.null", async () => {
    selectDark = [{ id: 5, snippet: "400 a day" }];
    const res = await runCorpusBackfill();
    expect(res.embedded).toBe(1);
    expect(updates[0].filter).toBe("id=eq.5&embedding=is.null");
    expect(updates[0].values.embed_model).toBe(NEURAL_MODEL);
    expect((updates[0].values.embedding as number[]).length).toBe(EMBED_DIM);
  });

  it("a row another sweep already filled counts as skipped, not embedded", async () => {
    selectDark = [{ id: 5, snippet: "400 a day" }];
    updateOk = false; // the filter matched nothing - somebody else won
    const res = await runCorpusBackfill();
    expect(res).toMatchObject({ embedded: 0, skipped: 1 });
    expect(events).toEqual([]); // nothing embedded, nothing to report
  });

  it("an UNREADABLE queue is not a cheerful empty one", async () => {
    selectDark = null;
    expect(await runCorpusBackfill()).toMatchObject({ reason: "unreadable" });
    expect(updates).toEqual([]);
  });

  it("a not-ready gate does no work and asks nothing", async () => {
    gate = "missing";
    expect(await runCorpusBackfill()).toMatchObject({ reason: "not-ready" });
    expect(updates).toEqual([]);
  });

  it("an empty queue is reported as empty", async () => {
    expect(await runCorpusBackfill()).toMatchObject({ reason: "empty" });
  });

  it("reads a BOUNDED batch, oldest first", async () => {
    const src = (await import("fs")).readFileSync("src/lib/corpus/sidecar.ts", "utf8");
    expect(src).toMatch(/order=created_at\.asc&limit=\$\{batch\}/);
    expect(BACKFILL_BATCH).toBeGreaterThan(0);
    expect(BACKFILL_BATCH).toBeLessThanOrEqual(100);
  });

  it("a row the embedder refuses is skipped, never written as an empty vector", async () => {
    selectDark = [{ id: 9, snippet: "x" }];
    embedResult = null;
    const res = await runCorpusBackfill();
    expect(res).toMatchObject({ embedded: 0, skipped: 1 });
    expect(updates).toEqual([]);
  });

  it("a lexical fallback rewrites the row's model, so the spaces stay separate", async () => {
    // The queue row was stamped neural; if the embedder had to fall back, the
    // row must say lexical or a later read would compare across two spaces.
    selectDark = [{ id: 11, snippet: "400 a day" }];
    embedResult = { model: LEXICAL_MODEL, vector: new Array(EMBED_DIM).fill(0.2), dim: EMBED_DIM };
    await runCorpusBackfill();
    expect(updates[0].values.embed_model).toBe(LEXICAL_MODEL);
  });

  it("reports one batch summary when it actually embedded something", async () => {
    selectDark = [{ id: 1, snippet: "a" }, { id: 2, snippet: "b" }];
    await runCorpusBackfill();
    expect(events.map((e) => e.kind)).toEqual(["corpus-backfill"]);
    expect(JSON.parse(events[0].detail)).toMatchObject({ embedded: 2, read: 2 });
  });
});
