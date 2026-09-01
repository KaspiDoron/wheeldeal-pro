// THE one thread resolver. Every layer that asks "is this a real shop thread,
// and what RFQ does it belong to?" must come through here.
//
// The bug this kills: three copies of the lookup existed with THREE different
// predicates -
//   - drill.ts/thread-gate: newest 10 outbound, anchor = rfq OR vendorId OR kind
//   - agent-loop:            newest 1  outbound, anchor = rfq ONLY
//   - vision.worker:         newest 1  outbound, anchor = rfq ONLY
// so a thread could PASS the ingest gate (message stored), then be dropped by
// the agent as "no-rfq-thread". That happened whenever the newest outbound row
// carried no rfq - which a human-manual takeover row, or any send whose client
// omitted body.rfq, guarantees. One stray row silently killed the whole
// conversation forever.
//
// Fix: scan a WINDOW of recent outbound rows and take the newest row that
// actually carries an RFQ, instead of demanding it be the very newest row. A
// later takeover/custom message can no longer erase the thread's identity.

import "server-only";
import { sbSelect } from "../runtime-config";
import { threadNumberOr } from "./phone-key";
import { classifyIngestDetailed, type GateRaw, type IngestReason } from "./thread-gate";
import type { StructuredRFQ } from "../types";
import { citedDurationDays, promiseOf, reconcileRfq, rfqDrifted } from "./rental-params";

export interface ThreadRaw extends GateRaw {
  /** The row's stamped rfq. On the value this resolver RETURNS as `ctx` this is
   *  always the reconciled promise, never the raw stamp - see `ctx` below. */
  rfq?: StructuredRFQ | null;
  /** Set when the rfq on this row came from anchor RECOVERY, not from the send. */
  rfqRecovered?: boolean;
  sender?: string;
  region?: string;
  vendorName?: string;
  localLang?: boolean;
  plan?: string;
  round?: number;
}

export interface ThreadContext {
  /** Ingestible: a real shop thread inside its window. */
  ok: boolean;
  reason: IngestReason;
  /**
   * OUR OUTAGE, not the shop's absence.
   *
   * The anchor read used to be wrapped in `.catch(() => [])`, so a Supabase
   * wobble produced zero rows and the caller concluded "we never sent this
   * number an RFQ" - writing `no-rfq-thread` and abandoning a live negotiation
   * over a transient blip. drill.ts refuses to make that mistake (it reads
   * strict precisely so unavailable stays distinguishable from empty) and this
   * resolver never got the same treatment. When this is true the caller must
   * leave the reply REPLAYABLE rather than declaring the thread unknown.
   */
  unavailable?: boolean;
  /** The newest outbound raw that carries an RFQ (not merely the newest row),
   *  reconciled against the thread's opening promise. */
  rfq: StructuredRFQ | null;
  /**
   * The anchor row's raw - identity, sender, round, region - WITH `rfq` replaced
   * by the reconciled value above.
   *
   * W9: it used to hand back the raw drifted row while `.rfq` carried the
   * reconciled promise, and the two callers disagreed about which one to read:
   * the wakeup/tick path took `resolved.rfq`, the LIVE inbound turn took
   * `ctx.rfq`. So one thread answered a scheduled follow-up on 3 days and the
   * shop's own reply on 1 - the mid-thread flip, on the path the traveller
   * actually watches. A context whose `rfq` disagrees with `.rfq` is a footgun
   * no call site should have to know about, so the disagreement is removed
   * HERE: `ctx.rfq === rfq`, always, on every branch including self-heal.
   */
  ctx: ThreadRaw | null;
  vendorId?: string;
  vendorName?: string;
  region?: string;
  /** How many outbound rows we saw (0 => we never messaged this number). */
  anchors: number;
  /** received_at of the newest outbound row (session-close comparisons). */
  newestAt: string | null;
  /** True when `rfq` came from anchor RECOVERY, not from an outbound row. */
  repaired?: boolean;
}

const WINDOW = 12; // recent outbound rows scanned for an RFQ anchor

