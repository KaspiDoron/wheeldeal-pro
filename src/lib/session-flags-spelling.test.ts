import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT F176 - human takeover was stored and matched on an EXACT number spelling.
//
// Two writers hold two spellings of one shop by construction: the in-app toggle
// (/api/thread/takeover) resolves the newest OUTBOUND row's to_number - Google's
// national "09776620146" - while the ingest detector stamps WhatsApp's inbound
// JID digits "639776620146". isThreadTakenOver matched `raw->>digits=eq.` and
// cached under the raw spelling, so a takeover the traveller switched on in the
// app was invisible to the reply gate, and the agent talked over them. Every
// test here RUNS setThreadTakeover / isThreadTakenOver against a marker store
// that honours the same PostgREST filter grammar production does.

interface Marker {
  sender: string;
  digits: string;
  digitsKey?: string;
  kind: string;
  at: number;
}

const state: {
  markers: Marker[];
  mode: "ok" | "missing" | "unavailable";
  clock: number;
  queries: string[];
} = { markers: [], mode: "ok", clock: 1_700_000_000_000, queries: [] };

/** Every `col.eq.v` clause of a PostgREST `or=(...)` group. */
function orClauses(query: string): { col: string; op: string; value: string }[] {
  const group = /(?:^|&)or=\(([^)]*)\)/.exec(query)?.[1];
  if (!group) return [];
  return group.split(",").map((c) => {
    const m = /^(.+?)\.(eq|like|in)\.(.+)$/.exec(c);
    if (!m) throw new Error(`unparseable or-clause: ${c}`);
    return { col: m[1], op: m[2], value: m[3] };
  });
}

vi.mock("./runtime-config", () => ({
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    if (table !== "whatsapp_messages") return true;
    for (const r of rows) {
      const raw = r.raw as { sender: string; digits: string; digitsKey?: string; kind: string };
      state.markers.push({
        sender: raw.sender,
        digits: raw.digits,
        ...(raw.digitsKey ? { digitsKey: raw.digitsKey } : {}),
        kind: raw.kind,
        at: state.clock++,
      });
    }
    return true;
  },
  sbSelectStrict: async (_table: string, query: string) => {
    state.queries.push(query);
    if (state.mode !== "ok") return { error: state.mode };
    const sender = decodeURIComponent(/raw->>sender=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const exact = decodeURIComponent(/raw->>digits=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const kinds = (/raw->>kind=in\.\(([^)]*)\)/.exec(query)?.[1] ?? "").split(",");
    const clauses = orClauses(query);
    const digitsIn = clauses.filter((c) => c.col === "raw->>digits" && c.op === "eq").map((c) => c.value);
    const keys = clauses.filter((c) => c.col === "raw->>digitsKey" && c.op === "eq").map((c) => c.value);
    if (exact) digitsIn.push(exact);
    const rows = state.markers
      .filter(
        (m) =>
          m.sender === sender &&
          kinds.includes(m.kind) &&
          (digitsIn.includes(m.digits) || (m.digitsKey ? keys.includes(m.digitsKey) : false))
      )
      .sort((a, b) => b.at - a.at)
      .slice(0, 1)
      .map((m) => ({ raw: { kind: m.kind } }));
    return { rows };
  },
}));

import { isThreadTakenOver, setThreadTakeover } from "./session-flags";

const EMAIL = "traveller@example.com";
const NATIONAL = "09776620146"; // the app toggle: the newest outbound row's to_number
const INTERNATIONAL = "639776620146"; // the ingest detector: WhatsApp's inbound JID digits

const clearCache = () => {
  (globalThis as { __wd_takeover_flags__?: unknown }).__wd_takeover_flags__ = undefined;
};

beforeEach(() => {
  state.markers = [];
  state.mode = "ok";
  state.queries = [];
  clearCache();
});

