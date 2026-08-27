import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

// OWNER REPORT 11, C2.2 - A COALESCED BURST WAS RE-ANSWERED TEN MINUTES LATER.
//
// When a turn coalesces a shop's rapid-fire burst (3 messages in a second), it
// answers all of them with one reply and CLAIMS each sibling id in wa_processed
// so no other frame answers them again. But it inserted the bare claim with no
// `settled_at`. wa_processed rows are LEASES: `claimIsDeadTurn` treats a claim
// past CLAIM_LEASE_MS with settled_at == null as a dead turn to retake, so the
// recovery sweep re-answered the whole burst ten minutes on. The PRIMARY message
// was settled after its send; only its siblings were left unsettled.
//
// The fix settles each sibling in the same breath as the claim, reusing
// settleReplyClaim (which no-ops on a pre-migration schema).

const updates: { table: string; filter: string; values: Record<string, unknown> }[] = [];
vi.mock("../runtime-config", () => ({
  sbUpdate: async (table: string, filter: string, values: Record<string, unknown>) => {
    updates.push({ table, filter, values });
    return true;
  },
}));

beforeEach(() => {
  updates.length = 0;
});

describe("settling a claim is what stops the sweep re-answering it", () => {
  it("claimIsDeadTurn: an unsettled claim past the lease IS a dead turn (the bug)", async () => {
    const { claimIsDeadTurn, CLAIM_LEASE_MS } = await import("./inbound-claim");
    const old = new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString();
    // No settled_at -> reads as answered-by-nobody -> retaken -> re-answered.
    expect(claimIsDeadTurn({ created_at: old, settled_at: null })).toBe(true);
    // Settled -> a reply demonstrably went out -> never retaken.
    expect(claimIsDeadTurn({ created_at: old, settled_at: old })).toBe(false);
  });

  it("EXECUTED: settleReplyClaim stamps settled_at on the sibling's scoped key", async () => {
    const { settleReplyClaim, claimKey } = await import("./inbound-claim");
    await settleReplyClaim("SIBLING-MSG-2", "traveller@x.co");
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("wa_processed");
    // It targets the receiver-scoped key, so the settle lands on the exact row
    // the coalesce loop claimed.
    expect(updates[0].filter).toContain(
      encodeURIComponent(claimKey("traveller@x.co", "SIBLING-MSG-2"))
    );
    expect(updates[0].values).toHaveProperty("settled_at");
    expect(typeof updates[0].values.settled_at).toBe("string");
  });
});

describe("the coalesce loop settles every sibling it claims", () => {
  const src = () => readFileSync("src/lib/agent-loop.ts", "utf8");

  it("calls settleReplyClaim for each consumed sibling, right after the claim", () => {
    const s = src();
    const block = s.slice(
      s.indexOf('finishBeforeResponse("claim-coalesced"'),
      s.indexOf('finishBeforeResponse("claim-coalesced"') + 1400
    );
    expect(block).toMatch(/for \(const id of consumed\)/);
    expect(block).toMatch(/sbInsertReturning\("wa_processed"/); // still claims
    expect(block).toMatch(/settleReplyClaim\(id, opts\.senderEmail\)/); // now settles
  });
});
