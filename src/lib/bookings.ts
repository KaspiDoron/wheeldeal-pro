// THE BOOKING LIFECYCLE - a real state machine for the money record
// (design-truth data model piece 2).
//
// Before this module, `bookings.status` was only ever the string 'confirmed':
// the sole operations were INSERT and DELETE, so the table could not represent
// a deposit being paid, the traveller picking the vehicle up, the trip
// completing, or a cancellation - the owner's funnel steps 7-9 had nowhere to
// land even when the conversation reached them.
//
// DOCTRINE (owner decision #3): the funnel never asserts what nobody
// witnessed. deposit_* facts flow from the deal terms at close time;
// `picked_up` and `completed` come from TRAVELLER TAPS on the Trips page; the
// scheduled_at+duration timeout only ever SUGGESTS completion via a push
// ("Did you return it?") - it never auto-completes.
//
// Concurrency is the advanceLead/advanceThreadStage pattern: forward-only by
// rank and terminal refusal live in the PostgREST PATCH filter, never in a
// read-then-write, and only the caller whose PATCH actually changed the row
// writes the history event.

import { sbUpdateReturning } from "./runtime-config";
import { noteAgentEvent } from "./events";
import { digitsOnly } from "./phone";

/** The forward path. deposit_pending/deposit_settled/deposit_waived are
 *  optional rungs - a shop that takes no deposit goes confirmed -> picked_up
 *  directly, which rank ordering allows (skips are legal, regressions are not). */
export const BOOKING_STATUSES = [
  "confirmed",
  "deposit_pending",
  "deposit_settled",
  "deposit_waived",
  "picked_up",
  "completed",
] as const;

/** Terminal exits, enterable from any non-terminal status. */
export const BOOKING_TERMINALS = ["cancelled", "no_show"] as const;

export type BookingStatus =
  | (typeof BOOKING_STATUSES)[number]
  | (typeof BOOKING_TERMINALS)[number];

const RANK: Record<string, number> = Object.fromEntries(
  BOOKING_STATUSES.map((s, i) => [s, (i + 1) * 10])
);
// The two deposit outcomes are alternatives at the same height, not a ladder:
// settled must not be "past" waived or vice versa.
RANK.deposit_waived = RANK.deposit_settled;

/** Statuses nothing may leave. `completed` is a hard terminal too - a finished
 *  trip cannot be un-finished, cancelled, or no-showed after the fact. */
const HARD_TERMINALS: readonly string[] = ["completed", "cancelled", "no_show"];

export function bookingRank(status: string | null | undefined): number | undefined {
  return status && status in RANK ? RANK[status] : undefined;
}

/** The statuses a transition to `to` is legal FROM (exported pure for tests). */
export function bookingEligibleFrom(to: BookingStatus): string[] {
  if (to === "cancelled" || to === "no_show") {
    // Any non-terminal booking can be cancelled or recorded as a no-show.
    return BOOKING_STATUSES.filter((s) => !HARD_TERMINALS.includes(s));
  }
  const toRank = RANK[to];
  // Forward-only, skips legal. The alternatives-at-same-height rule means
  // deposit_settled and deposit_waived are never eligible-from each other.
  return BOOKING_STATUSES.filter((s) => (RANK[s] ?? 0) < toRank);
}

function bookingFilter(id: number, userEmail: string, to: BookingStatus): string {
  const from = bookingEligibleFrom(to);
  // Ownership is part of the atomic predicate - a booking id is guessable, so
  // the user_email clause is what makes the PATCH a per-traveller operation
  // rather than a global one. `status=is.null` tolerates pre-lifecycle rows.
  return `id=eq.${id}&user_email=eq.${encodeURIComponent(userEmail)}&or=(status.is.null,status.in.(${from.join(",")}))`;
}

export interface BookingAdvance {
  advanced: boolean;
  /** The row after the transition, when it happened. */
  row?: { id: number; status: string; vendor_id: string | null; vendor_name: string | null; thread_key: string | null };
}

/**
 * Advance a booking's lifecycle status. Never throws. On a real transition:
 * (a) the status + any evidence fields land atomically (filter-guarded);
 * (b) one `booking-stage` agent_events row records it (join columns stamped);
 * (c) `completed` also advances the funnel ledger to its final stage - the
 *     one place the two state machines touch.
 */
