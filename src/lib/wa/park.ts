import { sbInsert, sbDelete, sbSelect } from "../runtime-config";
import { tableReady } from "../schema-probe";
import { outboxKey } from "./phone-key";
import { REPLY_KIND_FILTER, humanizeForOutbound } from "../wa-guard";
import { insertUserEvent } from "../events";

/**
 * Park an auto-composed WhatsApp message in wa_outbox with STRICT
 * one-row-per-shop dedup.
 *
 * The bug this fixes: the human-delay parks (graph engine + agent loop) inserted
 * a fresh wa_outbox row on every composed turn with no check for an existing
 * pending row to the same shop, and the wakeup-retry re-runs a turn that already
 * queued - so a single shop that was awaiting a reply piled up as 4 duplicate
 * queued messages, which then burned the anti-ban budget and pushed every other
 * shop's send an hour out.
 *
 * Invariant: at most ONE pending AUTO-COMPOSE row per (sender_key, to_number). A
 * newer auto composition REPLACES any older pending auto row (the latest message
 * is the one to send). The delete is KIND-SCOPED - it never touches a pending
 * `rfq` (a fresh outreach a shop has not received yet), a user-typed `custom`
 * message, or a `human-manual` row. Without that scoping, a shop from an EARLIER
 * search replying late (its 14-day thread is still ingestible) while a NEW RFQ
 * to the same number is queued would silently delete that unsent RFQ. Per-thread
 * composition is serialized by the wakeup claim, so the delete-then-insert
 * window is negligible; it also self-heals pre-existing auto duplicates.
 *
 * ROBUSTNESS (overnight audit DEFECT 1): the insert result used to be discarded,
 * so a transient write blip on the insert half (after the delete succeeded) left
 * the shop with NOTHING queued and no trace, and a unique-index conflict from a
 * concurrent compose silently dropped a reply. Now the insert result is checked:
 * a conflict means a pending reply already exists (fine - a reply IS queued); a
 * genuine failure retries once and, if still failing, logs a visible
 * `wa-park-failed` event so a lost park is never silent (a future inbound/tick
 * recomposes - the thread is not stuck).
 */
// THE SAME NULL TRAP W-14 FIXED ON THE REPLY LANE, HERE ON THE DEDUP SCOPE.
// The old local `meta->>kind=not.in.(...)` predicate evaluates NULL for a
// row that never stamped a kind, and PostgREST keeps only TRUE - so a
// kind-less pending auto row was invisible to this delete and the
// one-row-per-shop invariant silently admitted zombies. REPLY_KIND_FILTER
// (imported above) spells the NULL case out - "no kind means auto" - and
// sharing it means the park's idea of an auto row can never drift from the
// drain's again.

// `robustRequeue` used to live here: the drain claimed a row by DELETING it, so
// a failed re-insert after a failed send meant permanent, silent loss, and the
// re-insert needed a retry-and-log dance of its own. The outbound lifecycle
// (wa/outbox-lifecycle) removed the problem rather than hardening the workaround
// - a claimed row is leased, never deleted, so a re-queue is a patch on a row
// that already exists and there is no insert left to lose.

/**
 * ARM A DRAIN AT `not_before` (dependency-inverted, exactly like the vision
 * Flow hook - this file must never import BullMQ into the Next bundle).
 *
 * A reply parked 6-15s out was still gated by whatever ran next: the worker's
 * 20s heartbeat, or nothing at all until the following one. So the delay the
 * composer chose was a FLOOR, and the real latency was that floor plus up to a
 * full heartbeat - which is how a "snappy" reply still read as a minute away.
 * The worker runtime sets this to a delayed drain job scheduled at exactly the
 * moment the row comes due.
 *
 * Unset, the NEXT runtime's own armer (wa/drain-armer.ts) runs - and that is
 * the ONLY runtime live today: `services/workers` is in no Dockerfile CMD and
 * no deploy manifest, so the worker hook is dark in production. It stayed dark
 * and unnoticed because the comment here used to say the Next path "already
 * kicks the self-chaining /api/wa/tick, which waits the row out in-process" -
 * true of the code, false of the outcome. That kick was refused every time a
 * cold batch was draining (one global runner, one chain claim), which is
 * exactly when a reply matters.
 *
 * The Next default arms a bounded in-process timer whose only action is an
 * HTTP self-kick of the per-sender reply dispatcher (never a dangling drain -
 * Cloud Run freezes CPU after the response, so the work must run in its own
 * invocation). The 1-minute cron stays the backstop; the armer is the fast
 * path. Provisioning the worker replaces it with an exact-moment drain job.
 */
let armDrainAt: ((atMs: number, senderKey?: string) => void) | null = null;

export function setDrainArmer(fn: ((atMs: number, senderKey?: string) => void) | null): void {
  armDrainAt = fn;
}

