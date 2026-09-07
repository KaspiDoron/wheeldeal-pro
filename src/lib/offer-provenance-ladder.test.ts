// AUDIT F011 - the offers ladder's lower rungs dropped the provenance columns,
// re-arming the package-arithmetic rival the guard exists to block.
//
// Shop A answers "500 for 3 days" for a traveller renting ONE day. The row's
// price_per_day is 167 and its quote_basis_days is 3 - and that 3 is the only
// thing that stops `pickRival` citing 167 at Shop B as a like-for-like daily
// rate. The ladder carried it on rungs 1 and 2 and dropped it on rung 3, and
// rung 3 is where a wide insert lands whenever ONE deposit column has not been
// migrated (schema.sql adds deposit_note long before the provenance pair) or
// whenever Supabase hiccups twice: `sbInsert` returns a bare boolean and cannot
// tell "column missing" from any other 4xx, so the step-down could not tell
// either.
//
// EXECUTED against the real `publishOfferRow` over a Map-backed PostgREST that
// 400s on columns the simulated database does not have - the only way to see
// which rung actually landed - and the landed row is then run through the real
// `pickRival` to show whether it is citable.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const db = {
  /** Does this simulated database have quote_basis_days/effective_daily_rate? */
  provenanceColumns: true,
  /** Does it have the deposit block? */
  depositColumns: true,
  /** Insert attempts that fail for a reason that is NOT a missing column. */
  blips: 0,
  /** Every insert attempt against `offers`, in order. */
  attempts: [] as Record<string, unknown>[],
};

vi.mock("./runtime-config", async () => {
  const h = await import("./privacy/postgrest-store.test-helper");
  const base = h.runtimeConfigMock() as Record<string, unknown> & {
    sbInsert: (t: string, rows: Record<string, unknown>[]) => Promise<boolean>;
    sbSelectStrict: (
      t: string,
      q: string
    ) => Promise<{ rows: Record<string, unknown>[] } | { error: "missing" | "unavailable" }>;
  };
  const DEPOSIT_COLS = [
    "deposit_note",
    "deposit_type",
    "deposit_amount",
    "deposit_currency",
    "delivery_fee",
    "insurance_included",
    "km_limit_per_day",
    "fuel_policy",
  ];
  return {
    ...base,
    sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
      if (table !== "offers") return base.sbInsert(table, rows);
      db.attempts.push({ ...rows[0] });
      if (db.blips > 0) {
        db.blips -= 1;
        return false; // a 4xx/5xx that says nothing about the schema
      }
      const has = (c: string) => rows.some((r) => c in r);
      if (!db.provenanceColumns && (has("quote_basis_days") || has("effective_daily_rate"))) {
        return false; // PostgREST 400: column does not exist
      }
      if (!db.depositColumns && DEPOSIT_COLS.some(has)) return false;
      return base.sbInsert(table, rows);
    },
    sbSelectStrict: async (table: string, query: string) => {
      if (table === "offers" && /select=quote_basis_days/.test(query) && !db.provenanceColumns) {
        return { error: "missing" as const };
      }
      return base.sbSelectStrict(table, query);
    },
  };
});

import { store } from "./privacy/postgrest-store.test-helper";
import { publishOfferRow } from "./agent-loop";
import { pickRival } from "./search-session";
import { resetSchemaProbeCache } from "./schema-probe";
import { AGENT_EVENT_KINDS } from "./events";

const EMAIL = "traveller@x.co";
const SEARCH_ID = 42;

const OFFER_BASE = {
  user_email: EMAIL,
  vendor_id: "shop-a",
  vendor_name: "Shop A",
  price_per_day: 167,
  list_price_per_day: 167,
  currency: "THB",
  round: 1,
  simulated: false,
  verified: false,
  region_key: "krabi",
  vehicle_key: "scooter-125",
  duration_days: 1,
  delivers: null,
};
const BASE = { ...OFFER_BASE, search_id: SEARCH_ID };
// "500 for 3 days" read for a ONE-day traveller: the package does not apply, so
// there is no honest effective rate and the basis is the whole provenance.
const PROVENANCE = { effective_daily_rate: null, quote_basis_days: 3 };
const DEPOSITS = {
  deposit_note: "passport",
  deposit_type: "passport",
  deposit_amount: null,
  deposit_currency: null,
  delivery_fee: null,
  insurance_included: null,
  km_limit_per_day: null,
  fuel_policy: null,
};
const CONTEXT = {
  userEmail: EMAIL,
  toNumber: "66812345678",
  vendorId: "shop-a",
  vendorName: "Shop A",
  price: 167,
  currency: "THB",
  basisDays: 3,
};

