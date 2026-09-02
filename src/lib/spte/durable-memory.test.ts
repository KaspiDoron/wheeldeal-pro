import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// THE AMNESIA (W4.5).
//
// `runTurn` has always computed `mergeDigest(...)` and returned it as
// `outcome.digest`. `runSpteLiveTurn` never read it back, and `buildDigest`
// always restarted from `emptyDigest()`. So on the engine that actually answers
// shops:
//
//   - `digest.facts` was permanently [], which made `hasClosed()` permanently
//     false - the "one warm goodbye then silence" rule was unenforced.
//   - `quotedPricePerDay` was rebuilt from the CURRENT message alone, so the
//     moment a shop replied without restating its number ("ok for you?"),
//     bargain / deposit-probe / present all went illegal and momentum turned on
//     against a shop we were mid-negotiation with.
//   - the model's `RECENT MESSAGES` block contained ONLY our own outbound
//     sends. Not one shop turn. It was shown a monologue and asked to continue
//     a dialogue - while `input.history`, the budgeted thread window the caller
//     had already built, sat unread.

// One fake provider, routed by which judgement it was handed - the same shape
// the comprehension suite uses. `null` everywhere is the AI-outage case, which
// is what every memory test below runs under (the digest is deterministic).
const ai = vi.hoisted(() => ({
  stance: null as unknown,
  compose: null as unknown,
}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async (msgs: Array<{ role: string; content: string }>) => {
    const system = msgs[0]?.content ?? "";
    if (system.includes("where does this shop stand")) {
      return ai.stance ? { text: JSON.stringify(ai.stance), provider: "groq" } : { text: null };
    }
    if (system.includes("HAS the vehicle available") || system.includes("what deposit or security")) {
      return { text: null };
    }
    return ai.compose ? { text: JSON.stringify(ai.compose), provider: "groq" } : { text: null };
  },
  extractJson: (t: string) => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  },
}));

import { runSpteLiveTurn, buildTail } from "./live";
import { digestFromStored, emptyDigest, persistableDigest } from "./digest";
import { legalMovesFor } from "./policy";
import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "../graph/types";
import type { ThreadDigest, TurnContext, VerifiedExtraction } from "./types";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

function mockIo(seed?: Partial<NegotiationThreadState>) {
  const saved: NegotiationThreadState[] = [];
  let stored: NegotiationThreadState | null = seed
    ? ({
        threadKey: "user@x.com:63999",
        userEmail: "user@x.com",
        vendorId: "v1",
        vendorName: "Shop A",
        toNumber: "63999",
        phase: "negotiating",
        version: 1,
        fields: { firmCount: 0, toneDegraded: false, rounds: 0 },
        nodeRuns: {},
        updatedAt: "t",
        ...seed,
      } as NegotiationThreadState)
    : null;
  const io = {
    now: () => 1_000_000,
    sessionTable: async () => [],
    loadState: async () => (stored ? { ...stored } : null),
    saveState: async (s: NegotiationThreadState) => {
      saved.push(s);
      stored = s;
    },
    guardAndSend: async ({ text }: { text: string }) => ({
      delivered: "sent" as const,
      detail: "ok",
      finalText: text,
    }),
    queueOutbox: async () => {},
    insertWakeup: async () => {},
    recordEvent: async () => {},
    writeTrace: async () => {},
  } as unknown as GraphIO;
  return { io, saved };
}

function input(partial: Partial<GraphTurnInput> = {}): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "user@x.com:63999",
      userEmail: "user@x.com",
      toDigits: "63999",
      shopMessage: "ok for you?",
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
    extraction: { found: false, matchesSpec: true, confidence: "medium" },
    usablePrice: undefined,
    currency: "THB",
    floorPrice: 150,
    sessionClosed: false,
    history: "",
    priorOutbound: ["Hi! Do you have a 125cc scooter for 4 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    deadlineAt: 1_045_000,
    ...partial,
  };
}

beforeEach(() => {
  ai.stance = null;
  ai.compose = null;
});

