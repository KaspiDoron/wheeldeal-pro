import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { nationalTail } from "./phone-key";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const guard = readCode("src/lib/wa-guard.ts");

// THE BUDGET WAS DENOMINATED IN THE WRONG UNIT.
//
// WhatsApp meters introductions that never got a REPLY. We counted
// introductions SENT. A traveller whose shops all answered had spent nothing
// risk-bearing and was throttled anyway; one sitting on twenty silent threads
// was waved through.
//
// Two things had to be true before that could be fixed, and only the second is
// obvious:
//
//   1. one row per shop, whatever spelling arrived - otherwise the reply stamp
//      and the introduction stamp land on DIFFERENT rows and the whole ledger
//      is fiction;
//   2. a WINDOW on the open-thread count, or the meter saturates and pins the
//      user at zero forever.

describe("one shop, one row - the split that made the ledger fiction", () => {
  it("the two spellings of a number agree on the tail", () => {
    // Our send carries discovery's spelling, the shop's reply carries
    // WhatsApp's. Same line, different strings.
    expect(nationalTail("66812345678")).toBe(nationalTail("0812345678"));
    expect(nationalTail("+66 81 234 5678")).toBe(nationalTail("66812345678"));
    expect(nationalTail("639661952196")).toBe(nationalTail("09661952196"));
  });

  it("different shops do not collide", () => {
    expect(nationalTail("66812345678")).not.toBe(nationalTail("66812345679"));
  });

  it("a number too short to identify a line yields no key", () => {
    // Better to fall back to exact matching than to merge two shops.
    expect(nationalTail("1234")).toBe("");
    expect(nationalTail("")).toBe("");
  });

  it("upsertRecipient looks up by tail, with an exact-match fallback", () => {
    const fn = guard.slice(
      guard.indexOf("async function upsertRecipient"),
      guard.indexOf("async function stampRecipientFirst")
    );
    expect(fn).toMatch(/nationalTail\(toNumber\)/);
    expect(fn).toMatch(/to_tail=eq\./);
    // Legacy rows written before the column existed must be ADOPTED, not
    // duplicated.
    expect(fn).toMatch(/to_number=eq\./);
    // The adopted legacy row gets its tail written, so the next lookup finds
    // it by tail and the duplicate never appears. (Asserted on the CODE, not
    // the comment - readCode strips comments.)
    expect(fn).toMatch(/\.\.\.\(tail \? \{ to_tail: tail \} : \{\}\)/);
  });

  it("the new-contact check is tail-keyed too", () => {
    // Exact-matching here counted an already-running thread as brand new and
    // burned a fresh contact slot on it.
    const fn = guard.slice(
      guard.indexOf("async function recordOutboundSend"),
      guard.indexOf("async function recordOutboundSend") + 1800
    );
    expect(fn).toMatch(/const tail = nationalTail\(toNumber\)/);
    expect(fn).toMatch(/to_tail=eq\./);
  });
});

describe("milestones are write-once", () => {
  const fn = guard.slice(
    guard.indexOf("async function stampRecipientFirst"),
    guard.indexOf("async function stampRecipientFirst") + 1400
  );

  it("an already-stamped milestone is never moved", () => {
    // The second reply does not reset the first, and re-stamping would silently
    // reset the AGE of an open thread - which is the only thing the window
    // measures.
    expect(fn).toMatch(/if \(row\?\.\[field\]\) return;/);
  });

  it("it can never block a send or an ingest", () => {
    expect(fn).toMatch(/catch \{[\s\S]{0,120}\}/);
  });

  it("both milestones are actually stamped by the events that define them", () => {
    expect(guard).toMatch(/stampRecipientFirst\(senderKey, toNumber, "first_intro_at"\)/);
    expect(guard).toMatch(/stampRecipientFirst\(senderKey, fromNumber, "first_reply_at"\)/);
  });
});

describe("two meters, because the refund question is genuinely open", () => {
  const fn = guard.slice(
    guard.indexOf("export async function unansweredMeters"),
    guard.indexOf("export const MONTHLY_NON_REPLIER_WARN")
  );

  it("Meter A is WINDOWED - this is the anti-saturation guarantee", () => {
    // An unwindowed "unanswered ever" cap saturates: non-repliers never clear,
    // so at q=0.35 and 24 intros/day the open pool grows ~15/day and by day
    // three the traveller is pinned at zero capacity forever. That is strictly
    // worse than the sent-count it replaces.
    expect(fn).toMatch(/first_intro_at=gte\./);
    expect(guard).toMatch(/UNANSWERED_WINDOW_DAYS = 7/);
  });

  it("Meter B is the monthly accumulator, aligned to the calendar cycle", () => {
    expect(fn).toMatch(/last_sent_at=gte\./);
    expect(fn).toMatch(/monthStart/);
  });

  it("both meters count only shops that never replied", () => {
    expect((fn.match(/first_reply_at=is\.null/g) ?? []).length).toBe(2);
  });

  it("both reads are STRICT so an unreadable meter is visible", () => {
    expect((fn.match(/sbSelectStrict/g) ?? []).length).toBe(2);
    expect(fn).toMatch(/unreadable: openUnreadable \|\| monthUnreadable/);
  });
});

describe("admission is the minimum, and it degrades safely", () => {
  // The budget-computation logic moved into computeNewContactBudget behind a
  // short-TTL caching wrapper (OR11 E2.2); the logic these cases pin lives there.
  const fn = guard.slice(
    guard.indexOf("async function computeNewContactBudget"),
    guard.indexOf("async function computeNewContactBudget") + 3600
  );

  it("takes the lowest of the sent budget and both meters", () => {
    expect(fn).toMatch(/Math\.min\(/);
    expect(fn).toMatch(/openHeadroom/);
    expect(fn).toMatch(/monthHeadroom/);
  });

  it("a meter that could not be read does not silently throttle the user", () => {
    // Infinity here means "this meter has no opinion" - the plan's sent-count
    // and the strict intro read still bind, so the budget is not opened.
    expect(fn).toMatch(/Number\.POSITIVE_INFINITY/);
  });

  it("an unreadable meter still re-checks in minutes", () => {
    expect(fn).toMatch(/meters\?\.unreadable/);
  });

  it("the meters are surfaced, not just consumed", () => {
    // A budget the owner cannot inspect is a budget nobody can debug.
    expect(fn).toMatch(/openUnanswered: meters\?\.openInWindow/);
    expect(fn).toMatch(/monthlyToNonRepliers: meters\?\.monthlyToNonRepliers/);
  });
});
