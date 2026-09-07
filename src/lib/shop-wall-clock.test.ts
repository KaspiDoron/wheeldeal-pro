// AUDIT F108 - a pickup time stored as the SHOP's wall clock must be rendered
// as that wall clock on every surface.
//
// bookings.scheduled_at is a naive shop-local string ("2026-09-20T10:00:00",
// scheduled_tz: "shop-local") written into a timestamptz column, so PostgREST
// hands it back with a "+00:00" tail it never earned. The profile card then ran
// it through `new Date(...).toLocaleString()`, which re-interprets that tail in
// the DEVICE zone: a Bangkok traveller's 10:00 pickup read 17:00, while the
// Trips card printed the same row raw, offset tail and all. Two screens, one
// booking, seven hours apart.
//
// formatShopWallClock reads the digits and never constructs a Date, which is
// the same reason formatRentalDate exists for the date half.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatShopWallClock } from "./clock";

describe("F108 - the stored wall clock survives the render", () => {
  it("keeps 10:00 as 10:00 even with the timestamptz tail Postgres adds", () => {
    const out = formatShopWallClock("2026-09-20T10:00:00+00:00");
    expect(out).toContain("10:00");
    expect(out).toContain("20");
    // The tail is not the shop's business and never reaches the traveller.
    expect(out).not.toContain("+00:00");
    expect(out).not.toContain("T");
  });

  it("does NOT shift by the device's offset - the old render did", () => {
    const stored = "2026-09-20T10:00:00+00:00";
    // What the profile card used to show a traveller standing in Bangkok.
    const deviceZoned = new Date(stored).toLocaleTimeString("en-GB", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(deviceZoned).toBe("17:00");
    expect(formatShopWallClock(stored)).not.toContain("17:00");
  });

  it("reads the naive form the booking sheet posts", () => {
    expect(formatShopWallClock("2026-09-20T10:00:00")).toContain("10:00");
  });

  it("tolerates the space-separated shape PostgREST can return", () => {
    expect(formatShopWallClock("2026-09-20 08:05:00+07:00")).toContain("08:05");
  });

  it("renders nothing rather than 'Invalid Date' for junk or null", () => {
    expect(formatShopWallClock(null)).toBe("");
    expect(formatShopWallClock(undefined)).toBe("");
    expect(formatShopWallClock("")).toBe("");
    expect(formatShopWallClock("soon")).toBe("");
    expect(formatShopWallClock("2026-09-20")).toBe("");
  });
});

describe("F108 - both surfaces render it the same way", () => {
  const profile = readFileSync(join(process.cwd(), "src/app/profile/page.tsx"), "utf8");
  const trips = readFileSync(join(process.cwd(), "src/app/deals/page.tsx"), "utf8");

  it("the profile card no longer localises a shop-local wall clock", () => {
    expect(profile).not.toMatch(/new Date\(b\.scheduled_at\)\.toLocaleString\(\)/);
    expect(profile).toMatch(/formatShopWallClock\(b\.scheduled_at\)/);
  });

  it("the Trips card no longer prints the raw offset tail", () => {
    expect(trips).not.toMatch(/scheduled_at\.replace\("T"/);
    expect(trips).toMatch(/formatShopWallClock\(b\.scheduled_at\)/);
  });
});