describe("EXECUTED: a takeover under one spelling is seen under the other", () => {
  it("switched on in the app (outbound spelling), the reply gate asking with the JID digits sees it", async () => {
    await setThreadTakeover(EMAIL, NATIONAL, true);
    clearCache(); // another instance: no cache, the store is the truth
    // THE ASSERTION THAT FAILED BEFORE: exact `raw->>digits=eq.639776620146`
    // matched nothing, false came back, and the agent answered the shop.
    expect(await isThreadTakenOver(EMAIL, INTERNATIONAL)).toBe(true);
  });

  it("detected at ingest (JID spelling), the drain re-check asking with the outbox spelling sees it", async () => {
    await setThreadTakeover(EMAIL, INTERNATIONAL, true);
    clearCache();
    expect(await isThreadTakenOver(EMAIL, NATIONAL)).toBe(true);
  });

  it("a LEGACY marker (no canonical key stamped) is still found where a spelling can be derived", async () => {
    state.markers.push({ sender: EMAIL, digits: NATIONAL, kind: "human-takeover", at: state.clock++ });
    expect(await isThreadTakenOver(EMAIL, INTERNATIONAL)).toBe(true);
  });

  it("a handback under the OTHER spelling releases the thread - newest marker wins across spellings", async () => {
    await setThreadTakeover(EMAIL, NATIONAL, true);
    await setThreadTakeover(EMAIL, INTERNATIONAL, false);
    clearCache();
    expect(await isThreadTakenOver(EMAIL, NATIONAL)).toBe(false);
    expect(await isThreadTakenOver(EMAIL, INTERNATIONAL)).toBe(false);
  });

  it("a DIFFERENT shop is not swept up", async () => {
    await setThreadTakeover(EMAIL, NATIONAL, true);
    clearCache();
    expect(await isThreadTakenOver(EMAIL, "639771111111")).toBe(false);
  });
});

describe("EXECUTED: the 30s cache is ONE entry per shop, not one per spelling", () => {
  it("the app toggle's cached true serves the reply gate's spelling during a store blip", async () => {
    await setThreadTakeover(EMAIL, NATIONAL, true); // caches true under the canonical key
    state.mode = "unavailable";
    // Fail-closed direction: a stale true keeps holding. Under a per-spelling
    // cache this was a MISS, and the blip answered null instead of the truth.
    expect(await isThreadTakenOver(EMAIL, INTERNATIONAL)).toBe(true);
  });

  it("a fresh read under one spelling is served from cache under the other - no second query", async () => {
    state.markers.push({ sender: EMAIL, digits: NATIONAL, kind: "human-takeover", at: state.clock++ });
    expect(await isThreadTakenOver(EMAIL, NATIONAL)).toBe(true);
    const before = state.queries.length;
    expect(await isThreadTakenOver(EMAIL, INTERNATIONAL)).toBe(true);
    expect(state.queries.length).toBe(before);
  });
});

describe("the tri-state contract and the query shape are unchanged", () => {
  it("unavailable is still null (fail closed), missing is still false", async () => {
    state.mode = "unavailable";
    expect(await isThreadTakenOver(EMAIL, INTERNATIONAL)).toBe(null);
    state.mode = "missing";
    expect(await isThreadTakenOver(EMAIL, INTERNATIONAL)).toBe(false);
  });

  it("ONE select, the sentinel filter untouched, only `.eq.` clauses on jsonb paths in the or-group", async () => {
    await isThreadTakenOver(EMAIL, INTERNATIONAL);
    expect(state.queries).toHaveLength(1);
    const q = state.queries[0];
    expect(q).toMatch(/(^|&)to_number=eq\.takeover(&|$)/);
    expect(q).toMatch(/raw->>kind=in\.\(human-takeover,human-handback\)/);
    const clauses = orClauses(q);
    expect(clauses.length).toBeGreaterThan(0);
    for (const c of clauses) expect(c.op).toBe("eq");
    expect(q).not.toMatch(/raw->>[A-Za-z]+\.like\./);
  });
});
