// THE LEAD LEDGER - one row per handoff attempt, and the state machine it moves
// through. Plan Part 12.1.4 and 12.2.
//
// A lead is: this traveller wants to talk to this agency. Our official number
// asks the agency to message them; the agency does; the traveller's own number
// takes the negotiation from there. Every one of those steps can fail in a
// different way, and the whole point of this module is that each failure has a
// name, a row and a reason - never a silent drop.
//
// THE ONE MECHANIC EVERYTHING TURNS ON.
//
// Outside a 24h service window we may only send a pre-approved TEMPLATE, which
// is priced, metered against the portfolio tier, and subject to the per-user cap
// that produces error 131049. INSIDE an open window - opened by any inbound from
// that agency and restarted by every subsequent one - we may send FREE-FORM
// text: unlimited, free, and outside the tier entirely.
//
// So the cost and the risk of an agency are paid at most ONCE PER DAY, and
// popularity becomes cheap instead of ruinous:
//
//   Traveller 1 picks Agency A -> no window -> A gets the template.
//   Travellers 2..9 pick A in the same hour -> HELD, not dropped.
//   A replies to us -> window opens -> every held lead flushes as free-form.
//
// That is why `heldLeadsFor` and `openWindow` exist, and why "held" is a
// first-class user-visible state rather than an invisible queue. Part 5.5's
// finding stands: a shop dropped before the loop is counted nowhere and cannot
// be explained to the traveller.

import "server-only";
import { randomBytes } from "crypto";
import {
  sbInsertReturning,
  sbSelect,
  sbSelectStrict,
  sbUpdate,
  sbInsert,
} from "../runtime-config";
import { nationalTail } from "../wa/phone-key";

export type LeadState =
  | "draft"
  | "held"
  | "template_sent"
  | "handoff_sent"
  | "handed_off"
  | "expired"
  | "failed";

/** Terminal states never transition again. */
export const TERMINAL_STATES: readonly LeadState[] = ["handed_off", "expired", "failed"];

export interface Lead {
  id: number;
  state: LeadState;
  user_email: string;
  agency_tail: string;
  agency_number: string;
  agency_name: string | null;
  session_id: string | null;
  lane: "template" | "freeform" | null;
  link_token: string | null;
  created_at: string;
  sent_at: string | null;
  agency_replied_at: string | null;
  traveller_inbound_at: string | null;
  handed_off_at: string | null;
  terminal_reason: string | null;
  /** Join to the conversation spine (user_email:agency_digits). Nullable on
   *  rows written before the migration. */
  thread_key?: string | null;
}

export interface AgencyState {
  agency_tail: string;
  window_expires_at: string | null;
  template_capped_until: string | null;
  last_template_at: string | null;
  /** COMPLIANCE GATE (owner decision, Meta Business Messaging Policy): a cold
   *  template may only go to a shop that opted in to WheelDeal leads. Null =
   *  never opted in = the WABA lane refuses and Evolution stays the lane. */
  opted_in_at?: string | null;
}

/**
 * Opaque, single-use, unguessable.
 *
 * Anyone who receives a forwarded template can tap the button, so the token must
 * not encode a phone number and must not be enumerable. 18 random bytes,
 * URL-safe.
 */
export function mintLinkToken(): string {
  return randomBytes(18).toString("base64url");
}

/** Append-only wire log. Best-effort: telemetry can never break a send. */
export async function noteWabaEvent(
  kind: string,
  fields: { leadId?: number; agencyTail?: string; errorCode?: number; raw?: unknown }
): Promise<void> {
  await sbInsert("waba_events", [
    {
      kind,
      lead_id: fields.leadId ?? null,
      agency_tail: fields.agencyTail ?? null,
      error_code: fields.errorCode ?? null,
      raw: fields.raw ?? null,
    },
  ]).catch(() => false);
}

// ---- Agency state ----------------------------------------------------------

/**
 * Read one agency's messaging state.
 *
 * STRICT, and an unreadable read is NOT treated as "no window, no cap". Both of
 * those defaults point the wrong way: with no window we would send a template
 * that may not be needed, and with no cap we would send one to a recipient we
 * have already capped today - burning quality rating on a message guaranteed
 * undeliverable. Unknown means DO NOT SEND.
 */
export async function agencyState(
  tail: string
): Promise<{ state: AgencyState | null; unreadable: boolean }> {
  const read = await sbSelectStrict<AgencyState>(
    "waba_agencies",
    // opted_in_at is deliberately NOT in this select: on an un-migrated DB an
    // unknown column would fail the WHOLE read and scramble the cooldown
    // machinery. The opt-in gate reads it separately (admitLead), where a
    // failed read is a REFUSAL - compliance fails closed on its own.
    `select=agency_tail,window_expires_at,template_capped_until,last_template_at&agency_tail=eq.${encodeURIComponent(
      tail
    )}&limit=1`
  );
  if ("error" in read) {
    return { state: null, unreadable: read.error === "unavailable" };
  }
  return { state: read.rows[0] ?? null, unreadable: false };
}

