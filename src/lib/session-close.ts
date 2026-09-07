// CLOSE A SEARCH SESSION HARD - the one implementation, two callers.
//
// Extracted from /api/session/close so the TTL stand-down can reuse it: a
// hunt that quietly EXPIRED used to leave everything armed - queued outbox
// rows, strategic-wait wakeups, un-tombstoned recipients - because expiry was
// enforced only by the client dropping sessionStorage. The first agent turn
// against a stale hunt now runs this exact close (reason "ttl-expired"), so
// an expired hunt winds down the same way a cleared one does.
//
// Three guarantees, unchanged from the route that grew them:
//   1. Every queued outbound message inside the window is deleted.
//   2. Every shop the session was talking to is TOMBSTONED (wa_cancellations),
//      so even a strategic-wait wakeup that re-composes is refused at the gate.
//   3. A session-closed marker is stamped - the durable fact every other
//      surface (agent gates, push liveness, Trips) reads.

import "server-only";
import { sbInsert, sbSelect, sbDelete, sbDeleteReturning } from "./runtime-config";
import { cancelSends, pruneCancellations } from "./wa/cancellations";
import { patchThreadFields, THREAD_PATCH_SELECT } from "./thread/patch-fields";

export interface CloseSessionOpts {
  /** Start of the closing session's window (ms). Defaults to now - 7d. */
  fromMs?: number;
  /** The close cutoff (ms) - rows created after it belong to the NEW session. */
  beforeMs?: number;
  /** Why the session closed - stamped on the marker so Ops can tell a user
   *  clear from a quiet expiry. */
  reason?: "user" | "ttl-expired";
}

