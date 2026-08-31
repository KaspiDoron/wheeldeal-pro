// WHICH BRAIN ANSWERS THIS SHOP?
//
// There are two live negotiation engines and, until this file existed, two
// independent answers to that question.
//
// `processVendorReply` (agent-loop.ts) routed an INBOUND message to SPTE and
// kept the graph engine as an exception-only safety net. But a thread does not
// only move when the shop speaks: SPTE schedules its own follow-ups - the
// three-minute return on a quiet thread, the strategic wait before the next
// nudge - by writing a row into `graph_wakeups` with `payload.engine = "v3"`.
// Nothing ever read that field back. `drainGraphWakeups` called `runGraphTurn`
// unconditionally, so EVERY scheduled turn ran the older engine.
//
// That is not a rare corner. It is the second turn of every conversation that
// waits, and it is precisely the turn the recent negotiation fixes were written
// for: out-of-stock outranking a decline, a goodbye that cannot contain a
// price, one nudge at the session floor, momentum on a silent thread. All of
// them live in src/lib/spte/*. The wakeup ran the engine that has none of them,
// and told no one: SPTE writes `engine-v3-turn` telemetry, the graph engine
// wrote nothing, so the Ops dashboard showed a healthy stream of V3 turns while
// the follow-ups quietly used the pre-fix brain.
//
// So: ONE routing authority, used by every entry point. SPTE is the engine;
// the graph engine is the fallback for an SPTE that throws before it sends; and
// whichever one runs SAYS SO, so this can never again be invisible.

import type { GraphIO, GraphTurnInput } from "./graph/types";
import type { GraphTurnResult } from "./graph/engine";
import type { SpteLiveResult } from "./spte/live";

/** How the turn entered the system. Stamped on telemetry so a wakeup-driven
 *  turn is distinguishable from a reply-driven one in the Inspector. */
export type TurnEntry = "inbound" | "wakeup" | "user-action";

export interface ThreadTurnOutcome {
  /** Which engine actually composed this turn. */
  engine: "v3" | "graph" | "none";
  /** SPTE's own result, when SPTE ran. */
  spte?: SpteLiveResult;
  /** The graph engine's result, when IT ran (user actions + failover) - what
   *  runUserAction's callers read delivery state from. */
  graph?: GraphTurnResult;
  /** Why SPTE did not run, when it did not. */
  fallbackReason?: string;
}

/**
 * Run one negotiation turn through the live engine ladder.
 *
 * SPTE first (it holds every behavioural fix). If its pre-send build throws -
 * and it only ever throws BEFORE a message leaves, never after - fail over to
 * the graph engine so the shop still gets an answer. If both are switched off,
 * return `none` and let the caller decide (the legacy orchestrator path).
 *
 * `entry` is telemetry only: it never changes routing. Every entry point gets
 * the same brain, which is the whole point of this module.
 */
export async function runThreadTurn(
  input: GraphTurnInput,
  io: GraphIO,
  entry: TurnEntry = "inbound"
): Promise<ThreadTurnOutcome> {
  // USER ACTIONS ARE DISPATCHED, NOT FAILED OVER. The two user-action nodes
  // (pickup-consent, closing-message) exist only in the graph engine - SPTE
  // has no event kind for them, and pushing one through it would read the
  // action as an empty shop message and answer with silence: the traveller's
  // closing message would simply never send. This branch is the routing
  // authority SAYING that, in one place, instead of runUserAction quietly
  // bypassing the authority altogether (the TurnEntry "user-action" had zero
  // producers). When SPTE grows these moves, this branch is what moves.
  if (input.event.kind === "user-consent-pickup" || input.event.kind === "user-close-deal") {
    const { graphEngineEnabled, runGraphTurn } = await import("./graph/engine");
    if (await graphEngineEnabled()) {
      const graph = await runGraphTurn(input, io);
      await recordGraphTurn(io, input, "user-action", "user-action nodes live in the graph engine");
      return { engine: "graph", graph, fallbackReason: "user-action" };
    }
    return { engine: "none", fallbackReason: "graph engine (user-action owner) disabled" };
  }

  const { engineV3Enabled } = await import("./spte");
  if (await engineV3Enabled()) {
    try {
      const { runSpteLiveTurn } = await import("./spte/live");
      const spte = await runSpteLiveTurn(input, io);
      return { engine: "v3", spte };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // The failover is a real event with a real cause. Recorded with the
      // vendor and the entry point so "5 failovers in 6h" can be traced to
      // WHICH shop and WHY, instead of being a bare count on a tile.
      await io
        .recordEvent?.({
          kind: "engine-v3-fallback",
          vendorId: input.ctx.vendorId,
          vendorName: input.ctx.vendorName,
          userEmail: input.ctx.sender,
          toDigits: input.event.toDigits,
          detail: `SPTE failover -> graph engine (${entry}): ${reason}`.slice(0, 500),
        })
        .catch(() => {});
      const { graphEngineEnabled, runGraphTurn } = await import("./graph/engine");
      if (await graphEngineEnabled()) {
        const graph = await runGraphTurn(input, io);
        await recordGraphTurn(io, input, entry, `spte-failover: ${reason}`);
        return { engine: "graph", graph, fallbackReason: reason };
      }
      return { engine: "none", fallbackReason: reason };
    }
  }

  const { graphEngineEnabled, runGraphTurn } = await import("./graph/engine");
  if (await graphEngineEnabled()) {
    const graph = await runGraphTurn(input, io);
    await recordGraphTurn(io, input, entry, "ENGINE_V3 is switched off");
    return { engine: "graph", graph, fallbackReason: "ENGINE_V3 off" };
  }
  return { engine: "none", fallbackReason: "both engines disabled" };
}

/** A graph-engine turn used to be silent. Now it leaves the same kind of trace
 *  SPTE does, so the Inspector cannot show an all-V3 stream while the graph
 *  engine is quietly answering shops. */
async function recordGraphTurn(
  io: GraphIO,
  input: GraphTurnInput,
  entry: TurnEntry,
  why: string
): Promise<void> {
  await io
    .recordEvent?.({
      kind: "engine-graph-turn",
      vendorId: input.ctx.vendorId,
      vendorName: input.ctx.vendorName,
      userEmail: input.ctx.sender,
      toDigits: input.event.toDigits,
      detail: JSON.stringify({ entry, why }).slice(0, 500),
    })
    .catch(() => {});
}
