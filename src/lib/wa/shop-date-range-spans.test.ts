// AUDIT F103 + F105 - the two branches of readShopDateRange that mis-read a span.
//
// F103: opening hours ("9.30 - 5.30") and a decimal price range ("25.00 -
// 30.00") were accepted as dates because only the DAY halves were validated,
// so the digits were blanked out of the text and the shop's total was divided
// by a span nobody stated.
//
// F105: both dated shapes capture the END month and then discard it, so any
// range whose end day-of-month is greater than its start day-of-month was
// scored as a same-month span - "Aug 1 to Sep 10" read as 9 nights instead of
// 40, and the package total beside it divided by 9.
//
// Executed against the real parser: no source greps, no mocks needed - the
// module is pure.

import { describe, it, expect } from "vitest";
import { readShopDateRange, spanBetween } from "./shop-date-range";
import { extractQuotedPrices } from "./price-extract";

const range = (t: string) => readShopDateRange(t, { requireTotalNear: true });
const offer = (t: string, durationDays: number) =>
  extractQuotedPrices(t, { durationDays, localCurrency: "THB" } as never).offer;

describe("F103: a clock time or a decimal price range is not a shop date range", () => {
  it("EXECUTED: opening hours are not a 27-day rental window", () => {
    // "9.30 - 5.30" has month halves of 30 and 30. Read as a date it gave
    // {startDay:9, endDay:5, spanDays:27} and the shop's 1500 for a 5-day
    // rental was published as 56/day instead of 300/day.
    expect(range("Open 9.30 - 5.30. 1500 baht")).toBe(null);
    expect(range("open 8.00 - 20.00\n1500 baht")).toBe(null);
    expect(range("Hours 9:30 - 5:30, 1500 baht total")).toBe(null);
  });

  it("EXECUTED: a decimal price range is not a date range", () => {
    expect(range("Car rental 25.00 - 30.00 EUR per day")).toBe(null);
  });

  it("EXECUTED: the ungrounded 56/day derived from those hours is gone", () => {
    const o = offer("Open 9.30 - 5.30. 1500 baht", 5) as
      | (Record<string, unknown> & { pricePerDay: number; derivedFromDays?: number })
      | null;
    expect(o?.derivedFromDays).not.toBe(27);
    expect(o?.pricePerDay).not.toBe(56);
  });

  it("EXECUTED: a real dated range still reads", () => {
    expect(range("27/12 to 1/1 total 1250")?.spanDays).toBe(5);
    expect(range("27.12 - 1.1 total 1250")?.spanDays).toBe(5);
    expect(range("Dec 27 to Jan 1 is 1250 baht")?.spanDays).toBe(5);
    expect(range("27 to 1 the is 1250")?.spanDays).toBe(5);
    expect(range("27-1 1250")?.spanDays).toBe(5);
  });
});

describe("F105: a range that crosses a month is counted across the month", () => {
  it("EXECUTED: spanBetween walks the calendar when both months are known", () => {
    expect(spanBetween(1, 10, 8, 9)).toBe(40); // 1 Aug to 10 Sep
    expect(spanBetween(27, 1, 12, 1)).toBe(5); // 27 Dec to 1 Jan
    expect(spanBetween(27, 5, 12, 1)).toBe(9); // 27 Dec to 5 Jan
    expect(spanBetween(1, 10, 8, 8)).toBe(9); // same month, no crossing
  });

  it("EXECUTED: the existing no-month and start-month readings are untouched", () => {
    expect(spanBetween(5, 9)).toBe(4);
    expect(spanBetween(27, 1)).toBe(5); // 31-day month
    expect(spanBetween(27, 1, 2)).toBe(2); // February
    expect(spanBetween(27, 1, 4)).toBe(4); // 30-day month
  });

  it("EXECUTED: both dated shapes read the end month", () => {
    expect(range("1/8 to 10/9 total 12000 baht")?.spanDays).toBe(40);
    expect(range("Aug 1 to Sep 10 total 12000 baht")?.spanDays).toBe(40);
    expect(range("27 Dec - 5 Jan total 2700 baht")?.spanDays).toBe(9);
  });

  it("EXECUTED: the package rate is the shop's real 300/day, not 1333", () => {
    const a = offer("Aug 1 to Sep 10 total 12000 baht", 40) as
      | { pricePerDay: number; derivedFromDays?: number }
      | null;
    expect(a?.pricePerDay).toBe(300);
    expect(a?.derivedFromDays).toBe(40);
    const b = offer("1/8 to 10/9 total 12000 baht", 40) as
      | { pricePerDay: number; derivedFromDays?: number }
      | null;
    expect(b?.pricePerDay).toBe(300);
    expect(b?.derivedFromDays).toBe(40);
  });
});
