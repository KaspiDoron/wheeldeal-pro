// AUDIT F102 - a weekly or monthly rate written in the shop's own language was
// computed and then thrown away.
//
// The per-line loop discarded every scanRates result whose unit was not "day",
// and the only week/month readers matched the literal English words. So a Thai,
// Vietnamese, Indonesian, Filipino or Spanish monthly quote extracted NO price
// at all - on exactly the long-stay searches where shops answer in months.
//
// Executed against the real extractor - no source grepping.
import { describe, it, expect } from "vitest";
import { extractQuotedPrices } from "./price-extract";

const perDay = (text: string, durationDays: number, localCurrency = "THB") =>
  extractQuotedPrices(text, { durationDays, localCurrency } as never);

describe("F102: a native-language monthly or weekly rate is kept", () => {
  it("EXECUTED: Thai monthly", () => {
    const r = perDay("4000 บาท/เดือน", 30);
    expect(r.offer?.pricePerDay).toBe(133);
    expect(r.offer?.derivedFromDays).toBe(30);
    expect(perDay("4000 บาท ต่อ เดือน", 30).offer?.pricePerDay).toBe(133);
  });

  it("EXECUTED: Indonesian monthly, magnitude suffix included", () => {
    expect(perDay("3 juta/bulan", 30, "IDR").offer?.pricePerDay).toBe(100_000);
    expect(perDay("3jt/bulan", 30, "IDR").offer?.pricePerDay).toBe(100_000);
  });

  it("EXECUTED: Thai and Vietnamese weekly", () => {
    const r = perDay("1500 บาท/สัปดาห์", 7);
    expect(r.offer?.pricePerDay).toBe(214);
    expect(r.offer?.derivedFromDays).toBe(7);
    expect(perDay("1500 บาท ต่อ อาทิตย์", 7).offer?.pricePerDay).toBe(214);
    expect(perDay("700k/tuần", 7, "VND").offer?.pricePerDay).toBe(100_000);
  });

  it("EXECUTED: the divisor is the traveller's own stay when it is month-scale", () => {
    // The English reader divides a month by the real stay at 28..31 days, and
    // the native path must not drift to a flat 30 beside it.
    expect(perDay("4200 บาท/เดือน", 28).offer?.pricePerDay).toBe(150);
    expect(perDay("4200 baht per month", 28).offer?.pricePerDay).toBe(150);
    // Outside that band a month is the trade's 30 days.
    expect(perDay("4200 บาท/เดือน", 3).offer?.pricePerDay).toBe(140);
  });

  it("EXECUTED: no double counting - the English form still reads once", () => {
    const r = perDay("4000 baht per month", 30);
    expect(r.allOffers.map((o) => o.pricePerDay)).toEqual([133]);
  });

  it("EXECUTED: an availability line is still not a weekly price", () => {
    expect(perDay("we open 7 days a week 8am to 8pm", 7).offer).toBeNull();
    expect(perDay("buka setiap hari", 7, "IDR").offer).toBeNull();
  });

  it("EXECUTED: a daily rate on the same line still wins its own branch", () => {
    // The day reader runs first and short-circuits the line, exactly as before.
    expect(perDay("250 บาท/วัน", 3).offer?.pricePerDay).toBe(250);
  });
});
