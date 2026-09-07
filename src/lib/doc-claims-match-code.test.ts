import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// AUDIT DOCDRIFT (G14) - three paragraphs the repair round made false.
//
// A doc that describes last quarter's mechanism is not neutral: it is what the
// next agent reads before touching pacing, the cancellation ledger or the
// vector corpus, and each of these three sentences would steer that change
// wrong. So each claim is checked against the CODE, by running it:
//
//   1. PRODUCTION-READINESS.md described the pacing lock as a per-sender
//      min-gap bucket made straddle-proof by a "previous-bucket age check".
//      After F243 the claim row is keyed on a fixed 5s quantum
//      (FLEET_SLOT_QUANTUM_SEC) and the configured gap is enforced by ONE
//      gap-wide straddle READ across the previous ceil(gap/quantum) slots.
//   2. supabase/schema.sql's comment on wa_cancellations.reason listed three
//      reasons; F049 added a fourth ("account-blocked") that cancelSends
//      really writes.
//   3. docs/VECTOR-SPEC.md called agent_training "owner-authored", the exact
//      excuse F171 retired when it registered the table as user-keyed.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

interface Mocked {
  claims: Map<string, number>;
  inserted: { table: string; rows: Record<string, unknown>[] }[];
  queries: string[];
  nowMs: number;
}
const state: Mocked = { claims: new Map(), inserted: [], queries: [], nowMs: 1_700_000_000_000 };

vi.mock("./runtime-config", () => ({
  getConfig: async () => undefined,
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    state.inserted.push({ table, rows });
    return true;
  },
  sbInsertClaim: async (_t: string, row: { sender_key: string; slot_key: string }) => {
    const key = `${row.sender_key}|${row.slot_key}`;
    if (state.claims.has(key)) return "lost" as const;
    state.claims.set(key, state.nowMs);
    return "won" as const;
  },
  sbDelete: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    state.claims.delete(`${sender}|${slot}`);
    return true;
  },
  sbSelect: async () => [],
  sbSelectStrict: async (_t: string, query: string) => {
    state.queries.push(query);
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const eq = /slot_key=eq\.([^&]+)/.exec(query)?.[1];
    const inList = /slot_key=in\.\(([^)]*)\)/.exec(query)?.[1];
    const slots = eq
      ? [decodeURIComponent(eq)]
      : (inList ?? "")
          .split(",")
          .filter(Boolean)
          .map((s) => decodeURIComponent(s));
    const at = slots
      .map((s) => state.claims.get(`${sender}|${s}`))
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => b - a)[0];
    return { rows: at ? [{ created_at: new Date(at).toISOString() }] : [] };
  },
  sbUpdateReturning: async () => [],
}));

import { claimSendSlots, FLEET_SLOT_QUANTUM_SEC, gapBucket } from "./wa/pacing";
import { cancelSends, type CancelReason } from "./wa/cancellations";
import { USER_TABLES, EXCLUDED_TABLES } from "./privacy/user-tables";

beforeEach(() => {
  vi.useRealTimers();
  state.claims.clear();
  state.inserted.length = 0;
  state.queries.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PRODUCTION-READINESS describes the pacing lock that actually runs", () => {
  it("the claim key carries the QUANTUM and the straddle is one gap-wide read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(state.nowMs);
    const gapSeconds = 20;
    const out = await claimSendSlots({
      senderKey: "traveller@example.com",
      toDigits: "66811112222",
      text: "hello",
      auto: true,
      gapSeconds,
    });
    expect(out.ok).toBe(true);

    // The gap slot is keyed on the quantum bucket, NOT on the configured gap.
    const bucket = gapBucket(state.nowMs, FLEET_SLOT_QUANTUM_SEC);
    expect([...state.claims.keys()].some((k) => k.endsWith(`|gap:${bucket}`))).toBe(true);

    // And the previous-slot check is a single `in.(...)` READ spanning
    // ceil(gap / quantum) slots, not a one-bucket-back age check.
    const straddle = state.queries.find((q) => q.includes("slot_key=in.("));
    expect(straddle, "no gap-wide straddle read was issued").toBeTruthy();
    const keys = /slot_key=in\.\(([^)]*)\)/.exec(straddle ?? "")?.[1].split(",") ?? [];
    expect(keys.length).toBe(Math.ceil(gapSeconds / FLEET_SLOT_QUANTUM_SEC));
  });

  it("the paragraph names the quantum and the gap-wide read, not the retired bucket age check", () => {
    const doc = read("PRODUCTION-READINESS.md");
    const idx = doc.indexOf("wa_send_claims");
    expect(idx, "the concurrency section moved - re-point this test").toBeGreaterThan(-1);
    const section = doc.slice(idx, idx + 1400);
    expect(section).toMatch(/FLEET_SLOT_QUANTUM_SEC/);
    expect(section).toMatch(new RegExp(`${FLEET_SLOT_QUANTUM_SEC}s`));
    expect(section).toMatch(/straddle/i);
    // The retired description: a bucket sized by the gap, checked one bucket back.
    expect(section).not.toMatch(/previous-bucket age check/);
    expect(section).not.toMatch(/per-sender min-gap bucket/);
  });
});

describe("schema.sql documents every cancellation reason the code writes", () => {
  const REASONS: CancelReason[] = [
    "user-removed",
    "session-closed",
    "deal-closed",
    "account-blocked",
  ];

  it("cancelSends really writes each reason, and the column comment lists each", async () => {
    const written: string[] = [];
    for (const reason of REASONS) {
      state.inserted.length = 0;
      const ok = await cancelSends("traveller@example.com", "66811112222", reason);
      expect(ok).toBe(true);
      const row = state.inserted.find((i) => i.table === "wa_cancellations")?.rows[0];
      expect(row, `cancelSends wrote no wa_cancellations row for ${reason}`).toBeTruthy();
      written.push(String(row?.reason));
    }
    expect(written).toEqual(REASONS);

    const schema = read("supabase/schema.sql");
    const table = schema.slice(schema.indexOf("create table if not exists public.wa_cancellations"));
    const comment = table.slice(0, table.indexOf(");"));
    for (const reason of written) {
      expect(comment, `schema.sql does not document reason '${reason}'`).toContain(reason);
    }
  });
});

describe("VECTOR-SPEC does not excuse a registered user-keyed table as owner-authored", () => {
  it("agent_training is registered in the erasure registry", () => {
    expect(USER_TABLES.some((t) => t.table === "agent_training")).toBe(true);
    expect(EXCLUDED_TABLES["agent_training"]).toBeUndefined();
  });

  it("and the spec's corpus-sources paragraph says so", () => {
    const spec = read("docs/VECTOR-SPEC.md");
    const idx = spec.indexOf("Corpus sources by value");
    expect(idx, "the corpus-sources paragraph moved - re-point this test").toBeGreaterThan(-1);
    const para = spec.slice(idx, idx + 900);
    expect(para).toContain("agent_training");
    expect(para).not.toMatch(/agent_training` is owner-authored/);
    // It has to say what the registry says: the rows carry a person.
    expect(para).toMatch(/user-keyed|user_email|erasure registry/);
  });
});