const publish = (over: Partial<Parameters<typeof publishOfferRow>[0]> = {}) =>
  publishOfferRow({
    base: BASE,
    offerBase: OFFER_BASE,
    provenance: PROVENANCE,
    deposits: DEPOSITS,
    context: CONTEXT,
    ...over,
  });

/** The landed row, read back the way `cheapestRivalQuoteFor` reads it. */
function landedAsRival() {
  const rows = store.rows("offers") as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  const r = rows[0];
  return {
    vendorId: String(r.vendor_id),
    pricePerDay: Number(r.price_per_day),
    currency: String(r.currency),
    vehicleKey: (r.vehicle_key ?? null) as string | null,
    effectiveDailyRate: (r.effective_daily_rate ?? null) as number | null,
    createdAt: String(r.created_at ?? new Date().toISOString()),
    searchId: (r.search_id ?? null) as number | null,
    quoteBasisDays: (r.quote_basis_days ?? null) as number | null,
  };
}

/** Would a ONE-day traveller at Shop B be told about this row? */
const citedAtShopB = (row: ReturnType<typeof landedAsRival>) =>
  pickRival([row], {
    vendorId: "shop-b",
    currency: "THB",
    vehicleKey: "scooter-125",
    belowPrice: 300,
    sinceIso: "1970-01-01T00:00:00.000Z",
    searchId: SEARCH_ID,
    durationDays: 1,
  });

beforeEach(() => {
  store.reset();
  resetSchemaProbeCache();
  db.provenanceColumns = true;
  db.depositColumns = true;
  db.blips = 0;
  db.attempts = [];
});

describe("F011: the offers ladder keeps quote_basis_days for as long as the schema allows", () => {
  it("EXECUTED: a deposit column that has not been migrated no longer takes the basis with it", async () => {
    // The exact deployment the ladder exists for, one step earlier than the
    // one it handles: deposit_note is there, one of the wider deposit columns
    // is not, and the provenance pair IS.
    db.depositColumns = false;

    const out = await publish();

    expect(out.provenanceStamped).toBe(true);
    const row = landedAsRival();
    expect(row.quoteBasisDays).toBe(3);
    // ...so a 3-day package is not offered to a 1-day traveller as 167 a day.
    expect(citedAtShopB(row)).toBe(null);
  });

  it("EXECUTED: two transient failures no longer publish a provenance-free row", async () => {
    // A Supabase blip is not a schema answer. The old ladder read it as one and
    // stepped down to `base`, which has no provenance at all.
    db.blips = 2;

    const out = await publish();

    expect(out.provenanceStamped).toBe(true);
    const row = landedAsRival();
    expect(row.quoteBasisDays).toBe(3);
    expect(citedAtShopB(row)).toBe(null);
  });

  it("EXECUTED: on a database that really lacks the columns the row still lands, and the loss is recorded", async () => {
    db.provenanceColumns = false;

    const out = await publish();

    // The row is NOT dropped - it is the traveller's own price for this shop.
    expect(out.provenanceStamped).toBe(false);
    const rows = store.rows("offers") as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].price_per_day).toBe(167);
    // The schema is PROBED, not inferred from two doomed inserts.
    expect(db.attempts).toHaveLength(1);
    expect("quote_basis_days" in db.attempts[0]).toBe(false);
    // ...and the degrade is visible instead of silent.
    const events = store.rows("agent_events") as Record<string, unknown>[];
    expect(events.map((e) => e.kind)).toContain("offer-provenance-dropped");
  });

  it("EXECUTED: a QUOTED daily rate loses nothing, so it raises no breadcrumb", async () => {
    db.provenanceColumns = false;

    const out = await publishOfferRow({
      base: BASE,
      offerBase: OFFER_BASE,
      provenance: { effective_daily_rate: 250, quote_basis_days: null },
      deposits: DEPOSITS,
      context: { ...CONTEXT, price: 250, basisDays: undefined },
    });

    expect(out.provenanceStamped).toBe(false);
    expect(store.rows("offers")).toHaveLength(1);
    const events = store.rows("agent_events") as Record<string, unknown>[];
    expect(events.map((e) => e.kind)).not.toContain("offer-provenance-dropped");
  });

  it("EXECUTED: the ordinary path is untouched - one insert, provenance and deposits on it", async () => {
    const out = await publish();

    expect(out.provenanceStamped).toBe(true);
    expect(db.attempts).toHaveLength(1);
    const row = landedAsRival();
    expect(row.quoteBasisDays).toBe(3);
    expect(store.rows("agent_events")).toHaveLength(0);
  });

  it("the breadcrumb kind is registered", () => {
    expect(AGENT_EVENT_KINDS).toContain("offer-provenance-dropped");
  });
});
