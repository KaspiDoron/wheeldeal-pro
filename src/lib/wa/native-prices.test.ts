import { describe, it, expect } from "vitest";
import { extractQuotedPrices } from "./price-extract";
import { scanRates } from "./rate-expr";
import { mentionedCurrencies, reconcileCurrency } from "./price-extract";

// OWNER PROBLEM 5: a shop quotes in its own language and the app reads nothing.
//
// An audit executed fourteen real Thai, Vietnamese and Indonesian phrasings
// against the readers. Recall was 0/14 - including "250฿/วัน", where the ฿ WAS
// recognised and the unit word beside it was not. The digit fold that turns
// ๒๕๐ into 250 had been wired for a wave and was inert for the same reason: a
// folded number next to an unreadable unit is still not a rate.

const perDay = (text: string, opts: { durationDays?: number; localCurrency?: string } = {}) =>
  extractQuotedPrices(text, {
    durationDays: opts.durationDays ?? 3,
    localCurrency: opts.localCurrency ?? "THB",
  } as never).allOffers.map((o) => o.pricePerDay);

describe("a shop writing in its own language is finally read", () => {
  it("EXECUTED: Thai", () => {
    expect(perDay("250 บาท/วัน")).toEqual([250]);
    expect(perDay("ราคา 250 บาท ต่อ วัน")).toEqual([250]);
    expect(perDay("250฿/วัน")).toEqual([250]);
    // Thai numerals, through the fold that was already wired.
    expect(perDay("๒๕๐ บาท/วัน")).toEqual([250]);
    // A stated total over the shop's own span: 900 over 3 days.
    expect(perDay("เช่า 3 วัน 900 บาท")).toEqual([300]);
  });

  it("EXECUTED: Vietnamese", () => {
    expect(perDay("150k/ngày")).toEqual([150000]);
    expect(perDay("150.000 đồng một ngày")).toEqual([150000]);
    expect(perDay("Giá 150k một ngày")).toEqual([150000]);
    expect(perDay("1 ngày 150 nghìn")).toEqual([150000]);
  });

  it("EXECUTED: Indonesian and Filipino", () => {
    expect(perDay("Rp 70.000 per hari")).toEqual([70000]);
    expect(perDay("70rb/hari")).toEqual([70000]);
    expect(perDay("sewa 3 hari 200rb")).toEqual([66667]);
    expect(perDay("500 pesos kada araw")).toEqual([500]);
  });
});

describe("a magnitude suffix is part of the number, not decoration", () => {
  it("EXECUTED: reading 70rb as SEVENTY was worse than reading nothing", () => {
    // A 70-rupiah scooter is a phantom bargain that beats every real quote in
    // the hunt, so it would have won BEST PRICE.
    expect(perDay("70rb/hari")).toEqual([70000]);
    expect(perDay("150k/ngày")).toEqual([150000]);
  });

  it("EXECUTED: the suffix is itself rate evidence - nobody writes '3k days'", () => {
    const r = scanRates("150k/ngày");
    expect(r).toHaveLength(1);
    expect(r[0].amount).toBe(150000);
    expect(r[0].unit).toBe("day");
  });

  it("EXECUTED: a native WEEK or MONTH word is not lumped in with days", () => {
    // "minggu" is a week and starts with m; "mes" is a month and starts with m.
    // A first-letter test cannot tell them apart, and the old one did not try.
    expect(scanRates("500rb per minggu")[0]?.unit).toBe("week");
    expect(scanRates("2jt per bulan")[0]?.unit).toBe("month");
    expect(scanRates("250 บาท ต่อ เดือน")[0]?.unit).toBe("month");
  });
});

describe("the phantom guards are untouched by the new vocabulary", () => {
  it("EXECUTED: a duration condition is still not a price", () => {
    expect(perDay("minimum 3 days 500 deposit")).toEqual([]);
    expect(perDay("We are open 7 days 9am to 6pm")).toEqual([]);
  });

  it("EXECUTED: a real English total still divides exactly as before", () => {
    expect(perDay("1500 for 5 days")).toEqual([300]);
    expect(perDay("250 baht per day")).toEqual([250]);
  });
});

describe("a currency word many countries share cannot overrule the country", () => {
  it("EXECUTED: 'pesos' means what the shop's own region means", () => {
    // Executed across ten markets, EIGHT rendered the wrong currency: "250
    // pesos per day" in Mexico came out as PHP with a ₱ sign, because the word
    // was genuinely "mentioned" and reconcileCurrency defended it.
    expect(reconcileCurrency("PHP", "MXN", "250 pesos per day")).toBe("MXN");
    expect(reconcileCurrency("PHP", "COP", "50000 pesos per day")).toBe("COP");
    // ...and in the Philippines it still means PHP.
    expect(reconcileCurrency("PHP", "PHP", "250 pesos per day")).toBe("PHP");
  });

  it("EXECUTED: 'dollars' and 'rupees' are the same class of ambiguity", () => {
    expect(reconcileCurrency("USD", "AUD", "45 dollars per day")).toBe("AUD");
    expect(reconcileCurrency("USD", "SGD", "40 dollars per day")).toBe("SGD");
    expect(reconcileCurrency("INR", "LKR", "3000 rupees per day")).toBe("LKR");
    expect(reconcileCurrency("INR", "NPR", "1500 rupees per day")).toBe("NPR");
  });

  it("EXECUTED: an UNAMBIGUOUS symbol or code still wins over the region", () => {
    // The traveller's region is not always the shop's, and a shop that types
    // ฿ or THB means it.
    expect(reconcileCurrency("THB", "IDR", "250฿ per day")).toBe("THB");
    expect(reconcileCurrency("THB", "IDR", "250 THB per day")).toBe("THB");
    // And the misspelling half of the same defect stays fixed.
    expect(reconcileCurrency("THB", "USD", "900 bath for 4 day")).toBe("THB");
  });

  it("EXECUTED: mentionedCurrencies resolves the shared word against the region", () => {
    expect(mentionedCurrencies("250 pesos", "MXN")).toEqual(["MXN"]);
    expect(mentionedCurrencies("250 pesos", "PHP")).toEqual(["PHP"]);
    // With no region there is nothing to resolve against - the single guess
    // stands, exactly as before.
    expect(mentionedCurrencies("250 pesos")).toEqual(["PHP"]);
  });
});
