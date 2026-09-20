import { describe, expect, it } from "vitest";
import { parseRevenueCsv, reconcile, type ClickCount } from "./revenue";

const SUB_TH = "p1-mth-cscooter-9a3f01bc";
const SUB_VN = "p1-mvn-cmotorbike-0011aabb";

describe("revenue report import", () => {
  it("reads a partner CSV whatever the column order or header spelling", () => {
    const csv = ["Date,Sub ID,Clicks,Estimated Revenue (USD)", `2026-09-19,${SUB_TH},12,4.80`, `2026-09-19,${SUB_VN},3,0.90`].join("\n");
    const out = parseRevenueCsv(csv);
    expect(out.errors).toEqual([]);
    expect(out.rows).toEqual([
      { day: "2026-09-19", subId: SUB_TH, clicks: 12, revenue: 4.8 },
      { day: "2026-09-19", subId: SUB_VN, clicks: 3, revenue: 0.9 },
    ]);
  });

  it("handles quoted fields, currency symbols and thousands separators", () => {
    const csv = ['subid,day,revenue,clicks', `"${SUB_TH}","2026-09-19","$1,204.50","1,900"`].join("\n");
    expect(parseRevenueCsv(csv).rows[0]).toEqual({ day: "2026-09-19", subId: SUB_TH, clicks: 1900, revenue: 1204.5 });
  });

  // Money. A row that cannot be read is named and dropped - it is never
  // coerced to zero and never silently summed as NaN.
  it("reports unreadable rows by line number and keeps the rest", () => {
    const csv = ["date,subid,clicks,revenue", `2026-09-19,${SUB_TH},5,2.00`, `not-a-date,${SUB_TH},5,2.00`, `2026-09-19,${SUB_TH},five,2.00`, `2026-09-19,${SUB_TH},5,-3`].join("\n");
    const out = parseRevenueCsv(csv);
    expect(out.rows).toHaveLength(1);
    expect(out.errors).toHaveLength(3);
    expect(out.errors[0]).toMatch(/line 3/);
  });

  it("says which column is missing instead of importing nothing quietly", () => {
    const out = parseRevenueCsv("date,clicks,revenue\n2026-09-19,5,2.00");
    expect(out.rows).toEqual([]);
    expect(out.errors.join(" ")).toMatch(/sub/i);
  });

  it("refuses a file large enough to be a mistake", () => {
    const big = "date,subid,clicks,revenue\n" + `2026-09-19,${SUB_TH},1,0.1\n`.repeat(50_001);
    expect(parseRevenueCsv(big).errors.join(" ")).toMatch(/too many/i);
  });
});

describe("reconciliation: their clicks against ours", () => {
  const ours: ClickCount[] = [
    { day: "2026-09-19", placement: "guide-inline", market: "th", clicks: 15 },
    { day: "2026-09-19", placement: "guide-inline", market: "vn", clicks: 3 },
  ];

  it("rolls revenue up per placement and market, with revenue per thousand of OUR clicks", () => {
    const report = reconcile(
      [
        { day: "2026-09-19", subId: SUB_TH, clicks: 12, revenue: 4.8 },
        { day: "2026-09-19", subId: SUB_VN, clicks: 3, revenue: 0.9 },
      ],
      ours,
      0.8
    );
    const th = report.lines.find((l) => l.market === "th");
    expect(th).toMatchObject({ placement: "guide-inline", ourClicks: 15, partnerClicks: 12, gross: 4.8 });
    expect(th?.net).toBeCloseTo(3.84);
    expect(th?.netPerThousandClicks).toBeCloseTo(256);
    expect(report.totals.gross).toBeCloseTo(5.7);
  });

  // The number an arbitrage operator actually watches. A partner counting far
  // fewer clicks than we sent is discarding them as invalid (or not counting
  // them at all); either way it is found here, in week one, not at payout.
  it("flags a partner that counts far fewer clicks than were sent", () => {
    const report = reconcile([{ day: "2026-09-19", subId: SUB_TH, clicks: 6, revenue: 2.4 }], ours, 1);
    const th = report.lines.find((l) => l.market === "th");
    expect(th?.clickGap).toBeCloseTo(0.6);
    expect(th?.flag).toBe("under-counted");
  });

  it("flags clicks the partner reports that we never logged", () => {
    const report = reconcile([{ day: "2026-09-19", subId: SUB_TH, clicks: 40, revenue: 9 }], ours, 1);
    expect(report.lines.find((l) => l.market === "th")?.flag).toBe("over-counted");
  });

  // For Google's in-page unit "their clicks / ours" is an ad click-through
  // rate, not a counting dispute - flagging it would cry wolf on every row.
  it("raises no gap flags when asked not to (an AFS partner)", () => {
    const report = reconcile([{ day: "2026-09-19", subId: SUB_TH, clicks: 3, revenue: 2.4 }], ours, 1, { flagGaps: false });
    const th = report.lines.find((l) => l.market === "th");
    expect(th?.clickGap).toBeCloseTo(0.8);
    expect(th?.flag).toBeNull();
  });

  it("does not flag a small sample - 2 clicks against 3 is noise, not a finding", () => {
    const report = reconcile([{ day: "2026-09-19", subId: SUB_VN, clicks: 2, revenue: 0.5 }], ours, 1);
    expect(report.lines.find((l) => l.market === "vn")?.flag).toBeNull();
  });

  it("keeps revenue whose sub-id it cannot read as UNATTRIBUTED, never guessed into a placement", () => {
    const report = reconcile([{ day: "2026-09-19", subId: "someone-elses-format", clicks: 9, revenue: 3 }], ours, 1);
    expect(report.unattributed).toMatchObject({ clicks: 9, gross: 3 });
    expect(report.totals.gross).toBeCloseTo(3);
    expect(report.lines.every((l) => l.gross === 0)).toBe(true);
  });

  it("shows our clicks that earned nothing, so a dead placement is visible", () => {
    const report = reconcile([], ours, 1);
    expect(report.lines).toHaveLength(2);
    expect(report.lines[0]).toMatchObject({ partnerClicks: 0, gross: 0, netPerThousandClicks: 0 });
  });
});
