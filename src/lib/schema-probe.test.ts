import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { tableReady, schemaDetail, resetSchemaProbeCache, NEGATIVE_TTL_MS } from "./schema-probe";
import { isMissingSchemaBody } from "./runtime-config";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A GREEN CARD OVER AN EMPTY DATABASE.
//
// The deploy-info card exists to answer "did the schema land?" from a phone. It
// asked by wrapping sbSelect in a try/catch - and sbSelect has NO throw path, so
// the catch was dead code and all seven probes returned ok:true whatever the
// database contained. The one instrument built to catch a silent degradation was
// itself silently degraded, and no test existed that could have noticed.

// A REAL Response, not a hand-rolled shape. The partial fake had `json` and
// nothing else, so it broke the moment production started weighing payloads on
// the way past (the egress meter, owner report 10). A stand-in that implements
// one method of the thing it stands in for will keep doing that.
const OK = (rows: unknown[] = []) =>
  new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const ERR = (status: number, body: string) =>
  ({ ok: false, status, text: async () => body, json: async () => ({}) }) as unknown as Response;

describe("REPRODUCTION: the probe could not report a missing table", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetSchemaProbeCache();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("a 400 with the undefined-column code is MISSING, not ready", async () => {
    globalThis.fetch = vi.fn(async () =>
      ERR(400, JSON.stringify({ code: "42703", message: 'column "to_key" does not exist' }))
    ) as unknown as typeof fetch;
    expect(await tableReady("wa_outbox", "to_key")).toBe("missing");
  });

  it("a 400 with the undefined-table code is MISSING", async () => {
    globalThis.fetch = vi.fn(async () =>
      ERR(400, JSON.stringify({ code: "42P01", message: "relation does not exist" }))
    ) as unknown as typeof fetch;
    expect(await tableReady("consent_events", "email")).toBe("missing");
  });

  it("a 404 is MISSING - PostgREST answers an unknown relation that way", async () => {
    globalThis.fetch = vi.fn(async () => ERR(404, "")) as unknown as typeof fetch;
    expect(await tableReady("consent_events", "email")).toBe("missing");
  });

  it("a successful read is READY", async () => {
    globalThis.fetch = vi.fn(async () => OK([])) as unknown as typeof fetch;
    expect(await tableReady("app_users", "terms_version")).toBe("ready");
  });

  it("a 500 is UNAVAILABLE - unknown is not the same answer as no", async () => {
    // The whole point of the split: "missing" says the schema was never run and
    // the read is vacuously empty; "unavailable" says we do not know. A caller
    // that treats a blip as "missing" makes a decision on a fact it does not have.
    globalThis.fetch = vi.fn(async () => ERR(500, "upstream")) as unknown as typeof fetch;
    expect(await tableReady("app_users", "terms_version")).toBe("unavailable");
  });

  it("a network throw is UNAVAILABLE, not missing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await tableReady("app_users", "terms_version")).toBe("unavailable");
  });
});

describe("REPRODUCTION: PostgREST says 'missing' in three dialects, two were matched", () => {
  it("the Postgres SQLSTATE codes", () => {
    expect(isMissingSchemaBody('{"code":"42P01"}')).toBe(true);
    expect(isMissingSchemaBody('{"code":"42703"}')).toBe(true);
  });

  it("PGRST204 - a schema-CACHE miss carries no Postgres code at all", () => {
    // The query never reaches the database, so there is no SQLSTATE to match.
    // Matching only the codes made this degrade to "unavailable" - the wrong
    // fail direction for a gate that decides whether to block every user.
    expect(
      isMissingSchemaBody(
        '{"code":"PGRST204","message":"Column \'terms_version\' of \'app_users\' not found in the schema cache"}'
      )
    ).toBe(true);
  });

  it("and the bare prose, from versions that forward no code", () => {
    expect(isMissingSchemaBody('{"message":"column app_users.terms_version does not exist"}')).toBe(
      true
    );
  });

  it("an ordinary failure is NOT read as missing", () => {
    expect(isMissingSchemaBody('{"message":"JWT expired"}')).toBe(false);
    expect(isMissingSchemaBody("")).toBe(false);
  });
});

describe("the cache direction, which matters more than the cache", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetSchemaProbeCache();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("a positive sticks - nothing in this app drops a column", async () => {
    const f = vi.fn(async () => OK([]));
    globalThis.fetch = f as unknown as typeof fetch;
    expect(await tableReady("app_users", "terms_version")).toBe("ready");
    expect(await tableReady("app_users", "terms_version")).toBe("ready");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("REPRODUCTION: a negative must EXPIRE, or schema.sql needs a redeploy to take effect", async () => {
    // The owner runs schema.sql in the Supabase editor. If a "missing" answer
    // were cached for the process lifetime, the app would keep insisting the
    // table is absent - and the only way to clear it would be a redeploy, which
    // is exactly the manual step this whole surface exists to avoid.
    const f = vi.fn(async () => ERR(404, ""));
    globalThis.fetch = f as unknown as typeof fetch;
    expect(await tableReady("consent_events", "email")).toBe("missing");
    expect(await tableReady("consent_events", "email")).toBe("missing");
    expect(f).toHaveBeenCalledTimes(1); // cached within the TTL

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + NEGATIVE_TTL_MS + 1);
      globalThis.fetch = vi.fn(async () => OK([])) as unknown as typeof fetch;
      expect(await tableReady("consent_events", "email")).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the TTL is short enough that the owner does not wait on it", () => {
    expect(NEGATIVE_TTL_MS).toBeLessThanOrEqual(120_000);
  });
});

describe("the card says what to DO about each state", () => {
  it("missing names the command; unreadable does not pretend to be missing", () => {
    expect(schemaDetail("missing")).toMatch(/supabase\/schema\.sql/);
    expect(schemaDetail("unavailable")).toMatch(/unreadable/i);
    expect(schemaDetail("ready")).toBe("present");
  });

  it("the route probes through tableReady, not through the throw that never happens", () => {
    const route = readCode("src/app/api/admin/deploy-info/route.ts");
    expect(route).toMatch(/const state = await tableReady\(table, select\);/);
    expect(route).toMatch(/ok: state === "ready"/);
    // The dead try/catch around sbSelect is gone.
    expect(route).not.toMatch(/await sbSelect\(table,/);
  });

  it("...and a failed probe reaches the problems list with its own detail", () => {
    const route = readCode("src/app/api/admin/deploy-info/route.ts");
    expect(route).toMatch(/\.filter\(\(\[, v\]\) => !v\.ok\)/);
    expect(route).toMatch(/`schema: \$\{k\} - \$\{v\.detail\}`/);
  });
});
