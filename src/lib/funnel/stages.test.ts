// The funnel ledger's rule set, executed - not grepped. The rules ARE the
// product here: a wrong eligible-from set silently freezes or resurrects
// threads at scale, so every rule the module states gets a case that runs it.
import { describe, it, expect, vi, beforeEach } from "vitest";

interface Call {
  table: string;
  filter?: string;
  query?: string;
  values?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
}

const calls: { selects: Call[]; updates: Call[]; inserts: Call[] } = {
  selects: [],
  updates: [],
  inserts: [],
};
let selectResult: { stage: string | null }[] = [];
let updateResult: Record<string, unknown>[] = [];
let insertOk = true;

vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string, query: string) => {
    calls.selects.push({ table, query });
    return selectResult;
  },
  sbUpdateReturning: async (table: string, filter: string, values: Record<string, unknown>) => {
    calls.updates.push({ table, filter, values });
    return updateResult;
  },
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    calls.inserts.push({ table, rows });
    return insertOk;
  },
}));

beforeEach(() => {
  calls.selects.length = 0;
  calls.updates.length = 0;
  calls.inserts.length = 0;
  selectResult = [];
  updateResult = [];
  insertOk = true;
});

const ARGS = { userEmail: "t@x.com", toNumber: "+66 81 234 5678", vendorId: "v1", vendorName: "Krabi Bikes" };

describe("eligibleFrom - the rule set as data", () => {
  it("progression is strictly forward: a later stage is never eligible-from an earlier target", async () => {
    const { eligibleFrom, PROGRESSION_STAGES, stageRank } = await import("./stages");
    for (const to of PROGRESSION_STAGES) {
      const from = eligibleFrom(to);
      for (const s of from) {
        const r = stageRank(s);
        if (r !== undefined) expect(r).toBeLessThan(stageRank(to)!);
      }
    }
  });

  it("hard terminals appear in NO eligible-from set, for any target or option", async () => {
    const { eligibleFrom, PROGRESSION_STAGES, LATERAL_STAGES } = await import("./stages");
    const targets = [...PROGRESSION_STAGES, ...LATERAL_STAGES];
    for (const to of targets) {
      for (const opts of [{}, { restart: true }, { overridesOutOfStock: true }]) {
        const from = eligibleFrom(to, opts);
        expect(from).not.toContain("dead");
        expect(from).not.toContain("completed");
      }
    }
  });

  it("out_of_stock is left ONLY on explicit availability evidence", async () => {
    const { eligibleFrom } = await import("./stages");
    expect(eligibleFrom("price_received")).not.toContain("out_of_stock");
    expect(eligibleFrom("price_received", { overridesOutOfStock: true })).toContain("out_of_stock");
    // A mere reply does not restock the shop - even with restart on the table.
    expect(eligibleFrom("replied")).not.toContain("out_of_stock");
  });

  it("declined is refuted only by price evidence (rank >= price_received)", async () => {
    const { eligibleFrom } = await import("./stages");
    expect(eligibleFrom("replied")).not.toContain("declined");
    expect(eligibleFrom("understood")).not.toContain("declined");
    expect(eligibleFrom("price_received")).toContain("declined");
    expect(eligibleFrom("booked")).toContain("declined");
  });

  it("unreachable is refuted by ANY reply, and only enterable before one", async () => {
    const { eligibleFrom } = await import("./stages");
    expect(eligibleFrom("replied")).toContain("unreachable");
    // Enterable only from the pre-reply rungs.
    expect(eligibleFrom("unreachable")).toEqual(["selected", "contact_queued", "contacted"]);
  });

  it("restart re-opens the early rungs from mid-funnel, but never from a hard terminal", async () => {
    const { eligibleFrom } = await import("./stages");
    const from = eligibleFrom("selected", { restart: true });
    expect(from).toContain("negotiating");
    expect(from).toContain("declined");
    expect(from).not.toContain("dead");
    expect(from).not.toContain("completed");
    // Restart is an early-rung affordance only - it does not loosen later ones.
    expect(eligibleFrom("replied", { restart: true })).not.toContain("negotiating");
  });

  it("the PATCH filter carries the whole rule: null-stage OR the eligible set", async () => {
    const { stageFilter } = await import("./stages");
    const f = stageFilter("t@x.com:6681", "replied");
    expect(f).toContain("thread_key=eq.t%40x.com%3A6681");
    expect(f).toContain("or=(stage.is.null,stage.in.(");
    expect(f).toContain("contacted");
    expect(f).not.toContain("dead");
  });
});

