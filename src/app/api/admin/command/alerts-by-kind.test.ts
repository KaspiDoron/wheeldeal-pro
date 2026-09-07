import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F078: THE COMMAND CENTER READ THE 30 NEWEST agent_events OF ANY KIND,
// SO cron-ping STARVED THE BAN-RISK AND FUNNEL-GAP ALERTS.
//
// Both the critical `wa-ban-risk` alert and the `vague-reply` funnel-gap
// warning were JS filters over ONE unfiltered read capped at
// `order=created_at.desc&limit=30`. Two per-minute schedulers each write a
// `cron-ping` row on every successful ping, so that window covered about
// fifteen minutes of pings and nothing else: a number that tripped ban
// recovery at 10:00 had no "ban-risk event" alert by 10:15, and the
// vague-reply warning - rarer than pings by orders of magnitude - could
// never fire at all. The `handled=eq.false` predicate on the same read
// filtered nothing: nothing in src/ or supabase/ ever writes handled=true.
//
// Executed against the real route over a Map-backed store that honours the
// query's kind filter, order and limit.

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({ email: "owner@example.com", role: "owner" }),
}));
vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { GET } from "./route";

const NOW = Date.now();
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();

interface Alert {
  level: string;
  title: string;
  detail: string;
}

beforeEach(() => {
  store.reset();
  // One ban-risk row and one vague reply, both twenty minutes old...
  store.seed("agent_events", [
    {
      id: 1,
      kind: "wa-ban-risk",
      vendor_name: null,
      detail: "traveller@example.com: risk 62, entering recovery",
      handled: false,
      created_at: iso(-20 * 60_000),
    },
    {
      id: 2,
      kind: "vague-reply",
      vendor_name: "Sunrise Rentals",
      detail: "depends on the day, come and see",
      handled: false,
      created_at: iso(-21 * 60_000),
    },
  ]);
  // ...buried under fifteen minutes of two-scheduler cron pings (2 per minute).
  store.seed(
    "agent_events",
    Array.from({ length: 30 }, (_, i) => ({
      id: 100 + i,
      kind: "cron-ping",
      vendor_name: null,
      detail: JSON.stringify({ drained: 0, synced: 0, hosts: 1 }),
      handled: false,
      created_at: iso(-(i + 1) * 30_000),
    }))
  );
});

describe("EXECUTED (F078): chatty kinds cannot crowd the alert kinds out of the window", () => {
  it("the ban-risk event still renders as a critical alert under 30 newer cron pings", async () => {
    const j = (await (await GET()).json()) as { alerts: Alert[]; degraded: string[] };
    expect(j.degraded).toEqual([]);
    const ban = j.alerts.find((a) => /ban-risk event/.test(a.title));
    expect(ban?.level).toBe("critical");
    expect(ban?.detail).toMatch(/entering recovery/);
  });

  it("the vague-reply funnel-gap warning renders too", async () => {
    const j = (await (await GET()).json()) as { alerts: Alert[] };
    const vague = j.alerts.find((a) => /vague answer/.test(a.title));
    expect(vague?.level).toBe("warning");
    expect(vague?.detail).toMatch(/Sunrise Rentals/);
  });

  it("an unreadable agent_events still lands in degraded[] - unknown, not zero alerts", async () => {
    store.unavailable.add("agent_events");
    const j = (await (await GET()).json()) as { alerts: Alert[]; degraded: string[] };
    expect(j.degraded).toContain("agent events");
    expect(j.alerts[0].level).toBe("critical");
    expect(j.alerts[0].title).toMatch(/unreadable/);
  });
});
