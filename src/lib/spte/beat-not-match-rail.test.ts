import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runPostRails } from "./rails";
import { fallbackArtifact } from "./pass";
import type { MoveKind, TurnArtifact, TurnContext } from "./types";

// W5.1 - EXECUTED: the "never match" doctrine passes through the real rail.
//
// This runs runPostRails itself, not a regex over its source. The distinction
// is the whole point of the change: before this rail, "never match" existed
// only as sentences inside three prompts, and this file's neighbours are full
// of comments explaining that a prompt is advice and a rail is a guarantee.
// The live message the owner reported - "Could you match the 200 THB/day offer"
// - passed every check this engine had.

const ctx = (over: Partial<TurnContext> = {}): TurnContext =>
  ({
    legalMoves: ["bargain", "clarify"],
    tail: [],
    guards: { floorPerDay: 150, maxRounds: 4 },
    inbound: {
      text: "300 baht per day",
      verified: {
        vehicleStatus: "confirmed",
        vehicleAsked: true,
        pricePerDay: 300,
        found: true,
        currency: "THB",
      },
    },
    thread: { threadKey: "t@x:66900", digest: { facts: [], round: 0, quotedPricePerDay: 300, options: [] } },
    session: {
      rivals: [{ vendorId: "b", shop: "Other", pricePerDay: 200, currency: "THB" }],
      currency: "THB",
      rfq: { durationDays: 3, engineSizeCc: 125, vehicleClass: "scooter" },
    },
    ...over,
  }) as unknown as TurnContext;

const draft = (move: MoveKind, message: string, counter?: number): TurnArtifact =>
  ({
    move,
    message,
    counterPricePerDay: counter,
    leverageUsed: ["rival"],
    digestPatch: [],
    read: { intent: "" },
    think: "",
  }) as TurnArtifact;

describe("REPRODUCTION: the message the owner read on the wire", () => {
  it("a bargain that asks the shop to MATCH does not go out", () => {
    const r = runPostRails(ctx(), draft("bargain", "Could you match the 200 THB/day offer?", 200));
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("beat-not-match");
    expect(r.finalText).toBeUndefined();
  });

  it("the prompt's own few-shot would have been refused too", () => {
    const r = runPostRails(
      ctx(),
      draft("bargain", "another shop give me 200 per day for 3 days, you can do same or better?", 200)
    );
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("beat-not-match");
  });

  it("...and so would the old fallback's 'get close to'", () => {
    const r = runPostRails(
      ctx(),
      draft("bargain", "if you can get close to 200 per day for the 3 days, I book right now", 200)
    );
    expect(r.ok).toBe(false);
  });

  it("momentum is held to the same rule - it is a price move by another name", () => {
    const r = runPostRails(ctx(), draft("momentum", "Any chance you can match that 200?", 200));
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("beat-not-match");
  });
});

describe("a real BEAT still goes out unharmed", () => {
  it("naming a number strictly below the rival passes every rail", () => {
    const r = runPostRails(
      ctx(),
      draft("bargain", "Another shop offered me 200 a day. Could you do 190 for the 3 days? 🙂", 190)
    );
    expect(r.ok).toBe(true);
    expect(r.finalText).toContain("190");
  });

  it("an open-ended 'below X' ask is not a MATCH - beat-not-match leaves it alone", () => {
    // This rail's job is to catch "can you do the same as them?". An
    // open-ended "could you do better than that?" is the opposite and must
    // never be rejected AS A MATCH.
    //
    // It IS now rejected by a different rail - cite-the-rival (owner report 8):
    // with a cheaper rival on the board, a bargain that names no number gives
    // the shop nothing to beat. That rejection re-composes through the
    // deterministic template, which cites the rival. So the assertion here is
    // about WHICH rule fires, not about the draft surviving.
    const r = runPostRails(
      ctx(),
      draft("bargain", "300 a day is a bit much for me - could you do better than that for the 3 days?")
    );
    expect(r.rejected?.rule ?? null).not.toBe("beat-not-match");
  });

  it("...and with the rival named, that same open-ended shape sails through", () => {
    const r = runPostRails(
      ctx(),
      draft(
        "bargain",
        "Another shop offered me 200 a day - could you do better than that for the 3 days?"
      )
    );
    expect(r.ok).toBe(true);
  });

  it("a NON-price move may still use ordinary 'same' English", () => {
    // The rail is scoped to bargain/momentum precisely so this stays legal.
    const r = runPostRails(
      ctx({ legalMoves: ["clarify"] } as Partial<TurnContext>),
      draft("clarify", "Thanks! Is that the same bike as in the photo?")
    );
    expect(r.ok).toBe(true);
  });
});

