import "server-only";
import { createHash } from "crypto";
import { sbDelete, sbInsert, sbInsertClaim, sbSelectStrict } from "../runtime-config";
import { digitsOnly } from "../phone";

/**
 * ALARM ON THE SILENT DEGRADATION (W-beta30).
 *
 * A missing `wa_send_claims` table makes every claim below answer "ok", which
 * is the right call for a pre-migration install (sends must not brick) and the
 * WRONG thing to do quietly: with the table absent there is no message
 * idempotency, no per-recipient mutex, and no gap or fleet slot - the atomic
 * half of the anti-ban layer is simply not running, on personal phone numbers.
 * One throttled event per hour per instance puts it on the admin surface.
 *
 * TOTALLY INERT ON FAILURE. This is telemetry on the send path: the whole body
 * is wrapped, not just the promise, because a throw from the write (a store
 * outage, an unavailable client) would otherwise propagate out of
 * claimSendSlots and turn "we cannot report a degradation" into "we cannot
 * send" - the alarm taking down the thing it watches.
 */
let lastClaimsMissingAt = 0;
function noteClaimsTableMissing(): void {
  const now = Date.now();
  if (now - lastClaimsMissingAt < 3600_000) return;
  lastClaimsMissingAt = now;
  try {
    void sbInsert("agent_events", [
      {
        kind: "claims-table-missing",
        detail: JSON.stringify({
          note:
            "wa_send_claims is absent: message idempotency, the recipient mutex and " +
            "the gap/fleet pacing slots are ALL inert. Run supabase/schema.sql.",
          at: new Date(now).toISOString(),
        }),
      },
    ])?.catch?.(() => {});
  } catch {
    // Reporting the degradation must never become a second degradation.
  }
}

// Pacing primitives for the anti-ban engine.
//
// Two problems live here:
//  1. THUNDERING HERD - cap holds used to stamp a flat now+offset on every
//     held message, so a whole batch released at the same instant (the
//     "ten messages all at ~15:27" screenshot). jitteredHold() spreads them.
//  2. CONCURRENCY - serverless has no locks; concurrent drain callers all
//     read the same pacing state and pass together. claimSendSlots() makes
//     the send decision atomic via wa_send_claims primary-key conflicts.

/**
 * A [0,1] value drawn from a TRUNCATED GAUSSIAN (bell curve) instead of a flat
 * uniform. Human inter-message timing clusters around a typical gap and tapers
 * at the extremes; uniform jitter is flat (45s and 75s equally likely), which
 * is itself a faint machine signature. Feeding this as the `rand` argument to
 * the stagger functions below reshapes the SAME 45-75s band into a bell centered
 * near the middle - most gaps land around the mean, a few stretch to the edges -
 * without changing any bound (the output is always clamped to [0,1], so
 * `45 + rand()*30` stays exactly within 45-75s). Box-Muller; drop-in for
 * Math.random.
 */
