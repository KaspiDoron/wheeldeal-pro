import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// WAVE 9 SLICE D: owner problem #10 - the consent DATA layer. Two opt-in
// purposes with recorded withdrawals, a consent-gated projection of the funnel
// ledger, a consent stamp on the deal store, and a k-anonymous rollup as the
// only commercial artefact.

vi.mock("server-only", () => ({}));

const db: {
  consentRows: { granted: boolean | null }[];
  inserts: { table: string; row: Record<string, unknown> }[];
  failTables: Set<string>;
  consentUnreadable: boolean;
  darkRows: Record<string, unknown>[] | null;
  darkQuery: string;
} = {
  consentRows: [],
  inserts: [],
  failTables: new Set(),
  consentUnreadable: false,
  darkRows: [],
  darkQuery: "",
};

vi.mock("./runtime-config", () => ({
  sbSelect: async (table: string) => {
    if (table === "consent_events") {
      if (db.consentUnreadable) throw new Error("db down");
      return db.consentRows;
    }
    return [];
  },
  sbSelectDark: async (_table: string, query: string) => {
    db.darkQuery = query;
    return db.darkRows;
  },
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    db.inserts.push({ table, row: rows[0] });
    return !db.failTables.has(table);
  },
  sbUpdate: async () => true,
  supabaseConfigured: () => true,
  getConfig: async () => undefined,
}));

import {
  CONSENT_KINDS,
  OPT_IN_KINDS,
  consentFor,
  recordConsent,
  resetConsentCache,
} from "./consent";
import { buildInsightsRollup, K_ANONYMITY_FLOOR } from "./ops/insights";
import { projectProductEvent } from "./privacy/product-events";
import { rememberDeal } from "./spte/memory";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

beforeEach(() => {
  db.consentRows = [];
  db.inserts = [];
  db.failTables = new Set();
  db.consentUnreadable = false;
  db.darkRows = [];
  db.darkQuery = "";
  resetConsentCache();
});

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

describe("consentFor is strict opt-in", () => {
  it("the two purposes exist and are marked opt-in", () => {
    expect(CONSENT_KINDS).toContain("analytics");
    expect(CONSENT_KINDS).toContain("commercial_insights");
    expect([...OPT_IN_KINDS].sort()).toEqual(["analytics", "commercial_insights"]);
  });

  it("no row = NO consent (the default is off, not on)", async () => {
    expect(await consentFor("a@x.com", "analytics")).toBe(false);
  });

  it("a granted row answers true; a NEWER withdrawal row answers false", async () => {
    db.consentRows = [{ granted: true }];
    expect(await consentFor("a@x.com", "analytics")).toBe(true);
    resetConsentCache();
    db.consentRows = [{ granted: false }]; // newest-first read
    expect(await consentFor("a@x.com", "analytics")).toBe(false);
  });

  it("an UNREADABLE ledger answers false - unprovable consent is no consent", async () => {
    db.consentRows = [{ granted: true }];
    db.consentUnreadable = true;
    expect(await consentFor("a@x.com", "analytics")).toBe(false);
  });
});

describe("recordConsent writes withdrawals as rows", () => {
  it("granted=false lands as a granted:false ledger row", async () => {
    await recordConsent({ email: "a@x.com", kind: "analytics", granted: false });
    const w = db.inserts.find((i) => i.table === "consent_events");
    expect(w?.row.granted).toBe(false);
  });

  it("PRE-MIGRATION: an acceptance may fall back to the legacy shape, a withdrawal may NOT", async () => {
    db.failTables = new Set(["consent_events"]);
    // Acceptance: tries with granted, retries legacy, then breadcrumbs.
    await recordConsent({ email: "a@x.com", kind: "analytics", granted: true });
    const acceptTries = db.inserts.filter((i) => i.table === "consent_events");
    expect(acceptTries.length).toBe(2);
    expect(acceptTries[1].row).not.toHaveProperty("granted");
    db.inserts = [];
    // Withdrawal: ONE try only - a legacy row would read back as an acceptance,
    // the exact opposite of what the person said - then the breadcrumb, which
    // carries granted.
    await recordConsent({ email: "a@x.com", kind: "analytics", granted: false });
    const withdrawTries = db.inserts.filter((i) => i.table === "consent_events");
    expect(withdrawTries.length).toBe(1);
    const crumb = db.inserts.find((i) => i.table === "agent_events");
    expect(String(crumb?.row.detail)).toContain('"granted":false');
  });
});

// ---------------------------------------------------------------------------
// The projection.
// ---------------------------------------------------------------------------

