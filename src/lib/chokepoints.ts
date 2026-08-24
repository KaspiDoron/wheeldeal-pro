// THE FOUR THINGS THAT BREAK FIRST (Wave 7).
//
// `SCALING.md` names, in order, the ceilings this deployment hits as it grows.
// Three of them were measurable already and none of them had an ALARM - the
// numbers existed on some panel with no threshold attached, so the owner had
// to know the ceiling by heart to notice they were near it:
//
//   1. Evolution host occupancy. One host holds ~40 paired users. The failure
//      mode is not a queue, it is a banned personal WhatsApp number, and that
//      is not reversible by adding a host afterwards. The pool panel showed a
//      raw user count with nothing to compare it to.
//   2. The drain heartbeat. Nothing sends a queued message unless something
//      pings; the age of the last ping is the only number that says the
//      machinery is alive. It was rendered, but only as beating/stale/never -
//      the alarm belongs to the OWNER, not to a log.
//   3. Database round-trip latency. Every read and write in this app is an
//      HTTPS call to PostgREST, whose `authenticator` pool defaults to 10;
//      exhaustion does NOT fail fast, it QUEUES and then 504s. So the first
//      visible symptom of the database ceiling is latency creeping, which
//      nothing plotted.
//   4. The three event kinds `PRODUCTION-READINESS.md` says should page
//      someone. They are written faithfully and read by nobody.
//
// Pure functions, so the thresholds are testable without a database and a tile
// that says "fine" has to have earned it.

/** A host at or above this share of its cap is in the red. */
export const HOST_OCCUPANCY_ALARM = 0.8;
/** A drain that has not pinged in this long has stopped, not slowed. */
export const DRAIN_ALARM_MS = 10 * 60_000;
/** Above this, every Supabase read is dragging the request behind it. */
export const DB_LATENCY_WARN_MS = 400;
export const DB_LATENCY_ALARM_MS = 1_500;

export type ChokeState = "ok" | "warn" | "alarm" | "unknown";

export interface HostOccupancy {
  state: ChokeState;
  /** Paired users across the pool. */
  users: number;
  /** hosts x cap. */
  capacity: number;
  /** 0-100, rounded. Null when there is no pool to divide by. */
  pct: number | null;
  /** Hosts individually at/over the alarm share - the ones to act on. */
  hot: { url: string; users: number; pct: number }[];
  detail: string;
}

/**
 * How full the WhatsApp host pool is.
 *
 * FLEET AVERAGE IS NOT THE MEASURE. Users stick to the host they paired on, so
 * a pool that is 50% full on average can still have one host at 39/40 - and it
 * is the individual host that bans, not the average. The state is therefore
 * the worst single host, and `hot` names it.
 */
export function hostOccupancy(
  hosts: { url: string; users: number }[],
  cap: number
): HostOccupancy {
  const users = hosts.reduce((s, h) => s + h.users, 0);
  const capacity = hosts.length * cap;
  if (hosts.length === 0 || cap <= 0) {
    return {
      state: "unknown",
      users,
      capacity: 0,
      pct: null,
      hot: [],
      detail:
        "No Evolution host is configured, so no traveller can link WhatsApp at all. Paste one url|key per line into EVOLUTION_HOSTS.",
    };
  }
  const withPct = hosts.map((h) => ({ ...h, pct: Math.round((h.users / cap) * 100) }));
  const hot = withPct
    .filter((h) => h.users >= cap * HOST_OCCUPANCY_ALARM)
    .sort((a, b) => b.users - a.users);
  const full = withPct.filter((h) => h.users >= cap);
  const state: ChokeState = full.length > 0 ? "alarm" : hot.length > 0 ? "alarm" : "ok";
  return {
    state,
    users,
    capacity,
    pct: Math.round((users / capacity) * 100),
    hot: hot.map((h) => ({ url: h.url, users: h.users, pct: h.pct })),
    detail:
      full.length > 0
        ? `${full.length} host(s) are AT the ${cap}-user cap. A new traveller has nowhere safe to link - add a host now.`
        : hot.length > 0
          ? `${hot.length} host(s) past ${Math.round(HOST_OCCUPANCY_ALARM * 100)}% of the ${cap}-user cap. Add a host BEFORE the invites land, not after: the failure mode here is a banned number, not a queue.`
          : `${users}/${capacity} paired users across ${hosts.length} host(s), cap ${cap} each.`,
  };
}

