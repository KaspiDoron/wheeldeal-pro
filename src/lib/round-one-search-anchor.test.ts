import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// AUDIT A6 - round ONE of a thread whose first reply arrives after a new hunt
// began files under the NEWEST hunt.
//
// agent-loop's `resolveSearchId` asks `offers` for this (traveller, vendor)
// pair's earliest stamped row and, finding none - which is exactly what round
// one looks like - falls back to `searches?order=created_at.desc&limit=1`. So a
// traveller who runs a Krabi hunt, taps a second hunt in Canggu an hour later,
// and only then gets the Krabi shop's FIRST reply, has that offer written with
// the CANGGU search id. It joins the Canggu rival pool, and pickCheapestRival
// (which scopes by exact searchId) can hand a Krabi price to a Canggu shop as
// leverage.
//
// The thread's own start time is the answer that was always available: the hunt
// that was live when we first messaged this shop is the hunt this thread
// belongs to. These tests EXECUTE that resolution against a Map-backed store.

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const store: Record<string, Row[]> = { searches: [], whatsapp_messages: [], offers: [] };
const queries: { table: string; query: string }[] = [];

/** A fake PostgREST: enough of the filter grammar for these reads. */
function serve(table: string, query: string): Row[] {
  queries.push({ table, query });
  let rows = [...(store[table] ?? [])];
  const lte = /created_at=lte\.([^&]+)/.exec(query);
  if (lte) {
    const bound = decodeURIComponent(lte[1]);
    rows = rows.filter((r) => String(r.created_at ?? "") <= bound);
  }
  if (/search_id=not\.is\.null/.test(query)) rows = rows.filter((r) => r.search_id != null);
  if (/direction=eq\.outbound/.test(query)) rows = rows.filter((r) => r.direction === "outbound");
  const order = /order=([a-z_]+)\.(asc|desc)/.exec(query);
  if (order) {
    const [, col, dir] = order;
    rows.sort(
      (a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (dir === "asc" ? 1 : -1)
    );
  }
  const limit = /limit=(\d+)/.exec(query);
  if (limit) rows = rows.slice(0, Number(limit[1]));
  return rows;
}

vi.mock("./runtime-config", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config")>("./runtime-config");
  return {
    ...actual,
    sbSelect: async (table: string, query: string) => serve(table, query),
    sbSelectStrict: async (table: string, query: string) => ({ rows: serve(table, query) }),
  };
});

import { searchIdForThread } from "./search-session";

const EMAIL = "traveller@example.com";
const KRABI_SHOP = "66111111111";
const KRABI_HUNT = 11;
const CANGGU_HUNT = 12;

const resolve = (over: { vendorId?: string; toDigits?: string } = {}) =>
  searchIdForThread({
    userEmail: EMAIL,
    vendorId: over.vendorId ?? "krabi-shop",
    toDigits: over.toDigits ?? KRABI_SHOP,
  });

beforeEach(() => {
  queries.length = 0;
  store.offers = [];
  store.searches = [
    { id: KRABI_HUNT, created_at: "2026-09-07T09:00:00.000Z" },
    { id: CANGGU_HUNT, created_at: "2026-09-07T10:00:00.000Z" }, // the second hunt
  ];
  // We messaged the Krabi shop five minutes into the Krabi hunt.
  store.whatsapp_messages = [
    { direction: "outbound", received_at: "2026-09-07T09:05:00.000Z", raw: { sender: EMAIL } },
  ];
});

describe("A6 - a thread belongs to the hunt that was live when it started", () => {
  it("round one: the first reply lands after a NEW hunt began and still files under the old one", async () => {
    // No prior offer row - this is round one, the residual case.
    expect(await resolve()).toBe(KRABI_HUNT);
  });

  it("a prior stamped offer still wins (the round-two guarantee is untouched)", async () => {
    store.offers = [
      { search_id: KRABI_HUNT, created_at: "2026-09-07T09:30:00.000Z" },
      { search_id: CANGGU_HUNT, created_at: "2026-09-07T11:00:00.000Z" },
    ];
    expect(await resolve()).toBe(KRABI_HUNT);
    // The oldest stamp is asked for, not the newest.
    expect(queries.some((q) => q.table === "offers" && /order=created_at\.asc/.test(q.query))).toBe(
      true
    );
  });

  it("no outbound row to anchor on degrades to the newest hunt, never to nothing", async () => {
    store.whatsapp_messages = [];
    expect(await resolve()).toBe(CANGGU_HUNT);
  });

  it("a thread opened inside the newest hunt resolves to it", async () => {
    store.whatsapp_messages = [
      { direction: "outbound", received_at: "2026-09-07T10:20:00.000Z", raw: { sender: EMAIL } },
    ];
    expect(await resolve()).toBe(CANGGU_HUNT);
  });

  it("no searches at all - null, not a guess", async () => {
    store.searches = [];
    expect(await resolve()).toBeNull();
  });
});

// The reply path must USE it: the resolution above is worthless if agent-loop
// keeps its own newest-first read.
describe("A6 - agent-loop's reply path delegates", () => {
  const loop = readFileSync(join(process.cwd(), "src/lib/agent-loop.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("resolveSearchId calls searchIdForThread", () => {
    expect(loop).toMatch(/searchIdForThread\(/);
  });

  it("...and no unguarded newest-hunt read is left behind", () => {
    expect(loop).not.toMatch(/"searches",[\s\S]{0,200}?order=created_at\.desc/);
  });
});