// ---------------------------------------------------------------------------
// W4.3 + W4.4, END TO END on the live turn: a shop message goes in, the
// comprehension pass reads it, the ladder answers it, and the row the CARD
// reads comes back out. Everything in between is the real code.
// ---------------------------------------------------------------------------

describe("the live turn acts on what the comprehension pass understood", () => {
  it("THE BRUSH-OFF: a graceful close goes out and the card can finally say so", async () => {
    ai.stance = {
      stance: "deflecting",
      stanceQuote: "You should try asking other shops",
      stanceReason: "sending us to competitors instead of quoting",
      uncertain: [],
      confidence: 0.92,
    };
    const { io, saved } = mockIo();
    const res = await runSpteLiveTurn(
      input({
        event: {
          kind: "inbound-text",
          threadKey: "user@x.com:63999",
          userEmail: "user@x.com",
          toDigits: "63999",
          shopMessage: "You should try asking other shops; maybe they'll give you one.",
          images: [],
          audios: [],
        },
      }),
      io
    );
    expect(res.move).toBe("graceful-close");
    // The bug, gone: no rate re-ask, no question of any kind.
    expect(res.text).toBeTruthy();
    expect(res.text).not.toMatch(/\?/);
    // ...and the field /api/replies reads for "They passed on this one." is
    // written by the PRIMARY engine at last - it only ever had a writer on the
    // graph engine, which is the failover.
    expect(saved[0].fields.declined).toBe(true);
  });

  it("...and the same message with no reachable model behaves exactly as before", async () => {
    // The degrade contract. `ai.stance` is null -> no verdict -> the ladder
    // reads the turn the way it did before this wave existed.
    const { io, saved } = mockIo();
    const res = await runSpteLiveTurn(
      input({
        event: {
          kind: "inbound-text",
          threadKey: "user@x.com:63999",
          userEmail: "user@x.com",
          toDigits: "63999",
          shopMessage: "You should try asking other shops; maybe they'll give you one.",
          images: [],
          audios: [],
        },
      }),
      io
    );
    expect(res.move).not.toBe("graceful-close");
    expect(saved[0].fields.declined).toBeUndefined();
  });

  it("THE AMBIGUOUS DEPOSIT: the agent asks, waits, and the card says why", async () => {
    ai.stance = {
      stance: "engaged",
      stanceQuote: null,
      stanceReason: null,
      uncertain: [
        {
          subject: "deposit",
          reading: "they will hold the passport",
          question: "wait - you mean I can leave a passport OR 4,000 cash?",
          confidence: 0.45,
        },
      ],
      confidence: 0.9,
    };
    const { io, saved } = mockIo();
    const res = await runSpteLiveTurn(
      input({
        event: {
          kind: "inbound-text",
          threadKey: "user@x.com:63999",
          userEmail: "user@x.com",
          toDigits: "63999",
          shopMessage: "300 per day. We have deposit passport or money4000",
          images: [],
          audios: [],
        },
        extraction: {
          found: true,
          pricePerDay: 300,
          currency: "THB",
          matchesSpec: true,
          confidence: "high",
        },
        usablePrice: 300,
      }),
      io
    );
    expect(res.move).toBe("confirm");
    expect(res.text).toBe("wait - you mean I can leave a passport OR 4,000 cash?");
    // The card's line: "Double-checking something with the shop..."
    expect(saved[0].fields.awaitingConfirmation?.subject).toBe("deposit");
    // ...and the ask-once bound is durable, so the next turn cannot repeat it.
    expect((saved[0].fields.digest as Partial<ThreadDigest>).confirmAsked).toEqual(["deposit"]);
  });

  it("a confirming question that never reached the shop is never claimed", async () => {
    ai.stance = {
      stance: "engaged",
      stanceQuote: null,
      stanceReason: null,
      uncertain: [
        {
          subject: "deposit",
          reading: "passport held",
          question: "wait - passport OR cash?",
          confidence: 0.45,
        },
      ],
      confidence: 0.9,
    };
    const { io, saved } = mockIo();
    io.guardAndSend = (async () => ({ delivered: "blocked" as const, detail: "guard" })) as GraphIO["guardAndSend"];
    await runSpteLiveTurn(
      input({
        event: {
          kind: "inbound-text",
          threadKey: "user@x.com:63999",
          userEmail: "user@x.com",
          toDigits: "63999",
          shopMessage: "300 per day. deposit passport or money4000",
          images: [],
          audios: [],
        },
        extraction: { found: true, pricePerDay: 300, currency: "THB", matchesSpec: true, confidence: "high" },
        usablePrice: 300,
      }),
      io
    );
    expect(saved[0].fields.awaitingConfirmation).toBeUndefined();
  });
});

