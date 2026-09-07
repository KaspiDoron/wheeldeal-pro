// AUDIT F137 - the deterministic templates must not state a package-derived
// per-day as a price the rival QUOTED.
//
// `validRivals` keeps a rival whose per-day was divided out of a multi-day
// package and stamps `derivedFromDays` on the row, because "500 for 3 days"
// gives 167 and no shop ever typed 167. `planLeverage` honours that with the
// "works out to about" directive for the LLM arm. The deterministic arm - which
// is what actually goes out on every provider failure and every rail rejection
// - dropped the provenance at `cheapestCheaperRival` and put "Another shop
// offered 333/day" on live WhatsApp instead.
//
// Everything below runs the REAL composer and the REAL rails.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ThreadDigest, TurnContext } from "./types";
import { emptyDigest } from "./digest";
import { templateFor } from "./pass";
import { runPostRails } from "./rails";
import { cheapestCheaperRival } from "../negotiation/leverage";

function ctx(p: {
  quoted?: number;
  durationDays?: number;
  rivals?: Array<{ pricePerDay: number; derivedFromDays?: number }>;
  floorPerDay?: number;
  digest?: Partial<ThreadDigest>;
  legalMoves?: TurnContext["legalMoves"];
}): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: {
        vehicleClass: "scooter",
        transmission: "any",
        durationDays: p.durationDays ?? 5,
        accessories: [],
        fulfillment: "any",
        vendorMessage: "",
      },
      currency: "THB",
      benchmark: null,
      lowest: null,
      rivals: (p.rivals ?? []).map((r, i) => ({
        vendorId: `rival-${i}`,
        shop: `Harbour Wheels ${i}`,
        pricePerDay: r.pricePerDay,
        currency: "THB",
        ...(r.derivedFromDays ? { derivedFromDays: r.derivedFromDays } : {}),
      })),
    },
    thread: {
      threadKey: "t@x.com:66812345678",
      vendorId: "v1",
      shop: "Krabi Bikes",
      digest: { ...emptyDigest(), quotedPricePerDay: p.quoted, ...p.digest },
    },
    tail: [],
    inbound: p.quoted
      ? {
          text: `${p.quoted} per day`,
          verified: { found: true, pricePerDay: p.quoted, currency: "THB" },
        }
      : { text: "", verified: { found: false } },
    legalMoves: p.legalMoves ?? ["bargain"],
    guards: { maxRounds: 4, floorPerDay: p.floorPerDay ?? 200 },
    event: "shop-message",
  };
}

describe("EXECUTED: the derived per-day keeps its provenance", () => {
  it("cheapestCheaperRival carries derivedFromDays through", () => {
    const cheapest = cheapestCheaperRival(
      [
        { pricePerDay: 333, currency: "THB", derivedFromDays: 3 },
        { pricePerDay: 380, currency: "THB" },
      ],
      400
    );
    expect(cheapest?.pricePerDay).toBe(333);
    expect(cheapest?.derivedFromDays).toBe(3);
  });

  it("the bargain template says the arithmetic, not a quote", () => {
    const t = templateFor(
      ctx({ quoted: 400, rivals: [{ pricePerDay: 333, derivedFromDays: 3 }] }),
      "bargain"
    )!;
    expect(t).toContain("works out to about");
    expect(t).toMatch(/3-day/);
    expect(t).not.toContain("Another shop offered");
    // The number is still cited - the leverage survives, only the claim changes.
    expect(t).toContain("333");
  });

  it("the momentum nudge says the arithmetic too", () => {
    const t = templateFor(
      ctx({
        rivals: [{ pricePerDay: 333, derivedFromDays: 3 }],
        legalMoves: ["momentum"],
      }),
      "momentum"
    )!;
    expect(t).toContain("works out to about");
    expect(t).toMatch(/3-day/);
    expect(t).not.toContain("has quoted");
    expect(t).not.toMatch(/someone else here is at/);
  });

  it("a rival that really did quote per day keeps the plain phrasing", () => {
    const t = templateFor(ctx({ quoted: 400, rivals: [{ pricePerDay: 333 }] }), "bargain")!;
    expect(t).toContain("Another shop offered");
    expect(t).not.toContain("works out to about");
    const m = templateFor(
      ctx({ rivals: [{ pricePerDay: 333 }], legalMoves: ["momentum"] }),
      "momentum"
    )!;
    expect(m).not.toContain("works out to about");
  });
});

describe("EXECUTED: the honest phrasing survives the rails to the wire", () => {
  it("the derived bargain template passes runPostRails with its span intact", () => {
    const c = ctx({ quoted: 400, rivals: [{ pricePerDay: 333, derivedFromDays: 3 }] });
    const message = templateFor(c, "bargain")!;
    const rail = runPostRails(c, {
      read: { intent: "bargain" },
      think: "",
      move: "bargain",
      message,
      leverageUsed: [],
      digestPatch: [],
    });
    expect(rail.ok, rail.rejected?.detail).toBe(true);
    expect(rail.finalText).toContain("works out to about");
    expect(rail.finalText).toMatch(/3-day/);
    // The traveller's own 5 days must not have swallowed the rival's 3.
    expect(rail.finalText).not.toMatch(/5[\s-]?days? price works out/);
  });

  it("the derived momentum nudge passes runPostRails too", () => {
    const c = ctx({ rivals: [{ pricePerDay: 333, derivedFromDays: 3 }], legalMoves: ["momentum"] });
    const message = templateFor(c, "momentum")!;
    const rail = runPostRails(c, {
      read: { intent: "momentum" },
      think: "",
      move: "momentum",
      message,
      leverageUsed: [],
      digestPatch: [],
    });
    expect(rail.ok, rail.rejected?.detail).toBe(true);
    expect(rail.finalText).toMatch(/3-day/);
  });
});

describe("the RIVAL OFFERS block the model is told to cite verbatim", () => {
  // buildPrompt is module-private, so the guarantee is pinned at the source:
  // the list line must carry the provenance suffix session-brief already
  // prints, or the model is handed a bare figure under a "cite it verbatim"
  // rule while the leverage card simultaneously orders "works out to about".
  const pass = readFileSync(resolve(process.cwd(), "src/lib/spte/pass.ts"), "utf8");

  it("carries the derived-package note", () => {
    expect(pass).toMatch(/another shop this search: \$\{r\.pricePerDay\} \$\{r\.currency\}\/day/);
    expect(pass).toMatch(/r\.derivedFromDays/);
    expect(pass).toMatch(/worked out per day - not a price they typed/);
  });

  it("and never the rival's name", () => {
    expect(pass).not.toMatch(/\$\{r\.shop\}/);
  });
});
