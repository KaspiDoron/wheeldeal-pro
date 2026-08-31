// Per-thread negotiation state - the engine's durable checkpoint between
// serverless invocations. Supabase table `negotiation_threads` when available,
// with a process-global in-memory fallback so the engine keeps working before
// the migration ran (golden rule: everything degrades gracefully).

import type { ExtractedOffer } from "../agents";
import { digitsOnly } from "../phone";
import { boundedSet } from "../bounded-map";
import type { VehicleConfirmationState } from "../vehicle/confirmation";
import type {
  FulfillmentKind,
  NegotiationThreadState,
  ThreadFields,
  ThreadPhase,
} from "./types";

export function threadKeyFor(userEmail: string | undefined, toDigits: string): string {
  return `${userEmail ?? "system"}:${digitsOnly(toDigits)}`;
}

export function newThreadState(args: {
  threadKey: string;
  userEmail?: string;
  vendorId?: string;
  vendorName?: string;
  toNumber: string;
}): NegotiationThreadState {
  return {
    threadKey: args.threadKey,
    userEmail: args.userEmail ?? "system",
    vendorId: args.vendorId ?? "",
    vendorName: args.vendorName ?? "",
    toNumber: args.toNumber,
    phase: "opening",
    version: 0,
    fields: { firmCount: 0, toneDegraded: false, rounds: 0 },
    nodeRuns: {},
    waitingUntil: null,
    updatedAt: new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Deal completeness
// ---------------------------------------------------------------------------

export function priceKnown(f: ThreadFields): boolean {
  return typeof f.pricePerDay === "number" && f.pricePerDay > 0;
}

export function depositKnown(f: ThreadFields): boolean {
  return Boolean(f.depositType) || Boolean(f.depositNote);
}

export function fulfillmentKnown(f: ThreadFields): boolean {
  return f.fulfillment === "pickup" || f.fulfillment === "delivery" || f.fulfillment === "on-shop";
}

/** A deal may be PRESENTED only when all three pillars are known. */
export function dealComplete(f: ThreadFields): boolean {
  return priceKnown(f) && depositKnown(f) && fulfillmentKnown(f);
}

export function missingFields(f: ThreadFields): ("price" | "deposit" | "fulfillment")[] {
  const out: ("price" | "deposit" | "fulfillment")[] = [];
  if (!priceKnown(f)) out.push("price");
  if (!depositKnown(f)) out.push("deposit");
  if (!fulfillmentKnown(f)) out.push("fulfillment");
  return out;
}

/** Phase derived from the fields - a pure projection, never stored stale. */
export function derivePhase(state: NegotiationThreadState): ThreadPhase {
  const f = state.fields;
  if (state.phase === "closed" || state.phase === "dead" || state.phase === "closing") {
    return state.phase; // terminal-ish phases only move via explicit events
  }
  if (f.presented) return "presented";
  if (dealComplete(f)) return "complete";
  if (priceKnown(f) && (depositKnown(f) || fulfillmentKnown(f) || f.rounds > 0)) {
    return depositKnown(f) && fulfillmentKnown(f) ? "complete" : "collecting_terms";
  }
  if (priceKnown(f)) return "negotiating";
  return state.nodeRuns["clarify"] || state.nodeRuns["answer"] ? "awaiting_price" : "opening";
}

/**
 * Lightweight state-machine sanity: is this phase move structurally legal?
 * NEVER blocks (behavior unchanged) - illegal jumps are recorded as
 * `phase-anomaly` events so the "deal settled but still bargaining/queued"
 * class of bug is caught structurally instead of per-symptom.
 */
export function validatePhaseTransition(from: string, to: string): boolean {
  if (from === to) return true;
  // Terminal phases never reopen implicitly (a NEW session starts a new
  // thread lifecycle; that path resets state explicitly).
  if (from === "closed" || from === "dead") return false;
  // Closing may only settle, complete or present - never resume bargaining.
  if (from === "closing") {
    return to === "closed" || to === "complete" || to === "presented";
  }
  return true;
}

// ---------------------------------------------------------------------------
// Applying an extraction to the state (the ONLY place inbound facts land)
// ---------------------------------------------------------------------------

/**
 * Merge a freshly-resolved vehicle confirmation onto whatever the thread
 * already held. CONFIRMED NEVER REGRESSES, and the ask-once latch survives even
 * when the rest of the state does not: a later vehicle-less price update
 * ("1100b./6days") must not un-confirm a thread or make the confirm question
 * legal again.
 *
 * Extracted so the two writers cannot drift. It used to be inline here, in the
 * graph engine's write path - the only path that persisted it - and that engine
 * effectively never runs (`engineV3Enabled` returns true even when config is
 * unreadable), so in practice the fact was resolved every turn and stored on
 * none of them.
 */
export function mergeVehicleConfirmation(
  prev: VehicleConfirmationState | undefined,
  next: VehicleConfirmationState
): VehicleConfirmationState {
  if (prev?.status !== "confirmed" || next.status === "confirmed") return next;
  return next.askedAt && !prev.askedAt ? { ...prev, askedAt: next.askedAt } : prev;
}

/**
 * Persist ONLY the vehicle confirmation for a thread (W-15).
 *
 * The thread forgot that it had already asked. `resolveConfirmation` reads
 * `prev` out of `negotiation_threads.fields.vehicleConfirmation`, and the sole
 * writer of that field was `applyExtractionToState`, called only from the graph
 * engine - which the SPTE route makes unreachable on an ordinary turn. So `prev`
 * was null on every single turn, and the ask-once latch could only survive while
 * the confirm question was still our MOST RECENT outbound. One bargain later it
 * was gone, `vehicleAsked` read false again, and the engine re-asked a question
 * the shop had already answered - the loop the owner watched.
 *
 * Deliberately narrow: it writes one field and touches nothing else, so it is
 * safe to call from the inbound path regardless of which engine then runs. The
 * engine's own full save merges through `mergeVehicleConfirmation` and cannot
 * undo it.
 */
export async function saveVehicleConfirmation(
  args: {
    threadKey: string;
    userEmail?: string;
    vendorId?: string;
    vendorName?: string;
    toNumber: string;
  },
  conf: VehicleConfirmationState
): Promise<void> {
  const prior = await loadThreadState(args.threadKey).catch(() => null);
  const state = prior ?? newThreadState(args);
  const merged = mergeVehicleConfirmation(state.fields.vehicleConfirmation, conf);
  // Nothing to say: do not burn a version bump (and a write) on a no-op.
  if (
    state.fields.vehicleConfirmation &&
    merged.status === state.fields.vehicleConfirmation.status &&
    merged.askedAt === state.fields.vehicleConfirmation.askedAt
  ) {
    return;
  }
  await saveThreadState({
    ...state,
    fields: { ...state.fields, vehicleConfirmation: merged },
  });
}

export function applyExtractionToState(
  state: NegotiationThreadState,
  extraction: ExtractedOffer | null,
  usablePrice: number | undefined,
  currency: string
): NegotiationThreadState {
  if (!extraction) return state;
  const f = { ...state.fields };

  // Thread-level vehicle confirmation: resolved once per turn in agent-loop
  // and carried on the extraction; persisted here AND, since W-15, directly by
  // the inbound path (saveVehicleConfirmation) so it survives on threads this
  // engine never touches. Confirmed never regresses.
  if (extraction.vehicleConfirmation) {
    f.vehicleConfirmation = mergeVehicleConfirmation(
      f.vehicleConfirmation,
      extraction.vehicleConfirmation
    );
  }

  if (usablePrice && usablePrice > 0) {
    f.pricePerDay = usablePrice;
    f.currency = currency;
    f.priceVerified = Boolean(
      extraction.found &&
        extraction.matchesSpec &&
        extraction.confidence === "high" &&
        // VERIFIED also means the VEHICLE is established - matchesSpec alone
        // stopped meaning that when unconfirmed prices became real offers.
        (!extraction.vehicleAssessment || extraction.vehicleAssessment.status === "confirmed")
    );
    // A PRINTED price list is a firmer anchor than a spoken quote - remember
    // the listed price so the bargaining ladder keeps its asks credible
    // (deep lowballs against a posted board kill deals).
    if (extraction.imageKind === "price_sheet") f.sheetPricePerDay = usablePrice;
  }
  if (extraction.depositType) {
    f.depositType = extraction.depositType;
    if (typeof extraction.depositAmount === "number") f.depositAmount = extraction.depositAmount;
    f.depositCurrency = extraction.depositCurrency ?? f.currency;
  }
  if (extraction.deposit) f.depositNote = extraction.deposit;

  // Fulfillment: explicit statements only, never guessed. Delivery wins over
  // on-shop when both appear ("no delivery... ok we deliver for 100" edge is
  // resolved by the LAST reply re-running this).
  if (extraction.pickupOffered === true) {
    f.pickupOffered = true;
    if (!f.fulfillment) f.fulfillment = "pickup";
  }
  if (extraction.delivers === true) f.fulfillment = "delivery";
  else if (extraction.onShopOnly === true && f.fulfillment !== "delivery") f.fulfillment = "on-shop";
  else if (extraction.delivers === false && !f.fulfillment && !f.pickupOffered) {
    f.fulfillment = "on-shop";
  }
  if (typeof extraction.deliveryFee === "number") f.deliveryFee = extraction.deliveryFee;

  // Extract-everything media memory: what a photo showed once stays known
  // (mileage and scratches become honest bargaining leverage later).
  if (typeof extraction.mileageKm === "number" && extraction.mileageKm > 0) {
    f.mileageKm = extraction.mileageKm;
  }
  if (extraction.conditionNotes) f.conditionNotes = extraction.conditionNotes.slice(0, 200);
  if (extraction.imageSummary) f.mediaSummary = extraction.imageSummary.slice(0, 500);

  // "Last price / cannot lower" only counts as FIRM when the shop is
  // defending a price we actually know. A firm-sounding line BEFORE any quote
  // ("cannot lower, last price" with no number yet) must not end the bargain
  // before it started - that exact case froze a 300-vs-160-floor negotiation.
  if (extraction.shopFirm === true && f.pricePerDay) f.firmCount = (f.firmCount ?? 0) + 1;
  if (extraction.shopTone === "annoyed") f.toneDegraded = true;
  // The shop walked away ("take it there") - the negotiation is OVER. One warm
  // goodbye at most, then silence; the UI shows the thread as declined.
  if (extraction.shopDeclined === true) f.declined = true;

  // OUT OF STOCK, both ways. Resolved in agent-loop from the thread's own
  // availability claims, so the shop's LAST word wins: "we have one now" sets
  // it back to false on its own and the card un-sticks with no special case.
  if (typeof extraction.shopUnavailable === "boolean") {
    f.shopUnavailable = extraction.shopUnavailable;
    f.restockHint = extraction.shopUnavailable ? extraction.restockHint : undefined;
  }

  // RE-ENGAGEMENT (winnable-deal recovery): a thread we treated as dead /
  // declined is NOT permanently over if the shop later comes back with a
  // concrete new price ("ok ok, 250 is fine, come"). A fresh usable NUMBER on
  // a dead/declined thread is a strong re-engagement signal (never a bare tick
  // or greeting), so clear the decline and let the phase re-derive from the
  // fresh facts. A WON deal (phase "closed") is never reopened this way.
  // Guard on the PRIOR state (state.fields.declined / state.phase), never the
  // f.declined we may have just set above - otherwise a fresh decline that
  // arrives WITH a number would instantly un-decline itself.
  const wasDead = state.phase === "dead" || state.fields.declined === true;
  const reengaged = typeof usablePrice === "number" && usablePrice > 0 && wasDead && state.phase !== "closed";
  if (reengaged) f.declined = false;

  const next = { ...state, fields: f };
  if (reengaged && next.phase === "dead") next.phase = "negotiating";
  next.phase = derivePhase(next);
  return next;
}

// ---------------------------------------------------------------------------
// Storage - Supabase first, process-memory fallback
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __wd_graph_threads__: Map<string, NegotiationThreadState> | undefined;
}

function mem(): Map<string, NegotiationThreadState> {
  if (!globalThis.__wd_graph_threads__) globalThis.__wd_graph_threads__ = new Map();
  return globalThis.__wd_graph_threads__;
}

interface Row {
  thread_key: string;
  user_email: string;
  vendor_id: string | null;
  vendor_name: string | null;
  to_number: string;
  phase: string;
  version: number;
  fields: ThreadFields | null;
  node_runs: Record<string, number> | null;
  waiting_until: string | null;
  last_decision_id: string | null;
  updated_at: string;
}

function fromRow(r: Row): NegotiationThreadState {
  return {
    threadKey: r.thread_key,
    userEmail: r.user_email,
    vendorId: r.vendor_id ?? "",
    vendorName: r.vendor_name ?? "",
    toNumber: r.to_number,
    phase: (r.phase as ThreadPhase) || "opening",
    version: r.version ?? 0,
    fields: { firmCount: 0, toneDegraded: false, rounds: 0, ...(r.fields ?? {}) },
    nodeRuns: r.node_runs ?? {},
    waitingUntil: r.waiting_until,
    lastDecisionId: r.last_decision_id ?? undefined,
    updatedAt: r.updated_at,
  };
}

export async function loadThreadState(
  threadKey: string
): Promise<NegotiationThreadState | null> {
  try {
    const { sbSelect } = await import("../runtime-config");
    const rows = await sbSelect<Row>(
      "negotiation_threads",
      `select=*&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
    );
    if (rows[0]) return fromRow(rows[0]);
  } catch {
    /* table missing / Supabase unset - memory fallback below */
  }
  return mem().get(threadKey) ?? null;
}

/**
 * Optimistic save: UPDATE ... WHERE version = n. On a lost race the engine's
 * other protections (wa_processed claim, guardOutbound dedupe) already prevent
 * a double send; we re-read and merge counters so nothing is under-counted.
 */
export async function saveThreadState(state: NegotiationThreadState): Promise<void> {
  const next: NegotiationThreadState = {
    ...state,
    version: state.version + 1,
    updatedAt: new Date().toISOString(),
  };
  // Bounded fallback cache: cap at 2000 threads so a long-lived process cannot
  // grow one state object per distinct conversation forever (Supabase is the
  // authoritative store; an evicted cold thread is re-read on next access).
  boundedSet(mem(), state.threadKey, next, 2000);
  try {
    const { sbSelect, sbInsert, sbUpdate } = await import("../runtime-config");
    const row = {
      thread_key: next.threadKey,
      user_email: next.userEmail,
      vendor_id: next.vendorId,
      vendor_name: next.vendorName,
      to_number: next.toNumber,
      phase: next.phase,
      version: next.version,
      fields: next.fields,
      node_runs: next.nodeRuns,
      waiting_until: next.waitingUntil ?? null,
      last_decision_id: next.lastDecisionId ?? null,
      updated_at: next.updatedAt,
    };
    const existing = await sbSelect<{ version: number; phase: string }>(
      "negotiation_threads",
      `select=version,phase&thread_key=eq.${encodeURIComponent(next.threadKey)}&limit=1`
    );
    if (existing.length === 0) {
      await sbInsert("negotiation_threads", [row]);
      return;
    }
    // Structural sanity (free - piggybacks on the version read): an illegal
    // phase jump is logged, never blocked.
    if (existing[0].phase && !validatePhaseTransition(existing[0].phase, next.phase)) {
      await sbInsert("agent_events", [
        {
          kind: "phase-anomaly",
          vendor_id: next.vendorId,
          vendor_name: next.vendorName,
          detail: `Thread ${next.threadKey} jumped ${existing[0].phase} -> ${next.phase} (structurally illegal - investigate).`,
        },
      ]).catch(() => {});
    }
    // Optimistic write - only wins if nobody else bumped the version.
    await sbUpdate(
      "negotiation_threads",
      `thread_key=eq.${encodeURIComponent(next.threadKey)}&version=eq.${state.version}`,
      row
    );
    // Lost race? Merge counters with the winner (max of each) - counters only
    // ever grow, so max is the safe union; a doubled counter is safer than an
    // under-count (it can only make the agent MORE polite, never pushier).
    const after = await sbSelect<Row>(
      "negotiation_threads",
      `select=*&thread_key=eq.${encodeURIComponent(next.threadKey)}&limit=1`
    );
    if (after[0] && after[0].version !== next.version) {
      const winner = fromRow(after[0]);
      const nodeRuns = mergeCounters(winner.nodeRuns, next.nodeRuns);
      // RE-ENGAGEMENT survives the race, but CONSERVATIVELY: the winner's
      // decline is authoritative UNLESS our write carried an EXPLICIT
      // re-engagement (decline cleared AND a concrete price). This preserves a
      // genuine reopen ("shop came back with 250") without a stale concurrent
      // write (whose `declined` is merely unset) spuriously resurrecting a
      // thread the winner just killed. A WON (closed) deal is never touched.
      const nextReengaged =
        next.fields.declined === false &&
        typeof next.fields.pricePerDay === "number" &&
        next.fields.pricePerDay > 0;
      const declined = nextReengaged ? false : winner.fields.declined ?? false;
      const mergedFields = {
        ...winner.fields,
        firmCount: Math.max(winner.fields.firmCount ?? 0, next.fields.firmCount ?? 0),
        rounds: Math.max(winner.fields.rounds ?? 0, next.fields.rounds ?? 0),
        toneDegraded: winner.fields.toneDegraded || next.fields.toneDegraded,
        declined,
        // Carry the re-engagement price only when reopening and the winner has
        // none, so the fresh number is not lost - never overwrite a live price.
        pricePerDay: nextReengaged
          ? winner.fields.pricePerDay ?? next.fields.pricePerDay
          : winner.fields.pricePerDay,
        currency: winner.fields.currency ?? next.fields.currency,
        // THE DIGEST SURVIVES THE RACE TOO. `...winner.fields` above dropped
        // OUR whole digest - the standing quote, the pending confirms, the
        // durable comprehension, the once-flags - so a tick turn winning the
        // version erased what the concurrent inbound turn had just learned,
        // and the next turn re-asked the shop. Union rules in spte/digest.
        ...(winner.fields.digest || next.fields.digest
          ? {
              digest: (await import("../spte/digest")).mergeStoredDigests(
                winner.fields.digest,
                next.fields.digest
              ),
            }
          : {}),
      };
      const mergedPhase =
        nextReengaged && winner.phase === "dead"
          ? derivePhase({ ...winner, phase: "negotiating", fields: mergedFields, nodeRuns })
          : winner.phase;
      const merged: NegotiationThreadState = {
        ...winner,
        nodeRuns,
        fields: mergedFields,
        phase: mergedPhase,
        version: winner.version + 1,
      };
      await sbUpdate(
        "negotiation_threads",
        `thread_key=eq.${encodeURIComponent(next.threadKey)}&version=eq.${winner.version}`,
        {
          fields: merged.fields,
          node_runs: merged.nodeRuns,
          version: merged.version,
          phase: merged.phase,
          updated_at: new Date().toISOString(),
        }
      ).catch(() => {});
      mem().set(state.threadKey, merged);
    }
  } catch {
    /* Supabase unavailable - memory copy is already saved */
  }
}

function mergeCounters(
  a: Record<string, number>,
  b: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}
