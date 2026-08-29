// STEP 7-9 MECHANICS (funnel: verifying -> shop_confirmed -> presented).
//
// The findings these pin: `present` was a dead end whose composed text went to
// the SHOP; a complete deal had no shop-facing confirmation step at all; a
// priced thread whose outstanding question the shop ignored froze forever
// (both bounds only evaluated when a turn happened, and a silent shop causes
// no turns); and mergeDigest silently DROPPED priceWatchArmed, so the
// once-ever price watch re-armed on every qualifying turn.
import { describe, it, expect } from "vitest";
import type { ThreadDigest, TurnArtifact, TurnContext, VerifiedExtraction } from "./types";
import { legalMovesFor } from "./policy";
import { templateFor } from "./pass";
import { advanceConfirmState, mergeDigest, emptyDigest, CONFIRM_WAIT_MS, persistableDigest, digestFromStored, mergeStoredDigests } from "./digest";

function ctx(partial: {
  digest?: Partial<ThreadDigest>;
  verified?: Partial<VerifiedExtraction>;
  event?: TurnContext["event"];
  nowMs?: number;
  presented?: boolean;
}): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: {
        vehicleClass: "scooter",
        transmission: "any",
        durationDays: 4,
        accessories: [],
        fulfillment: "any",
        vendorMessage: "",
      },
      currency: "THB",
      benchmark: null,
      lowest: null,
      rivals: [],
    },
    thread: {
      threadKey: "t@x.com:66812345678",
      vendorId: "v1",
      shop: "Krabi Bikes",
      digest: { ...emptyDigest(), ...partial.digest },
      presented: partial.presented,
    },
    nowMs: partial.nowMs,
    tail: [],
    inbound: { text: "", verified: { found: false, ...partial.verified } },
    legalMoves: [],
    guards: { maxRounds: 4 },
    event: partial.event ?? "shop-message",
  };
}

const COMPLETE: Partial<ThreadDigest> = {
  quotedPricePerDay: 250,
  firmCount: 2,
  depositKnown: true,
  fulfillmentKnown: true,
  comprehension: { depositKind: "document", handoverMode: "delivery" },
};

describe("the recap template - grounded by construction", () => {
  it("recaps the standing quote verbatim with the known terms, and asks to confirm", () => {
    const c = ctx({ digest: COMPLETE, verified: { currency: "THB" } });
    const t = templateFor(c, "verify-recap")!;
    expect(t).toContain("250 THB/day");
    expect(t).toContain("4 days");
    expect(t.toLowerCase()).toContain("passport as deposit");
    expect(t.toLowerCase()).toContain("delivered");
    expect(t.toLowerCase()).toContain("correct");
    // Grounded: the only digits in it are the quote and the duration.
    const nums = t.match(/\d+/g) ?? [];
    expect(new Set(nums)).toEqual(new Set(["250", "4"]));
  });

  it("asks the UNKNOWN subjects inside the recap instead of guessing", () => {
    const c = ctx({
      digest: { quotedPricePerDay: 250, firmCount: 2 },
      verified: { currency: "THB" },
    });
    const t = templateFor(c, "verify-recap")!;
    expect(t.toLowerCase()).toContain("what deposit you need");
    expect(t.toLowerCase()).toContain("deliver or i collect");
  });

  it("no price, no recap - a recap without a number is not a recap", () => {
    expect(templateFor(ctx({ digest: {} }), "verify-recap")).toBeUndefined();
  });
});

