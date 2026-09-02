// THE FUNNEL STAGE LEDGER - the single source of truth for "where is this
// conversation" (owner's 9-step funnel, design-truth data model piece 1).
//
// Before this module existed the question was answered THREE different ways:
// the client recomputed a 3-value messaged|active|offer rank from reply rows
// (which is how a sticker promoted a card to "pinning the price down"), the
// engine kept its own working `phase`, and the admin panels joined whatever
// they could reach. None of them agreed and none of them was durable. This
// ledger is ONE vocabulary, advanced by ONE function, stored in ONE place
// (`negotiation_threads.stage` for the current stage, an append-only
// `agent_events` kind='funnel-stage' row per transition for the history), so
// the traveller tracker, the Ops console and analytics all read the same fact.
//
// `derivePhase` (graph/state.ts) deliberately STAYS: phase is the engine's
// internal working state; the ledger is the funnel's truth. They answer
// different questions and a consistency test may compare them, but neither is
// derived from the other.
//
// CONCURRENCY DOCTRINE (copied from the proven advanceLead pattern,
// waba/leads.ts): all enforcement lives in the PostgREST PATCH filter, never
// in a read-then-write. Two webhooks for the same shop arrive concurrently
// often enough that a check-then-act would let a late `replied` overwrite a
// `price_received`, or resurrect a dead thread. The PATCH's WHERE clause names
// exactly the set of stages the transition is legal FROM; the row lock
// serializes racers and the loser's predicate re-evaluates against the
// winner's committed row - so exactly one caller advances, and only that
// caller writes the history event.

import { sbInsert, sbSelect, sbUpdateReturning } from "../runtime-config";
import { digitsOnly } from "../phone";
import { identityKey, numberFilter } from "../wa/phone-key";

/**
 * The progression vocabulary, in funnel order. Mapping to the owner's 9 steps:
 * Search + Shop Selection are session-scoped (the `searches` row + `selected`);
 * Initial Contact = contacted; Shop Response = replied/understood (the split
 * that ends the sticker->negotiating lie); Price Verification =
 * price_received/price_verified; Negotiation = negotiating; Deposit/Pickup =
 * terms_pending/terms_collected; Final Verification = verifying/shop_confirmed;
 * Completed = booked/completed.
 */
export const PROGRESSION_STAGES = [
  "selected", // traveller tapped Ask / mass-bargain included the shop - intent, not delivery
  "contact_queued", // the RFQ is parked in the outbox
  "contacted", // a confirmed outbound RFQ row exists (the repo's TRUTH RULE)
  "replied", // ANY inbound stored - honest about content-free replies
  "understood", // a vendor_replies row with at least one actionable fact
  "price_received", // a grounded price landed
  "price_verified", // offers.verified / vision-reconcile passed
  "negotiating", // first bargain went out (or a round advanced)
  "terms_pending", // we asked about deposit / fulfillment
  "terms_collected", // deposit AND fulfillment are known
  "verifying", // the verify-recap went to the shop
  "shop_confirmed", // the shop said yes to the recap
  "booked", // a booking row exists
  "completed", // the trip happened (booking lifecycle)
] as const;

/**
 * Lateral stages - each is a CLAIM about the thread, not a rung on the ladder,
 * and each names the evidence class that refutes it (see eligibleFrom):
 *   declined     - the shop refused. Refuted only by a real price (a shop that
 *                  quotes after "no" is negotiating, whatever it said first).
 *   out_of_stock - the vehicle is not available. Refuted ONLY by explicit
 *                  availability evidence (`unavailable:false` in a reply),
 *                  passed as opts.overridesOutOfStock - a mere greeting from
 *                  the shop does not restock it.
 *   unreachable  - the RFQ never got through (terminal send-drop). Only
 *                  enterable BEFORE any reply: once a shop has spoken, a later
 *                  dropped message is that message's problem, not the thread's.
 *   dead         - the session closed / expired around it. Hard terminal.
 */
