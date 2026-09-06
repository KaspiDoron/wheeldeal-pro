import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F090: THE HEALTH PANEL'S QUEUE DEPTH READ A CONFIDENT ZERO OVER A DEAD
// STORE, BESIDE TWELVE GUARD COUNTERS THAT CORRECTLY WENT NULL.
//
// The wa_outbox read feeding `queue` was a permissive `sbSelect(...).catch(()
// => [])`, and sbSelect maps a missing connection, a non-2xx and a throw all
// to `[]` - so during an outage the panel rendered "queue 0" with no overdue
// badge at the exact moment nothing could be drained, while `guardCounters`
// in the same response admitted it could not read agent_events. The per-turn
// stamps (`turnLatencyMs`, `providerErrors`) and the push breadcrumbs had the
// identical shape. queueDepth's own pure contract (an empty array IS 0/0/null,
// vitals.test.ts) is untouched: the null is threaded at the route.
//
// Executed against the real route (?probes=cached skips the billed service
// sweep) over a Map-backed store whose tables can be made unavailable.

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({ email: "owner@example.com", role: "owner" }),
}));
vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/corpus/gate", () => ({
  corpusDepth: async () => ({ state: "missing", queued: null, neural: null, lexical: null }),
}));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { GET } from "./route";

const NOW = Date.now();
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();

interface Body {
  queue: { waiting: number; overdue: number; oldestOverdueMs: number | null } | null;
  queueUnreadable: boolean;
  turnLatencyMs: { p50: number | null; p95: number | null; samples: number } | null;
  providerErrors: { degraded: number; total: number } | null;
  push24h: { sent: number; failed: number } | null;
  turnsUnreadable: boolean;
  pushUnreadable: boolean;
  guardCountersUnreadable: boolean;
}

const read = async () =>
  (await (await GET(new Request("http://local/api/admin/health?probes=cached"))).json()) as Body;

beforeEach(() => {
  store.reset();
  store.seed("wa_outbox", [
    { id: 1, not_before: iso(-45 * 60_000) },
    { id: 2, not_before: iso(+5 * 60_000) },
  ]);
  store.seed("agent_events", [
    { id: 1, kind: "engine-v3-turn", created_at: iso(-60_000), detail: JSON.stringify({ latencyMs: 1200 }) },
    { id: 2, kind: "push-sent", created_at: iso(-60_000), detail: "{}" },
  ]);
});

describe("EXECUTED (F090): an unreadable outbox is UNKNOWN, never an empty queue", () => {
  it("a readable store reports the real depth", async () => {
    const b = await read();
    expect(b.queueUnreadable).toBe(false);
    expect(b.queue).toEqual({ waiting: 2, overdue: 1, oldestOverdueMs: expect.any(Number) });
    expect(b.turnLatencyMs?.samples).toBe(1);
    expect(b.push24h?.sent).toBe(1);
  });

  it("wa_outbox unavailable -> queue is null and flagged, not {waiting: 0}", async () => {
    store.unavailable.add("wa_outbox");
    const b = await read();
    expect(b.queueUnreadable).toBe(true);
    expect(b.queue).toBeNull();
    // The other vitals were readable and stay so.
    expect(b.turnsUnreadable).toBe(false);
    expect(b.turnLatencyMs?.samples).toBe(1);
  });

  it("agent_events unavailable -> latency, provider errors and push breadcrumbs are null, in step with the guard counters", async () => {
    store.unavailable.add("agent_events");
    const b = await read();
    expect(b.guardCountersUnreadable).toBe(true);
    expect(b.turnsUnreadable).toBe(true);
    expect(b.pushUnreadable).toBe(true);
    expect(b.turnLatencyMs).toBeNull();
    expect(b.providerErrors).toBeNull();
    expect(b.push24h).toBeNull();
    // ...while the queue, whose table was readable, still reports its depth.
    expect(b.queue?.waiting).toBe(2);
  });

  it("a never-migrated wa_outbox is a real zero (no row can exist), not unreadable", async () => {
    store.missing.add("wa_outbox");
    const b = await read();
    expect(b.queueUnreadable).toBe(false);
    expect(b.queue).toEqual({ waiting: 0, overdue: 0, oldestOverdueMs: null });
  });
});
