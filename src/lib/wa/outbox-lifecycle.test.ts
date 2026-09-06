import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  outboxState,
  leaseUntil,
  CLAIM_LEASE_MS,
  MAX_DUP_HOLDS,
  type OutboxMeta,
} from "./outbox-lifecycle";

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse("2026-07-27T09:00:00.000Z");

describe("a message in flight is a STATE, not an absence", () => {
  it("a claimed row inside its lease is `sending`", () => {
    const meta: OutboxMeta = { claimedAt: NOW - 5_000 };
    expect(outboxState(leaseUntil(NOW - 5_000), meta, NOW)).toBe("sending");
  });

  it("a due row nobody has claimed is `due`", () => {
    expect(outboxState(iso(NOW - 1_000), { reason: "human pacing gap" }, NOW)).toBe("due");
  });

  it("a row parked in the future is `waiting`", () => {
    expect(outboxState(iso(NOW + 600_000), { reason: "shop is closed now" }, NOW)).toBe("waiting");
  });

  it("a LAPSED claim is honestly due again - a dead drainer cannot hold it forever", () => {
    // This is the crash recovery the delete-as-claim made impossible: the row
    // was gone, so an instance dying mid-send lost the message outright.
    const claimedAt = NOW - CLAIM_LEASE_MS - 1;
    expect(outboxState(leaseUntil(claimedAt), { claimedAt }, NOW)).toBe("due");
  });

  it("an unparseable time is treated as due, never as invisible", () => {
    expect(outboxState("not-a-date", null, NOW)).toBe("due");
    expect(outboxState(undefined, undefined, NOW)).toBe("due");
  });

  it("the lease is long enough for a slow send and short enough to recover fast", () => {
    // The transport's own hard timeout is 12s; an hour would strand a message.
    expect(CLAIM_LEASE_MS).toBeGreaterThan(30_000);
    expect(CLAIM_LEASE_MS).toBeLessThanOrEqual(5 * 60_000);
    expect(Date.parse(leaseUntil(NOW)) - NOW).toBe(CLAIM_LEASE_MS);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING. The lifecycle only fixes the disappearing shop if the drain
// actually uses it, and if every surface reads the same definition.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the drain claims by LEASE, so the row never stops existing", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("claiming no longer deletes the row", () => {
    expect(guard).toMatch(/claimOutboxRow\(cand\.id/);
    // The delete-with-return claim is what made the shop vanish mid-send.
    expect(guard).not.toMatch(/sbDeleteReturning<OutboxRow>\("wa_outbox"/);
  });

  it("the SENT row is written BEFORE the queued row is retired", () => {
    // Order is the whole point: the shop is briefly in both tables and never in
    // neither. Reversed, the gap - and the disappearance - comes straight back.
    // The SENT row goes through recordOutboundAnchor since audit F014 (the
    // insert's result is read, retried once and breadcrumbed on loss) - the
    // ordering it sits in is exactly what this pin has always held.
    const sentInsert = guard.indexOf("await recordOutboundAnchor(");
    expect(sentInsert).toBeGreaterThan(-1);
    // The retire call that belongs to the success path is the first one AFTER
    // the sent row is written; the earlier ones are the deliberate-drop paths.
    const complete = guard.indexOf("completeOutboxRow(row.id)", sentInsert);
    expect(complete).toBeGreaterThan(sentInsert);
    // ...and nothing else intervenes: they are the same block.
    expect(guard.slice(sentInsert, complete)).not.toMatch(/await send\(/);
  });

  it("every non-send outcome releases or retires the claim - none strands it", () => {
    // A guard reject, a cancellation, a lost pacing slot and both failure
    // classes each have to leave the row in a state a later drain can act on.
    expect(guard).toMatch(/releaseOutboxRow/);
    expect(guard).toMatch(/completeOutboxRow/);
    // Re-queueing is a PATCH on the row that is already there - there is no
    // insert left that could fail and silently lose the message.
    expect(guard).not.toMatch(/robustRequeue/);
  });

  it("a re-timed row is patched, never duplicated", () => {
    expect(guard).toMatch(/outboxRowId/);
    expect(guard).toMatch(/opts\.outboxRowId/);
  });

  it("being blocked by a live idempotency claim is BOUNDED and never silent", () => {
    expect(guard).toMatch(/MAX_DUP_HOLDS/);
    expect(guard).toMatch(/dupHolds/);
    expect(MAX_DUP_HOLDS).toBeGreaterThan(1);
  });
});

describe("every surface reads ONE definition of what a queued row is doing", () => {
  it("the queue viewer and the activity feed both use outboxState", () => {
    for (const f of ["src/app/api/queue/route.ts", "src/app/api/activity/route.ts"]) {
      const code = readCode(f);
      expect(code).toMatch(/outboxState\(/);
      expect(code).toMatch(/sending/);
    }
  });

  it("`sending` is a real tracker stage, so the card is never stateless", () => {
    expect(readCode("src/lib/types.ts")).toMatch(/\|\s*"sending"/);
    expect(readCode("src/components/Tracker.tsx")).toMatch(/sending: \{ text: "Sending"/);
  });

  it("the status partition is TOTAL - no shop can fall out of every bucket", () => {
    // The disappearance was not a rendering bug: `stage` fell through to
    // "found", which matched no branch, so the shop was counted nowhere.
    const page = readCode("src/app/page.tsx");
    const start = page.indexOf("const statusGroups");
    const block = page.slice(start, page.indexOf("return { messaged, replied, queued, deals }", start));
    expect(block).toMatch(/v\.stage === "sending" \|\| v\.queuedUntil/);
    // A final catch-all: a shop we have demonstrably contacted lands somewhere.
    expect(block).toMatch(/v\.sentText \|\| v\.lastEventAt/);
  });
});
