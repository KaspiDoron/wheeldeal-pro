// AUDIT F054 - a refused or unpersisted booking lifecycle tap must never
// render as the new status on Trips.
//
// The tap posts PATCH /api/bookings and then painted the card with the action
// it just sent whenever the answer carried no status string - so a 401, a 502
// and an outage-shaped `{ok:false,status:null}` all read as "Trip completed"
// while bookings.status was still `confirmed`, the booking-stage event was
// never written and advanceThreadStage never joined the booking to the funnel.
//
// Three halves are executed here:
//   1. advanceBooking must tell a filter REFUSAL apart from an UNREADABLE
//      store (sbUpdateReturning collapses both into []).
//   2. PATCH /api/bookings must answer 502 for the unreadable case, and keep
//      200 with the row's real status for the honest already-at-it refusal.
//   3. nextBookingStatus (the client's decision) must return the status only
//      when the server actually reported one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
type Strict = { rows: Row[] } | { error: "missing" | "unavailable" };

const EMAIL = "t@example.com";

function mockStore(opts: { update: Row[]; strict: Strict }) {
  const calls: { updates: number; selects: string[] } = { updates: 0, selects: [] };
  vi.doMock("@/lib/runtime-config", () => ({
    sbUpdateReturning: async () => {
      calls.updates += 1;
      return opts.update;
    },
    sbSelectStrict: async (_table: string, q: string) => {
      calls.selects.push(q);
      return opts.strict;
    },
    sbSelect: async () => [],
    sbInsert: async () => true,
    pgTimestamp: (v: string) => v,
  }));
  return calls;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock("@/lib/runtime-config");
  vi.doUnmock("@/lib/session");
});

describe("F054 - advanceBooking says WHY it did not advance", () => {
  it("an unreadable store is `unreadable`, never a silent refusal", async () => {
    mockStore({ update: [], strict: { error: "unavailable" } });
    const { advanceBooking } = await import("@/lib/bookings");
    const res = await advanceBooking(7, EMAIL, "completed", "tap");
    expect(res.advanced).toBe(false);
    expect(res.reason).toBe("unreadable");
  });

  it("a genuine filter refusal is `refused` and carries the row's real status", async () => {
    mockStore({ update: [], strict: { rows: [{ status: "completed" }] } });
    const { advanceBooking } = await import("@/lib/bookings");
    const res = await advanceBooking(7, EMAIL, "completed", "tap");
    expect(res.advanced).toBe(false);
    expect(res.reason).toBe("refused");
    expect(res.status).toBe("completed");
  });

  it("a real transition still advances and needs no extra read", async () => {
    const calls = mockStore({
      update: [{ id: 7, status: "picked_up", vendor_id: "v1", vendor_name: "Shop", thread_key: null }],
      strict: { error: "unavailable" },
    });
    const { advanceBooking } = await import("@/lib/bookings");
    const res = await advanceBooking(7, EMAIL, "picked_up", "tap");
    expect(res.advanced).toBe(true);
    expect(res.row?.status).toBe("picked_up");
    // The honesty read costs nothing on the happy path.
    expect(calls.selects.length).toBe(0);
  });
});

async function loadPatch(opts: { update: Row[]; strict: Strict }) {
  mockStore(opts);
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: EMAIL, plan: "pro", role: "user" }),
  }));
  const mod = await import("@/app/api/bookings/route");
  return mod.PATCH;
}

function patchReq(body: Row) {
  return new Request("http://localhost/api/bookings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("F054 - PATCH /api/bookings reports whether the write persisted", () => {
  it("answers 502 when the store never confirmed the change", async () => {
    const PATCH = await loadPatch({ update: [], strict: { error: "unavailable" } });
    const res = await PATCH(patchReq({ id: 7, action: "completed" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok?: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unreadable");
  });

  it("keeps the honest 200 for a booking already at that status", async () => {
    const PATCH = await loadPatch({ update: [], strict: { rows: [{ status: "completed" }] } });
    const res = await PATCH(patchReq({ id: 7, action: "completed" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; status?: string | null };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("completed");
  });

  it("answers 200 with the new status on a real transition", async () => {
    const PATCH = await loadPatch({
      update: [{ id: 7, status: "completed", vendor_id: "v1", vendor_name: "Shop", thread_key: null }],
      strict: { error: "unavailable" },
    });
    const res = await PATCH(patchReq({ id: 7, action: "completed" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; status?: string | null };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("completed");
  });
});

describe("F054 - nextBookingStatus paints only what the server confirmed", () => {
  it("a confirmed transition paints the new status", async () => {
    const { nextBookingStatus } = await import("./client/booking-tap");
    expect(nextBookingStatus(true, { ok: true, status: "completed" }, "completed")).toBe("completed");
  });

  it("an already-at-this-status refusal keeps the deliberate no-op", async () => {
    const { nextBookingStatus } = await import("./client/booking-tap");
    expect(
      nextBookingStatus(true, { ok: false, reason: "refused", status: "completed" }, "completed")
    ).toBe("completed");
  });

  it("a refusal with no status paints nothing", async () => {
    const { nextBookingStatus } = await import("./client/booking-tap");
    expect(nextBookingStatus(true, { ok: false, reason: "refused", status: null }, "completed")).toBe(
      null
    );
  });

  it("a 502 unreadable answer paints nothing", async () => {
    const { nextBookingStatus } = await import("./client/booking-tap");
    expect(nextBookingStatus(false, { ok: false, reason: "unreadable" }, "completed")).toBe(null);
  });

  it("a 401 paints nothing", async () => {
    const { nextBookingStatus } = await import("./client/booking-tap");
    expect(nextBookingStatus(false, { error: "Sign in first." }, "completed")).toBe(null);
  });

  it("a body that failed to parse paints nothing", async () => {
    const { nextBookingStatus } = await import("./client/booking-tap");
    expect(nextBookingStatus(false, {}, "picked_up")).toBe(null);
  });
});

describe("F054 - the Trips page cannot re-introduce the optimistic paint", () => {
  const page = readFileSync(join(process.cwd(), "src/app/deals/page.tsx"), "utf8");

  it("routes the lifecycle tap through nextBookingStatus", () => {
    expect(page).toMatch(/nextBookingStatus\(/);
  });

  it("no longer falls back to the requested action", () => {
    expect(page).not.toMatch(/d\?\.status\s*:\s*action/);
    expect(page).not.toMatch(/d\.status\s*:\s*action/);
  });

  it("tells the traveller when the tap did not save", () => {
    expect(page).toMatch(/bookingNote/);
  });
});
