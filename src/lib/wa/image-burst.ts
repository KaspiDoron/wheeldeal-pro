import "server-only";
import type { OrientationInfo } from "../media/orientation";
import { sbSelect } from "../runtime-config";
import { numberFilter } from "./phone-key";

// FIVE PHOTOS ARE ONE MESSAGE.
//
// A shop answering "what do you have?" sends an album: five frames, five
// webhooks, milliseconds apart. The worker pipeline coalesces them in a Redis
// window - and the worker is deployed nowhere, so in production every frame ran
// its own turn, each seeing ONE FIFTH of the price board and composing its own
// reply. The traveller watched the agent answer a five-photo album five times.
//
// This is the coalescer for the runtime that actually runs. No Redis, no
// worker: the frames are already stored in whatsapp_messages by the time the
// turn starts (ingest stores before it processes), so the database IS the
// buffer. The protocol:
//
//   NEWEST FRAME WINS. Every image turn asks "am I the newest frame of this
//   burst?" A frame with a newer sibling stands down - the sibling's own
//   invocation (which asked the same question later) owns the whole burst.
//   The newest frame can never stand down, so exactly the last arrival runs
//   the turn, with every frame of the burst attached.
//
//   DEFER ONCE, ON BURSTS ONLY. A multi-frame burst whose newest frame is
//   seconds old is very likely still landing (album frames arrive over a few
//   seconds, and webhooks can arrive out of order) - so the would-be
//   processor waits ONCE (~4s), re-asks, and either stands down (a straggler
//   arrived: its invocation owns the fuller burst) or proceeds with
//   everything that landed. A LONE photo never pays the wait: one extra
//   database read and straight on with the turn.
//
// Races lose gracefully: two frames that both believe they are newest each run
// a turn, and the stale-draft freshness gate drops the older reply at send
// time - the exact behaviour the drain already has for any superseded draft.

import { BURST_WINDOW_MS } from "../media/reading";

const DEFER_MS = 4_000;
const MAX_BURST_ROWS = 16;

/**
 * HOW FAR BACK THE *DISCOVERY* PROBE LOOKS - and it is not the burst window.
 *
 * The first probe's only job is to find OUR OWN ROW so the window can be
 * anchored on its `received_at`. It used to ask for `now - 6s`, which quietly
 * assumed the coalescer runs within the burst window of the row being stored -
 * and it does not: ingest inserts the row (ingest.ts, the inbound store) and
 * only then reaches the coalescer, with an AWAITED finishBeforeResponse between
 * them. Whenever that stretch exceeded six seconds the frame could not see its
 * own row, `burstAnchor` returned null, the window fell back to the sliding
 * `now - 6s` that had just failed, and a five-photo album ran as five separate
 * turns each holding one frame. That is exactly how a legible price menu
 * reaches the reader as one fifth of a board and comes back found=false.
 *
 * A wide lookback is safe here BECAUSE the probe decides nothing: it cannot
 * add a NEWER sibling (a newer row is newer whatever the lookback), and every
 * decision below - stand-down and assembly alike - is taken on the frozen
 * anchored window, never on this set.
 */
const DISCOVERY_LOOKBACK_MS = 180_000;

interface SiblingRow {
  id: number;
  wa_message_id: string | null;
  received_at: string;
  type: string;
  raw: {
    media?: { key?: unknown; kind?: string; mime?: string | null };
  } | null;
}

