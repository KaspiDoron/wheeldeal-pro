// The booking lifecycle's rules, executed - plus the doctrine pins: the
// traveller is the witness (no auto-complete anywhere), and nothing but
// advanceBooking may move bookings.status past its INSERT default.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const updates: { table: string; filter: string; values: Record<string, unknown> }[] = [];
let updateResult: Record<string, unknown>[] = [];
const selects: string[] = [];
let selectResult: Record<string, unknown>[] = [];
const pushes: { email: string; payload: Record<string, unknown> }[] = [];
const events: Record<string, unknown>[] = [];

vi.mock("./runtime-config", () => ({
  sbUpdateReturning: async (table: string, filter: string, values: Record<string, unknown>) => {
    updates.push({ table, filter, values });
    return updateResult;
  },
  sbSelect: async (_table: string, q: string) => {
    selects.push(q);
    return selectResult;
  },
  sbInsert: async (_table: string, rows: Record<string, unknown>[]) => {
    events.push(...rows);
    return true;
  },
}));
vi.mock("./push", () => ({
  sendPushToUser: async (email: string, payload: Record<string, unknown>) => {
    pushes.push({ email, payload });
    return { attempted: 1, delivered: 1, pruned: 0, results: [] };
  },
}));

beforeEach(() => {
  updates.length = 0;
  selects.length = 0;
  pushes.length = 0;
  events.length = 0;
  updateResult = [];
  selectResult = [];
});

