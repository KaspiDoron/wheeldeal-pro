"use client";

// WHO CLOSED THIS HUNT, AS THE CARD RECEIVES IT (audit F146).
//
// Three writers stamp one `session-closed` marker with three different reasons
// - the traveller's own clear, the TTL stand-down agent-loop fires when a reply
// lands past the window, and a locked booking - and /api/deals now names which
// one it was in `closedBy`. The Trips card reads that discriminant to choose
// its copy AND to decide whether Re-open is still a live button.
//
// This is the client half of the same defaulting rule the route applies in
// session-life.ts (`closedByOf`): a close with no reason attached is the
// traveller's own clear, so an unlabelled hunt keeps the strict refusal and can
// never be offered a Re-open that only 404s. It matters on the wire and not
// only in the database, because the page can be handed a payload from a build
// that predates `closedBy` - a browser on a cached bundle during a rolling
// deploy, an older revision still answering, or a test double that stubs the
// boolean alone - and reading the raw field there dropped both honest arms and
// rendered the 404 button.

/** The three closers, or `null` for a hunt nobody has closed. */
export type HuntClosure = "user" | "expired" | "deal" | null;

/**
 * The verdict for one SessionSummary as it arrived from /api/deals.
 *
 * Only the three known reasons pass through; ANY other value on a closed hunt
 * - absent, null, or a word this build does not know - is the traveller's own
 * clear.
 */
export function huntClosure(s: {
  closed?: boolean | null;
  closedBy?: string | null;
}): HuntClosure {
  if (s.closedBy === "expired" || s.closedBy === "deal" || s.closedBy === "user") {
    return s.closedBy;
  }
  return s.closed ? "user" : null;
}
