// AUDIT F134 (the belt half) - a thread whose only activity was a STAGE
// transition must still be inside the next close's per-hunt window.
//
// The window read was `updated_at=gte.<session start>` alone, and neither
// ledger write moved `updated_at` (funnel/stages.ts). A row created in hunt 1
// and only ever stage-stamped afterwards therefore fell out of every later
// window: from the close of hunt 2 onward its stage was never reset, and a
// terminal lateral (`out_of_stock`) stayed pinned on the shop's card into a
// hunt that had not messaged it yet.
//
// The ledger now stamps `updated_at` as well; this test pins the OTHER half,
// which rescues rows written before it did: the window admits a row on either
// clock. The store mock EVALUATES the filter - the whole point is which rows
// the query returns.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

interface StoreRow {
  thread_key: string;
  user_email: string;
  to_number: string;
  phase: string;
  stage: string | null;
  stage_at: string | null;
  version: number;
  fields: Record<string, unknown>;
  updated_at: string;
}

const store = new Map<string, StoreRow>();

function keyOf(query: string): string {
  return decodeURIComponent(/thread_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
}

/** `updated_at=gte.X`, and the `or=(updated_at.gte.X,stage_at.gte.X)` form. */
function insideWindow(query: string, row: StoreRow): boolean {
  const or = /or=\((updated_at\.gte\.[^,]+),(stage_at\.gte\.[^)]+)\)/.exec(query);
  if (or) {
    const u = decodeURIComponent(or[1].slice("updated_at.gte.".length));
    const s = decodeURIComponent(or[2].slice("stage_at.gte.".length));
    return (
      Date.parse(row.updated_at) >= Date.parse(u) ||
      (row.stage_at !== null && Date.parse(row.stage_at) >= Date.parse(s))
    );
  }
  const plain = /updated_at=gte\.([^&]+)/.exec(query);
  if (plain) return Date.parse(row.updated_at) >= Date.parse(decodeURIComponent(plain[1]));
  return true;
}

function applyUpdate(filter: string, values: Record<string, unknown>): StoreRow | null {
  const row = store.get(keyOf(filter));
  if (!row) return null;
  const want = /version=eq\.(\d+)/.exec(filter);
  if (want && row.version !== Number(want[1])) return null;
  const next = { ...row, ...(JSON.parse(JSON.stringify(values)) as Record<string, unknown>) } as StoreRow;
  store.set(next.thread_key, next);
  return next;
}

vi.mock("./runtime-config", () => ({
  sbSelect: async (table: string, query: string) => {
    if (table !== "negotiation_threads") return [];
    const key = /thread_key=eq\./.test(query) ? keyOf(query) : null;
    const email = decodeURIComponent(/user_email=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    return [...store.values()]
      .filter((r) => (key ? r.thread_key === key : r.user_email === email && insideWindow(query, r)))
      .map((r) => JSON.parse(JSON.stringify(r)) as StoreRow);
  },
  sbInsert: async () => true,
  sbUpdate: async (table: string, filter: string, values: Record<string, unknown>) =>
    table === "negotiation_threads" ? applyUpdate(filter, values) !== null : false,
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

const EMAIL = "traveller@example.com";
const KEY = `${EMAIL}:66812345678`;

beforeEach(() => {
  store.clear();
});

describe("the per-hunt reset window admits a stage-only row (F134)", () => {
  it("resets a row whose updated_at predates the hunt but whose stage moved inside it", async () => {
    const hunt2Start = Date.now() - 2 * 3600_000;
    store.set(KEY, {
      thread_key: KEY,
      user_email: EMAIL,
      to_number: "66812345678",
      phase: "negotiating",
      // Hunt 1 created the row; nothing but the ledger has touched it since.
      updated_at: new Date(hunt2Start - 24 * 3600_000).toISOString(),
      // ...and the ledger stamped out_of_stock DURING hunt 2.
      stage: "out_of_stock",
      stage_at: new Date(hunt2Start + 600_000).toISOString(),
      version: 3,
      fields: { pricePerDay: 300, rounds: 2 },
    });

    await closeSearchSession(EMAIL, { fromMs: hunt2Start, beforeMs: Date.now() });

    const row = store.get(KEY)!;
    expect(row.stage).toBeNull();
    expect(row.fields.pricePerDay).toBeUndefined();
    expect(row.fields.rounds).toBeUndefined();
  });
});
