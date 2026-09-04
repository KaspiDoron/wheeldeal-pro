import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT F035 - the cancel tombstone was ENFORCED by an exact to_number match
// while it was CLEARED tolerantly.
//
// Tombstones are written from wa_outbox.to_number / wa_recipient_state.to_number
// (discovery's spelling - a Google national number like "09776620146"), and the
// reply-path guard asks with the inbound JID digits ("639776620146"). isCancelled
// probed `to_number=eq.<digits>` and the marker fallback `raw->>digits=eq.`, so
// a shop the traveller explicitly removed was auto-messaged again the moment it
// replied. The clear direction was already tolerant (numberFilter); this suite
// executes the ENFORCEMENT direction against a store that honours the same
// filter grammar PostgREST does.

vi.mock("server-only", () => ({}));

interface MarkerRow {
  sender: string;
  digits: string;
  tail?: string;
  kind: string;
  at: number;
}

const state: {
  tableRows: { sender_key: string; to_number: string }[];
  markers: MarkerRow[];
  cancellationsMode: "ok" | "missing" | "unavailable";
  clock: number;
  queries: string[];
} = { tableRows: [], markers: [], cancellationsMode: "ok", clock: 1_700_000_000_000, queries: [] };

/** Every `col.eq.v` / `col.like.*t` clause of a PostgREST `or=(...)` group. */
function orClauses(query: string): { col: string; op: string; value: string }[] {
  const group = /(?:^|&)or=\(([^)]*)\)/.exec(query)?.[1];
  if (!group) return [];
  return group.split(",").map((c) => {
    const m = /^(.+?)\.(eq|like)\.(.+)$/.exec(c);
    if (!m) throw new Error(`unparseable or-clause: ${c}`);
    return { col: m[1], op: m[2], value: m[3] };
  });
}

