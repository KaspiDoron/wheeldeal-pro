import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({ email: "owner@example.com", role: "owner" }),
}));

// AUDIT F190: THE ANON PROBE CALLED EVERY ONE OF THE APP'S OWN TABLES A FOREIGN
// EXPOSURE.
//
// Probe 2 read PostgREST's anon OpenAPI document and reported every path in it
// as an exposed relation. That document lists what the role has a GRANT on,
// not what RLS lets it read - and Supabase's default privileges grant anon on
// every table created from the SQL editor, which is how schema.sql is run. So
// on a correctly configured project the probe enumerated all ~57 app tables,
// painted a permanent red EXPOSED with a remedy that does not apply ("move
// that service to its own database"), and a genuinely foreign relation
// (Evolution's "Message") hid inside a list that was red every time.
//
// The repair splits the enumeration against the erasure registry's CI-pinned
// table list (registeredTables + EXCLUDED_TABLES, which wave9-erasure.test.ts
// proves matches every `create table` in the SQL files): only unknown names
// are foreign, and RLS on the app's own tables is MEASURED with an anon row
// read of the highest-value ones rather than inferred from the listing.

import { registeredTables, EXCLUDED_TABLES } from "@/lib/privacy/user-tables";

const realFetch = globalThis.fetch;

type Reply = { status: number; body?: unknown };
let rpcReply: Reply = { status: 403 };
let docReply: Reply = { status: 200, body: { paths: {} } };
/** Per-table anon row reads (`/rest/v1/<table>?...`). Default: RLS holds (zero rows). */
let rowReplies: Record<string, Reply> = {};
let rowReads: string[] = [];

const ownTables = () => [...registeredTables(), ...Object.keys(EXCLUDED_TABLES)];
const docOf = (names: string[]) => ({
  paths: Object.fromEntries(["/", "/rpc/prune_old_rows", ...names.map((n) => `/${n}`)].map((p) => [p, {}])),
});

beforeEach(() => {
  process.env.SUPABASE_URL = "https://proj.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  rpcReply = { status: 403 };
  docReply = { status: 200, body: { paths: {} } };
  rowReplies = {};
  rowReads = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    let r: Reply;
    if (u.includes("/rest/v1/rpc/prune_old_rows")) r = rpcReply;
    else if (/\/rest\/v1\/?$/.test(u.split("?")[0])) r = docReply;
    else {
      const table = /\/rest\/v1\/([a-z_]+)/.exec(u)?.[1] ?? "";
      rowReads.push(table);
      r = rowReplies[table] ?? { status: 200, body: [] };
    }
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const run = async () => {
  const { GET } = await import("./route");
  return (await (await GET()).json()) as {
    state: string;
    detail: string;
    rpc: { state: string };
    tables: { state: string; exposed: string[]; detail: string };
  };
};

describe("EXECUTED (F190): the app's own tables under the default anon grant are not a foreign exposure", () => {
  it("a document listing exactly the app's own tables, with RLS holding, is not EXPOSED", async () => {
    docReply = { status: 200, body: docOf(ownTables()) };
    const out = await run();
    expect(out.tables.state).not.toBe("exposed");
    expect(out.tables.exposed).toEqual([]);
    // The combined verdict the panel colours from: a locked RPC over RLS that
    // was measured to hold is LOCKED, not a red alarm.
    expect(out.state).toBe("locked");
  });

  it("RLS is MEASURED, not inferred: the probe reads rows from the highest-value tables with the anon key", async () => {
    docReply = { status: 200, body: docOf(ownTables()) };
    await run();
    expect(rowReads).toContain("whatsapp_messages");
    expect(rowReads).toContain("app_users");
    expect(rowReads).toContain("app_config");
  });

  it("a foreign relation is still EXPOSED, and it is named ALONE rather than buried among 57 app tables", async () => {
    docReply = { status: 200, body: docOf([...ownTables(), "Message", "Chat"]) };
    const out = await run();
    expect(out.tables.state).toBe("exposed");
    expect(out.tables.exposed).toEqual(["Chat", "Message"]);
    expect(out.tables.exposed).not.toContain("whatsapp_messages");
    expect(out.state).toBe("exposed");
  });

  it("an app table whose RLS actually leaks a row is a REAL breach, named by table", async () => {
    docReply = { status: 200, body: docOf(ownTables()) };
    rowReplies = { whatsapp_messages: { status: 200, body: [{ wa_message_id: "x" }] } };
    const out = await run();
    expect(out.tables.state).toBe("exposed");
    expect(out.tables.exposed).toContain("whatsapp_messages");
    expect(out.tables.detail).toMatch(/whatsapp_messages/);
    expect(out.state).toBe("exposed");
  });

  it("a 401 on the row read is UNKNOWN - a rejected key measures nothing", async () => {
    docReply = { status: 200, body: docOf(ownTables()) };
    rowReplies = { app_users: { status: 401 } };
    const out = await run();
    expect(out.tables.state).toBe("unknown");
    expect(out.state).toBe("unknown");
  });

  it("an empty document is still CLEAN", async () => {
    const out = await run();
    expect(out.tables.state).toBe("clean");
    expect(out.state).toBe("locked");
  });
});