export const LATERAL_STAGES = ["declined", "out_of_stock", "unreachable", "dead"] as const;

export type ProgressionStage = (typeof PROGRESSION_STAGES)[number];
export type LateralStage = (typeof LATERAL_STAGES)[number];
export type ThreadStage = ProgressionStage | LateralStage;

/** Stages nothing may ever leave. Enforced inside the PATCH filter on EVERY
 *  call, exactly like advanceLead's terminal list - never in a read. */
export const HARD_TERMINAL_STAGES: readonly ThreadStage[] = ["dead", "completed"];

const RANK: Record<ProgressionStage, number> = Object.fromEntries(
  PROGRESSION_STAGES.map((s, i) => [s, (i + 1) * 10])
) as Record<ProgressionStage, number>;

export function stageRank(stage: string | null | undefined): number | undefined {
  return stage && stage in RANK ? RANK[stage as ProgressionStage] : undefined;
}

export function isThreadStage(v: string | null | undefined): v is ThreadStage {
  return Boolean(
    v && (PROGRESSION_STAGES.includes(v as ProgressionStage) || LATERAL_STAGES.includes(v as LateralStage))
  );
}

export interface StageArgs {
  userEmail: string;
  toNumber: string;
  vendorId?: string;
  vendorName?: string;
  /** Joins the transition to the engine decision that caused it. */
  decisionId?: string;
  /** Which wire carried the evidence: 'evolution' | 'waba' | 'cloud'. */
  transport?: string;
  /** Which engine was driving: 'v3' | 'graph' | 'legacy'. */
  engine?: string;
}

export interface StageOptions {
  /**
   * Explicit availability evidence (the shop said the vehicle IS available -
   * `unavailable:false`, or the traveller booked it). The ONLY thing that lets
   * a transition leave out_of_stock; a greeting or an unrelated fact does not.
   */
  overridesOutOfStock?: boolean;
  /**
   * A traveller-initiated re-contact (a fresh Ask on a thread from an earlier
   * search). Lets the early stages (selected/contact_queued/contacted) re-enter
   * from later ones, because the funnel genuinely restarted - without this,
   * forward-only would freeze a re-contacted shop at last season's stage.
   * Restart never resurrects a hard terminal.
   */
  restart?: boolean;
}

/** The stages a transition to `to` is legal FROM (null = no stage yet is
 *  always legal, and is expressed in the filter, not in this set). Exported
 *  pure so the rules are unit-testable without a database. */
export function eligibleFrom(to: ThreadStage, opts: StageOptions = {}): ThreadStage[] {
  const all = [...PROGRESSION_STAGES, ...LATERAL_STAGES] as ThreadStage[];
  const nonTerminal = all.filter((s) => !HARD_TERMINAL_STAGES.includes(s));
  const toRank = stageRank(to);

  if (toRank !== undefined) {
    // Progression target: forward-only - strictly lower-ranked stages...
    const from = PROGRESSION_STAGES.filter((s) => RANK[s] < toRank) as ThreadStage[];
    // ...plus each lateral whose refuting evidence class this stage carries.
    if (toRank >= RANK.replied) from.push("unreachable"); // the shop spoke: reachable
    if (toRank >= RANK.price_received) from.push("declined"); // a price refutes a refusal
    if (opts.overridesOutOfStock) from.push("out_of_stock");
    // A restart re-opens the early rungs from anywhere non-terminal.
    if (opts.restart && toRank <= RANK.contacted) {
      for (const s of nonTerminal) if (!from.includes(s) && s !== to) from.push(s);
    }
    return from;
  }

  if (to === "unreachable") {
    // Only before any reply - a shop that has spoken is reachable by definition.
    return ["selected", "contact_queued", "contacted"];
  }
  // declined / out_of_stock / dead: enterable from anything non-terminal except
  // themselves (dead additionally may swallow the other laterals - a declined
  // thread still dies with its session).
  return nonTerminal.filter((s) => s !== to);
}

