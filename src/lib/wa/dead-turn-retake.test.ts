import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F020: THE DEAD-TURN RETAKE OF A wa_processed LEASE WAS AN
// UNCONDITIONAL DELETE, SO TWO RETAKERS BOTH OWNED THE TURN.
//
// An instance killed mid-turn leaves an unsettled claim past CLAIM_LEASE_MS.
// Two sweeps (the ping cron and the traveller's /api/replies poll, on
// different containers) both read that dead row, and the retake deleted
// `wa_message_id=eq.<key>` with no lease predicate: the second retaker
// deleted the FIRST retaker's fresh claim and re-inserted its own, so both
// reached claimedReply = true. The loser of claimThreadTurn then released the
// only surviving row, the winner's settle patched nothing, and the next sweep
// re-answered the shop - a second agent message in a real chat.
//
// EXECUTED against the real processVendorReply claim block over a Map-backed
// wa_processed. The race is modelled honestly: the second retaker's READ is
// the snapshot it took before the first retaker's delete+insert landed, while
// the table already holds the first retaker's fresh claim.

const stale: { rows: Record<string, unknown>[] | null } = { rows: null };

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  const base = h.runtimeConfigMock() as Record<string, unknown> & {
    sbSelectStrict: (t: string, q: string) => Promise<unknown>;
  };
  return {
    ...base,
    // The retaker's pre-delete snapshot of wa_processed, when the test sets one.
    sbSelectStrict: async (table: string, query: string) =>
      table === "wa_processed" && stale.rows ? { rows: stale.rows } : base.sbSelectStrict(table, query),
  };
});

const RFQ = {
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "pickup",
} as unknown as import("../types").StructuredRFQ;

vi.mock("./thread-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./thread-context")>();
  return {
    ...actual,
    resolveThreadContext: async (digits: string, senderEmail: string) => ({
      ok: true,
      reason: "active-thread" as const,
      rfq: RFQ,
      ctx: { sender: senderEmail, vendorId: "v1", vendorName: "Shop", round: 1, rfq: RFQ },
      anchors: 1,
      newestAt: null,
      vendorId: "v1",
    }),
  };
});

// The turn itself is not under test: a retaker that gets past the claim block
// runs nothing here, and the finally then hands its claim back (a turn that
// delivered nothing releases). What matters is who gets past the claim block.
const turn = { entered: 0 };
vi.mock("../ai-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-budget")>();
  return {
    ...actual,
    runWithAiBudget: async () => {
      turn.entered += 1;
      return undefined;
    },
  };
});

import { store } from "../privacy/postgrest-store.test-helper";
import { processVendorReply } from "../agent-loop";
import { claimKey, CLAIM_LEASE_MS } from "./inbound-claim";

const EMAIL = "traveller@x.co";
const DIGITS = "66812345678";
const MSG = "3EB0ABC123";
const KEY = claimKey(EMAIL, MSG);

const run = () =>
  processVendorReply({
    fromDigits: DIGITS,
    text: "250 baht per day",
    waMessageId: MSG,
    senderEmail: EMAIL,
    send: async () => ({ ok: true }),
  });

beforeEach(() => {
  store.reset();
  stale.rows = null;
  turn.entered = 0;
  store.seed("app_users", [{ email: EMAIL, status: "active", plan: "free" }]);
});

describe("EXECUTED (F020): the dead-turn retake is conditional on the lease it read", () => {
  it("a second retaker whose read pre-dates the first retake stands down and leaves the fresh claim intact", async () => {
    const freshAt = new Date().toISOString();
    // The table as it IS: retaker A already deleted the dead row and holds a
    // fresh, unsettled claim.
    store.seed("wa_processed", [{ wa_message_id: KEY, created_at: freshAt, settled_at: null, owner: "A" }]);
    // What retaker B READ a moment earlier: the dead row (past the lease).
    stale.rows = [
      {
        wa_message_id: KEY,
        created_at: new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString(),
        settled_at: null,
      },
    ];

    await run();

    // B never reached the turn...
    expect(turn.entered).toBe(0);
    // ...and A's live claim is exactly as it was: same row, same lease clock.
    const rows = store.rows("wa_processed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ wa_message_id: KEY, created_at: freshAt, owner: "A" });
  });

  it("a genuinely dead lease (past CLAIM_LEASE_MS, unsettled) is still retaken by exactly one delete + one insert", async () => {
    store.seed("wa_processed", [
      {
        wa_message_id: KEY,
        created_at: new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString(),
        settled_at: null,
      },
    ]);
    await run();
    // The retaker got past the claim block into the turn.
    expect(turn.entered).toBe(1);
    const writes = store.log.filter((w) => w.table === "wa_processed");
    const del = writes.find((w) => w.op === "delete");
    expect(del, "the dead lease is removed").toBeTruthy();
    // The delete can only ever match the lease that was read: unsettled AND
    // older than CLAIM_LEASE_MS - never a sibling's fresh retake.
    expect(String(del!.query)).toContain("settled_at=is.null");
    expect(String(del!.query)).toMatch(/created_at=lt\./);
    const reinsert = writes.filter((w) => w.op === "insert");
    // One optimistic insert (conflicts on the dead row), one retake insert.
    expect(reinsert).toHaveLength(2);
    expect(writes.filter((w) => w.op === "delete").length).toBe(
      // The retake's one delete, plus the finally's release (the stubbed
      // turn delivered nothing, so the claim is handed back).
      2
    );
  });

  it("a SETTLED claim (a reply really went out) is never retaken, however old", async () => {
    store.seed("wa_processed", [
      {
        wa_message_id: KEY,
        created_at: new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString(),
        settled_at: new Date(Date.now() - CLAIM_LEASE_MS).toISOString(),
      },
    ]);
    await run();
    expect(turn.entered).toBe(0);
    expect(store.rows("wa_processed")).toHaveLength(1);
    expect(store.log.filter((w) => w.table === "wa_processed" && w.op === "delete")).toHaveLength(0);
  });
});
