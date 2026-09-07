import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { deterministicRFQ } from "./agents";
import { vehicleKeyFor } from "./market";
import { disqualifyingKeys } from "./vehicle/spec";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** The shape the request panel actually posts (RequestBuilder always sets
 *  accessories); the point under test is only what is ABSENT from it. */
const fields = (over: Record<string, unknown>) =>
  ({ durationDays: 3, accessories: [], transmission: "any", fulfillment: "any", ...over }) as never;

// W5.5 - FUNNEL HONESTY: the 110cc trap (owner report 5 #11).
//
// A traveller who never states an engine size - or who explicitly taps
// "Any / cheapest" - had 110cc DECLARED for them by the profiler's "CHEAPEST BY
// DEFAULT" rule. Displacement is a DISQUALIFYING attribute in the
// vehicle-identity gate, and only attributes the traveller actually declared
// may block a quote. So in a 125cc market like Thailand, real quotes for the
// bikes the shops actually rent were stamped "wrong vehicle" and barred from
// BEST PRICE - on a constraint the traveller never asked for and could not see.
//
// The seats default was removed for exactly this reason (the comment is still
// in normalizeRFQ) and left the cc one standing beside it.

describe("REPRODUCTION: 'any / cheapest' must mean no cc constraint", () => {
  it("a scooter request with no size stated declares NO engine size", () => {
    const rfq = deterministicRFQ(fields({ vehicleClass: "scooter" }));
    expect(rfq.engineSizeCc).toBeUndefined();
  });

  it("a motorbike request with no size stated declares NO engine size", () => {
    const rfq = deterministicRFQ(fields({ vehicleClass: "motorbike" }));
    expect(rfq.engineSizeCc).toBeUndefined();
  });

  it("a size the traveller DID state is still honoured exactly", () => {
    const rfq = deterministicRFQ(fields({ vehicleClass: "scooter", engineSizeCc: 155 }));
    expect(rfq.engineSizeCc).toBe(155);
  });

  it("displacement is a disqualifying attribute - which is why inventing it hurt", () => {
    // Declared -> it can bar a quote. Undeclared -> it is simply not a
    // constraint. This is the property the fix depends on.
    expect(disqualifyingKeys({ displacementCc: 110 })).toContain("displacementCc");
    expect(disqualifyingKeys({})).not.toContain("displacementCc");
  });

  it("the undeclared scooter now buckets with the 125s the market rents", () => {
    // vehicleKeyFor falls back to 125 for a scooter with no stated cc, so an
    // undeclared request compares against the real market instead of being
    // pinned to the scooter-110 bucket by a number nobody asked for.
    const rfq = deterministicRFQ(fields({ vehicleClass: "scooter" }));
    expect(vehicleKeyFor(rfq)).toBe("scooter-125");
  });

  it("a car still gets its economy default - that one costs nothing", () => {
    // carType is not disqualifying, so defaulting it constrains nobody.
    const rfq = deterministicRFQ(fields({ vehicleClass: "car" }));
    expect(rfq.carType).toBe("economy");
    expect(rfq.engineSizeCc).toBeUndefined();
    expect(rfq.seats).toBeUndefined();
  });

  it("the LLM profiler is told the same rule, so both paths agree", () => {
    const prompts = read("src/lib/prompts.ts");
    expect(prompts).toMatch(/NEVER INVENT AN ENGINE SIZE/);
    expect(prompts).not.toMatch(/default to engineSizeCc 110/);
  });
});

describe("REPRODUCTION: 'Push harder' posts the leverage it is named for", () => {
  // The action posted `{ vendor, rfq }` and nothing else, which silently
  // disabled every server-side lever: no region -> currency resolves to USD (a
  // Thai shop asked for DOLLARS) and the market floor is dropped for a currency
  // mismatch; no currentPricePerDay -> the whole rival lookup is skipped, since
  // it is gated on `quoted`, and no target can be computed at all; no round ->
  // every push composes as the first one.
  const page = read("src/app/page.tsx");

  it("the draft request carries the region", () => {
    expect(page).toMatch(/region: origin\?\.label \|\| undefined,\s*\n\s*currentPricePerDay/);
  });

  it("...the shop's current price, which is what unlocks the rival lookup", () => {
    expect(page).toMatch(/currentPricePerDay: vendor\.offer\?\.pricePerDay/);
  });

  it("...and the round, so a third push is not composed as a first", () => {
    expect(page).toMatch(/round: vendor\.offer\?\.round \?\? 0/);
  });

  it("the route resolves the currency through the SHARED server chain", () => {
    // REWRITTEN for audit F094. This used to pin `currencyForRegion(region) ||
    // "USD"` and call the dollar default "honest" - it is not: the labels the
    // geocoder actually produces ("My current location", a raw pin) carry no
    // country token, so a +66 shop was asked for dollars and every THB-stamped
    // rival was filtered out by `currency=eq.USD`. The shared chain consults
    // the SHOP'S PHONE PREFIX and leaves the currency undefined rather than
    // inventing one.
    const route = read("src/app/api/bargain-draft/route.ts");
    expect(route).toMatch(/const cur = await resolveLocalCurrency\(\{/);
    expect(route).toMatch(/shopDigits: digitsOnly\(String\(vendor\.whatsapp \?\? ""\)\),/);
    // ...and the unguarded default is gone, here and in the composer it feeds.
    expect(route).not.toMatch(/currencyForRegion\(region\) \|\| "USD"/);
    expect(read("src/lib/agents.ts")).not.toMatch(
      /const cur = opts\.currency \|\| currencyForRegion\(opts\.region\) \|\| "USD"/
    );
  });
});
