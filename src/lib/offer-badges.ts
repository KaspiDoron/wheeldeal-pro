// WORDS THE TRAVELLER DID NOT AGREE TO LEARN.
//
// The price row wears one of four badges - VERIFIED, SHOP QUOTE, UNVERIFIED,
// DIFFERENT VEHICLE - and every one of them is a term of art this app invented.
// They carry real, load-bearing distinctions (whether the price is for the
// vehicle that was asked for, whether the model has been confirmed, whether the
// number can be locked), and none of that is guessable from the word.
//
// Worse, the two that sound alarming are the two that most often mean "nothing
// is wrong": SHOP QUOTE is a real price a real shop gave, and UNVERIFIED means
// the agent is confirming the model in the background and the badge will flip
// on its own. A traveller reading those as warnings hesitates over a good deal.
//
// ONE VOCABULARY, so the badge and its explanation cannot drift: the label the
// card renders and the sentence the tooltip shows come from the same entry.

export type OfferStance = "mismatch" | "similar" | "confirming" | "verified" | "quote";

export interface OfferBadge {
  /** Stable id - the InfoTip's single-open key, and the test's anchor. */
  id: OfferStance;
  /** The badge text itself. */
  label: string;
  /** Plain language: what this badge is telling you. */
  what: string;
  /** What to do about it, when there is anything to do. */
  next?: string;
}

export const OFFER_BADGES: Record<OfferStance, OfferBadge> = {
  verified: {
    id: "verified",
    label: "VERIFIED",
    what:
      "The shop confirmed IN WRITING that this price is for the exact vehicle you asked for. This is the strongest state an offer reaches, and it is safe to lock.",
  },
  quote: {
    id: "quote",
    label: "SHOP QUOTE",
    what:
      "A real price a real shop gave us for your request. It has not been double-confirmed against the exact model yet - which is normal, not a warning.",
    next: "Nothing to do. Lock it if you like it, or let the agent keep pushing.",
  },
  confirming: {
    id: "confirming",
    label: "UNVERIFIED",
    what:
      "The price is real and lockable. Your agent is asking the shop to confirm exactly which model it covers, and this badge flips to VERIFIED on its own when it answers.",
    next: "Nothing to do - it resolves itself, usually within a few minutes.",
  },
  // A SUBSTITUTE THE SHOP OFFERED, waiting on the traveller's Yes/No. Distinct
  // from `mismatch`, which is a shop quoting the wrong bike by accident or
  // misunderstanding: this shop is actively trying to do business, and the
  // traveller has a decision in front of them. Two documents credited this tag
  // as shipped and it did not exist - the substitute simply wore UNVERIFIED,
  // which reads as "resolves itself" over a choice only a person can make.
  similar: {
    id: "similar",
    label: "SIMILAR VEHICLE",
    what:
      "This shop does not have the exact vehicle you asked for, and offered a close alternative instead. The price is real - it is just for a different machine, so it is not counted as your best deal.",
    next: "Say Yes or No on the card. Your agent has paused this conversation until you do.",
  },
  mismatch: {
    id: "mismatch",
    label: "DIFFERENT VEHICLE",
    what:
      "This price is for a DIFFERENT vehicle than the one you asked for - a smaller engine, an automatic instead of a manual, or another class entirely. It is not counted as your best deal.",
    next: "Your agent is asking the shop about the vehicle you wanted. If you would take this one instead, say so and it becomes the target.",
  },
};

/**
 * Which badge an offer wears.
 *
 * Precedence is deliberate and matches the card: a vehicle mismatch outranks
 * everything (a price for the wrong bike is not a better deal however well
 * confirmed), then the in-flight confirmation, then the written confirmation.
 */
export function offerBadge(input: {
  stance?: string | null;
  verified?: boolean | null;
  /** A substitution is parked on this thread, waiting on the traveller. */
  pendingChoice?: boolean | null;
}): OfferBadge {
  if (input.stance === "mismatch") {
    // A parked substitution is its own state - the shop offered something, and
    // the traveller has a Yes/No to make. `mismatch` copy says the agent is
    // handling it, which is false while the thread is paused on them.
    return input.pendingChoice ? OFFER_BADGES.similar : OFFER_BADGES.mismatch;
  }
  if (input.stance === "confirming") return OFFER_BADGES.confirming;
  return input.verified ? OFFER_BADGES.verified : OFFER_BADGES.quote;
}
