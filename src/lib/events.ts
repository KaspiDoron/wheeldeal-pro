// THE AGENT_EVENTS KIND REGISTRY - one closed vocabulary for the telemetry
// spine (design-truth data model piece 3).
//
// The audit found the same defect five times over: a reader counting a kind
// nothing ever wrote (push-failed, push-skipped, human-takeover, turn-latency
// on the live path, judge scores), each rendering as a confident zero on an
// owner surface. The kinds lived as ~130 scattered string literals, so nothing
// could SAY "this reader has no writer". This registry is that missing
// statement: every kind written to agent_events is declared here, and
// events-reconcile.test.ts holds two properties against the source tree -
// every registered kind has writer evidence, and every kind a query reads is
// registered (and therefore written).
//
// Adding a kind: add it to the tuple, write it (prefer noteAgentEvent below,
// which stamps the join columns the message-path/KPI surfaces need), and the
// meta-test enforces the rest. Removing one: delete the writer first, then the
// readers, then the registry row - the test fails on any other order.
//
// wa_risk_events' RISK_KINDS (wa/risk-events.ts) stays separate: that table
// already has this discipline.

import { sbInsert } from "./runtime-config";

export const AGENT_EVENT_KINDS = [
  // ---- funnel & lifecycle ---------------------------------------------------
  "funnel-stage", // the stage ledger's transition history (funnel/stages.ts)
  "booking-stage", // the booking lifecycle's transition history (bookings.ts)
  "phase-anomaly", // structurally illegal engine phase jump (graph/state.ts)
  "wa-session-closed", // a linked WhatsApp session ended
  // ---- engine turns ---------------------------------------------------------
  "engine-v3-turn", // SPTE turn summary (metrics + clipped reasoning)
  "engine-v3-fallback", // SPTE threw pre-send; graph engine took the turn
  "engine-graph-turn", // the failover engine's own turn summary
  "turn-latency", // compose->outcome timing for the speed panel
  "reply-latency", // inbound->wire wall clock, stamped at the drain
  // ---- comprehension & pricing ----------------------------------------------
  "vague-reply", // reply understood as content-free
  "ambiguous-inbound", // could not attribute/parse an inbound frame
  "price-ungrounded", // extractor price absent from the shop's own words
  // The market floor resolved a different currency than the price of record,
  // so every price-sanity net on that thread is inert. Previously silent - and
  // it was silent for exactly the regions ("Ao Nang", "Krabi") whose bad prices
  // the nets were built for.
  "floor-currency-mismatch",
  "price-implausible", // sanity rail rejected a read price
  "price-reconciled", // divided-total corrected to a per-day rate
  "price-arbiter-odd", // the two extraction passes disagreed oddly
  "suspect-floor", // a floor price that looks like a parsing artifact
  "rival-hint-ignored", // leverage existed but the pass declined it
  "alternative-decision", // traveller answered a substitution choice
  "vision-check", // typed price vs price-sheet photo reconciliation
  "vision-empty", // photo read ran and found nothing readable
  "vision-parse-failed", // vision model answered, JSON did not parse
  "vision-truncated", // vision answer cut off at the token ceiling
  "vision-sanity-nulled", // vision price read and rejected as implausible
  "vision-unavailable", // whole vision provider ladder failed
  "image-batch-truncated", // more photos than the batch cap; tail unread
  "media-fetch-failed", // provider media redeem failed
  "media-unreadable", // media bytes fetched but unusable
  "reading-stamp-failed", // could not stamp the media reading onto the row
  // ---- outbound path --------------------------------------------------------
  "send-failed", // direct send failed (route path)
  "send-dropped", // outbound dropped pre-wire
  "outbound-log-failed", // message sent but the TRUTH-RULE row write failed
  "wa-hold", // guard queued/held a message, with the reason
  "wa-send-dropped", // drain gave up on a queued row (terminal)
  "wa-send-unconfirmed", // 2xx accepted, no delivery receipt
  "wa-send-stale", // parked reply no longer answers the thread
  "wa-send-expired", // queued row binned as too old
  "claim-lost", // send-slot claim lost to a concurrent sender
  "claim-error", // send-slot claim errored (store unreadable)
  "wa-park-failed", // could not park a row into the outbox
  // ---- inbound path ---------------------------------------------------------
  "inbound-dropped", // inbound stored nowhere / claim released
  "inbound-call", // the shop tried to CALL the traveller
  "inbound-risk", // safety screen flagged a reply
  "contact-suggested", // shop shared a contact card (suggestion only)
  "human-takeover", // traveller typed in the thread; agents stood down
  "human-handback", // traveller handed the thread back to the agents
  // ---- anti-ban & transport health ------------------------------------------
  "wa-ban-risk", // risk engine verdict on a sender
  "wa-opt-out", // a shop asked to stop; suppression recorded
  "wa-stop-loss", // stop-loss halted a sender's sends
  "wa-presence-failed", // presence mimicry call failed
  "wa-read-failed", // read-receipt call failed
  "wa-rep-bump-degraded", // reputation counter bump lost its columns
  "host-geo-mismatch", // number placed on a host declaring other regions
  "anchor-repaired", // thread anchor row reconstructed
  "rfq-drift", // stored RFQ diverged from the live request
  "rfq-drift-blocked", // drifted RFQ blocked from sending
  // ---- webhook & infra ------------------------------------------------------
  "webhook-ok", // Evolution webhook processed
  "webhook-403", // webhook rejected (bad token)
  "webhook-origin-override", // webhook re-arm changed the origin
  "webhook-orphan", // webhook event for an unknown instance
  "cron-ping", // scheduler heartbeat
  "retention-ran", // nightly prune heartbeat - WRITTEN BY supabase/retention.sql
  "engine-disabled", // both engines off by hand; reply stored but unanswered
  "ai-budget-exhausted", // provider budget refused an AI call
  "ai-chain-exhausted", // EVERY rung refused: the fleet is running deterministic
  "drain-budget-stop", // the drain hit its wall clock and left rows for the next run
  "claims-table-missing", // wa_send_claims absent: atomic pacing is inert
  "localize-fallback", // localization fell back to English
  "user-persist-failed", // user-profile write failed
  "booking-write-failed", // all booking insert tiers failed
  "vapid-autogen", // push keys were auto-generated
  // ---- push notifications ---------------------------------------------------
  "push-sent", // an interruption was spent
  "push-skipped", // the significance gate declined, with the reason
  "push-failed", // every attempted subscription rejected
  "push-collapse", // pushes collapsed/deduped
  "push-ingest", // push decision breadcrumb at ingest
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(AGENT_EVENT_KINDS);

export function isAgentEventKind(k: string): k is AgentEventKind {
  return KIND_SET.has(k);
}

/**
 * Write one agent_events row with the join columns ALWAYS stamped.
 *
 * The wa-send-dropped lesson, made structural: an event without
 * user_email/to_number is invisible to messagePath and every per-user surface,
 * so this helper refuses to let a caller forget them (empty string is an
 * explicit "genuinely not applicable", e.g. a fleet-wide webhook event - but
 * it must be SAID). Best-effort like every telemetry write: returns false,
 * never throws.
 */
export async function noteAgentEvent(e: {
  kind: AgentEventKind;
  userEmail: string;
  toNumber: string;
  vendorId?: string;
  vendorName?: string;
  decisionId?: string;
  detail?: string;
  handled?: boolean;
}): Promise<boolean> {
  if (!isAgentEventKind(e.kind)) return false; // JS callers exist; fail quiet, not loud
  return sbInsert("agent_events", [
    {
      kind: e.kind,
      user_email: e.userEmail,
      to_number: e.toNumber,
      vendor_id: e.vendorId ?? "",
      vendor_name: e.vendorName ?? "",
      ...(e.decisionId ? { decision_id: e.decisionId } : {}),
      ...(typeof e.handled === "boolean" ? { handled: e.handled } : {}),
      detail: (e.detail ?? "").slice(0, 2000),
    },
  ]).catch(() => false);
}
