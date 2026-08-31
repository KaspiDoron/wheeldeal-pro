// SPTE orchestrator - the turn lifecycle that ties the modules together. This
// is the single-pass replacement for runGraphTurn: pre-rails (deterministic,
// free) -> reflex tier OR single pass (<=1 LLM call) -> post-rails
// (deterministic, free) -> digest merge + outcome. IO is injected so it runs in
// both the web and the worker runtime and is unit-testable without a DB.

import type {
  ConfirmSubject,
  MoveKind,
  ThreadDigest,
  TurnArtifact,
  TurnContext,
  ModelRoute,
  VerifiedExtraction,
} from "./types";
import { confirmSubjectFor, legalMovesFor, reflexTurn, waitingOn } from "./policy";
import { runSinglePass, fallbackArtifact, templateFor, fallbackLeverage } from "./pass";
import { runPostRails } from "./rails";
import { advanceConfirmState, mergeDigest } from "./digest";

export interface TurnOutcome {
  move: MoveKind;
  /** The wire-ready text, or undefined for a silent/no-send turn. */
  text?: string;
  /** The next durable digest to persist. */
  digest: ThreadDigest;
  /** A strategic wait, in minutes, or undefined. */
  waitMinutes?: number;
  /** True when the lowest offer for the session materially improved this turn -
   *  the caller enqueues bounded re-bargain wakeups for sibling threads. */
  materialDrop: boolean;
  route: ModelRoute;
  artifact: TurnArtifact;
  /** The verified inbound signals (for the caller to persist offers/state). */
  verified: VerifiedExtraction;
}

/**
 * Run ONE turn of the single-pass engine. Pure orchestration over the injected
 * context; performs at most ONE LLM call (0 for a reflex turn). Never throws,
 * never goes silent on a composable move, never sends an unverified number.
 */
export async function runTurn(ctx: TurnContext): Promise<TurnOutcome> {
  // THE DOUBTS THIS THREAD IS CARRYING, ADVANCED ONE TURN - before anything is
  // decided, because whether we are still waiting on an answer changes which
  // moves exist at all. The MODEL says whether the shop answered; the state
  // machine and its bound are arithmetic. See settleConfirmState.
  ctx.thread.digest = await settleConfirmState(ctx);

  // PRE-RAILS: legal move set (0 tokens).
  ctx.legalMoves = legalMovesFor(ctx);

  // TIER R: reflex resolution with no LLM call. Protocol reflexes (license
  // policy) carry their exact wire text - deterministic even with every LLM
  // provider down. The text still passes the post-rails like any draft.
  const reflex = reflexTurn(ctx);
  if (reflex) {
    const artifact: TurnArtifact = {
      read: { intent: reflex.reason },
      think: reflex.reason,
      move: reflex.move,
      message: reflex.message,
      leverageUsed: [],
      digestPatch: [],
    };
    const rail = runPostRails(ctx, artifact);
    return finalize(ctx, artifact, { tier: "R", reason: "reflex" }, rail.ok ? rail.finalText : undefined);
  }

  // REPLAY: no network, no model, byte-stable. The legal move set and every
  // rail above and below are the REAL ones - only the composition is frozen,
  // which is exactly the property a regression gate needs.
  if (ctx.deterministic) {
    const fb = fallbackArtifact(ctx);
    const rail = runPostRails(ctx, fb);
    return finalize(ctx, fb, { tier: "R", reason: "replay" }, rail.ok ? rail.finalText : undefined);
  }

  // TIER F / M: the turn's ONE LLM call, schema-validated + move-coerced.
  const { artifact, route } = await runSinglePass(ctx);

  // POST-RAILS: verify numbers + protocol. A rejected draft falls back to a
  // safe templated move (never a broken send).
  const rail = runPostRails(ctx, artifact);
  if (!rail.ok) {
    // A REJECTED MOVE FALLS BACK TO THE SAME MOVE, NOT TO THE TOP OF THE LADDER.
    //
    // `fallbackArtifact` walks `ctx.legalMoves` and takes the FIRST move that
    // has a template. That is right when there is no usable model output at all
    // - nothing has been decided yet, so the ladder decides. It is wrong here:
    // the model DID pick a move, a rail rejected only how it was WORDED, and
    // re-walking the ladder throws the decision away too.
    //
    // Owner report 8's cite-the-rival rail is where this bites. It rejects a
    // bargain that fails to name the cheaper rival, and its whole justification
    // was that the rejection falls through to a template which DOES name it
    // (pass.ts templateFor "bargain"). But when `answer` is also legal - a shop
    // that quotes a price and asks a question, the commonest reply there is -
    // `answer` ranks first, so the shop received a confirm-the-details line and
    // the leverage the owner explicitly asked for was silently dropped at the
    // exact moment the rail fired to enforce it.
    //
    // Same move first, ladder only if that move has no template.
    const sameMove = templateFor(ctx, artifact.move);
    const fb: TurnArtifact = sameMove
      ? {
          read: { intent: "fallback" },
          think: `rail rejected (${rail.rejected?.rule ?? "unknown"}) - deterministic ${artifact.move}`,
          move: artifact.move,
          message: sameMove,
          leverageUsed: fallbackLeverage(ctx, artifact.move, sameMove),
          digestPatch: [],
        }
      : fallbackArtifact(ctx);
    let fbRail = runPostRails(ctx, fb);
    // The HONEST reason. "quota-overflow" was hard-coded here, so Ops could
    // not tell "providers down" from "the model misbehaved and a rail caught
    // it" - the same blindness route.error was added to fix, re-created one
    // layer up.
    // A DOUBLE REJECTION MUST NOT BE A HALF-SENT TURN. `finalize` renders
    // `text: move === "silent" ? undefined : finalText`, so a non-silent move
    // whose text was rejected produces an outcome that claims to have acted and
    // carries nothing to send. Give the ladder one more chance, and if that is
    // also rejected say SILENT out loud, so the turn is coherent and the thread
    // schedules a retry instead of believing it spoke.
    let out = fb;
    if (!fbRail.ok && sameMove) {
      const ladder = fallbackArtifact(ctx);
      const ladderRail = runPostRails(ctx, ladder);
      if (ladderRail.ok) {
        out = ladder;
        fbRail = ladderRail;
      }
    }
    if (!fbRail.ok) {
      out = { ...out, move: "silent", message: undefined };
    }
    return finalize(
      ctx,
      out,
      { tier: "R", reason: `rail-rejected:${rail.rejected?.rule ?? "unknown"}` },
      fbRail.ok ? fbRail.finalText : undefined
    );
  }
  return finalize(ctx, artifact, route, rail.finalText);
}

