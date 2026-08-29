import "server-only";
import { sbSelect } from "../runtime-config";
import { numberFilter, waDigits } from "./phone-key";

// THE WHOLE PATH OF A MESSAGE, IN ONE PLACE (owner report 3, items 4+8).
//
// "Where is each message stuck, and why is it not landing?" had no single
// answer: composes lived in whatsapp_messages, holds on the mutable outbox
// row (overwritten per re-park), attempts nowhere at all, wakeups in their
// own table. This assembles the durable pieces - stored messages (voice
// transcripts included), the pending outbox rows, the append-only wa-hold /
// send-attempt / drop / unconfirmed events, and the scheduled wakeups - into
// ONE chronological trail per (traveller, shop).
//
// It is deliberately a lib returning plain JSON: the admin route serves it to
// the Ops panel AND to any tool that can hit an authenticated endpoint, so
// the same view that answers the owner answers an investigating agent - at
// the cost of a few PostgREST reads and zero LLM calls.

export interface PathStep {
  at: string;
  /** Which subsystem produced the step. */
  stage:
    | "inbound"
    | "outbound"
    | "queued"
    | "hold"
    | "send-attempt"
    | "send-dropped"
    | "send-unconfirmed"
    | "send-expired"
    | "send-stale"
    | "claim-lost"
    | "claim-error"
    | "park-failed"
    // I1 (owner report 6): the failure classes the owner could only see via
    // screenshots. A dropped inbound, a duration rewritten by the drift rail,
    // every vision outcome, a media fetch that failed, a localization that
    // fell back to English, and the engine's own turn record - all of them
    // were real events in agent_events that this trail never fetched.
    | "inbound-dropped"
    | "drift"
    | "vision"
    | "media"
    | "localize"
    | "engine-turn"
    // OR8 wave C: a number placed on a host that declares OTHER regions. Not a
    // failure - a geo-mismatched link beats no link - but a scored WhatsApp
    // signal, and one that is invisible from a host panel showing every box
    // green. It belongs on the trail so "why did this number get restricted"
    // has the placement in it.
    | "transport"
    | "wakeup"
    // The funnel LEDGER's transitions (src/lib/funnel/stages.ts) - the trail
    // can now say not just where a message went but where it moved the funnel.
    | "funnel"
    // send-failed / human-takeover / human-handback: written with join columns
    // since Wave 1, so the trail can finally fetch them.
    | "send-failed"
    | "takeover";
  detail: string;
  /** Structured leftovers for machines; the UI shows `detail`. */
  raw?: Record<string, unknown>;
}

export interface MessagePath {
  senderKey: string;
  toDigits: string;
  steps: PathStep[];
  /** True when any read failed - the trail may be missing pieces, and the
   *  caller must say so instead of presenting a partial trail as complete. */
  degraded: boolean;
}

const EVENT_STAGE: Record<string, PathStep["stage"]> = {
  "wa-hold": "hold",
  "wa-send-dropped": "send-dropped",
  "wa-send-unconfirmed": "send-unconfirmed",
  "wa-park-failed": "park-failed",
  // The four terminal-or-contended fates that used to be invisible here: a row
  // binned as too old, a draft dropped as stale, and the two claim outcomes
  // (busy vs broken). Without them the trail showed a message queued and then
  // NOTHING - exactly the "where did it go" hole this view exists to close.
  "wa-send-expired": "send-expired",
  "wa-send-stale": "send-stale",
  "claim-lost": "claim-lost",
  "claim-error": "claim-error",
  // I1: the failure classes the owner previously proved with screenshots.
  "inbound-dropped": "inbound-dropped",
  "rfq-drift": "drift",
  "rfq-drift-blocked": "drift",
  "vision-check": "vision",
  "vision-empty": "vision",
  "vision-parse-failed": "vision",
  "vision-sanity-nulled": "vision",
  "vision-truncated": "vision",
  "vision-unavailable": "vision",
  "media-fetch-failed": "media",
  "media-unreadable": "media",
  "localize-fallback": "localize",
  "engine-v3-turn": "engine-turn",
  "host-geo-mismatch": "transport",
  // Wave 1: kinds that previously existed but were invisible here (no join
  // columns) or did not exist at all. Every one now writes user_email +
  // to_number, so the trail's per-thread fetch finds them.
  "funnel-stage": "funnel",
  "send-failed": "send-failed",
  "human-takeover": "takeover",
  "human-handback": "takeover",
};

/** The agent_events kinds the trail fetches - derived from the map above so
 *  the filter and the stage labels can never drift apart. */
const EVENT_KINDS = Object.keys(EVENT_STAGE).join(",");

