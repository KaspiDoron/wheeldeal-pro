import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F021: parkOutboxOnce DELETED A ROW A DRAINER WAS MID-SEND ON.
//
// The park's one-row-per-shop delete scoped on sender_key, to_key and the
// reply kind only - no lease predicate - so it removed a row that
// outbox-lifecycle currently reports as `sending`. The drainer still held that
// row in memory (it was sleeping in the wait-not-repark loop, having already
// passed the stale-draft gate), so it sent the old draft anyway; the freshly
// parked replacement then drained a few seconds later. Two agent messages to
// one shop with different bodies, which the msg: idempotency slot cannot
// dedupe - the exact two-bargains-in-one-minute pattern the turn lock exists
// to prevent.
//
// The fix mirrors outboxState's lease semantics exactly (the refuter's
// concern): a row is untouchable while `meta.claimedAt` is inside
// CLAIM_LEASE_MS, and honestly `due` again - replaceable - once the lease has
// lapsed, so a crashed drainer's zombie can never block the shop's next reply
// forever. When the newer draft then collides with the live row on the unique
// index, the park says so with a wa-park-failed breadcrumb naming the live
// claim instead of returning as if the newer draft were queued.
//
// Executed against the REAL parkOutboxOnce over a Map-backed PostgREST store
// that also enforces wa_outbox_pending_auto_uidx.

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  const base = h.runtimeConfigMock() as Record<string, unknown> & {
    sbInsert: (t: string, rows: Record<string, unknown>[], c?: string) => Promise<boolean>;
  };
  // wa_outbox_pending_auto_uidx (schema.sql): UNIQUE (sender_key,
  // coalesce(to_key, to_number), coalesce(meta->>'kind','')) WHERE kind not in
  // (custom, human-manual). The helper knows only primary keys, so the
  // partial unique index is enforced here.
  const pendingKey = (r: Record<string, unknown>) => {
    const meta = (r.meta ?? {}) as { kind?: string };
    const kind = meta.kind ?? "";
    if (kind === "custom" || kind === "human-manual") return null;
    return `${r.sender_key}|${r.to_key ?? r.to_number}|${kind}`;
  };
  return {
    ...base,
    sbInsert: async (table: string, rows: Record<string, unknown>[], onConflict?: string) => {
      if (table === "wa_outbox") {
        for (const r of rows) {
          const k = pendingKey(r);
          if (k && h.store.rows("wa_outbox").some((x) => pendingKey(x) === k)) {
            h.store.log.push({ op: "insert", table, rows });
            return false; // 409 on the partial unique index
          }
          r.id = 100 + h.store.rows("wa_outbox").length;
        }
      }
      return base.sbInsert(table, rows, onConflict);
    },
  };
});

const probe: { state: "ready" | "missing" } = { state: "ready" };
vi.mock("../schema-probe", () => ({
  tableReady: async () => probe.state,
}));

// The real filter fragment, verbatim (wa-guard.ts) - the store's parser
// evaluates it, so the scope under test is the scope production sends.
vi.mock("../wa-guard", () => ({
  REPLY_KIND_FILTER: "&or=(meta->>kind.is.null,meta->>kind.not.in.(rfq,custom,human-manual))",
  humanizeForOutbound: (_s: string, _t: string, body: string) => body,
}));

import { store } from "../privacy/postgrest-store.test-helper";
import { CLAIM_LEASE_MS, outboxState } from "./outbox-lifecycle";
import { outboxKey } from "./phone-key";
import { parkOutboxOnce, setDrainArmer } from "./park";

const SENDER = "traveller@example.com";
const SHOP = "66812345678";
const KEY = outboxKey(SHOP);

function seedReply(id: number, body: string, meta: Record<string, unknown>, notBeforeMs: number) {
  store.seed("wa_outbox", [
    {
      id,
      sender_key: SENDER,
      to_number: SHOP,
      // A pre-migration database has no to_key column at all.
      ...(probe.state === "ready" ? { to_key: KEY } : {}),
      body,
      not_before: new Date(notBeforeMs).toISOString(),
      meta: { kind: "bargain", vendorId: "v1", vendorName: "Shop", ...meta },
    },
  ]);
}

