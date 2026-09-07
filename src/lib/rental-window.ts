// THE RENTAL WINDOW AUTHORITY - one function that decides when a rental may
// start, by plan, on the SERVER.
//
// "Free is same-day only" was a rule in three places and enforced in none of
// them properly: `/api/bookings` had no plan check at all, so a client posting
// a future pickup date simply got one; `close-deal` passed the traveller's
// `when` straight through; and the RFQ opener happily asked shops about a
// future start date regardless of plan. Only the outreach composer knew the
// rule, and it knew it as a regex over one message.
//
// A rule enforced at one surface out of four is not a rule, it is a suggestion
// with a UI. This is the single authority every surface calls - including the
// client, which now only ever DISPLAYS what the server decided rather than
// deciding for itself.
//
// PURE: no clock of its own, no database, no session. `now` and `plan` come in,
// a decision comes out, and it is unit-testable in every timezone.

export type PlanTier = "free" | "pro" | "ultra";

export interface WindowDecision {
  /** The start date the rental may actually use (YYYY-MM-DD). */
  startDate: string;
  /** True when the requested date was moved. */
  adjusted: boolean;
  /** Plain-language reason, shown to the traveller when adjusted. */
  reason?: string;
  /** The furthest start date this plan may book, for the UI's date picker. */
  maxStartDate: string;
  /** Free plans are today-only; paid plans book ahead. */
  daysAhead: number;
}

/** How far ahead each plan may schedule a rental start. */
export const PLAN_DAYS_AHEAD: Record<PlanTier, number> = {
  free: 0, // today only
  pro: 30,
  ultra: 180,
};

function normalizePlan(plan: string | null | undefined): PlanTier {
  const p = String(plan ?? "").toLowerCase();
  return p === "ultra" ? "ultra" : p === "pro" ? "pro" : "free";
}

/** YYYY-MM-DD for an instant, in a given IANA zone (the traveller's local day). */
export function localDay(nowMs: number, timeZone?: string): string {
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/**
 * Calendar arithmetic on a YYYY-MM-DD string. Anchored at UTC midnight
 * DELIBERATELY: the input carries no zone, so parsing it as local and rendering
 * it back through toISOString() would shift the day by one for anyone east or
 * west of Greenwich - and DST would move it again twice a year. This adds days
 * to a date label, which is a different operation from adding days to a moment.
 *
 * Exported because the booking sheet was doing this arithmetic itself with a
 * local Date, and getting a return date one day early for every traveller in
 * Asia.
 */
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The device's IANA zone, or undefined when the runtime will not say.
 *
 * Every date decision in this app is about the TRAVELLER'S day - "same-day
 * pickup" means the day it is where they are standing, not in Greenwich - and
 * the server can only honour that if the client tells it where that is.
 */
export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * THE decision. A requested date outside the plan's window is CLAMPED, never
 * silently accepted and never rejected with a dead end - the traveller gets the
 * soonest date their plan allows plus an honest reason.
 *
 * A date in the past is always moved to today, whatever the plan: it is a stale
 * form, not an upsell moment.
 */
export function resolveWindow(opts: {
  plan: string | null | undefined;
  requested?: string | null;
  nowMs: number;
  timeZone?: string;
}): WindowDecision {
  const plan = normalizePlan(opts.plan);
  const daysAhead = PLAN_DAYS_AHEAD[plan];
  const today = localDay(opts.nowMs, opts.timeZone);
  const maxStartDate = addDays(today, daysAhead);

  const requested = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.requested ?? ""))
    ? String(opts.requested)
    : "";
  if (!requested) {
    return { startDate: today, adjusted: false, maxStartDate, daysAhead };
  }
  if (requested < today) {
    return {
      startDate: today,
      adjusted: true,
      reason: "That date has passed - using today instead.",
      maxStartDate,
      daysAhead,
    };
  }
  if (requested > maxStartDate) {
    return {
      startDate: maxStartDate,
      adjusted: true,
      reason:
        daysAhead === 0
          ? "The free plan arranges same-day rentals. Pro and Ultra book ahead."
          : `Your plan books up to ${daysAhead} days ahead.`,
      maxStartDate,
      daysAhead,
    };
  }
  return { startDate: requested, adjusted: false, maxStartDate, daysAhead };
}

