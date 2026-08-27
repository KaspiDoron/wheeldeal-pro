import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// OWNER REPORT 11, E2.2 - THE INTRO BUDGET WAS RE-SCANNED ON EVERY 6s POLL.
//
// newContactBudget scans the intro ledger (introductionsInWindow reads the
// outbound rfq rows) plus the unanswered meters - and it was recomputed on
// every /api/activity poll (6s) to render two chips, and again per send
// decision. The atomic claimSendSlots fleet-gap is the real velocity ceiling,
// so this budget is advisory; a 12s cache (2x the poll) removes the scan from
// the steady state, while { fresh: true } keeps the click-time mass route exact.

// Count the EXPENSIVE ledger read (the rfq scan) so we can see it run once.
let rfqReads = 0;
vi.mock("../runtime-config", () => ({
  sbSelect: async () => [],
  sbSelectStrict: async (_t: string, q: string) => {
    if (q.includes("raw->>kind=eq.rfq")) rfqReads += 1;
    return { rows: [] as unknown[] };
  },
  sbInsert: async () => true,
  sbUpdate: async () => true,
  sbDelete: async () => true,
  getConfig: async () => undefined,
  pgTimestamp: (d: string) => d,
}));

beforeEach(() => {
  rfqReads = 0;
});

describe("newContactBudget caches the ledger scan across rapid polls", () => {
  it("EXECUTED: two calls inside the TTL scan the ledger ONCE", async () => {
    const { newContactBudget } = await import("../wa-guard");
    const sender = "cache-a@x.co";
    const first = await newContactBudget(sender, "free");
    const readsAfterFirst = rfqReads;
    expect(readsAfterFirst).toBeGreaterThanOrEqual(1); // the first genuinely reads
    const second = await newContactBudget(sender, "free");
    // The second is served from cache - no new ledger scan.
    expect(rfqReads).toBe(readsAfterFirst);
    // ...and it is the SAME budget, not a degraded one.
    expect(second).toEqual(first);
  });

  it("EXECUTED: { fresh: true } bypasses the cache for the click-time truth", async () => {
    const { newContactBudget } = await import("../wa-guard");
    const sender = "cache-b@x.co";
    await newContactBudget(sender, "free");
    const before = rfqReads;
    await newContactBudget(sender, "free", { fresh: true });
    // fresh forces a re-scan - the mass route must never act on a stale value.
    expect(rfqReads).toBeGreaterThan(before);
  });

  it("EXECUTED: a different plan is a different cache key (no cross-plan bleed)", async () => {
    const { newContactBudget } = await import("../wa-guard");
    const sender = "cache-c@x.co";
    await newContactBudget(sender, "free");
    const before = rfqReads;
    await newContactBudget(sender, "ultra"); // different key -> real scan
    expect(rfqReads).toBeGreaterThan(before);
  });
});