const park = (body: string) =>
  parkOutboxOnce({
    senderKey: SENDER,
    toNumber: SHOP,
    body,
    notBeforeMs: Date.now() + 15_000,
    meta: { kind: "bargain", vendorId: "v1", vendorName: "Shop" },
    alreadyHumanized: true,
  });

beforeEach(() => {
  store.reset();
  probe.state = "ready";
  setDrainArmer(() => {});
});

describe("EXECUTED (F021): a row inside its drain lease is never deleted by a newer park", () => {
  it("the live row survives, no second pending row appears, and the collision is breadcrumbed", async () => {
    const now = Date.now();
    // Claimed 5s ago: the drainer holds it (outboxState says `sending`).
    seedReply(1, "old draft, in flight", { claimedAt: now - 5_000 }, now + CLAIM_LEASE_MS - 5_000);
    expect(outboxState(store.rows("wa_outbox")[0].not_before as string, store.rows("wa_outbox")[0].meta as never, now)).toBe("sending");

    await park("newer draft composed against the shop's latest message");

    // THE ASSERTION THAT FAILED BEFORE: the leased row was deleted, and the
    // newer draft was inserted in its place - so the drainer sent the old
    // body from memory and the new row went out right after it.
    const rows = store.rows("wa_outbox");
    expect(rows.map((r) => r.id)).toEqual([1]);
    expect(rows[0].body).toBe("old draft, in flight");

    // The delete the park issued carries the lease predicate.
    const del = store.log.find((w) => w.op === "delete" && w.table === "wa_outbox");
    expect(del?.query ?? "").toMatch(/claimedAt/);

    // ...and the park did not pretend the newer draft was queued: the
    // collision with the live claim is named.
    const crumbs = store.rows("agent_events").filter((e) => e.kind === "wa-park-failed");
    expect(crumbs).toHaveLength(1);
    expect(String(crumbs[0].detail)).toMatch(/lease|mid-send|in flight/i);
    expect(crumbs[0].user_email).toBe(SENDER);
  });

  it("the to_number fallback spelling (to_key not migrated) honours the lease too", async () => {
    probe.state = "missing";
    const now = Date.now();
    seedReply(1, "old draft, in flight", { claimedAt: now - 5_000 }, now + CLAIM_LEASE_MS - 5_000);
    await park("newer draft");
    expect(store.rows("wa_outbox").map((r) => r.id)).toEqual([1]);
    const del = store.log.find((w) => w.op === "delete" && w.table === "wa_outbox");
    expect(del?.query ?? "").toMatch(/to_number=eq\./);
    expect(del?.query ?? "").toMatch(/claimedAt/);
  });
});

describe("the lease is mirrored exactly - lapsed means due, and due means replaceable", () => {
  it("a LAPSED claim (crashed drainer) is replaced by the newer draft, never a permanent zombie", async () => {
    const now = Date.now();
    // Claimed longer ago than the lease: outboxState reports it `due` again.
    seedReply(1, "zombie draft", { claimedAt: now - CLAIM_LEASE_MS - 1_000 }, now - 1_000);
    expect(outboxState(store.rows("wa_outbox")[0].not_before as string, store.rows("wa_outbox")[0].meta as never, now)).toBe("due");

    await park("newer draft");

    const rows = store.rows("wa_outbox");
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("newer draft");
    expect(store.rows("agent_events").filter((e) => e.kind === "wa-park-failed")).toHaveLength(0);
  });

  it("an unclaimed pending reply is replaced by the newer composition (the one-row invariant)", async () => {
    seedReply(1, "older pending draft", {}, Date.now() + 20_000);
    await park("newer draft");
    const rows = store.rows("wa_outbox");
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("newer draft");
  });

  it("a pending cold RFQ to the same shop is never touched (kind scoping)", async () => {
    store.seed("wa_outbox", [
      {
        id: 7,
        sender_key: SENDER,
        to_number: SHOP,
        to_key: KEY,
        body: "cold intro",
        not_before: new Date(Date.now() + 30_000).toISOString(),
        meta: { kind: "rfq" },
      },
    ]);
    await park("a reply");
    const rows = store.rows("wa_outbox");
    expect(rows.find((r) => r.id === 7)?.body).toBe("cold intro");
    expect(rows.some((r) => r.body === "a reply")).toBe(true);
  });
});
