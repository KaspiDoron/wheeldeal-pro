import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F250: THE TWO BUSIEST POLLS RACED drainOutbox AGAINST 3s BUT NEVER
// PASSED budgetMs, SO THE DRAIN RAN ON DETACHED TO ITS 45s DEFAULT.
//
// /api/replies and /api/activity wrap their opportunistic drains in a 3s
// Promise.race and answer at 3s - but a race does not cancel. Without
// `budgetMs` the loser kept running to `Date.now() + 45_000` (wa-guard's
// default deadline), and on Cloud Run the CPU is throttled to ~0 the instant
// the response flushes, so the detached drain froze mid-loop holding a
// claimOutboxRow lease. That row read as "sending" to the cron and the reply
// tick for the full 3-minute CLAIM_LEASE_MS. Which of the three sibling polls
// happened to own the drain slot decided whether a shop's answer went out in
// seconds or minutes. The wakeup drain had the same shape on all three, and
// its lease is 5 minutes.
//
// The refuter's concern: drainOutbox floors its budget at 5_000, so a literal
// 3_000 (wa/status) still ran 2s detached. The budget the polls pass is the
// floor itself, and a DrainWakeupOptions.budgetMs now exists so the wakeup
// drain can stop taking rows too.
//
// EXECUTED against the real GET handlers: every drain is recorded at the
// module boundary, the store is the Map-backed PostgREST stand-in, and the
// assertions read the options each route actually handed its drains.

const rec = vi.hoisted(() => ({
  outbox: [] as { opts: unknown }[],
  wakeups: [] as { opts: unknown }[],
}));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "traveller@example.com", plan: "pro" }),
}));
vi.mock("@/lib/wa/drain-owner", () => ({
  claimDrainSlot: () => true,
  resetDrainSlots: () => {},
  DRAIN_OWNER_INTERVAL_MS: 20_000,
}));
vi.mock("@/lib/wa-sync", () => ({ syncInboundReplies: async () => {} }));
vi.mock("@/lib/wa-guard", () => ({
  drainOutbox: async (_send: unknown, opts: unknown) => {
    rec.outbox.push({ opts });
    return 0;
  },
  afterSend: async () => {},
  senderSafety: async () => null,
  REPLY_KIND_FILTER: "",
}));
vi.mock("@/lib/graph/engine", () => ({
  drainGraphWakeups: async (_send: unknown, opts: unknown) => {
    rec.wakeups.push({ opts });
    return 0;
  },
}));
vi.mock("@/lib/evolution", () => ({
  sendFromUser: async () => ({ ok: true, messageId: "3EB0" }),
  evolutionConfigured: async () => true,
  connectionState: async () => "open",
  isLinkedForUi: async () => true,
  touchActivity: async () => {},
  markOpen: async () => {},
  webhookToken: async () => null,
}));

import { store } from "@/lib/privacy/postgrest-store.test-helper";

const EMAIL = "traveller@example.com";
// drainOutbox's own floor (wa-guard: Math.max(5_000, opts?.budgetMs ?? 45_000)).
const DRAIN_FLOOR_MS = 5_000;
// wave1-scope pins the poll race at <= 8s; a budget past that is the 45s
// default creeping back under a different name.
const RACE_CEILING_MS = 8_000;

beforeEach(() => {
  store.reset();
  rec.outbox.length = 0;
  rec.wakeups.length = 0;
});

type Opts = { senderKey?: string; userEmail?: string; budgetMs?: number } | undefined;

const routes: { name: string; run: () => Promise<Response> }[] = [
  {
    name: "/api/replies",
    run: async () => {
      const { GET } = await import("@/app/api/replies/route");
      return GET(new Request("http://localhost/api/replies?vclass=scooter"));
    },
  },
  {
    name: "/api/activity",
    run: async () => {
      const { GET } = await import("@/app/api/activity/route");
      return GET(new Request("http://localhost/api/activity"));
    },
  },
  {
    name: "/api/wa/status",
    run: async () => {
      const { GET } = await import("@/app/api/wa/status/route");
      return GET(new Request("http://localhost/api/wa/status"));
    },
  },
];

describe("EXECUTED (F250): every opportunistic poll drain carries its own deadline", () => {
  for (const r of routes) {
    it(`${r.name} passes a scoped, floor-or-better budgetMs to BOTH drains`, async () => {
      const res = await r.run();
      expect(res.status).toBe(200);

      expect(rec.outbox, `${r.name} did not drain the outbox`).toHaveLength(1);
      const outbox = rec.outbox[0].opts as Opts;
      expect(outbox?.senderKey).toBe(EMAIL);
      // THE ASSERTION THAT FAILED BEFORE: no budgetMs at all (replies,
      // activity), or a 3_000 that wa-guard silently floors to 5_000 (status).
      expect(outbox?.budgetMs, `${r.name} drainOutbox budgetMs`).toBeGreaterThanOrEqual(
        DRAIN_FLOOR_MS
      );
      expect(outbox?.budgetMs).toBeLessThanOrEqual(RACE_CEILING_MS);

      expect(rec.wakeups, `${r.name} did not drain wakeups`).toHaveLength(1);
      const wakeups = rec.wakeups[0].opts as Opts;
      expect(wakeups?.userEmail).toBe(EMAIL);
      expect(wakeups?.budgetMs, `${r.name} drainGraphWakeups budgetMs`).toBeGreaterThanOrEqual(
        DRAIN_FLOOR_MS
      );
      expect(wakeups?.budgetMs).toBeLessThanOrEqual(RACE_CEILING_MS);
    });
  }
});
