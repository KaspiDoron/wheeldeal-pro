import { describe, expect, it } from "vitest";
import {
  PLACEMENTS,
  SUBID_MAX_LENGTH,
  buildSubId,
  parseSubId,
  sessionHash,
  type SubIdInput,
} from "./subid";

const base: SubIdInput = {
  placement: "guide-inline",
  market: "th",
  category: "scooter",
  sessionSeed: "a-random-session-seed",
  day: "2026-09-20",
};

describe("sub-id: what a partner is allowed to learn", () => {
  it("is built only from a closed vocabulary and a hash - never free text", () => {
    const id = buildSubId(base);
    expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(id.length).toBeLessThanOrEqual(SUBID_MAX_LENGTH);
  });

  it("round-trips the three reporting dimensions", () => {
    const parsed = parseSubId(buildSubId(base));
    expect(parsed).toMatchObject({ placement: "guide-inline", market: "th", category: "scooter" });
  });

  // THE PROPERTY THAT MATTERS. A sub-id leaves the building: it lands in a
  // partner's reports, their logs and their exports, outside every erasure and
  // retention control this app has. So personal data must be unable to enter it
  // BY CONSTRUCTION - not by a reviewer remembering to check.
  it("cannot carry an email, a phone number or a thread id, whatever is passed", () => {
    const hostile = [
      "doron@example.com",
      "+66812345678",
      "66812345678",
      "thread_9f8e7d6c",
      "../../etc/passwd",
      "<script>alert(1)</script>",
    ];
    for (const value of hostile) {
      const id = buildSubId({
        ...base,
        market: value,
        category: value,
        placement: value as SubIdInput["placement"],
      });
      expect(id).not.toContain("@");
      expect(id).not.toContain("example");
      expect(id).not.toContain("66812345678");
      expect(id).not.toContain("9f8e7d6c");
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      // An unknown value degrades to the neutral bucket instead of echoing.
      expect(parseSubId(id)).toMatchObject({ placement: "unknown", market: "xx", category: "other" });
    }
  });

  it("does not expose the session seed, and cannot be reversed into it", () => {
    const id = buildSubId(base);
    expect(id).not.toContain("a-random-session-seed");
    expect(sessionHash(base.sessionSeed, base.day)).toHaveLength(8);
  });

  // A stable per-visitor token would let a partner rebuild a cross-day profile
  // of one person from our sub-ids alone. Rotating it daily keeps the same-day
  // de-duplication reconciliation needs and gives up nothing else.
  it("rotates the session hash daily, so a partner cannot follow one visitor across days", () => {
    const monday = sessionHash("seed", "2026-09-21");
    const tuesday = sessionHash("seed", "2026-09-22");
    expect(monday).not.toBe(tuesday);
    expect(sessionHash("seed", "2026-09-21")).toBe(monday);
  });

  it("gives different visitors different hashes on the same day", () => {
    expect(sessionHash("visitor-a", "2026-09-21")).not.toBe(sessionHash("visitor-b", "2026-09-21"));
  });

  it("refuses to parse anything it did not build", () => {
    for (const junk of ["", "hello", "p9-mth-cscooter-zzzzzzzz", "a-b-c-d-e-f", "P1-MTH-CSCOOTER-ABCDEF12"]) {
      expect(parseSubId(junk)).toBeNull();
    }
  });

  it("keeps placement codes unique - two placements sharing a code would merge their revenue", () => {
    const codes = Object.values(PLACEMENTS).map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
