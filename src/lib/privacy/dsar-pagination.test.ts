import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// A SUBJECT ACCESS EXPORT THAT STOPPED AT ROW 1000 AND SAID NOTHING.
//
// buildDsarExport read every table with `limit=1000`, no ORDER, and no second
// page. A heavy user has more than 1000 whatsapp_messages, agent_events and
// api_usage rows within weeks, so their "everything we hold about you" was the
// first thousand rows Postgres happened to return - a different thousand on a
// different day, because an unordered read has no defined order - and the
// document carried no mark that anything was missing. `rowLimitPerTable: 1000`
// sat at the bottom like a footnote nobody is told to read.
//
// That is the exact failure `unreadable` was built to stop, arriving by a
// different door: a false statement about what we hold, dressed as data.
//
// Executed: the REAL assembly over a Map-backed store that evaluates the real
// query strings (order, limit, offset), with a wrapper that can cap pages and
// fail reads so the awkward cases are reachable.

const knobs = vi.hoisted(() => ({
  /** A server-side page cap BELOW what the client asked for (PostgREST max-rows). */
  serverMaxRows: 0,
  /** `${table}|${offset}` reads that answer "unavailable". */
  failAt: new Set<string>(),
  /** Tables that answer "missing" to any read naming an order (a stale order key). */
  orderUnknown: new Set<string>(),
  /** Every query string the export issued. */
  queries: [] as { table: string; query: string }[],
}));

vi.mock("../runtime-config", async () => {
  const h = await import("./postgrest-store.test-helper");
  const base = h.runtimeConfigMock();
  const strict = base.sbSelectStrict as (
    table: string,
    query: string
  ) => Promise<{ rows: Record<string, unknown>[] } | { error: "missing" | "unavailable" }>;
  return {
    ...base,
    sbSelectStrict: async (table: string, query: string) => {
      knobs.queries.push({ table, query });
      const offset = Number(/(?:^|&)offset=(\d+)/.exec(query)?.[1] ?? 0);
      if (knobs.failAt.has(`${table}|${offset}`)) return { error: "unavailable" as const };
      if (knobs.orderUnknown.has(table) && /(?:^|&)order=/.test(query)) {
        return { error: "missing" as const };
      }
      const read = await strict(table, query);
      if ("rows" in read && knobs.serverMaxRows > 0) {
        return { rows: read.rows.slice(0, knobs.serverMaxRows) };
      }
      return read;
    },
  };
});

import { store } from "./postgrest-store.test-helper";
import { buildDsarExport, exportOrderFor, DSAR_PAGE_ROWS, DSAR_MAX_PAGES } from "./dsar";
import { USER_TABLES, CHILD_TABLES } from "./user-tables";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const CEILING = DSAR_PAGE_ROWS * DSAR_MAX_PAGES;

/** n rows for one person, seeded in SCRAMBLED id order - the store must not be
 *  able to make the export look ordered by accident. */
function seedSearches(email: string, n: number, idBase = 0): void {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: idBase + i + 1,
    user_email: email,
    query: `q${i + 1}`,
  }));
  for (let i = rows.length - 1; i > 0; i--) {
    const j = (i * 7919 + 13) % (i + 1);
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  store.seed("searches", rows);
}

beforeEach(() => {
  store.reset();
  knobs.serverMaxRows = 0;
  knobs.failAt.clear();
  knobs.orderUnknown.clear();
  knobs.queries.length = 0;
  store.seed("app_users", [{ email: ALICE, status: "active", plan: "free", provider: "email" }]);
});