/** The PostgREST filter enforcing the whole rule set atomically. */
export function stageFilter(threadKey: string, to: ThreadStage, opts: StageOptions = {}): string {
  const from = eligibleFrom(to, opts);
  const key = encodeURIComponent(threadKey);
  // `stage=is.null` covers pre-ledger threads and freshly inserted rows; the
  // in-list is the eligible-from set. Hard terminals are excluded by simply
  // never being in the set - same effect as advanceLead's not.in list, stated
  // positively so a NEW stage added later is refused-by-default until a rule
  // names it.
  return `thread_key=eq.${key}&or=(stage.is.null,stage.in.(${from.join(",")}))`;
}

export interface StageAdvance {
  advanced: boolean;
  /** Why not, when not: 'already' (at/past target), 'refused' (filter said no),
   *  'unreadable' (store down), 'noop' (no email/number to key on). */
  reason?: "already" | "refused" | "unreadable" | "noop";
}

/**
 * Advance a thread's funnel stage. Never throws; a false result is a fact
 * ("this transition did not happen"), not an error to handle.
 *
 * Two writes through one door: (a) the current-stage PATCH, guarded entirely
 * in its filter; (b) one append-only history event, written ONLY by the
 * caller whose PATCH actually changed the row - so concurrent duplicate
 * evidence (every inbound calls this with 'replied') produces zero extra
 * events and zero extra PATCHes in steady state (the pre-read short-circuits).
 */
