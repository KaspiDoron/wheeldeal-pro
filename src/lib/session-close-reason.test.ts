// AUDIT F146 - a hunt the traveller never cleared must not be reported as one
// they cleared.
//
// Three writers stamp the SAME `kind: "session-closed"` marker with three
// different reasons - session-close.ts (`user` for the traveller's own clear,
// `ttl-expired` for the quiet stand-down agent-loop fires when a reply lands
// past the TTL) and close-deal/route.ts (`deal-closed` when a booking locks.)
// All three readers - /api/deals, /api/deals/restore and /api/deals/recheck -
// filtered on `kind` alone and never projected `reason`, so a shop answering
// four hours late turned the hunt into "You cleared this hunt - it stays here
// as history.", permanently withdrawing Re-open and the price re-check.
//
// Everything below EXECUTES the real route handlers against a fake PostgREST.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closedByOf } from "./session-life";

type Row = Record<string, unknown>;

// Same fake PostgREST shape trips-truth.test.ts uses: the filters the fixtures
// actually model are applied, the jsonb-path ones are ignored (every fixture is
// already scoped to one user).
function fakeSupabase(tables: Record<string, Row[]>) {
  const queries: { table: string; query: string }[] = [];
  function select(table: string, query: string): Row[] {
    queries.push({ table, query });
    const p = new URLSearchParams(query);
    let rows = [...(tables[table] ?? [])];
    for (const [key, raw] of p.entries()) {
      if (["select", "order", "limit", "offset", "or"].includes(key)) continue;
      const m = /^(gte|gt|lte|lt|eq)\.(.*)$/s.exec(raw);
      if (!m) continue;
      const [, op, val] = m;
      if (!rows.length || !(key in rows[0])) continue;
      rows = rows.filter((r) => {
        const cell = r[key];
        if (op === "eq") return String(cell) === val;
        const a = Date.parse(String(cell));
        const b = Date.parse(val);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
        if (op === "gte") return a >= b;
        if (op === "gt") return a > b;
        if (op === "lte") return a <= b;
        return a < b;
      });
    }
    const order = p.get("order");
    if (order) {
      const [col, dir] = order.split(".");
      rows.sort((x, y) => {
        const ax = Date.parse(String(x[col]));
        const ay = Date.parse(String(y[col]));
        const a = Number.isFinite(ax) ? ax : Number(x[col]);
        const b = Number.isFinite(ay) ? ay : Number(y[col]);
        return dir === "asc" ? a - b : b - a;
      });
    }
    const limit = Number(p.get("limit"));
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
    return rows;
  }
  return { select, queries };
}

const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// The shared classifier
// ---------------------------------------------------------------------------

describe("F146 - closedByOf reads the marker's own reason", () => {
  it("maps each writer's reason to its own verdict", () => {
    expect(closedByOf("user")).toBe("user");
    expect(closedByOf("ttl-expired")).toBe("expired");
    expect(closedByOf("deal-closed")).toBe("deal");
  });

  it("a marker written before the reason existed is treated as the traveller's own clear", () => {
    // Strictest default: an unlabelled row must not unlock Re-open.
    expect(closedByOf(null)).toBe("user");
    expect(closedByOf(undefined)).toBe("user");
    expect(closedByOf("")).toBe("user");
    expect(closedByOf("something-new")).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// /api/deals - the card's verdict
// ---------------------------------------------------------------------------

async function loadDeals(tables: Record<string, Row[]>) {
  const db = fakeSupabase(tables);
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: "t@example.com", plan: "pro", role: "user" }),
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbSelect: async (table: string, q: string) => db.select(table, q),
    sbSelectStrict: async (table: string, q: string) => ({ rows: db.select(table, q) }),
    pgTimestamp: (v: string) => v,
  }));
  const mod = await import("@/app/api/deals/route");
  return { GET: mod.GET, db };
}

const huntAt = Date.now() - 6 * 3600_000;

function huntRows() {
  return [
    {
      id: 7,
      query_text: "scooter in ao nang",
      radius_km: 5,
      vehicle_class: "scooter",
      source: "google",
      results: 6,
      rfq: { durationDays: 4, startDate: "2026-09-01" },
      created_at: iso(huntAt),
    },
  ];
}

function marker(reason: string | null) {
  return {
    to_number: "session",
    received_at: iso(huntAt + 3 * 3600_000),
    reason,
  };
}

