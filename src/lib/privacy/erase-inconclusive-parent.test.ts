import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F167.
//
// The child walk collected parent ids with sbSelect, which returns [] for a
// transient 500, a timed-out fetch and a genuinely empty parent set alike. So
// an UNREADABLE parent read stamped `purged[child] = true` ("nothing to
// delete"), the registry loop then deleted the parent rows, and the children
// - feedback_images' base64 screenshots, waba_events - survived with no
// remaining path from the person to them. The route saw `failed: []` and
// answered {ok:true}: "every trace of your data", permanently false.
//
// Every test here RUNS eraseUserData against a Map-backed store whose parent
// read answers with the strict read's three outcomes.

type ParentMode = "unavailable" | "missing" | "rows" | "paged";

const calls: {
  deletes: { table: string; filter: string }[];
  updates: { table: string }[];
  parentMode: ParentMode;
} = { deletes: [], updates: [], parentMode: "unavailable" };

vi.mock("../runtime-config", () => ({
  supabaseConfigured: () => true,
  sbDelete: async (table: string, filter: string) => {
    calls.deletes.push({ table, filter });
    return true;
  },
  // The permissive read: [] on failure and on empty alike - what the walker
  // used to drive off.
  sbSelect: async () => [],
  sbSelectStrict: async (table: string, query: string) => {
    if (table === "feedback" && query.includes("select=id")) {
      if (calls.parentMode === "unavailable") return { error: "unavailable" as const };
      if (calls.parentMode === "missing") return { error: "missing" as const };
      if (calls.parentMode === "paged") {
        const offset = Number(/offset=(\d+)/.exec(query)?.[1] ?? 0);
        if (offset === 0) return { rows: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 })) };
        return { rows: [{ id: 1001 }, { id: 1002 }] };
      }
      return { rows: [{ id: 7 }, { id: 9 }] };
    }
    return { rows: [] };
  },
  sbInsert: async () => true,
  sbUpdate: async (table: string) => {
    calls.updates.push({ table });
    return true;
  },
  getConfig: async () => undefined,
}));

vi.mock("../evolution", () => ({
  disconnectInstance: async () => ({ severed: true, hostsTried: 1, hadLink: true }),
}));

import { eraseUserData } from "./erase";

beforeEach(() => {
  calls.deletes = [];
  calls.updates = [];
  calls.parentMode = "unavailable";
});

const deletesOn = (table: string) => calls.deletes.filter((d) => d.table === table);

describe("EXECUTED: an unreadable parent read is inconclusive, never a successful purge", () => {
  it("the children are NAMED as failed, the parent DELETE is skipped, the account row survives", async () => {
    calls.parentMode = "unavailable";
    const r = await eraseUserData("someone@example.com");
    // THE ASSERTIONS THAT FAILED BEFORE: purged[feedback_images] was true and
    // the feedback rows (the only key to the screenshots) were deleted.
    expect(r.failed).toContain("feedback_images");
    expect(r.failed).toContain("feedback_replies");
    expect(deletesOn("feedback")).toEqual([]);
    expect(r.failed).toContain("feedback");
    // The account row is deleted LAST and only after everything else went, so
    // the person (or the owner) can retry and the retry can still find the ids.
    expect(r.userDeleted).toBe(false);
    expect(deletesOn("app_users")).toEqual([]);
  });

  it("skipping the inconclusive parent does not abandon the rest of the registry pass", async () => {
    calls.parentMode = "unavailable";
    const r = await eraseUserData("someone@example.com");
    expect(deletesOn("searches").length).toBe(1);
    // sender + receiver, each under the live address and the wd- pseudonym (F025)
    expect(deletesOn("whatsapp_messages").length).toBe(4);
    expect(r.purged.searches).toBe(true);
    // A genuinely empty parent set (waba_leads) stays a successful no-op.
    expect(r.purged.waba_events).toBe(true);
  });

  it("a parent table this database does not have is a successful no-op purge (not-yet-migrated is vacuous)", async () => {
    calls.parentMode = "missing";
    const r = await eraseUserData("someone@example.com");
    expect(r.purged.feedback_images).toBe(true);
    expect(r.failed).toEqual([]);
    expect(deletesOn("feedback").length).toBe(1);
    expect(r.userDeleted).toBe(true);
  });

  it("a readable parent set deletes the children by id in-list, then the parents", async () => {
    calls.parentMode = "rows";
    const r = await eraseUserData("someone@example.com");
    expect(deletesOn("feedback_images").map((d) => d.filter)).toEqual(["feedback_id=in.(7,9)"]);
    const order = calls.deletes.map((d) => d.table);
    expect(order.indexOf("feedback_images")).toBeLessThan(order.indexOf("feedback"));
    expect(r.failed).toEqual([]);
    expect(r.userDeleted).toBe(true);
  });

  it("more parent rows than one page are PAGED, not truncated - the tail is not orphaned", async () => {
    calls.parentMode = "paged";
    const r = await eraseUserData("someone@example.com");
    const filters = deletesOn("feedback_images").map((d) => d.filter);
    expect(filters.length).toBe(2);
    expect(filters[0]).toMatch(/^feedback_id=in\.\(1,2,3,/);
    expect(filters[0]).toMatch(/,1000\)$/);
    expect(filters[1]).toBe("feedback_id=in.(1001,1002)");
    expect(r.purged.feedback_images).toBe(true);
  });
});
