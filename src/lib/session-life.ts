// HOW LONG A SEARCH SESSION STAYS LIVE - one answer, shared by four callers.
//
// THE DEFECT THIS EXISTS TO KILL. A traveller opened the app and found the hunt
// they ran a WEEK earlier sitting there as the live workspace, complete with its
// shops, its offers and the line "Picked your hunt back up - the agents never
// stopped." The agents had very much stopped. Four independent gaps produced it,
// and each one on its own was enough:
//
//   1. /api/deals/restore?ts=latest selected `searches` with no `created_at`
//      floor at all and pinned to group 0 - the newest row in the table, whether
//      that was five minutes or five months old.
//   2. The cold-mount auto-restore on the client fired whenever the vendor list
//      was empty, with no age check of its own.
//   3. sessionStorage's `wd_search` was read back with no TTL, even though the
//      blob already carried `searchEpoch`.
//   4. The restored (ancient) epoch was then sent as `since=` to /api/activity
//      and /api/replies, overriding their own 24h defaults, so a week of traces
//      and offers was re-hydrated onto the board.
//
// A shared constant would not have been enough on its own - the sibling route
// /api/deals ALREADY had a 14-day window and simply disagreed. What was missing
// was one PREDICATE that every surface asks. That is this module.
//
// It is deliberately pure and free of `server-only` so the browser rehydrate and
// the route handlers can import the same function. The value is owner-tunable
// (see `searchSessionTtlMs` in ./session-life-config for the server-side read);
// this file owns the default and the arithmetic.

/**
 * How long after a search STARTED it is still "the live hunt".
 *
 * Three hours, chosen against the product rather than a round number: a
 * traveller lands, searches for a bike, and the shops that were going to answer
 * have answered inside an hour or two. Past that the board is history, not work
 * in progress - and showing history as live is the bug above.
 */
export const SEARCH_SESSION_TTL_MS = 3 * 60 * 60 * 1000;

/** Owner-tunable floor and ceiling, so a bad config value cannot break the app. */
export const MIN_SESSION_TTL_MS = 15 * 60 * 1000;
export const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Parse an owner-supplied TTL (hours, as typed into the Key Vault) into ms.
 *
 * Anything unparseable, absent, or outside the sane band falls back to the
 * default rather than to zero. A zero TTL would expire every session the instant
 * it was created - which is a worse bug than the one this module fixes, and the
 * kind of thing an empty text field produces by accident.
 */
export function parseSessionTtl(raw: string | null | undefined): number {
  const hours = Number(String(raw ?? "").trim());
  if (!Number.isFinite(hours) || hours <= 0) return SEARCH_SESSION_TTL_MS;
  const ms = hours * 3600_000;
  if (ms < MIN_SESSION_TTL_MS) return MIN_SESSION_TTL_MS;
  if (ms > MAX_SESSION_TTL_MS) return MAX_SESSION_TTL_MS;
  return ms;
}

/**
 * Is a session that started at `startMs` still live?
 *
 * FAILS CLOSED on a missing or nonsensical start. An unknown age must read as
 * stale, never as fresh: the whole failure mode here is old state presented as
 * current, so the direction of the doubt matters.
 */
/**
 * `searches.source` values that record a REQUEST BUILD rather than a hunt.
 *
 * /api/profile inserts a `searches` row every time an RFQ is built - both the
 * LLM profiler and the zero-token tap-to-build panel - stamped `results: 0`,
 * with no snapshot and no rfq. /api/vendors is the one that records a real
 * search.
 *
 * Telling them apart matters in three places that had each answered it
 * differently or not at all: the auto-restore (a build row is the newest
 * "session" and carries no snapshot, so it fell through to an unbounded
 * fallback), the Trips list (padded with entries that open onto nothing), and
 * the warm-up gate - which counts completed searches and therefore decides
 * whether anyone is allowed to pay us.
 */
const BUILD_ONLY_SOURCES = new Set(["panel", "profiler"]);

/** Does this `searches` row represent a hunt the traveller actually ran? */
export function isRealHunt(source: string | null | undefined): boolean {
  return !BUILD_ONLY_SOURCES.has(String(source ?? ""));
}

export function isSessionFresh(
  startMs: number | null | undefined,
  nowMs: number,
  ttlMs: number = SEARCH_SESSION_TTL_MS
): boolean {
  if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs <= 0) return false;
  // A start in the future is a clock-skew artefact, not a fresh session. Treat
  // it as live rather than stale - the phone is ahead of the server, and the
  // hunt genuinely just began.
  if (startMs > nowMs) return true;
  return nowMs - startMs < ttlMs;
}

/** The oldest moment that still belongs to a live session, as epoch ms. */
export function sessionFloorMs(nowMs: number, ttlMs: number = SEARCH_SESSION_TTL_MS): number {
  return nowMs - ttlMs;
}

/**
 * Slack added to the floor used for CLAMPING a caller's window (never to the
 * freshness test itself).
 *
 * The client stamps `searchEpoch` from the PHONE's clock and corrects it with a
 * measured skew before sending it as `since=`. A hard floor at exactly now-TTL
 * would therefore shave the first seconds off a session whose own start sits a
 * hair outside it, and the symptom - the oldest few replies of a hunt quietly
 * missing - is far more expensive to diagnose than the half hour of extra rows
 * this grace admits. The clamp exists to refuse a WEEK, not to trim minutes.
 */
