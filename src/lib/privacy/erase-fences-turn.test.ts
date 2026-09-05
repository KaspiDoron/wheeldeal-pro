import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// AUDIT F050: ERASE FENCED NOTHING BUT THE WEBHOOK - AN IN-FLIGHT TURN
// RE-CREATED ROWS UNDER THE DELETED EMAIL.
//
// eraseUserData severs the WhatsApp link (so no NEW frames arrive), revokes
// sessions, walks the registry and deletes app_users. A negotiation turn that
// was already running - or that a sweep started moments later - never asked
// whether the account it acts for still exists: it went on to stamp
// reputation, store the inbound copy, write vendor_replies / offers / events
// and SEND, all keyed to the erased email, after the walker had reported
// "every trace gone". A blocked account was the same: the block gated cookies,
// never the agent answering shops on the person's behalf.
//
// Executed twice over: the fence itself against a Map-backed store, and the
// REAL processVendorReply against the same store with the account row gone -
// the turn must stop before its first write and leave nothing but its
// released leases behind.

vi.mock("../runtime-config", async () => {
  const h = await import("./postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "./postgrest-store.test-helper";
import { accountTurnFence } from "./turn-fence";
import { processVendorReply } from "../agent-loop";

const EMAIL = "traveller@example.com";
const SHOP = "66812345678";
const T0 = Date.parse("2026-09-04T09:00:00.000Z");

/** Leases a turn takes and hands back; every other table is a real write. */
const LEASE_TABLES = new Set(["wa_processed", "wa_send_claims", "wa_thread_locks", "wa_inbound_seen"]);

function seedThread() {
  store.seed("whatsapp_messages", [
    {
      id: 1,
      wa_message_id: "OUT-1",
      direction: "outbound",
      from_number: "wd-instance",
      to_number: SHOP,
      body: "Hi, do you have an automatic scooter for 3 days?",
      received_at: new Date(T0 - 3_600_000).toISOString(),
      raw: {
        sender: EMAIL,
        vendorId: "v-samui-1",
        vendorName: "Samui Scooter Rent",
        kind: "rfq",
        region: "TH",
        rfq: {
          vehicleClass: "scooter",
          transmission: "automatic",
          durationDays: 3,
          accessories: [],
          fulfillment: "any",
        },
      },
    },
  ]);
}

beforeEach(() => {
  store.reset();
  (globalThis as { __wheeldeal_users_v2__?: Map<string, unknown> }).__wheeldeal_users_v2__ = new Map();
  // No network: any model or provider call fails fast instead of hanging.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in test");
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("EXECUTED (F050): the fence reads the account the turn acts for", () => {
  it("a POSITIVE 'row is gone' answer is erased", async () => {
    expect(await accountTurnFence(EMAIL, Date.now())).toBe("erased");
  });

  it("a blocked account is blocked", async () => {
    store.seed("app_users", [{ email: EMAIL, status: "blocked", sessions_valid_from: null }]);
    expect(await accountTurnFence(EMAIL, Date.now())).toBe("blocked");
  });

  it("a revocation that landed AFTER the turn began is revoked; one before it is not", async () => {
    const started = T0;
    store.seed("app_users", [
      { email: EMAIL, status: "active", sessions_valid_from: new Date(T0 + 2_000).toISOString() },
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 5_000);
    expect(await accountTurnFence(EMAIL, started)).toBe("revoked");
    store.tables.set("app_users", [
      { email: EMAIL, status: "active", sessions_valid_from: new Date(T0 - 2_000).toISOString() },
    ]);
    expect(await accountTurnFence(EMAIL, started)).toBeNull();
  });

  it("a live account, an outage, an un-migrated table and no email all fail OPEN", async () => {
    store.seed("app_users", [{ email: EMAIL, status: "active", sessions_valid_from: null }]);
    expect(await accountTurnFence(EMAIL, Date.now())).toBeNull();
    store.unavailable.add("app_users");
    expect(await accountTurnFence(EMAIL, Date.now())).toBeNull();
    store.unavailable.delete("app_users");
    store.missing.add("app_users");
    expect(await accountTurnFence(EMAIL, Date.now())).toBeNull();
    store.missing.delete("app_users");
    expect(await accountTurnFence(undefined, Date.now())).toBeNull();
  });
});

describe("EXECUTED (F050): a turn for an erased account writes nothing and sends nothing", () => {
  it("processVendorReply stops before its first write when the app_users row is gone", async () => {
    seedThread();
    const send = vi.fn(async () => ({ ok: true as const, id: "x" }));

    await processVendorReply({
      fromDigits: SHOP,
      text: "Yes we have, 300 baht per day",
      waMessageId: "IN-1",
      senderEmail: EMAIL,
      remoteJid: `${SHOP}@s.whatsapp.net`,
      send: send as unknown as Parameters<typeof processVendorReply>[0]["send"],
    }).catch(() => {});

    expect(send).not.toHaveBeenCalled();
    // THE ASSERTION THAT FAILED BEFORE: the turn had already stamped the
    // sender's reputation (and went on from there) for an account that no
    // longer existed.
    const writes = store.log
      .filter((l) => l.op !== "delete" && !LEASE_TABLES.has(l.table))
      .map((l) => `${l.op}:${l.table}`);
    expect(writes).toEqual([]);
    expect(store.rows("whatsapp_number_reputation")).toEqual([]);
    expect(store.rows("whatsapp_messages")).toHaveLength(1); // only our own anchor
    // The message lease went back so a redelivery is not silently eaten.
    expect(store.rows("wa_processed")).toEqual([]);
  }, 30_000);
});

describe("the fence stands at both points where the turn's writes begin", () => {
  const loop = readFileSync(join(process.cwd(), "src/lib/agent-loop.ts"), "utf8");

  it("before the first write (reputation + the inbound copy) and again before the engine composes and sends", () => {
    // One read, through the helper, at each checkpoint.
    expect(loop.match(/accountTurnFence\(/g) ?? []).toHaveLength(1);
    const checkpoints = loop.match(/if \(await fenced\(\)\) return;/g) ?? [];
    expect(checkpoints).toHaveLength(2);
    const first = loop.indexOf("if (await fenced()) return;");
    const reputation = loop.indexOf("await recordInboundEngagement(ctx.sender, from)");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(reputation);
    const second = loop.indexOf("if (await fenced()) return;", first + 1);
    const engine = loop.indexOf("THE DIGRAPH NEGOTIATION ENGINE");
    expect(second).toBeLessThan(engine);
    expect(second).toBeGreaterThan(reputation);
  });

  it("an erased or revoked account leaves NO breadcrumb keyed to the person", () => {
    // Only the blocked case may trace (the account still exists to own it).
    const block = loop.slice(loop.indexOf("function fenced("), loop.indexOf("function fenced(") + 1200);
    expect(block).toMatch(/if \(fence === "blocked"\)/);
    expect(block).toMatch(/"account-blocked"/);
    expect(block).not.toMatch(/"account-erased"|"account-revoked"/);
  });
});
