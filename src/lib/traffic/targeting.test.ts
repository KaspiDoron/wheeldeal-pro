import { describe, expect, it } from "vitest";
import { GUIDES } from "../guides";
import { guideTargeting, linkTermsFor } from "./targeting";
import { SUBID_CATEGORIES, SUBID_MARKETS } from "./subid";

describe("guide targeting", () => {
  it("reads the market and the category out of a slug", () => {
    expect(guideTargeting("thailand-scooter-rental-prices")).toEqual({ market: "th", category: "scooter" });
    expect(guideTargeting("vietnam-motorbike-rental-prices")).toEqual({ market: "vn", category: "motorbike" });
    expect(guideTargeting("bali-scooter-rental-prices")).toEqual({ market: "id", category: "scooter" });
    expect(guideTargeting("travel-insurance-scooter-accidents")).toEqual({ market: "xx", category: "insurance" });
    expect(guideTargeting("international-driving-permit-scooter")).toEqual({ market: "xx", category: "licence" });
    expect(guideTargeting("car-vs-scooter-rental-abroad").category).toBe("scooter");
  });

  it("only ever answers inside the sub-id vocabularies, for every real guide", () => {
    for (const g of GUIDES) {
      const t = guideTargeting(g.slug);
      expect(SUBID_MARKETS as readonly string[], g.slug).toContain(t.market);
      expect(SUBID_CATEGORIES as readonly string[], g.slug).toContain(t.category);
    }
  });

  it("degrades to the neutral bucket, never to the input", () => {
    expect(guideTargeting("")).toEqual({ market: "xx", category: "travel" });
    expect(guideTargeting("doron@example.com")).toEqual({ market: "xx", category: "travel" });
  });
});

describe("terms for a link partner", () => {
  it("are built from what the guide is about, and are plain short queries", () => {
    const terms = linkTermsFor("th", "scooter");
    expect(terms[0]).toBe("scooter rental Thailand");
    for (const t of terms) {
      expect(t).toMatch(/^[A-Za-z ]+$/);
      expect(t.length).toBeLessThanOrEqual(60);
    }
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("still reads naturally with no known market", () => {
    expect(linkTermsFor("xx", "licence")).toEqual([
      "scooter rental abroad",
      "travel insurance for riders",
      "international driving permit online",
    ]);
  });
});
