import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { checkDailyLimit, recordApi, reserveDailyUnitFor } from "./usage";

// THE CAP GOVERNED ONE ROUTE; THE SPEND WAS EVERYWHERE ELSE.
//
// `LIMIT_AI_PER_DAY` was enforced at exactly one call site
// (`api/extract-offer/route.ts`). A grep for `checkDailyLimit` across
// `src/lib/spte/**`, `src/lib/graph/**`, `agent-loop.ts`, `ai.ts` and
// `orchestrator.ts` returned NOTHING - the negotiation engine, which is where
// virtually all of the token spend actually happens, had no per-user gate of
// any kind. One traveller running forty shops across several rounds each
// generated unbounded LLM cost while the owner's "AI calls per day" slider in
// Admin -> Limits reported that it was capped.
//
// WHY NOT JUST ADD checkDailyLimit AT EACH CALL SITE. Because that is how it
// ended up on one route: there are twenty-odd `chat()` callers across agents,
// nodes, judge, director, gaps, coherence, scenarios and the SPTE pass, and any
// new one silently opts out. The identity has to arrive at the choke point
// without every caller having to remember to carry it.
//
// So: one AsyncLocalStorage scope, opened once at the turn/request boundary.
// Every nested `chat()` inherits it with no signature change and no way to
// forget. (Node-only - the one `runtime = "edge"` route in this app is the
// banner image generator, which never touches the AI path.)
//
// COST OF THE GATE ITSELF. Checking the limit inside `chat()` would add a
// Supabase round trip per LLM call, and a single engine turn makes several. So
// the scope checks ONCE on open and debits ONCE on close, holding a local
// allowance in between. That also repairs a second-order defect: the codebase
// had ten `recordApi` call sites against five `checkDailyLimit` sites, so the
// gate and the debit were not even paired. Here they are the same object.

export interface AiBudgetScope {
  /** Who the spend belongs to. */
  who: string;
  /** False when they were already over the cap when the scope opened. */
  allowed: boolean;
  /** Calls still permitted inside THIS scope. Decremented as they are made. */
  remaining: number;
  /** Calls actually made, debited when the scope closes. */
  spent: number;
  /** The cap in force, so the per-call atomic reservation knows the ceiling. */
  limit: number;
  /** Set once, so a turn that exhausts its budget explains itself only once. */
  reportedExhausted?: boolean;
}

const storage = new AsyncLocalStorage<AiBudgetScope>();

/** The scope for the current async context, or undefined when ungoverned. */
export function currentAiBudget(): AiBudgetScope | undefined {
  return storage.getStore();
}

/**
 * Reserve a call against the active scope.
 *
 * Returns `"ok"` when the call may proceed, `"over-cap"` when it may not, and
 * `"ungoverned"` when there is no scope - which is deliberately permissive, so
 * an un-wrapped path behaves exactly as it does today rather than failing shut
 * on a code path nobody has migrated yet. Every governed path is opt-IN.
 */
export async function reserveAiCall(): Promise<"ok" | "over-cap" | "ungoverned"> {
  const scope = storage.getStore();
  if (!scope) return "ungoverned";
  if (!scope.allowed || scope.remaining <= 0) return "over-cap";

  // THE ATOMIC HALF. The in-scope allowance above is per-TURN and cannot see a
  // second turn for the same traveller running concurrently - a burst of shop
  // replies is exactly that. `reserveDailyUnitFor` is a Redis INCR, so parallel
  // turns get distinct totals and only one can cross the line. Without Redis it
  // returns true and the local allowance is all there is, which is the
  // pre-existing behaviour, documented rather than hidden.
  const ok = await reserveDailyUnitFor("ai", scope.who, scope.limit);
  if (!ok) {
    scope.remaining = 0; // the rest of this turn composes deterministically
    return "over-cap";
  }

  scope.remaining -= 1;
  scope.spent += 1;
  return "ok";
}

/**
 * Run `fn` with a per-user AI budget in scope.
 *
 * The gate is checked once here and the debit written once at the end, so a
 * multi-call turn costs one read and one write rather than one of each per
 * call.
 *
 * NEVER THROWS AND NEVER BLOCKS THE WORK ITSELF. An over-cap scope still runs
 * `fn` - it simply refuses the model calls inside it, and the engine's
 * deterministic composer takes over exactly as it does when no provider key is
 * configured. That is the graceful degradation this app is built on: a
 * traveller who exhausts their AI allowance keeps a working (template-driven)
 * negotiation rather than a frozen one.
 *
 * `who` empty (an unauthenticated or system path) runs ungoverned, since there
 * is no one to bill.
 */
