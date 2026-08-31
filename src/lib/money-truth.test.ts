import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// THE MONEY TAB SAID "PAID 6" WITH ZERO PAYING CUSTOMERS.
//
// Every defect on that screen was the same defect: a number derived from
// something adjacent to the fact it claimed. Paid was derived from the plan
// COLUMN (which this product writes for free to every invitee on every login),
// the percentages were derived from the row above (stages that do not nest),
// the stall buckets from hard-coded thresholds (while the card above them
// printed the owner's), and the quantiles from n=1.
//
// So these tests RUN lifecycleReport against a stubbed store. A source grep
// cannot tell you that 6 became 0.

interface Row {
  [k: string]: unknown;
}
let db: Record<string, Row[]> = {};
let unavailable = new Set<string>();

vi.mock("./runtime-config", () => ({
  getConfig: async () => undefined,
  sbSelectStrict: async (table: string) => {
    if (unavailable.has(table)) return { error: "unavailable" as const };
    if (!(table in db)) return { error: "missing" as const };
    return { rows: db[table] };
  },
}));
vi.mock("./allowlist", () => ({
  isTestUser: async (e: string) => e.startsWith("tester"),
  ownerEmail: () => "owner@wheeldeal.app",
}));
vi.mock("./cohort", () => ({
  WARMUP_HOLDOUT: { key: "warmup", pct: 0, named: [] },
  cohortDecision: async (_c: unknown, email: string) => ({
    member: email.startsWith("hold"),
  }),
}));

const load = async () => (await import("./lifecycle")).lifecycleReport;

const ACTIVATION = "subscription-activated";
const DAY = 864e5;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** One traveller who genuinely paid, five who were invited and never did. */
function seedBetaWithOnePayer() {
  db = {
    app_users: [
      { email: "payer@x.com", plan: "ultra", added_at: iso(10 * DAY), warmed_up_at: iso(9 * DAY) },
      { email: "invitee1@x.com", plan: "ultra", added_at: iso(8 * DAY), warmed_up_at: null },
      { email: "invitee2@x.com", plan: "pro", added_at: iso(8 * DAY), warmed_up_at: null },
      { email: "invitee3@x.com", plan: "ultra", added_at: iso(7 * DAY), warmed_up_at: null },
      { email: "invitee4@x.com", plan: "business", added_at: iso(7 * DAY), warmed_up_at: null },
      { email: "free1@x.com", plan: "free", added_at: iso(6 * DAY), warmed_up_at: null },
    ],
    wa_sessions: [{ email: "payer@x.com", status: "open" }],
    searches: [{ user_email: "payer@x.com", source: "hunt" }],
    wa_recipient_state: [
      { sender_key: "payer@x.com", to_tail: "555111", to_number: "+66555111", first_reply_at: iso(DAY) },
    ],
    agent_events: [{ user_email: "payer@x.com", kind: ACTIVATION }],
  };
  unavailable = new Set();
}

beforeEach(() => {
  vi.resetModules();
  seedBetaWithOnePayer();
});

describe("Paid means a payment, Comped means an entitlement somebody was given", () => {
  it("EXECUTED: five invited plan-holders do not become five paying customers", async () => {
    const r = await (await load())();
    const paid = r.stages.find((s) => s.id === "paid")!;
    const comped = r.stages.find((s) => s.id === "comped")!;
    // The screenshot said 6. Five of those were invites and one was the payer.
    expect(paid.count).toBe(1);
    expect(comped.count).toBe(4);
    expect(paid.label).toMatch(/verified/i);
  });

  it("EXECUTED: an entitlement WITH a payment behind it is paid, not comped", async () => {
    // The payer holds plan=ultra too - the split must not double-count them.
    const r = await (await load())();
    expect(r.stages.find((s) => s.id === "paid")!.count).toBe(1);
    expect(r.stages.find((s) => s.id === "comped")!.count).toBe(4);
  });

  it("EXECUTED: an unreadable payment trail goes DARK, it does not report zero revenue", async () => {
    unavailable = new Set(["agent_events"]);
    const r = await (await load())();
    expect(r.stages.find((s) => s.id === "paid")!.count).toBe(null);
    expect(r.stages.find((s) => s.id === "comped")!.count).toBe(null);
    expect(r.degraded).toContain("verified payments");
  });
});

describe("every percentage is a share of one population that contains it", () => {
  it("EXECUTED: no stage can exceed 100% of signups", async () => {
    const r = await (await load())();
    for (const s of r.stages) {
      if (s.ofSignups === null) continue;
      expect(s.ofSignups, s.id).toBeLessThanOrEqual(1);
      expect(s.ofSignups, s.id).toBeGreaterThanOrEqual(0);
    }
  });

  it("EXECUTED: rows belonging to deleted accounts cannot inflate a numerator", async () => {
    // wa_sessions / searches / wa_recipient_state outlive the account that
    // wrote them. Counting an orphan in a numerator whose denominator is
    // app_users is the second, quieter way to print a ratio above 100%.
    db.wa_sessions.push({ email: "erased@x.com", status: "open" });
    db.searches.push({ user_email: "erased@x.com", source: "hunt" });
    db.wa_recipient_state.push({
      sender_key: "erased@x.com",
      to_tail: "555999",
      to_number: "+66555999",
      first_reply_at: iso(DAY),
    });
    const r = await (await load())();
    expect(r.stages.find((s) => s.id === "linked")!.count).toBe(1);
    expect(r.stages.find((s) => s.id === "searched")!.count).toBe(1);
    expect(r.stages.find((s) => s.id === "reached")!.count).toBe(1);
    for (const s of r.stages) {
      if (s.ofSignups !== null) expect(s.ofSignups, s.id).toBeLessThanOrEqual(1);
    }
  });

  it("EXECUTED: the same shop on two rows is one shop, as the gate counts it", async () => {
    db.wa_recipient_state.push({
      sender_key: "payer@x.com",
      to_tail: "555111",
      to_number: "+66555111",
      first_reply_at: null,
    });
    const r = await (await load())();
    expect(r.stages.find((s) => s.id === "reached")!.count).toBe(1);
  });
});