function isImageRow(r: SiblingRow): boolean {
  const m = r.raw?.media;
  if (!m) return false;
  if (m.kind === "image") return true;
  return Boolean(m.mime && /^image\//i.test(m.mime));
}

/**
 * THE WINDOW IS ANCHORED ON THE LEADER, NOT ON THE CLOCK.
 *
 * This used to compute `now - 6s` on every one of the three probes, which is a
 * SLIDING window - and between probe 1 and probe 3 the code does a media
 * download (with retries) and then sleeps 4s. By probe 3 the frame's OWN row
 * had usually fallen out of its own window: `newerSibling` then found no `own`
 * row and refused to stand down (correct - never stand down blind), and the
 * assembly loop below iterated a `rows` array that no longer contained the
 * frame itself OR any of its siblings. A five-photo album assembled zero
 * frames and the reader was handed nothing.
 *
 * The burst is defined relative to the LEADER's arrival: every frame that
 * landed within BURST_WINDOW_MS BEFORE it, plus anything that lands after. That
 * set does not move while we wait, so however long the fetch and the defer take
 * the same rows keep answering. Falls back to the sliding window only when our
 * own row is not visible at all (a brand-new store, an un-ingested frame),
 * which is exactly the case where there is no anchor to use.
 */
export function burstWindowSince(anchorReceivedAt: string | null, nowMs: number): string {
  const at = anchorReceivedAt ? Date.parse(anchorReceivedAt) : NaN;
  const base = Number.isFinite(at) ? at : nowMs;
  return new Date(base - BURST_WINDOW_MS).toISOString();
}

/** The leader's own `received_at`, when its row is visible. */
export function burstAnchor(
  rows: Array<{ wa_message_id: string | null; received_at?: string }>,
  ownMsgId: string
): string | null {
  const own = rows.find((r) => r.wa_message_id === ownMsgId);
  return own?.received_at ?? null;
}

async function siblingFrames(
  email: string,
  fromDigits: string,
  sinceIso?: string
): Promise<SiblingRow[]> {
  const since = sinceIso ?? new Date(Date.now() - DISCOVERY_LOOKBACK_MS).toISOString();
  // NEWEST-FIRST AT THE DATABASE, arrival order in memory. `id.asc` + LIMIT
  // truncates to the OLDEST rows in range, which is harmless over a six-second
  // window and actively wrong over the discovery lookback - it could drop our
  // own row, the one thing the probe exists to find. Asking desc and reversing
  // keeps the truncation on the far end, where it belongs.
  const rows = await sbSelect<SiblingRow>(
    "whatsapp_messages",
    `select=id,wa_message_id,received_at,type,raw&direction=eq.inbound` +
      `&raw->>receiver=eq.${encodeURIComponent(email)}` +
      `&received_at=gte.${encodeURIComponent(since)}` +
      `&type=in.(image,document)` +
      `&order=id.desc&limit=${MAX_BURST_ROWS}${numberFilter("from_number", fromDigits)}`
  ).catch(() => [] as SiblingRow[]);
  // Arrival order is restored HERE rather than assumed from the driver: every
  // caller below reads this list as the burst in the order it landed.
  return rows.filter(isImageRow).sort((a, b) => a.id - b.id);
}

/** Rows at or after the frozen window start - the burst, as of this probe. */
function withinWindow(rows: SiblingRow[], sinceIso: string): SiblingRow[] {
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since)) return rows;
  return rows.filter((r) => {
    const at = Date.parse(String(r.received_at ?? ""));
    return !Number.isFinite(at) || at >= since;
  });
}

/** Is there a frame NEWER than ours? Pure, so the protocol is unit-testable. */
export function newerSibling(
  rows: Array<{ id: number; wa_message_id: string | null; received_at?: string }>,
  ownMsgId: string
): { id: number; wa_message_id: string | null } | null {
  const own = rows.find((r) => r.wa_message_id === ownMsgId);
  if (!own) return null; // our row is not visible - never stand down blind
  const newest = rows[rows.length - 1];
  if (!newest || newest.id <= own.id) return null;
  // BOUNDED, OR THE CHAIN ORPHANS FRAMES. The leader reads only frames within
  // BURST_WINDOW_MS of ITS anchor, and the follower stamp is capped at the
  // same window - so standing down to a sibling further away than that hands
  // this frame to a turn that will never read it and a stamp that may never
  // cover it: a photo nobody looks at and nobody explains. Beyond the window
  // this frame runs its own turn instead.
  const ownAt = Date.parse(String(own.received_at ?? ""));
  const newestAt = Date.parse(String(newest.received_at ?? ""));
  if (Number.isFinite(ownAt) && Number.isFinite(newestAt) && newestAt - ownAt > BURST_WINDOW_MS) {
    return null;
  }
  return newest;
}

export type BurstVerdict =
  | { standDown: true; leaderId: string }
  | {
      standDown: false;
      /** Every burst frame in arrival order, own frame included. */
      frames: Array<{
        mime: string;
        base64: string;
        waMessageId: string;
        orientation?: OrientationInfo;
      }>;
      /** Sibling frames whose bytes could not be fetched (traced by caller). */
      fetchFailures: number;
      /** How many frames the burst held in total (before any fetch failure). */
      burstSize: number;
      /** True when this frame's own bytes could not be fetched. */
      ownFetchFailed: boolean;
    };