/**
 * THE WAIT, RESOLVED OR AGED BY ONE TURN.
 *
 * "If they are not positive about something they should ask the shop, but in a
 * way of a question... then wait for the shop answer." The waiting half needs an
 * exit, and the exit is a judgement about what their reply MEANT - which is the
 * model's job, never a keyword test (a shop settles "passport or 4,000 cash?"
 * with "yes both ok", "up to you", "cash better", or a correction). The read is
 * zod-validated and lives in comprehension.readConfirmResolution.
 *
 * Everything around it is deterministic: which doubt we are waiting on, how many
 * turns it has left, and what expiry does (release the thread, and record that
 * the shop never answered - never that they confirmed).
 *
 * THREE CASES WHERE NO MODEL RUNS AT ALL, each degrading to PATIENCE:
 *   - nothing is waiting -> nothing to read;
 *   - the turn carries no shop message (a tick, a wakeup, a swarm poke) -> there
 *     is no reply to judge, and this is precisely the turn that used to erase
 *     the wait;
 *   - replay/deterministic mode -> the golden suite makes no network calls, so a
 *     frozen thread yields the same bytes on every run.
 * A provider outage lands in the same place: the wait holds until the bound
 * releases it, which is the only safe direction.
 */
async function settleConfirmState(ctx: TurnContext): Promise<ThreadDigest> {
  const waiting = waitingOn(ctx);
  const text = (ctx.inbound.text ?? "").trim();
  if (!waiting || ctx.deterministic || ctx.event !== "shop-message" || !text) {
    return advanceConfirmState(ctx.thread.digest, [], ctx.nowMs);
  }
  const resolved: ConfirmSubject[] = [];
  try {
    const { readConfirmResolution } = await import("./comprehension");
    const r = await readConfirmResolution({
      pending: waiting,
      text,
      context: contextForResolution(ctx),
    });
    if (r?.answered) resolved.push(r.subject);
  } catch {
    // The read owns its own failures; this is the last net, and its answer is
    // "keep waiting" - the same thing an outage means.
  }
  return advanceConfirmState(ctx.thread.digest, resolved, ctx.nowMs);
}

/** What the resolution read needs to know beyond the two texts: what we asked
 *  about, and the reading we refused to latch. Deliberately small - the
 *  question itself carries the rest. */
function contextForResolution(ctx: TurnContext): string {
  const p = waitingOn(ctx);
  if (!p) return "";
  return (
    `We are waiting for this shop to confirm the ${p.subject}.` +
    (p.reading ? ` The reading we did not trust: ${p.reading}` : "")
  );
}

function finalize(
  ctx: TurnContext,
  artifact: TurnArtifact,
  route: ModelRoute,
  finalText?: string
): TurnOutcome {
  const v = ctx.inbound.verified;
  // WHICH FACT A CONFIRM IS ABOUT is decided by the policy, never by the model:
  // the model picks the MOVE from a closed vocabulary, and the subject is
  // already determined by what the comprehension pass could not settle. Stamped
  // here so every path - reflex, replay and the single pass - records it, and
  // so the ask-once bound below cannot be sidestepped by a route.
  if (artifact.move === "confirm" && !artifact.confirmSubject) {
    artifact.confirmSubject = confirmSubjectFor(ctx)?.subject;
  }
  const digest = mergeDigest(ctx.thread.digest, artifact, v);

  // A material improvement: a fresh, lower quote than the session's current
  // lowest (or the first offer at all) -> tell the swarm.
  const priorLowest = ctx.session.lowest?.pricePerDay;
  const newQuote = v.found ? v.pricePerDay : undefined;
  const materialDrop =
    typeof newQuote === "number" &&
    (priorLowest === undefined || newQuote < priorLowest * 0.95);

  return {
    move: artifact.move,
    text: artifact.move === "silent" ? undefined : finalText,
    digest,
    waitMinutes: artifact.waitMinutes,
    materialDrop,
    route,
    artifact,
    verified: v,
  };
}
