import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// W8.1 - "...THEN WAIT FOR THE SHOP ANSWER", and the doubt that must survive
// until they give one.
//
// The owner's rule has two clauses and only the first shipped:
//
//   "if the ai agents not sure about something - they should ask the shop
//    'wait, you mean that I can deposit a passport or cash 4000?' THEN WAIT FOR
//    THE SHOP ANSWER."
//
// Two structural holes, both proven against the shipped code:
//
//   THE DOUBT WAS NOT DURABLE. `verified.uncertain` is rebuilt from the CURRENT
//   message and `digest.depositKnown` is a regex over ALL inbound text, so the
//   moment the ambiguous message scrolled into history the engine decided it
//   knew the deposit again - on the very reading it had told itself not to
//   trust. Worse, `policy.depositKnown` OR-ed in a scan of the durable model
//   notes (`digest.facts`) that the ambiguity never suppressed, so the deposit
//   re-latched from the notes alone and `present` went legal.
//
//   THE WAIT WAS NOT ENFORCED. `awaitingConfirmation` was derived from the
//   current turn, so a scheduled tick - which carries no message at all - erased
//   it and left `bargain` legal. The agent asked its question and then, with no
//   answer, pushed on price.
//
// Everything below runs the REAL ladder and the REAL state machine.

import { legalMovesFor, confirmableSubjects, waitingOn } from "./policy";
import {
  advanceConfirmState,
  digestFromStored,
  emptyDigest,
  mergeDigest,
  persistableDigest,
  CONFIRM_WAIT_TURNS,
  CONFIRM_OPEN_TURNS,
} from "./digest";
import type {
  PendingConfirm,
  ThreadDigest,
  TurnArtifact,
  TurnContext,
  Uncertainty,
  VerifiedExtraction,
} from "./types";

const DOUBT: Uncertainty = {
  subject: "deposit",
  reading: "they want the passport held",
  question: "wait - you mean I can leave a passport OR 4,000 cash?",
  confidence: 0.45,
};

const WAITING: PendingConfirm = {
  subject: "deposit",
  reading: DOUBT.reading,
  question: DOUBT.question,
  confidence: DOUBT.confidence,
  state: "waiting",
  turns: 0,
};

/** A thread that has everything a full deal needs - a standing quote, the
 *  handover settled, and the deposit "known" from BOTH sources the audit named:
 *  the derived flag and the model's durable notes. */
function completeDigest(over: Partial<ThreadDigest> = {}): ThreadDigest {
  return {
    ...emptyDigest(),
    facts: ["quoted 300 THB/day", "deposit: passport or money4000", "pickup at the shop"],
    quotedPricePerDay: 300,
    depositKnown: true,
    fulfillmentKnown: true,
    ...over,
  };
}

function ctx(partial: {
  verified?: VerifiedExtraction;
  digest?: ThreadDigest;
  text?: string;
  event?: TurnContext["event"];
}): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: {
        vehicleClass: "scooter",
        engineSizeCc: 125,
        transmission: "automatic",
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
    thread: { threadKey: "u:66", vendorId: "v1", shop: "Shop A", digest: partial.digest ?? emptyDigest() },
    tail: [],
    inbound: { text: partial.text ?? "", verified: partial.verified ?? { found: false } },
    legalMoves: [],
    guards: { maxRounds: 4, floorPerDay: 150 },
    event: partial.event ?? "shop-message",
  };
}

// ---------------------------------------------------------------------------
// FIX 2 - the ambiguity is DURABLE, so "unsure" cannot evaporate
// ---------------------------------------------------------------------------