describe("the booking state machine", () => {
  it("is forward-only with legal skips: no-deposit shops go confirmed -> picked_up", async () => {
    const { bookingEligibleFrom } = await import("./bookings");
    expect(bookingEligibleFrom("picked_up")).toContain("confirmed");
    expect(bookingEligibleFrom("picked_up")).toContain("deposit_settled");
    expect(bookingEligibleFrom("confirmed")).toEqual([]);
    // Regression is never eligible.
    expect(bookingEligibleFrom("deposit_pending")).not.toContain("picked_up");
  });

  it("the two deposit outcomes are alternatives, never each other's past", async () => {
    const { bookingEligibleFrom } = await import("./bookings");
    expect(bookingEligibleFrom("deposit_settled")).not.toContain("deposit_waived");
    expect(bookingEligibleFrom("deposit_waived")).not.toContain("deposit_settled");
    // Both can still advance.
    expect(bookingEligibleFrom("picked_up")).toContain("deposit_waived");
  });

  it("hard terminals leave nothing: a completed trip cannot be cancelled after the fact", async () => {
    const { bookingEligibleFrom } = await import("./bookings");
    expect(bookingEligibleFrom("cancelled")).not.toContain("completed");
    expect(bookingEligibleFrom("no_show")).not.toContain("completed");
    expect(bookingEligibleFrom("cancelled")).not.toContain("no_show");
  });

  it("advanceBooking carries ownership in the atomic filter and writes one booking-stage event", async () => {
    const { advanceBooking } = await import("./bookings");
    updateResult = [
      { id: 7, status: "picked_up", vendor_id: "v1", vendor_name: "Krabi Bikes", thread_key: "t@x.com:66812345678" },
    ];
    const res = await advanceBooking(7, "t@x.com", "picked_up", "traveller tapped", { picked_up_at: "now" });
    expect(res.advanced).toBe(true);
    expect(updates[0].filter).toContain("id=eq.7");
    expect(updates[0].filter).toContain("user_email=eq.t%40x.com");
    expect(updates[0].filter).toContain("status.in.(");
    const ev = events.find((e) => e.kind === "booking-stage");
    expect(ev).toBeTruthy();
    expect(ev!.user_email).toBe("t@x.com");
    expect(ev!.to_number).toBe("66812345678");
  });

  it("completed also advances the funnel ledger - the one place the machines touch", async () => {
    const { advanceBooking } = await import("./bookings");
    updateResult = [
      { id: 7, status: "completed", vendor_id: "v1", vendor_name: "Krabi Bikes", thread_key: "t@x.com:66812345678" },
    ];
    // The thread row exists at `booked` - the ledger's pre-read sees it and
    // takes the guarded PATCH path (an absent row would take the insert path).
    selectResult = [{ stage: "booked" }];
    await advanceBooking(7, "t@x.com", "completed", "traveller tapped", { completed_at: "now" });
    expect(updates.some((u) => u.table === "negotiation_threads")).toBe(true);
    const funnel = events.find((e) => e.kind === "funnel-stage");
    expect(JSON.parse(String(funnel!.detail))).toMatchObject({ from: "booked", to: "completed" });
  });

  it("a refused transition (lost race / already past) writes NO event", async () => {
    const { advanceBooking } = await import("./bookings");
    updateResult = [];
    const res = await advanceBooking(7, "t@x.com", "picked_up", "double tap");
    expect(res.advanced).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe("the completion suggestion - asks, never asserts", () => {
  it("pushes once for a rental whose window passed, claiming atomically first", async () => {
    const { suggestCompletions } = await import("./bookings");
    const now = Date.parse("2026-08-29T12:00:00Z");
    selectResult = [
      {
        id: 3,
        user_email: "t@x.com",
        vendor_name: "Krabi Bikes",
        scheduled_at: "2026-08-25T09:00:00Z",
        duration_days: 3, // ended the 28th - over
      },
      {
        id: 4,
        user_email: "t@x.com",
        vendor_name: "Ao Nang Scooters",
        scheduled_at: "2026-08-28T09:00:00Z",
        duration_days: 5, // still riding
      },
    ];
    updateResult = [{ id: 3 }]; // the claim wins
    const n = await suggestCompletions(now);
    expect(n).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].payload.title).toContain("Did you return");
    // The claim is the is.null conditional PATCH - the once-only mechanism.
    expect(updates[0].filter).toBe("id=eq.3&completion_suggested_at=is.null");
    // CRUCIALLY: no status write - a suggestion never completes anything.
    expect(updates.every((u) => !("status" in u.values))).toBe(true);
  });

  it("a lost claim sends nothing - one ask per booking across the fleet", async () => {
    const { suggestCompletions } = await import("./bookings");
    selectResult = [
      { id: 3, user_email: "t@x.com", vendor_name: "K", scheduled_at: "2026-08-20T09:00:00Z", duration_days: 1 },
    ];
    updateResult = []; // another instance claimed it
    const n = await suggestCompletions(Date.parse("2026-08-29T12:00:00Z"));
    expect(n).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it("rentalOver needs real dates - unknowable windows never prompt", async () => {
    const { rentalOver } = await import("./bookings");
    const now = Date.parse("2026-08-29T12:00:00Z");
    expect(rentalOver(null, 3, now)).toBe(false);
    expect(rentalOver("2026-08-25T09:00:00Z", null, now)).toBe(false);
    expect(rentalOver("2026-08-25T09:00:00Z", 3, now)).toBe(true);
  });
});

describe("doctrine pin: only advanceBooking writes bookings.status", () => {
  it("no other non-test source PATCHes a status onto bookings", () => {
    const files: string[] = [];
    (function walk(d: string) {
      for (const name of readdirSync(d)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(p);
      }
    })(join(process.cwd(), "src"));
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith("src/lib/bookings.ts")) continue;
      const code = readFileSync(f, "utf8");
      // A write-shaped touch: an update call on "bookings" whose values name
      // status. The INSERT's initial status:"confirmed" is the one legal other
      // writer and is POST-shaped, not PATCH-shaped.
      for (const m of code.matchAll(/sbUpdate\w*\(\s*\n?\s*"bookings"[\s\S]{0,400}?\)/g)) {
        if (/status/.test(m[0])) offenders.push(f.replace(process.cwd() + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});
