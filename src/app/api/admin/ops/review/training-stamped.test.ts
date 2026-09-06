import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F171 (the writer half): every agent_training row the Ops Center
// builds FROM a traveller's thread is stamped with that traveller's address,
// so the erasure registry and the DSAR export can find it. Attempted WITH the
// column and retried WITHOUT it when the write does not confirm - the same
// degrade contract events.ts uses - so an un-migrated database loses the key,
// never the lesson. Executed against the real route over a Map-backed store.

vi.mock("@/lib/session", () => ({
  requireOwner: async () => ({ email: "owner@example.com", role: "owner", plan: "ultra", issuedAt: 0 }),
}));

/** Simulates a database where schema.sql has not been re-run: PostgREST 400s any agent_training write naming user_email. */
const flags = { rejectUserEmailColumn: false };

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  const base = h.runtimeConfigMock() as {
    sbInsert: (t: string, r: Row[], c?: string) => Promise<boolean>;
    sbInsertReturning: (t: string, r: Row[]) => Promise<Row[]>;
  };
  const stale = (table: string, rows: Row[]) =>
    table === "agent_training" && flags.rejectUserEmailColumn && rows.some((r) => "user_email" in r);
  return {
    ...base,
    sbInsert: async (table: string, rows: Row[], onConflict?: string) =>
      stale(table, rows) ? false : base.sbInsert(table, rows, onConflict),
    sbInsertReturning: async (table: string, rows: Row[]) =>
      stale(table, rows) ? [] : base.sbInsertReturning(table, rows),
  };
});
// The learning side effects that hang off a review save are not under test.
vi.mock("@/lib/ops/learning", () => ({ recompileOpsLearning: async () => {} }));
vi.mock("@/lib/ops/golden", () => ({
  runGoldenSuite: async () => ({ passed: 0, total: 0, cases: [] }),
  goldenGateBlocks: () => "the golden suite could not be read",
  runGoldenCase: async () => ({ pass: false, turns: [] }),
}));
vi.mock("@/lib/policy", () => ({ saveVersionedSpec: async () => ({ ok: true }) }));
vi.mock("@/lib/ops/overlay", () => ({ getPolicyOverlay: async () => ({}) }));
vi.mock("@/lib/spte/coaching", () => ({ bustCoachingCache: () => {} }));

import { store, type Row } from "@/lib/privacy/postgrest-store.test-helper";
import { POST } from "./route";

const ALICE = "alice@example.com";
const DIGITS = "66812345678";
const THREAD = `${ALICE}:${DIGITS}`;
const ALICE_WORDS = "hi, we are staying near Ao Nang from the 5th to the 9th";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://local/api/admin/ops/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

const trainingRow = (sourcePrefix: string) =>
  store.rows("agent_training").find((r) => String(r.source ?? "").startsWith(sourcePrefix));

beforeEach(() => {
  store.reset();
  flags.rejectUserEmailColumn = false;
  store.seed("negotiation_threads", [
    { thread_key: THREAD, user_email: ALICE, vendor_id: "v-krabi", vendor_name: "Krabi Bike Rent" },
  ]);
  store.seed("whatsapp_messages", [
    {
      id: 1,
      direction: "outbound",
      to_number: DIGITS,
      body: ALICE_WORDS,
      received_at: "2026-09-02T09:00:00.000Z",
      raw: { sender: ALICE },
    },
    {
      id: 2,
      direction: "inbound",
      from_number: DIGITS,
      body: "300 baht per day",
      received_at: "2026-09-02T09:05:00.000Z",
      raw: { receiver: ALICE },
    },
  ]);
});

describe("EXECUTED (F171): the ops writers stamp the traveller the text was copied from", () => {
  it("a bookmark's exemplar carries Alice's words AND her address", async () => {
    const res = await post({ threadKey: THREAD, bookmark: true });
    expect(res.status).toBe(200);
    const row = trainingRow("ops-exemplar");
    expect(row).toBeDefined();
    expect(String(row?.text)).toContain(ALICE_WORDS);
    // THE ASSERTION THAT FAILED BEFORE: no key, so no walker could find it.
    expect(row?.user_email).toBe(ALICE);
  });

  it("a correction is stamped too", async () => {
    const res = await post({ threadKey: THREAD, betterResponse: "Ask for 260 with the helmet included." });
    expect(res.status).toBe(200);
    const row = trainingRow("ops-correction");
    expect(row).toBeDefined();
    expect(row?.user_email).toBe(ALICE);
  });

  it("a misread lesson is stamped too", async () => {
    const res = await post({
      threadKey: THREAD,
      misread: { shopMessage: "we only have the 160cc left", actualMeaning: "option-menu" },
    });
    expect(res.status).toBe(200);
    const row = trainingRow("ops-lesson");
    expect(row).toBeDefined();
    expect(row?.user_email).toBe(ALICE);
  });

  it("an un-migrated database keeps the exemplar and loses only the key", async () => {
    flags.rejectUserEmailColumn = true;
    const res = await post({ threadKey: THREAD, bookmark: true });
    expect(res.status).toBe(200);
    const row = trainingRow("ops-exemplar");
    expect(row).toBeDefined();
    expect(String(row?.text)).toContain(ALICE_WORDS);
    expect("user_email" in (row ?? {})).toBe(false);
  });
});
