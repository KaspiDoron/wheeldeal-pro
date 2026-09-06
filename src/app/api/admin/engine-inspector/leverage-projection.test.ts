import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F087: leverageUsePct WAS FED A PROJECTION THAT DROPPED rivals AND
// citedRival, SO THE LEVERAGE KPI WAS PERMANENTLY DEAD.
//
// `statTurns` projected only at/move/provider/latencyMs out of the parsed
// turn detail, then was CAST to a type claiming rivals and citedRival. The
// filter in leverageUsePct requires `(t.rivals ?? 0) > 0`, so every row failed
// it and the tile rendered "-" with the sub-caption "no rival yet" on every
// deployment - including sessions where the live engine stamped rivals:2,
// citedRival:true on the bargain it wrote. Executed against the real route
// over a Map-backed store holding exactly such turns.

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({
    email: "owner@example.com",
    role: "owner",
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

function turn(detail: Record<string, unknown>, minutes: number) {
  return {
    kind: "engine-v3-turn",
    vendor_name: "Sunrise Rentals",
    detail: JSON.stringify({ tier: "fast", provider: "x", latencyMs: 900, ...detail }),
    created_at: minutesAgo(minutes),
  };
}

beforeEach(() => {
  store.reset();
  store.seed("agent_events", [
    // Two bargains with a rival on the table: one cited it on the wire, one did not.
    turn({ move: "bargain", rivals: 2, citedRival: true }, 5),
    turn({ move: "bargain", rivals: 2, citedRival: false }, 15),
    // A bargain with no rival is not an opportunity, and a present is not a bargain.
    turn({ move: "bargain", rivals: 0, citedRival: false }, 25),
    turn({ move: "present", rivals: 2, citedRival: false }, 35),
  ]);
});

describe("EXECUTED (F087): the leverage KPI sees the rivals the engine stamped", () => {
  it("two opportunities, one used - 50%, not a dead dash", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      operations: { leverageUsePct: number | null; leverageOpportunities: number };
    };
    // THE ASSERTIONS THAT FAILED BEFORE: null and 0.
    expect(snap.operations.leverageOpportunities).toBe(2);
    expect(snap.operations.leverageUsePct).toBe(50);
  });
});
