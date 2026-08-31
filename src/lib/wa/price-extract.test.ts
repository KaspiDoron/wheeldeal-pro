import { describe, it, expect } from "vitest";
import {
  extractQuotedPrices,
  extractRentalDailyPrice,
  isListPriceAt,
  mentionedCurrencies,
  reconcileCurrency,
} from "./price-extract";

// The exact Sun House Rental template that broke the parser in production: a
// business greeting, three port/airport transfer lines priced "/trip", the real
// scooter rental line "Scooter: 350 PHP/day", and an island-tour upsell.
const SUN_HOUSE = `Welcome to Sun House Rental! Here are our services:
Airport <-> Sun House Rental: 250 PHP/trip
Balbagon Port <-> Sun House Rental: 350 PHP/trip
Benoni Port <-> Sun House Rental: 600 PHP/trip
Scooter: 350 PHP/day
Island tour available, ask us for a quote!
Thank you and God bless.`;

describe("extractRentalDailyPrice - Sun House Rental (the production breaker)", () => {
  it("extracts the scooter /day rate and IGNORES the /trip transfer prices", () => {
    const hit = extractRentalDailyPrice(SUN_HOUSE, {
      vehicleClass: "scooter",
      durationDays: 5,
    });
    expect(hit).not.toBeNull();
    expect(hit!.pricePerDay).toBe(350);
    expect(hit!.currency).toBe("PHP");
    // NEVER the 250/350/600 "/trip" transfer numbers.
    expect(hit!.line.toLowerCase()).toContain("scooter");
    expect(hit!.line.toLowerCase()).not.toContain("trip");
  });

  it("does NOT grab the cheaper 250 airport-transfer number", () => {
    const hit = extractRentalDailyPrice(SUN_HOUSE, { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).not.toBe(250);
    expect(hit!.pricePerDay).not.toBe(600);
  });

  it("classMatch is true for a scooter request against the 'Scooter:' line", () => {
    const hit = extractRentalDailyPrice(SUN_HOUSE, { vehicleClass: "scooter" });
    expect(hit!.classMatch).toBe(true);
  });
});

describe("extractRentalDailyPrice - currency in either position", () => {
  it("handles currency AFTER the number ('350 PHP/day')", () => {
    const hit = extractRentalDailyPrice("Scooter is 350 PHP/day", { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(350);
    expect(hit!.currency).toBe("PHP");
  });

  it("handles currency BEFORE the number ('PHP 350 per day')", () => {
    const hit = extractRentalDailyPrice("PHP 350 per day for the scooter", { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(350);
    expect(hit!.currency).toBe("PHP");
  });

  it("handles a bare number with a local-currency hint", () => {
    const hit = extractRentalDailyPrice("350 per day", { vehicleClass: "scooter", localCurrency: "PHP" });
    expect(hit!.pricePerDay).toBe(350);
    expect(hit!.currency).toBe("PHP");
  });

  it("handles the baht symbol ('฿300/day')", () => {
    const hit = extractRentalDailyPrice("฿300/day", { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(300);
    expect(hit!.currency).toBe("THB");
  });
});

describe("extractRentalDailyPrice - class selection", () => {
  it("prefers the matching class line over a cheaper different-class line", () => {
    const text = `Car: 900/day\nScooter: 400/day\nMotorbike: 350/day`;
    const hit = extractRentalDailyPrice(text, { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(400);
    expect(hit!.classMatch).toBe(true);
  });

  it("returns the cheapest among multiple matching-class lines", () => {
    const text = `Yamaha Fino scooter 280/day\nHonda Click scooter 300/day\nNMAX scooter 500/day`;
    const hit = extractRentalDailyPrice(text, { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(280);
  });

  it("flags a wrong-class-only reply with classMatch false", () => {
    const hit = extractRentalDailyPrice("Sedan car 1200/day", { vehicleClass: "scooter" });
    expect(hit).not.toBeNull();
    expect(hit!.classMatch).toBe(false);
  });

  it("class-agnostic bare price ('350/day') matches any request", () => {
    const hit = extractRentalDailyPrice("It's 350/day", { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(350);
    expect(hit!.classMatch).toBeUndefined();
  });
});

describe("extractRentalDailyPrice - totals and edge cases", () => {
  it("divides a whole-rental total ('1750 for 5 days')", () => {
    const hit = extractRentalDailyPrice("Scooter 1750 for 5 days", { vehicleClass: "scooter", durationDays: 5 });
    expect(hit!.pricePerDay).toBe(350);
  });

  it("does NOT mistake the day COUNT for a price ('3 day 900' -> 300, not 3)", () => {
    const hit = extractRentalDailyPrice("scooter 3 days 900", { vehicleClass: "scooter", durationDays: 3 });
    expect(hit!.pricePerDay).toBe(300);
  });

  // PRICE_TOTAL_REV phantom guards (Wave 0). The reverse divider used to bridge
  // a day token to an unrelated number across a noun, minting per-day offers
  // that could BEAT the shop's real quote.
  it("does NOT read a deposit clause as a rental total ('minimum 3 days rental 500 deposit')", () => {
    expect(
      extractRentalDailyPrice("minimum 3 days rental 500 deposit", { vehicleClass: "scooter", durationDays: 3 })
    ).toBeNull();
  });

  it("does NOT read opening hours as a rental total ('open 7 days a week 8am to 8pm')", () => {
    expect(
      extractRentalDailyPrice("we are open 7 days a week 8am to 8pm", { vehicleClass: "scooter", durationDays: 3 })
    ).toBeNull();
  });

  it("keeps the marked daily over a phantom division on the same reply (-> 250, not 167)", () => {
    const hit = extractRentalDailyPrice("250 baht per day\nminimum 3 days, deposit 500", {
      vehicleClass: "scooter",
      durationDays: 3,
    });
    expect(hit!.pricePerDay).toBe(250);
  });

  // Currency totality (Wave 0): 'bath'/'bht' are misspellings shops really type;
  // they must resolve to THB, never the invalid ISO code "BATH"/"BHT".
  it("resolves the 'bath' misspelling to THB, not an invented code", () => {
    const q = extractQuotedPrices("Special price 900 bath for 4 day", {
      vehicleClass: "scooter",
      durationDays: 4,
      engineSizeCc: 125,
    });
    expect(q.offer?.currency).toBe("THB");
  });

  it("mentionedCurrencies skips an unrecognised token instead of inventing a code", () => {
    expect(mentionedCurrencies("300 bath")).toEqual(["THB"]);
    expect(mentionedCurrencies("300 zzz")).toEqual([]);
  });

  it("returns null on a transfer-ONLY template (no rental line)", () => {
    const text = `Airport transfer: 250 PHP/trip\nPort transfer: 350 PHP/trip`;
    expect(extractRentalDailyPrice(text, { vehicleClass: "scooter" })).toBeNull();
  });

  it("returns null on a pure greeting", () => {
    expect(extractRentalDailyPrice("Hello sir! Welcome!", { vehicleClass: "scooter" })).toBeNull();
  });

  it("returns null on empty / whitespace", () => {
    expect(extractRentalDailyPrice("", {})).toBeNull();
    expect(extractRentalDailyPrice("   \n  ", {})).toBeNull();
  });

  it("handles a single-line reply with no newlines", () => {
    const hit = extractRentalDailyPrice("yes sir 350 php per day ok", { vehicleClass: "scooter" });
    expect(hit!.pricePerDay).toBe(350);
  });

  // ---- live-failure pins (the "3 of 4 offers vanished" formats) --------------

  it("MONTHLY quote on a 30-day search -> per-day over the real duration", () => {
    const hit = extractRentalDailyPrice("4000 baht per month", {
      vehicleClass: "scooter",
      durationDays: 30,
      localCurrency: "THB",
    });
    expect(hit!.pricePerDay).toBe(133); // 4000/30
    expect(hit!.currency).toBe("THB");
  });

  it("monthly phrased as 'monthly rate is 4500'", () => {
    const hit = extractRentalDailyPrice("monthly rate is 4500", { durationDays: 30 });
    expect(hit!.pricePerDay).toBe(150);
  });

  it("WEEKLY quote -> /7", () => {
    const hit = extractRentalDailyPrice("1400 a week sir", { durationDays: 7 });
    expect(hit!.pricePerDay).toBe(200);
  });

  it("BARE-NUMBER answer to our price question ('400 baht')", () => {
    const hit = extractRentalDailyPrice("400 baht", { durationDays: 30, localCurrency: "THB" });
    expect(hit!.pricePerDay).toBe(400);
  });

  it("bare plain number ('450')", () => {
    const hit = extractRentalDailyPrice("450", { durationDays: 4 });
    expect(hit!.pricePerDay).toBe(450);
  });

  it("bare number rejects times, tiny numbers and phone numbers", () => {
    expect(extractRentalDailyPrice("9", {})).toBeNull();
    expect(extractRentalDailyPrice("9:00", {})).toBeNull();
    expect(extractRentalDailyPrice("0812345678", {})).toBeNull();
    expect(extractRentalDailyPrice("we open at 9", {})).toBeNull();
  });

  it("k-notation ('150k per day' IDR)", () => {
    const hit = extractRentalDailyPrice("150k per day", { localCurrency: "IDR" });
    expect(hit!.pricePerDay).toBe(150000);
  });
});

// ---------------------------------------------------------------------------
// The Krabi incident. A shop agreed 250/day, then wrote "That is a discount
// already, normally it's 300/day" - and the app showed the traveller "RM
// 300/day": the wrong price AND the wrong country's money, because "no-RM-ally"
// matched the ringgit code and the list price was read as a fresh quote.
// ---------------------------------------------------------------------------
const KRABI = { vehicleClass: "scooter" as const, durationDays: 5, localCurrency: "THB" };

describe("a currency code buried in an ordinary word is not a currency", () => {
  it("'normally' is not Malaysian ringgit", () => {
    // (the amount itself is a list price, so it lands in listPrice - see below)
    expect(extractQuotedPrices("normally 300/day", KRABI).listPrice!.currency).toBe("THB");
    expect(extractRentalDailyPrice("ok 300/day", KRABI)!.currency).toBe("THB");
    expect(mentionedCurrencies("That is a discount already, normally it's 300/day")).toEqual([]);
  });

  it("neither is 'confirm', 'airport' or 'nomad'", () => {
    expect(mentionedCurrencies("please confirm 300/day")).toEqual([]);
    expect(mentionedCurrencies("airport pickup included")).toEqual([]);
    expect(mentionedCurrencies("nomad rates available")).toEqual([]);
  });

  it("'try' and 'mad' never name a currency, but a real code still does", () => {
    expect(mentionedCurrencies("we will try 300")).toEqual([]);
    expect(mentionedCurrencies("RM 300 per day")).toEqual(["MYR"]);
    expect(mentionedCurrencies("300 baht per day")).toEqual(["THB"]);
    expect(mentionedCurrencies("฿300")).toEqual(["THB"]);
  });

  it("a real ringgit quote is still read as ringgit", () => {
    const hit = extractRentalDailyPrice("RM 300/day", { ...KRABI, localCurrency: "MYR" });
    expect(hit!.currency).toBe("MYR");
  });
});

describe("a restated LIST price is an anchor, never the offer", () => {
  it("the exact reply that broke it: 300 is kept as the anchor, no new offer", () => {
    const q = extractQuotedPrices(
      "That is a discount already, normally it's 300/day\nWhere are you staying?",
      KRABI
    );
    expect(q.offer).toBeNull(); // the agreed 250 stands untouched
    expect(q.listPrice!.pricePerDay).toBe(300);
    expect(q.listPrice!.currency).toBe("THB");
  });

  it("the opening quote: 300 normal, 250 offered -> the offer is 250", () => {
    const q = extractQuotedPrices(
      "Normally we can do fr 300/day\nI can drop it to 250/day for you\nWe can also drop it off at your place",
      KRABI
    );
    expect(q.offer!.pricePerDay).toBe(250);
    expect(q.listPrice!.pricePerDay).toBe(300);
  });

  it("both prices on ONE line still separate correctly", () => {
    const q = extractQuotedPrices("Normally 300/day but for you 250/day", KRABI);
    expect(q.offer!.pricePerDay).toBe(250);
    expect(q.listPrice!.pricePerDay).toBe(300);
  });

  it("'was X now Y' reads Y as the offer", () => {
    const q = extractQuotedPrices("was 400/day, now 320/day", KRABI);
    expect(q.offer!.pricePerDay).toBe(320);
    expect(q.listPrice!.pricePerDay).toBe(400);
  });

  it("a plain quote is never mistaken for a list price", () => {
    const q = extractQuotedPrices("300/day for the scooter", KRABI);
    expect(q.offer!.pricePerDay).toBe(300);
    expect(q.listPrice).toBeNull();
  });

  it("the cue only governs a number it actually precedes", () => {
    expect(isListPriceAt("normally it's 300/day", "normally it's ".length)).toBe(true);
    expect(isListPriceAt("300/day is normal for us", 0)).toBe(false);
  });
});

describe("reconcileCurrency - the shop's own money wins unless they typed otherwise", () => {
  it("keeps a foreign currency the shop really typed", () => {
    expect(reconcileCurrency("MYR", "THB", "RM 300 per day")).toBe("MYR");
    expect(reconcileCurrency("USD", "THB", "$10 per day")).toBe("USD");
  });

  it("falls back to the region when the currency was never mentioned", () => {
    expect(reconcileCurrency("MYR", "THB", "normally it's 300/day")).toBe("THB");
    expect(reconcileCurrency("USD", "THB", "300 per day")).toBe("THB");
  });

  it("is a no-op when there is nothing to reconcile", () => {
    expect(reconcileCurrency("THB", "THB", "300")).toBe("THB");
    expect(reconcileCurrency(undefined, "THB", "300")).toBe("THB");
    expect(reconcileCurrency("THB", undefined, "300")).toBe("THB");
  });
});

describe("the bare-number rescue survives burst coalescing (owner report 5)", () => {
  // The field failure: the shop answered "200 baht" as one frame of a burst.
  // The coalescer joins every unread frame with newlines, so the WHOLE text is
  // far over the 40-char bare-message ceiling and the rescue never fired - the
  // card said "No price yet" while the excerpt showed the price. The rescue now
  // also runs PER LINE, with the identical strict shape + sanity band.
  it("finds a bare price on ONE LINE of a long coalesced message", () => {
    const burst = [
      "Hello! Sorry for late reply, we were busy at the shop today",
      "200 baht",
      "You can come pick it up any time before 8pm, we are near the pier",
    ].join("\n");
    const hit = extractRentalDailyPrice(burst, { vehicleClass: "scooter", durationDays: 3 });
    expect(hit).not.toBeNull();
    expect(hit!.pricePerDay).toBe(200);
    expect(hit!.currency).toBe("THB");
  });

  it("the whole-message rescue still works exactly as before", () => {
    const hit = extractRentalDailyPrice("400 baht", { durationDays: 2 });
    expect(hit!.pricePerDay).toBe(400);
  });

  it("a line that is not a bare amount never passes (times, years, day counts)", () => {
    // "3" == durationDays is excluded; "open 8:30 am" has no bare-amount shape;
    // a long chatty line is skipped by the 40-char line ceiling.
    const burst = ["we open 8:30 am, close 8:00 pm", "3", "see you soon!"].join("\n");
    expect(extractRentalDailyPrice(burst, { durationDays: 3 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W12b: THE PHANTOM TABLE.
//
// Two regression tests used to pin the two literal strings the field reported,
// and an audit defeated both by moving one word: "minimum 3 days rental 500
// deposit" was caught, "Minimum RENTAL 3 days 500 deposit" divided to 167/day.
// A guard that only holds for one word order is not a guard, so the cases are a
// TABLE of permutations now - and the executed evidence from that audit is in
// it, every phantom it found included.
// ---------------------------------------------------------------------------

describe("a division only happens when the dividend is really rent", () => {
  const opts = { durationDays: 4, localCurrency: "THB" } as const;
  const perDay = (text: string) =>
    extractQuotedPrices(text, opts as never).allOffers.map((o) => o.pricePerDay);

  it("EXECUTED: a qualifying MINIMUM is not a total, in any word order", () => {
    for (const text of [
      "minimum 3 days rental 500 deposit",
      "Minimum rental 3 days 500 deposit",
      "Minimum of 3 days 500 deposit required",
      "we rent from 3 days, 500 deposit",
      "at least 3 days and 500 deposit",
    ]) {
      expect(perDay(text), text).toEqual([]);
    }
  });

  it("EXECUTED: a charge word AFTER the amount disqualifies it, like one before", () => {
    // The clause check only looked at the 28 chars BEFORE the amount, so
    // "3000 baht deposit" - the way people actually write it - divided.
    expect(perDay("Booking requires 2 days 3000 baht deposit and passport")).toEqual([]);
    expect(perDay("2 days, deposit 3000 baht")).toEqual([]);
  });

  it("EXECUTED: a clock time and a percentage are not rental totals", () => {
    for (const text of [
      "We are open 7 days 9am to 6pm",
      "Sorry we are closed. Reopen in 2 days at 9",
      "Hi! This is an automated message. We will get back to you in 2 days 100%",
      "open 7 days until 8pm",
    ]) {
      expect(perDay(text), text).toEqual([]);
    }
  });

  it("EXECUTED: a REAL package total still divides - the guards are not a blanket", () => {
    expect(perDay("1500 for 5 days")).toEqual([300]);
    // The shop's OWN span divides its own total: 1250 over the 5 days it
    // named, not over the 4 the traveller asked for.
    expect(perDay("5 days 1250 total")).toContain(250);
    expect(perDay("3 days 900")).toContain(300);
  });
});

describe("a date range is not a cheaper price tier", () => {
  const opts = { durationDays: 4, localCurrency: "THB" } as const;
  const perDay = (text: string) =>
    extractQuotedPrices(text, opts as never).allOffers.map((o) => o.pricePerDay);

  it("EXECUTED: 'available 27 to 1, 250 per day' quotes 250 and nothing else", () => {
    // The alternation walker harvested the shop's START DATE as a tier, and
    // since the menu picks the CHEAPEST row, 27 became the shop's best price.
    expect(perDay("available 27 to 1, 250 per day")).toEqual([250]);
  });

  it("EXECUTED: a genuine two-tier quote is untouched", () => {
    // The guard needs BOTH a day-of-month range AND an order-of-magnitude gap,
    // so real alternations - which are never 10x apart - still read.
    expect(perDay("250 or 300 per day").sort((a, b) => a - b)).toEqual([250, 300]);
    expect(perDay("200 and 250 per day").sort((a, b) => a - b)).toEqual([200, 250]);
  });
});