vi.mock("../runtime-config", () => ({
  getConfig: async () => undefined,
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    if (table === "wa_cancellations") {
      if (state.cancellationsMode !== "ok") return false;
      for (const r of rows) {
        state.tableRows.push({ sender_key: String(r.sender_key), to_number: String(r.to_number) });
      }
      return true;
    }
    if (table === "whatsapp_messages") {
      for (const r of rows) {
        const raw = r.raw as { sender?: string; digits?: string; tail?: string; kind?: string };
        state.markers.push({
          sender: String(raw.sender),
          digits: String(raw.digits),
          ...(raw.tail ? { tail: String(raw.tail) } : {}),
          kind: String(raw.kind),
          at: state.clock++,
        });
      }
      return true;
    }
    return true;
  },
  sbDelete: async () => true,
  sbSelectStrict: async (table: string, query: string) => {
    state.queries.push(`${table}?${query}`);
    if (table === "wa_cancellations") {
      if (state.cancellationsMode !== "ok") return { error: state.cancellationsMode };
      const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      const exact = decodeURIComponent(/(?:^|&)to_number=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      const clauses = orClauses(query);
      const eqs = clauses.filter((c) => c.col === "to_number" && c.op === "eq").map((c) => c.value);
      const tail = clauses.find((c) => c.col === "to_number" && c.op === "like")?.value.replace(/^\*/, "");
      if (exact) eqs.push(exact);
      const rows = state.tableRows.filter(
        (r) =>
          r.sender_key === sender &&
          (eqs.includes(r.to_number) || (tail ? r.to_number.endsWith(tail) : false))
      );
      return { rows: rows.map(() => ({ id: 1 })) };
    }
    if (table === "whatsapp_messages") {
      const sender = decodeURIComponent(/raw->>sender=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      const exact = decodeURIComponent(/raw->>digits=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      const clauses = orClauses(query);
      const digitsIn = clauses.filter((c) => c.col === "raw->>digits" && c.op === "eq").map((c) => c.value);
      const tails = clauses.filter((c) => c.col === "raw->>tail" && c.op === "eq").map((c) => c.value);
      if (exact) digitsIn.push(exact);
      const rows = state.markers
        .filter(
          (m) =>
            m.sender === sender &&
            (digitsIn.includes(m.digits) || (m.tail ? tails.includes(m.tail) : false))
        )
        .sort((a, b) => b.at - a.at)
        .map((m) => ({ raw: { sender: m.sender, digits: m.digits, kind: m.kind } }));
      return { rows };
    }
    return { rows: [] };
  },
}));

import { cancelSends, clearCancellation, isCancelled } from "./cancellations";

const SENDER = "a@x.com";
const NATIONAL = "09776620146"; // Google Places' spelling, stored on the outbox row
const INTERNATIONAL = "639776620146"; // WhatsApp's JID digits, what the reply path holds

beforeEach(() => {
  state.tableRows = [];
  state.markers = [];
  state.cancellationsMode = "ok";
  state.queries = [];
});

describe("EXECUTED: the tombstone is enforced under EITHER spelling of one shop", () => {
  it("stored under the national spelling, refused under the international one (the reply path)", async () => {
    // The queue Remove tap writes the tombstone from the deleted outbox row.
    state.tableRows.push({ sender_key: SENDER, to_number: NATIONAL });
    // The shop replies from its JID; guardOutbound asks with those digits.
    expect(await isCancelled(SENDER, INTERNATIONAL)).toBe(true);
  });

  it("stored under the international spelling, refused under the national one (the drain path)", async () => {
    state.tableRows.push({ sender_key: SENDER, to_number: INTERNATIONAL });
    expect(await isCancelled(SENDER, NATIONAL)).toBe(true);
  });

  it("a DIFFERENT shop is not swept up, and a different traveller is untouched", async () => {
    state.tableRows.push({ sender_key: SENDER, to_number: NATIONAL });
    expect(await isCancelled(SENDER, "639771111111")).toBe(false);
    expect(await isCancelled("b@x.com", INTERNATIONAL)).toBe(false);
  });
});

describe("EXECUTED: the marker fallback (pre-migration) is tolerant too", () => {
  beforeEach(() => {
    state.cancellationsMode = "missing";
  });

  it("a marker written under the national spelling blocks the international one", async () => {
    expect(await cancelSends(SENDER, NATIONAL, "user-removed")).toBe(true);
    expect(await isCancelled(SENDER, INTERNATIONAL)).toBe(true);
  });

  it("a marker written under the international spelling blocks the national one", async () => {
    await cancelSends(SENDER, INTERNATIONAL, "user-removed");
    expect(await isCancelled(SENDER, NATIONAL)).toBe(true);
  });

  it("a LEGACY marker (no tail stamped) is still found in the direction a spelling can be derived", async () => {
    state.markers.push({ sender: SENDER, digits: NATIONAL, kind: "cancelled-shop", at: state.clock++ });
    expect(await isCancelled(SENDER, INTERNATIONAL)).toBe(true);
  });

  it("the NEWEST verdict wins across spellings - a clear under one spelling re-opens the shop", async () => {
    await cancelSends(SENDER, NATIONAL, "user-removed");
    await clearCancellation(SENDER, INTERNATIONAL);
    expect(await isCancelled(SENDER, NATIONAL)).toBe(false);
    expect(await isCancelled(SENDER, INTERNATIONAL)).toBe(false);
  });

  it("the marker read uses only `.eq.` clauses on jsonb paths - the shape production already runs", async () => {
    await isCancelled(SENDER, INTERNATIONAL);
    const markerQuery = state.queries.find((q) => q.startsWith("whatsapp_messages?"));
    expect(markerQuery).toBeDefined();
    for (const c of orClauses(markerQuery!)) expect(c.op).toBe("eq");
    // No `like` on a jsonb path anywhere in the query.
    expect(markerQuery).not.toMatch(/raw->>[a-z]+\.like\./);
  });
});