describe("the thread remembers its own turns", () => {
  it("the outcome digest is WRITTEN BACK to the thread row", async () => {
    const { io, saved } = mockIo();
    const res = await runSpteLiveTurn(
      input({
        event: {
          kind: "inbound-text",
          threadKey: "user@x.com:63999",
          userEmail: "user@x.com",
          toDigits: "63999",
          shopMessage: "Click 125 is 300 baht per day.",
          images: [],
          audios: [],
        },
        extraction: { found: true, pricePerDay: 300, currency: "THB", matchesSpec: true, confidence: "high" },
        usablePrice: 300,
      }),
      io
    );
    expect(res.ran).toBe(true);
    expect(saved).toHaveLength(1);
    const d = saved[0].fields.digest as Partial<ThreadDigest>;
    expect(d).toBeTruthy();
    expect(d.quotedPricePerDay).toBe(300);
    expect(d.facts).toContain("quoted 300 THB/day");
  });

  it("...and SEEDS the next turn, so a quote survives a message without a number", async () => {
    const { io, saved } = mockIo({
      fields: {
        firmCount: 0,
        toneDegraded: false,
        rounds: 0,
        digest: { facts: ["quoted 300 THB/day"], quotedPricePerDay: 300, round: 0 },
      },
    });
    // "ok for you?" carries no price at all. Before the digest was durable this
    // was a thread with no quote: bargain illegal, momentum on.
    const res = await runSpteLiveTurn(input(), io);
    expect(res.move).toBe("bargain");
    // The standing quote is carried forward, not dropped.
    expect((saved[0].fields.digest as Partial<ThreadDigest>).quotedPricePerDay).toBe(300);
  });

  it("the standing quote makes the price moves legal (the ladder, directly)", () => {
    const base: TurnContext = {
      session: {
        sessionId: "s",
        rfq: {
          vehicleClass: "scooter",
          engineSizeCc: 125,
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
      thread: { threadKey: "t", vendorId: "v", shop: "s", digest: emptyDigest() },
      tail: [],
      inbound: { text: "ok for you?", verified: { found: false } as VerifiedExtraction },
      legalMoves: [],
      guards: { maxRounds: 4, floorPerDay: 150 },
      event: "shop-message",
    };
    // No memory: the reproduction. A live negotiation reads as a dead thread.
    expect(legalMovesFor(base)).not.toContain("bargain");
    // With the thread's standing quote: the negotiation continues.
    const withMemory = {
      ...base,
      thread: { ...base.thread, digest: { ...emptyDigest(), quotedPricePerDay: 300 } },
    };
    expect(legalMovesFor(withMemory)).toContain("bargain");
  });

  it("ONE WARM GOODBYE, THEN SILENCE - enforceable at last", async () => {
    // `hasClosed()` scans digest.facts, which was permanently [] on the live
    // path, so the rule could never bind. With the digest persisted, the second
    // event on a declined thread has only silence left.
    const { io } = mockIo({
      fields: {
        firmCount: 0,
        toneDegraded: false,
        rounds: 0,
        declined: true,
        digest: { facts: ["closed - one goodbye sent"], round: 0 },
      },
    });
    const res = await runSpteLiveTurn(
      input({
        extraction: { found: false, matchesSpec: true, confidence: "high", shopDeclined: true },
      }),
      io
    );
    expect(res.move).toBe("silent");
    expect(res.text).toBeUndefined();
  });

  it("a stored digest is read back DEFENSIVELY - old rows simply seed empty", () => {
    expect(digestFromStored(undefined)).toEqual(emptyDigest());
    expect(digestFromStored("garbage")).toEqual(emptyDigest());
    expect(digestFromStored({ facts: [1, "ok"], round: -3, quotedPricePerDay: 0 })).toEqual({
      ...emptyDigest(),
      facts: ["ok"],
      round: 0,
      quotedPricePerDay: undefined,
      tone: undefined,
      confirmAsked: undefined,
      awaitingConfirmation: null,
      // W5: a row written before the price watch existed must read as "not
      // armed", never as a watch that already fired.
      priceWatchArmed: undefined,
    });
  });

  it("only the NON-DERIVABLE half is persisted", () => {
    // Everything else (firmCount, depositKnown, options, the ledger,
    // lastOutbound) is recomputed from the thread's own rows every turn -
    // "the conversation is the state" - so persisting it would only create
    // stale copies that can disagree with the messages.
    const full: ThreadDigest = {
      ...emptyDigest(),
      facts: ["a"],
      quotedPricePerDay: 300,
      round: 2,
      tone: "reluctant",
      confirmAsked: ["deposit"],
      firmCount: 3,
      depositKnown: true,
      lastOutbound: ["x"],
      options: [],
      ledger: { claims: [], known: [], outstanding: [], owed: [] },
    };
    const p = persistableDigest(full);
    expect(Object.keys(p).sort()).toEqual(
      ["confirmAsked", "facts", "quotedPricePerDay", "round", "tone"].sort()
    );
  });
});

describe("the model finally sees both sides of the conversation", () => {
  it("the tail carries SHOP turns, from the budgeted window the caller built", () => {
    const tail = buildTail(
      input({
        history: [
          "Us: Hi! Do you have a 125cc scooter for 4 days?",
          "Shop: Yes, Click 125, 300 baht per day.",
          "Us: Any chance on a better rate?",
          "Shop: ok for you?",
        ].join("\n"),
      })
    );
    expect(tail.map((m) => m.dir)).toEqual(["out", "in", "out", "in"]);
    expect(tail[1].text).toBe("Yes, Click 125, 300 baht per day.");
    // Not one shop line reached the prompt before this.
    expect(tail.some((m) => m.dir === "in")).toBe(true);
  });

  it("the elision marker is not mistaken for a turn", async () => {
    const { HISTORY_ELISION } = await import("../wa/history-window");
    const tail = buildTail(
      input({ history: ["Us: opener", HISTORY_ELISION, "Shop: 300 baht"].join("\n") })
    );
    expect(tail).toHaveLength(2);
    expect(tail.map((m) => m.text)).toEqual(["opener", "300 baht"]);
  });

  it("no window supplied -> the old outbound-only tail, byte for byte", () => {
    const tail = buildTail(input({ history: "", priorOutbound: ["a", "b"] }));
    expect(tail.map((m) => m.text)).toEqual(["a", "b"]);
    expect(tail.every((m) => m.dir === "out")).toBe(true);
  });

  it("A LONG THREAD KEEPS BOTH ENDS - the head is what the old cap threw away", async () => {
    // `buildHistoryWindow` preserves the four OLDEST lines verbatim when it has
    // to cut - "the part a misunderstanding destroys deals over", in its own
    // words - and `buildTail` then took the last EIGHT lines of what it had
    // rebuilt. So on any thread past eight messages the RFQ, the dates and the
    // vehicle were discarded and the engine that is meant to remember the whole
    // conversation remembered four exchanges.
    const { buildThreadTail, TAIL_LINES } = await import("./live");
    const lines: string[] = [
      "Us: Hi! 125cc scooter, 14-18 Aug, 4 days - what is your rate?",
      "Shop: Click 125, 300 baht per day.",
      "Us: Could you do better for 4 days?",
      "Shop: 280 is my best.",
    ];
    for (let i = 0; i < TAIL_LINES + 20; i++) lines.push(`Shop: filler ${i}`);
    const { tail, elided } = buildThreadTail(input({ history: lines.join("\n") }));

    expect(tail.length).toBe(TAIL_LINES);
    // The head survived, dates and vehicle intact.
    expect(tail[0].text).toContain("14-18 Aug");
    expect(tail[1].text).toContain("Click 125");
    expect(tail[3].text).toContain("280 is my best");
    // ...and so did the newest message.
    expect(tail[tail.length - 1].text).toBe(`filler ${TAIL_LINES + 19}`);
    // The cut is declared, never silent.
    expect(elided).toBe(true);
  });

  it("a thread that FITS is carried whole, with no elision claimed", async () => {
    const { buildThreadTail } = await import("./live");
    const lines = Array.from({ length: 12 }, (_, i) => `Shop: line ${i}`);
    const { tail, elided } = buildThreadTail(input({ history: lines.join("\n") }));
    expect(tail).toHaveLength(12);
    expect(elided).toBe(false);
  });

  it("the window's OWN elision marker sets the flag without becoming a turn", async () => {
    const { buildThreadTail } = await import("./live");
    const { HISTORY_ELISION } = await import("../wa/history-window");
    const { tail, elided } = buildThreadTail(
      input({ history: ["Us: opener", HISTORY_ELISION, "Shop: 300 baht"].join("\n") })
    );
    expect(tail.map((m) => m.text)).toEqual(["opener", "300 baht"]);
    expect(elided).toBe(true);
  });

  it("the prompt SAYS the thread was cut - a hidden hole invites a re-ask", () => {
    // A model that believes it has the whole conversation will confidently
    // re-ask what the shop answered in the part it cannot see.
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/ctx\.tailElided/);
    expect(pass).toMatch(/some middle messages are not shown/);
  });

  it("the caller's budgeted window is the source - SPTE stopped ignoring it", () => {
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/String\(input\.history \?\? ""\)\.split\("\\n"\)/);
    expect(live).toMatch(/l\.startsWith\("Shop: "\)/);
  });

  it("the standing quote reaches the PROMPT too, as a do-not-re-ask fact", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/this shop's standing quote is/);
    expect(pass).toMatch(/you must NOT ask for it again/);
  });
});

