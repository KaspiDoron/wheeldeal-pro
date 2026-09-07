// AUDIT F033 - the per-hunt thread reset must survive an in-flight turn.
//
// closeSearchSession deletes the per-search keys from negotiation_threads.fields
// and resets phase/stage/waiting_until, but it did so through a bare
// `thread_key=eq.<key>` PATCH that never touched `version`. A turn that had
// loaded the row BEFORE the close still matched its own `version=eq.N` cas
// afterwards and wrote the whole pre-close blob back - so the new hunt opened
// on a thread that already believed it was at round 3 with a standing quote and
// a shop that had walked away, which is exactly the failure the block at
// session-close.ts:90-97 exists to prevent.
//
// These tests EXECUTE closeSearchSession and saveThreadState against one
// Map-backed store, interleaved.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

interface StoreRow {
  thread_key: string;
  user_email: string;
  vendor_id: string | null;
  vendor_name: string | null;
  to_number: string;
  phase: string;
  stage: string | null;
  stage_at: string | null;
  version: number;
  fields: Record<string, unknown>;
  node_runs: Record<string, number>;
  waiting_until: string | null;
  last_decision_id: string | null;
  updated_at: string;
}

const store = new Map<string, StoreRow>();
const inserted: { table: string; rows: Record<string, unknown>[] }[] = [];
const hooks: { afterThreadRead: null | (() => void) } = { afterThreadRead: null };

function keyOf(query: string): string {
  return decodeURIComponent(/thread_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
}
function versionOf(query: string): number | null {
  const m = /version=eq\.(\d+)/.exec(query);
  return m ? Number(m[1]) : null;
}
function applyUpdate(filter: string, values: Record<string, unknown>): StoreRow | null {
  const row = store.get(keyOf(filter));
  if (!row) return null;
  const want = versionOf(filter);
  if (want !== null && row.version !== want) return null;
  const clean = JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
  const next = { ...row, ...clean } as StoreRow;
  store.set(next.thread_key, next);
  return next;
}

vi.mock("./runtime-config", () => ({
  sbSelect: async (table: string, query: string) => {
    if (table !== "negotiation_threads") return [];
    const key = /thread_key=eq\./.test(query) ? keyOf(query) : null;
    const email = decodeURIComponent(/user_email=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const rows = [...store.values()]
      .filter((r) => (key ? r.thread_key === key : r.user_email === email))
      .map((r) => JSON.parse(JSON.stringify(r)) as StoreRow);
    // The window read is the close's own; fire the interleaving hook after it.
    if (!key) {
      const h = hooks.afterThreadRead;
      hooks.afterThreadRead = null;
      h?.();
    }
    return rows;
  },
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    inserted.push({ table, rows });
    if (table === "negotiation_threads") {
      for (const r of rows) store.set(String(r.thread_key), JSON.parse(JSON.stringify(r)) as StoreRow);
    }
    return true;
  },
  sbUpdate: async (table: string, filter: string, values: Record<string, unknown>) => {
    if (table !== "negotiation_threads") return false;
    return applyUpdate(filter, values) !== null;
  },
  sbUpdateReturning: async (table: string, filter: string, values: Record<string, unknown>) => {
    if (table !== "negotiation_threads") return [];
    const row = applyUpdate(filter, values);
    return row ? [JSON.parse(JSON.stringify(row))] : [];
  },
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
}));

vi.mock("./wa/cancellations", () => ({
  cancelSends: async () => true,
  pruneCancellations: async () => true,
}));

import { closeSearchSession } from "./session-close";
import { loadThreadState, saveThreadState } from "./graph/state";

const EMAIL = "traveller@example.com";
const KEY = `${EMAIL}:66812345678`;

function seed(): void {
  store.set(KEY, {
    thread_key: KEY,
    user_email: EMAIL,
    vendor_id: "v1",
    vendor_name: "Shop X",
    to_number: "66812345678",
    phase: "closing",
    stage: "negotiating",
    stage_at: new Date(Date.now() - 120_000).toISOString(),
    version: 9,
    fields: {
      firmCount: 2,
      toneDegraded: false,
      rounds: 3,
      pricePerDay: 300,
      currency: "THB",
      priceBasisDays: 1,
      vehicleKey: "scooter-125",
      declined: true,
      language: { mode: "english", reason: "shop-asked", at: "2026-01-01T00:00:00.000Z" },
      digest: {
        quotedPricePerDay: 300,
        round: 3,
        facts: ["the shop walked away", "deposit is passport"],
      },
    },
    node_runs: {},
    waiting_until: new Date(Date.now() + 600_000).toISOString(),
    last_decision_id: null,
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  });
}

const closeNow = () =>
  closeSearchSession(EMAIL, { fromMs: Date.now() - 3600_000, beforeMs: Date.now() });

beforeEach(() => {
  store.clear();
  inserted.length = 0;
  hooks.afterThreadRead = null;
  (globalThis as { __wd_graph_threads__?: Map<string, unknown> }).__wd_graph_threads__ = new Map();
});

describe("closeSearchSession per-hunt reset (F033)", () => {
  it("is not undone by a turn that loaded the thread before the close", async () => {
    seed();
    // The turn loads at version 9 and spends 20s composing.
    const inflight = await loadThreadState(KEY);
    expect(inflight?.version).toBe(9);

    await closeNow();

    // ...and only now writes what it read before the close.
    await saveThreadState({
      ...inflight!,
      fields: { ...inflight!.fields, rounds: 4 },
    });

    const row = store.get(KEY)!;
    expect(row.fields.pricePerDay).toBeUndefined();
    expect(row.fields.rounds).toBeUndefined();
    expect(row.fields.firmCount).toBeUndefined();
    expect(row.fields.declined).toBeUndefined();
    expect(row.fields.priceBasisDays).toBeUndefined();
    const digest = row.fields.digest as {
      quotedPricePerDay?: number;
      round?: number;
      facts?: string[];
    };
    expect(digest.quotedPricePerDay).toBeUndefined();
    expect(digest.round).toBeUndefined();
    expect(digest.facts).toEqual(["deposit is passport"]);
    // The shop-durable half the close promises to keep is still there.
    expect((row.fields.language as { mode?: string } | undefined)?.mode).toBe("english");
    // And the close moved the version, so an in-flight cas cannot match it.
    expect(row.version).toBeGreaterThan(9);
    expect(row.phase).toBe("opening");
    expect(row.stage).toBeNull();
  });

  it("re-applies the reset to a row a turn moved mid-close", async () => {
    seed();
    // A turn lands between the close's read and its write.
    hooks.afterThreadRead = () => {
      const row = store.get(KEY)!;
      store.set(KEY, {
        ...row,
        version: row.version + 1,
        fields: {
          ...row.fields,
          rounds: 4,
          depositType: "passport",
          digest: { quotedPricePerDay: 290, round: 4, facts: ["the shop walked away"] },
        },
      });
    };

    await closeNow();

    const row = store.get(KEY)!;
    expect(row.fields.rounds).toBeUndefined();
    expect(row.fields.pricePerDay).toBeUndefined();
    // The fresher fact the turn wrote is kept - the reset is per-hunt, not a wipe.
    expect(row.fields.depositType).toBe("passport");
    const digest = row.fields.digest as { quotedPricePerDay?: number; facts?: string[] };
    expect(digest.quotedPricePerDay).toBeUndefined();
    expect(digest.facts).toEqual([]);
    expect(row.version).toBe(11);
  });
});
