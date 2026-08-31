import { describe, it, expect } from "vitest";
import { countryForShop } from "./copy/region";
import { currencyForRegion } from "./agents";
import { reconcileCurrency } from "./wa/price-extract";

// Wave 3: the currency of record is resolved
//   explicit token -> region -> SHOP-PREFIX country -> undefined
// and NEVER defaulted to USD when the shop's phone reveals the country. The old
// chain consulted only a free-text region regex (undefined for "Ao Nang") and
// then fell back to USD, storing a +66 shop's "250 per day" as $250/day.
describe("currency resolves from the shop's phone prefix, not a USD default", () => {
  const cases: Array<[string, string]> = [
    ["66812345678", "THB"], // Thailand
    ["6281234567890", "IDR"], // Indonesia
    ["639171234567", "PHP"], // Philippines
    ["84901234567", "VND"], // Vietnam
    ["919812345678", "INR"], // India
  ];
  for (const [digits, code] of cases) {
    it(`a +${digits.slice(0, 2)}... shop resolves to ${code} via countryForShop`, () => {
      const region = currencyForRegion(countryForShop(digits) || undefined);
      expect(region).toBe(code);
    });
  }

  it("a region with no country token yields to the shop prefix instead of USD", () => {
    // "Ao Nang" names no country, so currencyForRegion(region) is undefined...
    expect(currencyForRegion("Ao Nang")).toBeUndefined();
    // ...but the shop-prefix chain still lands on THB.
    const localCur =
      currencyForRegion("Ao Nang") ?? currencyForRegion(countryForShop("66812345678") || undefined);
    // A bare "250 per day" reply (no explicit currency token) then reconciles to
    // the resolved local currency, never USD.
    const cur = reconcileCurrency(undefined, localCur, "250 per day") || localCur || "USD";
    expect(cur).toBe("THB");
  });
});
