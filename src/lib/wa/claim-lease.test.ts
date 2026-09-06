import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { claimIsDeadTurn, CLAIM_LEASE_MS } from "./inbound-claim";

vi.mock("server-only", () => ({}));

const readCode = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 7, P0-B: THE CLAIM THAT OUTLIVED ITS TURN.
//
// wa_processed is a lease: a turn that fails hands it back, so a surviving row
// was taken to mean "answered". But an instance killed mid-turn (Cloud Run
// recycles freely) hands back nothing - the claim survives with no reply
// behind it, and the recovery sweep, the ONLY path that could rescue that
// message, skipped it forever as already-answered. Stored, silent, lost.

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("a dead turn's claim is distinguishable from a real answer", () => {
  it("THE REGRESSION: unsettled and past the lease is a dead turn", () => {
    expect(claimIsDeadTurn({ created_at: ago(CLAIM_LEASE_MS + 1000) }, NOW)).toBe(true);
  });

  it("a SETTLED claim is an answer forever, however old", () => {
    // The reply really did go out; re-answering would put a second message
    // into a real shop's chat.
    expect(
      claimIsDeadTurn({ created_at: ago(30 * 24 * 3600_000), settled_at: ago(30 * 24 * 3600_000) }, NOW)
    ).toBe(false);
  });

  it("a claim still inside the lease is LIVE - a turn may be running right now", () => {
    expect(claimIsDeadTurn({ created_at: ago(30_000) }, NOW)).toBe(false);
    expect(claimIsDeadTurn({ created_at: ago(CLAIM_LEASE_MS - 1000) }, NOW)).toBe(false);
  });

  it("the lease is far longer than any turn - it can only catch a dead process", () => {
    // A whole turn is bounded around 60s; anything near that would make this a
    // duplicate-reply generator instead of a repair.
    expect(CLAIM_LEASE_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("UNREADABLE means LIVE - it never guesses toward a second message", () => {
    expect(claimIsDeadTurn({ created_at: null }, NOW)).toBe(false);
    expect(claimIsDeadTurn({ created_at: "not a date" }, NOW)).toBe(false);
    expect(claimIsDeadTurn({}, NOW)).toBe(false);
    expect(claimIsDeadTurn(null, NOW)).toBe(false);
    expect(claimIsDeadTurn(undefined, NOW)).toBe(false);
  });
});

describe("the three places the lease has to be honored", () => {
  it("a delivered turn SETTLES its claim", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/turnDelivered && opts\.waMessageId/);
    expect(loop).toMatch(/settleReplyClaim\(opts\.waMessageId, opts\.senderEmail\)/);
  });

  it("a new delivery can RETAKE a dead turn's claim - and only the dead lease it read (audit F020)", () => {
    // The executed instrument for this is src/lib/wa/dead-turn-retake.test.ts;
    // this pins the shape so the unconditional delete cannot come back.
    const loop = readCode("src/lib/agent-loop.ts");
    const block = loop.slice(loop.indexOf("if (existing.length > 0)"));
    const ins = block.indexOf("sbInsertReturning");
    const head = block.slice(0, ins);
    expect(head).toMatch(/if \(!claimIsDeadTurn\(existing\[0\]\)\) return;/);
    // The delete is CONDITIONAL and RETURNING: it can only match the lease
    // this caller read - unsettled and older than CLAIM_LEASE_MS - so a second
    // retaker whose read pre-dates the first retake removes nothing and stands
    // down instead of deleting the winner's fresh claim. It used to be a bare
    // delete by key under a comment calling that "atomic"; it was not.
    const del = head.indexOf("sbDeleteReturning<{ wa_message_id: string }>(");
    expect(del).toBeGreaterThan(-1);
    expect(del, "the conditional delete precedes the re-claim").toBeLessThan(ins);
    expect(head).toMatch(/settled_at=is\.null/);
    expect(head).toMatch(/created_at=lt\.\$\{pgTimestamp\(Date\.now\(\) - CLAIM_LEASE_MS\)\}/);
    expect(head).toMatch(/if \(retired\.length === 0\) return;/);
    // ...and the unguarded shape is gone: no delete of wa_processed by key alone.
    expect(head).not.toMatch(/sbDelete\(\s*"wa_processed"/);
    expect(block.slice(ins, ins + 400)).toMatch(/if \(retaken\.length === 0\) return;/);
  });

  it("the recovery sweep stops counting a dead turn as answered", () => {
    const sync = readCode("src/lib/wa-sync.ts");
    expect(sync).toMatch(/select=wa_message_id,created_at,settled_at/);
    expect(sync).toMatch(/\.filter\(\(r\) => !claimIsDeadTurn\(r\)\)/);
  });

  it("the column is additive, so a pre-migration deployment is unchanged", () => {
    const schema = readCode("supabase/schema.sql");
    expect(schema).toMatch(/add column if not exists settled_at timestamptz/);
    // And the settle write is best-effort - a missing column must not fail a turn.
    const claim = readCode("src/lib/wa/inbound-claim.ts");
    const fn = claim.slice(claim.indexOf("export async function settleReplyClaim"));
    expect(fn.slice(0, 700)).toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});
