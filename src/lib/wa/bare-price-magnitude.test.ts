// AUDIT F100 - the bare-number rescue must read the magnitude suffix.
//
// "350rb" is Rp 350,000 a day. BARE_PRICE was built from lead-currency, number
// and trailing-currency only, and "rb"/"jt" are IN the currency vocabulary - so
// the suffix was swallowed as a currency marker and the amount under-read by a
// factor of 1000. "2jt" and "1.5jt" fell under the plausibility band entirely
// and returned no price at all.
//
// Executed against the real extractor - no source grepping.
import { describe, it, expect } from "vitest";
import { extractQuotedPrices } from "./price-extract";

const bare = (text: string, durationDays = 3, localCurrency = "IDR") =>
  extractQuotedPrices(text, { durationDays, localCurrency } as never).offer?.pricePerDay ?? null;

describe("F100: a magnitude suffix is part of a bare price", () => {
  it("EXECUTED: the whole-message rescue applies the suffix", () => {
    expect(bare("350rb")).toBe(350_000);
    expect(bare("200 ribu")).toBe(200_000);
    expect(bare("70rb")).toBe(70_000);
    expect(bare("2jt")).toBe(2_000_000);
    expect(bare("1.5jt")).toBe(1_500_000);
  });

  it("EXECUTED: the PER-LINE rescue applies it too (burst coalescing)", () => {
    // A coalesced burst is far over the 40-char whole-text bound, so the price
    // only ever reaches the line-level rescue.
    expect(bare("Halo kak, tersedia\n350rb\nsilakan datang")).toBe(350_000);
    expect(bare("Selamat pagi kak, motor ready ya\n1.5jt\nsilakan mampir")).toBe(1_500_000);
  });

  it("EXECUTED: Vietnamese thousands read the same way", () => {
    expect(bare("150 nghìn", 3, "VND")).toBe(150_000);
  });

  it("EXECUTED: the plain forms and the sanity band are unchanged", () => {
    expect(bare("400", 3, "THB")).toBe(400);
    expect(bare("400 baht", 3, "THB")).toBe(400);
    expect(bare("PHP 350 only", 3, "PHP")).toBe(350);
    // Under the band, and a clock time is still not a price.
    expect(bare("9", 3, "THB")).toBeNull();
  });
});
