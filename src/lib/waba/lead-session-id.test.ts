// AUDIT F006: createLead wrote a 12-hex BATCH id into waba_leads.session_id,
// which is a `uuid` column (supabase/schema.sql:1512).
//
// Postgres answers 22P02, PostgREST turns that into a 400, sbInsertReturning
// returns [] - and the pre-migration fallback rung stripped only `thread_key`,
// so the same poisoned value rode the retry and 400ed identically. createLead
// returned null and dispatchHandoff refused EVERY shop in the batch with
// "lead-write-failed": the company-number lane (and the dry-run rehearsal that
// is the safe way to test it) could never succeed from the mass path.
//
// EXECUTED against the real createLead, over a store that models the column:
// an insert carrying a non-uuid session_id is rejected exactly as PostgREST
// rejects it.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rec = vi.hoisted(() => ({
  /** Every waba_leads insert the subject attempted, in order. */
  attempts: [] as Record<string, unknown>[],
  /** Simulate an un-migrated DB: the thread_key column does not exist. */
  rejectThreadKey: false,
  /** Simulate a session_id column that refuses the value whatever it is. */
  rejectSessionColumn: false,
}));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  const base = h.runtimeConfigMock();
  const insertReturning = base.sbInsertReturning as (
    table: string,
    rows: Record<string, unknown>[]
  ) => Promise<Record<string, unknown>[]>;
  return {
    ...base,
    sbInsertReturning: async (table: string, rows: Record<string, unknown>[]) => {
      if (table === "waba_leads") {
        for (const r of rows) {
          rec.attempts.push({ ...r });
          // PostgREST 400 - the column does not exist on this database.
          if (rec.rejectThreadKey && "thread_key" in r) return [];
          if (rec.rejectSessionColumn && "session_id" in r) return [];
          // PostgREST 400 - 22P02, invalid input syntax for type uuid.
          const sid = r.session_id;
          if (typeof sid === "string" && !UUID_SHAPE.test(sid)) return [];
        }
      }
      return insertReturning(table, rows);
    },
  };
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";

// What src/app/api/outreach/mass/route.ts actually mints: randomBytes(6).toString("hex").
const BATCH_ID = "67580f3bf592";
const REAL_UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const INPUT = {
  userEmail: "Traveller@Example.com",
  agencyNumber: "66812345678",
  agencyName: "Sunrise Rentals",
};

beforeEach(() => {
  store.reset();
  rec.attempts.length = 0;
  rec.rejectThreadKey = false;
  rec.rejectSessionColumn = false;
});

describe("EXECUTED (F006): a batch id can never poison the lead insert", () => {
  it("a non-uuid sessionId still lands a lead, with session_id left null", async () => {
    const { createLead } = await import("./leads");
    const lead = await createLead({ ...INPUT, sessionId: BATCH_ID });
    expect(lead, "the lead must be created, not lost to a value shape").not.toBeNull();
    for (const a of rec.attempts) {
      expect(a.session_id, "a 12-hex batch id must never be written to a uuid column").toBeNull();
    }
    // The join to the real conversation spine still rides on the first rung.
    expect(rec.attempts[0].thread_key).toBe("traveller@example.com:66812345678");
  });

  it("a genuine uuid is preserved verbatim", async () => {
    const { createLead } = await import("./leads");
    const lead = await createLead({ ...INPUT, sessionId: REAL_UUID });
    expect(lead?.session_id).toBe(REAL_UUID);
  });

  it("the pre-migration rung strips session_id as well as thread_key", async () => {
    // The file's retry-without-columns doctrine: a lead must never be lost to a
    // pending ALTER - and that has to hold for BOTH columns the first rung adds,
    // not only the one the fallback happened to name.
    rec.rejectThreadKey = true;
    rec.rejectSessionColumn = true;
    const { createLead } = await import("./leads");
    const lead = await createLead({ ...INPUT, sessionId: REAL_UUID });
    expect(lead, "the second rung must land the lead").not.toBeNull();
    const last = rec.attempts[rec.attempts.length - 1];
    expect("thread_key" in last).toBe(false);
    expect("session_id" in last).toBe(false);
    expect(last.state).toBe("draft");
    expect(last.agency_tail).toBeTruthy();
  });
});
