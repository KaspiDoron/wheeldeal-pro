import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({ email: "owner@example.com" }),
}));

// A 401 IS A REJECTED KEY, NOT A REFUSED PERMISSION.
//
// This probe existed to answer one question honestly: can the browser's anon
// key call prune_old_rows and delete the owner's history? It read 401, 403 and
// 404 as one thing - "locked out" - and they are not one thing. PostgREST
// answers 401 when the apikey is missing, malformed, revoked, or from a
// DIFFERENT project: the request never reached a permission decision at all.
//
// So a database with the grant WIDE OPEN, probed with a stale anon key, was
// reported LOCKED. A security check manufacturing the exact reassurance it
// exists to withhold - and the tables probe beside it already called the same
// status "unknown", so the two halves of one response contradicted each other.

const realFetch = globalThis.fetch;
let responses: Record<string, { status: number; body?: unknown }> = {};

beforeEach(() => {
  process.env.SUPABASE_URL = "https://proj.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  responses = {};
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    const key = u.includes("/rpc/prune_old_rows") ? "rpc" : "tables";
    const r = responses[key] ?? { status: 200, body: { paths: {} } };
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
    rpc: { state: string; detail: string };
    tables: { state: string };
  };
};

describe("401 is never read as proof of anything", () => {
  it("a 401 on the RPC is UNKNOWN, not locked", async () => {
    responses = { rpc: { status: 401 }, tables: { status: 401 } };
    const out = await run();
    expect(out.rpc.state).toBe("unknown");
    expect(out.state).toBe("unknown");
  });

  it("and it names the real remedy - the key, not the grant", async () => {
    responses = { rpc: { status: 401 }, tables: { status: 401 } };
    const out = await run();
    expect(out.rpc.detail).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(out.rpc.detail).toMatch(/proves nothing/i);
  });

  it("the two probes agree about the same status code", async () => {
    // They disagreed: one called 401 "locked", the other "unknown".
    responses = { rpc: { status: 401 }, tables: { status: 401 } };
    const out = await run();
    expect(out.rpc.state).toBe(out.tables.state);
  });
});

describe("a REAL refusal still reads as locked", () => {
  it("403 with a clean schema is locked", async () => {
    responses = { rpc: { status: 403 }, tables: { status: 200, body: { paths: {} } } };
    const out = await run();
    expect(out.rpc.state).toBe("locked");
    expect(out.state).toBe("locked");
  });

  it("404 with a clean schema is locked - PostgREST will not name it", async () => {
    responses = { rpc: { status: 404 }, tables: { status: 200, body: { paths: {} } } };
    const out = await run();
    expect(out.rpc.state).toBe("locked");
    expect(out.state).toBe("locked");
  });
});

describe("an open grant is still caught, loudly", () => {
  it("a 200 from the RPC is EXPOSED whatever the tables say", async () => {
    responses = { rpc: { status: 200 }, tables: { status: 200, body: { paths: {} } } };
    const out = await run();
    expect(out.rpc.state).toBe("exposed");
    expect(out.state).toBe("exposed");
    expect(out.rpc.detail).toMatch(/DELETE YOUR HISTORY/);
  });

  it("a foreign table is exposed even when the RPC is locked", async () => {
    responses = {
      rpc: { status: 403 },
      tables: { status: 200, body: { paths: { "/": {}, "/Message": {}, "/rpc/x": {} } } },
    };
    const out = await run();
    expect(out.state).toBe("exposed");
  });
});