export function gaussianUnit(
  mean = 0.5,
  sd = 0.22,
  rand: () => number = Math.random
): number {
  // Box-Muller needs u1 in (0,1]; guard the log against 0.
  const u1 = 1 - rand();
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const v = mean + z * sd;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A hold timestamp with a per-row random spread - never a shared instant. */
export function jitteredHold(
  nowMs: number,
  baseMinutes: number,
  spreadMinutes: number,
  rand: () => number = Math.random
): string {
  return new Date(nowMs + (baseMinutes + rand() * spreadMinutes) * 60_000).toISOString();
}

/**
 * WHEN A PAUSED NUMBER'S MESSAGE SHOULD LOOK AGAIN.
 *
 * Nothing goes out while `paused_until` stands - that part is not a choice,
 * the pause is account-level and the recovery schedule IS the treatment. This
 * decides only the WAKE-UP, and the two lanes want opposite answers:
 *
 *  - COLD INTRODUCTIONS are the vector under treatment. They keep the full
 *    horizon and wake when the pause actually ends.
 *  - REPLIES are reciprocal traffic, the safe side of the ban axis, and a
 *    collapsing reply ratio is itself the signal that gets numbers restricted.
 *    A reply stamped for the original 4h wall sat parked long after the risk
 *    engine had cleared the pause early, so replies re-check on a bounded
 *    schedule instead of sleeping through it.
 *
 * EXTRACTED FROM `guardOutbound` DELIBERATELY. It was an inline ternary inside
 * a function that needs Supabase, WhatsApp and a policy store to reach, so the
 * only test on it was a regex over the source - and a regex cannot notice that
 * the condition is inverted. Inverting it (cold intros re-checking, replies
 * sleeping four hours) passed the entire 5,700-test suite. It is a pure
 * function now, and the lanes are asserted by running it.
 */
export function pauseRecheckAt(opts: {
  nowMs: number;
  pausedUntilIso: string;
  isNewContact: boolean;
  rand?: () => number;
}): string {
  const { nowMs, pausedUntilIso, isNewContact } = opts;
  const rand = opts.rand ?? Math.random;
  if (isNewContact) return pausedUntilIso; // the lane under treatment: full horizon
  const pauseLeftMs = Date.parse(pausedUntilIso) - nowMs;
  // A pause longer than four hours is a BAN RECOVERY, not a risk pause. Both
  // re-check; the recovery's interval scales with what is left, bounded so it
  // can never become a disguised four-hour sleep.
  const banRecovery = pauseLeftMs > 4 * 3600_000;
  const replyRecheck = Math.min(45, Math.max(20, Math.round(pauseLeftMs / 60_000 / 8)));
  return banRecovery
    ? jitteredHold(nowMs, replyRecheck, 10, rand)
    : jitteredHold(nowMs, 10, 5, rand);
}

// `staggerOffsets` lived here: a 45-75s cumulative trickle, exported, tested,
// re-exported from @wheeldeal/core - and called by nothing. `batchStagger`
// below is what both dispatch paths actually use, and it schedules to a
// DEADLINE rather than accumulating a fixed step. The dead one was worse than
// unused: reading the Ko Tao timeline, a 45-75s stagger was the obvious
// suspect for the delay, and it cost real time to establish that the code
// could not have run. Unreachable code that looks like an explanation is a
// liability, not a spare part.
//
// `cappedStaggerOffsets` lived here too. It built a batch schedule bottom-up from a
// per-message gap and an hourly cap and accepted whatever total fell out, which
// is how a batch of eight shops came to span three hours. `batchStagger` below
// replaces it on BOTH dispatch paths (the mass route and the outreach worker) -
// deleted rather than left alongside, because two schedulers is how one call
// site keeps the old behaviour.

/**
 * THE HARD SAFETY FLOOR. No batch deadline may ever push two cold sends closer
 * together than this - it is the one number the compression below is not
 * allowed to trade away. Everything else about the schedule is negotiable.
 */
export const HARD_MIN_GAP_SEC = 8;

/**
 * How close two of OUR messages may land on one shop, whichever lane sent them.
 *
 * The same number as the cold-batch floor, and for the same reason: it is the
 * shortest interval that still reads as two separate messages from a person
 * rather than one automated burst. Lanes pace themselves; this paces the shop's
 * inbox. See the recipient mutex in claimSendSlots.
 */
export const RECIPIENT_LOCK_SEC = HARD_MIN_GAP_SEC;

/** The mutex key. Keyed on the RECIPIENT only - no lane, no gap size. */
export function recipientSlot(toDigits: string, bucket: number): string {
  return `to:${digitsOnly(toDigits)}:${bucket}`;
}

export interface BatchSchedule {
  /** ms after batch start for each item, in order. */
  offsets: number[];
  /** The gap actually used, after fitting to the window. */
  gapSecUsed: number;
  /** True when the requested gap had to be compressed to keep the promise. */
  compressed: boolean;
  /**
   * Items that could not fit inside the window because they exceed the
   * sender's hourly capacity - they are scheduled honestly into later hours,
   * and the caller is expected to SAY so rather than let them look normal.
   */
  overflow: number;
}

/**
 * SCHEDULE A BATCH TO A DEADLINE, not to a per-message gap.
 *
 * The old `cappedStaggerOffsets` built the schedule bottom-up: take the policy
 * min-gap, add jitter, jump an hour whenever the hourly cap was reached, and
 * accept whatever total came out. That is how a batch of 8 ended up spanning
 * three hours - every input was individually defensible and nothing was
 * responsible for the whole.
 *
 * This starts from the promise (lib/wa/capacity BATCH_WINDOW_MINUTES) and works
 * back to a gap, with two things it will not do:
 *
 *   - It never goes below HARD_MIN_GAP_SEC. Ban safety is not negotiable, so a
 *     batch that cannot fit at the floor overflows honestly instead.
 *   - It never goes ABOVE the requested gap. A deliberately slow policy stays
 *     slow for a small batch; compression only ever kicks in when the batch
 *     would otherwise break the promise.
 *
 * Items beyond `hourCap` cannot go inside the window by definition - the hourly
 * ceiling is a real limit - so they are placed in later hour groups and counted
 * in `overflow`. In practice this is unreachable for a within-budget batch,
 * because every plan's hourCap is >= its conversation budget.
 */
export function batchStagger(opts: {
  count: number;
  hourCap: number;
  /** The gap the anti-ban policy asks for (p.min_gap_seconds). */
  gapSec: number;
  /** The batch promise, in ms. */
  windowMs: number;
  rand?: () => number;
}): BatchSchedule {
  const rand = opts.rand ?? Math.random;
  const count = Math.max(0, Math.floor(opts.count));
  const cap = Math.max(1, Math.floor(opts.hourCap));
  const requested = Math.max(HARD_MIN_GAP_SEC, opts.gapSec);
  // How many items must fit inside the window: the first hour-group, capped by
  // the batch itself. Item 0 is immediate, so the gaps number one fewer.
  const inWindow = Math.min(count, cap);
  const gaps = Math.max(1, inWindow - 1);
  // Leave room for jitter: a gap can stretch to 1.25x, so size the base gap so
  // that even the slowest roll lands inside the window.
  const fitSec = opts.windowMs / 1000 / (gaps * 1.25);
  const gapSecUsed = Math.max(HARD_MIN_GAP_SEC, Math.min(requested, fitSec));

  const offsets: number[] = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const hour = Math.floor(i / cap);
    const within = i % cap;
    if (within === 0) {
      // A new hour group starts a min-gap PAST the 3600s boundary, so the
      // previous group's oldest send has aged out of the drain's inclusive
      // rolling-hour window before this item is due.
      acc = hour === 0 ? 0 : hour * 3600_000 + Math.round((gapSecUsed + 30) * 1000);
    } else {
      acc += Math.round((gapSecUsed + rand() * gapSecUsed * 0.25) * 1000);
    }
    offsets.push(acc);
  }
  return {
    offsets,
    gapSecUsed,
    compressed: gapSecUsed < requested,
    overflow: Math.max(0, count - cap),
  };
}

