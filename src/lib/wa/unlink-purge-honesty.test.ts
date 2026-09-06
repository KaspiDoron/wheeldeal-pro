import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT M50: THE DISCONNECT PURGE OF PARKED WORK WAS FIRE-AND-FORGET.
//
// disconnectInstance deleted the traveller's wa_outbox rows and graph_wakeups
// with `.catch(() => {})` - but sbDelete never rejects, it returns false on
// any non-2xx or timeout, so the catch was decoration and the only signal was
// the DISCARDED boolean. A PostgREST 5xx during a disconnect left the parked
// rows behind, the result still said the link was severed, and the rows
// survived to fire stale sends the moment the traveller re-linked
// (outboxExpired keeps a row live for 6h; a wakeup never ages out).
//
// EXECUTED against the real disconnectInstance and the real connectInstance
// over a Map-backed store with the Evolution host stubbed at fetch: the purge
// is read and retried, its outcome is reported, a failed purge leaves a
// durable marker, and the re-link path drains that marker BEFORE anything can
// send.

const deleteFailures: { table: string; remaining: number }[] = [];

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  const base = h.runtimeConfigMock() as Record<string, unknown> & {
    sbDelete: (t: string, f: string) => Promise<boolean>;
  };
  return {
    ...base,
    // A delete that fails N times for a table, then works (a PostgREST blip).
    sbDelete: async (table: string, filter: string) => {
      const f = deleteFailures.find((d) => d.table === table && d.remaining > 0);
      if (f) {
        f.remaining -= 1;
        h.store.log.push({ op: "delete", table, query: filter });
        return false;
      }
      return base.sbDelete(table, filter);
    },
  };
});

import { store } from "../privacy/postgrest-store.test-helper";
import { disconnectInstance, connectInstance } from "../evolution";
import { POST as disconnectRoute } from "@/app/api/wa/disconnect/route";

vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "linked@example.com", plan: "free" }),
}));

const EMAIL = "linked@example.com";
const OTHER = "someone-else@example.com";

beforeEach(() => {
  store.reset();
  deleteFailures.length = 0;
  store.config.set("EVOLUTION_API_URL", "https://evo.test");
  store.config.set("EVOLUTION_API_KEY", "test-key");
  store.seed("wa_sessions", [{ email: EMAIL, instance_name: "wd-x", status: "open" }]);
  store.seed("wa_outbox", [
    { id: 1, sender_key: EMAIL, to_number: "66811111111", body: "hi", not_before: "2020-01-01T00:00:00.000Z" },
    { id: 2, sender_key: EMAIL, to_number: "66822222222", body: "hi", not_before: "2020-01-01T00:00:00.000Z" },
    { id: 3, sender_key: OTHER, to_number: "66833333333", body: "hi", not_before: "2020-01-01T00:00:00.000Z" },
  ]);
  store.seed("graph_wakeups", [
    { id: 10, kind: "tick", thread_key: `${EMAIL}:66811111111`, user_email: EMAIL, not_before: "2020-01-01T00:00:00.000Z" },
    { id: 11, kind: "tick", thread_key: `${OTHER}:66833333333`, user_email: OTHER, not_before: "2020-01-01T00:00:00.000Z" },
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://evo.test/")) return new Response('{"status":"SUCCESS"}', { status: 200 });
      return new Response("{}", { status: 200 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mine = (table: string, col: string) => store.rows(table).filter((r) => r[col] === EMAIL);
const marker = () =>
  store.rows("user_cooldowns").filter((r) => r.email === EMAIL && r.kind === "wa-purge-pending");

describe("EXECUTED (M50): the disconnect purge is awaited, retried and reported", () => {
  it("a clean disconnect purges only this sender's parked rows and reports purged: true", async () => {
    const r = await disconnectInstance(EMAIL);
    expect(r.severed).toBe(true);
    expect(r.purged).toBe(true);
    expect(mine("wa_outbox", "sender_key")).toHaveLength(0);
    expect(mine("graph_wakeups", "user_email")).toHaveLength(0);
    // Another traveller's parked work is untouched.
    expect(store.rows("wa_outbox")).toHaveLength(1);
    expect(store.rows("graph_wakeups")).toHaveLength(1);
    expect(marker()).toHaveLength(0);
  });

  it("a single PostgREST blip is absorbed by the retry: still purged, still purged: true", async () => {
    deleteFailures.push({ table: "wa_outbox", remaining: 1 });
    const r = await disconnectInstance(EMAIL);
    expect(r.severed).toBe(true);
    expect(r.purged).toBe(true);
    expect(mine("wa_outbox", "sender_key")).toHaveLength(0);
    expect(marker()).toHaveLength(0);
  });

  it("a purge that keeps failing is REPORTED (purged: false) and leaves a durable purge-pending marker", async () => {
    store.failWrites.add("wa_outbox");
    const r = await disconnectInstance(EMAIL);
    // The host-side sever succeeded - the link IS gone...
    expect(r.severed).toBe(true);
    // ...but the parked rows are still there, and the result says so.
    expect(r.purged).toBe(false);
    expect(mine("wa_outbox", "sender_key")).toHaveLength(2);
    expect(marker()).toHaveLength(1);
  });

  it("the disconnect route echoes the purge outcome instead of a bare {ok:true}", async () => {
    store.failWrites.add("wa_outbox");
    const res = await disconnectRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, severed: true, purged: false });
  });

  it("the re-link path drains the marker: the rows the disconnect could not purge are gone before the link opens", async () => {
    store.failWrites.add("wa_outbox");
    await disconnectInstance(EMAIL);
    expect(mine("wa_outbox", "sender_key")).toHaveLength(2);
    expect(marker()).toHaveLength(1);
    // The store is healthy again by the time the traveller re-links.
    store.failWrites.delete("wa_outbox");
    // No Evolution host is placeable here (nothing configured for placement),
    // so connectInstance returns early - the purge-pending drain sits in
    // front of every later step, which is the point.
    store.config.delete("EVOLUTION_API_URL");
    await connectInstance(EMAIL, "https://app.test", "+66899999999");
    expect(mine("wa_outbox", "sender_key")).toHaveLength(0);
    expect(mine("graph_wakeups", "user_email")).toHaveLength(0);
    expect(marker()).toHaveLength(0);
    // Still nobody else's rows.
    expect(store.rows("wa_outbox")).toHaveLength(1);
  });
});
