import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readTypedWindow,
  windowConflict,
  withoutWindowText,
} from "./request-window-conflict";
import { readShopDateRange, spanBetween } from "./wa/shop-date-range";
import { extractQuotedPrices } from "./wa/price-extract";

// TWO PROBLEMS THE RUNBOOK CALLED FIXED AND WHICH DID NOT EXIST IN CODE.
//
// Problem 3 credited a "shop-side date-range reader": grep found the phrase in
// RUNBOOK.md and nowhere else. Problem 9 credited "W4 conflict chips": no
// date/duration reconciliation surface existed at all.

const perDay = (text: string, durationDays = 3) =>
  extractQuotedPrices(text, { durationDays, localCurrency: "THB" } as never).allOffers.map(
    (o) => [o.pricePerDay, o.derivedFromDays] as const
  );

describe("problem 3: the shop states its dates and we read the price", () => {
  it("EXECUTED: the literal reported message finally reads", () => {
    // "27 to 1 the is 1250" used to return NOTHING - the shop's real 1250 was
    // lost - and its dated cousins turned the DATE digits into THB 2/day and
    // THB 5/day tiers.
    expect(perDay("27 to 1 the is 1250")).toEqual([[250, 5]]);
    expect(perDay("27/12 to 1/1 total 1250")).toEqual([[250, 5]]);
    expect(perDay("Dec 27 to Jan 1 is 1250 baht")).toEqual([[250, 5]]);
    expect(perDay("27-1 1250")).toEqual([[250, 5]]);
    expect(perDay("from 27 to 1 total 1250 baht")).toEqual([[250, 5]]);
  });

  it("EXECUTED: the derived rate carries the SHOP's span, not the traveller's", () => {
    // The traveller asked for 3 days; the shop priced 5. Stamping the shop's
    // span is what lets the like-for-like rival guard discount the package.
    const [[, basis]] = perDay("27 to 1 the is 1250", 3);
    expect(basis).toBe(5);
  });

  it("EXECUTED: a real two-tier quote is NOT read as a date range", () => {
    // The bare "27 to 1" shape is only a date beside a package-scale amount -
    // otherwise "250 or 300" would lose a tier, which is a worse bug.
    expect(perDay("250 or 300 per day").map((p) => p[0]).sort((a, b) => a - b)).toEqual([250, 300]);
    expect(perDay("200 and 250 per day").map((p) => p[0]).sort((a, b) => a - b)).toEqual([200, 250]);
  });

  it("EXECUTED: a price-board TIER row is not a date range", () => {
    // "2-10 days - P 400" is a rate card row: the range is how long you rent.
    // Blanking it as a date deleted a whole tier from the board.
    expect(readShopDateRange("2-10 days - P 400", { requireTotalNear: true })).toBe(null);
    expect(readShopDateRange("8 - 14 day 250", { requireTotalNear: true })).toBe(null);
  });

  it("EXECUTED: the span arithmetic is nights, and it crosses the month", () => {
    expect(spanBetween(5, 9)).toBe(4);
    expect(spanBetween(27, 1)).toBe(5); // 31-day month
    expect(spanBetween(27, 1, 2)).toBe(2); // February
    expect(spanBetween(27, 1, 4)).toBe(4); // 30-day month
  });
});

describe("problem 9: two rental windows can no longer ride in one message", () => {
  it("EXECUTED: free text that states its own window is recognised", () => {
    expect(readTypedWindow("27 to 1")?.days).toBe(5);
    expect(readTypedWindow("5 days")?.days).toBe(5);
    expect(readTypedWindow("for 10 days please")?.days).toBe(10);
  });

  it("EXECUTED: an ACCESSORY is never mistaken for a duration", () => {
    // Reading "2 helmets" as a two-day rental would be worse than the bug this
    // fixes, so a count only counts beside a TIME word.
    for (const t of ["2 helmets", "a phone holder", "top box", "child seat", "3 bags"]) {
      expect(readTypedWindow(t), t).toBe(null);
    }
  });

  it("EXECUTED: agreement is not a conflict", () => {
    expect(windowConflict("3 days", 3)).toBe(null);
    expect(windowConflict("a phone holder", 3)).toBe(null);
    expect(windowConflict("", 3)).toBe(null);
  });

  it("EXECUTED: a real disagreement is reported with both numbers", () => {
    const clash = windowConflict("27 to 1", 3);
    expect(clash).not.toBe(null);
    expect(clash!.typed.days).toBe(5);
    expect(clash!.pickerDays).toBe(3);
    expect(clash!.typed.text).toBe("27 to 1");
  });

  it("EXECUTED: the window is stripped from what the shops are told", () => {
    // The opener already states the picker's dates; appending the typed ones
    // is what put two rentals in one message.
    expect(withoutWindowText("27 to 1, 2 helmets")).toBe(", 2 helmets");
    expect(withoutWindowText("2 helmets")).toBe("2 helmets");
  });

  it("the builder shows the chip and strips the dates from the accessories", () => {
    const builder = readFileSync(join(process.cwd(), "src/components/RequestBuilder.tsx"), "utf8");
    expect(builder).toMatch(/windowConflict\(custom, days\)/);
    expect(builder).toMatch(/accessories: parseExtras\(storageBox, withoutWindowText\(custom\)\)/);
  });
});
