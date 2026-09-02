import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// The gate is built on sbSelectStrict via schema-probe, so the double is at
// THAT layer - the real tableReady, the real cache, the real TTL semantics run.
type Strict<T> = { rows: T[] } | { error: "missing" | "unavailable" };
let strict: Strict<Record<string, unknown>> = { rows: [] };
let selectDark: Record<string, unknown>[] | null = [];
let counts: Record<string, number | null> = {};
let countCalls: string[] = [];

vi.mock("../runtime-config", () => ({
  sbSelectStrict: async () => strict,
  sbSelectDark: async () => selectDark,
  sbCountDark: async (_t: string, filter: string) => {
    countCalls.push(filter);
    // `in`, not `??`: the whole point of this helper is that null (unreadable)
    // is a DIFFERENT answer from 0, and `??` would erase the distinction inside
    // the double itself.
    return filter in counts ? counts[filter] : 0;
  },
}));

let events: { kind: string }[] = [];
// Only the WRITER is doubled - AGENT_EVENT_KINDS stays the real list, because
// one of the assertions below is precisely that the gate's kind is registered
// in it. A wholesale module replacement would have made that test vacuous.
vi.mock("../events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../events")>()),
  noteAgentEvent: async (e: { kind: string }) => {
    events.push(e);
    return true;
  },
}));

import { corpusDepth, corpusReady, CORPUS_GATE_KIND } from "./gate";
import { NEGATIVE_TTL_MS, resetSchemaProbeCache } from "../schema-probe";
import { LEXICAL_MODEL, NEURAL_MODEL } from "./embed";
import { AGENT_EVENT_KINDS } from "../events";

beforeEach(() => {
  resetSchemaProbeCache();
  strict = { rows: [] };
  selectDark = [];
  counts = {};
  countCalls = [];
  events = [];
});

describe("the three states, and the third is the point", () => {
  it("a readable table is ready", async () => {
    expect(await corpusReady()).toBe("ready");
    expect(events).toEqual([]);
  });

  it("MISSING breadcrumbs exactly ONCE across fifty calls", async () => {
    // The trap retention.ts names: the thing that would gate the re-attempt is
    // the row the missing thing never wrote. Here the breadcrumb gates itself.
    strict = { error: "missing" };
    for (let i = 0; i < 50; i++) {
      // After the first write the store contains the row, so the gate reads it
      // back and stops writing - exactly what production does.
      selectDark = events.length > 0 ? [{ id: 1 }] : [];
      expect(await corpusReady()).toBe("missing");
    }
    expect(events.map((e) => e.kind)).toEqual([CORPUS_GATE_KIND]);
  });

  it("UNAVAILABLE never breadcrumbs - an outage is not a migration signal", async () => {
    strict = { error: "unavailable" };
    for (let i = 0; i < 20; i++) expect(await corpusReady()).toBe("unavailable");
    expect(events).toEqual([]);
  });

  it("an unreadable EVENT store does not manufacture a breadcrumb either", async () => {
    strict = { error: "missing" };
    selectDark = null; // sbSelectDark's "unknown"
    expect(await corpusReady()).toBe("missing");
    expect(events).toEqual([]);
  });

  it("the breadcrumb kind is registered, or noteAgentEvent silently refuses it", () => {
    // events.ts hard-refuses an unlisted kind and returns false. An unregistered
    // gate kind would mean the breadcrumb never writes AND the gate re-fires on
    // every single turn for ever.
    expect(AGENT_EVENT_KINDS as readonly string[]).toContain(CORPUS_GATE_KIND);
    expect(AGENT_EVENT_KINDS as readonly string[]).toContain("corpus-backfill");
  });

  it("the kind WRITTEN is the kind the read filter looks for", () => {
    // The write site spells the kind as a literal so events-reconcile can see
    // it; the read filter uses the constant. If those two ever drift, the gate
    // breadcrumbs a row it can never find again and re-fires on every turn -
    // silently, and for ever. So the drift is what is pinned.
    strict = { error: "missing" };
    return corpusReady().then(() => {
      expect(events.map((e) => e.kind)).toEqual([CORPUS_GATE_KIND]);
    });
  });
});

describe("the owner pastes the SQL and it turns itself on - no redeploy", () => {
  it("a negative expires after NEGATIVE_TTL_MS and re-probes", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
      strict = { error: "missing" };
      expect(await corpusReady()).toBe("missing");

      // The owner enables pgvector and re-runs schema.sql. Within the negative
      // TTL the cache still says missing...
      strict = { rows: [] };
      vi.setSystemTime(new Date("2026-09-02T00:00:00Z").getTime() + NEGATIVE_TTL_MS - 1_000);
      expect(await corpusReady()).toBe("missing");

      // ...and past it, the feature is live with no deploy.
      vi.setSystemTime(new Date("2026-09-02T00:00:00Z").getTime() + NEGATIVE_TTL_MS + 1_000);
      expect(await corpusReady()).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("depth is honest about what it could not read", () => {
  it("a non-ready gate reports nulls, never a confident zero", async () => {
    strict = { error: "unavailable" };
    const d = await corpusDepth();
    expect(d).toEqual({ state: "unavailable", queued: null, neural: null, lexical: null });
    expect(countCalls).toEqual([]); // nothing is even asked
  });

  it("a ready gate counts the queue and BOTH models separately", async () => {
    counts = {
      "embedding=is.null": 7,
      [`embed_model=eq.${encodeURIComponent(NEURAL_MODEL)}&embedding=not.is.null`]: 42,
      [`embed_model=eq.${encodeURIComponent(LEXICAL_MODEL)}&embedding=not.is.null`]: 3,
    };
    const d = await corpusDepth();
    expect(d).toEqual({ state: "ready", queued: 7, neural: 42, lexical: 3 });
  });

  it("every count filters on embed_model, so the two spaces are never mixed", async () => {
    await corpusDepth();
    const modelled = countCalls.filter((f) => f.includes("embed_model=eq."));
    expect(modelled.length).toBe(2);
    expect(modelled.some((f) => f.includes(encodeURIComponent(NEURAL_MODEL)))).toBe(true);
    expect(modelled.some((f) => f.includes(encodeURIComponent(LEXICAL_MODEL)))).toBe(true);
  });

  it("an unreadable count is null, not zero", async () => {
    counts = { "embedding=is.null": null };
    const d = await corpusDepth();
    expect(d.queued).toBeNull();
  });
});