/** The min-gap bucket a timestamp falls into (bucket size = the HARD floor). */
export function gapBucket(nowMs: number, gapSeconds: number): number {
  const size = Math.max(1, gapSeconds) * 1000;
  return Math.floor(nowMs / size);
}

/** Stable short hash of a message body for idempotency slot keys. */
export function messageSlotKey(toDigits: string, text: string): string {
  const norm = text.replace(/\s+/g, " ").trim().toLowerCase();
  return `msg:${digitsOnly(toDigits)}:${createHash("sha256")
    .update(norm)
    .digest("hex")
    .slice(0, 16)}`;
}

export type ClaimOutcome =
  | { ok: true }
  /**
   * `recipient-busy` is the human-send answer to the mutex: something else is
   * mid-send to this exact shop right now. It is NOT a pacing hold to retry
   * quietly - the traveller is standing there with their thumb on the button,
   * so the caller tells them their agent is already talking to this shop.
   *
   * `retryAtMs` (pacing/recipient refusals only): when the lane that refused
   * FREES - the next bucket edge, or the straddle window's end. The lanes a
   * reply loses are measured in seconds, and the flat re-park penalty for
   * losing one was the dominant latency in the whole system; a caller that
   * can afford to WAIT to this instant and re-claim skips the re-park, the
   * outbox round-trip and the next drain's whole pipeline.
   */
  | {
      ok: false;
      kind: "pacing" | "duplicate" | "error" | "recipient-busy";
      retryAtMs?: number;
    };

