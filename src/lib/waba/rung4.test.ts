import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// RUNG 4 - THE HOLD TIMES OUT, THE LEGACY PATH TAKES OVER.
//
// Constraint 1 (absolute shop choice): a traveller who picked a shop gets that
// shop contacted. An agency that never answers the company number inside the
// hold window still has to be reachable - on the traveller's own wire, exactly
// as before the WABA lane existed. The sweep's correctness rests on three
// things tested here: the atomic state=eq.held expiry claim (the flush and the
// sweep race BY DESIGN), the fallback payload captured at hold time (a held
// lead has no anchor row - nothing was ever sent), and the re-dispatch being a
// PARKED row the drain fully re-guards, never a direct send.

const config: Record<string, string | null> = {};
let heldRows: unknown = { rows: [] };
let expireResult: { id: number }[] = [{ id: 1 }];
const inserted: { table: string; rows: Record<string, unknown>[] }[] = [];
const updatedReturning: { table: string; filter: string; values: Record<string, unknown> }[] = [];
const updated: { table: string; filter: string; values: Record<string, unknown> }[] = [];
const claims: { table: string; row: Record<string, unknown> }[] = [];
let claimResult: "won" | "lost" | "error" = "won";
let updateOk = true;

vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => config[k] ?? null,
  sbSelectStrict: async (table: string, q: string) => {
    if (table === "waba_leads" && q.includes("state=eq.held")) return heldRows;
    return { rows: [] };
  },
  sbSelect: async () => [],
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    inserted.push({ table, rows });
    return true;
  },
  sbInsertReturning: async (_t: string, rows: Record<string, unknown>[]) => [
    { ...rows[0], id: 9, created_at: new Date().toISOString() },
  ],
  sbUpdate: async (table: string, filter: string, values: Record<string, unknown>) => {
    updated.push({ table, filter, values });
    return updateOk || !("fallback" in values);
  },
  sbUpdateReturning: async (table: string, filter: string, values: Record<string, unknown>) => {
    updatedReturning.push({ table, filter, values });
    return expireResult;
  },
  sbInsertClaim: async (table: string, row: Record<string, unknown>) => {
    claims.push({ table, row });
    return claimResult;
  },
}));

vi.mock("../wa/outbox-columns", () => ({ outboxToKeyPatch: async () => ({}) }));
vi.mock("../wa-guard", () => ({
  humanizeForOutbound: (_s: string, _d: string, text: string) => text,
}));
const stageCalls: { to: string; transport?: string }[] = [];
vi.mock("../funnel/stages", () => ({
  advanceThreadStage: async (args: { transport?: string }, to: string) => {
    stageCalls.push({ to, transport: args.transport });
    return { advanced: true };
  },
}));
let sendCalls = 0;
vi.mock("./send", () => ({
  wabaSend: async () => {
    sendCalls += 1;
    return { ok: true, dryRun: false, messageId: "m1", preview: "wire" };
  },
}));

const HELD_LEAD = {
  id: 1,
  state: "held",
  user_email: "t@example.com",
  agency_tail: "812345678",
  agency_number: "66812345678",
  agency_name: "Sunrise Rentals",
  session_id: null,
  lane: null,
  link_token: "tok_abcdefghij",
  created_at: "2026-08-01T00:00:00Z",
  sent_at: null,
  agency_replied_at: null,
  traveller_inbound_at: null,
  handed_off_at: null,
  terminal_reason: null,
  thread_key: "t@example.com:66812345678",
  fallback: {
    text: "Hey - looking for a 125cc scooter for 4 days, what would it cost?",
    rfq: { vehicleClass: "scooter", engineSizeCc: 125, durationDays: 4 },
    vendorId: "v-1",
    vendorName: "Sunrise Rentals",
  },
};

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  // A deployment that has NEVER pasted a WABA credential never reads
  // waba_leads - that is the flag-off invariant, and it is what the beta runs
  // as. These are rung-4 tests, so this deployment is one that HAS configured
  // the lane; whether the switch is currently on is deliberately irrelevant,
  // because a lane that was turned off (or killed mid-incident) still owes its
  // held leads a re-dispatch on the traveller's own wire.
  config.WABA_SENDER_ID = "s";
  config.WABA_API_KEY = "k";
  heldRows = { rows: [] };
  expireResult = [{ id: 1 }];
  inserted.length = 0;
  updatedReturning.length = 0;
  updated.length = 0;
  claims.length = 0;
  claimResult = "won";
  updateOk = true;
  stageCalls.length = 0;
  sendCalls = 0;
});

describe("the expiry claim is atomic - the flush and the sweep cannot both act", () => {
  it("only a STILL-HELD lead may expire, enforced in the filter", async () => {
    const { expireHold } = await import("./leads");
    expect(await expireHold(1)).toBe(true);
    expect(updatedReturning[0].filter).toContain("state=eq.held");
    expect(updatedReturning[0].values).toMatchObject({
      state: "expired",
      terminal_reason: "hold-timeout",
    });
  });

  it("losing the claim reports false and the sweep re-dispatches NOTHING", async () => {
    heldRows = { rows: [HELD_LEAD] };
    expireResult = []; // the window flush won - its freeform send stands
    const { sweepExpiredHolds } = await import("./dispatch");
    const out = await sweepExpiredHolds(Date.parse("2026-08-01T02:00:00Z"));
    expect(out).toEqual({ expired: 0, redispatched: 0 });
    expect(inserted.find((i) => i.table === "wa_outbox")).toBeUndefined();
  });
});

