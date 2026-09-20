import { describe, expect, it } from "vitest";
import { cleanQuery, searchGuides, tokens } from "./search";

describe("guide search - the organic results behind /search", () => {
  it("puts the guide the query is about first", () => {
    expect(searchGuides("thailand scooter rental price")[0].slug).toBe("thailand-scooter-rental-prices");
    expect(searchGuides("vietnam motorbike")[0].slug).toBe("vietnam-motorbike-rental-prices");
    expect(searchGuides("international driving permit")[0].slug).toBe("international-driving-permit-scooter");
  });

  it("finds plurals and ignores filler words", () => {
    expect(tokens("What are the Scooters' prices?")).toEqual(["scooter", "price"]);
    expect(searchGuides("how do I negotiate a scooter rental")[0].slug).toBe("how-to-negotiate-scooter-rental");
  });

  // An irrelevant result is a fake result, and fake results exist to justify
  // ads. Zero is the right answer for a query this site has nothing on.
  it("returns NOTHING for a query the site has nothing to say about", () => {
    expect(searchGuides("cheap flights to new york")).toEqual([]);
    expect(searchGuides("best pizza dough recipe")).toEqual([]);
    expect(searchGuides("zzzz qqqq")).toEqual([]);
  });

  it("does not count one coincidental shared word as a match", () => {
    expect(searchGuides("apartment rental manhattan brokers")).toEqual([]);
  });

  it("returns nothing for an empty, stop-word-only or junk query", () => {
    for (const q of ["", "   ", "the of and", "!!!", "\u0000\u0001"]) expect(searchGuides(q)).toEqual([]);
  });

  it("bounds what it returns and explains each hit with a real sentence from the guide", () => {
    const hits = searchGuides("scooter rental", 5);
    expect(hits.length).toBeGreaterThan(1);
    expect(hits.length).toBeLessThanOrEqual(5);
    for (const h of hits) {
      expect(h.excerpt.length).toBeGreaterThan(20);
      expect(h.excerpt.length).toBeLessThanOrEqual(220);
      expect(h.score).toBeGreaterThan(0);
    }
    expect([...hits].sort((a, b) => b.score - a.score)).toEqual(hits);
  });

  it("cleans a raw query parameter", () => {
    expect(cleanQuery("  scooter\n\trental  ")).toBe("scooter rental");
    expect(cleanQuery("x".repeat(500)).length).toBe(120);
    expect(cleanQuery(undefined)).toBe("");
  });
});
