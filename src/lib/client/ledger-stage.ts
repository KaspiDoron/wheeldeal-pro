// THE LEDGER FINALLY REACHES THE CARD.
//
// `negotiation_threads.stage` is written on evidence by advanceThreadStage and
// CLAUDE.md calls it the one source of truth the client, admin and
// product_events all read. Two of those three did. The traveller's card - the
// most-watched surface in the product - still derived its stage from the legacy
// three-value `vendorStates` rollup, which bumps a shop to "active" on ANY
// stored inbound row, ANY vendor_replies row, and even on an `extract` trace.
//
// That is owner problem 2, exactly as photographed: a shop says "hello" and the
// card announces "Negotiating" over the caption "The shop replied - your agent
// is pinning the exact price down." Nothing was being pinned. The ledger knew -
// it had the thread at `replied`, and deliberately does NOT promote to
// `understood` until a vendor_replies row carries an actionable fact - and no
// surface asked it.
//
// This module is the pure mapping. It lives client-side so page.tsx can apply
// it without importing the server module, and so it can be tested by execution.

import type { TrackerStage } from "../types";

/**
 * The card stage a ledger stage means, or `null` when the ledger has no opinion
 * worth overriding the local card state with.
 *
 * `null` is returned for the pre-contact rungs on purpose: the card already
 * models queued / sending / rfq-sent with better resolution than the ledger
 * (which cannot see an outbox row being claimed), and rewriting those from a
 * poll is how the card used to visibly flicker mid-send.
 */
export function trackerStageForLedger(stage: string | null | undefined): TrackerStage | null {
  switch (stage) {
    // Lateral claims. Each is terminal for the card until refuted by the
    // evidence class named in funnel/stages.ts - the poll must never rewind it.
    case "declined":
      return "declined";
    case "out_of_stock":
      return "out-of-stock";
    case "unreachable":
      return "no-contact";

    // THE SPLIT THAT WAS MISSING. An inbound arrived and carried no actionable
    // fact yet: the honest card state is "they answered", not "we are haggling".
    case "replied":
      return "replied";

    // A vendor_replies row with a fact, or a grounded price, or a bargain that
    // actually went out. All of these ARE the negotiation.
    case "understood":
    case "negotiating":
    case "terms_pending":
      return "negotiating";

    // A price exists and is on the card.
    case "price_received":
    case "price_verified":
    case "terms_collected":
    case "verifying":
    case "shop_confirmed":
    case "booked":
    case "completed":
      return "offer-received";

    case "contacted":
      return "awaiting-response";

    default:
      return null;
  }
}

/** The ledger stages past which a card must never be rewound by a poll. */
export const LEDGER_TERMINAL_CARD_STAGES: ReadonlySet<string> = new Set([
  "declined",
  "out-of-stock",
  "no-contact",
]);
