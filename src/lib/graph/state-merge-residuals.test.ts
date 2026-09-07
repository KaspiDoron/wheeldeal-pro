// AUDIT F032 / F133 - the two residuals the G10 fix panel's regression lens
// raised against its own group's diff, both of which it correctly filed as
// correctness work rather than as refutations.
//
// 1. F032's key-wise union (`{ ...next.fields, ...winner.fields }`) pins the
//    winner's deliberate clears for priceBasisDays and restockHint, because a
//    key set to `undefined` never reaches the JSON row and the union would
//    otherwise resurrect the loser's stale copy. `awaitingConfirmation` is
//    cleared exactly the same way (spte/live.ts writes `undefined` when the
//    pending question has been answered) and was NOT pinned, so a losing turn
//    could bring a resolved pending-confirm chip back to life - and the thread
//    would then sit waiting for an answer the shop has already given.
//
// 2. F133's adopt-before-inserting branch re-targeted the write onto the row
//    the ledger had created under the other spelling, but wrote the whole
//    `fields` blob under a bare `thread_key=eq.` filter with NO version
//    predicate - one more writer of exactly the shape M38 exists to eliminate.
//    A ledger write landing between the adoption read and that PATCH was
//    silently overwritten.
//
// Both tests EXECUTE saveThreadState against a Map-backed store.

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
/** Fires once, immediately after the adoption read is served, to simulate a
 *  concurrent ledger write landing between that read and the write it feeds. */
let bumpAfterAdoption: (() => void) | null = null;

function keyOf(query: string): string {
  return decodeURIComponent(/thread_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
}
function versionOf(query: string): number | null {
  const m = /version=eq\.(\d+)/.exec(query);
  return m ? Number(m[1]) : null;
}
function tail(n: string): string {
  return n.replace(/\D+/g, "").slice(-8);
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
    if (query.includes("&or=")) {
      // The spelling-tolerant adoption read: owner-scoped, number-tolerant.
      const email = decodeURIComponent(/user_email=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      const digits = /\((?:[^)]*?)(\d{6,})/.exec(query)?.[1] ?? "";
      const hit = [...store.values()].find(
        (r) => r.user_email === email && tail(r.to_number) === tail(digits)
      );
      const snapshot = hit ? [JSON.parse(JSON.stringify(hit))] : [];
      if (hit && bumpAfterAdoption) {
        const fire = bumpAfterAdoption;
        bumpAfterAdoption = null;
        fire();
      }
      return snapshot;
    }
    const row = store.get(keyOf(query));
    return row ? [JSON.parse(JSON.stringify(row))] : [];
  },
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    if (table === "agent_events") return true;
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

import { loadThreadState, saveThreadState, newThreadState } from "./state";

const EMAIL = "traveller@example.com";
const INTL = "6281236954642";
const NATIONAL = "081236954642";

function seed(threadKey: string, toNumber: string, fields: Record<string, unknown>, version: number): void {
  store.set(threadKey, {
    thread_key: threadKey,
    user_email: EMAIL,
    vendor_id: "v1",
    vendor_name: "Shop A",
    to_number: toNumber,
    phase: "negotiating",
    version,
    fields: { rounds: 2, ...fields },
    node_runs: {},
    waiting_until: null,
    last_decision_id: null,
    updated_at: new Date(1_700_000_000_000).toISOString(),
  });
}

beforeEach(() => {
  store.clear();
  bumpAfterAdoption = null;
  (globalThis as { __wd_graph_threads__?: Map<string, unknown> }).__wd_graph_threads__ = new Map();
});

describe("the lost-race union honours EVERY deliberate clear (F032)", () => {
  it("does not resurrect a pending-confirm chip the winner already resolved", async () => {
    const key = `${EMAIL}:${INTL}`;
    seed(
      key,
      INTL,
      {
        awaitingConfirmation: { subject: "helmet", question: "Is a helmet included?", at: "2026-09-01T00:00:00.000Z" },
        pricePerDay: 300,
      },
      5
    );

    // The losing turn loads at version 5, so it carries the chip.
    const loser = await loadThreadState(key);
    expect(loser).toBeTruthy();
    expect(loser!.fields.awaitingConfirmation).toBeTruthy();

    // The winning turn lands first: the shop answered, so the chip is cleared
    // by writing `undefined`, which JSON drops - the key is simply gone.
    const winner = await loadThreadState(key);
    winner!.fields.awaitingConfirmation = undefined;
    winner!.fields.presented = true;
    await saveThreadState(winner!);
    expect(store.get(key)!.version).toBe(6);
    expect(store.get(key)!.fields).not.toHaveProperty("awaitingConfirmation");

    // Now the loser saves. Its CAS on version 5 fails and the merge runs.
    loser!.fields.depositType = "passport";
    await saveThreadState(loser!);

    const after = store.get(key)!;
    // The losing turn's own new fact survives, as F032 intends...
    expect(after.fields.depositType).toBe("passport");
    expect(after.fields.presented).toBe(true);
    // ...but the answered question must NOT come back from the dead.
    expect(after.fields).not.toHaveProperty("awaitingConfirmation");
  });
});

describe("the adoption write is version guarded (F133)", () => {
  it("merges instead of clobbering a ledger write that lands under it", async () => {
    // The ledger created this shop's row under the NATIONAL spelling.
    seed(`${EMAIL}:${NATIONAL}`, NATIONAL, { stageNote: "contacted" }, 3);

    // The engine builds fresh state under the CANONICAL spelling: no row of
    // its own, so saveThreadState takes the adopt-before-insert branch.
    const fresh = newThreadState({
      threadKey: `${EMAIL}:${INTL}`,
      userEmail: EMAIL,
      vendorId: "v1",
      vendorName: "Shop A",
      toNumber: INTL,
    });
    fresh.fields.depositType = "passport";

    // A concurrent ledger write lands between the adoption read and the write
    // it feeds: same row, version bumped, a new durable fact written.
    bumpAfterAdoption = () => {
      const row = store.get(`${EMAIL}:${NATIONAL}`)!;
      store.set(row.thread_key, {
        ...row,
        version: row.version + 1,
        fields: { ...row.fields, declined: false, shopConfirmedAt: "2026-09-07T00:00:00.000Z" },
      });
    };

    await saveThreadState(fresh);

    const after = store.get(`${EMAIL}:${NATIONAL}`)!;
    // One row, still - adoption must never split the shop in two.
    expect(store.size).toBe(1);
    // The concurrent ledger write is NOT lost.
    expect(after.fields.shopConfirmedAt).toBe("2026-09-07T00:00:00.000Z");
    // And the turn's own fact still lands, through the same union.
    expect(after.fields.depositType).toBe("passport");
    // The ledger's row keeps its identity; nothing was written beside it.
    expect(after.thread_key).toBe(`${EMAIL}:${NATIONAL}`);
  });
});