/**
 * WHERE THE CURRENT SEARCH BEGINS (owner report 6 B - the '5 days' bug).
 *
 * The opener/promise reads below used to fetch the first outbound EVER to a
 * number. When a new search re-contacted a shop from a previous hunt, that
 * row was the OLD search's opening message, promiseOf() preferred it, and
 * reconcileRfq() overwrote the new search's durationDays with the old one -
 * after which the duration RAIL enforced the wrong number on every draft. A
 * new search makes a NEW promise: everything promise-shaped is bounded by the
 * newest session-closed marker (stamped by clear, new-search, TTL expiry and
 * deal-close alike).
 */
async function sessionBoundary(senderEmail: string): Promise<string | null> {
  try {
    const rows = await sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&raw->>sender=eq.${encodeURIComponent(
        senderEmail
      )}&to_number=eq.session&raw->>kind=eq.session-closed&order=received_at.desc&limit=1`
    );
    return rows[0]?.received_at ?? null;
  } catch {
    return null;
  }
}

/**
 * THE PROMISE, FOR THE COMPOSERS THE INBOUND PATH NEVER TOUCHED (W4.1).
 *
 * `resolveThreadContext` applies the promise on the INBOUND path - a shop
 * replies, the turn runs on reconciled terms. The two OUTBOUND composers the
 * traveller drives (the Bargain draft and a hand-typed custom send) compose
 * from the CLIENT's live rfq with no reconciliation at all, and then re-stamp
 * that rfq onto the outbound row - minting a fresh anchor that contradicts the
 * opener. That is the mid-thread flip in owner report 5 #7: openers said 1 day
 * (the duration bug), and the moment the traveller tapped Bargain the draft
 * composed on the client's live 3 - a number this shop had never been quoted.
 *
 * One cheap read of the thread's FIRST outbound row, which is immutable
 * evidence of what we actually said, then the same pure `reconcileRfq` the
 * inbound path uses. Degrades to the client's rfq unchanged when there is no
 * opener (a first contact has made no promise yet) or the read fails - it can
 * only ever pull a composer back toward what the shop was told.
 */
export async function promisedRfq(
  digits: string,
  senderEmail: string,
  clientRfq: StructuredRFQ | null | undefined
): Promise<{ rfq: StructuredRFQ | null; drifted: boolean }> {
  const rfq = clientRfq ?? null;
  if (!rfq || !digits || !senderEmail) return { rfq, drifted: false };
  const or = threadNumberOr("to_number", digits);
  if (!or) return { rfq, drifted: false };
  try {
    const boundary = await sessionBoundary(senderEmail);
    const sinceBound = boundary ? `&received_at=gt.${encodeURIComponent(boundary)}` : "";
    const openerRows = await sbSelect<{ body: string | null; raw: ThreadRaw | null }>(
      "whatsapp_messages",
      `select=body,raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        senderEmail
      )}${sinceBound}&order=received_at.asc&limit=1&or=${or}`
    );
    const opener = openerRows[0];
    if (!opener) return { rfq, drifted: false }; // first contact - nothing promised yet
    const promise = promiseOf(opener.raw?.rfq as StructuredRFQ | undefined, opener.body, rfq);
    if (!promise) return { rfq, drifted: false };
    return { rfq: reconcileRfq(rfq, promise) ?? rfq, drifted: rfqDrifted(rfq, promise) };
  } catch {
    return { rfq, drifted: false };
  }
}

/**
 * Resolve the thread for `digits` as seen by `senderEmail`. Number matching is
 * spelling-tolerant (see phone-key) so threads written before canonicalization
 * still resolve.
 */
export async function resolveThreadContext(
  digits: string,
  senderEmail: string
): Promise<ThreadContext> {
  const empty: ThreadContext = {
    ok: false,
    reason: "no-outbound",
    rfq: null,
    ctx: null,
    anchors: 0,
    newestAt: null,
  };
  if (!digits || !senderEmail) return empty;

  const or = threadNumberOr("to_number", digits);
  if (!or) return empty;

  // Two reads, in parallel so the turn costs no extra latency:
  //   - the recent window, which supplies the live anchor and identity
  //   - the thread's FIRST outbound, which is the promise we made this shop
  // The opener is what fixes the duration and vehicle for the whole thread; see
  // lib/wa/rental-params for why the newest rfq cannot be trusted with them.
  const boundary = await sessionBoundary(senderEmail);
  const sinceBound = boundary ? `&received_at=gt.${encodeURIComponent(boundary)}` : "";
  const { sbSelectStrict } = await import("../runtime-config");
  const [anchorRead, openerRows] = await Promise.all([
    // STRICT on the anchor read. This is the query that decides whether a live
    // thread exists at all; a permissive catch here turns our own outage into
    // "this shop was never contacted".
    sbSelectStrict<{ id: number; received_at: string; raw: ThreadRaw | null }>(
      "whatsapp_messages",
      `select=id,received_at,raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        senderEmail
      )}&order=received_at.desc&limit=${WINDOW}&or=${or}`
    ),
    // The opener of the CURRENT search - the first thing we told this shop
    // THIS hunt, which is the promise that binds. The previous hunt's opener
    // (before the boundary) binds nothing anymore.
    sbSelect<{ id: number; body: string | null; raw: ThreadRaw | null }>(
      "whatsapp_messages",
      `select=id,body,raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        senderEmail
      )}${sinceBound}&order=received_at.asc&limit=1&or=${or}`
    ).catch(() => []),
  ]);

  // "missing" (no table yet, a fresh deploy) is a real empty; anything else is
  // an outage and must not be read as "no thread".
  if (!("rows" in anchorRead)) {
    return anchorRead.error === "missing" ? empty : { ...empty, unavailable: true };
  }
  const rows = anchorRead.rows;
  if (rows.length === 0) return empty;

  const gate = classifyIngestDetailed(rows, Date.now());

  // The newest IN-SESSION row that actually carries an RFQ - NOT simply
  // rows[0]. A human-manual or rfq-less row on top no longer orphans the
  // conversation, and a stale anchor from the PREVIOUS search (its rfq stamp
  // carries the old duration) never supplies this search's terms. The full
  // window still feeds the gate and identity - vendor name/id are durable.
  const inSession = (r: { received_at: string }) =>
    !boundary || r.received_at > boundary;
  const anchor = rows.find((r) => inSession(r) && r.raw?.rfq != null) ?? null;
  // Identity (vendor/region) can come from any recent row, newest wins.
  const identity = rows.find((r) => r.raw?.vendorId) ?? anchor ?? rows[0];

  // SELF-HEAL. We demonstrably messaged this shop (rows.length > 0) and the
  // gate says the thread is live, yet NO row carries an rfq - so every reply
  // would die as "no-rfq-thread" forever. Recover the RFQ from the traveller's
  // own recent search and repair the row, instead of going permanently silent.
  if (!anchor && gate.ok && rows.some(inSession)) {
    const { recoverRfqForSender } = await import("./anchor-recovery");
    // Recover against what THIS thread asked for, not merely the newest search.
    // The opener's own sentence still states the duration even when its
    // structured rfq is the thing that went missing.
    const opened = openerRows[0];
    const want = {
      durationDays:
        (opened?.raw?.rfq as StructuredRFQ | undefined)?.durationDays ??
        citedDurationDays(opened?.body) ??
        undefined,
      vehicleClass: (opened?.raw?.rfq as StructuredRFQ | undefined)?.vehicleClass,
    };
    const recovered = await recoverRfqForSender(senderEmail, Date.now(), want).catch(() => null);
    if (recovered) {
      const target = identity ?? rows[0];
      // Persist onto the newest outbound row so the heal is permanent (one
      // recovery per thread, not one per inbound message) and the WA doctor
      // reports a healthy anchor from here on. Best-effort: if the write fails
      // we still proceed with THIS turn using the recovered rfq.
      // W9: THE HEAL IS APPLIED IN MEMORY BEFORE IT IS APPLIED IN THE DB.
      //
      // This used to hand sbUpdate a fresh object literal and return
      // `target.raw` untouched, so the caller got a ctx with NO rfq at all -
      // past the `!resolved.rfq` guard (which reads the other field), straight
      // into `rfq.vehicleClass` on the live inbound path. The repaired row IS
      // the context from here on, so build it once and use it for both.
      const healed: ThreadRaw | null = target?.raw
        ? { ...target.raw, rfq: recovered, rfqRecovered: true }
        : null;
      if (target) {
        const { sbUpdate } = await import("../runtime-config");
        await sbUpdate(
          "whatsapp_messages",
          `id=eq.${target.id}`,
          { raw: healed ?? { rfq: recovered, rfqRecovered: true } }
        ).catch(() => {});
      }
      // Never silent: the repair is an event the owner can see in the doctor.
      const { sbInsert } = await import("../runtime-config");
      await sbInsert("agent_events", [
        {
          kind: "anchor-repaired",
          user_email: senderEmail,
          vendor_name: identity?.raw?.vendorName ?? digits,
          detail: `Re-anchored ${digits} from the traveller's recent search (no outbound row carried an rfq).`,
        },
      ]).catch(() => {});
      return {
        ok: gate.ok,
        reason: gate.reason,
        rfq: recovered,
        ctx: healed,
        vendorId: identity?.raw?.vendorId,
        vendorName: identity?.raw?.vendorName,
        region: identity?.raw?.region || undefined,
        anchors: rows.length,
        newestAt: rows[0]?.received_at ?? null,
        repaired: true,
      };
    }
  }

  // THE PROMISE OUTRANKS THE ANCHOR.
  //
  // `anchor.raw.rfq` is client-posted and re-stampable by any later send, so a
  // second search for a different duration silently rewrote live threads - and
  // the agent then quoted a duration this shop had never been asked about. The
  // opener is immutable evidence of what we actually said, so it supplies the
  // duration and vehicle while the anchor still supplies everything else.
  const opener = openerRows[0];
  const promise = promiseOf(
    opener?.raw?.rfq as StructuredRFQ | undefined,
    opener?.body,
    (anchor?.raw?.rfq as StructuredRFQ | undefined) ?? null
  );
  const anchorRfq = (anchor?.raw?.rfq as StructuredRFQ | undefined) ?? null;
  const resolvedRfq = reconcileRfq(anchorRfq, promise);

  if (rfqDrifted(anchorRfq, promise)) {
    // Never silent: a drift means some other surface wrote an rfq into this
    // thread, and the owner should be able to see that it was overruled.
    //
    // W9: "Kept what the shop was told" was a FALSE claim until the ctx above
    // stopped disagreeing with `rfq` - the live inbound turn read the drifted
    // anchor while this trail told the owner it had been overruled, which is
    // very likely how the flip survived an audit. It is true on every path now
    // because there is only one rfq to keep.
    const { sbInsert } = await import("../runtime-config");
    await sbInsert("agent_events", [
      {
        kind: "rfq-drift-blocked",
        user_email: senderEmail,
        vendor_name: identity?.raw?.vendorName ?? digits,
        detail: `Anchor rfq said ${anchorRfq?.durationDays}d ${anchorRfq?.vehicleClass}; this thread was opened on ${promise?.durationDays}d ${promise?.vehicleClass}. Kept what the shop was told.`,
      },
    ]).catch(() => {});
  }

  // ONE RFQ LEAVES THIS FUNCTION. The base row supplies identity and thread
  // state; the reconciled promise supplies the rental terms, overwriting the
  // stamp the row happens to carry. A caller that reads `ctx.rfq` and a caller
  // that reads `.rfq` now get the same answer, which is the only way two entry
  // points into the same thread can stop contradicting each other.
  const base = anchor?.raw ?? identity?.raw ?? null;

  return {
    ok: gate.ok,
    reason: gate.reason,
    rfq: resolvedRfq,
    ctx: base ? { ...base, rfq: resolvedRfq } : null,
    vendorId: identity?.raw?.vendorId,
    vendorName: identity?.raw?.vendorName,
    region: (anchor?.raw?.region ?? identity?.raw?.region) || undefined,
    anchors: rows.length,
    newestAt: rows[0]?.received_at ?? null,
  };
}
