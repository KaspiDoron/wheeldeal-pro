import { describe, it, expect } from "vitest";
import type { SessionShopRow } from "../graph/types";
import {
  buildSessionBrief,
  standingFor,
  BRIEF_MAX_LINES,
  BRIEF_MAX_CHARS,
} from "./session-brief";
import { validRivals } from "./session-rivals";

// WHAT THE AGENT KNEW ABOUT THE HUNT BEFORE THIS: four prices.
//
// `validRivals` is a LEVERAGE filter - live, priced, comparable currency,
// capped at four - and it was the turn's ONLY cross-thread knowledge. So the
// agent answering shop B could not know that shop C had said no, that shop D
// was still silent, or that B was the last shop left, and every one of those
// inverts how hard a person would push.

const row = (r: Partial<SessionShopRow> & { vendorId: string }): SessionShopRow => ({
  vendorName: r.vendorId,
  ...r,
});

describe("EXECUTED: the facts validRivals drops on the floor", () => {
  const rows: SessionShopRow[] = [
    row({ vendorId: "me", isThisShop: true, pricePerDay: 300, currency: "THB" }),
    row({ vendorId: "a", pricePerDay: 200, currency: "THB", rounds: 2 }),
    row({ vendorId: "b", pricePerDay: 260, currency: "THB" }),
    row({ vendorId: "c", declined: true, pricePerDay: 240, currency: "THB" }),
    row({ vendorId: "d", outOfStock: true }),
    row({ vendorId: "e" }), // contacted, silent
  ];

  it("the rival card sees only the two live prices", () => {
    const rivals = validRivals(rows, { excludeVendorId: "me", currency: "THB" });
    expect(rivals.map((r) => r.pricePerDay)).toEqual([200, 260]);
  });

  it("the brief carries the three shops the rival card could not", () => {
    const brief = buildSessionBrief({ rows, excludeVendorId: "me" });
    expect(brief).toContain("said no");
    expect(brief).toContain("none available");
    expect(brief).toContain("no reply yet");
  });

  it("it counts the hunt so the model does not have to", () => {
    const brief = buildSessionBrief({ rows, excludeVendorId: "me" });
    // 5 others: 2 priced-and-live, 1 live without a price, 2 out.
    expect(brief).toContain("OTHER SHOPS IN THIS SEARCH (5");
    expect(brief).toContain("2 have quoted");
    expect(brief).toContain("1 still live without a price");
    expect(brief).toContain("2 out");
  });

  it("NO SHOP NAMES, ever - the same disclosure rule as the rival card", () => {
    const named = rows.map((r) => ({ ...r, vendorName: `Krabi ${r.vendorId} Rentals` }));
    const brief = buildSessionBrief({ rows: named, excludeVendorId: "me" });
    for (const r of named) expect(brief).not.toContain(r.vendorName);
    expect(brief).not.toContain("Krabi");
  });

  it("the shop we are answering is never described to itself", () => {
    const brief = buildSessionBrief({ rows, excludeVendorId: "me" });
    // This shop's own 300 must not appear as one of the "other shops".
    expect(brief).not.toContain("300");
  });
});

describe("EXECUTED: the strategic inversion - when this is the last shop left", () => {
  const allOut: SessionShopRow[] = [
    row({ vendorId: "me", isThisShop: true }),
    row({ vendorId: "a", declined: true }),
    row({ vendorId: "b", outOfStock: true }),
    row({ vendorId: "c", phase: "dead" }),
  ];
  it("says so in words, because the tactic reverses", () => {
    const brief = buildSessionBrief({ rows: allOut, excludeVendorId: "me" });
    expect(brief).toContain("only shop left");
    expect(brief).toContain("secure it warmly");
  });
  it("...and does NOT say so while anyone else is still live", () => {
    const brief = buildSessionBrief({
      rows: [...allOut, row({ vendorId: "d", pricePerDay: 210, currency: "THB" })],
      excludeVendorId: "me",
    });
    expect(brief).not.toContain("only shop left");
  });
});