describe("an unconfirmed deposit does not read as known - from ANY source", () => {
  it("THE AUDIT'S REPRODUCTION: the durable notes cannot re-latch it", () => {
    // The ambiguous message is now history: this turn carries no uncertainty of
    // its own, and `digest.facts` carries the deposit line. That is the exact
    // shape that made `depositKnown` true again and `present` legal.
    const withDoubt = ctx({
      digest: completeDigest({ pending: [{ ...WAITING, state: "open" }] }),
      verified: { found: false },
    });
    const legal = legalMovesFor(withDoubt);
    expect(legal).not.toContain("present");
    expect(legal).not.toContain("verify-recap");
    // ...while the very same thread WITHOUT the carried doubt moves to step 7
    // (the shop-facing recap - `present` itself comes only after the shop
    // confirms it), so this test cannot pass by accident on a thread that was
    // never complete.
    expect(legalMovesFor(ctx({ digest: completeDigest(), verified: { found: false } }))).toContain(
      "verify-recap"
    );
  });

  it("a doubt raised turns ago is still askable, with the words it was raised in", () => {
    // Nothing is uncertain about THIS message; the thread is still unsure.
    const c = ctx({ digest: completeDigest({ pending: [{ ...WAITING, state: "open" }] }) });
    const subjects = confirmableSubjects(c);
    expect(subjects.map((s) => s.subject)).toEqual(["deposit"]);
    expect(subjects[0].question).toBe(DOUBT.question);
    expect(legalMovesFor(c)).toContain("confirm");
  });

  it("the doubt is written to the DURABLE digest and survives a round trip", () => {
    const artifact: TurnArtifact = {
      read: { intent: "" },
      think: "",
      move: "bargain",
      leverageUsed: [],
      digestPatch: [],
    };
    // The model flagged it; we did NOT ask this turn (the move was a bargain).
    const merged = mergeDigest(emptyDigest(), artifact, { found: false, uncertain: [DOUBT] });
    expect(merged.pending?.[0]).toMatchObject({ subject: "deposit", state: "open", turns: 0 });

    const stored = persistableDigest(merged);
    expect(stored.pending?.[0].question).toBe(DOUBT.question);
    const read = digestFromStored(JSON.parse(JSON.stringify(stored)));
    expect(read.pending?.[0]).toMatchObject({ subject: "deposit", state: "open" });
    // ...and a thread seeded from that row still refuses to call the deposit known.
    expect(
      legalMovesFor(ctx({ digest: { ...completeDigest(), pending: read.pending } }))
    ).not.toContain("present");
  });

  it("...and no doubt of ANY kind is presented as settled terms", () => {
    // `present` is where an internal reading becomes THE TERMS, so a doubt about
    // the price is as disqualifying as one about the deposit - the owner's rule
    // is "anything", not "the deposit".
    const priceDoubt: PendingConfirm = {
      subject: "price",
      question: "is 300 per day, or for the whole 4 days?",
      state: "open",
      turns: 0,
    };
    expect(
      legalMovesFor(ctx({ digest: completeDigest({ pending: [priceDoubt] }) }))
    ).not.toContain("present");
  });

  it("a row written before the field existed keeps waiting, not resumes", () => {
    // `awaitingConfirmation` is the card's mirror of a live wait. A thread
    // mid-question at deploy time must not quietly carry on without an answer.
    const read = digestFromStored({
      facts: [],
      round: 0,
      awaitingConfirmation: { subject: "deposit", question: DOUBT.question },
    });
    expect(read.pending?.[0]).toMatchObject({ subject: "deposit", state: "waiting" });
  });
});

// ---------------------------------------------------------------------------
// FIX 3 - the WAIT is enforced, and bounded
// ---------------------------------------------------------------------------