describe("the sweep respects the flag-off invariant without stranding anything", () => {
  it("EXECUTED: a deployment that never configured WABA reads no WABA table", async () => {
    // waba/config.ts pins the invariant: with the lane unconfigured, no new
    // table is read and no new request leaves the process. This sweep runs from
    // the ping every five minutes, so it was quietly breaking that on every
    // Evolution-only deployment.
    for (const k of Object.keys(config)) delete config[k];
    heldRows = { rows: [HELD_LEAD] };
    const { sweepExpiredHolds } = await import("./dispatch");
    const out = await sweepExpiredHolds(Date.parse("2026-08-01T02:00:00Z"));
    expect(out).toEqual({ expired: 0, redispatched: 0 });
    expect(inserted).toHaveLength(0);
  });

  it("EXECUTED: a lane switched OFF still re-dispatches its held leads", async () => {
    // The gate is CONFIGURED, not enabled. Gating on the on/off switch would
    // strand exactly the leads rung 4 exists to rescue - a held lead whose
    // shop never answered, whose traveller is still waiting.
    config.WABA_ENABLED = "off";
    heldRows = { rows: [HELD_LEAD] };
    const { sweepExpiredHolds } = await import("./dispatch");
    const out = await sweepExpiredHolds(Date.parse("2026-08-01T02:00:00Z"));
    expect(out).toEqual({ expired: 1, redispatched: 1 });
  });
});

describe("an expired hold re-dispatches the traveller's REAL opener on their own wire", () => {
  it("parks the stored fallback as a guarded outbox row, never a direct send", async () => {
    heldRows = { rows: [HELD_LEAD] };
    const { sweepExpiredHolds } = await import("./dispatch");
    const out = await sweepExpiredHolds(Date.parse("2026-08-01T02:00:00Z"));
    expect(out).toEqual({ expired: 1, redispatched: 1 });
    const park = inserted.find((i) => i.table === "wa_outbox");
    expect(park).toBeDefined();
    const row = park!.rows[0];
    expect(row.sender_key).toBe("t@example.com");
    expect(row.to_number).toBe("66812345678");
    expect(String(row.body)).toContain("125cc scooter");
    // The rfq rides the meta so the delivered row can anchor the thread.
    const meta = row.meta as { kind: string; rfq: { durationDays?: number } | null };
    expect(meta.kind).toBe("rfq");
    expect(meta.rfq?.durationDays).toBe(4);
    // No wabaSend - rung 4 is the OTHER wire.
    expect(sendCalls).toBe(0);
  });

  it("the funnel says what happened: queued on the traveller's wire, not waba", async () => {
    heldRows = { rows: [HELD_LEAD] };
    const { sweepExpiredHolds } = await import("./dispatch");
    await sweepExpiredHolds(Date.parse("2026-08-01T02:00:00Z"));
    expect(stageCalls).toContainEqual({ to: "contact_queued", transport: "evolution" });
  });

  it("a hold with no payload is recorded as unrecoverable, never silently dropped", async () => {
    heldRows = { rows: [{ ...HELD_LEAD, fallback: null }] };
    const { sweepExpiredHolds } = await import("./dispatch");
    const out = await sweepExpiredHolds(Date.parse("2026-08-01T02:00:00Z"));
    expect(out).toEqual({ expired: 1, redispatched: 0 });
    expect(inserted.find((i) => i.table === "wa_outbox")).toBeUndefined();
    const events = inserted.filter((i) => i.table === "waba_events");
    expect(events.some((e) => e.rows[0].kind === "expired-unrecoverable")).toBe(true);
  });
});

describe("the template lane is claimed atomically, once per agency per day", () => {
  const live = () => {
    config.WABA_ENABLED = "on";
    config.WABA_DRY_RUN = "off";
    config.WABA_BASE_URL = "https://example.test";
    config.WABA_API_KEY = "k";
    config.WABA_SENDER_ID = "s";
    config.WABA_TEMPLATE_FIRST_CONTACT = "first_contact";
    config.WABA_LINK_BASE = "https://wheeldeal.test/h";
  };
  const INPUT = {
    vehicle: "scooter",
    dates: "4 days",
    freeformText: "hey",
    agencyName: "Sunrise Rentals",
  };

  it("two concurrent dispatches cannot both pay - the loser HOLDS", async () => {
    live();
    claimResult = "lost";
    const { sendForLead } = await import("./dispatch");
    const out = await sendForLead(HELD_LEAD as never, "template", INPUT);
    expect(out.outcome).toBe("held");
    expect(sendCalls, "the losing dispatch must not put a template on the wire").toBe(0);
    expect(claims[0].row.slot_key).toMatch(/^template:812345678:\d{4}-\d{2}-\d{2}$/);
  });

  it("a DRY RUN takes no claim - a rehearsal spends nothing", async () => {
    live();
    config.WABA_DRY_RUN = "on";
    const { sendForLead } = await import("./dispatch");
    await sendForLead(HELD_LEAD as never, "template", INPUT);
    expect(claims).toHaveLength(0);
  });

  it("the free lane never pays the template lane's claim", async () => {
    live();
    const { sendForLead } = await import("./dispatch");
    await sendForLead(HELD_LEAD as never, "freeform", INPUT);
    expect(claims).toHaveLength(0);
  });
});

describe("holdLead survives a pre-migration DB", () => {
  it("retries without the payload rather than losing the hold", async () => {
    updateOk = false; // the fallback column does not exist yet
    const { holdLead } = await import("./leads");
    const ok = await holdLead(1, { text: "opener" });
    expect(ok).toBe(true);
    expect(updated.length).toBe(2);
    expect("fallback" in updated[1].values).toBe(false);
  });
});
