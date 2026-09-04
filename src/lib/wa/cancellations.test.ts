import { describe, it, expect, vi, beforeEach } from "vitest";

// The absolute-cancellation contract, v2: a removed shop is NEVER auto-
// messaged again - and that guarantee must hold BEFORE the schema migration
// runs (marker rows in the always-existing messages table carry the
// tombstone), AFTER it (table + markers agree), and across the transition
// (an empty new table must not silently reopen marker-cancelled shops).

vi.mock("server-only", () => ({}));

interface MarkerRow {
  sender: string;
  digits: string;
  tail?: string;
  kind: string;
  reason?: string;
  at: number;
}

const state: {
  tableRows: { sender_key: string; to_number: string; reason?: string }[];
  markers: MarkerRow[];
  // per-table availability: "ok" | "missing" | "unavailable"
  cancellationsMode: "ok" | "missing" | "unavailable";
  messagesMode: "ok" | "missing" | "unavailable";
  config: Record<string, string | undefined>;
  clock: number;
} = {
  tableRows: [],
  markers: [],
  cancellationsMode: "ok",
  messagesMode: "ok",
  config: {},
  clock: 1_700_000_000_000,
};

vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => state.config[k],
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    if (table === "wa_cancellations") {
      if (state.cancellationsMode !== "ok") return false;
      for (const r of rows) {
        state.tableRows = state.tableRows.filter(
          (x) => !(x.sender_key === r.sender_key && x.to_number === r.to_number)
        );
        state.tableRows.push({
          sender_key: String(r.sender_key),
          to_number: String(r.to_number),
          reason: r.reason ? String(r.reason) : undefined,
        });
      }
      return true;
    }
    if (table === "whatsapp_messages") {
      if (state.messagesMode !== "ok") return false;
      for (const r of rows) {
        const raw = r.raw as { sender?: string; digits?: string; tail?: string; kind?: string; reason?: string };
        state.markers.push({
          sender: String(raw.sender),
          digits: String(raw.digits),
          ...(raw.tail ? { tail: String(raw.tail) } : {}),
          kind: String(raw.kind),
          reason: raw.reason,
          at: state.clock++,
        });
      }
      return true;
    }
    return true;
  },
  sbDelete: async (table: string, query: string) => {
    if (table !== "wa_cancellations") return true;
    if (state.cancellationsMode !== "ok") return false;
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    // clearCancellation now deletes TOLERANTLY (numberFilter or-group of
    // spellings + a tail LIKE), so the mock honors any of them.
    const eqs = [...query.matchAll(/to_number\.eq\.([0-9]+)/g)].map((m) => m[1]);
    const exact = decodeURIComponent(/to_number=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    if (exact) eqs.push(exact);
    const tail = /to_number\.like\.\*([0-9]+)/.exec(query)?.[1];
    state.tableRows = state.tableRows.filter((r) => {
      if (r.sender_key !== sender) return true;
      if (eqs.length === 0 && !tail) return false; // sender-wide delete
      const hit = eqs.includes(r.to_number) || (tail ? r.to_number.endsWith(tail) : false);
      return !hit;
    });
    return true;
  },
  sbSelectStrict: async (table: string, query: string) => {
    if (table === "wa_cancellations") {
      if (state.cancellationsMode !== "ok") return { error: state.cancellationsMode };
      const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      // isCancelled now reads TOLERANTLY (audit F035) with the same
      // numberFilter or-group the delete mock above already honours.
      const eqs = [...query.matchAll(/to_number\.eq\.([0-9]+)/g)].map((m) => m[1]);
      const exact = decodeURIComponent(/(?:^|&)to_number=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      if (exact) eqs.push(exact);
      const tail = /to_number\.like\.\*([0-9]+)/.exec(query)?.[1];
      const scoped = eqs.length > 0 || Boolean(tail);
      return {
        rows: state.tableRows
          .filter(
            (r) =>
              r.sender_key === sender &&
              (!scoped || eqs.includes(r.to_number) || (tail ? r.to_number.endsWith(tail) : false))
          )
          .map((r) => ({
            id: 1,
            to_number: r.to_number,
            reason: r.reason ?? null,
            created_at: new Date(1_700_000_000_000).toISOString(),
          })),
      };
    }
    if (table === "whatsapp_messages") {
      if (state.messagesMode !== "ok") return { error: state.messagesMode };
      const sender = decodeURIComponent(/raw->>sender=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      // markerSaysCancelled now reads TOLERANTLY (audit F035): an or-group of
      // `raw->>digits.eq.<spelling>` clauses plus `raw->>tail.eq.<tail>`. The
      // mock honours the or-group so the digits filter is exercised, not
      // vacuous; the exact form stays for cancelledEntries' sender-wide read.
      const exact = decodeURIComponent(/raw->>digits=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      const group = /(?:^|&)or=\(([^)]*)\)/.exec(query)?.[1] ?? "";
      const digitsIn = [...group.matchAll(/raw->>digits\.eq\.([0-9]+)/g)].map((m) => m[1]);
      const tails = [...group.matchAll(/raw->>tail\.eq\.([0-9]+)/g)].map((m) => m[1]);
      if (exact) digitsIn.push(exact);
      const scoped = digitsIn.length > 0 || tails.length > 0;
      const rows = state.markers
        .filter(
          (m) =>
            m.sender === sender &&
            (!scoped ||
              digitsIn.includes(m.digits) ||
              (m.tail ? tails.includes(m.tail) : false))
        )
        .sort((a, b) => b.at - a.at)
        .map((m) => ({
          raw: { sender: m.sender, digits: m.digits, kind: m.kind, ...(m.reason ? { reason: m.reason } : {}) },
          received_at: new Date(m.at).toISOString(),
        }));
      return { rows };
    }
    return { rows: [] };
  },
}));

