import { describe, expect, it } from "vitest";
import { matchCreative, parseCreatives } from "./creatives";

const LIST = parseCreatives("Compare scooter rental prices in Thailand\n\n# a comment\n  Rent a scooter in   Bali  \nCompare scooter rental prices in Thailand\n" + "x".repeat(301));

describe("the owner's declared ad creatives", () => {
  it("parses one per line, normalises whitespace, drops blanks, comments, duplicates and oversized lines", () => {
    expect(LIST).toEqual(["Compare scooter rental prices in Thailand", "Rent a scooter in Bali"]);
    expect(parseCreatives(null)).toEqual([]);
  });

  it("forwards a creative the owner declared", () => {
    expect(matchCreative(LIST, "Compare scooter rental prices in Thailand")).toBe("Compare scooter rental prices in Thailand");
    expect(matchCreative(LIST, "  Rent a scooter\tin Bali ")).toBe("Rent a scooter in Bali");
  });

  // Anyone can link to a guide with ?rac=anything. Forwarding it would make this
  // site declare a stranger's text to Google as its own ad - a named strike.
  it("ignores a creative nobody declared, however plausible", () => {
    for (const rac of ["Free iPhone - click now", "compare scooter rental prices in thailand", "Compare scooter rental prices in Thailand!", "", "   ", "x".repeat(400)]) {
      expect(matchCreative(LIST, rac), rac.slice(0, 30)).toBeNull();
    }
    expect(matchCreative(LIST, null)).toBeNull();
    expect(matchCreative(LIST, undefined)).toBeNull();
  });

  it("with no list configured - the organic case - nothing is ever forwarded", () => {
    expect(matchCreative([], "Compare scooter rental prices in Thailand")).toBeNull();
  });

  it("returns the OWNER's string, so a match cannot smuggle a variant through", () => {
    const out = matchCreative(LIST, "Rent a scooter\u0000 in Bali");
    expect(out).toBe(LIST[1]);
  });
});
