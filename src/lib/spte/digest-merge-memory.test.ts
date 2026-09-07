// Audit F031 - the concession ladder's memory (`lastAskPerDay`) was dropped by
// both merges.
//
// `persistableDigest` persists it and `digestFromStored` reads it back, but
// `mergeStoredDigests` rebuilt the merged object from a HAND-LISTED key set
// that did not name it, so every lost optimistic-version race deleted the
// thread's last ask; and `mergeDigest` omitted it from its own return, so even
// with no race a non-bargain turn wiped it. `computeRoundTarget`'s ratchet
// ("never re-ask BELOW an earlier ask") is the only thing stopping the agent
// from lowballing a shop that has just conceded, and it is fed exactly that
// value (pass.ts:85).
//
// Executed on the pure functions - no store, no mocks needed.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  persistableDigest,
  digestFromStored,
  mergeStoredDigests,
  mergeDigest,
} from "./digest";
import { computeRoundTarget } from "../graph/math";
import type { ThreadDigest, TurnArtifact, VerifiedExtraction } from "./types";

/** A digest carrying every durable key, so the key-set assertion below is
 *  derived from persistableDigest itself rather than a second hand-list. */
const FULL: ThreadDigest = {
  facts: ["quoted 400 THB/day", "deposit 3000 cash"],
  quotedPricePerDay: 300,
  round: 2,
  lastAskPerDay: 260,
  tone: "warm",
  confirmAsked: ["deposit"],
  awaitingConfirmation: { subject: "deposit", question: "is the deposit 3000?" },
  pending: [{ subject: "deposit", state: "waiting", question: "is the deposit 3000?" }],
  priceWatchArmed: true,
  recapSent: true,
  recapSentAt: 1_700_000_000_000,
  recapConfirmedAt: 1_700_000_060_000,
  recapAmended: true,
  oweWatchArmed: true,
  comprehension: { stance: "engaged", depositStated: true, firmTurns: 1 },
} as unknown as ThreadDigest;

const artifact = (move: string): TurnArtifact =>
  ({
    read: { intent: "answering" },
    think: "",
    move,
    message: "ok",
    leverageUsed: [],
    digestPatch: [],
  }) as unknown as TurnArtifact;

const nothingVerified: VerifiedExtraction = { found: false };

describe("F031 - the last ask survives a lost version race", () => {
  it("mergeStoredDigests keeps every key persistableDigest persists", () => {
    const stored = persistableDigest(FULL);
    const merged = mergeStoredDigests(stored, stored);
    for (const key of Object.keys(stored)) {
      expect(Object.keys(merged)).toContain(key);
    }
  });

  it("a 260 last ask survives the merge and still ratchets the ladder", () => {
    const stored = persistableDigest(FULL);
    const merged = mergeStoredDigests(stored, stored);
    expect(merged.lastAskPerDay).toBe(260);
    const back = digestFromStored(merged);
    expect(back.lastAskPerDay).toBe(260);
    // The whole point of persisting it: without the memory the round-2 rung
    // computes 230 and the agent re-asks 30 BELOW its own previous ask.
    expect(
      computeRoundTarget({ quoted: 300, floorPrice: 160, rounds: 2, lastTarget: back.lastAskPerDay })
    ).toBe(260);
    expect(
      computeRoundTarget({ quoted: 300, floorPrice: 160, rounds: 2, lastTarget: undefined })
    ).toBe(230);
  });

  it("ours wins over the version winner, exactly as the quote does", () => {
    const winner = persistableDigest({ ...FULL, lastAskPerDay: 240 });
    const ours = persistableDigest({ ...FULL, lastAskPerDay: 260 });
    expect(mergeStoredDigests(winner, ours).lastAskPerDay).toBe(260);
  });

  it("the winner's value is kept when ours never had one", () => {
    const winner = persistableDigest(FULL);
    const ours = persistableDigest({ ...FULL, lastAskPerDay: undefined });
    expect(mergeStoredDigests(winner, ours).lastAskPerDay).toBe(260);
  });
});

describe("F031 - and it survives an ordinary non-bargain turn", () => {
  it("mergeDigest carries the last ask through a turn that did not bargain", () => {
    const next = mergeDigest(FULL, artifact("answer"), nothingVerified);
    expect(next.lastAskPerDay).toBe(260);
    expect(persistableDigest(next).lastAskPerDay).toBe(260);
  });

  it("a bargain turn keeps it too (live.ts overwrites it after the wire)", () => {
    const next = mergeDigest(FULL, artifact("bargain"), nothingVerified);
    expect(next.lastAskPerDay).toBe(260);
    expect(next.round).toBe(3);
  });
});