describe("once we have asked, the thread waits", () => {
  const waitingThread = (over: Partial<ThreadDigest> = {}) =>
    completeDigest({
      pending: [WAITING],
      awaitingConfirmation: { subject: "deposit", question: DOUBT.question },
      confirmAsked: ["deposit"],
      ...over,
    });

  it("A TICK CANNOT BARGAIN AWAY THE QUESTION", () => {
    // The reproduction: a scheduled wakeup fires while we wait. It used to erase
    // the pending state and leave `bargain` legal on the standing quote.
    const legal = legalMovesFor(ctx({ digest: waitingThread(), event: "tick" }));
    expect(legal).toEqual(["silent"]);
    expect(legal).not.toContain("bargain");
  });

  it("...nor can a swarm poke, nor an unrelated inbound message", () => {
    for (const event of ["rival-improved", "shop-message"] as const) {
      const legal = legalMovesFor(
        ctx({
          digest: waitingThread(),
          event,
          text: "Do you want a helmet too?",
          verified: { found: true, pricePerDay: 300 },
        })
      );
      expect(legal).not.toContain("bargain");
      expect(legal).not.toContain("present");
      expect(legal).not.toContain("deposit-probe");
    }
  });

  it("a shop waiting on US is still owed its reply - and nothing more", () => {
    const legal = legalMovesFor(
      ctx({ digest: waitingThread(), verified: { found: false, askedQuestion: true } })
    );
    expect(legal[0]).toBe("answer");
    expect(legal).not.toContain("bargain");
  });

  it("a shop that declines or runs out while we wait still gets its answer", () => {
    // The wait sits BELOW the terminal branches: a goodbye is owed, not a stare.
    expect(
      legalMovesFor(ctx({ digest: waitingThread(), verified: { found: false, declined: true } }))
    ).toContain("farewell");
    expect(
      legalMovesFor(
        ctx({ digest: waitingThread(), verified: { found: false, shopUnavailable: true } })
      )
    ).toContain("restock-probe");
  });

  it("the wait survives every turn until the MODEL says they answered", () => {
    let d = waitingThread();
    for (let i = 0; i < CONFIRM_WAIT_TURNS; i++) {
      d = advanceConfirmState(d, []);
      expect(waitingOn(ctx({ digest: d }))).toBeTruthy();
      expect(legalMovesFor(ctx({ digest: d, event: "tick" }))).toEqual(["silent"]);
    }
    const answered = advanceConfirmState(d, ["deposit"]);
    expect(answered.pending).toBeUndefined();
    expect(answered.awaitingConfirmation).toBeNull();
    // The thread moves again - and only now. This deal is complete once the
    // deposit is settled, so the move it was held back from is step 7: the
    // shop-facing verify-recap (`present` comes only after the shop confirms).
    expect(legalMovesFor(ctx({ digest: answered, verified: { found: false } }))).toContain(
      "verify-recap"
    );
  });

  it("...and a shop that NEVER answers cannot freeze the thread forever", () => {
    let d = waitingThread();
    for (let i = 0; i < CONFIRM_WAIT_TURNS + 1; i++) d = advanceConfirmState(d, []);
    expect(d.pending).toBeUndefined();
    expect(d.awaitingConfirmation).toBeNull();
    // Released, but never as "they confirmed it": the durable note says the
    // opposite, so nothing downstream can present the reading as settled terms.
    expect(d.facts.join(" ")).toMatch(/never answered/i);
    expect(d.facts.join(" ")).not.toMatch(/confirmed the deposit/i);
  });

  it("a doubt nobody ever asks about is released too - no deadlock", () => {
    let d = completeDigest({ pending: [{ ...WAITING, state: "open" }] });
    for (let i = 0; i < CONFIRM_OPEN_TURNS + 1; i++) d = advanceConfirmState(d, []);
    expect(d.pending).toBeUndefined();
  });

  it("asking flips the doubt to WAITING, once, with the question we sent", () => {
    const artifact: TurnArtifact = {
      read: { intent: "" },
      think: "",
      move: "confirm",
      confirmSubject: "deposit",
      message: DOUBT.question,
      leverageUsed: [],
      digestPatch: [],
    };
    const d = mergeDigest(emptyDigest(), artifact, { found: false, uncertain: [DOUBT] });
    expect(d.pending).toEqual([
      {
        subject: "deposit",
        reading: DOUBT.reading,
        question: DOUBT.question,
        confidence: DOUBT.confidence,
        state: "waiting",
        turns: 0,
      },
    ]);
    expect(d.awaitingConfirmation).toEqual({ subject: "deposit", question: DOUBT.question });
    // A shop repeating the same ambiguous thing does not buy a fresh wait.
    const aged = advanceConfirmState(d, []);
    const restated = mergeDigest(aged, { ...artifact, move: "silent" }, {
      found: false,
      uncertain: [DOUBT],
    });
    expect(restated.pending?.[0].turns).toBe(1);
    expect(restated.pending?.[0].state).toBe("waiting");
  });
});

// ---------------------------------------------------------------------------
// THE EXIT IS A MODEL JUDGEMENT, NOT A KEYWORD TEST (owner doctrine)
// ---------------------------------------------------------------------------

const ai = vi.hoisted(() => ({
  answer: null as unknown,
  stance: null as unknown,
  calls: [] as string[],
}));

vi.mock("../ai", () => ({
  chat: async () => null,
  extractJson: (t: string) => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  },
  chatDetailed: async (msgs: Array<{ role: string; content: string }>) => {
    const system = msgs[0]?.content ?? "";
    ai.calls.push(system);
    // One stub, routed by which judgement it was handed - the same shape the
    // comprehension suite uses. Everything else (composition included) answers
    // nothing, so the deterministic templates run.
    if (system.includes("waiting for their reply")) {
      return ai.answer ? { text: JSON.stringify(ai.answer), provider: "groq" } : { text: null };
    }
    if (system.includes("where does this shop stand")) {
      return ai.stance ? { text: JSON.stringify(ai.stance), provider: "groq" } : { text: null };
    }
    return { text: null };
  },
}));