export async function runWithAiBudget<T>(who: string, fn: () => Promise<T>): Promise<T> {
  const email = String(who ?? "").trim();
  if (!email) return await fn();

  let gate: Awaited<ReturnType<typeof checkDailyLimit>>;
  try {
    // Plan-aware (W-beta30): webhook-side turns have no session, so the plan
    // comes from the durable user row (10s cache in access.ts - one cheap
    // lookup per turn, not per model call). Invited testers have their plan
    // PINNED there at login, so the tester who rides Ultra gets Ultra's 4x
    // AI allowance instead of templating out mid-hunt at the free cap.
    let plan: string | null = null;
    try {
      const { getUser, normalizePlan } = await import("./access");
      plan = normalizePlan((await getUser(email))?.plan);
    } catch {
      /* plan lookup is best-effort; the free base still governs */
    }
    // PEEK, do not consume. This scope reserves one unit per actual model call
    // below; taking one here as well would bill a turn that made none.
    gate = await checkDailyLimit("ai", email, "LIMIT_AI_PER_DAY", { reserve: false, plan });
  } catch {
    // checkDailyLimit already fails CLOSED on an unreadable count, so reaching
    // here means something unexpected. Do not invent a verdict: run ungoverned
    // rather than silently halting every negotiation in the fleet.
    return await fn();
  }

  const scope: AiBudgetScope = {
    who: email,
    allowed: gate.allowed,
    remaining: gate.allowed ? Math.max(0, gate.limit - gate.used) : 0,
    spent: 0,
    limit: gate.limit,
  };

  // THE DEGRADATION WAS INVISIBLE, WHICH IS THE HALF THAT MATTERS AT SCALE.
  //
  // Past the ceiling every model call in this turn falls to the deterministic
  // composer. That is the right behaviour - a working template negotiation
  // beats a frozen one - but until now NOTHING recorded that it happened. The
  // tester's experience is "the agent got stupid halfway through the hunt" and
  // the owner's experience is a dashboard that looks entirely healthy.
  //
  // The arithmetic says this is reachable by ONE tester in ONE day: a shop
  // reply burns 2-6 model calls (extraction, gloss, safety, the engine pass,
  // localization, the judge), so a 20-shop hunt at three rounds is 120-360
  // calls plus the openers - i.e. the upper half of a single enthusiastic
  // hunt already crosses 300. The cap is per-USER, so it is not a fleet
  // ceiling that 100 testers share; the free providers' own daily RPD is that,
  // and it is roughly an order of magnitude tighter. Raising this number would
  // move the wall, not remove it - so it stays, and it becomes VISIBLE.
  if (!gate.allowed) noteAiBudgetExhausted(email, gate.limit);

  try {
    return await storage.run(scope, fn);
  } finally {
    // Debit what was actually spent, once. Best-effort: losing the debit is a
    // billing inaccuracy, while throwing here would fail a negotiation turn
    // that has already happened.
    if (scope.spent > 0) {
      await recordApi("ai", scope.spent, email).catch(() => {});
    }
  }
}

// One event per user per day: the condition persists for the rest of the day
// by definition, so an un-throttled trace would write one row per model call
// for hours.
const aiExhaustedNotedOn = new Map<string, string>();

function noteAiBudgetExhausted(email: string, limit: number): void {
  const day = new Date().toISOString().slice(0, 10);
  if (aiExhaustedNotedOn.get(email) === day) return;
  aiExhaustedNotedOn.set(email, day);
  void (async () => {
    try {
      const { sbInsert } = await import("./runtime-config");
      await sbInsert("agent_events", [
        {
          kind: "ai-budget-exhausted",
          user_email: email,
          detail: `${email} hit LIMIT_AI_PER_DAY (${limit}) - every model call for the rest of today falls back to the deterministic composer. The negotiation keeps working; it stops being smart.`,
        },
      ]);
    } catch {
      /* best-effort: telemetry must never fail a negotiation turn */
    }
  })();
}
