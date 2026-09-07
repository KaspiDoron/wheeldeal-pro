// AUDIT F072 - a non-silent move with no text must never leave runTurn.
//
// `finalize` rendered `text: undefined` for any non-silent move whose rail
// result carried no finalText, and the two paths that produce that shape - a
// model artifact with a move and an empty message, and a reflex line a
// post-rail rejects - skipped the `!rail.ok` template ladder entirely. The turn
// then sent nothing, armed nothing (the 3-minute re-entry is keyed on move ===
// "silent"), settled the inbound claim as delivered, and with move "bargain"
// still spent a round; with "verify-recap" it latched the once-per-thread
// recap. Everything below drives the REAL runTurn with a stubbed model.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MoveKind, ThreadDigest, TurnContext, VerifiedExtraction } from "./types";
import { emptyDigest } from "./digest";

vi.mock("server-only", () => ({}));

const model = vi.hoisted(() => ({ reply: null as null | { move: string; message?: string } }));

vi.mock("../ai", () => ({
  chat: async () => null,
  extractJson: (t: string) => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  },
  chatDetailed: async () =>
    model.reply
      ? { text: JSON.stringify({ think: "nothing to add", ...model.reply }), provider: "mock" }
      : { text: null },
}));

function ctx(p: {
  quoted?: number;
  verified?: Partial<VerifiedExtraction>;
  digest?: Partial<ThreadDigest>;
  bannedPhrases?: string[];
  text?: string;
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
    thread: {
      threadKey: "t@x.com:66812345678",
      vendorId: "v1",
      shop: "Krabi Bikes",
      digest: { ...emptyDigest(), quotedPricePerDay: p.quoted, ...p.digest },
    },
    tail: [],
    inbound: {
      text: p.text ?? (p.quoted ? `${p.quoted} per day` : "Hello, how many days?"),
      verified: {
        found: Boolean(p.quoted),
        pricePerDay: p.quoted,
        currency: "THB",
        ...p.verified,
      },
    },
    legalMoves: [],
    guards: { maxRounds: 4, floorPerDay: 150, bannedPhrases: p.bannedPhrases },
    event: "shop-message",
  };
}

const ALL_MOVES: MoveKind[] = [
  "bargain",
  "confirm-vehicle",
  "option-probe",
  "clarify",
  "redirect-close",
  "graceful-close",
  "confirm",
  "farewell",
  "answer",
  "deposit-probe",
  "restock-probe",
  "fulfillment-probe",
  "momentum",
  "verify-recap",
];

/** Every template this context can compose - banning them all is how the test
 *  makes the whole deterministic ladder fail, which is the only way to reach
 *  the "nothing survives" branch on purpose. */
async function everyTemplate(c: TurnContext): Promise<string[]> {
  const { templateFor } = await import("./pass");
  return ALL_MOVES.map((m) => templateFor(c, m)).filter((t): t is string => Boolean(t));
}

const COMPLETE: Partial<ThreadDigest> = {
  quotedPricePerDay: 250,
  firmCount: 2,
  depositKnown: true,
  fulfillmentKnown: true,
  comprehension: { depositKind: "document", handoverMode: "delivery" },
};

describe("EXECUTED: the model picks a move and writes nothing", () => {
  beforeEach(() => {
    model.reply = null;
  });

  it("an empty `answer` to a priceless question is composed from the template, not dropped", async () => {
    const { runTurn } = await import("./orchestrator");
    model.reply = { move: "answer", message: "" };
    const out = await runTurn(ctx({ verified: { askedQuestion: true } }));
    // The invariant this file exists for: a move that is not silent carries text.
    expect(out.move).not.toBe("silent");
    expect(typeof out.text).toBe("string");
    expect(out.text!.trim().length).toBeGreaterThan(0);
    // ...and Ops can see why a template went out under a model route.
    expect(out.route.reason).toMatch(/empty-draft/);
  });

  it("the same with the message key absent entirely", async () => {
    const { runTurn } = await import("./orchestrator");
    model.reply = { move: "answer" };
    const out = await runTurn(ctx({ verified: { askedQuestion: true } }));
    expect(out.move === "silent" || (typeof out.text === "string" && out.text.length > 0)).toBe(true);
    expect(out.move).not.toBe("silent");
  });
});

describe("EXECUTED: when nothing survives, the turn says SILENT before the digest is merged", () => {
  beforeEach(() => {
    model.reply = null;
  });

  it("an empty `bargain` whose every rescue is rejected spends no round", async () => {
    const { runTurn } = await import("./orchestrator");
    const base = ctx({ quoted: 250 });
    const c = ctx({ quoted: 250, bannedPhrases: await everyTemplate(base) });
    model.reply = { move: "bargain", message: "" };
    const out = await runTurn(c);
    expect(out.text).toBeUndefined();
    expect(out.move).toBe("silent");
    // The round is the fixConcern: mergeDigest keys the increment off the move,
    // so a demotion AFTER the merge would still have burnt one of the four.
    expect(out.digest.round).toBe(0);
  });

  it("an empty `verify-recap` whose template is rejected does not latch recapSent", async () => {
    const { runTurn } = await import("./orchestrator");
    const base = ctx({ quoted: 250, digest: COMPLETE, text: "ok" });
    const c = ctx({ quoted: 250, digest: COMPLETE, text: "ok", bannedPhrases: await everyTemplate(base) });
    model.reply = { move: "verify-recap", message: "" };
    const out = await runTurn(c);
    expect(out.move).toBe("silent");
    expect(out.text).toBeUndefined();
    expect(out.digest.recapSent).toBeFalsy();
  });
});

describe("EXECUTED: a reflex line a rail rejects falls to the ladder with the honest reason", () => {
  it("the licence reflex, banned outright, is replaced by the answer template", async () => {
    const { runTurn } = await import("./orchestrator");
    const { reflexTurn } = await import("./policy");
    const { legalMovesFor } = await import("./policy");
    const probe = ctx({ verified: { askedQuestion: true, askedLicense: true } });
    probe.legalMoves = legalMovesFor(probe);
    const reflex = reflexTurn(probe);
    expect(reflex?.message).toBeTruthy();
    const c = ctx({
      verified: { askedQuestion: true, askedLicense: true },
      bannedPhrases: [reflex!.message!],
    });
    const out = await runTurn(c);
    expect(out.move).not.toBe("silent");
    expect(typeof out.text).toBe("string");
    expect(out.text).not.toBe(reflex!.message);
    expect(out.route.reason).toBe("rail-rejected:banned-phrase");
  });
});
