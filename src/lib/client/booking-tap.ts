"use client";

// THE TRIPS LIFECYCLE TAP'S ONE DECISION (audit F054).
//
// "I picked it up" and "Trip completed" are the only writers of those two
// booking statuses, and the card used to repaint itself with the action it had
// just sent whenever the answer carried no status string:
//
//   const next = typeof d?.status === "string" && d.status ? d.status : action;
//
// `r.ok` was never read, so a 401 after an aged-out session, a 502 from an
// unreadable store, and a 200 whose body says the write did not land all
// painted "Trip completed" over a booking still sitting at `confirmed` - with
// the lifecycle buttons then hidden, so the traveller could not even retry.
//
// The rule is one line of truth: paint a status only when the SERVER named one,
// or when it said outright that the transition happened. Everything else leaves
// the card alone so the traveller can tap again.
//
// Pure and exported on its own so it can be executed by a test - there is no
// React harness in this repo, and this is the part that has to be right.

/**
 * The status to render after a PATCH /api/bookings answer, or `null` when the
 * server confirmed nothing and the card must stay as it is.
 *
 * @param ok    the HTTP response's `ok` (2xx). A 401/502 is never a success.
 * @param body  the parsed JSON body, whatever shape arrived (or `{}`).
 * @param action the status that was requested - used ONLY when the server said
 *               `ok: true` without echoing a row.
 */
export function nextBookingStatus(
  ok: boolean,
  body: unknown,
  action: string
): string | null {
  if (!ok) return null;
  const b = (body ?? {}) as { ok?: unknown; status?: unknown };
  // A status the server actually read back wins - including on the honest
  // `ok:false` refusal, where it says the booking is already there and the card
  // should show exactly that.
  if (typeof b.status === "string" && b.status.trim()) return b.status.trim();
  if (b.ok === true) return action || null;
  return null;
}
