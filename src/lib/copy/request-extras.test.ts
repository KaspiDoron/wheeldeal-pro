import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { compileOpener, extrasClause } from "./promptCompiler";
import type { StructuredRFQ } from "../types";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE OWNER TYPED SOMETHING INTO THE SEARCH FORM AND IT NEVER REACHED A SHOP.
//
// Three places lost it, any one of which was enough:
//
//   1. RequestBuilder hard-coded `accessories: []` and folded the free-text
//      field into `notes`.
//   2. `buildMessage` reads `accessories`. It has never read `notes`.
//   3. It does not matter what the client composed anyway - the outreach route
//      REPLACES the text with compileOpener, which rendered the vehicle and
//      the duration and stopped.
//
// So "child seat" was dropped, silently, on the way to every shop in the batch.

const rfq = (over: Partial<StructuredRFQ> = {}): StructuredRFQ => ({
  vehicleClass: "scooter",
  engineSizeCc: 125,
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
  ...over,
});

const seed = { threadId: "traveller@example.com", vendorId: "v1", nonce: 0 };

describe("the extras clause", () => {
  it("one item reads as itself", () => {
    expect(extrasClause(rfq({ accessories: ["a child seat"] }))).toBe("a child seat");
  });

  it("several read as a list a person would say out loud", () => {
    expect(extrasClause(rfq({ accessories: ["a child seat", "a phone mount"] }))).toBe(
      "a child seat and a phone mount"
    );
    expect(
      extrasClause(rfq({ accessories: ["a child seat", "a phone mount", "a top box"] }))
    ).toBe("a child seat, a phone mount and a top box");
  });

  it("it is BOUNDED - a shopping list buries the question the message exists to ask", () => {
    const many = extrasClause(rfq({ accessories: ["a", "b", "c", "d", "e"] }));
    expect(many).toBe("a, b and c");
    // ...and one enormous item cannot run away with the message either. The
    // field accepts 240 characters of anything.
    expect(extrasClause(rfq({ accessories: ["x".repeat(300)] })).length).toBeLessThanOrEqual(40);
  });

  it("nothing asked for means nothing added", () => {
    expect(extrasClause(rfq())).toBe("");
    expect(extrasClause(rfq({ accessories: ["", "   "] }))).toBe("");
  });
});

describe("REPRODUCTION: the opener that replaces everything now carries them", () => {
  it("a child seat reaches the shop", () => {
    const out = compileOpener(rfq({ accessories: ["a child seat"] }), seed);
    expect(out).toMatch(/child seat/);
  });

  it("...and the price question is still the message's point", () => {
    const out = compileOpener(rfq({ accessories: ["a child seat"] }), seed);
    expect(out).toMatch(/\?/);
    // The extras clause goes AFTER the ask, never in front of it.
    expect(out.indexOf("child seat")).toBeGreaterThan(out.search(/(price|rate|much|cost)/i));
  });

  it("an opener with no extras is byte-identical to before", () => {
    // The whole matrix is seeded and deterministic; adding a dimension must not
    // shift a draw that has no extras to render.
    const out = compileOpener(rfq(), seed);
    expect(out).not.toMatch(/also|too|need/i);
    expect(out.length).toBeGreaterThan(20);
  });

  it("different vendors still get different shapes - the anti-fingerprint holds", () => {
    const a = compileOpener(rfq({ accessories: ["a top box"] }), { ...seed, vendorId: "v1" });
    const b = compileOpener(rfq({ accessories: ["a top box"] }), { ...seed, vendorId: "v2" });
    const c = compileOpener(rfq({ accessories: ["a top box"] }), { ...seed, vendorId: "v3" });
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
    // ...and the same seed is still bit-stable.
    expect(compileOpener(rfq({ accessories: ["a top box"] }), { ...seed, vendorId: "v1" })).toBe(a);
  });
});

describe("the form stops throwing the answer away", () => {
  const builder = readCode("src/components/RequestBuilder.tsx");

  it("extras are written to accessories, not only to notes", () => {
    // W12e: the dates are stripped first. A traveller who typed "27 to 1" had
    // it appended verbatim to an opener that already stated the picker's
    // window, so the shop was asked about two different rentals in one
    // message. The window is a chip now, not an accessory.
    expect(builder).toMatch(
      /accessories: parseExtras\(storageBox, withoutWindowText\(custom\)\)/
    );
    expect(builder).not.toMatch(/accessories: \[\]/);
    // `notes` survives as the traveller's raw words - provenance, and the
    // fallback if the split ever reads a sentence wrongly.
    expect(builder).toMatch(/fields\.notes = notes/);
  });
});

describe("mileage means the odometer, and says so", () => {
  const builder = readCode("src/components/RequestBuilder.tsx");

  it("the ranges are the owner's, and they are formatted", () => {
    expect(builder).toMatch(/ODOMETER_MAX_KM = \[null, 5_000, 15_000, 30_000\]/);
    expect(builder).toMatch(/m\.toLocaleString\(\)/);
    // The review chip rendered a raw "<30000km".
    expect(builder).toMatch(/maxMileage\.toLocaleString\(\)/);
  });

  it("the label no longer contradicts every consumer of the field", () => {
    // "Max mileage per day" against agents.ts asking for a bike "under 100 km"
    // and graph/gaps.ts asking for an odometer photo. Nobody meant a daily
    // allowance; the label was the only thing that said one.
    expect(builder).toMatch(/Max distance on the clock/);
    expect(builder).not.toMatch(/Max mileage per day/);
    expect(readCode("src/lib/i18n-catalog.ts")).toMatch(/Max distance on the clock/);
  });

  it("and the shops are asked in those terms", () => {
    const agents = readCode("src/lib/agents.ts");
    expect(agents).toMatch(/km on the clock/);
    expect(readCode("src/lib/graph/gaps.ts")).toMatch(/odometer reading/);
  });
});