export interface InviteHeadroom {
  state: ChokeState;
  /** Testers on the beta allowlist right now (the owner is not counted). */
  invited: number;
  /** hosts x per-host cap - how many numbers the fleet can actually hold. */
  capacity: number;
  /** Invites that could still be sent before the fleet is the binding wall. */
  headroom: number;
  detail: string;
}

/**
 * CAN I INVITE MORE TESTERS? - the arithmetic the owner was doing by hand.
 *
 * Two independent ceilings decide this and they were on different screens:
 * the invite list has its own cap (`BETA_ALLOWLIST_MAX`), and the Evolution
 * fleet holds `hosts x maxPerHost` linked numbers. An invite past the SECOND
 * one is not refused at the door - the tester signs in perfectly happily and
 * then cannot link WhatsApp, which is the confusing half of the failure.
 *
 * Not every invited tester links a number, so this deliberately compares
 * INVITES against capacity rather than paired sessions: it is the pessimistic
 * reading, and the pessimistic reading is the one worth alarming on when the
 * downside is a tester who cannot use the product.
 */
export function inviteHeadroom(
  invited: number,
  hostCount: number,
  cap: number,
  listMax: number
): InviteHeadroom {
  const capacity = Math.max(0, hostCount) * Math.max(0, cap);
  const headroom = capacity - invited;
  if (hostCount <= 0 || cap <= 0) {
    return {
      state: "unknown",
      invited,
      capacity: 0,
      headroom: 0,
      detail: `${invited} tester(s) invited and NO Evolution host is configured, so none of them can link WhatsApp. Add a host before the next invite.`,
    };
  }
  // ALARM means someone ALREADY cannot link - not merely "no slack left".
  // Exactly-full is a warning: every invited tester still has a socket, and
  // calling that red trains the owner to ignore the tile that is red when a
  // tester genuinely cannot use the product.
  const state: ChokeState = headroom < 0 ? "alarm" : headroom <= cap ? "warn" : "ok";
  const listNote =
    invited >= listMax ? ` The invite list is also at its own ${listMax} ceiling.` : "";
  return {
    state,
    invited,
    capacity,
    headroom,
    detail:
      headroom < 0
        ? `${invited} testers invited against a fleet that holds ${capacity}. ${-headroom} of them can sign in and then FAIL to link WhatsApp. Add hosts or shrink the list.${listNote}`
        : headroom === 0
          ? `Exactly full: ${invited} invited, ${capacity} linkable. Every current tester has a socket and the next invite does not. Stand up the next lane before it goes out.${listNote}`
          : headroom <= cap
            ? `Room for ${headroom} more tester(s) before the fleet is full - less than one host's worth. Stand up the next lane now, not after the invites go out.${listNote}`
            : `Room for ${headroom} more tester(s): ${hostCount} host(s) x ${cap} = ${capacity} linkable numbers, ${invited} invited.${listNote}`,
  };
}

export interface DrainAlarm {
  state: ChokeState;
  ageMs: number | null;
  detail: string;
}

/**
 * Has anything drained the queue recently?
 *
 * `pulse()` in lib/ops/vitals already classifies this for the health tile; the
 * alarm is stated separately because "stale" and "never" are both RED to an
 * owner but only one of them means the schedule was never created.
 */
export function drainAlarm(lastPingAt: string | null | undefined, now: number): DrainAlarm {
  const at = lastPingAt ? Date.parse(lastPingAt) : NaN;
  if (!Number.isFinite(at)) {
    return {
      state: "alarm",
      ageMs: null,
      detail:
        "Nothing has EVER pinged the drain. Queued introductions and timed replies only move while somebody has the app open. Create the Cloud Scheduler job (see SCALING.md, step 5).",
    };
  }
  const ageMs = Math.max(0, now - at);
  if (ageMs > DRAIN_ALARM_MS) {
    return {
      state: "alarm",
      ageMs,
      detail: `The drain last ran ${Math.round(ageMs / 60_000)} minutes ago. It exists and has stopped - check the scheduler job's recent runs and the ping token.`,
    };
  }
  if (ageMs > DRAIN_ALARM_MS / 2) {
    return {
      state: "warn",
      ageMs,
      detail: `Last ping ${Math.round(ageMs / 60_000)} minutes ago - slower than the 1-5 minute cadence, but not yet stopped.`,
    };
  }
  return { state: "ok", ageMs, detail: `Last ping ${Math.round(ageMs / 60_000)} minute(s) ago.` };
}

