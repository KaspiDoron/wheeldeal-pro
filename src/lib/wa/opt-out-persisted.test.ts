import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F013 - the opt-out stamp DISCARDED its write result.
//
// A shop says "please stop messaging me". markRecipientOptedOut upserted
// wa_recipient_state.opted_out_at, threw away the sb* boolean, returned void,
// and wrote a wa-opt-out event whose own text asserted "every future send to
// this number is refused". With the store timing out or answering 5xx, no
// stamp landed, guardOutbound's veto (a pure row read) found nothing, and the
// composed reply went out to the shop that had just said stop - with a
// breadcrumb claiming the opposite. Every test here RUNS the real functions
// against a store whose recipient writes can be made to fail.

const db = vi.hoisted(() => ({
  recipientWritesLand: true,
  recipientWrites: 0,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("../runtime-config", () => ({
  sbSelect: vi.fn(async () => []),
  sbSelectStrict: vi.fn(async () => ({ rows: [] })),
  sbInsert: vi.fn(async (table: string, rows: Array<Record<string, unknown>>) => {
    if (table === "agent_events") {
      db.events.push(...rows);
      return true;
    }
    if (table === "wa_recipient_state") {
      db.recipientWrites += 1;
      return db.recipientWritesLand;
    }
    return true;
  }),
  sbUpdate: vi.fn(async (table: string) => {
    if (table === "wa_recipient_state") {
      db.recipientWrites += 1;
      return db.recipientWritesLand;
    }
    return true;
  }),
  sbDelete: vi.fn(async () => true),
  sbDeleteReturning: vi.fn(async () => []),
  sbInsertClaim: vi.fn(async () => "won" as const),
  getConfig: vi.fn(async () => undefined),
  getConfigExact: vi.fn(async () => undefined),
  getConfigFresh: vi.fn(async () => ({ value: undefined })),
  setConfig: vi.fn(async () => ({ ok: true, persistent: true })),
  supabaseConfigured: () => true,
  pgTimestamp: (d: Date) => d.toISOString(),
}));

vi.mock("../ai", () => ({
  chat: vi.fn(async () => null),
  extractJson: () => null,
}));

import { guardOutbound, markRecipientOptedOut } from "../wa-guard";

const SENDER = "traveller@example.com";
const JID_DIGITS = "639776620146"; // the inbound spelling the stop arrives under
const OUTBOX_DIGITS = "09776620146"; // the outbox row's spelling of the same shop

const optOutEvents = () => db.events.filter((e) => e.kind === "wa-opt-out");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  db.recipientWritesLand = true;
  db.recipientWrites = 0;
  db.events = [];
});

describe("EXECUTED: a stop whose stamp did not land is reported honestly", () => {
  it("returns false, and the wa-opt-out event says NOT PERSISTED instead of asserting a refusal", async () => {
    db.recipientWritesLand = false;
    const persisted = await markRecipientOptedOut(SENDER, "639770000001", "Shop A");
    expect(persisted).toBe(false);
    const ev = optOutEvents();
    expect(ev).toHaveLength(1);
    expect(String(ev[0].detail)).toMatch(/not persisted/i);
    expect(String(ev[0].detail)).not.toMatch(/every future send to this number is refused/);
  });

  it("returns true when the stamp landed, and the event asserts the refusal it can now back", async () => {
    const persisted = await markRecipientOptedOut(SENDER, "639771111111", "Shop B");
    expect(persisted).toBe(true);
    expect(String(optOutEvents()[0]?.detail)).toMatch(/every future send to this number is refused/);
  });

  it("retries the stamp ONCE, off the reply path, and it lands when the store recovers", async () => {
    db.recipientWritesLand = false;
    const persisted = await markRecipientOptedOut(SENDER, "639772222222", "Shop C");
    expect(persisted).toBe(false);
    const attemptsOnReplyPath = db.recipientWrites;
    // The store recovers a moment later; the deferred retry must land the
    // stamp WITHOUT the reply path having waited for it.
    db.recipientWritesLand = true;
    await sleep(400);
    expect(db.recipientWrites).toBeGreaterThan(attemptsOnReplyPath);
  });
});

describe("EXECUTED: this instance still refuses the turn's reply when no stamp is in the store", () => {
  it("guardOutbound vetoes the AUTOMATED reply terminally, with the opt-out reason", async () => {
    db.recipientWritesLand = false;
    await markRecipientOptedOut(SENDER, "639773333333", "Shop D");
    // The store holds no opted_out_at row (every recipient read returns []).
    // THE ASSERTION THAT FAILED BEFORE: with nothing durable to read, the veto
    // was blind and the composed reply proceeded.
    const v = await guardOutbound({
      senderKey: SENDER,
      toDigits: "639773333333",
      text: "Sure, I can do 250 per day for 3 days - deal?",
      auto: true,
      queueIfBlocked: false,
    });
    expect(v.allow).toBe(false);
    expect(v.terminal).toBe(true);
    expect(v.reason).toMatch(/opted-out/);
  });

  it("...and a MANUAL send too - the shop's request was about being contacted at all", async () => {
    db.recipientWritesLand = false;
    await markRecipientOptedOut(SENDER, "639774444444", "Shop E");
    const v = await guardOutbound({
      senderKey: SENDER,
      toDigits: "639774444444",
      text: "hey, can I pick it up at 6?",
      auto: false,
      queueIfBlocked: false,
    });
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/opted-out/);
  });

  it("...under the OTHER spelling of the same shop (the drain's outbox row)", async () => {
    db.recipientWritesLand = false;
    await markRecipientOptedOut(SENDER, JID_DIGITS, "Shop F");
    const v = await guardOutbound({
      senderKey: SENDER,
      toDigits: OUTBOX_DIGITS,
      text: "Still interested - is the 125cc free from Monday?",
      auto: true,
      queueIfBlocked: false,
    });
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/opted-out/);
  });

  it("a DIFFERENT shop, and a different traveller, are untouched", async () => {
    db.recipientWritesLand = false;
    await markRecipientOptedOut(SENDER, "639775555555", "Shop G");
    const other = await guardOutbound({
      senderKey: SENDER,
      toDigits: "639776666666",
      text: "Hi! Do you have a scooter for 3 days?",
      auto: false,
      queueIfBlocked: false,
    });
    expect(other.reason ?? "").not.toMatch(/opted-out/);
    const otherTraveller = await guardOutbound({
      senderKey: "someone-else@example.com",
      toDigits: "639775555555",
      text: "Hi! Do you have a scooter for 3 days?",
      auto: false,
      queueIfBlocked: false,
    });
    expect(otherTraveller.reason ?? "").not.toMatch(/opted-out/);
  });
});