/**
 * Assemble the burst this frame belongs to, or stand down to a newer sibling.
 *
 * Injection points (`fetchOwn`/`fetchByKey`/`sleep`) exist so the protocol is
 * testable without Evolution or a database in the loop.
 */
export async function assembleImageBurst(opts: {
  email: string;
  fromDigits: string;
  ownMsgId: string;
  fetchOwn: () => Promise<{ mime: string; base64: string } | null>;
  fetchByKey: (key: unknown) => Promise<{ mime: string; base64: string } | null>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BurstVerdict> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // 1) DISCOVERY. This probe answers one question - when did OUR row land? -
  //    and it looks far enough back that a slow ingest cannot hide it (see
  //    DISCOVERY_LOOKBACK_MS: the frame missing its own row is how an album
  //    became five one-frame turns).
  const discovered = await siblingFrames(opts.email, opts.fromDigits);
  // FREEZE THE WINDOW on our own arrival. Every later probe asks the same
  // question of the same set, so the seconds spent fetching and deferring can
  // never shrink the burst out from under us (including our own row).
  const since = burstWindowSince(burstAnchor(discovered, opts.ownMsgId), Date.now());
  // The burst is the anchored window, NEVER the discovery set: a photo this
  // shop sent two minutes ago is not a frame of this album, and standing down
  // to it would drop the frame we are holding out of the read entirely.
  let rows = withinWindow(discovered, since);
  const newer0 = newerSibling(rows, opts.ownMsgId);
  if (newer0) return { standDown: true, leaderId: newer0.wa_message_id ?? String(newer0.id) };

  // 2) Fetch our own bytes (the slow part - the album may still be uploading).
  const own = await opts.fetchOwn();

  // 3) Re-ask. A lone photo pays exactly this one extra read and moves on.
  //    (Anything that arrived during the fetch is NEWER than us - store ids
  //    are monotonic - so growth always resolves to a stand-down here.)
  rows = await siblingFrames(opts.email, opts.fromDigits, since);
  const newer1 = newerSibling(rows, opts.ownMsgId);
  if (newer1) return { standDown: true, leaderId: newer1.wa_message_id ?? String(newer1.id) };

  // 4) We hold the newest frame of a MULTI-frame burst: a straggler may still
  //    be in flight (out-of-order webhooks). Wait once, re-ask, and hand over
  //    to any frame that landed meanwhile - otherwise this is the whole burst.
  if (rows.length >= 2) {
    await sleep(DEFER_MS);
    rows = await siblingFrames(opts.email, opts.fromDigits, since);
    const newer2 = newerSibling(rows, opts.ownMsgId);
    if (newer2) return { standDown: true, leaderId: newer2.wa_message_id ?? String(newer2.id) };
  }

  // 5) We are the newest frame: assemble every sibling's bytes, arrival order.
  //
  // BELT AND BRACES ON OUR OWN FRAME. The anchored window above means our row
  // can no longer age out of the probe, but the probe can also return [] for a
  // reason that has nothing to do with time (a read error - `siblingFrames`
  // swallows those). Bytes we already hold must never be thrown away because a
  // LISTING failed, so `own` is pushed unconditionally when the loop did not
  // find our row.
  // orientation rides along: the spreads below already carried the value,
  // only the TYPE dropped it, which is why it silently never reached vision.
  const frames: Array<{
    mime: string;
    base64: string;
    waMessageId: string;
    orientation?: OrientationInfo;
  }> = [];
  let fetchFailures = 0;
  let sawOwn = false;
  for (const r of rows) {
    const msgId = r.wa_message_id ?? String(r.id);
    if (msgId === opts.ownMsgId) {
      sawOwn = true;
      if (own) frames.push({ ...own, waMessageId: msgId });
      continue;
    }
    const key = r.raw?.media?.key;
    if (!key) {
      fetchFailures++;
      continue;
    }
    const media = await opts.fetchByKey(key).catch(() => null);
    if (media) frames.push({ ...media, waMessageId: msgId });
    else fetchFailures++;
  }
  if (!sawOwn && own) frames.unshift({ ...own, waMessageId: opts.ownMsgId });
  return {
    standDown: false,
    frames,
    fetchFailures,
    burstSize: Math.max(rows.length, frames.length, 1),
    ownFetchFailed: !own,
  };
}
