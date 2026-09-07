// AUDIT F133 + F134 - ONE SHOP, ONE `negotiation_threads` ROW, AND A ROW THE
// LEDGER TOUCHES STAYS INSIDE THE NEXT SESSION WINDOW.
//
// F133: the ledger built `thread_key` as `email:identityKey(number)` (the
// 9-digit national tail) while the engine built `email:digitsOnly(number)`, so
// for every real international number the two wrote DIFFERENT primary keys -
// one row carrying `stage` and vendor identity, a second carrying
// `phase`/`fields`/the digest. Ops listed the shop twice and the transcript
// read `stage: null` for every live thread.
//
// F134: neither ledger write touched `updated_at`, so a row whose only
// activity since creation was stage transitions fell out of session-close's
// `updated_at=gte.<session start>` window from the second hunt onward - and a
// terminal lateral (`out_of_stock`) stayed pinned on the card of a shop the
// new hunt had not messaged yet.
//
// Both tests EXECUTE advanceThreadStage and saveThreadState against ONE
// Map-backed store, in the order the real system runs them.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

interface Row {
  thread_key: string;
  user_email: string;
  to_number: string;
  vendor_id?: string | null;
  vendor_name?: string | null;
  stage?: string | null;
  stage_at?: string | null;
  phase?: string;
  version?: number;
  fields?: Record<string, unknown>;
  node_runs?: Record<string, number>;
  waiting_until?: string | null;
  last_decision_id?: string | null;
  updated_at?: string;
}

const threads = new Map<string, Row>();
const events: Record<string, unknown>[] = [];

function param(query: string, name: string): string | null {
  const m = new RegExp(`${name}=eq\\.([^&]+)`).exec(query);
  return m ? decodeURIComponent(m[1]) : null;
}

/** The `or=(to_number.eq.X,...,to_number.like.*TAIL)` spelling filter. */
function matchesNumberOr(query: string, row: Row): boolean {
  const m = /or=\((to_number[^)]*)\)/.exec(query);
  if (!m) return true;
  return m[1].split(",").some((clause) => {
    const eq = /^to_number\.eq\.(.+)$/.exec(clause);
    if (eq) return row.to_number === decodeURIComponent(eq[1]);
    const like = /^to_number\.like\.\*(.+)$/.exec(clause);
    if (like) return row.to_number.endsWith(decodeURIComponent(like[1]));
    return false;
  });
}

function stageFilterMatches(filter: string, stage: string | null | undefined): boolean {
  const m = filter.match(/or=\(stage\.is\.null,stage\.in\.\(([^)]*)\)\)/);
  if (!m) return true;
  if (stage == null) return true;
  return m[1].split(",").includes(stage);
}

function applyUpdate(filter: string, values: Record<string, unknown>): Row | null {
  const key = param(filter, "thread_key");
  const row = key ? threads.get(key) : null;
  if (!row) return null;
  if (!stageFilterMatches(filter, row.stage)) return null;
  const wantVersion = /version=eq\.(\d+)/.exec(filter);
  if (wantVersion && (row.version ?? 0) !== Number(wantVersion[1])) return null;
  const next = { ...row, ...(JSON.parse(JSON.stringify(values)) as Record<string, unknown>) } as Row;
  threads.set(next.thread_key, next);
  return next;
}

vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string, query: string) => {
    if (table !== "negotiation_threads") return [];
    const key = param(query, "thread_key");
    if (key) {
      const row = threads.get(key);
      return row ? [JSON.parse(JSON.stringify(row))] : [];
    }
    const email = param(query, "user_email");
    return [...threads.values()]
      .filter((r) => r.user_email === email && matchesNumberOr(query, r))
      .map((r) => JSON.parse(JSON.stringify(r)) as Row);
  },
  sbSelectStrict: async () => ({ rows: [] }),
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    if (table !== "negotiation_threads") {
      for (const r of rows) events.push({ table, ...r });
      return true;
    }
    const row = rows[0] as unknown as Row;
    if (threads.has(row.thread_key)) return false; // primary key conflict
    threads.set(row.thread_key, JSON.parse(JSON.stringify(row)) as Row);
    return true;
  },
  sbUpdate: async (table: string, filter: string, values: Record<string, unknown>) =>
    table === "negotiation_threads" ? applyUpdate(filter, values) !== null : false,
  sbUpdateReturning: async (table: string, filter: string, values: Record<string, unknown>) => {
    if (table !== "negotiation_threads") return [];
    const row = applyUpdate(filter, values);
    return row ? [JSON.parse(JSON.stringify(row))] : [];
  },
}));

