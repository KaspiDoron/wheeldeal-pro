import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F086 (C4): THE FAILOVER AND DROPPED-SEND COUNTERS SHARED ONE 60-ROW
// NEWEST-FIRST BUDGET WITH THE TURN STREAM, SO THEY READ ZERO UNDER LOAD.
//
// One `order=created_at.desc&limit=60` read over six event kinds fed four
// statistics. With more than 60 engine-v3-turn rows in the 6h window the
// newest 60 rows were all turns, so failoversLast6h, unconfirmedSendsLast6h,
// `dropped` and `graphTurns` all read zero/empty while turnsLast6h - an exact
// HEAD count - said 200. The panel then claimed the primary engine never
// failed over on the busiest window of the beta. Same starvation the health
// route documents and fixed for its twelve guard counters. Executed against
// the real route over a Map-backed store.

const session: { role: "admin" | "owner" } = { role: "owner" };

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({
    email: "owner@example.com",
    role: session.role,
    plan: "ultra",
    issuedAt: 0,
  }),
}));

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { GET } from "./route";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function turn(i: number) {
  return {
    kind: "engine-v3-turn",
    vendor_name: `Shop ${i}`,
    detail: JSON.stringify({ move: "bargain", provider: "x", latencyMs: 10 }),
    created_at: minutesAgo(i),
  };
}
function rare(kind: string, minutes: number, detail: string) {
  return { kind, vendor_name: "Sunrise Rentals", detail, created_at: minutesAgo(minutes) };
}

beforeEach(() => {
  store.reset();
  session.role = "owner";
});

async function snapshot() {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as {
    turns: unknown[];
    stats: {
      turnsLast6h: number | null;
      failoversLast6h: number | null;
      unconfirmedSendsLast6h: number | null;
      failoverDetail: unknown[];
      dropped: unknown[];
      graphTurns: unknown[];
    };
  };
}

describe("EXECUTED (F086): the alarming kinds cannot be starved by the turn stream", () => {
  it("100 newer turns do not push 4 failovers, 2 unconfirmed sends and the drops out of the window", async () => {
    // 100 turns in the last 100 minutes - newer than every alarming row.
    store.seed("agent_events", Array.from({ length: 100 }, (_, i) => turn(i + 1)));
    store.seed("agent_events", [
      rare("engine-v3-fallback", 120, "SPTE failover -> graph engine (inbound): boom"),
      rare("engine-v3-fallback", 121, "SPTE failover -> graph engine (inbound): boom"),
      rare("engine-v3-fallback", 122, "SPTE failover -> graph engine (wakeup): boom"),
      rare("engine-v3-fallback", 123, "SPTE failover -> graph engine (wakeup): boom"),
      rare("send-dropped", 130, JSON.stringify({ reason: "duplicate", digits: "66812345678" })),
      rare("send-dropped", 131, JSON.stringify({ reason: "rfq-dedup", digits: "66812345678" })),
      rare("send-dropped", 132, JSON.stringify({ reason: "engagement-halt", digits: "66812345678" })),
      rare("wa-send-stale", 135, "quote-moved: the shop quoted again"),
      rare("wa-send-unconfirmed", 140, "Sent but WhatsApp returned no delivery receipt"),
      rare("wa-send-unconfirmed", 141, "Sent but WhatsApp returned no delivery receipt"),
      rare("engine-graph-turn", 150, JSON.stringify({ entry: "inbound", why: "spte threw" })),
    ]);

    const snap = await snapshot();
    // The exact count beside them, unchanged.
    expect(snap.stats.turnsLast6h).toBe(100);
    expect(snap.turns.length).toBe(30);
    // THE ASSERTIONS THAT FAILED BEFORE: every one of these read 0 / [].
    expect(snap.stats.failoversLast6h).toBe(4);
    expect(snap.stats.unconfirmedSendsLast6h).toBe(2);
    expect(snap.stats.failoverDetail.length).toBe(4);
    expect(snap.stats.dropped.length).toBe(4); // 3 refused + 1 stale draft
    expect(snap.stats.graphTurns.length).toBe(1);
  });

  it("a storm of one alarming kind does not hide another - the counts stay exact", async () => {
    // 70 unconfirmed sends newer than 4 failovers: more than any single sample
    // window holds, so a count taken by filtering a capped sample would miss
    // the failovers entirely.
    store.seed(
      "agent_events",
      Array.from({ length: 70 }, (_, i) =>
        rare("wa-send-unconfirmed", i + 1, "Sent but WhatsApp returned no delivery receipt")
      )
    );
    store.seed("agent_events", [
      rare("engine-v3-fallback", 200, "SPTE failover -> graph engine (inbound): boom"),
      rare("engine-v3-fallback", 201, "SPTE failover -> graph engine (inbound): boom"),
      rare("engine-v3-fallback", 202, "SPTE failover -> graph engine (inbound): boom"),
      rare("engine-v3-fallback", 203, "SPTE failover -> graph engine (inbound): boom"),
    ]);
    const snap = await snapshot();
    expect(snap.stats.unconfirmedSendsLast6h).toBe(70);
    expect(snap.stats.failoversLast6h).toBe(4);
  });

  it("an unreadable store answers null (a dash), never a confident zero", async () => {
    store.unavailable.add("agent_events");
    const snap = await snapshot();
    expect(snap.stats.turnsLast6h).toBeNull();
    expect(snap.stats.failoversLast6h).toBeNull();
    expect(snap.stats.unconfirmedSendsLast6h).toBeNull();
  });
});
