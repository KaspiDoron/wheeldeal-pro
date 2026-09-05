import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// AUDIT F170.
//
// agent_events is registered for erasure by `user_email=eq.<email>` and nothing
// else. Several writers interpolated the traveller's address into the free-text
// `detail` while leaving `user_email` null - the send-error breadcrumb, the
// session-closed event, the park failure, the media-unreadable rows - so those
// rows were invisible to eraseUserData and stayed queryable in Admin -> Events
// for up to 90 days after an erasure that reported ok.
//
// The writers are EXECUTED here against a Map-backed store: any inserted
// agent_events row whose detail names the email must carry user_email equal to
// it, and on a database without the column (PostgREST 400) the breadcrumb must
// still land - the existing degrade-and-retry contract, never a lost event.

const state: {
  inserted: { table: string; row: Record<string, unknown> }[];
  rejectUserEmail: boolean;
  outboxFails: boolean;
} = { inserted: [], rejectUserEmail: false, outboxFails: false };

vi.mock("../runtime-config", () => ({
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    if (table === "wa_outbox" && state.outboxFails) return false;
    // An un-migrated database: the column does not exist, PostgREST answers
    // 400, sbInsert returns false.
    if (table === "agent_events" && state.rejectUserEmail && rows.some((r) => "user_email" in r)) {
      return false;
    }
    for (const row of rows) state.inserted.push({ table, row });
    return true;
  },
  sbInsertReturning: async () => [],
  sbInsertClaim: async () => "won" as const,
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: [] }),
  sbSelectDark: async () => null,
  sbUpdate: async () => true,
  sbUpdateReturning: async () => [],
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
  sbCount: async () => 0,
  sbRpc: async () => false,
  getConfig: async () => undefined,
  supabaseConfigured: () => true,
  pgTimestamp: (d: Date | number) => new Date(d).toISOString(),
}));

import { recordSendError } from "../wa-guard";
import { recordSuppressedSend } from "./cancellations";
import { parkOutboxOnce, setDrainArmer } from "./park";

const EMAIL = "tester@example.com";
const SHOP = "66812345678";

const events = (kind: string) =>
  state.inserted.filter((i) => i.table === "agent_events" && i.row.kind === kind).map((i) => i.row);

beforeEach(() => {
  state.inserted = [];
  state.rejectUserEmail = false;
  state.outboxFails = false;
  setDrainArmer(() => {});
});

describe("EXECUTED: a row that names the person in detail is keyed to the person", () => {
  it("the cold send-error breadcrumb carries user_email", async () => {
    await recordSendError(EMAIL, SHOP, { firstContact: true, status: "403" });
    const [row] = events("wa-send-error-cold");
    expect(row).toBeDefined();
    expect(String(row.detail)).toContain(EMAIL);
    // THE ASSERTION THAT FAILED BEFORE: user_email was absent.
    expect(row.user_email).toBe(EMAIL);
  });

  it("the reply-lane send-error breadcrumb carries user_email", async () => {
    await recordSendError(EMAIL, SHOP, { firstContact: false, status: "500" });
    const [row] = events("wa-send-error-reply");
    expect(row.user_email).toBe(EMAIL);
  });

  it("a suppressed send carries user_email", async () => {
    await recordSuppressedSend(EMAIL, SHOP, "cancelled-send-blocked");
    const [row] = events("cancelled-send-blocked");
    expect(String(row.detail)).toContain(EMAIL);
    expect(row.user_email).toBe(EMAIL);
  });

  it("a park failure carries user_email", async () => {
    state.outboxFails = true;
    await parkOutboxOnce({ senderKey: EMAIL, toNumber: SHOP, body: "hello", notBeforeMs: Date.now() });
    const [row] = events("wa-park-failed");
    expect(row).toBeDefined();
    expect(String(row.detail)).toContain(EMAIL);
    expect(row.user_email).toBe(EMAIL);
  });

  it("DEGRADES: without the column the breadcrumb still lands (retry without user_email), never lost", async () => {
    state.rejectUserEmail = true;
    await recordSendError(EMAIL, SHOP, { firstContact: true, status: "403" });
    const rows = events("wa-send-error-cold");
    expect(rows.length).toBe(1);
    expect(rows[0].user_email).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The writers that cannot be driven from a unit test (the webhook body, the
// Evolution close path) are held structurally: every agent_events write whose
// detail interpolates the person's address must carry user_email or go through
// insertUserEvent. Pins the guarantee AND the absence of the unguarded shape.
// ---------------------------------------------------------------------------

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const NAMES_THE_PERSON = /\$\{(email|senderKey|row\.senderKey|userEmail|opts\.senderEmail)\}/;

describe("every agent_events writer that names the person keys the row to them", () => {
  const root = process.cwd();
  const offenders: string[] = [];
  let population = 0;
  for (const p of sourceFiles(join(root, "src"))) {
    const lines = readFileSync(p, "utf8").split("\n");
    const rel = p.replace(root + "/", "");
    lines.forEach((line, i) => {
      const direct = /sbInsert\(\s*"agent_events"/.test(line);
      const viaHelper = /insertUserEvent\(/.test(line) && !/function insertUserEvent/.test(line);
      if (!direct && !viaHelper) return;
      const block = lines.slice(i, i + 22).join("\n");
      if (!NAMES_THE_PERSON.test(block)) return;
      population++;
      if (direct && !/user_email/.test(block)) offenders.push(`${rel}:${i + 1}`);
    });
  }

  it("the scan found the known population (not vacuous)", () => {
    expect(population).toBeGreaterThanOrEqual(10);
  });

  it("no writer interpolates the address into detail while leaving user_email null", () => {
    expect(offenders).toEqual([]);
  });
});