/**
 * Atomically claim the right to SEND now.
 *
 * - "msg" slot: one delivery per unique (recipient, body) - two concurrent
 *   invocations carrying the same message cannot both send. Claimed BEFORE
 *   the network send (the old dedup row was written after, so concurrent
 *   duplicates both passed).
 * - "gap" slot (auto sends only): one send per min-gap bucket per sender -
 *   serializes the 5+ concurrent drain callers. Straddle-proof: winning the
 *   current bucket also requires the PREVIOUS bucket to be free or older
 *   than the gap, so two sends can never land min-gap-epsilon apart across
 *   a bucket boundary.
 *   - perRecipient (REPLIES to already-engaged shops): the gap slot is keyed
 *     by (sender, RECIPIENT, bucket) instead of (sender, bucket). Distinct
 *     engaged shops no longer serialize through ONE per-sender window - 40
 *     live threads can each get their counter-reply promptly - while the SAME
 *     shop is still min-gap paced. Cold first-contact intros keep the strict
 *     per-sender lane (velocity to NEW numbers is the real ban vector).
 *
 * Fail CLOSED: an unknown claim state ("error") refuses the send - the
 * caller re-queues. A missing wa_send_claims table (schema not migrated)
 * degrades to "ok" - exactly today's behavior until the owner runs the DDL.
 */
