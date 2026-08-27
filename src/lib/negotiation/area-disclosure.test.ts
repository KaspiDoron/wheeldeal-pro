import { describe, it, expect } from "vitest";
import { coarseArea, disclosureBlock } from "./traveller-disclosure";

// OWNER REPORT 11, S3 - THE EXACT HOTEL COULD REACH THE SHOP VIA THE AREA ANSWER.
//
// The `area` fact answers "where will you ride?" with a general place. The only
// "where" the app holds is the traveller's stored stay LABEL - the precise
// hotel/street they typed - and it is present even without the coordinate
// consent. It was fed straight into the area answer, so a shop asking "which
// city?" was told "riding around Ibis Styles Krabi, 123 Beach Rd" - the exact
// hotel, before any price, while the `address` fact one case below is instructed
// to REFUSE a hotel. `coarseArea` shares a bare town and withholds anything that
// looks like a precise address.

const ASK_AREA = "which city will you ride in?";

describe("coarseArea shares a town, withholds an address", () => {
  it("passes a bare town through", () => {
    expect(coarseArea("Krabi")).toBe("Krabi");
    expect(coarseArea("Ao Nang")).toBe("Ao Nang");
    expect(coarseArea("Chiang Mai")).toBe("Chiang Mai");
  });

  it("withholds anything with a street/unit number", () => {
    expect(coarseArea("Sugar Marina 88")).toBeNull();
    expect(coarseArea("123 Beach Road")).toBeNull();
  });

  it("withholds a comma-separated multi-part label", () => {
    expect(coarseArea("Ibis Styles Krabi, 123 Beach Road")).toBeNull();
    expect(coarseArea("Riverside, Ao Nang")).toBeNull();
  });

  it("withholds a long or many-word label", () => {
    expect(coarseArea("The Beachfront Resort and Spa Ao Nang Krabi")).toBeNull();
    expect(coarseArea("Some Very Long Hotel Name Here")).toBeNull();
  });

  it("handles empty / nullish", () => {
    expect(coarseArea("")).toBeNull();
    expect(coarseArea(null)).toBeNull();
    expect(coarseArea(undefined)).toBeNull();
  });
});

describe("the area answer never states a precise stay label", () => {
  it("names a bare town (the legitimate, friendly area disclosure)", () => {
    const b = disclosureBlock({ rfq: undefined, town: "Krabi" }, ASK_AREA);
    expect(b).toContain("riding around Krabi");
  });

  it("does NOT state a precise hotel/address when the shop asks the area", () => {
    const precise = "Ibis Styles Krabi, 123 Beach Road";
    const b = disclosureBlock({ rfq: undefined, town: precise }, ASK_AREA);
    expect(b, "the exact stay label must never reach the shop via the area answer").not.toContain(
      precise
    );
    expect(b).not.toContain("123 Beach Road");
    // It still answers - just at the correct, general granularity.
    expect(b.toLowerCase()).toContain("riding around");
  });

  it("the address fact still refuses a hotel outright when asked directly", () => {
    // The case that made the area leak a contradiction: this one always refused.
    const b = disclosureBlock({ rfq: undefined, town: "Krabi" }, "where are you staying? which hotel?");
    expect(b).toMatch(/Do NOT give an address or a hotel/);
  });
});
