// SUPABASE EGRESS - THE CEILING NOBODY COULD SEE.
//
// The owner-report-8 audit put Supabase's free 5 GB/month egress FIRST in the
// list of what breaks at beta scale, ahead of the Evolution hosts, and computed
// it exhausting in roughly 38 minutes at 50 active users. Wave A7 cut the hot
// polls by something like 8-10x, which buys hours rather than minutes - and at
// 100 users halves whatever that is.
//
// Every plan since has ended in the same instruction: "measure this before
// inviting anyone, from the Supabase usage graph, during a real hunt". That is
// a bad instruction. It needs a human watching a third-party dashboard at the
// exact moment traffic happens, it cannot be checked afterwards, and the number
// it produces is gone as soon as the tab closes. A ceiling that only exists on
// someone else's screen is a ceiling nobody acts on.
//
// So the app counts its own. Every Supabase read passes through two functions
// in runtime-config; they add up the response bytes, and this module turns that
// running total into the one number that decides an invite wave: at today's
// rate, do we cross 5 GB before the month ends?
//
// HONEST ABOUT WHAT IT IS. This is a good estimate, not a bill:
//   - It counts the READ path. Writes, Storage and Realtime are not in it.
//   - Where PostgREST sends `content-length` that is the wire size. Where it
//     does not (chunked responses), the decoded UTF-8 length is used, which
//     OVER-states whenever transport compression is active. Over-stating a
//     safety ceiling is the right direction to be wrong in.
//   - Instances that never flush before they are recycled lose their tail.
// The panel says "estimate" for all three reasons.

/** Supabase's free-tier monthly egress allowance. */
export const FREE_TIER_EGRESS_BYTES = 5 * 1024 * 1024 * 1024;

/** Past this share of the allowance, projected, the tile stops being green. */
export const EGRESS_WARN_FRACTION = 0.6;
/** Past this, the free tier will not hold the month. */
export const EGRESS_ALARM_FRACTION = 0.9;

export type EgressState = "ok" | "warn" | "alarm" | "unknown";

export interface EgressReading {
  state: EgressState;
  /** Bytes measured across the sample window. Null when nothing was readable. */
  bytes: number | null;
  /** Length of the sample, in days. */
  windowDays: number;
  /** Straight-line 30-day projection from the sample. Null when unknown. */
  projectedMonthBytes: number | null;
  /** Projection as a share of the free allowance, 0-1+. Null when unknown. */
  fraction: number | null;
  detail: string;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

/**
 * Project a sample forward to a month and say whether the free tier holds.
 *
 * A SHORT WINDOW IS NOT A VERDICT. Projecting a whole month from twenty minutes
 * of one tester's hunt would produce a confident, wildly wrong number - and a
 * confident wrong number on a launch panel is worse than a dash, because it
 * gets acted on. Under `MIN_SAMPLE_DAYS` the reading stays "unknown" and says
 * what it is still waiting for.
 */
export const MIN_SAMPLE_DAYS = 0.5;

export function egressReading(
  bytes: number | null,
  windowDays: number,
  allowance = FREE_TIER_EGRESS_BYTES
): EgressReading {
  if (bytes === null) {
    return {
      state: "unknown",
      bytes: null,
      windowDays,
      projectedMonthBytes: null,
      fraction: null,
      detail:
        "The egress counter could not be read. That is not a zero - it means this panel cannot see the ceiling the audit ranked first.",
    };
  }
  if (windowDays < MIN_SAMPLE_DAYS || bytes <= 0) {
    return {
      state: "unknown",
      bytes,
      windowDays,
      projectedMonthBytes: null,
      fraction: null,
      detail: `${formatBytes(bytes)} measured so far. A month is not projected from less than ${MIN_SAMPLE_DAYS * 24} hours of traffic - a confident wrong number here gets acted on. Run a real hunt and come back.`,
    };
  }
  const projected = (bytes / windowDays) * 30;
  const fraction = projected / allowance;
  const state: EgressState =
    fraction >= EGRESS_ALARM_FRACTION ? "alarm" : fraction >= EGRESS_WARN_FRACTION ? "warn" : "ok";
  const head = `~${formatBytes(projected)}/month projected from ${formatBytes(bytes)} over ${windowDays.toFixed(1)} day(s) - ${Math.round(fraction * 100)}% of the free 5 GB.`;
  return {
    state,
    bytes,
    windowDays,
    projectedMonthBytes: projected,
    fraction,
    detail:
      state === "alarm"
        ? `${head} The free tier will NOT hold this month, and a restricted project takes the whole app down, not one feature. Supabase Pro is $25/mo and is cheaper than any host in the fleet plan - this is the moment to buy it, or to stop inviting.`
        : state === "warn"
          ? `${head} Past ${Math.round(EGRESS_WARN_FRACTION * 100)}%, another invite wave is what crosses the line. Decide on Pro BEFORE the wave, not after the project is restricted.`
          : `${head} Read-path estimate only - writes, Storage and Realtime are not counted.`,
  };
}

/**
 * Scale a measured sample by a user multiple - "what happens if I go from 25
 * testers to 100?" - which is the actual question being asked of this number.
 */
export function projectAtUsers(
  bytes: number,
  windowDays: number,
  measuredUsers: number,
  targetUsers: number,
  allowance = FREE_TIER_EGRESS_BYTES
): { projectedMonthBytes: number; fraction: number } {
  const per = measuredUsers > 0 ? bytes / measuredUsers : bytes;
  const projected = (per * targetUsers * 30) / Math.max(windowDays, 1 / 24);
  return { projectedMonthBytes: projected, fraction: projected / allowance };
}
