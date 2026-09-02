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
/** Served ONLY to the spelling-tolerant legacy lookup (the one filtering on
 *  user_email + to_number rather than thread_key). */
let legacyRow: { thread_key: string; stage: string | null } | null = null;
let updateResult: Record<string, unknown>[] = [];
let insertOk = true;

/**
 * When set, the mock becomes a MINIMAL POSTGREST: sbSelect serves db.stage,
 * and sbUpdateReturning actually EVALUATES the PATCH filter's
 * `or=(stage.is.null,stage.in.(...))` clause against it before applying. This
 * is what proves the filter STRINGS encode the rules - the pure eligibleFrom
 * tests alone could pass while the filter builder dropped the set entirely.
 */
let db: { exists: boolean; stage: string | null } | undefined;

function filterMatches(filter: string, stage: string | null): boolean {
  const m = filter.match(/or=\(stage\.is\.null,stage\.in\.\(([^)]*)\)\)/);
  if (!m) return false;
  if (stage === null) return true;
  return m[1].split(",").includes(stage);
}

vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string, query: string) => {
    calls.selects.push({ table, query });
    // The legacy-adoption read: keyed on the user + every spelling of the
    // number, NOT on thread_key.
    if (query.includes("user_email=eq.") && !query.includes("thread_key=eq.")) {
      return legacyRow ? [legacyRow] : [];
    }
    if (db) return db.exists ? [{ stage: db.stage }] : [];
    return selectResult;
  },
  sbUpdateReturning: async (table: string, filter: string, values: Record<string, unknown>) => {
    calls.updates.push({ table, filter, values });
    if (db) {
      if (!db.exists || !filterMatches(filter, db.stage)) return [];
      db.stage = String(values.stage);
      return [{ thread_key: "walk" }];
    }
    return updateResult;
  },
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    calls.inserts.push({ table, rows });
    if (db && table === "negotiation_threads") {
      if (db.exists) return false; // PK conflict - the creation race
      db.exists = true;
      db.stage = String((rows[0] as { stage?: string }).stage ?? "") || null;
      return true;
    }
    return insertOk;
  },
}));