export function windowOpen(s: AgencyState | null, now = Date.now()): boolean {
  if (!s?.window_expires_at) return false;
  const t = Date.parse(s.window_expires_at);
  return Number.isFinite(t) && t > now;
}

export function templateAllowed(
  s: AgencyState | null,
  cooldownHours: number,
  now = Date.now()
): boolean {
  if (!s) return true;
  // 131049 cap set by the platform. Absolute - not a backoff we may shorten.
  if (s.template_capped_until) {
    const until = Date.parse(s.template_capped_until);
    if (Number.isFinite(until) && until > now) return false;
  }
  // Our own cooldown, the guard that keeps us clear of the platform cap in the
  // first place. Our ranking is a pure total order with no user-dependent term,
  // so every traveller in a district sees the SAME top agencies - without this,
  // the third traveller of the day is silently undelivered at exactly the shops
  // that matter most.
  if (s.last_template_at) {
    const last = Date.parse(s.last_template_at);
    if (Number.isFinite(last) && now - last < cooldownHours * 3600_000) return false;
  }
  return true;
}

/**
 * An inbound from the agency opens (or restarts) the 24h service window.
 *
 * This is the single highest-value write in the module: it is what converts an
 * agency from "costs a template and a cap slot" to "free, uncapped, instant" for
 * the next 24 hours.
 */
export async function openWindow(tail: string, number: string, now = Date.now()): Promise<void> {
  const expires = new Date(now + 24 * 3600_000).toISOString();
  await sbInsert(
    "waba_agencies",
    [
      {
        agency_tail: tail,
        agency_number: number,
        window_expires_at: expires,
        updated_at: new Date(now).toISOString(),
      },
    ],
    "agency_tail"
  ).catch(() => false);
}

/** Platform said this recipient is capped. Do NOT retry before it lifts.
 *  UPSERT, not PATCH: a 131049 can arrive for an agency that has no
 *  waba_agencies row yet (the async status path), and a PATCH on a
 *  nonexistent row 204s silently - the cap was never recorded and the
 *  governor kept choosing the capped agency. */
export async function markTemplateCapped(tail: string, hours = 24): Promise<void> {
  const now = new Date().toISOString();
  await sbInsert(
    "waba_agencies",
    [
      {
        agency_tail: tail,
        template_capped_until: new Date(Date.now() + hours * 3600_000).toISOString(),
        updated_at: now,
      },
    ],
    "agency_tail"
  ).catch(() => false);
}

export async function markTemplateSent(tail: string, number: string): Promise<void> {
  const now = new Date().toISOString();
  await sbInsert(
    "waba_agencies",
    [{ agency_tail: tail, agency_number: number, last_template_at: now, updated_at: now }],
    "agency_tail"
  ).catch(() => false);
}

// ---- Leads -----------------------------------------------------------------

export interface CreateLeadInput {
  userEmail: string;
  agencyNumber: string;
  agencyName?: string;
  sessionId?: string;
}

export async function createLead(input: CreateLeadInput): Promise<Lead | null> {
  const tail = nationalTail(input.agencyNumber);
  if (!tail) return null;
  const email = input.userEmail.trim().toLowerCase();
  const digits = input.agencyNumber.replace(/\D+/g, "");
  const row = {
    state: "draft",
    user_email: email,
    agency_tail: tail,
    agency_number: input.agencyNumber,
    agency_name: input.agencyName ?? null,
    session_id: input.sessionId ?? null,
    link_token: mintLinkToken(),
    // The join to the REAL conversation spine (negotiation_threads /
    // whatsapp_messages) - the dead search_sessions uuid could join nothing.
    thread_key: digits ? `${email}:${digits}` : null,
  };
  const rows = await sbInsertReturning<Lead>("waba_leads", [row]);
  if (rows[0]) return rows[0];
  // Pre-migration fallback: thread_key not yet migrated -> insert without it
  // (a lead must never be lost to a pending ALTER).
  const { thread_key: _tk, ...legacy } = row;
  const fallback = await sbInsertReturning<Lead>("waba_leads", [legacy]);
  return fallback[0] ?? null;
}

/**
 * Move a lead forward. Refuses to move a TERMINAL lead.
 *
 * The refusal is enforced in the FILTER, not in a read-then-write: two webhooks
 * for the same message arrive concurrently often enough that a check-then-act
 * would let a late `expired` overwrite a `handed_off` and un-hand-off a live
 * negotiation.
 */
export async function advanceLead(
  id: number,
  to: LeadState,
  fields: Record<string, unknown> = {}
): Promise<boolean> {
  const terminalList = TERMINAL_STATES.join(",");
  const ok = await sbUpdate(
    "waba_leads",
    `id=eq.${id}&state=not.in.(${terminalList})`,
    { state: to, ...fields }
  ).catch(() => false);
  if (ok) await noteWabaEvent("state", { leadId: id, raw: { to } });
  return ok;
}

/**
 * Leads waiting on this agency to open its window.
 *
 * These flush the moment an inbound arrives - which is the mechanism that makes
 * a popular agency cheap rather than expensive.
 */