export async function messagePath(opts: {
  senderKey: string;
  toDigits: string;
  /** Bound each source read; the merged trail is capped at 4x this. */
  limit?: number;
}): Promise<MessagePath> {
  const limit = Math.max(10, Math.min(200, opts.limit ?? 60));
  const digits = waDigits(opts.toDigits) || opts.toDigits;
  const enc = encodeURIComponent;
  let degraded = false;
  const failing = <T>(p: Promise<T[]>): Promise<T[]> =>
    p.catch(() => {
      degraded = true;
      return [] as T[];
    });

  // 1. The stored conversation - both directions, receiver/sender scoped.
  const inbound = failing(
    sbSelect<{ body: string | null; type: string; raw: Record<string, unknown> | null; received_at: string }>(
      "whatsapp_messages",
      `select=body,type,raw,received_at&direction=eq.inbound${numberFilter("from_number", digits)}` +
        `&raw->>receiver=eq.${enc(opts.senderKey)}&order=received_at.desc&limit=${limit}`
    )
  );
  const outbound = failing(
    sbSelect<{ body: string | null; type: string; raw: Record<string, unknown> | null; received_at: string }>(
      "whatsapp_messages",
      `select=body,type,raw,received_at&direction=eq.outbound${numberFilter("to_number", digits)}` +
        `&raw->>sender=eq.${enc(opts.senderKey)}&order=received_at.desc&limit=${limit}`
    )
  );

  // 2. What is queued RIGHT NOW (current state, not history).
  const pending = failing(
    sbSelect<{ id: number; body: string; not_before: string; meta: Record<string, unknown> | null; created_at: string }>(
      "wa_outbox",
      `select=id,body,not_before,meta,created_at&sender_key=eq.${enc(opts.senderKey)}` +
        `${numberFilter("to_number", digits)}&order=created_at.desc&limit=${limit}`
    )
  );

  // 3. The append-only trail: holds, attempts, drops, unconfirmed, parks.
  //    to_number is the new indexed column; vendor_name ("+digits") is the
  //    degraded spelling older rows carry.
  const events = failing(
    sbSelect<{ kind: string; detail: string | null; created_at: string; to_number?: string | null }>(
      "agent_events",
      `select=kind,detail,created_at,to_number&user_email=eq.${enc(opts.senderKey)}` +
        `&kind=in.(${EVENT_KINDS})` +
        `&or=(to_number.eq.${enc(digits)},vendor_name.eq.${enc("+" + digits)})` +
        `&order=created_at.desc&limit=${limit}`
    )
  );

  // 4. Scheduled follow-ups still armed for this thread.
  const wakeups = failing(
    sbSelect<{ kind: string; not_before: string; created_at: string }>(
      "graph_wakeups",
      `select=kind,not_before,created_at&thread_key=eq.${enc(`${opts.senderKey}:${digits}`)}` +
        `&order=not_before.asc&limit=${limit}`
    )
  );

  const [inb, outb, pend, evs, wks] = await Promise.all([inbound, outbound, pending, events, wakeups]);

  const steps: PathStep[] = [];
  for (const m of inb) {
    const transcript = (m.raw as { transcript?: { text?: string } } | null)?.transcript;
    steps.push({
      at: m.received_at,
      stage: "inbound",
      detail: transcript?.text ? `${m.body ?? ""} - transcript: ${transcript.text}` : m.body ?? "",
      raw: { type: m.type },
    });
  }
  for (const m of outb) {
    const raw = (m.raw ?? {}) as { confirmed?: boolean; kind?: string; decisionId?: string };
    steps.push({
      at: m.received_at,
      stage: "outbound",
      detail: m.body ?? "",
      raw: {
        type: m.type,
        confirmed: raw.confirmed ?? null,
        kind: raw.kind ?? null,
        decisionId: raw.decisionId ?? null,
      },
    });
  }
  for (const q of pend) {
    steps.push({
      at: q.created_at,
      stage: "queued",
      detail: `queued until ${q.not_before}${q.meta?.reason ? ` - ${String(q.meta.reason)}` : ""}`,
      raw: { outboxRowId: q.id, body: q.body, notBefore: q.not_before },
    });
  }
  for (const e of evs) {
    let raw: Record<string, unknown> | undefined;
    try {
      raw = e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : undefined;
    } catch {
      raw = undefined;
    }
    // A funnel transition reads as a sentence, not a JSON blob: the trail is
    // the owner's forensic view and "understood -> price_received (shop quoted
    // a grounded price)" answers the question directly.
    const funnelLine =
      e.kind === "funnel-stage" && raw && typeof raw.to === "string"
        ? `${raw.from ?? "(start)"} -> ${raw.to}${raw.evidence ? ` (${String(raw.evidence)})` : ""}`
        : undefined;
    steps.push({
      at: e.created_at,
      stage: EVENT_STAGE[e.kind] ?? "hold",
      detail: funnelLine ?? (raw?.reason ? String(raw.reason) : e.detail ?? e.kind),
      raw,
    });
  }
  for (const w of wks) {
    steps.push({
      at: w.created_at,
      stage: "wakeup",
      detail: `${w.kind} armed for ${w.not_before}`,
      raw: { notBefore: w.not_before },
    });
  }

  steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { senderKey: opts.senderKey, toDigits: digits, steps, degraded };
}