describe("EXECUTED: standingFor - terminal beats priced", () => {
  it("a shop that walked away is not a shop with a price", () => {
    expect(standingFor(row({ vendorId: "x", declined: true, pricePerDay: 200 })).kind).toBe("declined");
    expect(standingFor(row({ vendorId: "x", phase: "closed", pricePerDay: 200 })).kind).toBe("declined");
    expect(standingFor(row({ vendorId: "x", outOfStock: true, pricePerDay: 200 })).kind).toBe("out_of_stock");
  });
  it("...but the price it HAD quoted is still stated, as history", () => {
    const brief = buildSessionBrief({
      rows: [row({ vendorId: "c", declined: true, pricePerDay: 240, currency: "THB" })],
    });
    expect(brief).toContain("said no (had quoted 240 THB/day)");
  });
  it("a priced shop mid-negotiation reads differently from a fresh quote", () => {
    expect(standingFor(row({ vendorId: "x", pricePerDay: 200, rounds: 2 })).kind).toBe("negotiating");
    expect(standingFor(row({ vendorId: "x", pricePerDay: 200 })).kind).toBe("quoted");
  });
  it("silence and conversation are genuinely different states", () => {
    expect(standingFor(row({ vendorId: "x" })).kind).toBe("no_reply");
    expect(standingFor(row({ vendorId: "x", phase: "opening" })).kind).toBe("no_reply");
    expect(standingFor(row({ vendorId: "x", phase: "awaiting_price" })).kind).toBe("talking");
    expect(standingFor(row({ vendorId: "x", rounds: 1 })).kind).toBe("talking");
  });
  it("a presented deal outranks everything short of a terminal state", () => {
    expect(standingFor(row({ vendorId: "x", presented: true, pricePerDay: 200 })).kind).toBe("presented");
  });
});

describe("EXECUTED: package provenance survives into the brief", () => {
  it("a divided package rate says so, exactly as every other surface must", () => {
    const brief = buildSessionBrief({
      rows: [row({ vendorId: "a", pricePerDay: 167, currency: "THB", quoteBasisDays: 3 })],
    });
    expect(brief).toContain("3-day package");
    expect(brief).toContain("not a price they typed");
  });
});

describe("EXECUTED: the firm ladder is visible to the composer", () => {
  it("a shop that has refused twice is marked as such", () => {
    const brief = buildSessionBrief({
      rows: [row({ vendorId: "a", pricePerDay: 200, currency: "THB", firmCount: 2 })],
    });
    expect(brief).toContain("last price twice");
  });
});

describe("EXECUTED: bounded, and honest about what it left out", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    row({ vendorId: `v${i}`, pricePerDay: 200 + i, currency: "THB" })
  );

  it("lists at most BRIEF_MAX_LINES shops", () => {
    const brief = buildSessionBrief({ rows: many });
    const bullets = brief.split("\n").filter((l) => l.startsWith("- ") && !l.startsWith("- and "));
    expect(bullets.length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
  });

  it("states the overflow as a count - dropping it silently would be a lie", () => {
    const brief = buildSessionBrief({ rows: many });
    expect(brief).toMatch(/- and \d+ more/);
    // The headline still counts every shop, listed or not.
    expect(brief).toContain("(30;");
  });

  it("never exceeds the character ceiling", () => {
    const brief = buildSessionBrief({ rows: many });
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS + 40); // + the overflow tail
  });

  it("the cheapest live quotes are the ones that survive truncation", () => {
    const brief = buildSessionBrief({ rows: many });
    expect(brief).toContain("200 THB/day");
    expect(brief).not.toContain("229 THB/day");
  });

  it("a hunt with one shop produces NOTHING - a heading over no rows is noise", () => {
    expect(buildSessionBrief({ rows: [row({ vendorId: "me", isThisShop: true })] })).toBe("");
    expect(buildSessionBrief({ rows: [] })).toBe("");
  });
});
