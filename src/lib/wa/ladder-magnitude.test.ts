// AUDIT F101 - a price board written with rb/jt suffixes is not 1000x cheap.
//
// amountOf matched the digit run and nothing else, so "3-7 days 250rb" read as
// 250. A ladder of two or more rows returns early from extractQuotedPrices AND
// overrides the model's own read in agent-loop, so the mis-scaled number became
// the price of record for the whole thread. The million form ("1.5jt") did not
// parse at all - AMOUNT needed two digits - so the board fell through to the
// generic readers instead.
//
// Executed against the real ladder parser - no source grepping.
import { describe, it, expect } from "vitest";
import { parseRateLadder, ladderRateFor } from "./rate-ladder";
import { extractQuotedPrices } from "./price-extract";

const IDR_BOARD = "1-2 days 300rb\n3-7 days 250rb\n8-14 days 200rb";
const IDR_MILLIONS = "1-2 days 1.5jt\n3-7 days 1.2jt";

describe("F101: ladder amounts carry their magnitude suffix", () => {
  it("EXECUTED: an Indonesian rb board reads in full rupiah", () => {
    const tiers = parseRateLadder(IDR_BOARD, { localCurrency: "IDR" });
    expect(tiers.map((t) => t.statedAmount)).toEqual([300_000, 250_000, 200_000]);
    expect(tiers.map((t) => t.pricePerDay)).toEqual([300_000, 250_000, 200_000]);
    expect(tiers.every((t) => t.unit === "per-day")).toBe(true);
  });

  it("EXECUTED: the 5-day tier off that board is 250,000, not 250", () => {
    expect(ladderRateFor(IDR_BOARD, 5, { localCurrency: "IDR" })?.pricePerDay).toBe(250_000);
    const r = extractQuotedPrices(IDR_BOARD, {
      durationDays: 5,
      localCurrency: "IDR",
    } as never);
    expect(r.offer?.pricePerDay).toBe(250_000);
  });

  it("EXECUTED: a one-digit mantissa with a suffix is a readable row", () => {
    const tiers = parseRateLadder(IDR_MILLIONS, { localCurrency: "IDR" });
    expect(tiers.map((t) => t.statedAmount)).toEqual([1_500_000, 1_200_000]);
    expect(tiers.map((t) => t.pricePerDay)).toEqual([1_500_000, 1_200_000]);
  });

  it("EXECUTED: the plausibility band still applies AFTER the magnitude", () => {
    // 550 million a day is not a rate, so that row carries no amount and the
    // board is not a ladder at all.
    expect(parseRateLadder("1-2 days 550m\n3-7 days 500m", { localCurrency: "IDR" })).toEqual([]);
  });

  it("EXECUTED: the peso board every earlier test pins is unchanged", () => {
    const board =
      "1-2 days - 650\n3-7 days - 600\n8-14 days - 550\n15-29 days - 500\nMonthly - 450";
    expect(parseRateLadder(board).map((t) => t.pricePerDay)).toEqual([650, 600, 550, 500, 450]);
    // A currency word glued to the amount must not truncate it.
    expect(
      parseRateLadder("1-2 days 650php\n3-7 days 600php").map((t) => t.statedAmount)
    ).toEqual([650, 600]);
  });
});
