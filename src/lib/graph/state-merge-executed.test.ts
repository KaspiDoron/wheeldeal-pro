// AUDIT F032 - the lost-race merge must not delete what the losing turn learned.
//
// saveThreadState is an optimistic UPDATE ... WHERE version = n. When the CAS
// does not match, the code re-reads the winner and merges. The merge based
// itself on `...winner.fields` and re-applied only six scalars plus the digest,
// so every OTHER key the losing turn wrote this turn - the durable language
// switch the shop asked for, the pending-confirm chip, the deposit and
// fulfillment facts - was replaced by the winner's value or deleted outright
// when the winner never carried it.
//
// These tests EXECUTE saveThreadState against a Map-backed store.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

interface StoreRow {
  thread_key: string;
  user_email: string;
  vendor_id: string | null;
  vendor_name: string | null;
  to_number: string;
  phase: string;
  version: number;
  fields: Record<string, unknown>;
  node_runs: Record<string, number>;
  waiting_until: string | null;
  last_decision_id: string | null;
  updated_at: string;
}

const store = new Map<string, StoreRow>();
const events: Record<string, unknown>[] = [];

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
  // PostgREST writes JSON: an `undefined` value never reaches the row.
  const clean = JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
  const next = { ...row, ...clean } as StoreRow;
  store.set(next.thread_key, next);
  return next;
}

vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string, query: string) => {
    if (table !== "negotiation_threads") return [];
    const row = store.get(keyOf(query));
    return row ? [JSON.parse(JSON.stringify(row))] : [];
  },
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    if (table === "agent_events") {
      events.push(...rows);
      return true;
    }
    for (const r of rows) store.set(String(r.thread_key), JSON.parse(JSON.stringify(r)) as StoreRow);
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
}));

import { loadThreadState, saveThreadState } from "./state";
import type { NegotiationThreadState } from "./types";

const KEY = "traveller@example.com:66812345678";

function seed(fields: Record<string, unknown>, version = 5): void {
  store.set(KEY, {
    thread_key: KEY,
    user_email: "traveller@example.com",
    vendor_id: "v1",
    vendor_name: "Shop A",
    to_number: "66812345678",
    phase: "negotiating",
    version,
    fields: { firmCount: 1, toneDegraded: false, rounds: 2, ...fields },
    node_runs: {},
    waiting_until: null,
    last_decision_id: null,
    updated_at: new Date(1_700_000_000_000).toISOString(),
  });
}

async function loaded(): Promise<NegotiationThreadState> {
  const s = await loadThreadState(KEY);
  if (!s) throw new Error("seed missing");
  return s;
}

beforeEach(() => {
  store.clear();
  events.length = 0;
  (globalThis as { __wd_graph_threads__?: Map<string, unknown> }).__wd_graph_threads__ = new Map();
});

describe("saveThreadState lost-race merge (F032)", () => {
  it("keeps the losing turn's facts and honours the winner's deliberate clears", async () => {
    seed({
      pricePerDay: 300,
      currency: "THB",
      priceBasisDays: 3,
      restockHint: "maybe tomorrow",
    });

    // Both turns load the SAME version - the user-action turn proceeds after a
    // lost claim by design (graph/engine.ts runUserActionTurn).
    const inbound = await loaded();
    const userAction = await loaded();

    // The user action lands first and wins the CAS. It clears the package
    // basis and the restock hint deliberately (spte/live.ts persistThreadOutcome).
    await saveThreadState({
      ...userAction,
      fields: {
        firmCount: 1,
        toneDegraded: false,
        rounds: 2,
        pricePerDay: 280,
        currency: "THB",
      },
    });

    // The inbound turn read the shop's message: a language switch, a pending
    // confirm, the deposit and the handover mode - none of which the winner saw.
    await saveThreadState({
      ...inbound,
      fields: {
        ...inbound.fields,
        firmCount: 2,
        rounds: 3,
        depositType: "passport",
        fulfillment: "delivery",
        presented: true,
        language: { mode: "english", reason: "shop-asked", at: "2026-01-01T00:00:00.000Z" },
        awaitingConfirmation: {
          subject: "deposit",
          question: "passport deposit, correct?",
          at: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    const row = store.get(KEY)!;
    // What the losing turn learned SURVIVES.
    expect(row.fields.depositType).toBe("passport");
    expect(row.fields.fulfillment).toBe("delivery");
    expect(row.fields.presented).toBe(true);
    expect((row.fields.language as { mode?: string } | undefined)?.mode).toBe("english");
    // ...EXCEPT the card's pending-confirm mirror, which follows the winner.
    // A cleared chip and a never-set one look identical in the JSON row (both
    // are simply absent), and of the two mistakes only the resurrection hurts:
    // it leaves the traveller's card asking a question the shop has already
    // answered. The engine's own copy lives in the digest, which IS unioned
    // below, so the mirror is re-derived on the next turn either way.
    // See src/lib/graph/state-merge-residuals.test.ts for the clear case.
    expect(row.fields.awaitingConfirmation).toBeUndefined();
    // The winner stays authoritative on every key both wrote.
    expect(row.fields.pricePerDay).toBe(280);
    // A deliberate CLEAR is not resurrected by the union.
    expect(row.fields.priceBasisDays).toBeUndefined();
    expect(row.fields.restockHint).toBeUndefined();
    // Counters still take the max, and the row moved on.
    expect(row.fields.firmCount).toBe(2);
    expect(row.fields.rounds).toBe(3);
    expect(row.version).toBeGreaterThan(6);
  });

  it("yields to a search close that landed mid-turn instead of merging over it", async () => {
    seed({ pricePerDay: 300, currency: "THB", rounds: 3, firmCount: 2 });
    const inbound = await loaded();

    // closeSearchSession resets the per-hunt half under its own version guard
    // and stamps the close. Two writers get between us and the store, so the
    // version is no longer merely one ahead.
    store.set(KEY, {
      ...store.get(KEY)!,
      version: 8,
      phase: "opening",
      fields: {
        firmCount: 0,
        toneDegraded: false,
        rounds: 0,
        searchClosedAt: "2026-02-02T00:00:00.000Z",
        language: { mode: "english", reason: "shop-asked", at: "2026-01-01T00:00:00.000Z" },
      },
    });

    await saveThreadState({
      ...inbound,
      fields: { ...inbound.fields, rounds: 4, firmCount: 2, presented: true },
    });

    const row = store.get(KEY)!;
    expect(row.fields.pricePerDay).toBeUndefined();
    expect(row.fields.rounds).toBe(0);
    expect(row.fields.firmCount).toBe(0);
    expect(row.fields.presented).toBeUndefined();
    expect(row.fields.searchClosedAt).toBe("2026-02-02T00:00:00.000Z");
    // The shop-durable half the close deliberately keeps is still there.
    expect((row.fields.language as { mode?: string } | undefined)?.mode).toBe("english");
  });
});
