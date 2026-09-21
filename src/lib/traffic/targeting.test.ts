import { describe, expect, it } from "vitest";
import { GUIDES } from "../guides";
import { FALLBACK_FUNNEL_GUIDE, funnelGuideFor, guideTargeting, linkTermsFor, marketFromText } from "./targeting";
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

describe("the funnel: from a place label to the guide worth reading", () => {
  const exists = (slug: string) => GUIDES.some((g) => g.slug === slug);

  it("reads a market out of the free-text place a traveller searched from", () => {
    expect(marketFromText("Chiang Mai, Thailand")).toBe("th");
    expect(marketFromText("Canggu, Bali")).toBe("id");
    expect(marketFromText("Da Nang")).toBe("vn");
    expect(marketFromText("Cebu City, Philippines")).toBe("ph");
    expect(marketFromText("Lisbon, Portugal")).toBe("xx");
    expect(marketFromText("")).toBe("xx");
  });

  it("agrees with the slug reader - a guide and a search about one country are one market", () => {
    expect(marketFromText("Phuket, Thailand")).toBe(guideTargeting("thailand-scooter-rental-prices").market);
  });

  it("points each market at its own price guide, and everywhere else at the overview", () => {
    expect(funnelGuideFor("th", { funnelGuides: {} }, exists)).toBe("thailand-scooter-rental-prices");
    expect(funnelGuideFor("vn", { funnelGuides: {} }, exists)).toBe("vietnam-motorbike-rental-prices");
    expect(funnelGuideFor("xx", { funnelGuides: {} }, exists)).toBe(FALLBACK_FUNNEL_GUIDE);
    expect(funnelGuideFor("gr", { funnelGuides: {} }, exists)).toBe(FALLBACK_FUNNEL_GUIDE);
  });

  it("every default it can return is a guide that really exists", () => {
    expect(exists(FALLBACK_FUNNEL_GUIDE)).toBe(true);
    for (const m of ["th", "vn", "id", "ph"] as const) expect(exists(funnelGuideFor(m, { funnelGuides: {} }, exists)), m).toBe(true);
  });

  // A typo in the vault must degrade to a real page, never to a 404.
  it("honours the owner's choice only when it names a real guide", () => {
    expect(funnelGuideFor("th", { funnelGuides: { th: "rental-scam-warning-signs" } }, exists)).toBe("rental-scam-warning-signs");
    expect(funnelGuideFor("th", { funnelGuides: { th: "no-such-guide" } }, exists)).toBe("thailand-scooter-rental-prices");
  });

  it("uses the owner's link terms for a market and category when there are any", () => {
    const settings = { linkTerms: { "th|scooter": ["moped hire Phuket"] } };
    expect(linkTermsFor("th", "scooter", settings)).toEqual(["moped hire Phuket"]);
    expect(linkTermsFor("vn", "scooter", settings)[0]).toBe("scooter rental Vietnam");
  });
});
