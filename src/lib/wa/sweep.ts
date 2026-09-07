// Pure fair-rotation for the scheduler's inbound-recovery sweep. The webhook is
// the primary inbound path; this sweep is the app-CLOSED backstop that pulls
// recent shop replies straight from Evolution for a few senders each tick. To
// stay cheap it processes at most N senders per tick, rotating by minute-of-day
// so every active sender is covered over the hour without a per-user timer.

/** Deterministically pick up to `n` emails for this minute, rotating the window
 * across the sorted sender list so coverage is fair over ~an hour. */
export function pickSweepEmails(emails: string[], minute: number, n: number): string[] {
  const unique = [...new Set(emails.filter(Boolean))].sort();
  if (unique.length === 0 || n <= 0) return [];
  if (unique.length <= n) return unique;
  const start = ((minute % unique.length) + unique.length) % unique.length;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(unique[(start + i) % unique.length]);
  return out;
}

/**
 * How many senders to sweep per minute, PROPORTIONAL to the fleet (owner report
 * 4, scale #9). A fixed 3/min meant a full rotation of the sender list took
 * `ceil(fleet/3)` minutes - fine at a dozen users, but at 300 that is a
 * 100-minute worst-case gap between app-closed recovery sweeps for any one
 * shop. Scale it to ceil(fleet/20) so the whole fleet is covered within ~20
 * minutes regardless of size, floored at 3 (never regress small deployments)
 * and capped at 10 (one cron minute cannot fan out unbounded work). Pure.
 */
export function sweepCapForFleet(fleetSize: number): number {
  return Math.min(10, Math.max(3, Math.ceil(fleetSize / 20)));
}

/** Rotate a WINDOW of `size` items across `items`, advancing a full window per
 * tick - so over ceil(len/size) ticks EVERY item is visited. The per-thread
 * sweep uses this: always taking the newest N meant the older shops of a big
 * batch were never swept and their missed replies stayed missed forever. */
export function rotateWindow<T>(items: T[], tick: number, size: number): T[] {
  if (size <= 0) return [];
  if (items.length <= size) return items;
  const start = (((tick * size) % items.length) + items.length) % items.length;
  const out: T[] = [];
  for (let i = 0; i < size; i++) out.push(items[(start + i) % items.length]);
  return out;
}

/**
 * WHICH PASS OVER THE ROSTER THIS MINUTE BELONGS TO - the tick the PER-THREAD
 * rotation must use on the cron path (audit F233).
 *
 * The two rotations used to share one clock: the ping picks travellers with
 * `rotateWindow(roster, minute, cap)` and syncInboundReplies picked that
 * traveller's threads with `rotateWindow(numbers, minute, 5)`. A traveller is
 * only selected on the minutes whose outer window covers them, so the inner
 * window only ever saw the starts belonging to those minutes - and a fixed
 * contiguous block of their shops was NEVER pulled from Evolution. Measured
 * over the two pure functions: a 4-user fleet covers 15 of 20 threads, a
 * 60-user fleet only 5 of 20, for every roster position.
 *
 * rotateWindow's contract is "advance a full window per tick", so the tick has
 * to advance by exactly one PER VISIT. The outer rotation walks the whole
 * roster in `ceil(roster / cap)` minutes and touches each traveller exactly
 * once per walk, so the number of completed walks is that counter - pure, no
 * stored cursor, and (unlike a visit ordinal derived from `minute * cap /
 * roster`, which collapses onto a subset of window starts whenever cap and the
 * roster share a factor) it restores full coverage at every fleet size.
 */
export function rosterPassTick(minute: number, rosterSize: number, perTick: number): number {
  const walkMinutes = Math.max(1, Math.ceil(Math.max(1, rosterSize) / Math.max(1, perTick)));
  return Math.floor(minute / walkMinutes);
}