export const CLAMP_GRACE_MS = 30 * 60 * 1000;

/** The same floor as a Postgres-comparable ISO string. */
export function sessionFloorIso(nowMs: number, ttlMs: number = SEARCH_SESSION_TTL_MS): string {
  return new Date(sessionFloorMs(nowMs, ttlMs)).toISOString();
}

/**
 * Clamp a caller-supplied `since=` so it can never reach further back than the
 * TTL.
 *
 * This is the server-side backstop for gap 4. The client sends the session epoch
 * it holds, and a restored-from-history client used to send one a week old -
 * which silently overrode /api/activity's own 24h default and made the route
 * return a week of rows. It is also the reason `since` is bounded at all: the
 * parameter is caller-controlled and previously had no floor.
 *
 * Returns the LATER of the two, so a client asking for a narrower window (a
 * fresh search, a delta poll) still gets exactly what it asked for.
 */
export function clampSince(
  requestedMs: number | null | undefined,
  nowMs: number,
  ttlMs: number = SEARCH_SESSION_TTL_MS
): number {
  const floor = sessionFloorMs(nowMs, ttlMs) - CLAMP_GRACE_MS;
  if (typeof requestedMs !== "number" || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return floor;
  }
  return Math.max(requestedMs, floor);
}

// ---- one definition of "a search session" ---------------------------------

/** The 30-minute quiet gap that separates one hunt from the next. */
export const SESSION_GROUP_GAP_MS = 30 * 60_000;

/** The minimum a row must carry to be grouped. */
export interface GroupableSearchRow {
  id: number;
  source: string | null;
  created_at: string;
}

/**
 * Group `searches` rows into hunts, newest hunt first.
 *
 * THREE ROUTES GROUPED THE SAME ROWS AND DISAGREED ABOUT THE ANSWER.
 *
 * `/api/deals` (the Trips list), `/api/deals/restore` and `/api/deals/recheck`
 * each carried their own copy of this loop. The copies were identical - but the
 * QUERIES feeding them were not: the list reads 14 days x 30 rows, restore
 * reads unbounded x 40. Same algorithm, different inputs, different group
 * boundaries.
 *
 * That mattered because restore then matched the hunt the traveller tapped by
 * TIMESTAMP, with a one-second tolerance, against a boundary computed from a
 * different row set:
 *
 *     groups.findIndex(g => Math.abs(Date.parse(g[0].created_at) - startMs) < 1000)
 *
 * Past ~30 hunt rows the list's oldest group is truncated mid-hunt and starts
 * at a LATER row than restore's version of the same hunt. The timestamps differ
 * by minutes, the match fails, and the traveller is told "That hunt is no
 * longer available" about a hunt that is sitting right there in the list.
 * `recheck` has the identical branch, so price re-check broke the same way.
 *
 * So: one implementation, and hunts are addressed by the `searches.id` of their
 * first row - a value that does not move when the query window does. A
 * reconstructed timestamp was never an identity; it was a coincidence that
 * usually held.
 */
export function groupSearchSessions<T extends GroupableSearchRow>(rows: T[]): T[][] {
  // Building a request is not running a hunt: /api/profile writes a row for
  // every RFQ build, and those carry the newest created_at with no snapshot.
  const hunts = rows.filter((r) => isRealHunt(r.source));
  const asc = [...hunts].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const groups: T[][] = [];
  for (const row of asc) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && Date.parse(row.created_at) - Date.parse(prev.created_at) <= SESSION_GROUP_GAP_MS) {
      last.push(row);
    } else {
      groups.push([row]);
    }
  }
  groups.reverse(); // newest session first, matching the Trips list order
  return groups;
}

/**
 * The stable identity of a hunt: the id of the row it starts with.
 *
 * Callers address a session with this instead of `group[0].created_at`, so a
 * different LIMIT or date window can no longer make two routes disagree about
 * which hunt the traveller meant.
 */
export function sessionIdOf<T extends GroupableSearchRow>(group: T[]): number | null {
  return group[0]?.id ?? null;
}

// ---- one definition of "this hunt's activity window" -----------------------

/**
 * The clock slack applied to the START of a hunt's window.
 *
 * The `searches` row and the first outbound message are written by two
 * different requests; a message stamped a few hundred ms before its own search
 * row is an ordinary race, not a message from the previous hunt.
 */
export const WINDOW_GRACE_MS = 1000;

/**
 * The window a hunt OWNS: from its first search row until the next (newer)
 * hunt begins.
 *
 * THREE ROUTES COMPUTED THIS INLINE AND ONE OF THEM DID NOT USE IT AT ALL.
 * `/api/deals` filtered its rows with `t >= start && t < end`, restore and
 * recheck with `t >= start - 1000 && t < end` - and recheck then QUERIED with
 * no date bound whatsoever, taking the newest 200 rows of all time and hoping
 * the hunt was inside them. For any traveller with a few hunts behind them it
 * was not: the card offered "Ask if these deals still stand (5)" and the route
 * answered "No shops were messaged in that hunt." about the same five shops.
 *
 * One window object, and the same object also builds the PostgREST bound - so
 * what a route READS and what it then FILTERS can no longer disagree.
 */
