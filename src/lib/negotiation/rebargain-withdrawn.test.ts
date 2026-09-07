// AUDIT F138 - the sibling re-bargain fan-out re-entered shops that had already
// said no.
//
// `planSiblingRebargain` excluded a withdrawn shop only by `phase` in
// {dead, closed, closing}, and no live path writes those phases on a decline:
// `derivePhase` cannot return them, so a shop that answered "sorry, we are not
// renting scooters anymore" stays at `collecting_terms` with its price still
// on the board. When another shop dropped its quote, `materialDrop` fired and
// the swarm scheduled a rival-leverage re-entry into the declined shop's own
// thread - "another shop offered 200/day, could you do 190?" sent over the
// traveller's personal WhatsApp number to a shop that had explicitly refused
// to rent.
//
// The sibling predicate proves the rule already exists one module over:
// session-rivals.ts drops any row whose `declined` or `outOfStock` is true,
// with a comment saying the two paths "must not disagree about which shops are
// still in the hunt". The swarm path disagreed.
//
// EXECUTED: every case below runs the real planner over real SessionShopRow
// shapes (the projection graph/engine.ts sessionTable builds).

import { describe, it, expect } from "vitest";
import { planSiblingRebargain, MAX_FANOUT } from "./rebargain";
import type { SessionShopRow } from "../graph/types";

/** A dearer sibling the planner would re-enter if nothing barred it. */
function sibling(over: Partial<SessionShopRow> = {}): SessionShopRow {
  return {
    vendorId: "dear-shop",
    vendorName: "Dear Shop",
    pricePerDay: 300,
    currency: "THB",
    // The phase a declining shop is ACTUALLY left in: it quoted, it named a
    // term, so derivePhase says collecting_terms and never dead/closed.
    phase: "collecting_terms",
    toNumber: "66810000001",
    firmCount: 0,
    ...over,
  };
}

const plan = (rows: SessionShopRow[]) =>
  planSiblingRebargain({
    rows,
    excludeVendorId: "cheap-shop",
    newLowPerDay: 200,
    currency: "THB",
  });

describe("EXECUTED (F138): a shop that said no is not re-entered by the swarm", () => {
  it("the control: a live dearer shop IS planned for a re-bargain", () => {
    const targets = plan([sibling()]);
    expect(targets.map((t) => t.vendorId)).toEqual(["dear-shop"]);
  });

  it("a shop that DECLINED is not scheduled, even at collecting_terms", () => {
    // THE ASSERTION THAT FAILED BEFORE THE FIX: `declined` was never read, so
    // the planner returned this shop and a tick wakeup was inserted for it.
    const targets = plan([sibling({ declined: true })]);
    expect(targets).toEqual([]);
  });

  it("a shop that is OUT OF STOCK is not scheduled either", () => {
    const targets = plan([sibling({ outOfStock: true })]);
    expect(targets).toEqual([]);
  });

  it("the withdrawn shop is dropped without costing a live sibling its slot", () => {
    // Dearest-first ordering plus the MAX_FANOUT cap means a withdrawn shop
    // that survives the filter also STEALS a slot from a shop worth pushing.
    const rows = [
      sibling({ vendorId: "declined-dearest", pricePerDay: 900, declined: true }),
      sibling({ vendorId: "gone-dearest", pricePerDay: 800, outOfStock: true }),
      ...Array.from({ length: MAX_FANOUT }, (_, i) =>
        sibling({ vendorId: `live-${i}`, pricePerDay: 400 - i, toNumber: `6681000100${i}` })
      ),
    ];
    const ids = plan(rows).map((t) => t.vendorId);
    expect(ids).not.toContain("declined-dearest");
    expect(ids).not.toContain("gone-dearest");
    expect(ids).toHaveLength(MAX_FANOUT);
  });

  it("the firm ladder and the dead-phase bar are untouched by the new filter", () => {
    expect(plan([sibling({ firmCount: 2 })])).toEqual([]);
    expect(plan([sibling({ phase: "dead" })])).toEqual([]);
    // ...and a shop only 2% dearer is still not worth a turn.
    expect(plan([sibling({ pricePerDay: 204 })])).toEqual([]);
  });
});