export async function parkOutboxOnce(row: {
  senderKey: string;
  toNumber: string;
  body: string;
  notBeforeMs: number;
  meta?: Record<string, unknown>;
  /** The body already went through guardOutbound's humanize pass (e.g. a
   *  failed send being re-parked). Park it verbatim - a second pass would
   *  re-word text that was already delivery-ready. */
  alreadyHumanized?: boolean;
}): Promise<void> {
  // SCOPED BY THE SHOP, NOT BY THE SPELLING. This used to match to_number as an
  // exact string, so a shop stored once as "639661952196" and once as
  // "09661952196" kept TWO live pending rows - the very duplicate this function
  // exists to prevent, and the same mistake the unique index was migrated to
  // fix. The canonical key is what the index keys on; it is what we scope on.
  const key = outboxKey(row.toNumber);

  // THE SEATBELT: `to_key` IS NEWER THAN SOME DATABASES THIS CODE CAN REACH.
  //
  // Three things here hard-depend on the column - the delete scope, the insert
  // record, and the existence probe below. Against a database where schema.sql
  // has not been re-run, all three 400: the delete is swallowed, the insert
  // returns false, the probe returns [] so `existing.length === 0` is true, the
  // retry insert fails the same way, and EVERY agent reply park fails. A total
  // reply outage whose only trace is a `wa-park-failed` breadcrumb.
  //
  // One probe, cached, decides which spelling of the scope to use. The
  // to_number fallback is the exact pre-migration behaviour: it can leave two
  // pending rows for a shop stored under two spellings, which is a duplicate
  // risk - and a duplicate is enormously better than silence.
  const hasToKey = (await tableReady("wa_outbox", "to_key")) === "ready";
  const scope = hasToKey
    ? `sender_key=eq.${encodeURIComponent(row.senderKey)}&to_key=eq.${encodeURIComponent(key)}${REPLY_KIND_FILTER}`
    : `sender_key=eq.${encodeURIComponent(row.senderKey)}&to_number=eq.${encodeURIComponent(row.toNumber)}${REPLY_KIND_FILTER}`;
  await sbDelete("wa_outbox", scope).catch(() => {});
  // HUMANIZE AT PARK (owner report 3, 3.4 #2). The drain re-guards every
  // parked row with `alreadyHumanized: true` - a promise this path never kept:
  // rows parked here went out with the raw composer text, so the dominant
  // automated lane skipped the anti-fingerprinting pass entirely. The pass is
  // seeded from the message identity, so a wakeup-retry re-park of the same
  // composed turn produces a byte-identical body and the dedup/idempotency
  // hashes stay stable. Everything this function parks is auto-composed (the
  // dedup scope above is auto-kind by definition), so no user-typed text can
  // reach this rewording.
  //
  // W4.7: the humanize pass is THREAD-POSITION aware, and this park has to say
  // where it is - the drain re-guards the row with `alreadyHumanized: true` and
  // never looks again. Everything parked here is an auto-composed REPLY: the
  // dedup scope above is auto-kind by definition (REPLY_KIND_FILTER excludes
  // rfq, custom and human-manual), and a reply is mid-conversation by
  // construction. So the position is known statically - `firstOutbound: false`,
  // no query - which strips any leading greeting and never rolls a new one in.
  const record = {
    sender_key: row.senderKey,
    to_number: row.toNumber,
    ...(hasToKey ? { to_key: key } : {}),
    body: row.alreadyHumanized
      ? row.body
      : humanizeForOutbound(row.senderKey, row.toNumber, row.body, { firstOutbound: false }),
    not_before: new Date(row.notBeforeMs).toISOString(),
    meta: row.meta ?? {},
  };
  let ok = await sbInsert("wa_outbox", [record]);
  if (!ok) {
    // The insert failed. Either a concurrent compose already queued a pending
    // row (unique-index conflict - a reply IS queued, nothing to do) OR a
    // transient write blip lost it (the delete above may already have removed the
    // prior pending reply, so we must not leave the shop silent). Distinguish by
    // probing for an existing pending auto row.
    const existing = await sbSelect<{ id: number }>("wa_outbox", `select=id&${scope}&limit=1`).catch(
      () => [] as { id: number }[]
    );
    if (existing.length === 0) {
      ok = await sbInsert("wa_outbox", [record]); // retry the blip once
      if (!ok) {
        await insertUserEvent(row.senderKey, {
          kind: "wa-park-failed",
          vendor_id: String((row.meta as { vendorId?: string } | undefined)?.vendorId ?? ""),
          vendor_name: String(
            (row.meta as { vendorName?: string } | undefined)?.vendorName ?? row.toNumber
          ),
          detail: `Could not queue a composed reply to +${row.toNumber} (sender ${row.senderKey}) - write failed twice. A later inbound/tick recomposes.`,
        }).catch(() => {});
      }
    }
  }
  // A row EXISTS for this shop either way (fresh insert, or the concurrent
  // compose we lost to), so arming the drain is correct in both branches - and
  // the arm must never be able to break the park.
  try {
    if (armDrainAt) {
      armDrainAt(row.notBeforeMs, row.senderKey);
    } else {
      const { armReplyDrain } = await import("./drain-armer");
      armReplyDrain(row.notBeforeMs, row.senderKey);
    }
  } catch {
    /* a missed arm only costs the next heartbeat, never the message */
  }
}
