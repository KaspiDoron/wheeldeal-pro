// AUDIT F107 - the booking sheet must open on the start date the traveller
// picked and every shop was told about.
//
// BookingSheet read rfq.durationDays but never rfq.startDate, so the pickup it
// pre-filled, displayed and POSTed was derived purely from the clock: today for
// a free plan, TOMORROW for a paid one. A Pro traveller whose RFQ said "5 days
// from 20 Sep" - the exact words agents.ts put in the opener to every shop -
// silently booked tomorrow, bookings.start_date/return_date landed weeks before
// the window the shop agreed to, and the completion sweep then asked whether a
// rental that had not started yet was returned.
//
// pickupDefault is that seed, and it goes through the same resolveWindow
// authority the server enforces, so the sheet can never offer a date the server
// will refuse.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickupDefault, resolveWindow } from "./rental-window";

// 2026-09-02T05:00:00Z - the same instant in every case below.
const NOW = Date.parse("2026-09-02T05:00:00Z");
const UTC = "UTC";

describe("F107 - the sheet is seeded from the RFQ, not the clock", () => {
  it("a future RFQ start inside the plan window wins", () => {
    expect(
      pickupDefault({ rfqStartDate: "2026-09-20", plan: "pro", nowMs: NOW, timeZone: UTC })
    ).toBe("2026-09-20");
  });

  it("a stale RFQ start falls back to today, never to a date the server refuses", () => {
    expect(
      pickupDefault({ rfqStartDate: "2026-08-01", plan: "pro", nowMs: NOW, timeZone: UTC })
    ).toBe("2026-09-02");
  });

  it("no RFQ start keeps the old defaults: today free, tomorrow paid", () => {
    expect(pickupDefault({ plan: "free", nowMs: NOW, timeZone: UTC })).toBe("2026-09-02");
    expect(pickupDefault({ plan: "pro", nowMs: NOW, timeZone: UTC })).toBe("2026-09-03");
  });

  it("a free plan is same-day whatever the RFQ said", () => {
    expect(
      pickupDefault({ rfqStartDate: "2026-09-20", plan: "free", nowMs: NOW, timeZone: UTC })
    ).toBe("2026-09-02");
  });

  it("an RFQ start past the plan ceiling clamps to the furthest bookable day", () => {
    expect(
      pickupDefault({ rfqStartDate: "2026-12-01", plan: "pro", nowMs: NOW, timeZone: UTC })
    ).toBe(resolveWindow({ plan: "pro", nowMs: NOW, timeZone: UTC }).maxStartDate);
    // Ultra books 180 days ahead, so the same date is honoured there.
    expect(
      pickupDefault({ rfqStartDate: "2026-12-01", plan: "ultra", nowMs: NOW, timeZone: UTC })
    ).toBe("2026-12-01");
  });

  it("junk in the RFQ is ignored rather than rendered", () => {
    expect(
      pickupDefault({ rfqStartDate: "next tuesday", plan: "pro", nowMs: NOW, timeZone: UTC })
    ).toBe("2026-09-03");
    expect(pickupDefault({ rfqStartDate: null, plan: "pro", nowMs: NOW, timeZone: UTC })).toBe(
      "2026-09-03"
    );
  });

  it("is the TRAVELLER's day, not UTC's", () => {
    const evening = Date.parse("2026-09-02T19:00:00Z"); // 02:00 next day in Bangkok
    expect(pickupDefault({ plan: "free", nowMs: evening, timeZone: "Asia/Bangkok" })).toBe(
      "2026-09-03"
    );
  });
});

describe("F107 - the booking sheet uses it", () => {
  const sheet = readFileSync(join(process.cwd(), "src/components/BookingSheet.tsx"), "utf8");

  it("consults the RFQ's start date", () => {
    expect(sheet).toMatch(/rfq\?\.startDate/);
    expect(sheet).toMatch(/pickupDefault\(/);
  });

  it("no longer defaults off the clock alone", () => {
    expect(sheet).not.toMatch(/const defaultDate = freePlan \? today : tomorrow;/);
  });

  it("the picker's max comes from the same window authority the server uses", () => {
    expect(sheet).toMatch(/maxStartDate/);
    expect(sheet).not.toMatch(/const maxDate = freePlan \? today : undefined;/);
  });
});