describe("did they answer? - the model decides, the code only counts turns", () => {
  beforeEach(() => {
    ai.answer = null;
    ai.calls = [];
  });

  it("a reply that settles it ends the wait, in the shop's own way of saying so", async () => {
    // No keyword in this sentence says "passport" or "cash". A phrase list has
    // nothing to match; a model reading the question knows exactly what it is.
    ai.answer = { answered: true, answer: "either is fine", stillUnclear: false, confidence: 0.9 };
    const { readConfirmResolution } = await import("./comprehension");
    const r = await readConfirmResolution({ pending: WAITING, text: "up to you, both ok 👍" });
    expect(r?.answered).toBe(true);
    expect(ai.calls.some((c) => c.includes(DOUBT.question))).toBe(true);
  });

  it("a friendly non-answer does NOT end it", async () => {
    ai.answer = { answered: false, answer: null, stillUnclear: false, confidence: 0.9 };
    const { readConfirmResolution } = await import("./comprehension");
    const r = await readConfirmResolution({ pending: WAITING, text: "we open at 9am!" });
    expect(r?.answered).toBe(false);
  });

  it("an answer that leaves us no wiser does not end it either", async () => {
    ai.answer = { answered: true, answer: null, stillUnclear: true, confidence: 0.95 };
    const { readConfirmResolution } = await import("./comprehension");
    expect((await readConfirmResolution({ pending: WAITING, text: "yes deposit" }))?.answered).toBe(
      false
    );
  });

  it("a model that is not sure it was an answer does not end it", async () => {
    ai.answer = { answered: true, answer: "maybe", stillUnclear: false, confidence: 0.3 };
    const { readConfirmResolution } = await import("./comprehension");
    expect((await readConfirmResolution({ pending: WAITING, text: "ok" }))?.answered).toBe(false);
  });

  it("NO PROVIDER -> patience, never a manufactured answer", async () => {
    ai.answer = null;
    const { readConfirmResolution } = await import("./comprehension");
    const r = await readConfirmResolution({ pending: WAITING, text: "ok" });
    expect(r?.answered).toBe(false);
    expect(r?.degraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// END TO END on the live turn: ask, then a wakeup fires, and the thread WAITS.
// This is the reproduction the audit ran - the tick used to erase the pending
// state and send a bargain against a question nobody had answered.
// ---------------------------------------------------------------------------

import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "../graph/types";

function liveIo() {
  const saved: NegotiationThreadState[] = [];
  const sent: string[] = [];
  let stored: NegotiationThreadState | null = null;
  const io = {
    now: () => 1_000_000,
    sessionTable: async () => [],
    loadState: async () => (stored ? { ...stored } : null),
    saveState: async (s: NegotiationThreadState) => {
      saved.push(s);
      stored = s;
    },
    guardAndSend: async ({ text }: { text: string }) => {
      sent.push(text);
      return { delivered: "sent" as const, detail: "ok", finalText: text };
    },
    queueOutbox: async () => {},
    insertWakeup: async () => {},
    recordEvent: async () => {},
    writeTrace: async () => {},
  } as unknown as GraphIO;
  return { io, saved, sent };
}

function liveInput(partial: Partial<GraphTurnInput> = {}): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "user@x.com:63999",
      userEmail: "user@x.com",
      toDigits: "63999",
      shopMessage: "300 per day. We have deposit passport or money4000",
      images: [],
      audios: [],
    },
    ctx: { sender: "user@x.com", vendorId: "v1", vendorName: "Shop A", rfq: null },
    rfq: {
      vehicleClass: "scooter",
      engineSizeCc: 125,
      transmission: "any",
      durationDays: 4,
      accessories: [],
      fulfillment: "any",
      vendorMessage: "",
    },
    extraction: { found: true, pricePerDay: 300, currency: "THB", matchesSpec: true, confidence: "high" },
    usablePrice: 300,
    currency: "THB",
    floorPrice: 150,
    sessionClosed: false,
    history: "",
    priorOutbound: ["Hi! Do you have a 125cc scooter for 4 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    deadlineAt: 1_045_000,
    ...partial,
  } as GraphTurnInput;
}

describe("END TO END: the agent asks, and then it actually waits", () => {
  beforeEach(() => {
    ai.answer = null;
    ai.stance = null;
    ai.calls = [];
  });

  it("a wakeup during the wait sends NOTHING - it used to send a bargain", async () => {
    const { runSpteLiveTurn } = await import("./live");
    ai.stance = {
      stance: "engaged",
      stanceQuote: null,
      stanceReason: null,
      uncertain: [
        {
          subject: "deposit",
          reading: "they will hold the passport",
          question: DOUBT.question,
          confidence: 0.45,
        },
      ],
      confidence: 0.9,
    };
    const { io, saved, sent } = liveIo();
    const asked = await runSpteLiveTurn(liveInput(), io);
    expect(asked.move).toBe("confirm");
    expect(sent).toHaveLength(1);
    const digest = saved[0].fields.digest as Partial<ThreadDigest>;
    expect(digest.pending?.[0]).toMatchObject({ subject: "deposit", state: "waiting" });

    // ...and now the scheduled wakeup fires with no answer in sight.
    ai.stance = null;
    const tick = await runSpteLiveTurn(
      liveInput({
        event: {
          kind: "tick",
          threadKey: "user@x.com:63999",
          userEmail: "user@x.com",
          toDigits: "63999",
          // A wakeup carries no message - that is the whole point of this case.
          shopMessage: "",
          images: [],
          audios: [],
        },
        extraction: null,
        usablePrice: undefined,
      }),
      io
    );
    expect(tick.move).toBe("silent");
    expect(sent).toHaveLength(1); // nothing new went out
    // The wait is still on the persisted digest, one turn older - which is what
    // the next turn reads. (The CARD's own `fields.awaitingConfirmation` mirror
    // is written by live.ts only on a turn that actually sent something, so a
    // silent tick blanks the chip while the engine is still waiting; that line
    // lives outside this change and is reported separately.)
    const after = saved[saved.length - 1].fields.digest as Partial<ThreadDigest>;
    expect(after.pending?.[0]).toMatchObject({ subject: "deposit", state: "waiting", turns: 1 });
    expect(after.awaitingConfirmation?.subject).toBe("deposit");
  });

  it("and when the shop finally answers, the model ends the wait", async () => {
    const { runSpteLiveTurn } = await import("./live");
    ai.stance = {
      stance: "engaged",
      stanceQuote: null,
      stanceReason: null,
      uncertain: [
        { subject: "deposit", reading: "passport held", question: DOUBT.question, confidence: 0.45 },
      ],
      confidence: 0.9,
    };
    const { io, saved } = liveIo();
    await runSpteLiveTurn(liveInput(), io);

    ai.stance = { stance: "engaged", stanceQuote: null, stanceReason: null, uncertain: [], confidence: 0.9 };
    ai.answer = { answered: true, answer: "either one is fine", stillUnclear: false, confidence: 0.92 };
    await runSpteLiveTurn(
      liveInput({
        event: {
          kind: "inbound-text",
          threadKey: "user@x.com:63999",
          userEmail: "user@x.com",
          toDigits: "63999",
          shopMessage: "up to you, both ok",
          images: [],
          audios: [],
        },
        extraction: { found: false, matchesSpec: true, confidence: "medium" },
        usablePrice: undefined,
      }),
      io
    );
    const after = saved[saved.length - 1].fields.digest as Partial<ThreadDigest>;
    expect(after.pending).toBeUndefined();
    expect(saved[saved.length - 1].fields.awaitingConfirmation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE CARD MUST NOT DROP THE CHIP WHILE THE ENGINE IS STILL WAITING.
// ---------------------------------------------------------------------------
//
// `fields.awaitingConfirmation` was written only when THIS turn delivered
// something. The turn that asks the question delivers; every turn after it - a
// tick, a swarm poke, an unrelated inbound - does not, so the field was blanked
// while the wait was still in force. The engine kept waiting (proven above) but
// the traveller's card stopped saying so, which reads as "the agent moved on".
describe("the double-checking chip survives the turns that deliver nothing", () => {
  const persistLogic = readFileSync(join(process.cwd(), "src/lib/spte/live.ts"), "utf8");

  it("a turn that delivers nothing keeps a chip that was already raised", () => {
    const block = persistLogic.slice(
      persistLogic.indexOf("WHAT THE CARD SHOWS WHILE THE AGENT WAITS"),
      persistLogic.indexOf("const next: NegotiationThreadState")
    );
    expect(block, "the wait, not this turn's delivery, owns the chip").toMatch(/alreadyAsked/);
    expect(block).toMatch(/asked \|\| alreadyAsked/);
  });

  it("and the asked-at is not restamped on every tick", () => {
    // A three-turn wait that keeps resetting its timestamp looks permanently
    // brand new, which hides exactly the thread that is stuck waiting.
    const block = persistLogic.slice(
      persistLogic.indexOf("WHAT THE CARD SHOWS WHILE THE AGENT WAITS"),
      persistLogic.indexOf("const next: NegotiationThreadState")
    );
    expect(block).toMatch(/awaitingConfirmation\?\.at \?\?/);
  });
});