describe("F146 - /api/deals names WHO closed the hunt", () => {
  it("THE BUG: a TTL stand-down is not the traveller clearing the hunt", async () => {
    const { GET } = await loadDeals({
      searches: huntRows(),
      whatsapp_messages: [marker("ttl-expired")],
    });
    const body = await (await GET()).json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].closedBy).toBe("expired");
  });

  it("a hunt that ended in a booking is reported as a locked deal", async () => {
    const { GET } = await loadDeals({
      searches: huntRows(),
      whatsapp_messages: [marker("deal-closed")],
    });
    const body = await (await GET()).json();
    expect(body.sessions[0].closedBy).toBe("deal");
  });

  it("the traveller's own clear still reads as their own clear", async () => {
    const { GET } = await loadDeals({
      searches: huntRows(),
      whatsapp_messages: [marker("user")],
    });
    const body = await (await GET()).json();
    expect(body.sessions[0].closedBy).toBe("user");
    expect(body.sessions[0].closed).toBe(true);
  });

  it("a legacy marker with no reason stays the traveller's clear", async () => {
    const { GET } = await loadDeals({
      searches: huntRows(),
      whatsapp_messages: [marker(null)],
    });
    const body = await (await GET()).json();
    expect(body.sessions[0].closedBy).toBe("user");
  });

  it("an untouched hunt is not closed by anybody", async () => {
    const { GET } = await loadDeals({ searches: huntRows(), whatsapp_messages: [] });
    const body = await (await GET()).json();
    expect(body.sessions[0].closedBy).toBeNull();
    expect(body.sessions[0].closed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// /api/deals/restore - the gate
// ---------------------------------------------------------------------------

async function loadRestore(tables: Record<string, Row[]>, strict?: Record<string, unknown>) {
  const db = fakeSupabase(tables);
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: "t@example.com", plan: "pro", role: "user" }),
  }));
  vi.doMock("@/lib/session-life-config", () => ({
    searchSessionTtlMs: async () => 3 * 3600_000,
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbSelect: async (table: string, q: string) => db.select(table, q),
    sbSelectStrict: async (table: string, q: string) =>
      strict?.[table] ?? { rows: db.select(table, q) },
    pgTimestamp: (v: string) => v,
  }));
  const mod = await import("@/app/api/deals/restore/route");
  return { GET: mod.GET, db };
}

const restoreSearches = [
  {
    id: 41,
    query_text: "scooter in ao nang",
    lat: null,
    lng: null,
    radius_km: 5,
    vehicle_class: "scooter",
    source: "google",
    rfq: { vehicleClass: "scooter", durationDays: 4 },
    snapshot: [{ id: "v1", name: "Ao Nang Bikes", whatsapp: "66811111111" }],
    origin_label: "Ao Nang",
    created_at: iso(huntAt),
  },
];

async function restoreWith(reason: string | null) {
  const { GET } = await loadRestore(
    { searches: restoreSearches, whatsapp_messages: [], offers: [] },
    { whatsapp_messages: { rows: [{ received_at: iso(huntAt + 3 * 3600_000), reason }] } }
  );
  return GET(new Request(`http://x/api/deals/restore?ts=${iso(huntAt)}&sid=41`));
}

describe("F146 - Re-open survives a hunt that merely went quiet", () => {
  it("THE BUG: a TTL stand-down still re-opens", async () => {
    const res = await restoreWith("ttl-expired");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.vendors).toHaveLength(1);
  });

  it("the traveller's own clear is still refused, with their own words", async () => {
    const res = await restoreWith("user");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("session-closed");
    expect(body.hint).toBe("You cleared this hunt.");
  });

  it("a legacy marker with no reason is still refused", async () => {
    const res = await restoreWith(null);
    expect(res.status).toBe(404);
  });

  it("a booked hunt is refused, but not as a clear", async () => {
    const res = await restoreWith("deal-closed");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("session-closed");
    // Its own words: the traveller booked from this hunt, they did not bin it.
    expect(body.hint).not.toBe("You cleared this hunt.");
  });

  it("an unreadable store still refuses rather than restoring", async () => {
    const { GET } = await loadRestore(
      { searches: restoreSearches, whatsapp_messages: [], offers: [] },
      { whatsapp_messages: { error: "unavailable" } }
    );
    const res = await GET(new Request(`http://x/api/deals/restore?ts=${iso(huntAt)}&sid=41`));
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// The Trips card's copy
// ---------------------------------------------------------------------------

describe("F146 - the Trips card says which of the three happened", () => {
  const page = readFileSync(join(process.cwd(), "src/app/deals/page.tsx"), "utf8");

  it("reads the discriminant, not a bare boolean, when choosing the line", () => {
    expect(page).toContain("closedBy");
  });

  it("keeps the traveller's own clear worded as it was", () => {
    expect(page).toContain('t("You cleared this hunt - it stays here as history.")');
  });

  it("has its own line for a hunt that went quiet, and one for a booked hunt", () => {
    expect(page).toContain(
      't("This hunt went quiet and the agents stood down - re-open it to pick it back up.")'
    );
    expect(page).toContain('t("You booked from this hunt - it stays here as history.")');
  });
});

describe("F146 - the re-ask never messages the shops of a closed hunt", () => {
  const recheck = readFileSync(
    join(process.cwd(), "src/app/api/deals/recheck/route.ts"),
    "utf8"
  );

  it("still refuses EVERY close - the clear and the TTL stand-down both tombstoned the shops", () => {
    // Widening this would push fresh WhatsApp messages at shops the close has
    // already tombstoned (wa_cancellations), which is the opposite of a fix.
    expect(recheck).toContain("closedRead");
    expect(recheck).toContain('"rows" in closedRead && closedRead.rows.length');
  });

  it("but no longer blames the traveller for a close they did not make", () => {
    expect(recheck).toContain("closedByOf");
  });
});
