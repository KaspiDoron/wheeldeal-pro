import { describe, it, expect } from "vitest";
import { applyReplyFacts, factsFromRow, isReplyUnparsed, type ReplyFactsRow } from "./reply-facts";
import type { Vendor } from "../types";

// Wave 4 (owner problems #6 and #8). The substitution feature was dead END TO
// END because the page merge dropped any row without a price - each half was
// tested in isolation and the hop between them never was. These execute the
// actual merge, so re-introducing the `continue` cannot pass silently.

const vendor = (over: Partial<Vendor> = {}): Vendor =>
  ({
    id: "v1",
    name: "Shop A",
    lat: 0,
    lng: 0,
    rating: 4.5,
    reviews: 10,
    vehicleClasses: ["scooter"],
    ...over,
  }) as Vendor;

const row = (over: Partial<ReplyFactsRow> = {}): ReplyFactsRow => ({
  vendorId: "v1",
  createdAt: "2026-08-29T10:00:00Z",
  found: false,
  pricePerDay: null,
  effectivePrice: null,
  ...over,
});

describe("the substitution choice survives the merge (owner problem #6)", () => {
  const alt = {
    vehicle: "Nmax 155",
    engineSizeCc: 155,
    pricePerDay: 300,
    currency: "THB",
    closeness: "acceptable" as const,
    reason: "No Click today",
    at: 1,
  };

  it("a NO-PRICE row carrying alternativeOffer reaches vendor.threadFacts", () => {
    const v = applyReplyFacts(vendor(), row({ alternativeOffer: alt }));
    expect(v.threadFacts?.alternativeOffer?.vehicle).toBe("Nmax 155");
    // An alternative on the table is an EXPLAINED state, not an unparsed one.
    expect(v.threadFacts?.replyUnparsed).toBeUndefined();
  });

  it("with an existing offer, the alternative also lands ON the offer (the card reads it there)", () => {
    const v = applyReplyFacts(
      vendor({ offer: { pricePerDay: 250, currency: "THB" } as Vendor["offer"] }),
      row({ alternativeOffer: alt })
    );
    expect(v.offer?.alternativeOffer?.vehicle).toBe("Nmax 155");
    expect(v.offer?.pricePerDay).toBe(250); // the price is never touched
  });
});

describe("a no-price reply is no longer a blank card (owner problem #8)", () => {
  it("deposit / delivery / call facts on a priceless row all survive", () => {
    const v = applyReplyFacts(
      vendor(),
      row({
        deposit: "passport",
        depositType: "passport",
        delivers: true,
        insuranceIncluded: true,
        wantsCall: { urgency: "now", quote: "can you call me?" } as never,
        askedLocationQuote: "where are you staying?",
        replyText: "we deliver free, passport deposit, can you call me?",
      })
    );
    expect(v.threadFacts?.deposit).toBe("passport");
    expect(v.threadFacts?.delivers).toBe(true);
    expect(v.threadFacts?.insuranceIncluded).toBe(true);
    expect(v.threadFacts?.wantsCall).toBeTruthy();
    expect(v.threadFacts?.askedLocationQuote).toBe("where are you staying?");
    expect(v.threadFacts?.replyUnparsed).toBe(true);
    expect(v.threadFacts?.replyText).toContain("we deliver free");
  });

  it("declined / out-of-stock / confirming rows are EXPLAINED states, never 'unparsed'", () => {
    expect(isReplyUnparsed(row({ replyText: "no thanks", declined: true }))).toBe(false);
    expect(isReplyUnparsed(row({ unavailable: true }))).toBe(false);
    expect(isReplyUnparsed(row({ confirming: "deposit" }))).toBe(false);
  });

  it("a later PRICED row clears the stale unparsed flag", () => {
    const first = applyReplyFacts(vendor(), row({ replyText: "hello sir" }));
    expect(first.threadFacts?.replyUnparsed).toBe(true);
    const second = applyReplyFacts(first, row({ found: true, pricePerDay: 250, deposit: "cash 2000" }));
    expect(second.threadFacts?.replyUnparsed).toBeUndefined();
    expect(second.threadFacts?.deposit).toBe("cash 2000");
  });

  it("even a TEXTLESS reply (a sticker) is an honest 'replied, not understood'", () => {
    // The shop replied with something we cannot quote - that is still a reply
    // the card must acknowledge, never a blank.
    expect(factsFromRow(row())?.replyUnparsed).toBe(true);
  });

  it("a priced row with no term facts returns the SAME vendor reference (no re-render)", () => {
    const v = vendor();
    const priced = row({ found: true, pricePerDay: 250 });
    expect(applyReplyFacts(v, priced)).toBe(v);
    expect(factsFromRow(priced)).toBeUndefined();
  });

  it("a poll that carries no news returns the same reference too", () => {
    const r = row({ deposit: "passport", replyText: "passport pls" });
    const once = applyReplyFacts(vendor(), r);
    expect(applyReplyFacts(once, r)).toBe(once);
  });
});