describe("the rejection re-composes into something SENDABLE", () => {
  // A rail that rejects into silence would trade one failure for another: the
  // shop is owed an answer. The orchestrator falls back to the deterministic
  // artifact, so that artifact must itself pass this rail - otherwise a matched
  // draft turns a live negotiation into a dropped turn.
  it("the deterministic bargain fallback names no rival and cannot match one", () => {
    const c = ctx();
    const fb = fallbackArtifact(c);
    expect(fb.move).toBe("bargain");
    const r = runPostRails(c, fb);
    expect(r.ok).toBe(true);
    expect(r.finalText).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// CITE-THE-RIVAL - EXECUTED (owner report 10, test integrity).
//
// The rail shipped in OR8 with every assertion about it written as a regex
// over rails.ts, and the one behavioural signal it had was lost in the
// beat-not-match rewrite above, which now only checks WHICH rule fires. I
// verified the gap the honest way: wrapping the rail in `if (false && ...)`,
// so it can never run at all, passed the entire 5,700-test suite.
//
// This is the owner's headline product requirement - "another shop offered
// 200, can you do 180?" - and it was, once again, guaranteed by nothing.
// ---------------------------------------------------------------------------
describe("cite-the-rival actually rejects a bargain that names no rival", () => {
  it("EXECUTED: a vague ask with a cheaper rival on the board is REJECTED", () => {
    // The exact live message: it has a question mark, so send-worthiness let
    // it through, and the strongest card in the hand was never played.
    const r = runPostRails(ctx(), draft("bargain", "Any chance of a better daily rate?"));
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("cite-the-rival");
  });

  it("EXECUTED: naming the rival's number passes - it is a cite, not a format", () => {
    const r = runPostRails(
      ctx(),
      draft("bargain", "Another shop quoted me 200 a day - could you do 185 for the 3 days?", 185)
    );
    expect(r.ok).toBe(true);
    expect(r.finalText).toContain("200");
  });

  it("EXECUTED: NO cheaper rival means no obligation - the rail stands down", () => {
    // 300 on the table, the only rival is dearer. There is nothing to cite,
    // and a rail that fired here would reject perfectly good bargaining.
    const noCheaper = ctx({
      session: {
        rivals: [{ vendorId: "b", shop: "Other", pricePerDay: 400, currency: "THB" }],
        currency: "THB",
        rfq: { durationDays: 3, engineSizeCc: 125, vehicleClass: "scooter" },
      },
    } as Partial<TurnContext>);
    const r = runPostRails(noCheaper, draft("bargain", "Any chance of a better daily rate?"));
    expect(r.rejected?.rule ?? null).not.toBe("cite-the-rival");
  });

  it("EXECUTED: ANY real rival counts, not only the cheapest one", () => {
    // A board holding 250 and 200: citing the 250 is perfectly good leverage,
    // and demanding the cheapest specifically would reject it.
    const twoRivals = ctx({
      session: {
        rivals: [
          { vendorId: "b", shop: "Other", pricePerDay: 200, currency: "THB" },
          { vendorId: "c", shop: "Third", pricePerDay: 250, currency: "THB" },
        ],
        currency: "THB",
        rfq: { durationDays: 3, engineSizeCc: 125, vehicleClass: "scooter" },
      },
    } as Partial<TurnContext>);
    const r = runPostRails(
      twoRivals,
      draft("bargain", "Another shop quoted me 250 - can you do 240 for the 3 days?", 240)
    );
    expect(r.rejected?.rule ?? null).not.toBe("cite-the-rival");
  });

  it("EXECUTED: the rail reads LOCAL numerals - it never rejects a correct Thai cite", () => {
    // This app folds ten digit scripts precisely because shops and the
    // localizer render prices in local script. A rail that could not read them
    // would reject the very message it exists to require - a downgrade, not a
    // guarantee. (OR8.1 F4 found this exact class in `citedRival`.)
    const r = runPostRails(
      ctx(),
      draft("bargain", "ร้านอื่นเสนอ ๒๐๐ บาท/วัน ขอ ๑๙๐ ได้ไหมสำหรับ ๓ วัน", 190)
    );
    expect(r.rejected?.rule ?? null).not.toBe("cite-the-rival");
  });

  it("EXECUTED: the rejection re-composes into a message that DOES cite the rival", () => {
    // The rail's stated guarantee: its failure mode is the message the owner
    // asked for. A rejection that produced silence, or a rival-free template,
    // would trade one failure for another.
    const c = ctx();
    const fb = fallbackArtifact(c);
    const r = runPostRails(c, fb);
    expect(r.ok).toBe(true);
    expect(r.finalText, "the fallback must name the rival price").toContain("200");
  });
});
