// AUDIT F063 - the recovery sweep's 8s budget has to be REAL.
//
// syncInboundReplies advertises RUN_BUDGET_MS = 8s because it runs inside the
// traveller's /api/replies poll and inside the one-minute cron. The deadline
// was tested exactly once, at the top of the per-THREAD loop, while the inner
// loop over the recovered messages called processVendorReply - a full 72s-wall
// AI turn - with no deadline at all. One thread with four unanswered shop
// messages therefore ran four sequential turns after passing a single 8s
// check: the ping (which has already spent up to 50s draining) blew Cloud
// Run's 90s kill, its end-of-run heartbeat was never written, and the rest of
// that minute's senders were never swept.
//
// This test EXECUTES the sweep with turns that consume real budget.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const SHOP = "66812340001";
const TURN_MS = 30_000; // a heavy but perfectly ordinary inbound turn
const turns: string[] = [];
let now = 1_800_000_000_000;

const message = (n: number) => ({
  id: `MSG-${n}`,
  text: `price for the scooter, message ${n}`,
  hasImage: false,
  fromMe: false,
  remoteJid: `${SHOP}@s.whatsapp.net`,
  // Old enough to clear the 10s webhook head start, young enough for the window.
  ts: Math.floor((now - 120_000) / 1000),
  record: { key: { id: `MSG-${n}` } },
});

vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string, query: string) =>
    table === "whatsapp_messages" && query.includes("direction=eq.outbound")
      ? [{ to_number: SHOP, raw: { sender: "traveller@example.com" } }]
      : [],
  sbSelectStrict: async () => ({ rows: [] as unknown[] }),
  sbInsert: async () => true,
  sbUpdate: async () => true,
  sbDelete: async () => true,
  getConfig: async () => undefined,
}));
vi.mock("../evolution", () => ({
  resolveChatJid: async (_e: string, digits: string) => `${digits}@s.whatsapp.net`,
  fetchMessagesRaw: async () => [1, 2, 3, 4].map(message),
  fetchMediaBase64: async () => null,
  sendFromUser: async () => ({ ok: true }),
}));
vi.mock("../agent-loop", () => ({
  processVendorReply: async (o: { waMessageId?: string }) => {
    turns.push(String(o.waMessageId));
    // A turn is not free: it burns wall clock the caller advertised as 8s.
    vi.advanceTimersByTime(TURN_MS);
    return {};
  },
}));
vi.mock("../drill", () => ({ isVendorThread: async () => true }));
vi.mock("./inbound-claim", () => ({
  claimInboundStore: async () => true,
  claimIsDeadTurn: () => false,
  claimKey: (email: string, id: string) => `${email}:${id}`,
  quotedInList: (ids: string[]) => ids.map((i) => `"${i}"`).join(","),
}));
vi.mock("../funnel/stages", () => ({ advanceThreadStage: async () => null }));

import { syncInboundReplies } from "../wa-sync";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  turns.length = 0;
  (globalThis as { __wd_wa_sync__?: Map<string, number> }).__wd_wa_sync__ = new Map();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the recovery sweep honours its own budget inside a thread", () => {
  it("stops taking new turns once the run budget is spent", async () => {
    const startedAt = Date.now();
    await syncInboundReplies("traveller@example.com");
    const elapsed = Date.now() - startedAt;
    // A turn already under way is never cut short - the fix is that the NEXT
    // one is not started. Four unanswered messages must not become four turns.
    expect(
      turns.length,
      `the sweep ran ${turns.length} sequential turns inside an 8s budget`
    ).toBe(1);
    expect(elapsed, "one sweep must not outrun the ping invocation").toBeLessThanOrEqual(
      TURN_MS + 8_000
    );
  });

  it("takes a caller-supplied deadline (the cron's remaining invocation)", async () => {
    // The ping has already spent up to 50s draining before it sweeps, so the
    // budget it can honestly offer is what is LEFT of its own invocation.
    await syncInboundReplies("traveller@example.com", { deadlineAt: Date.now() - 1 });
    expect(turns.length, "a spent deadline must not start a 72s-wall turn").toBe(0);
  });
});
