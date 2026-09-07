// AUDIT F099 - a day RANGE is a duration, never a rate.
//
// "Rental period 2-4 days ok" satisfied scanRates' separator test (the bare
// hyphen is in SEP), so the FOUR was read as the denominator and the TWO as the
// money: perDay = round(2/4) = 1. price-extract then took that 1-baht phantom
// as the cheapest live offer, beating the shop's own explicit "300 per day".
//
// Executed against the real parsers - no source grepping.
import { describe, it, expect } from "vitest";
import { scanRates } from "./rate-expr";
import { extractQuotedPrices } from "./price-extract";

const offers = (text: string, durationDays = 3, localCurrency = "THB") =>
  extractQuotedPrices(text, { durationDays, localCurrency } as never);

describe("F099: a day range is a duration, not a rate", () => {
  it("EXECUTED: a bare day range mints no rate at all", () => {
    // No money anywhere in either string. Both used to return a 1-per-day rate.
    expect(scanRates("Available for 4-7 days only")).toHaveLength(0);
    expect(scanRates("8 - 14 days")).toHaveLength(0);
    expect(scanRates("we rent 1-2 days, longer is cheaper")).toHaveLength(0);
  });

  it("EXECUTED: the explicit daily survives a day range in the same message", () => {
    const r = offers("Price 300 per day. Rental period 2-4 days ok");
    expect(r.offer?.pricePerDay).toBe(300);
    expect(r.allOffers.map((o) => o.pricePerDay)).toEqual([300]);
  });

  it("EXECUTED: a message that is ONLY a day range yields no price", () => {
    expect(offers("Available for 4-7 days only", 5).offer).toBeNull();
  });

  it("EXECUTED: every genuine denominator form is untouched", () => {
    // A rate always has more money than units; a duration range runs low to
    // high. These five are the file's own denominator cases.
    expect(scanRates("3000/7days")[0].perDay).toBe(429);
    expect(scanRates("Click 125cc 6 days discount 250/1day")[0].perDay).toBe(250);
    expect(scanRates("4500 per 30 days")[0].perDay).toBe(150);
    expect(scanRates("1750 5 days")[0].perDay).toBe(350);
    // ...and the two that survive only because a currency marker is present.
    expect(scanRates("500rs/2days")[0].perDay).toBe(250);
    expect(scanRates("Honda click 125cc 1200b./6days")[0].perDay).toBe(200);
  });
});
