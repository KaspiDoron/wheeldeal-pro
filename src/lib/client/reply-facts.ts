// THE FACTS PASS (owner problem #8 - the blank card on a no-price reply).
//
// The replies merge in page.tsx used to skip any row without a price
// (`if (!confirmed && !effectivePrice) continue;`) - which discarded EVERYTHING
// the server had computed for that reply: the deposit, the delivery offer, the
// insurance, the shop's request for a call, its "where are you staying?"
// question, the option menu, the vehicle verdict and - fatally - the
// alternativeOffer that drives the substitution Yes/No UI. A shop that replied
// "we deliver free, passport deposit, can you call me?" with no number rendered
// a card with none of it, and the substitution feature had never rendered at
// all while the agent held the thread silent waiting for an answer the
// traveller was never shown.
//
// This module is the pure half of the fix: derive the THREAD FACTS from any
// reply row (priced or not) and apply them to a vendor - onto the existing
// offer when there is one, onto `vendor.threadFacts` when there is not - so the
// card can render what the shop said independently of whether a price was
// read. Pure so the merge is finally executable under test instead of living
// only inside a 5,000-line client component.

import type { ThreadFacts, Vendor } from "../types";

/** The subset of an /api/replies row the facts pass consumes. */
export interface ReplyFactsRow {
  vendorId: string;
  createdAt?: string | null;
  found?: boolean | null;
  pricePerDay?: number | null;
  effectivePrice?: { pricePerDay?: number | null } | null;
  replyText?: string | null;
  english?: string | null;
  deposit?: string | null;
  depositType?: string | null;
  depositAmount?: number | null;
  depositCurrency?: string | null;
  delivers?: boolean | null;
  insuranceIncluded?: boolean | null;
  deliveryFee?: number | null;
  fulfillment?: string | null;
  accessories?: ThreadFacts["accessories"];
  alternativeOffer?: ThreadFacts["alternativeOffer"];
  wantsCall?: ThreadFacts["wantsCall"];
  askedLocationQuote?: string | null;
  declined?: boolean | null;
  unavailable?: boolean | null;
  confirming?: string | null;
}

/**
 * The reply landed and none of the states the card already explains applies -
 * no price was read, the shop did not decline, is not out of stock, offered no
 * alternative, and the agent is not visibly double-checking. THAT is the state
 * that used to render as a blank: the card must say "replied, not understood"
 * instead.
 */
export function isReplyUnparsed(r: ReplyFactsRow): boolean {
  const priced = Boolean(r.found && r.pricePerDay) || Boolean(r.effectivePrice?.pricePerDay);
  return (
    !priced &&
    r.declined !== true &&
    r.unavailable !== true &&
    !r.alternativeOffer &&
    !r.confirming
  );
}

/** Derive the durable thread facts a row carries. Undefined = nothing useful. */
export function factsFromRow(r: ReplyFactsRow): ThreadFacts | undefined {
  const facts: ThreadFacts = {};
  if (r.alternativeOffer) facts.alternativeOffer = r.alternativeOffer;
  if (r.wantsCall) facts.wantsCall = r.wantsCall;
  if (r.askedLocationQuote) facts.askedLocationQuote = r.askedLocationQuote;
  if (r.deposit != null) facts.deposit = r.deposit;
  if (r.depositType != null) facts.depositType = r.depositType;
  if (typeof r.depositAmount === "number") facts.depositAmount = r.depositAmount;
  if (r.depositCurrency != null) facts.depositCurrency = r.depositCurrency;
  if (typeof r.delivers === "boolean") facts.delivers = r.delivers;
  if (typeof r.insuranceIncluded === "boolean") facts.insuranceIncluded = r.insuranceIncluded;
  if (typeof r.deliveryFee === "number") facts.deliveryFee = r.deliveryFee;
  if (
    r.fulfillment === "pickup" ||
    r.fulfillment === "delivery" ||
    r.fulfillment === "on-shop"
  ) {
    facts.fulfillment = r.fulfillment;
  }
  if (r.accessories?.length) facts.accessories = r.accessories;
  if (isReplyUnparsed(r)) {
    facts.replyUnparsed = true;
    if (r.replyText) facts.replyText = r.replyText.slice(0, 200);
    if (r.english) facts.replyEnglish = r.english.slice(0, 200);
  }
  if (r.createdAt) facts.at = r.createdAt;
  // `at` alone is not a fact worth a render.
  const keys = Object.keys(facts).filter((k) => k !== "at");
  return keys.length ? facts : undefined;
}

/**
 * Apply a row's facts to a vendor. Facts land on `threadFacts` always, and are
 * ALSO merged into an existing offer's fact fields (row value wins, existing
 * value survives a row that is silent on it - the same `r.x ?? offer.x`
 * semantics the priced merge uses). The price fields are never touched here:
 * a facts row must not invent, replace or clear a price.
 *
 * Returns the SAME vendor reference when nothing changed, so a poll that
 * carries no news does not re-render the memoized card.
 */
export function applyReplyFacts(v: Vendor, r: ReplyFactsRow): Vendor {
  const facts = factsFromRow(r);
  if (!facts) return v;
  const nextFacts: ThreadFacts = { ...v.threadFacts, ...facts };
  // A row that now carries a price (or any explained state) clears the
  // stale "replied, not understood" flag from an earlier poll.
  if (!isReplyUnparsed(r)) {
    delete nextFacts.replyUnparsed;
    delete nextFacts.replyText;
    delete nextFacts.replyEnglish;
  }
  const offer = v.offer
    ? {
        ...v.offer,
        alternativeOffer: r.alternativeOffer ?? v.offer.alternativeOffer,
        accessories: r.accessories ?? v.offer.accessories,
        wantsCall: r.wantsCall ?? v.offer.wantsCall,
        askedLocationQuote: r.askedLocationQuote ?? v.offer.askedLocationQuote,
        deposit: r.deposit ?? v.offer.deposit,
        depositType: (r.depositType ?? v.offer.depositType) as typeof v.offer.depositType,
        depositAmount: r.depositAmount ?? v.offer.depositAmount,
        depositCurrency: r.depositCurrency ?? v.offer.depositCurrency,
        includesInsurance: r.insuranceIncluded === true || v.offer.includesInsurance === true,
        includesDelivery: r.delivers === true || v.offer.includesDelivery === true,
        deliveryFee: r.deliveryFee ?? v.offer.deliveryFee,
        fulfillment: (facts.fulfillment ?? v.offer.fulfillment) as typeof v.offer.fulfillment,
      }
    : v.offer;
  const next: Vendor = { ...v, threadFacts: nextFacts, offer };
  // Same-content guard: JSON compare of the two mutated slots only.
  if (
    JSON.stringify(next.threadFacts) === JSON.stringify(v.threadFacts) &&
    JSON.stringify(next.offer) === JSON.stringify(v.offer)
  ) {
    return v;
  }
  return next;
}
