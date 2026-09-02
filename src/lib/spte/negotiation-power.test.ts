import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readFileSync } from "fs";
import { join } from "path";
import { runPostRails, } from "./rails";
import { fallbackArtifact } from "./pass";
import { beatRivalTarget } from "../negotiation/beat-rival";
import type { MoveKind, TurnArtifact, TurnContext } from "./types";

// OWNER REPORT 6, WAVE C - the agent fights with facts, EXECUTED.
//
// THE LIVE MESSAGE: "thanks! Any chance you can do a bit better for 4 days?"
// sent while a cheaper sibling quote sat in the session. That exact string is
// the deterministic bargain fallback - reached on EVERY provider failure and
// EVERY rail rejection - and it consulted none of the leverage the prompt
// builder computes two hundred lines above it.

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
    thread: {
      threadKey: "t@x:66900",
      digest: { facts: [], round: 0, quotedPricePerDay: 300, options: [] },
    },
    session: {
      rivals: [{ vendorId: "b", shop: "Other", pricePerDay: 200, currency: "THB" }],
      currency: "THB",
      rfq: { durationDays: 4, engineSizeCc: 125, vehicleClass: "scooter" },
    },
    ...over,
  }) as unknown as TurnContext;

const draft = (move: MoveKind, message: string): TurnArtifact =>
  ({
    move,
    message,
    leverageUsed: [],
    digestPatch: [],
    read: { intent: "" },
    think: "",
  }) as TurnArtifact;

describe("the deterministic bargain fallback plays the hand it holds", () => {
  it("cites the cheaper rival and asks strictly below it", () => {
    const fb = fallbackArtifact(ctx());
    expect(fb.move).toBe("bargain");
    const target = beatRivalTarget({ rivalPricePerDay: 200, quotePerDay: 300, floorPerDay: 150 });
    expect(fb.message).toContain("200");
    expect(fb.message).toContain(String(target));
    expect(target).toBeLessThan(200); // beat, never match - same helper, same figure
    // Never the rival's NAME - the disclosure rail's rule.
    expect(fb.message).not.toContain("Other");
  });

  it("...and that message survives the full rail stack", () => {
    const fb = fallbackArtifact(ctx());
    const r = runPostRails(ctx(), fb);
    expect(r.ok, r.rejected?.detail).toBe(true);
  });

  it("with no rival it still asks, as before", () => {
    const noRival = ctx({
      session: {
        rivals: [],
        currency: "THB",
        rfq: { durationDays: 4, engineSizeCc: 125, vehicleClass: "scooter" },
      },
    } as unknown as Partial<TurnContext>);
    const fb = fallbackArtifact(noRival);
    expect(fb.move).toBe("bargain");
    // THE PROPERTY, NOT ONE FAMILY MEMBER'S WORDING. This pinned the literal
    // "better|best price", which was safe while the branch had exactly one
    // sentence - and one sentence, sent by every traveller to every shop for
    // ever, is the fleet pattern this round is removing. What must hold is that
    // the fallback still ASKS for movement, in a question.
    expect(fb.message).toMatch(/\?\s*$/);
    expect(fb.message).toMatch(/better|best|lower|room|stretch|rate|price/i);
  });
});

describe("send-worthiness: a paced send slot is never spent on 'thanks!'", () => {
  it("REPRODUCTION: the literal live message is refused", () => {
    const r = runPostRails(ctx(), draft("bargain", "thanks! 👍"));
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("send-worthiness");
  });

  it("a terminal goodbye is exempt - a bare goodbye is its whole job", () => {
    const r = runPostRails(ctx(), draft("farewell", "Thanks so much! Safe travels!"));
    expect(r.ok).toBe(true);
  });

  it("a substantive short answer passes", () => {
    const r = runPostRails(ctx(), draft("clarify", "Yes - pickup at the shop works for me?"));
    expect(r.ok).toBe(true);
  });

  it("the SCRUB-REMNANT path: a banned phrase's leftover courtesy is refused too", () => {
    // The banned-phrase scrub deletes the substance; what remains must still
    // answer "does this advance anything?" - which is why the rail runs AFTER
    // the scrub.
    const scrubCtx = ctx({
      guards: { floorPerDay: 150, maxRounds: 4, bannedPhrases: ["No problem my friend"] },
    } as unknown as Partial<TurnContext>);
    const r = runPostRails(scrubCtx, draft("clarify", "No problem my friend. Thanks!"));
    expect(r.ok).toBe(false);
    expect(r.rejected?.rule).toBe("send-worthiness");
  });
});

describe("the wiring the merge cannot show", () => {
  const orch = readFileSync(join(process.cwd(), "src/lib/spte/orchestrator.ts"), "utf8");
  const engine = readFileSync(join(process.cwd(), "src/lib/graph/engine.ts"), "utf8");
  const live = readFileSync(join(process.cwd(), "src/lib/spte/live.ts"), "utf8");

  it("a rail rejection is reported as itself, never as quota-overflow", () => {
    expect(orch).toMatch(/rail-rejected:\$\{rail\.rejected\?\.rule/);
  });

  it("the thread row carries basis + vehicle; the merge adopts a masked basis", () => {
    expect(live).toMatch(/fields\.priceBasisDays = input\.priceBasisDays/);
    expect(live).toMatch(/fields\.vehicleKey = vehicleKeyFor\(input\.rfq\)/);
    expect(engine).toMatch(/fx\.vehicleKey && fx\.vehicleKey !== vehicleKey\) continue/);
    expect(engine).toMatch(/existing\.quoteBasisDays = o\.quote_basis_days/);
    // The starving sample: 16 unordered rows -> a session's worth, newest-first.
    expect(engine).toMatch(/order=updated_at\.desc&limit=200/);
  });
});