describe("EXECUTED: the export does not stop at the first page", () => {
  it("a person with 2,500 rows gets all 2,500 - and nobody else's", async () => {
    seedSearches(ALICE, 2500);
    seedSearches(BOB, 40, 10_000);
    const doc = await buildDsarExport(ALICE);
    const rows = doc.data.searches as { id: number; user_email: string }[];
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500); // no row twice
    expect(rows.every((r) => r.user_email === ALICE)).toBe(true);
    expect(doc.manifest.searches).toEqual({ rows: 2500, truncated: false });
    expect(doc.truncated).toEqual([]);
    expect(doc.unreadable).toEqual([]);
  });

  it("the order is DETERMINISTIC: by key, whatever order the store held the rows in", async () => {
    seedSearches(ALICE, 2500);
    const ids = ((await buildDsarExport(ALICE)).data.searches as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // ...and every paged read names its order - offset without ORDER BY is
    // undefined behaviour in Postgres, rows can repeat or vanish between pages.
    const paged = knobs.queries.filter((q) => q.table === "searches");
    expect(paged.length).toBeGreaterThan(1);
    for (const q of paged) expect(q.query).toMatch(/(?:^|&)order=id\.asc(?:&|$)/);
  });

  it("a server page cap BELOW the page size cannot end the read early", async () => {
    // PostgREST `max-rows` (Supabase: API settings -> Max rows) silently trims
    // a response. A loop that stops on the first SHORT page would read 400 of
    // 1,300 rows and call it complete - the same defect one level down.
    knobs.serverMaxRows = 400;
    seedSearches(ALICE, 1300);
    const doc = await buildDsarExport(ALICE);
    expect(doc.data.searches).toHaveLength(1300);
    expect(doc.manifest.searches).toEqual({ rows: 1300, truncated: false });
  });
});

describe("EXECUTED: the ceiling is a stated fact, not a silent one", () => {
  it("one row past the ceiling: truncated is TRUE, per table and at the top of the document", async () => {
    seedSearches(ALICE, CEILING + 1);
    const doc = await buildDsarExport(ALICE);
    expect(doc.data.searches).toHaveLength(CEILING);
    expect(doc.manifest.searches).toEqual({ rows: CEILING, truncated: true });
    expect(doc.truncated).toEqual(["searches"]);
    expect(doc.rowLimitPerTable).toBe(CEILING);
    // What was kept is the FIRST rows by key - stated, reproducible.
    expect((doc.data.searches as { id: number }[])[0].id).toBe(1);
    expect((doc.data.searches as { id: number }[])[CEILING - 1].id).toBe(CEILING);
  });

  it("EXACTLY the ceiling is complete, and says so - the flag is not a guess", async () => {
    seedSearches(ALICE, CEILING);
    const doc = await buildDsarExport(ALICE);
    expect(doc.data.searches).toHaveLength(CEILING);
    expect(doc.manifest.searches).toEqual({ rows: CEILING, truncated: false });
    expect(doc.truncated).toEqual([]);
  });

  it("a cut transcript table makes the media list derived from it cut too", async () => {
    // storage:wa-media is built FROM the exported whatsapp_messages rows, so it
    // can be no more complete than they are - and must not claim to be.
    store.seed(
      "whatsapp_messages",
      Array.from({ length: CEILING + 1 }, (_, i) => ({
        id: i + 1,
        wa_message_id: `wamid-${i + 1}`,
        direction: "inbound",
        raw: { receiver: ALICE, media: i === 0 ? { kind: "image", mime: "image/jpeg" } : null },
      }))
    );
    const doc = await buildDsarExport(ALICE);
    expect(doc.manifest.whatsapp_messages).toEqual({ rows: CEILING, truncated: true });
    expect(doc.manifest["storage:wa-media"]).toEqual({ rows: 1, truncated: true });
    expect(doc.truncated.sort()).toEqual(["storage:wa-media", "whatsapp_messages"]);
  });

  it("every exported table has a manifest line, including the genuinely empty ones", async () => {
    seedSearches(ALICE, 3);
    const doc = await buildDsarExport(ALICE);
    expect(Object.keys(doc.manifest).sort()).toEqual(Object.keys(doc.data).sort());
    for (const [table, line] of Object.entries(doc.manifest)) {
      expect(line.rows, table).toBe(doc.data[table].length);
    }
    expect(doc.manifest.bookings).toEqual({ rows: 0, truncated: false });
  });
});