/**
 * Clamp a request's start (and return) date to the plan's window, so the RFQ
 * the agents send to shops asks about a date the traveller can actually book.
 *
 * Without this the opener happily asked twenty shops about a future start date
 * a free plan cannot arrange - twenty real conversations built on a promise the
 * app would refuse at the end. Adjusting up front is kinder than refusing at
 * the close, and it is the same authority doing it.
 */
export function clampRfqWindow<T extends { startDate?: string; returnDate?: string }>(
  rfq: T,
  opts: { plan: string | null | undefined; nowMs: number; timeZone?: string }
): { rfq: T; adjusted: boolean; reason?: string } {
  if (!rfq.startDate) return { rfq, adjusted: false };
  const d = resolveWindow({ plan: opts.plan, requested: rfq.startDate, nowMs: opts.nowMs, timeZone: opts.timeZone });
  if (!d.adjusted) return { rfq, adjusted: false };
  // Keep the trip LENGTH the traveller asked for when the start moves.
  const shift =
    rfq.returnDate && /^\d{4}-\d{2}-\d{2}$/.test(rfq.returnDate)
      ? Date.parse(`${rfq.returnDate}T00:00:00Z`) - Date.parse(`${rfq.startDate}T00:00:00Z`)
      : null;
  const returnDate =
    shift !== null && Number.isFinite(shift)
      ? new Date(Date.parse(`${d.startDate}T00:00:00Z`) + shift).toISOString().slice(0, 10)
      : rfq.returnDate;
  return {
    rfq: { ...rfq, startDate: d.startDate, ...(returnDate ? { returnDate } : {}) },
    adjusted: true,
    reason: d.reason,
  };
}

/**
 * THE ONE WRITER OF `returnDate` (W4.1). An RFQ can arrive carrying
 * `durationDays: 3` next to a 16->17 Aug range - two facts about the same trip
 * that disagree, because the range came from an LLM parse while the duration
 * came from the traveller's picker. Nothing reconciled them, so the opener told
 * shops a window the traveller never asked for.
 *
 * After every override has been applied, the return date is ARITHMETIC, not
 * understanding: start + duration, deterministically. An LLM-supplied
 * returnDate that contradicts the reconciled pair is overwritten, never kept.
 * With no start date there is no pair to reconcile, so the RFQ is untouched.
 */
export function deriveReturnDate<
  T extends { startDate?: string; returnDate?: string; durationDays: number }
>(rfq: T): T {
  if (!rfq.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(rfq.startDate)) return rfq;
  const days = Math.floor(Number(rfq.durationDays));
  if (!Number.isFinite(days) || days < 1) return rfq;
  const derived = addDays(rfq.startDate, days);
  if (rfq.returnDate === derived) return rfq;
  return { ...rfq, returnDate: derived };
}

/**
 * THE DATE THE BOOKING SHEET OPENS ON (audit F107).
 *
 * The sheet used to derive it from the clock alone - today for a free plan,
 * tomorrow otherwise - and never looked at `rfq.startDate`, the field the
 * traveller filled in and the openers stated to every shop ("5 days from
 * 20 Sep"). So a Pro traveller who negotiated a window three weeks out tapped
 * Book and silently got tomorrow, with start_date/return_date written from that
 * same wrong day.
 *
 * The RFQ's start wins whenever it is a real date, run through the SAME
 * resolveWindow authority the server enforces, so a stale date becomes today
 * and a date past the plan's ceiling is clamped rather than offered and then
 * refused. With no usable RFQ date the old defaults stand.
 */
export function pickupDefault(opts: {
  rfqStartDate?: string | null;
  plan: string | null | undefined;
  nowMs: number;
  timeZone?: string;
}): string {
  const today = localDay(opts.nowMs, opts.timeZone);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(opts.rfqStartDate ?? ""))) {
    return resolveWindow({
      plan: opts.plan,
      requested: opts.rfqStartDate,
      nowMs: opts.nowMs,
      timeZone: opts.timeZone,
    }).startDate;
  }
  // No date to honour: same-day for a plan that can only do same-day, and the
  // next day for one that books ahead.
  const ahead = resolveWindow({ plan: opts.plan, nowMs: opts.nowMs, timeZone: opts.timeZone });
  return ahead.daysAhead === 0 ? today : addDays(today, 1);
}

/** May this plan schedule a rental starting on this day at all? */
export function withinWindow(opts: {
  plan: string | null | undefined;
  requested?: string | null;
  nowMs: number;
  timeZone?: string;
}): boolean {
  return !resolveWindow(opts).adjusted;
}