export async function heldLeadsFor(tail: string): Promise<Lead[]> {
  const read = await sbSelectStrict<Lead>(
    "waba_leads",
    `select=*&agency_tail=eq.${encodeURIComponent(
      tail
    )}&state=in.(held,template_sent)&handed_off_at=is.null&order=created_at.asc&limit=100`
  );
  return "error" in read ? [] : read.rows;
}

/** Leads whose hold has run out and must take a fallback. */
export async function expiredHolds(now = Date.now()): Promise<Lead[]> {
  const cutoff = new Date(now - (await holdTimeoutMs())).toISOString();
  const read = await sbSelectStrict<Lead>(
    "waba_leads",
    `select=*&state=eq.held&created_at=lt.${encodeURIComponent(cutoff)}&limit=100`
  );
  return "error" in read ? [] : read.rows;
}

export async function holdTimeoutMs(): Promise<number> {
  const { getConfig } = await import("../runtime-config");
  const raw = Number(await getConfig("WABA_HOLD_TIMEOUT_MINUTES"));
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 25;
  return minutes * 60_000;
}

export async function agencyCooldownHours(): Promise<number> {
  const { getConfig } = await import("../runtime-config");
  const raw = Number(await getConfig("WABA_AGENCY_COOLDOWN_HOURS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

// ---- The admission decision ------------------------------------------------

export type Admission =
  | { lane: "freeform"; reason: "window-open" }
  | { lane: "template"; reason: "cold" }
  | { hold: true; reason: "agency-cooldown" | "recipient-capped" }
  | { refuse: true; reason: "unreadable" | "no-tail" | "not-opted-in" | "suppressed" };

/** Has this agency opted in to WheelDeal leads? FAILS CLOSED: an unreadable
 *  or un-migrated store reads as "not opted in", because the thing at stake is
 *  a Meta policy line, not a convenience. Cold templates to non-opted-in shops
 *  are the one thing this lane must be STRUCTURALLY unable to do. */
export async function agencyOptedIn(tail: string): Promise<boolean> {
  const rows = await sbSelect<{ opted_in_at: string | null }>(
    "waba_agencies",
    `select=opted_in_at&agency_tail=eq.${encodeURIComponent(tail)}&limit=1`
  ).catch(() => [] as { opted_in_at: string | null }[]);
  return Boolean(rows[0]?.opted_in_at);
}

/** Record a shop's opt-in (QR/wa.me inbound to the WABA, or the partner form). */
export async function recordAgencyOptIn(tail: string, number: string): Promise<boolean> {
  const now = new Date().toISOString();
  return sbInsert(
    "waba_agencies",
    [{ agency_tail: tail, agency_number: number, opted_in_at: now, updated_at: now }],
    "agency_tail"
  ).catch(() => false);
}

/**
 * Which lane may this lead use right now?
 *
 * One decision, taken in one place, so the two lanes can never both be chosen
 * and a caller can never accidentally send a template into an open window (which
 * would pay for something that is free).
 */
export async function admitLead(agencyNumber: string, now = Date.now()): Promise<Admission> {
  const tail = nationalTail(agencyNumber);
  if (!tail) return { refuse: true, reason: "no-tail" };

  // FLEET-WIDE SUPPRESSION FIRST (owner decision): a shop that told anyone at
  // WheelDeal to stop is not admitted on ANY lane, and the company number is
  // the lane where ignoring that is a policy strike on a shared asset.
  {
    const { shopSuppression } = await import("../wa/suppression");
    const sup = await shopSuppression(agencyNumber);
    if (sup.suppressed) return { refuse: true, reason: "suppressed" };
  }

  const { state, unreadable } = await agencyState(tail);
  // FAIL CLOSED. This is the opposite of the warm-up gate's direction and for
  // the opposite reason: here the asset at risk is a rented WABA shared by every
  // user at once, and a wrong send costs quality rating we cannot buy back.
  if (unreadable) return { refuse: true, reason: "unreadable" };

  if (windowOpen(state, now)) return { lane: "freeform", reason: "window-open" };

  // THE COMPLIANCE GATE (owner decision, Meta policy): outside an open window
  // the only remaining lane is a COLD TEMPLATE, and a cold template may only
  // go to a shop that opted in to WheelDeal leads. A shop that has never opted
  // in is not refused SERVICE - it is refused THIS LANE; the dispatcher maps
  // this to fallback-legacy so the traveller's own number contacts it as
  // always. Inside an open window the shop messaged US first - that inbound
  // IS the opt-in Meta's rules recognise, which is why the gate sits below
  // windowOpen.
  if (!(await agencyOptedIn(tail))) return { refuse: true, reason: "not-opted-in" };

  const cooldown = await agencyCooldownHours();
  if (!templateAllowed(state, cooldown, now)) {
    const capped =
      state?.template_capped_until &&
      Date.parse(state.template_capped_until) > now;
    return { hold: true, reason: capped ? "recipient-capped" : "agency-cooldown" };
  }
  return { lane: "template", reason: "cold" };
}
