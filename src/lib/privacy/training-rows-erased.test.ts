import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// AUDIT F171: VERBATIM TRAVELLER TRANSCRIPTS WERE COPIED INTO agent_training,
// WHICH THE ERASURE REGISTRY EXCUSED AND RETENTION NEVER PRUNED.
//
// The Ops Center's bookmark, correction and lesson actions write rows whose
// text embeds a real traveller's stay area, dates and message wording, built
// from their whatsapp_messages bodies. agent_training had no user key, sat in
// EXCLUDED_TABLES as "owner-authored training snippets" (true before the Ops
// writers existed, false since), and appeared nowhere in retention.sql. So
// the person used Profile -> Erase, the route answered "erased", and their
// words stayed - forever - and were read back unscoped into OTHER travellers'
// live prompts.
//
// The fix keys the rows to the person they were copied from (user_email,
// stamped by the ops writers with a retry-without-the-column rung), registers
// the table so the walker and the DSAR export reach it, and prunes ops rows
// on the mid window. Executed: the REAL walker over a Map-backed store.

vi.mock("../runtime-config", async () => {
  const h = await import("./postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("../evolution", () => ({
  disconnectInstance: async () => ({ severed: true, hostsTried: 0, hadLink: false }),
}));

import { store } from "./postgrest-store.test-helper";
import { eraseUserData } from "./erase";
import { USER_TABLES, EXCLUDED_TABLES } from "./user-tables";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const ALICE_WORDS = "Agent: hi, we are staying near Ao Nang from the 5th to the 9th";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

beforeEach(() => {
  store.reset();
  store.seed("app_users", [{ email: ALICE, status: "active", plan: "free", provider: "email" }]);
  store.seed("agent_training", [
    {
      id: 1,
      text: `[OPS-EXEMPLAR 2026-09-02] Owner-approved negotiation with Krabi Bike Rent:\n${ALICE_WORDS}\nShop: 300 baht per day`,
      note: "Bookmarked in the Ops Center",
      source: "ops-exemplar",
      added_by: "owner@example.com",
      user_email: ALICE,
      created_at: "2026-09-02T10:00:00.000Z",
    },
    {
      id: 2,
      text: '[OPS-CORRECTION 2026-09-02] With Sunrise Rentals, the shop said: "250 final".',
      note: "Owner correction from the Ops Center",
      source: "ops-correction",
      added_by: "owner@example.com",
      user_email: BOB,
      created_at: "2026-09-02T11:00:00.000Z",
    },
    {
      id: 3,
      text: "Agent: can you do 240 for the week? Shop: ok 245 final",
      note: null,
      source: "text",
      added_by: "owner@example.com",
      user_email: null,
      created_at: "2026-09-01T10:00:00.000Z",
    },
  ]);
});

describe("EXECUTED (F171): a traveller's copied exchange leaves with them", () => {
  it("the walker deletes the row copied from Alice and nobody else's", async () => {
    const result = await eraseUserData(ALICE);
    expect(result.failed).toEqual([]);
    const left = store.rows("agent_training");
    // THE ASSERTION THAT FAILED BEFORE: row 1 survived the erase, and the
    // route still answered "erased".
    expect(left.map((r) => r.id)).toEqual([2, 3]);
    expect(JSON.stringify(left)).not.toContain(ALICE_WORDS);
  });

  it("agent_training is REGISTERED by user_email, no longer excused", () => {
    expect(
      USER_TABLES.some(
        (t) => t.table === "agent_training" && t.column === "user_email" && t.match === "exact"
      )
    ).toBe(true);
    expect(Object.keys(EXCLUDED_TABLES)).not.toContain("agent_training");
  });
});

describe("the schema and the retention window carry the other two limbs", () => {
  it("schema.sql adds the user_email column idempotently", () => {
    expect(read("supabase/schema.sql")).toMatch(
      /alter table public\.agent_training add column if not exists user_email text;/
    );
  });

  it("retention.sql prunes the copied rows on the mid window - by key AND by ops source", () => {
    // Rows written before the migration carry a NULL user_email and are
    // exactly the transcript-bearing rows, so the predicate must reach them
    // by source too (the refuter's concern). Owner-authored rows (null key,
    // non-ops source) are untouched.
    const sql = read("supabase/retention.sql");
    expect(sql).toMatch(
      /delete from public\.agent_training\s+where created_at < cutoff_mid\s+and \(user_email is not null or source like 'ops-%'\);/
    );
    expect(sql).toMatch(/jsonb_build_object\('agent_training', n\)/);
  });
});