import { advanceThreadStage } from "./stages";
import { loadThreadState, newThreadState, saveThreadState, threadKeyFor } from "../graph/state";

const EMAIL = "t@x.com";
/** What Google Places gave us - the NATIONAL spelling we messaged. */
const PLACES_FORM = "081236954642";
/** What the inbound WhatsApp JID gives us - always international. */
const JID_FORM = "6281236954642";

async function engineTurn(number: string, fields: Record<string, unknown>): Promise<void> {
  const key = threadKeyFor(EMAIL, number);
  const state =
    (await loadThreadState(key)) ??
    newThreadState({ threadKey: key, userEmail: EMAIL, toNumber: number, vendorId: "v1", vendorName: "Shop S" });
  await saveThreadState({ ...state, fields: { ...state.fields, ...fields } });
}

beforeEach(() => {
  threads.clear();
  events.length = 0;
  (globalThis as { __wd_graph_threads__?: Map<string, unknown> }).__wd_graph_threads__ = new Map();
});

describe("one shop, one negotiation_threads row (F133)", () => {
  it("the engine writes the row the ledger created, not a second one", async () => {
    // Mass outreach stamps `selected` with the number it messaged...
    const stamped = await advanceThreadStage(
      { userEmail: EMAIL, toNumber: PLACES_FORM, vendorId: "v1", vendorName: "Shop S" },
      "selected",
      "mass bargain included the shop"
    );
    expect(stamped.advanced).toBe(true);

    // ...the shop replies, and the engine keys the turn off the inbound JID.
    await engineTurn(JID_FORM, { pricePerDay: 300, currency: "IDR" });

    expect([...threads.values()]).toHaveLength(1);
    const row = [...threads.values()][0];
    expect(row.stage).toBe("selected");
    expect(row.fields?.pricePerDay).toBe(300);
  });

  it("the ledger stamps the row the engine created, not a second one", async () => {
    await engineTurn(JID_FORM, { pricePerDay: 300 });
    await advanceThreadStage(
      { userEmail: EMAIL, toNumber: PLACES_FORM, vendorId: "v1", vendorName: "Shop S" },
      "replied",
      "inbound stored"
    );

    expect([...threads.values()]).toHaveLength(1);
    expect([...threads.values()][0].stage).toBe("replied");
  });

  it("both key builders answer the same key for the same spelling", async () => {
    const { canonicalThreadKey } = await import("../wa/phone-key");
    expect(threadKeyFor(EMAIL, JID_FORM)).toBe(canonicalThreadKey(EMAIL, JID_FORM));
    // ...and the key's tail stays a DIALABLE number: the wakeup path rebuilds
    // the send target from it (graph/engine.ts buildTurnFromThread).
    expect(threadKeyFor(EMAIL, JID_FORM)).toBe(`${EMAIL}:${JID_FORM}`);
  });
});

describe("a ledger transition keeps the row inside the next session window (F134)", () => {
  it("the guarded PATCH bumps updated_at", async () => {
    const T0 = new Date(Date.now() - 3 * 3600_000).toISOString();
    threads.set(`${EMAIL}:${JID_FORM}`, {
      thread_key: `${EMAIL}:${JID_FORM}`,
      user_email: EMAIL,
      to_number: JID_FORM,
      stage: "contacted",
      stage_at: T0,
      phase: "opening",
      version: 1,
      fields: {},
      updated_at: T0,
    });

    const res = await advanceThreadStage(
      { userEmail: EMAIL, toNumber: JID_FORM },
      "out_of_stock",
      "shop says nothing available"
    );

    expect(res.advanced).toBe(true);
    const row = threads.get(`${EMAIL}:${JID_FORM}`)!;
    expect(row.stage).toBe("out_of_stock");
    expect(Date.parse(row.updated_at ?? "") > Date.parse(T0)).toBe(true);
  });

  it("the minimal INSERT stamps updated_at too", async () => {
    await advanceThreadStage({ userEmail: EMAIL, toNumber: JID_FORM }, "selected", "traveller asked");
    const row = [...threads.values()][0];
    expect(typeof row.updated_at).toBe("string");
    expect(Number.isFinite(Date.parse(row.updated_at ?? ""))).toBe(true);
  });
});