export async function advanceBooking(
  id: number,
  userEmail: string,
  to: BookingStatus,
  evidence: string,
  fields: Record<string, unknown> = {}
): Promise<BookingAdvance> {
  if (!Number.isFinite(id) || id <= 0 || !userEmail) return { advanced: false };
  type Row = {
    id: number;
    status: string;
    vendor_id: string | null;
    vendor_name: string | null;
    thread_key: string | null;
  };
  const filter = bookingFilter(id, userEmail, to);
  let rows = await sbUpdateReturning<Row>("bookings", filter, { status: to, ...fields }).catch(
    () => [] as Row[]
  );
  if (!rows[0] && Object.keys(fields).length > 0) {
    // Pre-migration fallback (same doctrine as the INSERT tiers): a PATCH
    // naming an unknown evidence column 400s whole, and a lifecycle tap must
    // not be lost to a pending migration. Retrying with status only is safe -
    // a genuine filter refusal returns [] again (same predicate).
    rows = await sbUpdateReturning<Row>("bookings", filter, { status: to }).catch(
      () => [] as Row[]
    );
  }
  const row = rows[0];
  if (!row) return { advanced: false };

  const toDigits = row.thread_key ? row.thread_key.slice(row.thread_key.lastIndexOf(":") + 1) : "";
  await noteAgentEvent({
    kind: "booking-stage",
    userEmail,
    toNumber: toDigits,
    vendorId: row.vendor_id ?? "",
    vendorName: row.vendor_name ?? "",
    detail: JSON.stringify({ bookingId: id, to, evidence: evidence.slice(0, 160) }),
  });

  // Consent-gated projection into product_events (W9) - same doctrine as the
  // funnel ledger's: granted 'analytics' consent or no row at all.
  void import("./privacy/product-events")
    .then(({ projectProductEvent }) =>
      projectProductEvent({
        email: userEmail,
        stage: to,
        kind: "booking-stage",
        props: { bookingId: id },
      })
    )
    .catch(() => {});

  if (to === "completed" && toDigits) {
    const { advanceThreadStage } = await import("./funnel/stages");
    await advanceThreadStage(
      { userEmail, toNumber: toDigits, vendorId: row.vendor_id ?? undefined, vendorName: row.vendor_name ?? undefined },
      "completed",
      "trip completed",
      { overridesOutOfStock: true }
    ).catch(() => {});
  }
  return { advanced: true, row };
}

/** The thread this booking's conversation lives on - stamped at INSERT so a
 *  money record can always be traced to its negotiation. */
export function bookingThreadKey(userEmail: string, whatsapp: string | null | undefined): string | null {
  const digits = digitsOnly(whatsapp ?? "");
  return userEmail && digits ? `${userEmail}:${digits}` : null;
}

/** Pure: is this booking's rental window over? (exported for tests) */
export function rentalOver(
  scheduledAt: string | null,
  durationDays: number | null,
  nowMs: number
): boolean {
  if (!scheduledAt || !durationDays || durationDays <= 0) return false;
  const start = Date.parse(scheduledAt);
  return Number.isFinite(start) && nowMs > start + durationDays * 86_400_000;
}

/**
 * The schedule-timeout SUGGESTION sweep (ping-cron): a booking whose rental
 * window has passed and that nobody marked completed gets ONE push - "did you
 * return it?" - and nothing else. It never advances the status: the funnel
 * does not assert what nobody witnessed, it asks the person who would know.
 *
 * Once-only across instances by an atomic claim on completion_suggested_at
 * (the conditional PATCH with `is.null` in the filter IS the claim - the
 * loser matches zero rows and sends nothing).
 */
export async function suggestCompletions(nowMs = Date.now()): Promise<number> {
  const { sbSelect } = await import("./runtime-config");
  const candidates = await sbSelect<{
    id: number;
    user_email: string | null;
    vendor_name: string | null;
    scheduled_at: string | null;
    duration_days: number | null;
  }>(
    "bookings",
    // Column arithmetic is not expressible in the filter, so bound the scan to
    // started-rentals with no suggestion yet and finish the date math here.
    `select=id,user_email,vendor_name,scheduled_at,duration_days&completion_suggested_at=is.null&status=in.(${[
      ...BOOKING_STATUSES.filter((s) => s !== "completed"),
    ].join(",")})&scheduled_at=lt.${encodeURIComponent(new Date(nowMs).toISOString())}&order=scheduled_at.asc&limit=40`
  ).catch(() => []);
  let suggested = 0;
  for (const b of candidates) {
    if (!b.user_email || !rentalOver(b.scheduled_at, b.duration_days, nowMs)) continue;
    const claimed = await sbUpdateReturning<{ id: number }>(
      "bookings",
      `id=eq.${b.id}&completion_suggested_at=is.null`,
      { completion_suggested_at: new Date(nowMs).toISOString() }
    ).catch(() => [] as { id: number }[]);
    if (!claimed[0]) continue; // another instance already asked
    suggested++;
    const { sendPushToUser } = await import("./push");
    await sendPushToUser(b.user_email, {
      title: "Did you return the vehicle?",
      body: `${b.vendor_name ?? "Your rental"} - tap to mark the trip completed (or ignore if you extended).`,
      url: "/deals",
      tag: `trip-complete-${b.id}`,
    }).catch(() => null);
  }
  return suggested;
}
