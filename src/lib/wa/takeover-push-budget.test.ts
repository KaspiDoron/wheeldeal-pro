// AUDIT F040 - the human-takeover push must be BUDGETED, like every other
// after-work push in the webhook.
//
// The takeover branch stands the agents down destructively (a human-manual row
// is written, the thread is flagged, every queued wa_outbox row and the
// graph_wakeups tick for that shop are deleted) and only THEN notifies the
// traveller. That notification used to be a bare `await sendPushToUser(...)`,
// the one push in this file outside finishBeforeResponse - and web-push's
// sendNotification carried no timeout, so a push endpoint that completes TLS
// and then never answers held the whole webhook open until Cloud Run killed it
// at 90s: the rest of the batch was never ingested, the deferred shop-replied
// pushes and the anti-ban read receipts never fired, and Evolution recorded a
// failed delivery for a message the app had already acted on.
//
// These tests EXECUTE processEvolutionWebhook with a push that never answers.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const inserts: Array<{ table: string; rows: any[] }> = [];
const deletes: string[] = [];
const calls: string[] = [];
let pushResolve: (() => void) | null = null;

vi.mock("@/lib/runtime-config", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async () => undefined,
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: [] as unknown[] }),
  sbInsert: async (table: string, rows: any[]) => {
    inserts.push({ table, rows });
    return true;
  },
  sbUpdate: async () => true,
  sbDelete: async (table: string) => {
    deletes.push(table);
    return true;
  },
}));

vi.mock("@/lib/evolution", () => ({
  resolveInstanceEmail: async () => ({ ok: true, email: "traveller@example.com" }),
  emailForInstance: async () => "traveller@example.com",
  sendFromUser: async () => ({ ok: true }),
  markMessageAsRead: async () => true,
  readReceiptDelayMs: () => 0,
  pauseIdleSessions: async () => 0,
  notePairingRotation: async () => {},
}));
vi.mock("@/lib/agent-loop", () => ({ processVendorReply: async () => ({}) }));
vi.mock("@/lib/drill", () => ({ isVendorThread: async () => true }));
vi.mock("@/lib/wa/lid-alias", () => ({
  resolveChatIdentity: async () => ({ phone: "66812345678", lid: "" }),
  rememberAlias: () => {},
  lidAliasForShop: async () => "",
}));
vi.mock("@/lib/wa/inbound-claim", () => ({
  claimInboundStore: async () => true,
  claimIsDeadTurn: () => false,
  claimKey: (email: string, id: string) => `${email}:${id}`,
  quotedInList: (ids: string[]) => ids.join(","),
}));
vi.mock("@/lib/wa/kick", () => ({ kickDispatcher: async () => true }));
vi.mock("@/lib/events", () => ({ insertUserEvent: async () => true }));
vi.mock("@/lib/wa-guard", () => ({ drainOutbox: async () => 0 }));
vi.mock("@/lib/graph/engine", () => ({ drainGraphWakeups: async () => 0 }));
vi.mock("@/lib/session-flags", () => ({
  setThreadTakeover: async () => {
    calls.push("setThreadTakeover");
    return true;
  },
  isThreadTakenOver: async () => false,
}));
vi.mock("@/lib/notify/significance", () => ({
  worthAnInterruption: () => ({ notify: true, reason: "handover" }),
}));
vi.mock("@/lib/notify/state", () => ({
  notifyState: async () => ({ anyReplyYet: true, pushesInWindow: 0 }),
  markPushSent: async (_e: string, reason: string) => {
    calls.push(`markPushSent:${reason}`);
  },
}));
// THE DEAD ENDPOINT: a push service that completes its handshake and then
// never answers. Nothing in the promise ever resolves on its own.
vi.mock("@/lib/push", () => ({
  sendPushToUser: () =>
    new Promise((resolve) => {
      calls.push("sendPushToUser");
      pushResolve = () => resolve({ attempted: 1, delivered: 0, pruned: 0, results: [] });
    }),
}));

import { processEvolutionWebhook } from "./ingest";

const payload = {
  event: "messages.upsert",
  instance: "wd-traveller",
  data: {
    key: { remoteJid: "66812345678@s.whatsapp.net", fromMe: true, id: "MSG-TAKEOVER-1" },
    message: { conversation: "hi, I will come by at 5pm to look at the bike" },
    messageTimestamp: Math.floor(Date.now() / 1000),
  },
};

beforeEach(() => {
  inserts.length = 0;
  deletes.length = 0;
  calls.length = 0;
  pushResolve = null;
});
afterEach(() => {
  pushResolve?.();
});

/** Real timers on purpose: the after-work budget is a real setTimeout, and the
 *  path under test does real dynamic imports between the store calls. The
 *  sentinel turns "never returns" into a readable assertion instead of a
 *  vitest timeout. */
const SENTINEL_MS = 20_000;
async function webhookOutcome(): Promise<"returned" | "held open"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const held = new Promise<"held open">((r) => {
    timer = setTimeout(() => r("held open"), SENTINEL_MS);
  });
  try {
    return await Promise.race([processEvolutionWebhook(payload).then(() => "returned" as const), held]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("the human-takeover push cannot hold the webhook open", () => {
  it(
    "returns inside the after-work budget when the push service never answers",
    async () => {
      const outcome = await webhookOutcome();
      // The stand-down is destructive and already done by the time the push is
      // attempted, so holding the request open loses the rest of the batch for
      // a message the app has ALREADY acted on.
      expect(inserts.some((i) => i.table === "whatsapp_messages")).toBe(true);
      expect(deletes).toContain("wa_outbox");
      expect(deletes).toContain("graph_wakeups");
      expect(calls).toContain("sendPushToUser");
      expect(calls.indexOf("setThreadTakeover")).toBeLessThan(calls.indexOf("sendPushToUser"));
      expect(outcome, "an unanswering push must not hold the Evolution webhook open").toBe(
        "returned"
      );
      // The 4-per-window ceiling accounting must survive the stall - inside the
      // race it was skipped exactly when the push was slowest, so the next
      // notification went out as if none had been sent.
      expect(calls.some((c) => c.startsWith("markPushSent:"))).toBe(true);
    },
    40_000
  );
});