describe("product_events is a projection that only exists under consent", () => {
  it("no consent -> NO row (not a flagged row - no row)", async () => {
    await projectProductEvent({ email: "a@x.com", stage: "replied", kind: "thread-stage" });
    expect(db.inserts.filter((i) => i.table === "product_events")).toEqual([]);
  });

  it("granted consent -> the typed row lands", async () => {
    db.consentRows = [{ granted: true }];
    await projectProductEvent({
      email: "a@x.com",
      stage: "price_verified",
      kind: "thread-stage",
      props: { transport: "evolution" },
    });
    const w = db.inserts.find((i) => i.table === "product_events");
    expect(w?.row).toMatchObject({
      user_email: "a@x.com",
      stage: "price_verified",
      kind: "thread-stage",
    });
  });

  it("both state machines project through it", () => {
    expect(readCode("src/lib/funnel/stages.ts")).toMatch(/projectProductEvent\(\{/);
    expect(readCode("src/lib/bookings.ts")).toMatch(/projectProductEvent\(\{/);
  });
});

// ---------------------------------------------------------------------------
// The deal store stamp + the k-anonymous rollup.
// ---------------------------------------------------------------------------

describe("deal_memory carries the consent decision as a stamp", () => {
  const rfq = {
    vehicleClass: "scooter" as const,
    transmission: "any" as const,
    durationDays: 3,
    accessories: [],
    fulfillment: "any" as const,
    vendorMessage: "",
  };

  it("a consenting closer stamps insights_ok=true; a silent one stamps false", async () => {
    db.consentRows = [{ granted: true }];
    await rememberDeal({ regionKey: "ko tao", rfq, currency: "THB", pricePerDay: 250, userEmail: "a@x.com" });
    expect(db.inserts.find((i) => i.table === "deal_memory")?.row.insights_ok).toBe(true);
    db.inserts = [];
    resetConsentCache();
    db.consentRows = [];
    await rememberDeal({ regionKey: "ko tao", rfq, currency: "THB", pricePerDay: 250, userEmail: "a@x.com" });
    expect(db.inserts.find((i) => i.table === "deal_memory")?.row.insights_ok).toBe(false);
  });

  it("no email at all stamps false - anonymous writes never feed the artefact", async () => {
    await rememberDeal({ regionKey: "ko tao", rfq, currency: "THB", pricePerDay: 250 });
    expect(db.inserts.find((i) => i.table === "deal_memory")?.row.insights_ok).toBe(false);
  });

  it("close-deal passes the closer's email so the stamp is real", () => {
    expect(readCode("src/app/api/negotiate/close-deal/route.ts")).toMatch(
      /userEmail: session\.email/
    );
  });
});

describe("the rollup enforces the k-floor and reads ONLY stamped rows", () => {
  const deal = (region: string, price: number) => ({
    region_key: region,
    vehicle_key: "scooter-auto",
    currency: "THB",
    price_per_day: price,
    list_price: price + 50,
    duration_days: 3,
    tactic: "closed-deal",
  });

  it("a group under the floor is SUPPRESSED whole - counted, never named", async () => {
    db.darkRows = [
      ...Array.from({ length: K_ANONYMITY_FLOOR + 5 }, (_, i) => deal("ko tao", 200 + i)),
      ...Array.from({ length: 5 }, (_, i) => deal("tiny village", 300 + i)),
    ];
    const r = await buildInsightsRollup();
    expect(r.groups.length).toBe(1);
    expect(r.groups[0].regionKey).toBe("ko tao");
    expect(r.groups[0].deals).toBe(K_ANONYMITY_FLOOR + 5);
    expect(r.suppressedGroups).toBe(1);
    expect(JSON.stringify(r.groups)).not.toContain("tiny village");
  });

  it("the source query is filtered to insights_ok=is.true", async () => {
    await buildInsightsRollup();
    expect(db.darkQuery).toContain("insights_ok=is.true");
  });

  it("an unreadable store is UNREADABLE, not an empty rollup", async () => {
    db.darkRows = null;
    const r = await buildInsightsRollup();
    expect(r.unreadable).toBe(true);
    expect(r.groups).toEqual([]);
  });

  it("the floor is 20 and the route is owner-only", () => {
    expect(K_ANONYMITY_FLOOR).toBe(20);
    expect(readCode("src/app/api/admin/ops/insights/route.ts")).toMatch(/requireOwner/);
  });
});

// ---------------------------------------------------------------------------
// The words match the machinery.
// ---------------------------------------------------------------------------

describe("legal text and plumbing agree", () => {
  const legal = read("src/lib/legal.ts");

  it("TERMS_VERSION was bumped so every user re-accepts the rewritten policy", () => {
    // Bumped again 2026-08-31 (beta-30 wave): section 2 now discloses the
    // messaging layer's transient copy of messages on the linked number. The
    // pin follows the CURRENT version - what it guards is that the version
    // MOVES whenever the policy text does, since needsReacceptance is the
    // only thing that walks existing users through new terms.
    expect(legal).toMatch(/TERMS_VERSION = "2026-08-31"/);
  });

  it("section 8 replaced the blanket 'not sold' with the honest carve-out", () => {
    expect(legal).toMatch(/do NOT sell your personal data/);
    expect(legal).toMatch(/groups of at least 20 deals/);
    expect(legal).toMatch(/off by default/);
  });

  it("section 6 names the real windows the prune enforces", () => {
    expect(legal).toMatch(/90 days/);
    expect(legal).toMatch(/180 days/);
    expect(legal).toMatch(/DE-IDENTIFIED/);
    expect(legal).toMatch(/DOWNLOAD everything we hold about you/);
  });

  it("the schema carries all three data-layer pieces", () => {
    const schema = read("supabase/schema.sql");
    expect(schema).toMatch(/alter table public\.consent_events add column if not exists granted boolean;/);
    expect(schema).toMatch(/create table if not exists public\.product_events/);
    expect(schema).toMatch(/alter table public\.deal_memory add column if not exists insights_ok boolean;/);
    // ...and the projection ages out with retention.
    expect(read("supabase/retention.sql")).toMatch(/delete from public\.product_events/);
  });

  it("the Profile endpoint flips ONLY the opt-in kinds, honestly", () => {
    const route = readCode("src/app/api/profile/consent/route.ts");
    expect(route).toMatch(/OPT_IN_KINDS/);
    expect(route).toMatch(/status: 500/); // an unrecorded choice is not "ok"
    expect(read("src/app/profile/page.tsx")).toMatch(/\/api\/profile\/consent/);
  });

  it("OPERATOR_NAME renders red-until-set in the Keys panel", () => {
    expect(read("src/app/admin/page.tsx")).toMatch(/REQUIRED - unset/);
  });
});
