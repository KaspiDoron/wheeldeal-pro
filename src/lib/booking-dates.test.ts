import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { localDay, addDays, resolveWindow } from "./rental-window";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE APP RUNS WHERE THE TRAVELLER IS, AND DECIDED DATES WHERE GREENWICH IS.
//
// "Same-day pickup" means the day it is where the person is standing. Every
// date decision in this codebase already had a timeZone parameter and already
// did the right thing with one - and neither client that fed it ever sent a
// zone, so every rental window on the eastern half of the planet was decided
// against a calendar day that had not started yet.

// 2026-08-01, 00:30 UTC. In Bangkok (UTC+7) it is already 07:30 on the 1st.
// 2026-07-31, 22:00 UTC. In Bangkok it is already 05:00 on AUGUST 1st.
const LATE_JULY_UTC = Date.parse("2026-07-31T22:00:00Z");

describe("REPRODUCTION: a Thai morning is the previous day in UTC", () => {
  it("22:00 UTC on the 31st is already the 1st in Bangkok", () => {
    expect(localDay(LATE_JULY_UTC, "UTC")).toBe("2026-07-31");
    expect(localDay(LATE_JULY_UTC, "Asia/Bangkok")).toBe("2026-08-01");
  });

  it("...so a free plan's ONLY legal day was one the server would refuse", () => {
    // The sheet offered (and defaulted to) the UTC day. The server, given the
    // real zone, allows the traveller's day. Those are different dates for
    // seven hours out of every twenty-four.
    const utcDecision = resolveWindow({
      plan: "free",
      requested: localDay(LATE_JULY_UTC, "UTC"),
      nowMs: LATE_JULY_UTC,
      timeZone: "Asia/Bangkok",
    });
    expect(utcDecision.adjusted).toBe(true);
    expect(utcDecision.startDate).toBe("2026-08-01");

    const localDecision = resolveWindow({
      plan: "free",
      requested: localDay(LATE_JULY_UTC, "Asia/Bangkok"),
      nowMs: LATE_JULY_UTC,
      timeZone: "Asia/Bangkok",
    });
    expect(localDecision.adjusted).toBe(false);
  });

  it("the western half of the planet has the mirror problem", () => {
    // Los Angeles at 16:00 on the 31st is already the 1st in UTC.
    const t = Date.parse("2026-08-01T02:00:00Z");
    expect(localDay(t, "UTC")).toBe("2026-08-01");
    expect(localDay(t, "America/Los_Angeles")).toBe("2026-07-31");
  });
});

describe("adding days to a DATE LABEL is not adding days to a moment", () => {
  it("it is stable regardless of where it runs", () => {
    expect(addDays("2026-08-01", 3)).toBe("2026-08-04");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    // A leap day, because February is where date arithmetic goes to die.
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("REPRODUCTION: a DST boundary does not shift the return date", () => {
    // The old code parsed "YYYY-MM-DDT00:00:00" as LOCAL and rendered it back
    // through toISOString(). Across a spring-forward that is off by one.
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
  });

  it("garbage in is echoed, never turned into a plausible wrong date", () => {
    expect(addDays("not-a-date", 3)).toBe("not-a-date");
  });
});

describe("the clients finally say where they are", () => {
  const sheet = readCode("src/components/BookingSheet.tsx");
  const page = readCode("src/app/page.tsx");

  it("the booking sheet computes the traveller's day, not the UTC one", () => {
    expect(sheet).toMatch(/const timeZone = deviceTimeZone\(\);/);
    expect(sheet).toMatch(/const nowMs = Date\.now\(\);/);
    expect(sheet).toMatch(/const today = localDay\(nowMs, timeZone\);/);
    // The hand-rolled `tomorrow` is gone: the default pickup is now seeded
    // from the RFQ's own start date through the shared window authority
    // (audit F107), which does the same local-day arithmetic in the
    // traveller's zone and clamps to what the plan may actually book.
    expect(sheet).toMatch(
      /pickupDefault\(\{ rfqStartDate: rfq\?\.startDate, plan, nowMs, timeZone \}\)/
    );
    expect(sheet).not.toMatch(/localDay\(Date\.now\(\) \+ 86400000/);
    // The two toISOString() day renders are gone.
    expect(sheet).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
    expect(sheet).not.toMatch(/returnDate\.toISOString\(\)/);
  });

  it("...and sends the zone with the booking, so the server decides in it", () => {
    expect(sheet).toMatch(/\n          timeZone,/);
  });

  it("the search does too - the window is clamped at request time", () => {
    expect(page).toMatch(/timeZone: deviceTimeZone\(\),/);
  });
});

describe("REPRODUCTION: a refused booking said 'confirmed'", () => {
  const sheet = readCode("src/components/BookingSheet.tsx");

  it("any non-OK booking response stops the flow", () => {
    // Only 409 was handled. The server's plan-window check answers 400 - and
    // that fell straight through to setStep("confirmed"), so the traveller was
    // told they had a rental that did not exist AND the shop was then sent a
    // closing message about it.
    expect(sheet).toMatch(/if \(!bRes\.ok\) \{/);
    const guard = sheet.slice(sheet.indexOf("if (!bRes.ok)"), sheet.indexOf('setStep("confirmed")'));
    expect(guard).toMatch(/setLockError\(/);
    expect(guard).toMatch(/setSubmitting\(false\);/);
    expect(guard).toMatch(/return;/);
  });

  it("but a NETWORK failure still confirms - the booking may well be stored", () => {
    // Stranding the traveller on a spinner over a dropped connection would be
    // worse than a retryable confirmation, so the catch stays EMPTY: it falls
    // through to confirmed. A refusal and an unreachable server are different
    // facts and get different endings.
    const start = sheet.indexOf("if (!bRes.ok)");
    const catchBlock = sheet.slice(sheet.indexOf("} catch {", start), sheet.indexOf('setStep("confirmed")'));
    expect(catchBlock).not.toMatch(/setLockError|return;/);
  });
});