export interface LatencyReading {
  state: ChokeState;
  ms: number | null;
  detail: string;
}

/**
 * Database round-trip, classified.
 *
 * The PostgREST `authenticator` pool (default 10 connections) does not refuse
 * an eleventh caller - it makes it WAIT, and only 504s after the acquisition
 * timeout. So a pool running out looks like slowness long before it looks like
 * an error, and a latency number with no threshold attached is a number nobody
 * reads.
 */
export function dbLatency(ms: number | null): LatencyReading {
  if (ms === null) {
    return { state: "unknown", ms: null, detail: "The database did not answer the probe at all." };
  }
  if (ms >= DB_LATENCY_ALARM_MS) {
    return {
      state: "alarm",
      ms,
      detail: `${ms}ms for one row. The PostgREST connection pool is queueing requests - upgrade Supabase compute (SCALING.md, step 3) before it starts returning 504s.`,
    };
  }
  if (ms >= DB_LATENCY_WARN_MS) {
    return {
      state: "warn",
      ms,
      detail: `${ms}ms for one row - slower than healthy. Watch it; if it keeps climbing under load, the pool is the reason.`,
    };
  }
  return { state: "ok", ms, detail: `${ms}ms for one row.` };
}

/** The kinds PRODUCTION-READINESS.md says should page someone, and the one that is a daily digest. */
export const PAGING_KINDS = ["wa-send-dropped", "wa-ban-risk"] as const;
export const DIGEST_KINDS = ["media-fetch-failed"] as const;
export const WATCHED_KINDS = [...PAGING_KINDS, ...DIGEST_KINDS] as const;
export type WatchedKind = (typeof WATCHED_KINDS)[number];

export interface WatchedEvent {
  kind: WatchedKind;
  /** Null means UNREADABLE, never zero - an absent sensor is not good news. */
  count24h: number | null;
  /** Age of the most recent one, ms. Null when there is none (or it is unreadable). */
  newestAgeMs: number | null;
  paging: boolean;
}

export interface PagerDigest {
  state: ChokeState;
  events: WatchedEvent[];
  /** One line, ready to be an email subject. */
  headline: string;
}

/**
 * THE THREE KINDS NOBODY READS.
 *
 * `PRODUCTION-READINESS.md` P1 #3 lists them and says, correctly, that a
 * hand-written SQL query is currently the only way anyone finds out. Wiring an
 * external error tracker is a dependency and a bill; counting the rows that
 * already exist is neither, and it turns "page someone" from a runbook
 * sentence into a red number with an age next to it.
 */
export function pagerDigest(
  rows: { kind: string; count: number | null; newestAt: string | null }[],
  now: number
): PagerDigest {
  const events: WatchedEvent[] = WATCHED_KINDS.map((kind) => {
    const row = rows.find((r) => r.kind === kind);
    const at = row?.newestAt ? Date.parse(row.newestAt) : NaN;
    return {
      kind,
      count24h: row ? row.count : null,
      newestAgeMs: Number.isFinite(at) ? Math.max(0, now - at) : null,
      paging: (PAGING_KINDS as readonly string[]).includes(kind),
    };
  });
  const unreadable = events.filter((e) => e.count24h === null);
  const firing = events.filter((e) => e.paging && (e.count24h ?? 0) > 0);
  const digesting = events.filter((e) => !e.paging && (e.count24h ?? 0) > 0);
  const state: ChokeState =
    firing.length > 0 ? "alarm" : unreadable.length > 0 ? "unknown" : digesting.length > 0 ? "warn" : "ok";
  return {
    state,
    events,
    headline:
      firing.length > 0
        ? `${firing.map((e) => `${e.count24h}x ${e.kind}`).join(", ")} in the last 24h - these are the kinds that should page someone.`
        : unreadable.length > 0
          ? `${unreadable.length} of ${events.length} counters could not be read - that is unknown, not zero.`
          : digesting.length > 0
            ? `${digesting.map((e) => `${e.count24h}x ${e.kind}`).join(", ")} in the last 24h - daily-digest level, not urgent.`
            : "No dropped sends, no ban-risk warnings and no failed media fetches in the last 24h.",
  };
}

/** The worst state among the four, for the panel's headline chip. */
export function worstState(states: ChokeState[]): ChokeState {
  if (states.includes("alarm")) return "alarm";
  if (states.includes("unknown")) return "unknown";
  if (states.includes("warn")) return "warn";
  return "ok";
}