describe("advanceThreadStage - write discipline", () => {
  it("a real transition PATCHes the stage and writes ONE funnel-stage event with join columns", async () => {
    const { advanceThreadStage } = await import("./stages");
    selectResult = [{ stage: "contacted" }];
    updateResult = [{ thread_key: "t@x.com:66812345678" }];
    const res = await advanceThreadStage(ARGS, "replied", "inbound stored", {});
    expect(res.advanced).toBe(true);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].values).toMatchObject({ stage: "replied" });
    const events = calls.inserts.filter((c) => c.table === "agent_events");
    expect(events).toHaveLength(1);
    const row = events[0].rows![0] as Record<string, unknown>;
    expect(row.kind).toBe("funnel-stage");
    expect(row.user_email).toBe("t@x.com");
    expect(row.to_number).toBe("66812345678");
    expect(row.vendor_id).toBe("v1");
    const detail = JSON.parse(String(row.detail));
    expect(detail.from).toBe("contacted");
    expect(detail.to).toBe("replied");
    expect(detail.evidence).toBe("inbound stored");
  });

  it("steady-state duplicate evidence short-circuits: no PATCH, no event", async () => {
    const { advanceThreadStage } = await import("./stages");
    selectResult = [{ stage: "replied" }];
    const res = await advanceThreadStage(ARGS, "replied", "another inbound");
    expect(res).toEqual({ advanced: false, reason: "already" });
    expect(calls.updates).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it("regression is refused before it reaches the store", async () => {
    const { advanceThreadStage } = await import("./stages");
    selectResult = [{ stage: "negotiating" }];
    const res = await advanceThreadStage(ARGS, "replied", "late webhook");
    expect(res).toEqual({ advanced: false, reason: "already" });
    expect(calls.updates).toHaveLength(0);
  });

  it("a hard terminal refuses everything, restart included", async () => {
    const { advanceThreadStage } = await import("./stages");
    selectResult = [{ stage: "dead" }];
    const res = await advanceThreadStage(ARGS, "selected", "re-ask", { restart: true });
    expect(res).toEqual({ advanced: false, reason: "refused" });
    expect(calls.updates).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it("a lost race (filter matched nothing) writes NO event - only the winner records history", async () => {
    const { advanceThreadStage } = await import("./stages");
    selectResult = [{ stage: "contacted" }];
    updateResult = []; // the concurrent winner already moved the row past us
    const res = await advanceThreadStage(ARGS, "replied", "inbound stored");
    expect(res.advanced).toBe(false);
    expect(res.reason).toBe("refused");
    expect(calls.inserts).toHaveLength(0);
  });

  it("no thread row yet: a minimal row is inserted so the ledger sees the very first tap", async () => {
    const { advanceThreadStage } = await import("./stages");
    selectResult = []; // row absent - the engine has never touched this thread
    const res = await advanceThreadStage(ARGS, "selected", "traveller tapped Ask");
    expect(res.advanced).toBe(true);
    const threadInserts = calls.inserts.filter((c) => c.table === "negotiation_threads");
    expect(threadInserts).toHaveLength(1);
    const row = threadInserts[0].rows![0] as Record<string, unknown>;
    expect(row).toMatchObject({
      thread_key: "t@x.com:66812345678",
      user_email: "t@x.com",
      to_number: "66812345678",
      stage: "selected",
    });
    // And the event records from:null - there was no prior stage.
    const ev = calls.inserts.find((c) => c.table === "agent_events");
    expect(JSON.parse(String(ev!.rows![0].detail)).from).toBeNull();
  });

  it("a lost CREATION race falls through to the guarded PATCH instead of failing", async () => {
    const { advanceThreadStage } = await import("./stages");
    selectResult = [];
    insertOk = false; // another instance created the row between read and insert
    updateResult = [{ thread_key: "t@x.com:66812345678" }];
    const res = await advanceThreadStage(ARGS, "selected", "traveller tapped Ask");
    expect(res.advanced).toBe(true);
    expect(calls.updates).toHaveLength(1);
  });

  it("missing identity is a noop, never a throw", async () => {
    const { advanceThreadStage } = await import("./stages");
    const res = await advanceThreadStage({ userEmail: "", toNumber: "123" }, "selected", "x");
    expect(res).toEqual({ advanced: false, reason: "noop" });
    expect(calls.selects).toHaveLength(0);
  });
});