describe("the priced-thread dead end is rescued on re-entry", () => {
  // The reproduction from the audit: price known, bargaining retired, the
  // handover question asked and never answered (ledger holds it outstanding so
  // the probe is stripped), dealComplete false. The old ladder: ["silent"],
  // forever.
  const DEAD_END: Partial<ThreadDigest> = {
    quotedPricePerDay: 250,
    firmCount: 2,
    depositKnown: true,
    // fulfillment NOT known - and already asked (outstanding holds it, so the
    // ask-once gate strips the probe; that is the freeze).
    ledger: {
      claims: [],
      known: [],
      outstanding: ["handover"],
      owed: [],
      askedOfUs: [],
    } as unknown as ThreadDigest["ledger"],
  };

  it("a tick turn on the dead-end thread gets ONE recap with the unknown asked inside", () => {
    const legal = legalMovesFor(ctx({ digest: DEAD_END, event: "tick" }));
    expect(legal).toContain("verify-recap");
  });

  it("the same thread mid-conversation does not - the shop just spoke, answer flow first", () => {
    const legal = legalMovesFor(ctx({ digest: DEAD_END, event: "shop-message" }));
    expect(legal).not.toContain("verify-recap");
  });

  it("the rescue respects the once latch", () => {
    const legal = legalMovesFor(ctx({ digest: { ...DEAD_END, recapSent: true }, event: "tick" }));
    expect(legal).not.toContain("verify-recap");
  });
});

describe("present after the recap - confirmed, or expired with the honest caveat", () => {
  it("an unanswered recap holds present until the wall clock releases it", () => {
    const sentAt = 1_700_000_000_000;
    const base = { ...COMPLETE, recapSent: true, recapSentAt: sentAt };
    // Before the bound: neither recap (latched) nor present (unconfirmed).
    const early = legalMovesFor(ctx({ digest: base, nowMs: sentAt + 10 * 60_000 }));
    expect(early).not.toContain("present");
    expect(early).not.toContain("verify-recap");
    // Past the bound: present becomes legal - waiting forever on a shop that
    // already stated every term serves nobody.
    const late = legalMovesFor(ctx({ digest: base, nowMs: sentAt + CONFIRM_WAIT_MS + 60_000 }));
    expect(late).toContain("present");
  });

  it("replays (no clock) never expire the recap - determinism holds", () => {
    const base = { ...COMPLETE, recapSent: true, recapSentAt: 1_700_000_000_000 };
    expect(legalMovesFor(ctx({ digest: base }))).not.toContain("present");
  });
});

describe("the confirm wait gains its wall-clock bound", () => {
  const WAITING: ThreadDigest = {
    ...emptyDigest(),
    pending: [
      { subject: "deposit", question: "passport or 4000 cash?", state: "waiting", turns: 0, at: 1_700_000_000_000 },
    ],
  };

  it("a shop that never replies releases on the clock, with the never-answered note", () => {
    const released = advanceConfirmState(WAITING, [], 1_700_000_000_000 + CONFIRM_WAIT_MS + 1);
    expect(released.pending).toBeUndefined();
    expect(released.facts.some((f) => f.includes("never answered"))).toBe(true);
  });

  it("inside the bound the wait holds; without a clock (replay) turns alone govern", () => {
    const held = advanceConfirmState(WAITING, [], 1_700_000_000_000 + 60_000);
    expect(held.pending).toHaveLength(1);
    const noClock = advanceConfirmState(WAITING, []);
    expect(noClock.pending).toHaveLength(1);
  });
});

describe("mergeDigest carries the step 7-8 state - and the once-flags it used to drop", () => {
  const artifact = (move: TurnArtifact["move"]): TurnArtifact => ({
    read: { intent: "" },
    think: "",
    move,
    leverageUsed: [],
    digestPatch: [],
  });
  const v: VerifiedExtraction = { found: false };

  it("the verify-recap move latches recapSent deterministically", () => {
    const out = mergeDigest({ ...emptyDigest(), quotedPricePerDay: 250 }, artifact("verify-recap"), v);
    expect(out.recapSent).toBe(true);
  });

  it("recap clocks and priceWatchArmed survive the merge (the silent re-arm fix)", () => {
    const prev: ThreadDigest = {
      ...emptyDigest(),
      priceWatchArmed: true,
      oweWatchArmed: true,
      recapSent: true,
      recapSentAt: 123,
      recapConfirmedAt: 456,
    };
    const out = mergeDigest(prev, artifact("silent"), v);
    // priceWatchArmed was DROPPED here before this fix, so the "once, ever"
    // watch re-armed on every qualifying silent turn.
    expect(out.priceWatchArmed).toBe(true);
    expect(out.oweWatchArmed).toBe(true);
    expect(out.recapSent).toBe(true);
    expect(out.recapSentAt).toBe(123);
    expect(out.recapConfirmedAt).toBe(456);
  });

  it("the whole step-7 state round-trips through persistence", () => {
    const d: ThreadDigest = {
      ...emptyDigest(),
      recapSent: true,
      recapSentAt: 123,
      recapConfirmedAt: 456,
      recapAmended: true,
      oweWatchArmed: true,
      pending: [{ subject: "deposit", question: "q", state: "waiting", turns: 1, at: 789 }],
    };
    const back = digestFromStored(persistableDigest(d));
    expect(back.recapSent).toBe(true);
    expect(back.recapSentAt).toBe(123);
    expect(back.recapConfirmedAt).toBe(456);
    expect(back.recapAmended).toBe(true);
    expect(back.oweWatchArmed).toBe(true);
    expect(back.pending?.[0].at).toBe(789);
  });
});

