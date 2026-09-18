import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  isNewSessionLow,
  canCiteRivalOnSilentThread,
  pricedShopCount,
  MIN_PRICED_SHOPS_FOR_RIVAL,
  NEW_LOW_MARGIN,
} from "./rival-gate";

const read = (p: string) => readFileSync(p, "utf8");

describe("a new cheapest quote is recognised as one", () => {
  it("THE REGRESSION: the first shop to quote cheaply is a new low", () => {
    // Shop B quoted 250 earlier; shop A now quotes 220. This is exactly the
    // owner's example, and exactly the case the old gate could not see,
    // because the figure it compared against already contained the 220.
    expect(isNewSessionLow({ quotePerDay: 220, cheapestOtherPerDay: 250 })).toBe(true);
  });

  it("does not fire when the arriving quote is dearer than the board", () => {
    expect(isNewSessionLow({ quotePerDay: 250, cheapestOtherPerDay: 220 })).toBe(false);
  });

  it("does not fire on a trivial improvement", () => {
    // 2% is not news - it would spend a message at every dearer shop.
    expect(isNewSessionLow({ quotePerDay: 245, cheapestOtherPerDay: 250 })).toBe(false);
    expect(NEW_LOW_MARGIN).toBe(0.05);
  });

  it("the very first price in a hunt counts (the planner then finds no target)", () => {
    expect(isNewSessionLow({ quotePerDay: 220, cheapestOtherPerDay: null })).toBe(true);
  });

  it("junk is never a new low", () => {
    expect(isNewSessionLow({ quotePerDay: 0, cheapestOtherPerDay: 250 })).toBe(false);
    expect(isNewSessionLow({ quotePerDay: undefined, cheapestOtherPerDay: 250 })).toBe(false);
  });
});

describe("two shops must have priced before a rival is named", () => {
  it("a silent thread may not cite the only price in the hunt", () => {
    expect(canCiteRivalOnSilentThread(1)).toBe(false);
  });

  it("two priced rivals are enough", () => {
    expect(canCiteRivalOnSilentThread(2)).toBe(true);
    expect(MIN_PRICED_SHOPS_FOR_RIVAL).toBe(2);
  });

  it("counts distinct shops, in the comparable currency only", () => {
    const rows = [
      { vendorId: "a", pricePerDay: 220, currency: "IDR" },
      { vendorId: "a", pricePerDay: 210, currency: "IDR" }, // same shop, re-quote
      { vendorId: "b", pricePerDay: 250, currency: "IDR" },
      { vendorId: "c", pricePerDay: 12, currency: "USD" }, // another currency
      { vendorId: "d", pricePerDay: 0, currency: "IDR" }, // no real price
    ];
    expect(pricedShopCount(rows, "IDR")).toBe(2);
  });
});

describe("the rules are actually wired in", () => {
  it("the swarm is no longer gated on the session low that includes this shop", () => {
    const live = read("src/lib/spte/live.ts");
    expect(live).toMatch(/isNewSessionLow/);
    // The old gate: `if (outcome.materialDrop && input.ctx.sender)`. If it comes
    // back, a new cheapest shop silently stops telling the dearer ones again.
    expect(live).not.toMatch(/if \(outcome\.materialDrop && input\.ctx\.sender\)/);
  });

  it("the silent-thread nudge asks the shared predicate", () => {
    const pass = read("src/lib/spte/pass.ts");
    expect(pass).toMatch(/canCiteRivalOnSilentThread/);
  });
});