export async function advanceThreadStage(
  args: StageArgs,
  to: ThreadStage,
  evidence: string,
  opts: StageOptions = {}
): Promise<StageAdvance> {
  const email = (args.userEmail ?? "").trim();
  const digits = digitsOnly(args.toNumber ?? "");
  if (!email || !digits) return { advanced: false, reason: "noop" };
  // ONE SHOP, ONE THREAD KEY - whatever spelling the caller happens to hold.
  //
  // This used to be `${email}:${digitsOnly(toNumber)}`, and the two callers do
  // not agree on spelling: `contacted` is stamped with the number Google Places
  // gave us (often the NATIONAL form, 081236954642) while `replied` is stamped
  // with the number the inbound JID gave us (always INTERNATIONAL,
  // 6281236954642). thread_key is the primary key, so those produced TWO rows -
  // the outbound one carrying vendor_id and stuck at `contacted`, and a second,
  // vendor-less one at `replied` that no surface could join to a card. The
  // traveller saw a shop that had plainly answered still listed under
  // "Awaiting reply".
  //
  // identityKey (the national tail) survives country-code and leading-zero
  // variation, so both spellings now land on the same row.
  let threadKey = `${email}:${identityKey(args.toNumber) || digits}`;

  // Cheap pre-read: telemetry's `from`, plus the steady-state short-circuit
  // (an inbound-per-second thread must not PATCH-per-second). Enforcement does
  // NOT depend on this read - the filter re-checks everything atomically.
  let from: string | null | undefined;
  let rowExists = false;
  try {
    const rows = await sbSelect<{ stage: string | null }>(
      "negotiation_threads",
      `select=stage&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
    );
    rowExists = rows.length > 0;
    from = rows[0]?.stage ?? null;
    if (!rowExists) {
      // ADOPT A PRE-EXISTING ROW rather than splitting alongside it. Threads
      // created before the key was canonicalised still carry an exact-digits
      // key, and a shop can only ever have one. numberFilter matches every
      // spelling, so this finds it whichever side wrote it first; on a miss we
      // keep the canonical key and create the row below.
      const legacy = await sbSelect<{ thread_key: string; stage: string | null }>(
        "negotiation_threads",
        `select=thread_key,stage&user_email=eq.${encodeURIComponent(email)}` +
          `${numberFilter("to_number", args.toNumber)}&limit=1`
      );
      if (legacy[0]?.thread_key) {
        threadKey = legacy[0].thread_key;
        rowExists = true;
        from = legacy[0].stage ?? null;
      }
    }
  } catch {
    /* unreadable - fall through to the guarded PATCH, which fails closed */
  }
  if (from != null) {
    if (from === to) return { advanced: false, reason: "already" };
    const fromRank = stageRank(from);
    const toRank = stageRank(to);
    if (
      fromRank !== undefined &&
      toRank !== undefined &&
      fromRank >= toRank &&
      !(opts.restart && toRank <= RANK.contacted)
    ) {
      return { advanced: false, reason: "already" };
    }
    if (HARD_TERMINAL_STAGES.includes(from as ThreadStage)) {
      return { advanced: false, reason: "refused" };
    }
  }

  const nowIso = new Date().toISOString();
  let landed = false;

  if (!rowExists) {
    // The early stages (selected/contact_queued/contacted) fire before any
    // engine turn has created the thread row. A minimal insert makes the
    // ledger visible from the very first tap; the engine's state layer adopts
    // the row (its persist PATCHes columns it owns and never touches stage).
    // Plain insert, deliberately NOT merge-duplicates: on a lost creation race
    // the conflict fails the insert and we fall through to the guarded PATCH.
    landed = await sbInsert("negotiation_threads", [
      {
        thread_key: threadKey,
        user_email: email,
        to_number: digits,
        vendor_id: args.vendorId ?? null,
        vendor_name: args.vendorName ?? null,
        stage: to,
        stage_at: nowIso,
      },
    ]).catch(() => false);
  }

  if (!landed) {
    const rows = await sbUpdateReturning<{ thread_key: string }>(
      "negotiation_threads",
      stageFilter(threadKey, to, opts),
      { stage: to, stage_at: nowIso }
    ).catch(() => [] as { thread_key: string }[]);
    landed = rows.length > 0;
    if (!landed) {
      // [] is both "filter refused" and "store unreachable"; the pre-read
      // disambiguates well enough for a return code that is telemetry, not
      // control flow.
      return { advanced: false, reason: rowExists || from != null ? "refused" : "unreadable" };
    }
  }

  // THE THREAD'S WIRE, stamped at first delivered contact. Delivery is the
  // moment the transport stops being a plan (a dry-run or a refused WABA lead
  // falls back to Evolution; only the wire that actually carried the RFQ may
  // become the thread's immutable stamp). Write-once inside the helper - a
  // later TRANSPORT_MODE flip can never reroute a running conversation.
  if (to === "contacted") {
    const { isWireTransport, stampThreadTransport } = await import("../wa/transport-stamp");
    if (isWireTransport(args.transport)) {
      await stampThreadTransport(threadKey, args.transport).catch(() => false);
    }
  }

  // The history event - join columns as COLUMNS (the wa-send-dropped lesson:
  // events without user_email/to_number are invisible to messagePath), written
  // only on a real transition so history stays append-only AND bounded (~a
  // dozen rows per thread lifetime).
  await sbInsert("agent_events", [
    {
      kind: "funnel-stage",
      user_email: email,
      to_number: digits,
      vendor_id: args.vendorId ?? "",
      vendor_name: args.vendorName ?? "",
      decision_id: args.decisionId ?? null,
      detail: JSON.stringify({
        from: from ?? null,
        to,
        evidence: evidence.slice(0, 160),
        transport: args.transport,
        engine: args.engine,
        entry: nowIso,
      }),
    },
  ]).catch(() => false);

  // The consent-gated PROJECTION (W9): the same transition, into the typed
  // product_events dataset - only while this person's 'analytics' consent is
  // granted, and never allowed to fail the funnel write it rides on. Deliberate
  // shape choice: stage + transport + engine, no vendor identifiers - the
  // dataset is about the traveller's funnel, not the shop directory.
  void import("../privacy/product-events")
    .then(({ projectProductEvent }) =>
      projectProductEvent({
        email,
        stage: to,
        kind: "thread-stage",
        props: { from: from ?? null, transport: args.transport ?? null, engine: args.engine ?? null },
      })
    )
    .catch(() => {});

  return { advanced: true };
}