export async function claimSendSlots(opts: {
  senderKey: string;
  toDigits: string;
  text: string;
  auto: boolean;
  gapSeconds: number;
  /** REPLY lane: key the pacing slot per-recipient so distinct engaged shops
   * do not serialize on one another (idempotency stays per-message). */
  perRecipient?: boolean;
  /** REPLY lane fleet ceiling: an ATOMIC per-sender cap on the TOTAL reply
   * velocity across all shops (a smaller gap than the per-recipient one). Keeps
   * the concurrency win without letting one number blast 40 sends in seconds. */
  fleetGapSeconds?: number;
  nowMs?: number;
}): Promise<ClaimOutcome> {
  const now = opts.nowMs ?? Date.now();

  // Idempotency first - it applies to every send, human or agent.
  const msgSlot = messageSlotKey(opts.toDigits, opts.text);
  const msg = await sbInsertClaim("wa_send_claims", {
    sender_key: opts.senderKey,
    slot_key: msgSlot,
  });
  if (msg === "lost") return { ok: false, kind: "duplicate" };
  if (msg === "error") {
    // Missing table = pre-migration: behave exactly as before the feature.
    const probe = await sbSelectStrict("wa_send_claims", "select=slot_key&limit=1");
    if ("error" in probe && probe.error === "missing") {
      // ...but SAY SO. This degradation silently disables every atomic pacing
      // guarantee in the system - the message-idempotency claim, the
      // per-recipient mutex, the gap and fleet slots - on an install that
      // simply never ran schema.sql. The sends still go out, so nothing else
      // looks wrong; the anti-ban layer is just gone. Throttled to one row an
      // hour per instance so a missing table cannot itself become a flood.
      void noteClaimsTableMissing();
      return { ok: true };
    }
    return { ok: false, kind: "error" };
  }

  // ---- THE RECIPIENT MUTEX: one lane-independent lock per shop --------------
  //
  // Ko Tao, 12:21. Two of our messages landed on one shop inside the same
  // minute: a cold introduction and an agent reply. Neither pacing lane was
  // broken - they simply do not intersect. A cold intro claims
  // `gap:12:<bucket>` with NO recipient in the key; a reply claims
  // `gap:5:<digits>:<bucket>`. Different strings, so both win, and the shop
  // gets two messages from a stranger at once.
  //
  // Every OTHER slot here is a pacing decision scoped to a lane. This one is
  // not a lane at all: it is the shop's own inbox, and the invariant is that
  // nothing we send lands on it twice inside the hard floor, whichever part of
  // the system decided to send. That is also why it has to exist BEFORE a
  // second dispatcher does - a reply-only drain running beside the global one
  // would otherwise recreate the same collision by design.
  //
  // AND IT APPLIES TO HUMAN SENDS TOO, which is the half that was missing.
  //
  // This block used to sit AFTER an early `if (!opts.auto) return {ok:true}`,
  // on the reasoning that a message the traveller typed is their decision and
  // has never been pacing-gated. That reasoning is right about PACING and wrong
  // about COLLISION: the traveller tapping Bargain while the agent is mid-send
  // is the same two-messages-in-one-minute the mutex exists to prevent, and it
  // is the likeliest version of it, because the app invites the tap at exactly
  // the moment a thread is active.
  //
  // So both lanes take the lock. What differs is what losing it MEANS: for the
  // agent it is pacing (re-queue, try again shortly); for a person standing
  // there with their thumb on the button it is news ("your agent is already
  // talking to this shop"), and the caller says so instead of silently queuing
  // a second message behind the first.
  const recipientBucket = gapBucket(now, RECIPIENT_LOCK_SEC);
  const recipientSlotFor = (b: number) => recipientSlot(opts.toDigits, b);
  const ownRecipientSlot = recipientSlotFor(recipientBucket);
  const mine = await sbInsertClaim("wa_send_claims", {
    sender_key: opts.senderKey,
    slot_key: recipientSlotFor(recipientBucket),
  });
  if (mine === "lost") {
    await releaseMessageClaim(opts.senderKey, opts.toDigits, opts.text);
    return {
      ok: false,
      kind: opts.auto ? "pacing" : "recipient-busy",
      retryAtMs: (recipientBucket + 1) * RECIPIENT_LOCK_SEC * 1000,
    };
  }
  if (mine === "error") {
    await releaseMessageClaim(opts.senderKey, opts.toDigits, opts.text);
    return { ok: false, kind: "error" };
  }
  // The same boundary straddle every other slot here guards: a bucket is a
  // window, not a spacing promise, and two sends either side of its edge are
  // milliseconds apart.
  // A READ, NOT A PROBE-WRITE. Claiming the previous bucket to find out whether
  // it was taken CREATED a row stamped now on every first attempt, and no
  // refusal path released it - so a later attempt read that row as "the last
  // send to this shop", and held a shop that had never been messaged for a full
  // 8s mutex on the strength of an attempt that sent nothing. The spacing was
  // measured from the first ATTEMPT instead of the last SEND, fleet-wide.
  {
    const row = await sbSelectStrict<{ created_at: string }>(
      "wa_send_claims",
      `select=created_at&sender_key=eq.${encodeURIComponent(
        opts.senderKey
      )}&slot_key=eq.${encodeURIComponent(recipientSlotFor(recipientBucket - 1))}&limit=1`
    );
    const prevAt = "rows" in row ? Date.parse(row.rows[0]?.created_at ?? "") : NaN;
    if (Number.isFinite(prevAt) && now - prevAt < RECIPIENT_LOCK_SEC * 1000) {
      await sbDelete(
        "wa_send_claims",
        `sender_key=eq.${encodeURIComponent(opts.senderKey)}&slot_key=eq.${encodeURIComponent(
          ownRecipientSlot
        )}`
      ).catch(() => {});
      await releaseMessageClaim(opts.senderKey, opts.toDigits, opts.text);
      return {
        ok: false,
        kind: opts.auto ? "pacing" : "recipient-busy",
        retryAtMs: prevAt + RECIPIENT_LOCK_SEC * 1000,
      };
    }
  }

  // A human send is now past the only gate that applies to it: the shop's own
  // inbox. Everything below is LANE PACING - anti-ban velocity budgets for
  // automated traffic - and a message the traveller typed has never been, and
  // is not now, subject to it.
  if (!opts.auto) return { ok: true };

  const bucket = gapBucket(now, opts.gapSeconds);
  // Reply lane -> the gap slot carries the recipient, so two DIFFERENT shops
  // never contend for the same bucket (only the same shop is serialized).
  const laneKey = opts.perRecipient ? `:${digitsOnly(opts.toDigits)}` : "";
  const slotFor = (b: number) => `gap:${opts.gapSeconds}${laneKey}:${b}`;
  const releaseOwn = async (slots: string[]) => {
    for (const s of slots) {
      await sbDelete(
        "wa_send_claims",
        `sender_key=eq.${encodeURIComponent(opts.senderKey)}&slot_key=eq.${encodeURIComponent(s)}`
      ).catch(() => {});
    }
  };

  const cur = await sbInsertClaim("wa_send_claims", {
    sender_key: opts.senderKey,
    slot_key: slotFor(bucket),
  });
  // When the winner of `slot` actually claimed it, or NaN if we cannot say.
  // A READ, never a write - see the straddle note below.
  const claimedAt = async (slot: string): Promise<number> => {
    const row = await sbSelectStrict<{ created_at: string }>(
      "wa_send_claims",
      `select=created_at&sender_key=eq.${encodeURIComponent(
        opts.senderKey
      )}&slot_key=eq.${encodeURIComponent(slot)}&limit=1`
    );
    return "rows" in row ? Date.parse(row.rows[0]?.created_at ?? "") : NaN;
  };
  if (cur === "lost") {
    await releaseOwn([msgSlot, ownRecipientSlot]); // let the queued retry re-claim it
    // THE INSTANT THIS LANE IS REALLY FREE, not the instant the bucket rolls.
    //
    // This returned the BUCKET EDGE while the straddle guard below refuses
    // anything inside `prevAt + gap` - and prevAt sits strictly INSIDE the
    // previous bucket, so the edge is always early by `prevAt mod gap`, up to a
    // full gap. The caller takes exactly ONE wait, so it slept to an instant
    // that was still refused, burned its whole allowance, and re-parked the row
    // for 20-40s. Wave 8's centrepiece was inert: executed on a 7-shop burst,
    // 1 reply reached the wire and 6 parked.
    const winner = await claimedAt(slotFor(bucket));
    const edge = (bucket + 1) * opts.gapSeconds * 1000;
    return {
      ok: false,
      kind: "pacing",
      retryAtMs: Number.isFinite(winner)
        ? Math.max(edge, winner + opts.gapSeconds * 1000)
        : edge,
    };
  }
  if (cur === "error") {
    await releaseOwn([msgSlot, ownRecipientSlot]);
    return { ok: false, kind: "error" };
  }

  // Boundary straddle check: if the PREVIOUS bucket was claimed less than a
  // full gap ago, this send would land too close to the previous one.
  // A READ, NOT A WRITE. This probed the previous bucket with sbInsertClaim,
  // so on a WIN it CREATED a row stamped now - and no refusal path released it.
  // The row then answered a later attempt's "when did the previous bucket
  // send?" with the time of an attempt that never sent anything, holding a shop
  // that had never been messaged for a full gap. Worse, the probe is written by
  // the FIRST attempt in each bucket, so the enforced spacing was measured from
  // the first ATTEMPT rather than the last SEND, on all three lanes.
  //
  // A select answers the same question and cannot corrupt the state it reads.
  const prevAt = await claimedAt(slotFor(bucket - 1));
  if (Number.isFinite(prevAt) && now - prevAt < opts.gapSeconds * 1000) {
    await releaseOwn([msgSlot, ownRecipientSlot, slotFor(bucket)]);
    return { ok: false, kind: "pacing", retryAtMs: prevAt + opts.gapSeconds * 1000 };
  }

  // REPLY-LANE FLEET CEILING: the per-recipient slot above lets distinct shops
  // send concurrently, which (without this) removed the ONLY atomic cap on total
  // reply velocity - one number could then emit dozens of sends in seconds (a
  // bulk-sender signature). This claims an ATOMIC per-sender slot at a smaller
  // gap, so the whole fleet still trickles (~1 reply per fleetGap) even as
  // distinct shops overlap. Lost -> pace this one out; distinct shops just take
  // turns through the fleet gap instead of all firing at once.
  if (opts.perRecipient && opts.fleetGapSeconds && opts.fleetGapSeconds > 0) {
    const fleetBucket = gapBucket(now, opts.fleetGapSeconds);
    const fleetSlotFor = (b: number) => `rfleet:${opts.fleetGapSeconds}:${b}`;
    const fleet = await sbInsertClaim("wa_send_claims", {
      sender_key: opts.senderKey,
      slot_key: fleetSlotFor(fleetBucket),
    });
    if (fleet === "lost") {
      await releaseOwn([msgSlot, ownRecipientSlot, slotFor(bucket)]);
      // The true free-at, for the same reason as the gap lane above: the bucket
      // edge is always earlier than `winner + gap`, so waiting to it guaranteed
      // a second refusal with the whole wait allowance already spent.
      const winner = await claimedAt(fleetSlotFor(fleetBucket));
      const edge = (fleetBucket + 1) * opts.fleetGapSeconds * 1000;
      return {
        ok: false,
        kind: "pacing",
        retryAtMs: Number.isFinite(winner)
          ? Math.max(edge, winner + opts.fleetGapSeconds * 1000)
          : edge,
      };
    }
    if (fleet === "error") {
      await releaseOwn([msgSlot, ownRecipientSlot, slotFor(bucket)]);
      return { ok: false, kind: "error" };
    }
    // THE SAME STRADDLE THE GAP SLOTS ALREADY GUARD. A bucket is a window, not
    // a spacing promise: a send at the last instant of bucket N and another at
    // the first instant of N+1 both win their claims and land milliseconds
    // apart - two different shops answered simultaneously, which is exactly the
    // bulk-sender signature the fleet ceiling exists to prevent. Speeding the
    // engaged lane up makes that boundary far more reachable, so it has to
    // close here rather than being left to luck.
    // A read, never a probe-write - see the gap lane's note.
    const prevFleetAt = await claimedAt(fleetSlotFor(fleetBucket - 1));
    if (Number.isFinite(prevFleetAt) && now - prevFleetAt < opts.fleetGapSeconds * 1000) {
      await releaseOwn([msgSlot, ownRecipientSlot, slotFor(bucket), fleetSlotFor(fleetBucket)]);
      return { ok: false, kind: "pacing", retryAtMs: prevFleetAt + opts.fleetGapSeconds * 1000 };
    }
  }
  return { ok: true };
}

