import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT F049 - blocking a user revoked the cookie but stopped nothing on the
// WhatsApp wire.
//
// setUserStatus flipped app_users.status and moved the revocation horizon -
// and no send path reads account status. A blocked tester's parked wa_outbox
// rows kept draining from their own linked number, their strategic-wait
// wakeups kept firing, and every shop reply kept producing an agent answer,
// because the inbound path is token/claim-gated only. The owner had no
// per-user lever short of the fleet-wide kill switch or erasing the account.
//
// The block now has a WRITE-side wire half, the way disconnectInstance and
// closeSearchSession already do it: the sender's parked outbox rows and
// wakeups are purged, and every shop the account has contacted is tombstoned
// in wa_cancellations - the veto guardOutbound already enforces on automated
// sends - so nothing is added to the drain or the reply path. Executed against
// the real setUserStatus with a Map-backed store, and the tombstone is read
// back through the real isCancelled.

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const db: {
  app_users: Map<string, Row>;
  wa_outbox: Row[];
  graph_wakeups: Row[];
  wa_recipient_state: Row[];
  wa_cancellations: Row[];
  markers: Row[];
  updates: { table: string; filter: string; values: Row }[];
  userWrite: boolean;
} = {
  app_users: new Map(),
  wa_outbox: [],
  graph_wakeups: [],
  wa_recipient_state: [],
  wa_cancellations: [],
  markers: [],
  updates: [],
  userWrite: true,
};

const param = (query: string, key: string) =>
  decodeURIComponent(new RegExp(`(?:^|&)${key}=eq\\.([^&]+)`).exec(query)?.[1] ?? "");

vi.mock("./runtime-config", () => ({
  supabaseConfigured: () => true,
  getConfig: async () => undefined,
  sbSelectStrict: async (table: string, query: string) => {
    if (table === "app_users") {
      const row = db.app_users.get(param(query, "email"));
      return { rows: row ? [row] : [] };
    }
    if (table === "wa_cancellations") {
      const sender = param(query, "sender_key");
      const eqs = [...query.matchAll(/to_number\.eq\.([0-9]+)/g)].map((m) => m[1]);
      const exact = param(query, "to_number");
      if (exact) eqs.push(exact);
      return {
        rows: db.wa_cancellations
          .filter((r) => r.sender_key === sender && (eqs.length === 0 || eqs.includes(String(r.to_number))))
          .map((r, i) => ({ id: i + 1, ...r })),
      };
    }
    if (table === "whatsapp_messages") return { rows: [] };
    return { rows: [] };
  },
  sbSelect: async (table: string, query: string) => {
    if (table === "app_users") {
      const row = db.app_users.get(param(query, "email"));
      return row ? [row] : [];
    }
    if (table === "wa_recipient_state") {
      const sender = param(query, "sender_key");
      return db.wa_recipient_state.filter((r) => r.sender_key === sender);
    }
    return [];
  },
  sbInsert: async (table: string, rows: Row[]) => {
    if (table === "app_users") {
      if (!db.userWrite) return false;
      for (const r of rows) db.app_users.set(String(r.email), { ...db.app_users.get(String(r.email)), ...r });
      return true;
    }
    if (table === "wa_cancellations") {
      for (const r of rows) {
        db.wa_cancellations = db.wa_cancellations.filter(
          (x) => !(x.sender_key === r.sender_key && x.to_number === r.to_number)
        );
        db.wa_cancellations.push(r);
      }
      return true;
    }
    if (table === "whatsapp_messages") {
      db.markers.push(...rows);
      return true;
    }
    return true;
  },
  sbUpdate: async (table: string, filter: string, values: Row) => {
    db.updates.push({ table, filter, values });
    return true;
  },
  sbDelete: async (table: string, query: string) => {
    if (table === "graph_wakeups") {
      const who = param(query, "user_email");
      db.graph_wakeups = db.graph_wakeups.filter((r) => r.user_email !== who);
      return true;
    }
    if (table === "wa_outbox") {
      const who = param(query, "sender_key");
      db.wa_outbox = db.wa_outbox.filter((r) => r.sender_key !== who);
      return true;
    }
    return true;
  },
  sbDeleteReturning: async (table: string, query: string) => {
    if (table !== "wa_outbox") return [];
    const who = param(query, "sender_key");
    const gone = db.wa_outbox.filter((r) => r.sender_key === who);
    db.wa_outbox = db.wa_outbox.filter((r) => r.sender_key !== who);
    return gone;
  },
}));