import {
  cancelSends,
  clearCancellation,
  isCancelled,
  cancelledNumbers,
  cancelledEntries,
} from "./cancellations";

beforeEach(() => {
  state.tableRows = [];
  state.markers = [];
  state.cancellationsMode = "ok";
  state.messagesMode = "ok";
  state.config = {};
});

describe("cancellation tombstones (table + marker trail)", () => {
  it("cancel -> cancelled; explicit clear -> re-opened", async () => {
    expect(await cancelSends("a@x.com", "+66 81-234 5678", "user-removed")).toBe(true);
    expect(await isCancelled("a@x.com", "66812345678")).toBe(true);
    expect(await isCancelled("b@x.com", "66812345678")).toBe(false); // other user unaffected
    await clearCancellation("a@x.com", "66812345678");
    expect(await isCancelled("a@x.com", "66812345678")).toBe(false);
  });

  it("PRE-MIGRATION: works entirely on markers when the table is missing", async () => {
    state.cancellationsMode = "missing";
    expect(await cancelSends("a@x.com", "66812345678", "user-removed")).toBe(true);
    expect(await isCancelled("a@x.com", "66812345678")).toBe(true);
    await clearCancellation("a@x.com", "66812345678");
    expect(await isCancelled("a@x.com", "66812345678")).toBe(false);
    expect(await cancelledNumbers("a@x.com")).toEqual([]);
  });

  it("MIGRATION TRANSITION: a marker-cancelled shop stays cancelled after the empty table appears", async () => {
    state.cancellationsMode = "missing";
    await cancelSends("a@x.com", "66812345678", "user-removed");
    state.cancellationsMode = "ok"; // the owner just ran schema.sql - table empty
    expect(await isCancelled("a@x.com", "66812345678")).toBe(true);
    expect(await cancelledNumbers("a@x.com")).toEqual(["66812345678"]);
  });

  it("BOTH stores unreadable -> UNKNOWN (null): senders must fail closed", async () => {
    state.tableRows.push({ sender_key: "a@x.com", to_number: "66812345678" });
    state.cancellationsMode = "unavailable";
    state.messagesMode = "unavailable";
    expect(await isCancelled("a@x.com", "66812345678")).toBe(null);
  });

  it("table unavailable but markers readable and empty -> still UNKNOWN (the table may hold the tombstone)", async () => {
    state.cancellationsMode = "unavailable";
    expect(await isCancelled("a@x.com", "66812345678")).toBe(null);
  });

  it("CANCEL_GUARD=off disables enforcement; flipping back restores it", async () => {
    await cancelSends("a@x.com", "66812345678", "user-removed");
    state.config.CANCEL_GUARD = "off";
    expect(await isCancelled("a@x.com", "66812345678")).toBe(false);
    state.config.CANCEL_GUARD = undefined;
    expect(await isCancelled("a@x.com", "66812345678")).toBe(true);
  });

  it("cancelSends reports failure only when NO durable store confirmed", async () => {
    state.cancellationsMode = "unavailable";
    state.messagesMode = "unavailable";
    expect(await cancelSends("a@x.com", "66812345678", "user-removed")).toBe(false);
    state.messagesMode = "ok"; // marker path recovers -> success
    expect(await cancelSends("a@x.com", "66812345678", "user-removed")).toBe(true);
  });

  it("cancelledEntries merges the table and the marker trail WITH the actor", async () => {
    // The reason column was always written but never read - which is how
    // the client rendered the system's session-close sweep as "REMOVED BY
    // YOU (6)" on shops the traveller never touched. The actor now rides
    // every entry, from either store.
    await cancelSends("a@x.com", "111", "user-removed");
    state.cancellationsMode = "missing";
    await cancelSends("a@x.com", "222", "session-closed");
    state.cancellationsMode = "ok";
    const entries = await cancelledEntries("a@x.com");
    const byDigits = new Map(entries.map((e) => [e.digits, e]));
    expect([...byDigits.keys()].sort()).toEqual(["111", "222"]);
    expect(byDigits.get("111")?.reason).toBe("user-removed"); // table row
    expect(byDigits.get("222")?.reason).toBe("session-closed"); // marker-only
    // The digits digest stays for older readers.
    expect((await cancelledNumbers("a@x.com")).sort()).toEqual(["111", "222"]);
  });

  it("clearCancellation is AUTHORITATIVE: true only when a durable store confirmed", async () => {
    await cancelSends("a@x.com", "66812345678", "user-removed");
    expect(await clearCancellation("a@x.com", "66812345678")).toBe(true);
    expect(await isCancelled("a@x.com", "66812345678")).toBe(false);
    // Both stores dead: the clear CANNOT be confirmed - callers must refuse
    // to queue for this shop instead of feeding the guard a row it will kill.
    state.cancellationsMode = "unavailable";
    state.messagesMode = "unavailable";
    expect(await clearCancellation("a@x.com", "66812345678")).toBe(false);
  });

  it("clearCancellation clears a tombstone stored under a DIFFERENT spelling", async () => {
    // Discovery stored the national form; the user re-selected the shop under
    // the international one. The exact-string delete used to miss, leaving a
    // 14-day tombstone the guard then enforced as "cancelled-by-user".
    state.tableRows.push({ sender_key: "a@x.com", to_number: "09776620146", reason: "user-removed" });
    await clearCancellation("a@x.com", "639776620146");
    expect(state.tableRows).toHaveLength(0);
  });

  it("the clearing marker is written UNCONDITIONALLY (a transient read cannot skip it)", async () => {
    state.cancellationsMode = "missing"; // pre-migration: markers only
    await cancelSends("a@x.com", "66812345678", "user-removed");
    await clearCancellation("a@x.com", "66812345678");
    const newest = state.markers[state.markers.length - 1];
    expect(newest.kind).toBe("cancel-cleared");
    expect(await isCancelled("a@x.com", "66812345678")).toBe(false);
  });
});