export async function closeSearchSession(
  email: string,
  opts: CloseSessionOpts = {}
): Promise<{ purged: number }> {
  const nowMs = Date.now();
  const beforeMs = Number.isFinite(opts.beforeMs) ? Math.min(Number(opts.beforeMs), nowMs) : nowMs;
  const fromMs = Number.isFinite(opts.fromMs)
    ? Math.max(Number(opts.fromMs), nowMs - 7 * 24 * 3600_000)
    : nowMs - 7 * 24 * 3600_000;
  const beforeIso = new Date(beforeMs).toISOString();
  const fromIso = new Date(fromMs).toISOString();
  const enc = encodeURIComponent(email);

  // 1. Drop what the CLOSING session still has parked - returning the
  //    recipients so each one gets a tombstone. Rows created after the
  //    cutoff belong to the new session and are left alone.
  const purged = await sbDeleteReturning<{ to_number: string }>(
    "wa_outbox",
    `sender_key=eq.${enc}&created_at=lte.${encodeURIComponent(beforeIso)}`
  ).catch(() => [] as { to_number: string }[]);

  // Wakeups: EXACT owner match on the stamped column only (the old
  // thread_key LIKE sweep was a cross-user hazard - an underscore in an email
  // is a single-char SQL wildcard). Every kind, not just tick: a surviving
  // judge wakeup still fires its drain branch against a dead session.
  await sbDelete("graph_wakeups", `user_email=eq.${enc}`).catch(() => {});

  // 2. Tombstone every shop this session was talking to - including the ones
  //    with no outbox row (already messaged, awaiting a reply), whose inbound
  //    would otherwise still trigger an auto-answer. wa_recipient_state has
  //    exactly one row per contacted shop, so this enumerates DISTINCT shops.
  //    SCOPE: only shops whose last send falls inside the closing session's
  //    own window [from, before] - earlier sessions are covered by their own
  //    close, the new session's shops have last_sent_at > before.
  const activeShops = await sbSelect<{ to_number: string }>(
    "wa_recipient_state",
    `select=to_number&sender_key=eq.${enc}&last_sent_at=gte.${encodeURIComponent(
      fromIso
    )}&last_sent_at=lte.${encodeURIComponent(beforeIso)}&limit=500`
  ).catch(() => [] as { to_number: string }[]);
  // BELT for the retry race: a shop the NEW session has already queued must
  // never be re-tombstoned by this (possibly retried) close.
  const freshRows = await sbSelect<{ to_number: string }>(
    "wa_outbox",
    `select=to_number&sender_key=eq.${enc}&created_at=gt.${encodeURIComponent(beforeIso)}&limit=200`
  ).catch(() => [] as { to_number: string }[]);
  const freshlyQueued = new Set(freshRows.map((r) => r.to_number));
  const digits = [
    ...new Set(
      [...purged.map((r) => r.to_number), ...activeShops.map((r) => r.to_number)].filter(Boolean)
    ),
  ].filter((d) => !freshlyQueued.has(d));
  for (const d of digits) {
    await cancelSends(email, d, "session-closed").catch(() => {});
  }
  // Housekeeping: stale tombstones (>14d) are meaningless - prune on this
  // rare event instead of on every hot-path request.
  await pruneCancellations(email).catch(() => {});

  // 3. PER-SEARCH THREAD STATE DIES WITH THE SESSION (owner report 6 B3).
  //    negotiation_threads is keyed user:number with no search dimension, so a
  //    re-contacted shop used to inherit the WHOLE previous hunt: its round
  //    count, its standing quote, its confirm-questions-already-spent, even a
  //    terminal 'closing'/'declined' state - and the new search started
  //    mid-negotiation or, worse, permanently mute. Reset the per-search half;
  //    keep what is genuinely durable about the SHOP (tone, language, deposit
  //    policy facts). Best-effort per row, bounded to the closing window.
  try {
    const threads = await sbSelect<{
      thread_key: string;
      fields: Record<string, unknown> | null;
      version: number | null;
      phase: string | null;
      stage: string | null;
    }>(
      "negotiation_threads",
      // EITHER CLOCK PUTS THE ROW IN THIS HUNT (audit F134). The window used to
      // be `updated_at=gte.<from>` alone, and the funnel ledger's writes did
      // not move `updated_at` - so a thread whose only activity was stage
      // transitions dropped out of every window after the first hunt and its
      // stale terminal stage was never reset. The ledger now stamps
      // `updated_at` too; this `or` also rescues rows written before it did.
      `${THREAD_PATCH_SELECT}&user_email=eq.${enc}&or=(updated_at.gte.${encodeURIComponent(
        fromIso
      )},stage_at.gte.${encodeURIComponent(fromIso)})&limit=200`
    ).catch(() => []);
    const SEARCH_FIELD_KEYS = [
      "round",
      "rounds",
      "firmCount",
      "pricePerDay",
      "currency",
      "priceBasisDays",
      "vehicleKey",
      "declined",
      "waitingUntil",
      // THE LATCH, SPELLED THE WAY ITS WRITERS SPELL IT (audit F067). This
      // entry read "vehicleConfirmed", a key nothing in the tree writes, so
      // the reset was a no-op: the durable key is `vehicleConfirmation`
      // (graph/types.ts), it can never regress on its own (a confirmed prev
      // is KEPT by mergeVehicleConfirmation), and it survived into the next
      // hunt - a scooter confirmed in hunt 1 presented hunt 2's CAR quote as
      // a vehicle-confirmed, verified offer, with the ask-once `askedAt`
      // still spent so the question could not even be re-asked.
      "vehicleConfirmation",
    ];
    // THE STAMP THE ENGINE'S OWN CAS READS (audit F033). The reset below is
    // versioned, so a turn that loaded the row BEFORE the close loses its cas -
    // and saveThreadState's lost-race merge would otherwise fold the pre-close
    // reads back in. This stamp is how that merge recognises a close it never
    // saw and yields to it whole (graph/state.ts).
    const closedAt = new Date().toISOString();
    const SEARCH_DIGEST_KEYS = [
      "quotedPricePerDay",
      "round",
      "confirmAsked",
      "awaitingConfirmation",
      "pending",
      "priceWatchArmed",
      // ONCE-PER-NEGOTIATION LATCHES, NOT FACTS ABOUT THE SHOP (audit F068).
      // lastAskPerDay is the concession ladder's memory of the last target we
      // named; the recap latch and its clocks say a verify-recap was already
      // sent and answered; oweWatchArmed is the silent-but-owing re-entry
      // bound. Carried into a new hunt they all describe a negotiation that
      // is over.
      "lastAskPerDay",
      "recapSent",
      "recapSentAt",
      "recapConfirmedAt",
      "recapAmended",
      "oweWatchArmed",
    ];
    // THE PER-HUNT HALF OF THE DURABLE COMPREHENSION (audit F068).
    //
    // `digest.comprehension` is the ONLY source deriveThreadFacts projects
    // firmCount / depositKnown / the goodbye latch from (spte/thread-facts),
    // and it was not reset at all: a shop that answered two bargains with
    // "last price" in hunt 1 opened hunt 2 with firmCount 2, which sets
    // firmAllowsBargain false in spte/policy - the agent never pushed it once,
    // against a brand new opening quote. `closed` likewise made hasClosed()
    // true from turn one.
    //
    // NOT the whole blob: the same object carries what the shop told us about
    // ITSELF (its deposit kind, how it hands the vehicle over and what that
    // costs), which spte/live reads precisely so a re-contacted shop is not
    // asked again. Only the verdicts about the FINISHED negotiation go.
    const SEARCH_COMPREHENSION_KEYS = [
      "firmTurns",
      "depositStated",
      "declined",
      "deflected",
      "closed",
    ];
    // THE RESET APPLIED TO WHATEVER THE ROW HOLDS AT WRITE TIME. Re-run on the
    // fresher row when a turn lands mid-close, so the turn's own reads are
    // kept and only the per-hunt half dies (audit F033).
    const resetFields = (f: Record<string, unknown>): Record<string, unknown> => {
      for (const k of SEARCH_FIELD_KEYS) delete f[k];
      const stored = f.digest;
      if (stored && typeof stored === "object") {
        // Copy before editing: `f` is a shallow copy of the row's fields, so
        // the nested digest is still the caller's object.
        const digest = { ...(stored as Record<string, unknown>) };
        f.digest = digest;
        for (const k of SEARCH_DIGEST_KEYS) delete digest[k];
        const comp = digest.comprehension;
        if (comp && typeof comp === "object") {
          // Copy for the same reason the digest itself is copied.
          const next = { ...(comp as Record<string, unknown>) };
          for (const k of SEARCH_COMPREHENSION_KEYS) delete next[k];
          digest.comprehension = next;
        }
        // 'shop declined / walked away' answered the PREVIOUS request; a new
        // search is a new request, and policy's hasClosed() scan over these
        // facts would otherwise keep the thread mute forever.
        const facts = digest.facts;
        if (Array.isArray(facts)) {
          digest.facts = facts.filter(
            (x) => typeof x !== "string" || !/closed|goodbye|declined|walked away/i.test(x)
          );
        }
      }
      f.searchClosedAt = closedAt;
      return f;
    };
    await Promise.all(
      threads.map(async (t) => {
        // FUNNEL LEDGER: the funnel this stage belonged to just ended. The
        // HISTORY records the death (one funnel-stage event, to:'dead'); the
        // ROW resets to null exactly like phase does, because the thread is
        // reused by the next hunt and a sticky 'dead' would refuse its
        // `selected` forever (dead is a hard terminal by design). A thread
        // that reached booked/completed did not die - it won; its stage still
        // clears (per-hunt state) but no death event is written over it.
        if (t.stage != null) {
          if (t.stage !== "booked" && t.stage !== "completed") {
            const tail = t.thread_key.slice(t.thread_key.lastIndexOf(":") + 1);
            await sbInsert("agent_events", [
              {
                kind: "funnel-stage",
                user_email: email,
                to_number: tail,
                vendor_id: "",
                vendor_name: "",
                detail: JSON.stringify({
                  from: t.stage,
                  to: "dead",
                  evidence:
                    opts.reason === "ttl-expired" ? "search session expired" : "search session closed",
                  entry: new Date().toISOString(),
                }),
              },
            ]).catch(() => {});
          }
        }
        // VERSIONED (audit F033). The bare PATCH this used to be left `version`
        // untouched, so a turn holding the pre-close version still won its own
        // cas afterwards and wrote every deleted key back - the new hunt then
        // opened at round 3 with a standing quote and a shop that had walked
        // away. Best-effort still: a close that cannot reach the store must
        // still have tombstoned the recipients above.
        await patchThreadFields({
          threadKey: t.thread_key,
          row: t,
          mutate: resetFields,
          columns: (row) => ({
            // Terminal-ish phases never reopen implicitly (graph/state.ts) - so
            // a new search against a 'closing'/'dead' thread would be born stuck.
            ...(row.phase && row.phase !== "opening" ? { phase: "opening" } : {}),
            waiting_until: null,
            ...(row.stage != null ? { stage: null, stage_at: null } : {}),
          }),
        }).catch(() => {});
      })
    );
  } catch {
    /* best-effort - the boundary reads (thread-context) still fence the rfq */
  }

  // 4. Stamp the close marker (a system row in the message log - no schema
  //    change needed, and to_number "session" can never match a real thread).
  await sbInsert("whatsapp_messages", [
    {
      to_number: "session",
      body:
        opts.reason === "ttl-expired"
          ? "(search session expired - agents stood down)"
          : "(search session closed by the user)",
      type: "system",
      direction: "outbound",
      raw: { sender: email, kind: "session-closed", reason: opts.reason ?? "user" },
    },
  ]).catch(() => {});

  return { purged: purged.length };
}