describe("EXECUTED: a read that fails part-way is UNREADABLE, never a shorter table", () => {
  it("page 2 unavailable: the table is named, and its first page is not handed over as the whole", async () => {
    seedSearches(ALICE, 2500);
    knobs.failAt.add(`searches|${DSAR_PAGE_ROWS}`);
    const doc = await buildDsarExport(ALICE);
    expect(doc.unreadable).toContain("searches");
    expect(doc.data.searches).toBeUndefined();
    expect(doc.manifest.searches).toBeUndefined();
  });

  it("an order key the database does not have is never exported as an empty table", async () => {
    // A "missing" answer to an ORDERED read can mean the table is absent - or
    // only that the order column is. The rows exist; [] would be a lie.
    seedSearches(ALICE, 5);
    knobs.orderUnknown.add("searches");
    const doc = await buildDsarExport(ALICE);
    expect(doc.unreadable).toContain("searches");
    expect(doc.data.searches).toBeUndefined();
  });

  it("a table that is genuinely absent is still a vacuous [], not an alarm", async () => {
    store.missing.add("searches");
    const doc = await buildDsarExport(ALICE);
    expect(doc.unreadable).not.toContain("searches");
    expect(doc.data.searches).toEqual([]);
  });
});

describe("EXECUTED: child tables follow ALL of the parents, in bounded requests", () => {
  it("1,200 feedback rows -> all 1,200 image index rows, no giant in.() list", async () => {
    store.seed(
      "feedback",
      Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, reporter_email: ALICE, body: "b" }))
    );
    store.seed(
      "feedback_images",
      Array.from({ length: 1200 }, (_, i) => ({
        id: 5000 + i,
        feedback_id: i + 1,
        created_at: "2026-09-01T00:00:00.000Z",
      }))
    );
    const doc = await buildDsarExport(ALICE);
    expect(doc.data.feedback).toHaveLength(1200);
    expect(doc.data.feedback_images).toHaveLength(1200);
    expect(doc.manifest.feedback_images).toEqual({ rows: 1200, truncated: false });
    // A 1,200-id in.() list is a URL the gateway refuses; the refusal reads as
    // "unavailable", so paginating the parents alone would have turned a big
    // account's child tables unreadable.
    for (const q of knobs.queries.filter((x) => x.table === "feedback_images")) {
      const list = /in\.\(([^)]*)\)/.exec(q.query)?.[1] ?? "";
      expect(list.split(",").length).toBeLessThanOrEqual(200);
    }
  });
});

describe("the order key of every exported table is real, and TOTAL", () => {
  const schema = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");

  /** The body of `create table if not exists public.<t> ( ... );`. */
  const tableBody = (table: string): string | null =>
    new RegExp(`create table if not exists (?:public\\.)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i").exec(
      schema
    )?.[1] ?? null;

  const exported = Array.from(
    new Set([
      ...USER_TABLES.filter((t) => !t.exportSkip).map((t) => t.table),
      ...CHILD_TABLES.filter((t) => !t.exportSkip).flatMap((t) => [t.table, t.parentTable]),
    ])
  );

  it("walks a real list", () => {
    expect(exported.length).toBeGreaterThan(25);
  });

  it.each(exported)("%s: ordered by a unique key that exists in schema.sql", (table) => {
    // Offset pagination is only correct over a TOTAL order. A non-unique order
    // column lets two rows tie, and tied rows may swap sides of a page
    // boundary between two reads - one exported twice, the other never. And an
    // order column the table does not have makes PostgREST answer 400, which
    // the strict read maps to "missing". So a new registered table with no
    // `id` must declare its key in dsar.ts before it can ship.
    const body = tableBody(table);
    expect(body, `no create table block for ${table} in supabase/schema.sql`).toBeTruthy();
    const lines = body!
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("--"));
    const columns = lines.map((l) => l.split(/\s+/)[0].replace(/"/g, ""));
    const order = exportOrderFor(table);
    for (const col of order) expect(columns, `${table}.${col}`).toContain(col);

    const inlinePk = lines.filter((l) => /\bprimary key\b/i.test(l) && !/^primary key/i.test(l));
    const tablePk = lines.find((l) => /^primary key\s*\(/i.test(l));
    const pk = tablePk
      ? tablePk
          .replace(/^primary key\s*\(/i, "")
          .replace(/\).*$/, "")
          .split(",")
          .map((c) => c.trim())
      : inlinePk.map((l) => l.split(/\s+/)[0]);
    expect(pk.length, `${table} has no primary key to order by`).toBeGreaterThan(0);
    // The order must COVER the primary key, or it is not total.
    for (const col of pk) expect(order, `${table} order must include pk column ${col}`).toContain(col);
  });
});