describe("the tiles beside the funnel tell the truth about their own evidence", () => {
  it("EXECUTED: quantiles report the sample they came from", async () => {
    const r = await (await load())();
    // One warmed account. The panel withholds the quantiles below its floor;
    // the report's job is to say how thin the sample is.
    expect(r.warm.sampleN).toBe(1);
  });

  it("EXECUTED: 'last 7 days' is an epoch comparison, not a string comparison", async () => {
    // THE CASE WHERE THE TWO COMPARISONS DISAGREE. This account warmed two
    // hours INSIDE the window, but its timestamp is written in UTC-05:00, so
    // its literal characters read five hours earlier than the instant it
    // denotes - three hours BEFORE the cutoff. Lexical ordering drops it;
    // Date.parse, which the loop already computed one line above, keeps it.
    const instant = Date.now() - 7 * DAY + 2 * 3600_000;
    const offsetLiteral =
      new Date(instant - 5 * 3600_000).toISOString().replace("Z", "-05:00");
    expect(offsetLiteral < new Date(Date.now() - 7 * DAY).toISOString()).toBe(true);
    expect(Date.parse(offsetLiteral)).toBeGreaterThan(Date.now() - 7 * DAY);
    db.app_users.push({
      email: "offsetwarm@x.com",
      plan: "free",
      added_at: iso(9 * DAY),
      warmed_up_at: offsetLiteral,
    });
    const r = await (await load())();
    // The base seed's one warmed account is 9 days old, so this is the only
    // account in the window - and before the fix it was invisible.
    expect(r.warm.last7d).toBe(1);
  });

  it("EXECUTED: gate-exempt accounts are not counted as stalled", async () => {
    db.app_users.push(
      { email: "owner@wheeldeal.app", plan: "business", added_at: iso(30 * DAY), warmed_up_at: null },
      { email: "tester1@x.com", plan: "ultra", added_at: iso(2 * DAY), warmed_up_at: null }
    );
    const r = await (await load())();
    expect(r.stallBasis!.exempt).toBe(2);
    const stuckTotal = r.stalls!.reduce((n, s) => n + s.stuck, 0);
    // 5 non-warm, non-exempt accounts remain (4 invitees + 1 free).
    expect(stuckTotal).toBe(5);
  });

  it("EXECUTED: the stall buckets name the thresholds they measured against", async () => {
    const r = await (await load())();
    expect(r.stallBasis).toEqual({ minEngaged: 3, minReplies: 1, exempt: 0 });
    expect(r.stalls!.find((s) => s.id === "engaged")!.label).toContain("3");
  });

  it("EXECUTED: the holdout arms convert on PAYMENTS, and go dark without them", async () => {
    db.app_users.push({
      email: "holdpayer@x.com",
      plan: "ultra",
      added_at: iso(5 * DAY),
      warmed_up_at: null,
    });
    db.agent_events.push({ user_email: "holdpayer@x.com", kind: ACTIVATION });
    const r = await (await load())();
    // The holdout arm has one member and that member really paid.
    expect(r.holdout.size).toBe(1);
    expect(r.holdout.converted).toBe(1);
    // The gated arm has six members and exactly ONE payer - not five, which is
    // what reading the plan column reported.
    expect(r.holdout.gatedSize).toBe(6);
    expect(r.holdout.gatedConverted).toBe(1);
  });

  it("EXECUTED: an unreadable payment trail darkens the holdout too", async () => {
    unavailable = new Set(["agent_events"]);
    const r = await (await load())();
    expect(r.holdout.converted).toBe(null);
    expect(r.holdout.gatedConverted).toBe(null);
    // The arm SIZES are still real and still shown.
    expect(r.holdout.size).not.toBe(null);
  });
});

describe("the payment record survives long enough to be the payment record", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/retention.sql"), "utf8");

  it("the 90-day prune no longer deletes the only proof a customer paid", () => {
    // billing_events has NO user_email column, so subscription-activated rows
    // are the one attributable money record in the system. Deleting them at 90d
    // moved every customer older than a quarter from Paid to Comped and
    // disarmed the PayPal reconcile sweep at the same time.
    expect(sql).toMatch(/kind not in \('subscription-activated'/);
    expect(sql).toMatch(/where created_at < cutoff_long\s*\n\s*and kind in \('subscription-activated'/);
  });

  it("the webhook-only grant writes an ATTRIBUTED activation row", () => {
    // The redirect checkout where the traveller never returns: the webhook was
    // the only thing applying what they paid for, and it wrote nothing carrying
    // an email - so a genuine payer was counted as comped.
    const hook = readFileSync(join(process.cwd(), "src/app/api/webhooks/paypal/route.ts"), "utf8");
    expect(hook).toMatch(/kind: ACTIVATION_KIND/);
    expect(hook).toMatch(/user_email: email/);
    expect(hook).toMatch(/source: "paypal-webhook"/);
  });
});