import { setUserStatus } from "./access";
import { isCancelled } from "./wa/cancellations";

const T = "tester@example.com";
const OTHER = "other@example.com";
const user = (email: string): Row => ({
  email,
  provider: "email",
  status: "active",
  plan: "free",
  password_hash: null,
  must_change_password: false,
  terms_accepted_at: null,
  terms_version: null,
  wa_risk_accepted_at: null,
  ai_responsibility_accepted_at: null,
  stay_label: null,
  stay_lat: null,
  stay_lng: null,
  stay_share_consent_at: null,
  sessions_valid_from: null,
  added_at: new Date(1_700_000_000_000).toISOString(),
  last_seen: new Date(1_700_000_000_000).toISOString(),
});

beforeEach(() => {
  globalThis.__wheeldeal_users_v2__ = new Map();
  db.app_users = new Map([
    [T, user(T)],
    [OTHER, user(OTHER)],
  ]);
  // The tester tapped mass bargain: one intro left, eleven parked; three
  // earlier threads are live (contacted, no outbox row, awaiting a reply); one
  // shop was contacted a month ago.
  db.wa_outbox = [
    ...Array.from({ length: 11 }, (_, i) => ({ id: i + 1, sender_key: T, to_number: `6281200000${i}` })),
    { id: 99, sender_key: OTHER, to_number: "6281299999999" },
  ];
  db.graph_wakeups = [
    { id: 1, user_email: T, kind: "tick" },
    { id: 2, user_email: T, kind: "judge" },
    { id: 3, user_email: OTHER, kind: "tick" },
  ];
  const recent = new Date(Date.now() - 3600_000).toISOString();
  db.wa_recipient_state = [
    { sender_key: T, to_number: "62813000001", last_sent_at: recent },
    { sender_key: T, to_number: "62813000002", last_sent_at: recent },
    { sender_key: T, to_number: "62813000003", last_sent_at: recent },
    { sender_key: T, to_number: "62813000004", last_sent_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() },
    { sender_key: OTHER, to_number: "62813000009", last_sent_at: recent },
  ];
  db.wa_cancellations = [];
  db.markers = [];
  db.updates = [];
  db.userWrite = true;
});

describe("blocking an account cancels its wire, not just its cookie", () => {
  it("REGRESSION: the parked batch and wakeups are purged, and every contacted shop is tombstoned", async () => {
    const ok = await setUserStatus(T, "blocked");
    // The eleven parked RFQs never drain from the blocked traveller's number.
    expect(db.wa_outbox.filter((r) => r.sender_key === T), "parked outbox rows must be gone").toEqual([]);
    expect(ok, "the status write persisted").toBe(true);
    expect(db.graph_wakeups.filter((r) => r.user_email === T)).toEqual([]);
    // Every shop this account ever contacted - parked or live - is vetoed at
    // the send moment through the guard's existing cancellation gate.
    for (const shop of ["62812000000", "62812000005", "62813000001", "62813000003", "62813000004"]) {
      expect(await isCancelled(T, shop), `shop ${shop} must be tombstoned`).toBe(true);
    }
    const reasons = new Set(db.wa_cancellations.map((r) => r.reason));
    expect([...reasons]).toEqual(["account-blocked"]);
    // The status write and the revocation horizon still happen.
    expect(db.app_users.get(T)?.status).toBe("blocked");
    expect(db.updates.some((u) => u.table === "app_users" && "sessions_valid_from" in u.values)).toBe(true);
  });

  it("another traveller's parked work and shops are untouched", async () => {
    await setUserStatus(T, "blocked");
    expect(db.wa_outbox.filter((r) => r.sender_key === OTHER)).toHaveLength(1);
    expect(db.graph_wakeups.filter((r) => r.user_email === OTHER)).toHaveLength(1);
    expect(await isCancelled(OTHER, "62813000009")).toBe(false);
    expect(db.app_users.get(OTHER)?.status).toBe("active");
  });

  it("unblocking purges nothing and tombstones nothing", async () => {
    await setUserStatus(T, "active");
    expect(db.wa_outbox.filter((r) => r.sender_key === T)).toHaveLength(11);
    expect(db.graph_wakeups.filter((r) => r.user_email === T)).toHaveLength(2);
    expect(db.wa_cancellations).toEqual([]);
  });

  it("reports a status write that did not persist as false", async () => {
    db.userWrite = false;
    expect(await setUserStatus(T, "blocked")).toBe(false);
  });
});
