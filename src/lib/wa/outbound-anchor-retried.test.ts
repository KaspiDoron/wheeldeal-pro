import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// AUDIT F014: THE DRAIN DISCARDED THE OUTBOUND-ROW INSERT AFTER A DELIVERED
// SEND, SO THE SHOP'S WHOLE CONVERSATION DIED AS no-rfq-thread.
//
// After sendFromUser succeeded the drain wrote the whatsapp_messages anchor
// with `await sbInsert(...)` and threw the boolean away (sbInsert never
// throws - it returns false on any non-2xx or timedFetch abort), then retired
// the outbox row and stamped the funnel `contacted`. With no outbound row at
// all, resolveThreadContext finds zero anchors, agent-loop returns at
// `no-rfq-thread`, and every later reply from that shop is stored and never
// processed - for the life of the thread. The single-shop route already read
// the same boolean and wrote `outbound-log-failed`; the drain, the mass route
// and the price re-check did not.
//
// The fix is ONE helper on the outbox lifecycle - recordOutboundAnchor - that
// the three delivered-send paths call: it retries the insert once and, if the
// anchor is still lost, writes the existing outbound-log-failed breadcrumb
// with the join columns stamped and enough detail to re-anchor. The retire
// ordering is untouched (the refuter's concern): the outbox row is still
// completed right after the anchor attempt, never left pending for a second
// drain to send the shop a second real message.
//
// drainOutbox is not unit-runnable (its in-module guardOutbound read surface
// cannot be stubbed from outside the module - see drain-lifecycle.test.ts), so
// this file EXECUTES the helper against a Map-backed store and pins the drain's
// call ordering plus the absence of the bare-insert shape at the source.

const fail: { whatsappMessagesInsertsToFail: number } = { whatsappMessagesInsertsToFail: 0 };

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  const base = h.runtimeConfigMock() as Record<string, unknown> & {
    sbInsert: (t: string, rows: Record<string, unknown>[], c?: string) => Promise<boolean>;
  };
  return {
    ...base,
    sbInsert: async (table: string, rows: Record<string, unknown>[], onConflict?: string) => {
      if (table === "whatsapp_messages" && fail.whatsappMessagesInsertsToFail > 0) {
        fail.whatsappMessagesInsertsToFail -= 1;
        h.store.log.push({ op: "insert", table, rows });
        return false; // a 400 / 5xx / timedFetch abort: sbInsert answers false
      }
      return base.sbInsert(table, rows, onConflict);
    },
  };
});

import { store } from "../privacy/postgrest-store.test-helper";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const SENDER = "traveller@example.com";
const SHOP = "66812345678";
const anchorRow = () => ({
  wa_message_id: "3EB0ABCDEF",
  to_number: SHOP,
  body: "Hi! Do you have a scooter for 3 days?",
  type: "text",
  direction: "outbound",
  raw: { sender: SENDER, ok: true, kind: "rfq", vendorId: "v1", vendorName: "Shop" },
});
const who = { senderKey: SENDER, toNumber: SHOP, vendorId: "v1", vendorName: "Shop", channel: "personal-wa" };

beforeEach(() => {
  store.reset();
  fail.whatsappMessagesInsertsToFail = 0;
});