/**
 * A send that FAILED after winning its claims must release the message slot,
 * or its own retry would be dropped as a "duplicate" of itself. The gap slot
 * is deliberately kept - a failed network call still consumed the pacing
 * window (the retry re-queues beyond it anyway).
 */
export async function releaseMessageClaim(
  senderKey: string,
  toDigits: string,
  text: string
): Promise<void> {
  await sbDelete(
    "wa_send_claims",
    `sender_key=eq.${encodeURIComponent(senderKey)}&slot_key=eq.${encodeURIComponent(
      messageSlotKey(toDigits, text)
    )}`
  ).catch(() => {});
}

// ACTUALLY throttled now: the docstring said "throttled" while the function
// ran two ranged DELETEs on EVERY drain call - and drains fire from four
// triggers up to several times a minute, against a table whose only index is
// the primary key (neither `created_at` nor `not like` is indexable without
// the schema.sql index this wave adds). Once per instance per 5 minutes keeps
// the table just as bounded; the expired rows have hours of slack by design.
const GC_EVERY_MS = 5 * 60_000;
declare global {
  // eslint-disable-next-line no-var
  var __wd_claims_gc_at__: number | undefined;
}

/** Throttled GC (call from the drain tail). Two horizons by slot type. */
export async function gcSendClaims(): Promise<void> {
  const last = globalThis.__wd_claims_gc_at__ ?? 0;
  if (Date.now() - last < GC_EVERY_MS) return;
  globalThis.__wd_claims_gc_at__ = Date.now();
  // Every NON-idempotency claim (gap: pacing, chain: tick self-chain lock,
  // game: score rate-limit, and any future prefix) only guards a short window -
  // clear after 2h. `not.like.msg:*` restores the pre-split guarantee that the
  // table cannot grow unbounded (the earlier gap:*-only delete leaked chain:
  // and game: rows forever - ~720-2880 chain rows/day on an active cron).
  await sbDelete(
    "wa_send_claims",
    `slot_key=not.like.msg:*&created_at=lt.${encodeURIComponent(
      new Date(Date.now() - 2 * 3600_000).toISOString()
    )}`
  ).catch(() => {});
  // msg (idempotency) claims must OUTLIVE the longest possible outbox hold. The
  // daily cap parks a row at oldest+24h, business-hours-clamped (up to ~40h
  // out), and a landed-but-timed-out queue() insert can re-park as a belt
  // duplicate; keeping the twin's msg claim ~72h means that duplicate is still
  // refused at send time (claimSendSlots -> 409 -> skipped) instead of
  // double-sending the same message ~a day apart (a ban signal).
  await sbDelete(
    "wa_send_claims",
    `slot_key=like.msg:*&created_at=lt.${encodeURIComponent(
      new Date(Date.now() - 72 * 3600_000).toISOString()
    )}`
  ).catch(() => {});
}