describe("the lost-race digest union - what a version race may no longer erase", () => {
  it("the loser's freshly-learned facts, quote, doubts and once-flags all survive", () => {
    // The reproduction: a tick turn (winner - knows little) races an inbound
    // turn (ours - just read the deposit and the quote). The old merge kept
    // `...winner.fields` and OUR digest vanished; the next turn re-asked.
    const winner = persistableDigest({
      ...emptyDigest(),
      facts: ["shop is friendly"],
      round: 1,
      priceWatchArmed: true,
    });
    const ours = persistableDigest({
      ...emptyDigest(),
      facts: ["deposit stated: 3000 cash"],
      quotedPricePerDay: 250,
      round: 2,
      comprehension: { depositStated: true, depositKind: "cash", firmTurns: 1 },
      pending: [{ subject: "deposit", question: "cash or passport?", state: "waiting", turns: 1, at: 5 }],
      confirmAsked: ["deposit"],
      recapSent: true,
      recapSentAt: 123,
    });
    const merged = digestFromStored(mergeStoredDigests(winner, ours));
    expect(merged.facts).toContain("shop is friendly");
    expect(merged.facts).toContain("deposit stated: 3000 cash");
    expect(merged.quotedPricePerDay).toBe(250);
    expect(merged.round).toBe(2);
    expect(merged.comprehension?.depositStated).toBe(true);
    expect(merged.pending?.[0].subject).toBe("deposit");
    expect(merged.pending?.[0].at).toBe(5);
    expect(merged.confirmAsked).toContain("deposit");
    expect(merged.priceWatchArmed).toBe(true);
    expect(merged.recapSent).toBe(true);
    expect(merged.recapSentAt).toBe(123);
  });

  it("latches OR across both sides; events take the max", () => {
    const a = persistableDigest({ ...emptyDigest(), comprehension: { firmTurns: 2, closed: true } });
    const b = persistableDigest({ ...emptyDigest(), comprehension: { firmTurns: 1, handoverCostKnown: true } });
    const merged = digestFromStored(mergeStoredDigests(a, b));
    expect(merged.comprehension?.firmTurns).toBe(2);
    expect(merged.comprehension?.closed).toBe(true);
    expect(merged.comprehension?.handoverCostKnown).toBe(true);
  });

  it("the state layer actually calls it on the lost race", () => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const state = readFileSync(`${process.cwd()}/src/lib/graph/state.ts`, "utf8");
    expect(state).toContain("mergeStoredDigests(");
    expect(state).toMatch(/winner\.fields\.digest,\s*\n\s*next\.fields\.digest/);
  });
});

describe("present is state-only on the live path", () => {
  it("the send decision excludes present, and markPresentable fires for it", () => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const live = readFileSync(`${process.cwd()}/src/lib/spte/live.ts`, "utf8");
    expect(live).toMatch(/outcome\.move !== "silent" && outcome\.move !== "present"/);
    expect(live).toMatch(/if \(outcome\.move === "present"\) \{\s*\n\s*await io\s*\n?\s*\.markPresentable/);
  });
});
