import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// AUDIT F169.
//
// The erasure registry excused agent_golden_cases as "de-identified at
// capture", and the capture did the opposite: both writers persisted
// `thread_key: threadKey` - the raw `${user_email}:${digits}` - beside the
// traveller's RFQ and up to eight verbatim shop messages. An erased tester's
// address stayed in the replay suite forever and never reached their export.
//
// The capture is EXECUTED here against a Map-backed store: the persisted row
// must carry a pseudonymous provenance stamp (the same sha256 prefix shape
// instanceNameFor already uses) and no address anywhere in it.

const inserted: { table: string; rows: Record<string, unknown>[] }[] = [];

vi.mock("@/lib/session", () => ({
  requireOwner: async () => ({ email: "owner@example.com", role: "owner" }),
}));
vi.mock("@/lib/ops/golden", () => ({
  listGoldenCases: async () => [],
  expectationFromOutbound: () => ({}),
  runGoldenCase: async () => ({ pass: true, turns: [] }),
}));
vi.mock("@/lib/runtime-config", () => ({
  sbSelect: async (table: string, query: string) => {
    if (table === "whatsapp_messages" && /direction=eq\.inbound/.test(query)) {
      return [{ body: "250 per day my friend", received_at: "2026-09-01T00:00:00Z" }];
    }
    return [];
  },
  sbInsertReturning: async (table: string, rows: Record<string, unknown>[]) => {
    inserted.push({ table, rows });
    return [{ id: 1 }];
  },
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    inserted.push({ table, rows });
    return true;
  },
  sbUpdate: async () => true,
  sbDelete: async () => true,
}));

import { POST } from "./route";

const EMAIL = "tester@example.com";
const DIGITS = "66812345678";

const freeze = async () => {
  const req = new Request("http://localhost/api/admin/ops/golden", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create-from-thread", threadKey: `${EMAIL}:${DIGITS}` }),
  });
  const res = await POST(req);
  const row = inserted.find((i) => i.table === "agent_golden_cases")?.rows[0];
  return { status: res.status, row };
};

beforeEach(() => {
  inserted.length = 0;
});

describe("EXECUTED: the golden capture stores a pseudonym, never the address", () => {
  it("thread_key carries no email - a sha256-prefix pseudonym plus the shop digits", async () => {
    const { status, row } = await freeze();
    expect(status).toBe(200);
    expect(row).toBeDefined();
    // THE ASSERTION THAT FAILED BEFORE: thread_key was `tester@example.com:66812345678`.
    expect(String(row!.thread_key)).not.toContain("@");
    expect(String(row!.thread_key)).toMatch(/^wd-[0-9a-f]{16}:66812345678$/);
    expect(String(row!.name)).not.toContain("@");
    // Nothing else in the persisted row names the person either.
    expect(JSON.stringify(row)).not.toContain(EMAIL);
  });

  it("the stamp is the shared, deterministic provenance helper (traceable for the owner, not reversible)", async () => {
    const { goldenProvenance, pseudonymForEmail } = await import("@/lib/ops/provenance");
    const { row } = await freeze();
    expect(row!.thread_key).toBe(goldenProvenance(`${EMAIL}:${DIGITS}`));
    expect(row!.thread_key).toBe(`${pseudonymForEmail(EMAIL)}:${DIGITS}`);
    // Case-insensitive on the address, like every other key in this app.
    expect(pseudonymForEmail("Tester@Example.com")).toBe(pseudonymForEmail(EMAIL));
    // A key that is already a pseudonym is left alone (re-stamping must be idempotent).
    expect(goldenProvenance(goldenProvenance(`${EMAIL}:${DIGITS}`))).toBe(
      goldenProvenance(`${EMAIL}:${DIGITS}`)
    );
  });
});

describe("the misread freeze in the review route uses the same stamp", () => {
  const readCode = (p: string) =>
    readFileSync(join(process.cwd(), p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  it("persists goldenProvenance(threadKey), and the raw-key shape is gone from the golden candidate", () => {
    const review = readCode("src/app/api/admin/ops/review/route.ts");
    // Only the GOLDEN candidate is de-identified: the agent_reviews row above
    // it keeps the raw key on purpose (that table is registered for erasure
    // by user_email and the Ops inbox resolves reviews back to their thread).
    const start = review.indexOf("if (misread.shouldHaveMoved) {");
    const end = review.indexOf('sbInsert("agent_golden_cases"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const freeze = review.slice(start, end);
    expect(freeze).toMatch(/thread_key: goldenProvenance\(threadKey\)/);
    expect(freeze).not.toMatch(/thread_key: threadKey\b/);
    const golden = readCode("src/app/api/admin/ops/golden/route.ts");
    expect(golden).toMatch(/thread_key: goldenProvenance\(threadKey\)/);
    expect(golden).not.toMatch(/thread_key: threadKey\b/);
  });
});