describe("EXECUTED (F014): the anchor write is retried and its loss is breadcrumbed", () => {
  it("a lost anchor is retried once, then named with the join columns stamped", async () => {
    const { recordOutboundAnchor } = await import("./outbox-lifecycle");
    fail.whatsappMessagesInsertsToFail = 2;
    const ok = await recordOutboundAnchor(anchorRow(), who);
    expect(ok).toBe(false);
    const attempts = store.log.filter((w) => w.op === "insert" && w.table === "whatsapp_messages");
    expect(attempts).toHaveLength(2);
    // The breadcrumb the single-shop route already writes, with the join
    // columns as COLUMNS (without them it is invisible to every per-user
    // surface) and the provider id so a later sweep can re-anchor the thread.
    const crumbs = store.rows("agent_events").filter((e) => e.kind === "outbound-log-failed");
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({
      user_email: SENDER,
      to_number: SHOP,
      vendor_id: "v1",
      vendor_name: "Shop",
    });
    expect(String(crumbs[0].detail)).toContain("3EB0ABCDEF");
  });

  it("a one-off blip is healed by the retry: the anchor lands and nothing is breadcrumbed", async () => {
    const { recordOutboundAnchor } = await import("./outbox-lifecycle");
    fail.whatsappMessagesInsertsToFail = 1;
    const ok = await recordOutboundAnchor(anchorRow(), who);
    expect(ok).toBe(true);
    expect(store.rows("whatsapp_messages")).toHaveLength(1);
    expect(store.rows("whatsapp_messages")[0].wa_message_id).toBe("3EB0ABCDEF");
    expect(store.rows("agent_events").filter((e) => e.kind === "outbound-log-failed")).toHaveLength(0);
  });

  it("the common case costs exactly one insert - nothing extra on the hot loop", async () => {
    const { recordOutboundAnchor } = await import("./outbox-lifecycle");
    const ok = await recordOutboundAnchor(anchorRow(), who);
    expect(ok).toBe(true);
    expect(store.log.filter((w) => w.op === "insert" && w.table === "whatsapp_messages")).toHaveLength(1);
    expect(store.rows("agent_events")).toHaveLength(0);
  });
});

describe("every delivered-send path reads the anchor result (the drain first)", () => {
  /** The block between a delivered send and the retire / ledger stamp. */
  const deliveredBlock = (code: string, from: string, to: string) => {
    const start = code.indexOf(from);
    expect(start, `missing "${from}"`).toBeGreaterThan(-1);
    const end = code.indexOf(to, start);
    expect(end, `missing "${to}" after "${from}"`).toBeGreaterThan(start);
    return code.slice(start, end);
  };

  it("the drain: recordOutboundAnchor BEFORE completeOutboxRow, and no bare insert", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    const block = deliveredBlock(guard, "await afterSend(row.sender_key, row.to_number);", "await completeOutboxRow(row.id);");
    // THE ASSERTION THAT FAILED BEFORE: the drain wrote the anchor with a bare
    // `await sbInsert("whatsapp_messages", ...)` and never read the boolean.
    expect(block).toMatch(/await recordOutboundAnchor\(/);
    expect(block).not.toMatch(/await sbInsert\(\s*"whatsapp_messages"/);
    // The retire ordering is unchanged: the anchor attempt, THEN the retire,
    // unconditionally - a delivered row is never left pending for a second
    // drain to send again.
    expect(guard).toMatch(/await recordOutboundAnchor\([\s\S]{0,3000}?await completeOutboxRow\(row\.id\);/);
  });

  it("the mass route reads it too", () => {
    const mass = readCode("src/app/api/outreach/mass/route.ts");
    const block = deliveredBlock(mass, "await afterSend(session.email, digits);", '"contacted",');
    expect(block).toMatch(/await recordOutboundAnchor\(/);
    expect(block).not.toMatch(/await sbInsert\(\s*"whatsapp_messages"/);
  });

  it("the price re-check reads it too", () => {
    const recheck = readCode("src/app/api/deals/recheck/route.ts");
    const block = deliveredBlock(recheck, "await afterSend(session.email, digits);", 'state: "sent"');
    expect(block).toMatch(/await recordOutboundAnchor\(/);
    expect(block).not.toMatch(/await sbInsert\(\s*"whatsapp_messages"/);
  });

  it("the single-shop route keeps its own honest check", () => {
    const single = readCode("src/app/api/outreach/route.ts");
    expect(single).toMatch(/const wroteLog = await sbInsert\("whatsapp_messages"/);
    expect(single).toMatch(/if \(!wroteLog\) \{/);
  });
});
