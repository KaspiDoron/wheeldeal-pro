import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const guard = readCode("src/lib/wa-guard.ts");
const evo = readCode("src/lib/evolution.ts");

// ---------------------------------------------------------------------------
// W8 A2: A SUPABASE OUTAGE WAS REPORTED AS "DAILY MESSAGE ALLOWANCE REACHED".
// ---------------------------------------------------------------------------
//
// `checkRateLimit` has TWO distinct `allowed:false` outcomes and only one of
// them is a cap:
//
//   * a genuine refusal - stamps `rateLimited: true`, carries the limiter's own
//     wait, and is normal operation;
//   * an unreadable send-history read - deliberately does NOT stamp it, and
//     carries an honest reason ("Send history is temporarily unreadable...").
//
// `sendFromUser` collapsed both by hardcoding `rateLimited: true`, so the drain
// re-parked a DATABASE OUTAGE with the words "held - daily message allowance
// reached, resumes 14:32" - a number the owner can go and check, and disprove,
// while the actual fault sits somewhere else entirely.

describe("W8 A2: the send path reports WHICH refusal it was", () => {
  it("REPRODUCTION: the two outcomes are genuinely different in the limiter", () => {
    // The unreadable branch returns no rateLimited flag, on purpose. (Wave 8
    // turned the 300-row body read into two exact HEAD counts - null is the
    // unreadable signal now, and the fail direction is unchanged.)
    expect(evo).toMatch(
      /if \(dayCount === null \|\| hourCount === null\) \{\s*return \{\s*allowed: false,\s*reason:/
    );
    // The cap branches do stamp it.
    expect((evo.match(/rateLimited: true,/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("sendFromUser forwards the limiter's own verdict instead of hardcoding it", () => {
    expect(evo).toMatch(/rateLimited: rate\.rateLimited === true,/);
    expect(evo).toMatch(/budgetUnreadable: rate\.rateLimited !== true,/);
    expect(evo).not.toMatch(/ok: false,\s*rateLimited: true,\s*retryAfterSeconds/);
  });

  it("the drain says the true thing for each, and they classify differently", async () => {
    const { classifyQueueReason } = await import("../queue-reason");
    // The cap keeps its honest allowance sentence...
    expect(guard).toMatch(/held - daily message allowance reached, resumes/);
    // ...and the outage is a sync retry, not a spent budget.
    expect(guard).toMatch(/if \(r\.budgetUnreadable\) \{/);
    expect(guard).toMatch(
      /reason: "sync-retry - send budget unreadable, holding rather than risking your number"/
    );
    expect(classifyQueueReason("held - daily message allowance reached, resumes 14:32")).toBe(
      "limit"
    );
    expect(
      classifyQueueReason(
        "sync-retry - send budget unreadable, holding rather than risking your number"
      )
    ).toBe("sync");
  });

  it("the hold trail records the third cause as itself", () => {
    expect(guard).toMatch(/\? "budget-unreadable"/);
  });
});

// ---------------------------------------------------------------------------
// W8 A6: THE DRAIN'S DOMINANT HOLDS LEFT NO TRAIL AT ALL.
// ---------------------------------------------------------------------------
//
// hold-events.ts promises "every queue() verdict appends a wa-hold event" and
// message-path.ts is built to read that history back chronologically. But the
// drain's OWN re-parks - the over-budget smoothing that handles the rest of
// every cold wave, and the duplicate-claim hold - went through
// `releaseOutboxRow`/`sbUpdate` directly, so the two most common holds in a
// real queue were the two the message-path view could never show. A row
// re-parked forty times looked like a row nothing had ever happened to.

describe("W8 A6: every drain re-park appends to the durable hold trail", () => {
  it("the post-claim release() writes an event with the reason it re-parked for", () => {
    const rel = guard.slice(
      guard.indexOf("const release = async (delayMs: number"),
      guard.indexOf("const rowKind =")
    );
    expect(rel.length).toBeGreaterThan(100);
    expect(rel).toMatch(/recordHoldEvent\(\{/);
    expect(rel).toMatch(/reason,/);
    expect(rel).toMatch(/until: notBefore,/);
    expect(rel).toMatch(/outboxRowId: row\.id,/);
  });

  it("the over-budget branch - the path most of a wave takes - writes one too", () => {
    const branch = guard.slice(
      guard.indexOf("if (overCap) {"),
      guard.indexOf("const claimedAt = Date.now();")
    );
    expect(branch).toMatch(/recordHoldEvent\(\{/);
    // ...and stamps the reason on the row as well, so the queue viewer stops
    // showing whatever reason the row was parked with hours ago.
    expect(branch).toMatch(/reason: overCapReason/);
  });

  it("the duplicate-claim hold goes through release(), so it is covered by it", () => {
    expect(guard).toMatch(
      /await release\(isReplyRow \? 30_000 : 120_000, \{ dupHolds: holds, reason: "human pacing gap" \}\)/
    );
  });

  it("the trail is throttled per reason, so a churning row cannot flood it", async () => {
    const { holdThrottleMsFor, REPLY_HOLD_EVENT_THROTTLE_MS, HOLD_EVENT_THROTTLE_MS } =
      await import("./hold-events");
    expect(holdThrottleMsFor("rfq")).toBe(HOLD_EVENT_THROTTLE_MS);
    expect(holdThrottleMsFor(undefined)).toBe(REPLY_HOLD_EVENT_THROTTLE_MS);
  });
});

// ---------------------------------------------------------------------------
// W8 A7: THE DRAIN'S LANE TEST AND ITS OWN FILTER DISAGREED ABOUT human-manual.
// ---------------------------------------------------------------------------

describe("W8 A7: one row, one lane", () => {
  it("isReplyRow excludes human-manual, like REPLY_KIND_FILTER and replyKind", () => {
    expect(guard).toMatch(
      /const isReplyRow = rowKind !== "rfq" && rowKind !== "custom" && rowKind !== "human-manual";/
    );
  });

  it("REPRODUCTION: all three definitions now name the same three kinds", async () => {
    const { REPLY_KIND_FILTER } = await import("../wa-guard");
    expect(REPLY_KIND_FILTER).toContain("rfq,custom,human-manual");
    // guardOutbound's own pre-recipient test
    expect(guard).toMatch(
      /kindStr !== "rfq" && kindStr !== "custom" && kindStr !== "human-manual"/
    );
    // the drain's send-slot test
    expect(guard).toMatch(
      /rowKind !== "rfq" && rowKind !== "custom" && rowKind !== "human-manual"/
    );
  });

  it("a user-typed manual message therefore paces on the STRICT lane", () => {
    // isReplyRow drives gapSeconds, perRecipient and the fleet gap. Treating a
    // hand-typed message as an agent reply gave it the 5s per-shop lane instead
    // of the 12s per-sender velocity lane the other two definitions put it on.
    expect(guard).toMatch(/gapSeconds: isReplyRow \? p\.reply_gap_seconds : p\.min_gap_seconds/);
    expect(guard).toMatch(/perRecipient: isReplyRow,/);
  });
});

// ---------------------------------------------------------------------------
// W8 A9: TWO COMMENTS THAT DESCRIBED CODE THAT NO LONGER EXISTS.
// ---------------------------------------------------------------------------

describe("W8 A9: the comments describe the code that is actually there", () => {
  const policyRaw = readFileSync(
    join(process.cwd(), "src/lib/wa/outbox-policy.ts"),
    "utf8"
  );
  const claimRaw = readFileSync(join(process.cwd(), "src/lib/wa/inbound-claim.ts"), "utf8");

  it("outbox-policy's header narrates the LEASE, not the delete it replaced", () => {
    expect(policyRaw).toMatch(/claims a due row by LEASE/);
    // The delete survives only as history, explicitly labelled as past.
    expect(policyRaw).toMatch(/It was a delete-with-return once/);
    expect(policyRaw).not.toMatch(/drainOutbox claims a due row by DELETING it/);
  });

  it("releaseReplyClaim's hover shows ITS contract, not claimInboundStore's", () => {
    const relIdx = claimRaw.indexOf("export async function releaseReplyClaim");
    const claimIdx = claimRaw.indexOf("export async function claimInboundStore");
    const storeDoc = "True when THIS caller owns the message and should store it.";
    const docIdx = claimRaw.indexOf(storeDoc);
    expect(docIdx).toBeGreaterThan(-1);
    // The doc block sits immediately above the function it documents...
    expect(docIdx).toBeGreaterThan(relIdx);
    expect(docIdx).toBeLessThan(claimIdx);
    // ...and nowhere near the one it used to shadow.
    expect(claimIdx - docIdx).toBeLessThan(600);
  });
});
