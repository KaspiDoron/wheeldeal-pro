import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trackerStageForLedger, LEDGER_TERMINAL_CARD_STAGES } from "./ledger-stage";
import { PROGRESSION_STAGES, LATERAL_STAGES } from "../funnel/stages";

// OWNER PROBLEM 2, AT THE SURFACE.
//
// The funnel ledger split `replied` from `understood` on real evidence and was
// well tested at the WRITE end. It had no readers. The traveller's card kept
// deriving its stage from the legacy three-value rollup, whose "active" fires
// on ANY stored inbound - so a shop saying "hello" drove the card to
// "Negotiating" under "The shop replied - your agent is pinning the exact price
// down." Nothing was being pinned.
//
// These tests execute the mapping, and then check that the card actually uses
// it - a mapping nobody calls would be the same defect one file over.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the line the ledger draws is the line the card draws", () => {
  it("EXECUTED: a content-free reply is REPLIED, never negotiating", () => {
    // This single assertion is the photographed bug.
    expect(trackerStageForLedger("replied")).toBe("replied");
    expect(trackerStageForLedger("replied")).not.toBe("negotiating");
  });

  it("EXECUTED: negotiating means a fact landed or a bargain went out", () => {
    expect(trackerStageForLedger("understood")).toBe("negotiating");
    expect(trackerStageForLedger("negotiating")).toBe("negotiating");
    expect(trackerStageForLedger("terms_pending")).toBe("negotiating");
  });

  it("EXECUTED: a price on the thread is an offer on the card", () => {
    for (const s of [
      "price_received",
      "price_verified",
      "terms_collected",
      "verifying",
      "shop_confirmed",
      "booked",
      "completed",
    ]) {
      expect(trackerStageForLedger(s), s).toBe("offer-received");
    }
  });

  it("EXECUTED: lateral claims map to the card's terminal states", () => {
    expect(trackerStageForLedger("declined")).toBe("declined");
    expect(trackerStageForLedger("out_of_stock")).toBe("out-of-stock");
    expect(trackerStageForLedger("unreachable")).toBe("no-contact");
  });

  it("EXECUTED: the pre-contact rungs stay silent - the card models them better", () => {
    // The ledger cannot see an outbox row being claimed, and rewriting these
    // from a poll is how the card used to flicker mid-send.
    for (const s of ["selected", "contact_queued", "dead", null, undefined, "nonsense"]) {
      expect(trackerStageForLedger(s), String(s)).toBe(null);
    }
    // `contacted` is the one pre-reply rung worth serving: it is the RFQ truth
    // rule, and it is what "Awaiting reply" means.
    expect(trackerStageForLedger("contacted")).toBe("awaiting-response");
  });

  it("EXECUTED: every ledger stage is handled deliberately - none falls through by accident", () => {
    const unmapped = [...PROGRESSION_STAGES, ...LATERAL_STAGES].filter(
      (s) => trackerStageForLedger(s) === null
    );
    // Exactly the three the card owns better than the ledger does.
    expect(unmapped.sort()).toEqual(["contact_queued", "dead", "selected"]);
  });

  it("EXECUTED: the terminal set is exactly the states a poll must not rewind", () => {
    expect([...LEDGER_TERMINAL_CARD_STAGES].sort()).toEqual([
      "declined",
      "no-contact",
      "out-of-stock",
    ]);
  });
});

describe("the card actually reads it", () => {
  const page = readCode("src/app/page.tsx");

  it("vendorStages is consumed, and the ledger OUTRANKS the legacy rollup", () => {
    // grep for vendorStages returned three hits before this, all inside the
    // producing route - the definition of a write-only ledger.
    expect(page).toMatch(/d\.vendorStages && typeof d\.vendorStages === "object"/);
    expect(page).toMatch(/const target = ledgerStage \?\? \(dbState \? stageForState\(dbState\) : null\)/);
  });

  it("a lateral claim lands even when it moves the card BACKWARDS", () => {
    // canAdvance is forward-only by design. A ledger that has decided the shop
    // declined is not advancing - it is refusing to keep pretending.
    expect(page).toMatch(/LEDGER_TERMINAL_CARD_STAGES\.has\(target\)/);
  });
});

describe("the copy stops claiming a price is being pinned down", () => {
  const card = readCode("src/components/VendorCard.tsx");

  it("a replied card says the shop answered, not that we are haggling", () => {
    expect(card).toMatch(/vendor\.stage === "replied"/);
    expect(card).toMatch(/The shop answered - your agent is reading their reply/);
  });

  it("declined and out-of-stock cards say so instead of promising a price", () => {
    expect(card).toMatch(/This shop said no\./);
    expect(card).toMatch(/Nothing available here right now/);
    // And they must not still be offering the ask.
    expect(card).toMatch(/cardTerminal/);
  });

  it("the tracker can render the new stage - a stage with no badge crashes the card", () => {
    const tracker = readCode("src/components/Tracker.tsx");
    expect(tracker).toMatch(/replied: \{ text: "Replied"/);
    expect(tracker).toMatch(/case "replied":/);
    expect(tracker).toMatch(/\{ key: "replied", label: "Replied" \}/);
  });
});