export interface HuntWindow {
  /** First row of the hunt, epoch ms (already carrying the grace). */
  start: number;
  /** Where the next hunt begins, epoch ms; Infinity for the newest hunt. */
  end: number;
  startIso: string;
  /** Null for the newest hunt - it has no upper bound. */
  endIso: string | null;
  contains(iso: string | null | undefined): boolean;
}

export function huntWindow<T extends GroupableSearchRow>(
  groups: readonly T[][],
  gi: number
): HuntWindow {
  const first = groups[gi]?.[0]?.created_at ?? "";
  const rawStart = Date.parse(first);
  const start = Number.isFinite(rawStart) ? rawStart - WINDOW_GRACE_MS : 0;
  const nextIso = gi > 0 ? (groups[gi - 1]?.[0]?.created_at ?? null) : null;
  const nextMs = nextIso ? Date.parse(nextIso) : NaN;
  const end = Number.isFinite(nextMs) ? nextMs : Infinity;
  return {
    start,
    end,
    startIso: new Date(start).toISOString(),
    endIso: Number.isFinite(end) ? new Date(end).toISOString() : null,
    contains(iso) {
      const t = Date.parse(String(iso ?? ""));
      if (!Number.isFinite(t)) return false;
      return t >= start && t < end;
    },
  };
}

/**
 * The same window as PostgREST filter fragments, so a route's QUERY is bounded
 * by exactly what its in-memory filter will keep.
 *
 * The encoder is a PARAMETER, and it is named `pgTimestamp` on purpose. It has
 * to be injected - importing `runtime-config` here would drag `server-only`
 * into a module the browser rehydrate depends on - but a raw `+00:00` from the
 * database decodes to a space and 400s the read, which `sbSelect` then renders
 * as an empty table. So the name at the interpolation site says which encoder
 * is required, and the repo-wide check in pg-timestamp.test.ts can still see it.
 */
export function huntWindowFilter(
  column: string,
  w: HuntWindow,
  pgTimestamp: (v: string) => string
): string {
  const from = `&${column}=gte.${pgTimestamp(w.startIso)}`;
  return w.endIso ? `${from}&${column}=lt.${pgTimestamp(w.endIso)}` : from;
}

// ---- re-opening a hunt ON PURPOSE ------------------------------------------

/**
 * The epoch a DELIBERATELY re-opened hunt should carry.
 *
 * THE BUG THIS KILLS. `/api/deals/restore` stamped the payload with the
 * ORIGINAL hunt's start; the Trips page wrote that to `wd_search`; and the
 * Find-deals screen refuses any blob whose epoch is past the TTL - so it
 * deleted the payload on arrival and landed on a blank search screen. Every
 * hunt in the "Earlier hunts" drawer is past that cliff BY CONSTRUCTION
 * (`partitionHunts` archives on the same TTL), so "Re-open this hunt" worked
 * only for hunts that did not need re-opening.
 *
 * WHAT THE TTL IS ACTUALLY PROTECTING, AND HOW THIS KEEPS IT. The danger was
 * never the age of the hunt - it was the ancient epoch silently becoming the
 * `since=` of every live poll, which dragged a week of old traces onto the
 * board. So a deliberate re-open gets a FRESH epoch: the polls start from the
 * moment the traveller asked, and everything the hunt already produced arrives
 * in the restore payload itself (shops, stages, offers) rather than by
 * re-hydrating a week of history through /api/activity.
 *
 * A hunt still inside the TTL keeps its real start, because there the two are
 * the same question and nothing is gained by moving it.
 */
export function reopenEpoch(
  huntStartMs: number,
  nowMs: number,
  ttlMs: number = SEARCH_SESSION_TTL_MS
): number {
  return isSessionFresh(huntStartMs, nowMs, ttlMs) ? huntStartMs : nowMs;
}

/**
 * WHO closed a hunt (audit F146).
 *
 * Three writers stamp the SAME `kind: "session-closed"` marker row and are told
 * apart only by `raw.reason`: session-close.ts writes `user` for the
 * traveller's own "Clear search" and `ttl-expired` for the quiet stand-down
 * agent-loop fires when a shop answers past the TTL, and close-deal writes
 * `deal-closed` when a booking locks. Every reader filtered on `kind` alone, so
 * a shop replying four hours late told the traveller they had cleared a hunt
 * they never touched - and permanently withdrew Re-open with it.
 */
export type SessionClosedBy = "user" | "expired" | "deal";

/**
 * The marker's reason as a verdict. Anything unrecognised - including the rows
 * written before the reason existed - is the traveller's own clear, so the
 * strict refusal stays the default and no unlabelled row can unlock Re-open.
 */
export function closedByOf(reason: string | null | undefined): SessionClosedBy {
  if (reason === "ttl-expired") return "expired";
  if (reason === "deal-closed") return "deal";
  return "user";
}
