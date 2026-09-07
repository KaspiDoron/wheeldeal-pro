// Audit F112 - the global-uniqueness re-variation must move the SAME metrics
// that triggered it, and must report honestly when it could not.
//
// The old mutation only swapped an emoji, an opener word and "can you" ->
// "could you"; both metrics (trigrams() here and normalizeForSig() in
// copy/hash.ts) strip punctuation and emoji, so for a draft without those two
// wording hooks the mutation was a provable no-op on the score - yet
// ensureGloballyFresh still returned changed:true and graph/engine.ts traced
// "re-varied (overlap 84%)" for a message it had not re-varied.
//
// Executed against the real module: no mocks are needed, uniqueness.ts is pure
// (the Redis layer is a strict no-op without REDIS_URL).
import { describe, it, expect } from "vitest";
import {
  revary,
  revarySeeded,
  trigramOverlap,
  ensureGloballyFresh,
  ensureGloballyUnique,
} from "./uniqueness";
import { simhash64, hamming64, mulberry32, fnv1a32 } from "../copy/hash";

// Realistic reply-path drafts with no okay/ok/great/thanks opener and no
// literal "can you" - i.e. exactly the shape the old mutation could not touch.
const DRAFTS = [
  "Any chance you could do 250 a day for the 4 days? I would book with you right now at that.",
  "Another shop quoted 220 a day for the same bike - could you match that for 5 days?",
  "I am comparing a few places - what is your best rate for 5 days?",
  "Is 250 THB/day the best you can do for 4 days?",
  "Do you deliver to the hotel, and what does that cost?",
];

const numerals = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).join("|");

describe("F112 - re-variation actually moves the similarity metrics", () => {
  it("revary changes the trigram score it is measured by", () => {
    for (const d of DRAFTS) {
      const out = revary(d);
      expect(trigramOverlap(d, out)).toBeLessThan(0.75);
    }
  });

  it("revarySeeded flips the simhash skeleton layer 2 compares", () => {
    for (const d of DRAFTS) {
      const out = revarySeeded(d, mulberry32(fnv1a32(d)));
      expect(hamming64(simhash64(d), simhash64(out))).toBeGreaterThan(10);
    }
  });

  it("never adds, drops or rewrites a numeral (this is shop-facing wire text)", () => {
    for (const d of DRAFTS) {
      expect(numerals(revary(d))).toBe(numerals(d));
      expect(numerals(revarySeeded(d, mulberry32(fnv1a32(d))))).toBe(numerals(d));
    }
  });

  it("revary is seeded, not Math.random - the re-park recomposes the same bytes", () => {
    for (const d of DRAFTS) {
      expect(revary(d)).toBe(revary(d));
    }
  });

  it("a real collision is resolved below the threshold, not merely mutated", () => {
    const prior = "Any chance you could do 250 a day for the 4 days? I would book with you right now at that.";
    const draft = "Any chance you could do 240 a day for the 4 days? I would book with you right now at that.";
    const verdict = ensureGloballyFresh(draft, [prior]);
    expect(verdict.maxOverlap).toBeLessThan(0.75);
    expect(verdict.changed).toBe(true);
    expect(numerals(verdict.text)).toBe(numerals(draft));
  });

  it("reports changed:false when the collision could NOT be resolved", () => {
    // Nothing mutable here: every token is a protected numeral, so no honest
    // re-variation exists and the trace must not claim one happened.
    const stuck = "250 250 250 250 250 250";
    const verdict = ensureGloballyFresh(stuck, [stuck]);
    expect(verdict.maxOverlap).toBeGreaterThanOrEqual(0.75);
    expect(verdict.changed).toBe(false);
  });

  it("ensureGloballyUnique carries the same honest verdict (no Redis)", async () => {
    const draft = "Any chance you could do 250 a day for the 4 days? I would book with you right now at that.";
    const verdict = await ensureGloballyUnique(draft, [draft]);
    expect(verdict.changed).toBe(true);
    expect(verdict.maxOverlap).toBeLessThan(0.75);
    expect(numerals(verdict.text)).toBe(numerals(draft));
  });
});