// ---------------------------------------------------------------------------
// THE PHASE FIX (Wave 0): the live engine now PERSISTS the deal-term fields, so
// a thread whose price, deposit and handover the shop has stated leaves
// "negotiating" instead of being pinned there forever. Before, SPTE wrote none
// of depositType/fulfillment/rounds/presented, so derivePhase could only ever
// return "opening" or "negotiating" on live traffic.
// ---------------------------------------------------------------------------
describe("the live turn persists deal-term fields so the phase can advance", () => {
  it("price + deposit + delivery -> the saved thread reaches complete", async () => {
    const { io, saved } = mockIo({ fields: { firmCount: 0, toneDegraded: false, rounds: 2 } });
    await runSpteLiveTurn(
      input({
        event: {
          kind: "inbound-text",
          threadKey: "user@x.com:63999",
          userEmail: "user@x.com",
          toDigits: "63999",
          shopMessage: "250/day, cash deposit, we deliver to your hotel",
          images: [],
          audios: [],
        },
        usablePrice: 250,
        extraction: {
          found: true,
          matchesSpec: true,
          confidence: "high",
          depositType: "cash",
          delivers: true,
        },
      }),
      io
    );
    const last = saved[saved.length - 1];
    expect(last).toBeTruthy();
    expect(last.fields.depositType).toBe("cash");
    expect(last.fields.fulfillment).toBe("delivery");
    expect(last.fields.pricePerDay).toBe(250);
    expect(last.phase).toBe("complete");
  });

  it("price + deposit only -> collecting_terms, not stuck at negotiating", async () => {
    const { io, saved } = mockIo();
    await runSpteLiveTurn(
      input({
        event: {
          kind: "inbound-text",
          threadKey: "user@x.com:63999",
          userEmail: "user@x.com",
          toDigits: "63999",
          shopMessage: "ok 250 per day, passport as deposit",
          images: [],
          audios: [],
        },
        usablePrice: 250,
        extraction: {
          found: true,
          matchesSpec: true,
          confidence: "high",
          depositType: "passport",
        },
      }),
      io
    );
    const last = saved[saved.length - 1];
    expect(last.fields.depositType).toBe("passport");
    expect(last.phase).toBe("collecting_terms");
  });
});