beforeEach(() => {
  calls.selects.length = 0;
  calls.updates.length = 0;
  calls.inserts.length = 0;
  selectResult = [];
  legacyRow = null;
  updateResult = [];
  insertOk = true;
  db = undefined;
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
      // The IDENTITY key (national tail), not the raw digits. `contacted` is
      // stamped with Google's spelling and `replied` with the JID's, and raw
      // digits made those two different primary keys - so the ledger split
      // into a vendor-less `replied` row beside a stuck `contacted` one, and
      // the traveller's card stayed on "Awaiting reply" for a shop that had
      // plainly answered.
      thread_key: "t@x.com:812345678",
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

describe("the funnel walk - the whole ledger against a real filter evaluator", () => {
  it("a thread walks the owner's funnel in evidence order, one event per rung", async () => {
    const { advanceThreadStage } = await import("./stages");
    db = { exists: false, stage: null };
    const walk = [
      ["selected", "traveller tapped Ask"],
      ["contact_queued", "RFQ parked"],
      ["contacted", "RFQ delivered"],
      ["replied", "inbound stored"],
      ["understood", "actionable fact"],
      ["price_received", "shop quoted"],
      ["negotiating", "bargain round 1"],
      ["terms_collected", "deposit and handover known"],
      ["booked", "booking stored"],
    ] as const;
    for (const [stage, evidence] of walk) {
      const res = await advanceThreadStage(ARGS, stage, evidence);
      expect(res.advanced, `${stage} should advance`).toBe(true);
      expect(db.stage).toBe(stage);
    }
    const events = calls.inserts.filter((c) => c.table === "agent_events");
    expect(events).toHaveLength(walk.length);
    // The history is a chain: each event's `from` is the previous event's `to`.
    const seq = events.map((e) => JSON.parse(String(e.rows![0].detail)));
    for (let i = 1; i < seq.length; i++) expect(seq[i].from).toBe(seq[i - 1].to);
    expect(seq[0].from).toBeNull();
  });

  it("a sticker after understanding adds nothing: replied is behind and writes no event", async () => {
    const { advanceThreadStage } = await import("./stages");
    db = { exists: true, stage: "price_received" };
    const res = await advanceThreadStage(ARGS, "replied", "sticker stored");
    expect(res).toEqual({ advanced: false, reason: "already" });
    expect(calls.inserts).toHaveLength(0);
    expect(db.stage).toBe("price_received");
  });

  it("out_of_stock traps the thread until explicit availability, then a price frees it", async () => {
    const { advanceThreadStage } = await import("./stages");
    db = { exists: true, stage: "understood" };
    expect((await advanceThreadStage(ARGS, "out_of_stock", "no bikes")).advanced).toBe(true);
    // A plain reply cannot restock the shop...
    expect((await advanceThreadStage(ARGS, "price_received", "quoted anyway")).advanced).toBe(false);
    expect(db.stage).toBe("out_of_stock");
    // ...but the shop saying it IS available can.
    expect(
      (await advanceThreadStage(ARGS, "price_received", "back in stock, 250/day", { overridesOutOfStock: true }))
        .advanced
    ).toBe(true);
    expect(db.stage).toBe("price_received");
  });

  it("a new hunt restarts a mid-funnel thread; the dead one stays dead", async () => {
    const { advanceThreadStage } = await import("./stages");
    db = { exists: true, stage: "negotiating" };
    expect(
      (await advanceThreadStage(ARGS, "selected", "fresh Ask", { restart: true })).advanced
    ).toBe(true);
    expect(db.stage).toBe("selected");
    db = { exists: true, stage: "dead" };
    expect(
      (await advanceThreadStage(ARGS, "selected", "fresh Ask", { restart: true })).advanced
    ).toBe(false);
    expect(db.stage).toBe("dead");
  });
});

describe("one shop is one thread row, whatever spelling the caller holds", () => {
  // THE SPLIT. `contacted` is stamped with the number Google Places returned
  // (often the national form) and `replied` with the number the inbound JID
  // carried (always international). thread_key is the PRIMARY KEY, so raw
  // digits produced two rows: the outbound one holding vendor_id and frozen at
  // `contacted`, and a second, vendor-less one at `replied` that no card could
  // join to. The app said "Awaiting reply" about a shop that had answered.
  const EMAIL = "t@x.com";
  const GOOGLE_FORM = "081236954642"; // how we stored it when we messaged
  const JID_FORM = "6281236954642"; // how the reply arrives

  it("both spellings produce the SAME thread_key", async () => {
    const { advanceThreadStage } = await import("./stages");

    selectResult = [];
    await advanceThreadStage(
      { userEmail: EMAIL, toNumber: GOOGLE_FORM },
      "contacted",
      "rfq delivered"
    );
    const first = (
      calls.inserts.find((c) => c.table === "negotiation_threads")!.rows![0] as {
        thread_key: string;
      }
    ).thread_key;

    calls.inserts.length = 0;
    selectResult = [];
    await advanceThreadStage(
      { userEmail: EMAIL, toNumber: JID_FORM },
      "replied",
      "inbound stored"
    );
    const second = (
      calls.inserts.find((c) => c.table === "negotiation_threads")!.rows![0] as {
        thread_key: string;
      }
    ).thread_key;

    expect(first).toBe(second);
  });

  it("a row written under the OLD exact-digits key is adopted, not duplicated", async () => {
    const { advanceThreadStage } = await import("./stages");
    // Nothing at the canonical key...
    selectResult = [];
    // ...but a pre-canonicalisation row exists under the raw-digits key.
    legacyRow = { thread_key: `${EMAIL}:${GOOGLE_FORM}`, stage: "contacted" };
    updateResult = [{ thread_key: `${EMAIL}:${GOOGLE_FORM}` }];

    const res = await advanceThreadStage(
      { userEmail: EMAIL, toNumber: JID_FORM },
      "replied",
      "inbound stored"
    );

    expect(res.advanced).toBe(true);
    // No second thread row was created...
    expect(calls.inserts.filter((c) => c.table === "negotiation_threads")).toHaveLength(0);
    // ...and the PATCH went to the row that already exists.
    expect(calls.updates[0].filter).toContain(encodeURIComponent(`${EMAIL}:${GOOGLE_FORM}`));
  });

  it("with no legacy row, the canonical key is used and a row is created", async () => {
    const { advanceThreadStage } = await import("./stages");
    selectResult = [];
    legacyRow = null;
    await advanceThreadStage({ userEmail: EMAIL, toNumber: JID_FORM }, "replied", "inbound");
    const row = calls.inserts.find((c) => c.table === "negotiation_threads")!.rows![0] as {
      thread_key: string;
    };
    expect(row.thread_key).toBe(`${EMAIL}:236954642`);
  });
});
