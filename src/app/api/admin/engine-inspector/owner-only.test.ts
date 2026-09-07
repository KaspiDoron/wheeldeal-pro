import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F086 (D4): THE ENGINE INSPECTOR SAID "OWNER-ONLY" IN ITS DOCBLOCK,
// GATED requireManagement, AND SPREAD THE WIRE TEXT AND THE MODEL SCRATCHPAD
// OF EVERY USER'S TURNS.
//
// `{ shop, at, ...d }` spread the whole parsed engine-v3-turn detail, which
// the live engine stamps with `think` (180 chars of scratchpad) and `text`
// (180 chars of the outbound WhatsApp message) on every turn, for every user;
// failoverDetail / dropped / graphTurns shipped 300 chars of raw event detail
// (shop numbers, sender emails). The same admin is refused whatsapp_messages
// by admin/data. Management keeps every metric the tiles and charts read (a
// number is not a transcript); the words cross the owner line only. Executed
// against the real route over a Map-backed store.

const session: { role: "admin" | "owner" } = { role: "admin" };

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({
    email: "someone@example.com",
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

const THINK = "they anchored at 300, the rival is at 250 so ask 240 and offer 5 days";
const TEXT = "Hi! Another shop quoted 250/day for the same bike - can you do 240?";
const FAILOVER = "SPTE failover -> graph engine (inbound): TypeError at composeReply";
const DROP = JSON.stringify({ reason: "duplicate", digits: "66812345678" });

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  store.reset();
  session.role = "admin";
  store.seed("agent_events", [
    {
      kind: "engine-v3-turn",
      vendor_name: "Sunrise Rentals",
      detail: JSON.stringify({
        move: "bargain",
        tier: "fast",
        provider: "x",
        think: THINK,
        text: TEXT,
        quote: 300,
        floor: 235,
        rivals: 1,
        latencyMs: 1200,
        delivered: "sent",
      }),
      created_at: minutesAgo(5),
    },
    { kind: "engine-v3-fallback", vendor_name: "Sunrise Rentals", detail: FAILOVER, created_at: minutesAgo(9) },
    { kind: "send-dropped", vendor_name: "66812345678", detail: DROP, created_at: minutesAgo(12) },
  ]);
});

type Snap = {
  turns: Array<Record<string, unknown>>;
  stats: {
    failoverDetail: Array<{ shop: string; at: string; detail: string | null }>;
    dropped: Array<{ shop: string; at: string; kind: string; detail: string | null }>;
  };
};

describe("EXECUTED (F086): the turn stream keeps its metrics and withholds the words", () => {
  it("a non-owner admin receives no scratchpad, no wire text and no raw event detail", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const raw = await res.text();
    // THE ASSERTIONS THAT FAILED BEFORE.
    expect(raw).not.toContain(THINK);
    expect(raw).not.toContain(TEXT);
    expect(raw).not.toContain("TypeError at composeReply");
    expect(raw).not.toContain("66812345678");
    const snap = JSON.parse(raw) as Snap;
    // Every metric the tiles and charts read is still there.
    expect(snap.turns).toHaveLength(1);
    expect(snap.turns[0].move).toBe("bargain");
    expect(snap.turns[0].quote).toBe(300);
    expect(snap.turns[0].floor).toBe(235);
    expect(snap.turns[0].latencyMs).toBe(1200);
    expect(snap.turns[0].shop).toBe("Sunrise Rentals");
    expect(snap.turns[0]).not.toHaveProperty("think");
    expect(snap.turns[0]).not.toHaveProperty("text");
    expect(snap.stats.failoverDetail).toHaveLength(1);
    expect(snap.stats.failoverDetail[0].shop).toBe("Sunrise Rentals");
    expect(snap.stats.failoverDetail[0].detail).toBeNull();
    expect(snap.stats.dropped).toHaveLength(1);
    expect(snap.stats.dropped[0].kind).toBe("send-dropped");
    expect(snap.stats.dropped[0].detail).toBeNull();
  });

  it("the owner still reads the scratchpad, the wire text and the failover cause", async () => {
    session.role = "owner";
    const res = await GET();
    const raw = await res.text();
    expect(raw).toContain(THINK);
    expect(raw).toContain(TEXT);
    const snap = JSON.parse(raw) as Snap;
    expect(snap.turns[0].think).toBe(THINK);
    expect(snap.turns[0].text).toBe(TEXT);
    expect(snap.stats.failoverDetail[0].detail).toBe(FAILOVER);
    expect(snap.stats.dropped[0].detail).toBe(DROP);
  });
});
