import { outboxToKeyPatch } from "../wa/outbox-columns";
import type { SendResult } from "../wa/transport";
import { finishBeforeResponse } from "../after";
// The digraph execution engine - one serverless invocation per event.
//
//   sense (transcribe -> extract -> coherence -> comparator)
//     -> director (picks ONE legal edge, or waits, or stays silent)
//       -> act node composes
//         -> tail gates (style-validator -> localize -> safety -> deliver)
//
// Every step writes a trace row stamped with the node + edge ids, so the
// Pipeline Studio replays the EXACT traversed path of every real WhatsApp
// event. State checkpoints to negotiation_threads between events; strategic
// waits park a wakeup in graph_wakeups, drained opportunistically at the same
// call sites as the wa_outbox queue (no external cron needed).

import "server-only";
import { getConfig, setConfig, sbInsert, sbSelect, sbSelectStrict, sbUpdate } from "../runtime-config";
import { runSafety, localizeMessage } from "../agents";
import {
  getOrchestratorConfig,
  newDecisionId,
  stripGreeting,
  validateDraft,
  writeTrace,
  type OrchestratorConfig,
  type TraceRow,
} from "../orchestrator";
import { defaultDecisionGraph, type DecisionGraph } from "../branching";
import {
  defaultGraphSpec,
  graphFromDecisionRules,
  sanitizeGraphSpec,
  validateGraphSpec,
} from "./default-graph";
import { evalGraphCondition, explainCondition } from "./conditions";
import { deterministicChoice, runDirector } from "./director";
import { composeForNode, computeRoundTarget } from "./nodes";
import { credibleFloor } from "./math";
import {
  buildSafeBargainAsk,
  checkOutboundNumbers,
  correctDuration,
  verbatimNumerals,
  hardConstraintBreached,
  hardConstraintDecline,
} from "./guardrails";
import {
  applyExtractionToState,
  dealComplete,
  depositKnown,
  derivePhase,
  fulfillmentKnown,
  loadThreadState,
  newThreadState,
  priceKnown,
  saveThreadState,
  threadKeyFor,
} from "./state";
import { validateMediaCoherence } from "./coherence";
import { enforceEmojiTone, ensureGloballyUnique } from "./uniqueness";
import { sessionTableRows } from "./session-table";

/**
 * How long a drainer's lease on a graph_wakeup holds before another drainer may
 * reclaim it (owner report 11 C2.1). A wakeup turn is one bounded serverless
 * compose (~60-90s); five minutes is comfortable headroom over that and keeps
 * recovery after a genuine instance death fast. The claim bumps `not_before`
 * this far into the future; success deletes the row, a mid-run death lets it
 * fall due again.
 */
const WAKEUP_LEASE_MS = 5 * 60_000;

import { getPolicyOverlay, DEFAULT_OVERLAY, type PolicyOverlay } from "../ops/overlay";
import type {
  DeliverResult,
  DirectorChoice,
  GraphFacts,
  GraphIO,
  GraphSpec,
  GraphTurnInput,
  LegalEdge,
  NegotiationThreadState,
  NodeSpec,
  SessionShopRow,
  WakeupRow,
} from "./types";
import { shopAskedQuestion } from "./nodes";
import { can, localLanguageAllowed } from "../entitlements";
// W4.6 - the thread's durable language decision (read here, written by SPTE).
import { threadLanguageFromStored } from "../wa/thread-language";

// ---------------------------------------------------------------------------
// Graph spec persistence (app_config key, hot-applied, legacy auto-migration)
// ---------------------------------------------------------------------------

const GRAPH_SPEC_KEY = "graph_spec";
const LEGACY_GRAPH_KEY = "decision_graph";

declare global {
  // eslint-disable-next-line no-var
  var __wd_graph_spec__: { at: number; value: GraphSpec } | undefined;
}

// Old rule id -> new default edge id (the owner's enable/order edits carry over).
const LEGACY_RULE_TO_EDGE: Record<string, string> = {
  "session-closed": "d-silent-closed",
  "answer-question": "d-answer",
  "thank-vehicle-photo": "d-thank-photo",
  "clarify-once": "d-clarify",
  "close-great-price": "d-close-great",
  "silent-great-price-closed": "d-silent-great",
  "close-no-real-saving": "d-close-no-saving",
  "silent-no-real-saving-closed": "d-silent-no-saving",
  "bargain-once": "d-bargain",
  "close-after-bargain": "d-close-after-push",
};

async function migrateFromLegacy(): Promise<GraphSpec> {
  const spec = defaultGraphSpec();
  try {
    const raw = await getConfig(LEGACY_GRAPH_KEY);
    if (!raw) return spec;
    const legacy = JSON.parse(raw) as DecisionGraph;
    if (legacy?.version !== 1 || !Array.isArray(legacy.rules)) return spec;
    const def = defaultDecisionGraph();
    const changed = JSON.stringify(legacy.rules) !== JSON.stringify(def.rules);
    if (!changed) return spec;
    // Carry the owner's edits: enabled/order per known rule; custom rules
    // become extra director edges with their original typed conditions.
    for (const rule of legacy.rules) {
      const edgeId = LEGACY_RULE_TO_EDGE[rule.id];
      if (edgeId) {
        const edge = spec.edges.find((x) => x.id === edgeId);
        if (edge) {
          edge.enabled = rule.enabled;
          edge.priority = rule.order;
          if (rule.label) edge.label = rule.label;
        }
      } else {
        spec.edges.push(...graphFromDecisionRules([rule]));
      }
    }
  } catch {
    /* keep defaults */
  }
  return spec;
}

export async function getGraphSpec(): Promise<GraphSpec> {
  const cached = globalThis.__wd_graph_spec__;
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  let spec: GraphSpec | null = null;
  try {
    const raw = await getConfig(GRAPH_SPEC_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as GraphSpec;
      if (parsed?.version === 2) spec = sanitizeGraphSpec(parsed);
    }
  } catch {
    /* fall through */
  }
  if (!spec) {
    spec = await migrateFromLegacy();
    // Persist the migrated copy so the Studio opens on the owner's real graph
    // (best-effort - defaults still serve if the write fails).
    setConfig(GRAPH_SPEC_KEY, JSON.stringify(spec)).catch(() => {});
  }
  globalThis.__wd_graph_spec__ = { at: Date.now(), value: spec };
  return spec;
}

export async function saveGraphSpec(spec: GraphSpec): Promise<{ ok: boolean; problems: string[] }> {
  const clean = sanitizeGraphSpec(spec);
  const v = validateGraphSpec(clean);
  if (!v.ok) return { ok: false, problems: v.problems };
  await setConfig(GRAPH_SPEC_KEY, JSON.stringify(clean));
  globalThis.__wd_graph_spec__ = undefined;
  return { ok: true, problems: [] };
}

/** Engine kill-switch: `GRAPH_ENGINE=off` reverts to the legacy inline loop. */
export async function graphEngineEnabled(): Promise<boolean> {
  const v = ((await getConfig("GRAPH_ENGINE")) ?? "").trim().toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

function buildFacts(args: {
  input: GraphTurnInput;
  state: NegotiationThreadState;
  spec: GraphSpec;
  target?: number;
  rivalPrice?: number;
  mediaCoherent: boolean;
  overlay: PolicyOverlay;
}): GraphFacts {
  const { input, state, spec, overlay } = args;
  const f = state.fields;
  const isTick = input.event.kind === "tick";
  const price = f.pricePerDay;
  const priceOk = priceKnown(f);
  const atFloor = Boolean(
    price && input.floorPrice && price <= input.floorPrice * overlay.floorTolerance
  );
  const counts = {
    clarify: Math.max(input.legacyCounts.clarify, state.nodeRuns["clarify"] ?? 0),
    bargain: Math.max(
      input.legacyCounts.bargain,
      f.rounds ?? 0,
      state.nodeRuns["bargain"] ?? 0
    ),
    answer: Math.max(input.legacyCounts.answer, state.nodeRuns["answer"] ?? 0),
    close: Math.max(input.legacyCounts.close, state.nodeRuns["close"] ?? 0),
  };
  return {
    sessionClosed: input.sessionClosed,
    // A tick carries no NEW shop message - never re-answer / re-clarify on it.
    shopAskedQuestion: isTick ? false : shopAskedQuestion(input.event.shopMessage),
    shopSentVehiclePhoto: isTick ? false : input.extraction?.imageKind === "vehicle",
    hasUsablePrice: priceOk,
    verified: Boolean(f.priceVerified),
    hasClarifyMessage: isTick ? false : Boolean(input.extraction?.clarifyMessage),
    matchesSpecNotFalse: input.extraction ? input.extraction.matchesSpec !== false : true,
    priceAtOrBelowFloor: atFloor,
    // Far above the floor (default >25%, owner-tunable) = real room remains;
    // one firm "last price" does not end the push when this is true.
    priceFarAboveFloor: Boolean(
      price && input.floorPrice && price > input.floorPrice * overlay.priceFarAboveFloor
    ),
    targetIsRealSaving: Boolean(price && args.target && args.target < price * 0.95),
    rivalCheaper: Boolean(args.rivalPrice),
    counts,
    event: input.event.kind,
    phase: state.phase,
    priceKnown: priceOk,
    depositKnown: depositKnown(f),
    fulfillmentKnown: fulfillmentKnown(f),
    depositPassportOnly: f.depositType === "passport",
    cashAlternativeAsked: Boolean(f.cashAlternativeAsked),
    firmCount: f.firmCount ?? 0,
    rounds: f.rounds ?? 0,
    maxRounds: spec.settings.maxRoundsPerShop,
    toneDegraded: Boolean(f.toneDegraded),
    shopDeclined: Boolean(f.declined),
    dealComplete: dealComplete(f),
    pickupOffered: Boolean(f.pickupOffered),
    pickupConsent: Boolean(f.pickupConsent),
    hasImage: input.event.images.length > 0,
    hasAudio: input.event.audios.length > 0 || Boolean(input.transcript),
    mediaCoherent: args.mediaCoherent,
    nodeRuns: state.nodeRuns,
    // Derived AFTER this build by applyStrongBargainFact (needs the spec's
    // edge legality, which buildFacts cannot see). Placeholder stays false.
    strongBargainAvailable: false,
  };
}

/**
 * The price-first gate's derived fact: strong leverage exists (cheaper rival
 * or a far-above-floor quote) AND a bargain edge is ACTUALLY legal right now
 * (edge enabled, node enabled, maxRuns unexhausted, condition true). Computed
 * as a fixpoint-safe overlay: bargain-edge conditions are evaluated with the
 * fact still false, so the gated edges' notG(strongBargainAvailable) wrappers
 * can never influence the bargain edges themselves (no recursion, and the
 * gate is provably active ONLY when a bargain move is in the legal set -
 * the director can never be starved by it).
 */
export function applyStrongBargainFact(spec: GraphSpec, facts: GraphFacts): GraphFacts {
  // The agent must take at least ONE real bargaining swing before it drifts to
  // logistics (deposit / delivery / pickup) - the owner's report was agents
  // "going straight for deposit and delivery" on a moderate first quote. So
  // enforce price-first not only under strong leverage (cheaper rival, or a
  // quote far above the floor) but ALSO on the FIRST quote whenever there is
  // genuine room to push (targetIsRealSaving) and no bargain has run yet. Once
  // that first push is spent, only sustained leverage (rival / far-above-floor)
  // keeps the gate closed, so a shop holding firm is not nagged forever.
  const firstBargainWithRoom = facts.targetIsRealSaving && facts.counts.bargain === 0;
  if (!(facts.rivalCheaper || facts.priceFarAboveFloor || firstBargainWithRoom)) return facts;
  const nodesById = new Map(spec.nodes.map((x) => [x.id, x]));
  const bargainLegal = spec.edges.some((edge) => {
    if (!edge.enabled || edge.from !== "director") return false;
    const node = nodesById.get(edge.to);
    if (!node || !node.enabled || node.kind !== "bargain") return false;
    if (
      node.maxRunsPerThread != null &&
      (facts.nodeRuns[node.id] ?? 0) >= node.maxRunsPerThread
    ) {
      return false;
    }
    return evalGraphCondition(edge.when, facts);
  });
  return bargainLegal ? { ...facts, strongBargainAvailable: true } : facts;
}

function legalEdgesFrom(
  spec: GraphSpec,
  fromId: string,
  facts: GraphFacts
): LegalEdge[] {
  const nodesById = new Map(spec.nodes.map((x) => [x.id, x]));
  return spec.edges
    .filter((edge) => edge.enabled && edge.from === fromId)
    .filter((edge) => {
      const node = nodesById.get(edge.to);
      if (!node || !node.enabled) return false;
      if (
        node.maxRunsPerThread != null &&
        (facts.nodeRuns[node.id] ?? 0) >= node.maxRunsPerThread
      ) {
        return false;
      }
      return evalGraphCondition(edge.when, facts);
    })
    .sort((x, y) => x.priority - y.priority)
    .map((edge) => ({
      edgeId: edge.id,
      label: edge.label ?? edge.id,
      toNodeId: edge.to,
      toKind: nodesById.get(edge.to)!.kind,
    }));
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

/**
 * One rung of the Director's priority ladder AT DECISION TIME: was this move
 * legal, was it the one picked, and - in plain language - why or why not.
 * This is what the Studio's Playground renders so a non-technical owner can
 * read exactly why the agent did what it did.
 */
export interface DecisionLadderRung {
  edgeId: string;
  label: string;
  toNodeId: string;
  toKind: string;
  emoji?: string;
  legal: boolean;
  chosen: boolean;
  why: string;
}

export interface GraphTurnResult {
  decisionId: string;
  action: string; // silent | deferred | node id that composed | ...
  message?: string;
  delivered?: DeliverResult;
  traces: TraceRow[];
  // The first (inbound) director decision's full ladder, for explain-why UIs.
  ladder?: DecisionLadderRung[];
}

export async function runGraphTurn(
  input: GraphTurnInput,
  io: GraphIO,
  specOverride?: GraphSpec
): Promise<GraphTurnResult> {
  const spec = specOverride ?? (await getGraphSpec());
  const cfg = await getOrchestratorConfig();
  const nodesById = new Map(spec.nodes.map((x) => [x.id, x]));
  const nodeOn = (id: string) => nodesById.get(id)?.enabled !== false && nodesById.has(id);

  const decisionId = newDecisionId();
  const traces: TraceRow[] = [];
  const base = {
    decisionId,
    userEmail: input.ctx.sender ?? undefined,
    vendorId: input.ctx.vendorId ?? undefined,
    vendorName: input.ctx.vendorName ?? undefined,
  };
  // Per-stage latency: each trace row records the wall time spent since the
  // previous stage - the Studio debugger's timeline. Real clock, not io.now()
  // (which tests freeze), so latency is honest even in the simulator.
  let lastPushAt = Date.now();
  const push = (row: Omit<TraceRow, keyof typeof base>) => {
    const t = Date.now();
    traces.push({ ...base, ...row, ms: t - lastPushAt });
    lastPushAt = t;
  };

  // LLM budget: hard cap per event + the serverless deadline.
  let llmCalls = 0;
  const llmBudget = () => {
    if (!io.llmAllowed) return false;
    if (llmCalls >= spec.settings.maxLlmCallsPerEvent) return false;
    if (input.deadlineAt - io.now() < 8_000) return false;
    llmCalls++;
    return true;
  };

  // Owner-tuned thresholds (defaults = the historical literals; 30s-cached
  // config read, so this costs nothing on the hot path). Replays pin their
  // own overlay so the golden suite is bit-stable regardless of live config.
  const overlay = input.overlay ?? (await getPolicyOverlay().catch(() => DEFAULT_OVERLAY));

  // ---- state ---------------------------------------------------------------
  let state =
    (await io.loadState(input.event.threadKey)) ??
    newThreadState({
      threadKey: input.event.threadKey,
      userEmail: input.ctx.sender,
      vendorId: input.ctx.vendorId,
      vendorName: input.ctx.vendorName,
      toNumber: input.event.toDigits,
    });
  // A fresh inbound supersedes any pending strategic wait - the shop spoke
  // again, so the "let them send the last message" bet already paid off.
  if (input.event.kind.startsWith("inbound") && state.waitingUntil) {
    state = { ...state, waitingUntil: null };
    await io.clearWakeups(state.threadKey, "tick");
  }
  state = applyExtractionToState(state, input.extraction, input.usablePrice, input.currency);

  // CREDIBILITY CLAMP (the Bargained-0 kill, engine choke point): a market
  // floor at/above the shop's LIVE price is bad data - it flips
  // priceAtOrBelowFloor true and makes the bargain edge illegal, muting the
  // whole negotiation. Clamping HERE (after state load) covers every caller in
  // one place: the inbound path, the tick path (price lives only in state
  // then) and the Playground - what the owner tests is what production runs.
  {
    const livePrice = input.usablePrice ?? state.fields.pricePerDay ?? undefined;
    const credible = credibleFloor(input.floorPrice, livePrice);
    if (credible.clamped) {
      input = { ...input, floorPrice: credible.floor };
    }
  }
  // The traveller has now provided a hotel: clear the awaiting-location hold so
  // the deposit/delivery probes resume - otherwise a thread that asked for the
  // hotel would stay frozen forever even after the user added it (even if they
  // left the share box UNticked). Clearing on the LABEL (not consent) unfreezes
  // the funnel; the answer node still gates SHARING the address on consent.
  if (state.fields.awaitingUserLocation && input.ctx.stay?.label) {
    state = { ...state, fields: { ...state.fields, awaitingUserLocation: false } };
  }
  // User-action events carry their own state facts (the app already gated the
  // consent / close), so stamp them before the director evaluates.
  if (input.event.kind === "user-consent-pickup") {
    state = {
      ...state,
      fields: { ...state.fields, pickupOffered: true, pickupConsent: true },
    };
  }
  state.lastDecisionId = decisionId;

  // ---- sense traces ----------------------------------------------------------
  if (input.transcript && nodeOn("transcribe")) {
    push({
      stage: "transcribe",
      nodeId: "transcribe",
      input: "(voice note)",
      reasoning: `heavy-accent transcription via ${input.transcript.source}${
        input.transcript.language ? ` - detected ${input.transcript.language}` : ""
      }`,
      output: input.transcript.text.slice(0, 600),
    });
  }
  if (input.extraction) {
    push({
      stage: "extract",
      nodeId: "extract",
      input: (input.event.shopMessage || "(media only)").slice(0, 600),
      reasoning: `found=${input.extraction.found} matchesSpec=${input.extraction.matchesSpec} confidence=${input.extraction.confidence}${
        input.extraction.imageKind ? ` imageKind=${input.extraction.imageKind}` : ""
      }${input.extraction.shopFirm ? " shopFirm" : ""}${
        input.extraction.shopTone === "annoyed" ? " tone=annoyed" : ""
      }`,
      output: input.usablePrice
        ? `${input.usablePrice} ${input.currency}/day`
        : "(no usable price)",
    });
  }

  // ---- media coherence -------------------------------------------------------
  let mediaCoherent = true;
  const hadMedia = input.event.images.length > 0 || Boolean(input.transcript);
  if (hadMedia && nodeOn("coherence") && input.extraction) {
    const verdict = await validateMediaCoherence({
      kind: input.transcript ? "audio" : "image",
      interpretation: input.transcript?.text ?? input.event.shopMessage ?? "(image)",
      extraction: input.extraction,
      history: input.history,
      rfq: input.rfq,
      floorPrice: input.floorPrice,
      floorTypical: input.floorTypical,
      region: input.ctx.region,
      llmAllowed: llmBudget(),
    });
    mediaCoherent = verdict.coherent;
    if (verdict.correctedPricePerDay && verdict.correctedPricePerDay > 0) {
      state = {
        ...state,
        fields: { ...state.fields, pricePerDay: verdict.correctedPricePerDay },
      };
      state.phase = derivePhase(state);
    }
    push({
      stage: "media-coherence",
      nodeId: "coherence",
      input: (input.transcript?.text ?? "(image reading)").slice(0, 400),
      reasoning: verdict.issues.join("; ") || "interpretation fits the conversation",
      output: verdict.coherent ? "coherent" : "NOT coherent - confirm in text",
      verdict: verdict.fromAi ? undefined : "deterministic",
    });

    // Gap Validator: what did this media give us, what does the deal still
    // need (deposit tiers, mileage, condition...)? Deterministic in the hot
    // path - the trace makes it 100% visible in Replay/Playground.
    try {
      const { assessMediaGaps } = await import("./gaps");
      const gaps = await assessMediaGaps({
        kind: input.transcript ? "audio" : "image",
        extraction: input.extraction,
        fields: state.fields,
        rfq: input.rfq,
        history: input.history,
        llmAllowed: false,
      });
      push({
        stage: "media-gap",
        nodeId: "coherence",
        input: `gained: ${gaps.gained.join("; ") || "(nothing usable)"}`,
        reasoning: gaps.stillMissing.length
          ? `still missing: ${gaps.stillMissing.join("; ")}`
          : "nothing missing - the deal fields are covered",
        output: gaps.followUp ?? "(no follow-up needed)",
        verdict: "deterministic",
      });
    } catch {
      /* gap check is an insight layer - never blocks the turn */
    }
  }

  // ---- comparator (floor + rival + round target) ------------------------------
  let rivalPrice: number | undefined;
  let target: number | undefined;
  const f = state.fields;
  if (nodeOn("comparator") && priceKnown(f)) {
    const atFloor = Boolean(
      input.floorPrice && f.pricePerDay! <= input.floorPrice * overlay.floorTolerance
    );
    // Cross-shop intelligence: always look for a cheaper rival in this search
    // session (even at-floor - the director still reads it as context), so
    // competitor offers can be used as honest leverage the moment they exist.
    if (input.ctx.sender && input.ctx.vendorId) {
      const { vehicleKeyFor } = await import("../market");
      rivalPrice = await io
        .cheapestRival({
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          currency: input.currency,
          vehicleKey: vehicleKeyFor(input.rfq),
          belowPrice: f.pricePerDay!,
          // Omitted, so every package-derived rival was dropped even when this
          // rental covers the package - see the type's note.
          durationDays: input.rfq.durationDays,
        })
        .catch(() => undefined);
    }
    if (!atFloor) {
      // PRINTED-LIST ANCHOR: a posted price board is firmer than a spoken
      // quote - deep lowballs against it kill deals ("that's OK, take it
      // there"). Asks bottom out around 80% (owner-tunable) of the listed
      // price of the chosen model (the real floor applies when higher).
      const sheetAnchor = f.sheetPricePerDay
        ? Math.round(f.sheetPricePerDay * overlay.sheetAnchor)
        : 0;
      const effFloor =
        Math.max(input.floorPrice ?? 0, sheetAnchor) || undefined;
      target = computeRoundTarget({
        quoted: f.pricePerDay!,
        floorPrice: effFloor,
        rivalPrice,
        rounds: f.rounds ?? 0,
        lastTarget: f.lastTarget,
      });
    }
    push({
      stage: "comparator",
      nodeId: "comparator",
      input: `quoted=${f.pricePerDay} ${input.currency} floor=${input.floorPrice ?? "?"} rounds=${f.rounds}`,
      reasoning: rivalPrice
        ? `cheapest rival in this session: ${rivalPrice} ${input.currency}/day - honest leverage`
        : atFloor
        ? "price already at/below the local floor"
        : "no cheaper rival yet",
      output: target ? `next target ${target} ${input.currency}/day` : "(no ask planned)",
    });
  }

  // ---- the director loop -------------------------------------------------------
  let facts = applyStrongBargainFact(spec, buildFacts({ input, state, spec, target, rivalPrice, mediaCoherent, overlay }));
  let steps = 0;
  let ladder: DecisionLadderRung[] | undefined;
  let lastResult: GraphTurnResult = { decisionId, action: "silent", traces };

  while (steps++ < spec.settings.maxStepsPerEvent) {
    const legal = legalEdgesFrom(spec, "director", facts);
    // Capture the FIRST decision's full ladder (every rung, pass or fail, with
    // a plain-language reason) - the Playground's "why did it do that" view.
    if (steps === 1) {
      ladder = spec.edges
        .filter((e) => e.enabled && e.from === "director")
        .sort((a, b) => a.priority - b.priority)
        .map((e) => {
          const node = nodesById.get(e.to);
          let pass = false;
          let why: string;
          if (!node || !node.enabled) {
            why = "this move is switched off";
          } else if (
            node.maxRunsPerThread != null &&
            (facts.nodeRuns[node.id] ?? 0) >= node.maxRunsPerThread
          ) {
            why = `already used ${node.maxRunsPerThread}x with this shop`;
          } else {
            const r = explainCondition(e.when, facts);
            pass = r.pass;
            why = r.why;
          }
          return {
            edgeId: e.id,
            label: e.label ?? e.id,
            toNodeId: e.to,
            toKind: node?.kind ?? "?",
            emoji: node?.emoji,
            legal: pass,
            chosen: false, // stamped below once the director picks
            why,
          };
        });
    }
    let choice: DirectorChoice;
    // SCOPE THE SESSION TABLE TO THE SAME MACHINE. This call passed no vehicle
    // key at all, so the director's rival board could hold a price for a
    // different machine entirely - a 150cc quoted in another thread, cited at a
    // shop that quoted a 125cc. Leverage has to compare like with like.
    const { vehicleKeyFor: sessionVehicleKeyFor } = await import("../market");
    const sessionVehicleKey = sessionVehicleKeyFor(input.rfq);
    if (nodeOn("director")) {
      choice = await runDirector({
        input,
        state,
        facts,
        legal,
        session:
          input.ctx.sender && io.llmAllowed
            ? await io
                .sessionTable(input.ctx.sender, input.ctx.vendorId, sessionVehicleKey, {
                  engineSizeCc: input.rfq.engineSizeCc,
                  durationDays: input.rfq.durationDays,
                })
                .catch(() => [])
            : [],
        settings: spec.settings,
        instructions: nodesById.get("director")?.instructions ?? "",
        target,
        rivalPrice,
        llmAllowed: llmBudget(),
      });
    } else {
      choice = deterministicChoice(legal, "director disabled - deterministic ladder");
    }
    if (steps === 1 && ladder && choice.edgeId) {
      for (const r of ladder) r.chosen = r.edgeId === choice.edgeId;
      // Persist the full ladder as its own trace row (observability only -
      // decisions are already made). This is what lets the USER-facing
      // "Why this move?" view work on live threads, not just the Playground.
      push({
        stage: "ladder",
        nodeId: "director",
        input: "",
        reasoning: "director decision ladder (why each move was taken or skipped)",
        output: JSON.stringify(
          ladder.map((r) => ({
            e: r.edgeId,
            l: r.label,
            k: r.toKind,
            legal: r.legal,
            chosen: r.chosen,
            why: r.why,
          }))
        ).slice(0, 8000),
      });
    }
    push({
      stage: "director",
      nodeId: "director",
      edgeId: choice.edgeId ?? undefined,
      input:
        `event=${facts.event} phase=${facts.phase} missing=[${[
          facts.depositKnown ? "" : "deposit",
          facts.fulfillmentKnown ? "" : "fulfillment",
          facts.priceKnown ? "" : "price",
        ]
          .filter(Boolean)
          .join(",")}] legal=[${legal.map((l) => l.edgeId).join(", ") || "none"}]`,
      reasoning: choice.reasoning,
      output:
        choice.action +
        (choice.waitSeconds ? ` ${choice.waitSeconds}s` : "") +
        (choice.edgeId ? ` -> ${choice.edgeId}` : "") +
        (choice.leverageNote ? ` | leverage: ${choice.leverageNote}` : ""),
      verdict: choice.fromAi ? undefined : "deterministic",
    });

    if (choice.action === "silent" || !choice.edgeId) {
      state.phase = derivePhase(state);
      await io.saveState(state);
      await io.writeTrace(traces);
      return { ...lastResult, action: "silent", ladder };
    }

    if (choice.action === "wait-defer") {
      const until = new Date(io.now() + (choice.waitSeconds ?? 600) * 1000).toISOString();
      state.waitingUntil = until;
      await io.insertWakeup({
        kind: "tick",
        threadKey: state.threadKey,
        notBefore: until,
        payload: { reason: choice.reasoning },
      });
      push({
        stage: "deliver",
        nodeId: "deliver",
        input: "(decision deferred)",
        reasoning: `strategic wait ${Math.round((choice.waitSeconds ?? 600) / 60)}min - ${choice.reasoning}`,
        output: `wakeup at ${until}`,
      });
      await io.saveState(state);
      await io.writeTrace(traces);
      return { ...lastResult, action: "deferred", ladder };
    }

    const edge = spec.edges.find((x) => x.id === choice.edgeId)!;
    const node = nodesById.get(edge.to)!;

    // Honest cross-shop leverage the composer may mention is derived ONLY from
    // a REAL rival price in this session - NEVER from the LLM director's
    // free-text leverageNote, which can hallucinate a competitor that does not
    // exist ("another shop quoted 220"). The director's note stays in the trace
    // for observability, but only a verified rivalPrice reaches the bargainer.
    const leverageNote =
      rivalPrice && node.id === "bargain"
        ? `another shop in this search already gave ${rivalPrice} ${input.currency}/day for the same vehicle for the ${input.rfq.durationDays} days - you MUST cite this ${rivalPrice}/day price and the ${input.rfq.durationDays} days and ask this shop to beat it`
        : undefined;

    const result = await composeForNode({
      node,
      edgeLabel: edge.label ?? edge.id,
      input,
      state,
      spec,
      cfg,
      target,
      rivalPrice,
      leverageNote,
      llmBudget,
    });
    state.nodeRuns[node.id] = (state.nodeRuns[node.id] ?? 0) + 1;
    if (result.fieldsPatch) {
      state = { ...state, fields: { ...state.fields, ...result.fieldsPatch } };
    }
    // A shop asked for the traveller's hotel and we have none: prompt the user
    // (once - the answer node only flips this on the transition) so they can add
    // it and the deal keeps moving instead of looping.
    if (result.fieldsPatch?.awaitingUserLocation === true && input.ctx.sender) {
      if (io.recordEvent) {
        await io
          .recordEvent({
            kind: "awaiting-location",
            vendorId: input.ctx.vendorId ?? "",
            vendorName: input.ctx.vendorName ?? "",
            userEmail: input.ctx.sender,
            toDigits: input.event.toDigits,
            detail: JSON.stringify({ email: input.ctx.sender }),
          })
          .catch(() => {});
      }
      // THROUGH THE GATE, LIKE EVERY OTHER PUSH.
      //
      // This one went straight to the push service: no significance check, no
      // budget spend, no markPushSent. So a thread that kept landing on this
      // transition buzzed the traveller every single time, uncounted against
      // the per-window ceiling that makes the other pushes bearable - and the
      // ceiling itself was understated by exactly these sends.
      //
      // Awaited for the same reason as the others: a detached promise here does
      // not "finish in the background" on Cloud Run, it stops.
      await finishBeforeResponse("location-push", async () => {
        const { worthAnInterruption } = await import("../notify/significance");
        const { notifyState, markPushSent } = await import("../notify/state");
        const gate = worthAnInterruption(
          { kind: "agent-blocked" },
          await notifyState(input.ctx.sender!)
        );
        if (!gate.notify) return;
        const { sendPushToUser } = await import("../push");
        await sendPushToUser(input.ctx.sender!, {
          title: "A shop needs your hotel 🏨",
          body: `${input.ctx.vendorName ?? "A shop"} asked where to deliver - add your hotel in your profile to keep the deal moving.`,
          url: "/profile",
          tag: `location:${input.ctx.vendorId ?? "shop"}`,
        });
        await markPushSent(input.ctx.sender!, "awaiting-location");
      });
    }
    push({
      stage: node.kind,
      nodeId: node.id,
      edgeId: edge.id,
      input: `via "${edge.label ?? edge.id}"${target ? ` target=${target} ${input.currency}` : ""}${
        rivalPrice ? ` rival=${rivalPrice}` : ""
      }`,
      reasoning: result.reasoning,
      output: result.message ?? "(state move - no message)",
      verdict: result.verdict,
    });

    if (node.kind === "present") {
      await io
        .markPresentable({
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          fulfillment: state.fields.fulfillment ?? null,
        })
        .catch(() => {});
      state.phase = derivePhase(state);
      // present loops back to the director (t-present-back) for a warm close.
      facts = applyStrongBargainFact(spec, buildFacts({ input, state, spec, target, rivalPrice, mediaCoherent, overlay }));
      lastResult = { decisionId, action: "present", traces, ladder };
      continue;
    }

    if (result.terminal || !result.message) {
      state.phase = derivePhase(state);
      await io.saveState(state);
      await io.writeTrace(traces);
      return { decisionId, action: node.id, traces, ladder };
    }

    // ---- tail gates ----------------------------------------------------------
    const delivered = await runTailGates({
      draft: result.message,
      englishGloss: result.englishGloss,
      kind: result.kind ?? `auto-${node.id}`,
      nodeId: node.id,
      nodeKind: node.kind,
      tacticId: result.tacticId,
      nextRound: result.nextRound ?? input.ctx.round ?? 0,
      holdSeconds: choice.action === "wait-hold" ? choice.waitSeconds : undefined,
      // Negotiation levers the validator must never strip (leverage guard).
      target,
      rivalPrice,
      leverageNote: choice.leverageNote,
      // W4.6: the thread's stored language decision - read, never re-derived.
      threadLanguage: threadLanguageFromStored(state.fields.language),
      // The inverted-ask ceiling is the shop's CURRENT SPOKEN quote - NOT the
      // posted list price, which (when higher than the spoken quote) would mask
      // an inverted ask (asking 600 after they verbally offered 500).
      shopCeiling: input.usablePrice ?? state.fields.pricePerDay ?? undefined,
      // The posted list/sheet price may be legitimately cited above the ask
      // ("your board says 1200, can you do 900?") - whitelisted, not the ask.
      sheetRef: state.fields.sheetPricePerDay ?? undefined,
      input,
      io,
      spec,
      cfg,
      nodeOn,
      push,
      llmBudget,
      decisionId,
    });

    // A BLOCKED delivery (validator veto, safety veto, post-scrub leverage
    // loss) must NOT consume the node's run budget: nothing reached the shop,
    // so counterBelow/maxRuns gates would otherwise read "already bargained
    // 1x" and silently abandon the push forever - the shop just hears
    // silence. Roll the increment back so the next event retries cleanly.
    if (delivered.delivered === "blocked") {
      state.nodeRuns[node.id] = Math.max(0, (state.nodeRuns[node.id] ?? 0) - 1);
      if (node.kind === "bargain" && io.recordEvent) {
        await io
          .recordEvent({
            kind: "bargain-blocked",
            vendorId: input.ctx.vendorId ?? "",
            vendorName: input.ctx.vendorName ?? "",
            userEmail: input.ctx.sender,
            toDigits: input.event.toDigits,
            detail: `Bargain to +${input.event.toDigits} blocked (${delivered.detail}) - run budget rolled back, next event retries.`,
          })
          .catch(() => {});
      }
    }

    if (node.kind === "bargain" && result.tacticId && delivered.delivered !== "blocked") {
      await io
        .insertBargainDraft({
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          tactic: result.tacticId,
          message: delivered.finalText ?? result.message,
        })
        .catch(() => {});
    }
    if (node.kind === "closing-message" && delivered.delivered !== "blocked") {
      state.phase = "closing";
    }

    state.phase = derivePhase(state);
    await io.saveState(state);
    await io.writeTrace(traces);
    return {
      decisionId,
      action: node.id,
      message: delivered.finalText ?? result.message,
      delivered,
      traces,
      ladder,
    };
  }

  // Step budget exhausted - trace it and go quiet (never a loud failure).
  push({
    stage: "deliver",
    nodeId: "deliver",
    input: "(traversal cap)",
    reasoning: `stopped after ${spec.settings.maxStepsPerEvent} steps - graph may have a loop`,
    output: "silent",
  });
  await io.saveState(state);
  await io.writeTrace(traces);
  return { decisionId, action: "silent", traces, ladder };
}

// ---------------------------------------------------------------------------
// Tail gates: style-validator -> localize -> safety -> deliver
// ---------------------------------------------------------------------------

/**
 * Which deliberate negotiation levers did a revision LOSE? A lever counts as
 * lost only if the original text actually contained it. Number levers match
 * as digit tokens (with thousands separators tolerated); the duration lever
 * matches the bare day count. Pure - unit-tested.
 */
export function leverageLost(
  original: string,
  revised: string,
  levers: { rivalPrice?: number; target?: number; durationDays?: number }
): string[] {
  const lost: string[] = [];
  const hasNumber = (s: string, n: number) => {
    const rx = new RegExp(`(?<![\\d])${String(n).split("").join("[,.]?")}(?![\\d])`);
    return rx.test(s.replace(/\s/g, ""));
  };
  if (levers.rivalPrice && hasNumber(original, levers.rivalPrice) && !hasNumber(revised, levers.rivalPrice)) {
    lost.push(`the rival offer (${levers.rivalPrice})`);
  }
  if (levers.target && hasNumber(original, levers.target) && !hasNumber(revised, levers.target)) {
    lost.push(`the target ask (${levers.target})`);
  }
  if (
    levers.durationDays &&
    levers.durationDays > 1 &&
    hasNumber(original, levers.durationDays) &&
    !hasNumber(revised, levers.durationDays)
  ) {
    lost.push(`the ${levers.durationDays}-day rental lever`);
  }
  return lost;
}

async function runTailGates(args: {
  draft: string;
  englishGloss?: string;
  kind: string;
  nodeId: string;
  // The node's KIND (bargain / answer / momentum / ...). The numeric + duration
  // guards key on this, NEVER on nodeId: an owner-edited graph spec can rename a
  // bargain node's id, and keying on id would let the renamed node bypass the
  // guard entirely (a silent no-op that ships a fabricated rival to a shop).
  nodeKind: string;
  tacticId?: string;
  nextRound: number;
  holdSeconds?: number;
  // Deliberate negotiation levers in the draft (bargain nodes) - the style
  // validator's revision is REJECTED if it drops any of them.
  target?: number;
  rivalPrice?: number;
  leverageNote?: string;
  shopCeiling?: number;
  sheetRef?: number;
  /** W4.6 - the thread's stored language decision (never re-derived here). */
  threadLanguage?: import("../wa/thread-language").ThreadLanguage;
  input: GraphTurnInput;
  io: GraphIO;
  spec: GraphSpec;
  cfg: OrchestratorConfig;
  nodeOn: (id: string) => boolean;
  push: (row: Omit<TraceRow, "decisionId" | "userEmail" | "vendorId" | "vendorName">) => void;
  llmBudget: () => boolean;
  decisionId: string;
}): Promise<DeliverResult> {
  const { input, io, spec, cfg, nodeOn, push } = args;
  let text = args.draft;
  let englishGloss = args.englishGloss;
  // Set when a deterministic rail rewrote the text after localization - the
  // re-gloss block at the bottom uses it to keep the traveller's translation
  // alive (owner report 4, item 8).
  let glossInvalidated = false;
  // W4.6 - THE LANGUAGE DOCTRINE, INVERTED. This used to call
  // `threadPrefersEnglish`, which flipped a thread to English the moment the
  // shop DEMONSTRATED English (and on the very first inbound, with no prior at
  // all). The owner's doctrine is the opposite: stay local, and switch only
  // when the shop SAYS they do not speak the local language. That statement is
  // read by the comprehension pass and stored on the thread, so this engine -
  // the failover - reads the decision instead of re-deriving one, and the two
  // engines can never disagree about the language of the same conversation.
  //
  // A tick needs no guard any more: a decision is not recomputed, so there is
  // nothing for a tick to accidentally flip (the old asymmetry - guarded here,
  // unguarded in the legacy loop - is gone by construction).
  const { threadWritesEnglish } = await import("../wa/thread-language");
  const shopWroteEnglish = threadWritesEnglish(args.threadLanguage);
  const useLocalLang =
    localLanguageAllowed({ requested: input.ctx.localLang, plan: input.ctx.plan }) &&
    !shopWroteEnglish;
  const isLocalizedBargain = args.nodeKind === "bargain" && useLocalLang;

  // ---- style-validator -------------------------------------------------------
  if (nodeOn("style-validator")) {
    if (input.priorOutbound.length > 0) text = stripGreeting(text);
    // Localized bargains skip the AI critique (an English pass on Thai text
    // risks flipping the language - stickiness wins), deterministic still runs.
    const validation = await validateDraft({
      cfg:
        isLocalizedBargain || !args.llmBudget()
          ? {
              ...cfg,
              stages: cfg.stages.map((s) =>
                s.id === "validator" ? { ...s, enabled: false } : s
              ),
            }
          : cfg,
      history: input.history,
      draft: text,
      shopMessage: input.event.shopMessage,
      priorOutbound: input.priorOutbound,
      currency: input.currency,
    });
    if (validation.verdict === "veto" || !validation.text) {
      push({
        stage: "style-validator",
        nodeId: "style-validator",
        input: text,
        reasoning: validation.reasons.join("; ") || "vetoed",
        output: "(vetoed)",
        verdict: "veto",
      });
      return { delivered: "blocked", detail: "vetoed by the style validator" };
    }
    text = validation.text;
    // LEVERAGE GUARD (deterministic): a bargain draft's rival price, target
    // number and rental-length lever are DELIBERATE negotiation moves. If the
    // validator's revision dropped any of them, the ORIGINAL draft wins - a
    // polite-but-toothless "Can you do X?" once cost a live negotiation its
    // competitive leverage. (Pattern precedent: the pickup-link survival check.)
    if (args.nodeKind === "bargain" && text !== args.draft) {
      const lost = leverageLost(args.draft, text, {
        rivalPrice: args.rivalPrice,
        target: args.target,
        durationDays: input.rfq?.durationDays,
      });
      if (lost.length) {
        push({
          stage: "style-validator",
          nodeId: "style-validator",
          input: text,
          reasoning: `leverage preserved - the revision dropped ${lost.join(" + ")}; keeping the original draft`,
          output: args.draft,
          verdict: "revised",
        });
        text = args.draft;
      }
    }
    // Global uniqueness (hundreds of users must never repeat a sentence) +
    // the warm-emoji tone policy. Skipped for local-language output - the
    // trigram store is English and an emoji swap there is safe anyway.
    let freshNote = "";
    if (!isLocalizedBargain) {
      const recent = await io.recentOutboundGlobal(6, 200).catch(() => []);
      // Module 4: two-layer guard - the in-process trigram compare (DB-fed)
      // PLUS the cross-fleet Redis signature window (no-op when REDIS_URL is unset). The
      // accepted text's compact signature is recorded so every other worker
      // sees this skeleton within one ZRANGE.
      const fresh = await ensureGloballyUnique(text, recent);
      if (fresh.changed) {
        freshNote = ` re-varied (overlap ${(fresh.maxOverlap * 100).toFixed(0)}%)`;
      }
      text = enforceEmojiTone(fresh.text, spec.settings.emojiTone);
    } else {
      // Local-language output skips the English trigram store, but the warm
      // emoji tone policy STILL applies (emojis are language-neutral) - the
      // audit found Ultra local-language bargains slipped past it entirely.
      text = enforceEmojiTone(text, spec.settings.emojiTone);
    }
    push({
      stage: "style-validator",
      nodeId: "style-validator",
      input: args.draft,
      reasoning: (validation.reasons.join("; ") || "clean") + freshNote,
      output: text,
      verdict: validation.verdict === "ok" && !freshNote ? "ok" : "revised",
    });
  }

  // Owner-banned phrases (policy overlay) - deterministic scrub, so a phrase
  // the owner outlawed in the Ops Center can never reach a shop again.
  try {
    const banned = (input.overlay ?? (await getPolicyOverlay())).bannedPhrases;
    const preScrub = text;
    const hits: string[] = [];
    for (const phrase of banned) {
      const rx = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      if (rx.test(text)) {
        hits.push(phrase);
        text = text.replace(rx, "").replace(/\s{2,}/g, " ").trim();
      }
    }
    if (hits.length) {
      push({
        stage: "style-validator",
        nodeId: "style-validator",
        input: hits.join(", "),
        reasoning: "owner-banned phrase removed (policy overlay)",
        output: text,
        verdict: "revised",
      });
      // The scrub runs AFTER the leverage guard - if a banned phrase
      // overlapped a price/duration token, the message just lost its levers
      // ("Can you do /day?"). The owner's ban is absolute (never restore the
      // phrase), so BLOCK delivery instead of sending a toothless ask: the
      // run-budget rollback lets the next event re-compose cleanly.
      if (args.nodeKind === "bargain") {
        const lost = leverageLost(preScrub, text, {
          rivalPrice: args.rivalPrice,
          target: args.target,
          durationDays: input.rfq?.durationDays,
        });
        if (lost.length) {
          push({
            stage: "style-validator",
            nodeId: "style-validator",
            input: text,
            reasoning: `banned-phrase scrub destroyed ${lost.join(" + ")} - blocking this send; the next turn recomposes without the banned phrase`,
            output: "(blocked)",
            verdict: "blocked",
          });
          return { delivered: "blocked", detail: "banned-phrase scrub removed a negotiation lever" };
        }
      }
    }
  } catch {
    /* scrub is best-effort */
  }

  // ---- localize ----------------------------------------------------------------
  if (nodeOn("localize") && useLocalLang && args.nodeId !== "bargain") {
    // The COUNTRY comes from the shop's own phone number when the thread has
    // no region label (owner report 4): the label-only lookup was the
    // 4-country ceiling that sent English to every +52/+51/+90 shop while
    // blaming the AI for it.
    const { countryForShop } = await import("../copy/region");
    const localeRegion =
      input.ctx.region || countryForShop(input.event.toDigits) || undefined;
    const localized = await localizeMessage(
      text,
      localeRegion,
      input.ctx.sender,
      spec.settings.streetLocal,
      // W4.7: rule 1 of the localize prompt orders a LOCAL greeting, which put
      // straight back the greeting `stripGreeting` had just removed - in a
      // script no deterministic rail downstream can read.
      { greet: input.priorOutbound.length === 0 }
    );
    if (localized.text && localized.text !== text) {
      englishGloss = localized.english ?? text;
      push({
        stage: "localize",
        nodeId: "localize",
        input: text,
        reasoning: "thread language stickiness - native local rewrite",
        output: localized.text,
      });
      text = localized.text;
    }
    // The reply paths used to fall back to English SILENTLY - the mass-send
    // route was the only emitter of localize-fallback. Same event, honest
    // reason, here too ("english-region" is a decision, not a failure).
    if (!localized.localized && localized.reason && localized.reason !== "english-region") {
      void sbInsert("agent_events", [
        {
          kind: "localize-fallback",
          user_email: input.ctx.sender ?? "",
          vendor_name: input.ctx.vendorName ?? input.event.toDigits,
          to_number: input.event.toDigits,
          detail: JSON.stringify({
            reason: localized.reason,
            region: localeRegion ?? null,
            path: "engine-reply",
          }).slice(0, 500),
        },
      ]).catch(() => {});
    }
  }

  // ---- safety --------------------------------------------------------------------
  if (nodeOn("safety")) {
    const verdict = await runSafety(text);
    if (!verdict.allowed) {
      push({
        stage: "safety",
        nodeId: "safety",
        input: text,
        reasoning: verdict.reason ?? "blocked by the safety screen",
        output: "(blocked)",
        verdict: "veto",
      });
      return { delivered: "blocked", detail: verdict.reason ?? "safety block" };
    }
  }

  // ---- negotiation integrity (deterministic pre-send validation) -------------
  // The last, un-bypassable arithmetic + constraint check on the FINAL text an
  // LLM produced. Catches the three failure classes no prompt fully prevents:
  // a fabricated rival, an inverted / sub-floor ask, and bargaining on a
  // vehicle that violates a hard user filter. Manual (non-auto) sends are never
  // touched - a human's own words are their own.
  {
    // (0) DURATION TRUTH: the message must state the traveller's REAL rental
    // length. An LLM freely writes the day count and, contaminated by few-shot
    // examples, drifts (5-day search -> "for 3 days") - which also sabotages a
    // "discount for long term" offer. checkOutboundNumbers can never catch this
    // (it strips every "N days" as a non-price), so duration gets its own
    // deterministic correction on EVERY outbound the engine composes. Keyed on
    // nothing but the presence of a wrong day count - safe for all node kinds.
    if (input.rfq?.durationDays) {
      const fixed = correctDuration(text, input.rfq.durationDays);
      if (fixed.changed) {
        push({
          stage: "safety",
          nodeId: "safety",
          input: text,
          reasoning: `duration guard: the draft said ${fixed.from.join("/")} day(s) but the traveller's rental is ${input.rfq.durationDays} days - corrected to the truth`,
          output: fixed.text,
          verdict: "revised",
        });
        text = fixed.text;
        englishGloss = undefined; // a corrected duration invalidates the gloss
        glossInvalidated = true;
      }
    }
    // (0.9) THE COMMITMENT RAIL - the same one SPTE runs, from one definition.
    //
    // The graph engine is the live FALLBACK and the sole engine on both
    // user-action routes, and it had no commitment rail at all: only SPTE
    // carried one, inside runPostRails, which needs a TurnContext this engine
    // does not have. So on precisely the paths where a traveller has just
    // tapped something, a composed message could book, reserve or accept on
    // their behalf - and a shop that holds a bike on that promise is a real
    // person losing a real rental when the traveller picks a cheaper shop.
    //
    // `closing-message` is the one node allowed through, because it exists only
    // after the traveller pressed Lock This Deal.
    //
    // A rejection here is NOT a dropped turn: it falls back to the safe
    // deterministic ask below, exactly as a numeric-guard rejection does.
    {
      const { checkCommitment, stripCommitment } = await import("../spte/rails");
      const committed = checkCommitment(text, args.nodeKind);
      if (committed) {
        push({
          stage: "safety",
          nodeId: "safety",
          input: text,
          reasoning: `commitment guard: ${committed.detail}`,
          output: "(rewritten)",
          verdict: "revised",
        });
        // Strip the committing sentence rather than the whole draft: the rest
        // of the turn is usually a legitimate question the shop is waiting on.
        text = stripCommitment(text);
        englishGloss = undefined;
        glossInvalidated = true;
        if (!text.trim()) {
          return { delivered: "blocked", detail: "commitment guard: nothing left to send" };
        }
      }
    }

    // The numeric + hard-constraint guards key on the node's KIND, never its id:
    // an owner-edited graph spec can rename a bargain node's id, and keying on id
    // would let the renamed node ship a fabricated rival past the guard.
    const PRICE_TREATING = new Set([
      "bargain",
      "momentum",
      "deposit-probe",
      "fulfillment-probe",
      "closing-message",
    ]);
    // (1) HARD-CONSTRAINT BREACH: the shop's price is for a vehicle that
    // violates the traveller's immutable filter (they asked manual, the shop
    // pivoted to an automatic). Decline that track - never bargain or accept it.
    if (
      hardConstraintBreached(input.rfq, input.extraction) &&
      PRICE_TREATING.has(args.nodeKind)
    ) {
      const decline = hardConstraintDecline(input.rfq);
      push({
        stage: "safety",
        nodeId: "safety",
        input: text,
        reasoning: `hard-constraint guard: the shop's offer is for a vehicle that violates the pinned ${
          input.rfq.transmission !== "any" ? input.rfq.transmission : "vehicle"
        } requirement - declining that track instead of bargaining on a garbage deal`,
        output: decline,
        verdict: "revised",
      });
      text = decline;
      englishGloss = undefined;
      glossInvalidated = true;
    } else if (["bargain", "momentum", "close", "answer"].includes(args.nodeKind)) {
      // (2) NUMERIC SANITY: fabricated rival (any of these nodes) + the
      // sub-floor / inverted-ask bounds (the price-asking bargain node only).
      const isBargain = args.nodeKind === "bargain";
      const excludeExact = [
        input.rfq?.durationDays,
        input.rfq?.engineSizeCc,
        input.rfq?.seats,
        input.rfq?.helmetCount,
        input.rfq?.driverAge,
      ].filter((n): n is number => typeof n === "number");
      const check = checkOutboundNumbers({
        text,
        ceiling: isBargain ? args.shopCeiling : undefined,
        floor: isBargain ? input.floorPrice : undefined,
        rivalPrice: args.rivalPrice,
        allowAbove: isBargain && args.sheetRef ? [args.sheetRef] : undefined,
        excludeExact,
        // PROVENANCE: a draft numeral must be a number this thread holds or a
        // closed derivation of one (total/days, daily*days, rounding). The
        // ladder target is grounded by construction (computeRoundTarget clamps
        // it to floor/quote/rival); an LLM-invented price is not, whatever the
        // bounds happen to allow.
        grounded: [
          args.target,
          args.shopCeiling,
          args.sheetRef,
          input.floorPrice,
          input.extraction?.pricePerDay,
          ...(input.extraction?.options ?? []).map((o) => o.pricePerDay),
          // Every numeral the conversation verbatim contains - a number
          // either party already said is never an invention.
          ...verbatimNumerals([
            input.history,
            input.event.kind !== "tick" ? input.event.shopMessage : undefined,
            ...input.priorOutbound,
          ]),
        ].filter((n): n is number => typeof n === "number" && n > 0),
        durationDays: input.rfq?.durationDays,
        checkAskBounds: isBargain,
      });
      if (!check.ok) {
        const { money } = await import("../agents");
        const safe = isBargain
          ? buildSafeBargainAsk({
              target: args.target,
              ceiling: args.shopCeiling,
              floor: input.floorPrice,
              durationDays: input.rfq?.durationDays,
              currency: input.currency,
              money,
            })
          : null;
        if (safe) {
          // Graceful fallback: replace the unsafe draft with an arithmetically
          // sane, rival-free ask at the ladder's already-clamped target.
          push({
            stage: "safety",
            nodeId: "safety",
            input: text,
            reasoning: `numeric guard (${check.violation}): ${check.detail} - repaired to a safe ask at the market-anchored target`,
            output: safe,
            verdict: "revised",
          });
          text = safe;
          englishGloss = undefined;
          glossInvalidated = true;
        } else {
          // No honest repair possible - block. The run-budget rollback in the
          // caller lets the next event recompose cleanly (never a lie sent).
          push({
            stage: "safety",
            nodeId: "safety",
            input: text,
            reasoning: `numeric guard (${check.violation}): ${check.detail} - blocking this send`,
            output: "(blocked)",
            verdict: "blocked",
          });
          return { delivered: "blocked", detail: `numeric-guard: ${check.violation}` };
        }
      }
    }
  }

  // ---- deliver --------------------------------------------------------------------
  const meta = {
    ...input.ctx,
    kind: args.kind,
    round: args.nextRound,
    auto: true,
    nodeId: args.nodeId,
    decisionId: args.decisionId,
    ...(englishGloss ? { englishGloss } : {}),
  };
  let delivered: DeliverResult;
  if (input.humanDelay && input.ctx.sender) {
    // Human thinking time (instant replies are THE robotic tell). The director
    // hold extends it - patience is a deliberate tactic.
    // Snappy but human: an engaged shop is waiting, so replies land within
    // ~1-2 min (owner: "respond within a minute or two"), not up to 4. The
    // director hold still extends it deliberately.
    const jitter =
      args.kind === "auto-close" || args.kind === "auto-answer"
        ? 10 + Math.floor(Math.random() * 15) // 10-25s
        : args.kind === "auto-deposit-probe" || args.kind === "auto-fulfillment-probe"
        ? 15 + Math.floor(Math.random() * 25) // 15-40s
        : args.kind === "deal-close" || args.kind === "auto-pickup-location"
        ? 8 + Math.floor(Math.random() * 17) // the traveller just acted - quick is natural
        : 15 + Math.floor(Math.random() * 25); // bargains "think" 15-40s
    // A director/strategic WAIT is a deliberate tactic, but never let it blow the
    // ~2 min counter-reply ceiling for an engaged shop - clamp it to 90s.
    const delayS = args.holdSeconds != null ? Math.min(args.holdSeconds, 90) : jitter;
    await io.queueOutbox({
      senderKey: input.ctx.sender,
      toNumber: input.event.toDigits,
      body: text,
      notBeforeMs: io.now() + delayS * 1000,
      meta: {
        ...meta,
        reason: args.holdSeconds
          ? "director hold - choosing the best reply order"
          : "human reply pacing (thinking time)",
      },
    });
    delivered = {
      delivered: "queued",
      detail: args.holdSeconds ? `director hold ${delayS}s` : `human pacing ${delayS}s`,
      finalText: text,
      queuedUntil: new Date(io.now() + delayS * 1000).toISOString(),
    };
  } else {
    delivered = await io.guardAndSend({
      senderKey: input.ctx.sender ?? "system",
      toNumber: input.event.toDigits,
      text,
      meta,
      shopOpenNow: input.shopOpenNow,
    });
  }
  push({
    stage: "deliver",
    nodeId: "deliver",
    input: text,
    reasoning: delivered.detail,
    output:
      delivered.delivered === "sent"
        ? delivered.finalText ?? text
        : `(${delivered.delivered}${delivered.queuedUntil ? ` until ${delivered.queuedUntil}` : ""})`,
  });

  // ---- re-gloss (owner report 4, item 8) --------------------------------------
  // A deterministic repair (duration fix, commitment strip) on a LOCALIZED
  // text dropped the English gloss, leaving the traveller blind to what was
  // sent in their name - on exactly the turns where a rail rewrote the words.
  // Fire-and-forget, same pattern as the inbound gloss: translate the FINAL
  // text and stamp it onto the row the send produced. Only non-Latin text
  // qualifies (a repair that produced English needs no gloss).
  if (glossInvalidated && !englishGloss && delivered.delivered !== "blocked" && input.ctx.sender) {
    const finalText = delivered.finalText ?? text;
    const letters = finalText.replace(/[^\p{L}]/gu, "");
    const ascii = letters.replace(/[^A-Za-z]/g, "");
    if (letters.length > 0 && ascii.length / letters.length < 0.9) {
      const senderKey = input.ctx.sender;
      const toNumber = input.event.toDigits;
      const wasQueued = delivered.delivered === "queued";
      const { finishBeforeResponse } = await import("../after");
      await finishBeforeResponse("outbound-regloss", async () => {
        try {
          const { translateToEnglish } = await import("../agents");
          const english = await translateToEnglish(finalText);
          if (!english) return;
          const { sbSelect: sel, sbUpdate } = await import("../runtime-config");
          const { numberFilter } = await import("../wa/phone-key");
          const encSender = encodeURIComponent(senderKey);
          if (wasQueued) {
            const rows = await sel<{ id: number; meta: Record<string, unknown> | null }>(
              "wa_outbox",
              `select=id,meta&sender_key=eq.${encSender}&order=id.desc&limit=1${numberFilter("to_number", toNumber)}`
            );
            if (rows[0]) {
              await sbUpdate("wa_outbox", `id=eq.${rows[0].id}`, {
                meta: { ...(rows[0].meta ?? {}), englishGloss: english },
              });
            }
          } else {
            const rows = await sel<{ id: number; raw: Record<string, unknown> | null }>(
              "whatsapp_messages",
              `select=id,raw&direction=eq.outbound&raw->>sender=eq.${encSender}&order=id.desc&limit=1${numberFilter("to_number", toNumber)}`
            );
            if (rows[0]) {
              await sbUpdate("whatsapp_messages", `id=eq.${rows[0].id}`, {
                raw: { ...(rows[0].raw ?? {}), englishGloss: english },
              });
            }
          }
        } catch {
          /* the gloss is a bonus - never the send */
        }
      });
    }
  }

  // ---- judge enqueue (never inline - a cheap later invocation grades it) ------
  if (
    delivered.delivered !== "blocked" &&
    Math.random() < spec.settings.judgeSampleRate &&
    args.kind !== "deal-close"
  ) {
    await io
      .insertWakeup({
        kind: "judge",
        threadKey: input.event.threadKey,
        notBefore: new Date(io.now() + 90_000).toISOString(),
        payload: {
          decisionId: args.decisionId,
          nodeId: args.nodeId,
          tacticId: args.tacticId,
          text,
          kind: args.kind,
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          vendorName: input.ctx.vendorName,
        },
      })
      .catch(() => {});
  }
  return delivered;
}

// ---------------------------------------------------------------------------
// Live IO
// ---------------------------------------------------------------------------

export type LiveSend = (
  senderKey: string,
  to: string,
  text: string,
  /**
   * Which send budget this draws from. A graph wakeup is by definition a turn
   * in a conversation that is already running - and after the engagement halt
   * change, a wakeup aimed at a shop that never replied is terminally dropped
   * before it reaches here. So everything that survives to this point is reply
   * traffic, and metering it against the cold-intro budget is what let a big
   * batch starve its own negotiation.
   */
  lane?: "intro" | "reply"
) => Promise<SendResult>;

export function liveGraphIO(send: LiveSend): GraphIO {
  return {
    loadState: loadThreadState,
    saveState: saveThreadState,
    async cheapestRival({ userEmail, vendorId, currency, vehicleKey, belowPrice, durationDays }) {
      // REAL session boundary (latest search, 18h-clamped) + the shared pure
      // predicate - the same function the playground filters through, so
      // owner tests exercise production selection logic byte-for-byte.
      const { cheapestRivalFor } = await import("../search-session");
      return cheapestRivalFor(userEmail, {
        vendorId,
        currency,
        vehicleKey,
        belowPrice,
        durationDays,
      });
    },
    async sessionTable(userEmail, thisVendorId, vehicleKey, spec) {
      const { sessionSinceIso, currentSession } = await import("../search-session");
      const since = await sessionSinceIso(userEmail);
      // SCOPED BY SEARCH, NOT ONLY BY CLOCK.
      //
      // This filtered on user + vehicle + an 18h window and nothing else, while
      // the sibling rival path enforces an exact `search_id` and calls that
      // scoping "leak-proof where the 18h time window is not". Two hunts for
      // the same vehicle class in different cities inside 18h therefore
      // cross-contaminated the PRIMARY engine's leverage - a Krabi price cited
      // at a Canggu shop. `search_id` has been on the offers table the whole
      // time and this read ignored it.
      //
      // Null-tolerant: rows written before the column was populated have no id
      // and must not vanish from a running hunt's board.
      const session = await currentSession(userEmail).catch(() => null);
      const sameSearch =
        session?.id != null
          ? `&or=(search_id.eq.${encodeURIComponent(String(session.id))},search_id.is.null)`
          : "";
      // SAME VEHICLE OR IT IS NOT A RIVAL. Without this predicate a quote for a
      // different machine - another search inside the same window - could be
      // cited at a shop as a competing price for THIS one. Leverage has to
      // compare like with like; a cross-vehicle "rival" is an invented argument.
      const sameVehicle = vehicleKey
        ? `&vehicle_key=eq.${encodeURIComponent(vehicleKey)}`
        : "";
      // A FEW CHATTY SHOPS USED TO CONSUME THE WHOLE WINDOW.
      //
      // `limit=16` is applied by Postgres BEFORE the per-vendor dedupe below,
      // and a negotiation writes one `offers` row per round - so three shops
      // that went five rounds each filled all sixteen slots and every other
      // shop in the hunt was invisible to the leverage read. The bound has to
      // be per VENDOR, not per row, and the dedupe that makes it per-vendor
      // lives here in code. 200 rows is a session's worth of rounds and still
      // one bounded query.
      //
      // `quote_basis_days` rides along: a per-day we divided out of a package
      // is not a like-for-like rival (owner report 5 #2), and the predicate
      // downstream needs the span to say so. Schema-graceful - a host that has
      // not re-run schema.sql loses the provenance, not the rivals.
      type OfferRow = {
        vendor_id: string;
        vendor_name: string;
        price_per_day: number;
        currency: string;
        duration_days?: number | null;
        quote_basis_days?: number | null;
      };
      const offerWhere = `&user_email=eq.${encodeURIComponent(
        userEmail
      )}&simulated=eq.false&created_at=gte.${encodeURIComponent(
        since
      )}${sameVehicle}${sameSearch}&order=created_at.desc&limit=200`;
      const strictOffers = await sbSelectStrict<OfferRow>(
        "offers",
        `select=vendor_id,vendor_name,price_per_day,currency,duration_days,quote_basis_days${offerWhere}`
      );
      const offers =
        "rows" in strictOffers
          ? strictOffers.rows
          : await sbSelect<OfferRow>(
              "offers",
              `select=vendor_id,vendor_name,price_per_day,currency${offerWhere}`
            ).catch(() => []);
      // Newest-first and per-session-sized (owner report 6 C4): the old
      // `limit=16` with NO order clause was an arbitrary sample of the hunt -
      // large hunts starved the swarm and the dead-shop filter of whole shops.
      const threads = await sbSelect<{
        vendor_id: string | null;
        vendor_name: string | null;
        to_number: string | null;
        phase: string;
        fields: Record<string, unknown> | null;
      }>(
        "negotiation_threads",
        `select=vendor_id,vendor_name,to_number,phase,fields&user_email=eq.${encodeURIComponent(
          userEmail
        )}&updated_at=gte.${encodeURIComponent(since)}&order=updated_at.desc&limit=200`
      ).catch(() => []);
      const rows = new Map<string, SessionShopRow>();
      const numberByVendor = new Map<string, string>();
      for (const t of threads) {
        if (!t.vendor_id) continue;
        if (t.to_number) numberByVendor.set(t.vendor_id, t.to_number);
        const fx = (t.fields ?? {}) as {
          pricePerDay?: number;
          priceBasisDays?: number;
          currency?: string;
          vehicleKey?: string;
          depositType?: string;
          depositNote?: string;
          fulfillment?: string;
          firmCount?: number;
          declined?: boolean;
          shopUnavailable?: boolean;
          rounds?: number;
          presented?: boolean;
          digest?: { firmCount?: number };
        };
        // SAME VEHICLE OR IT IS NOT A RIVAL - for THREAD rows too. The offers
        // query filters vehicle_key; this join never did, so a thread priced
        // in a different-vehicle hunt inside the window walked straight into
        // the rival set (negotiation_threads is keyed user:number with no
        // vehicle dimension at all). A row that DECLARES a different vehicle
        // is out; undeclared legacy rows stay (dropping them would silently
        // empty the swarm for every pre-stamp thread).
        if (vehicleKey && fx.vehicleKey && fx.vehicleKey !== vehicleKey) continue;
        rows.set(t.vendor_id, {
          vendorId: t.vendor_id,
          vendorName: t.vendor_name ?? t.vendor_id,
          pricePerDay: fx.pricePerDay,
          quoteBasisDays: typeof fx.priceBasisDays === "number" ? fx.priceBasisDays : undefined,
          currency: fx.currency,
          phase: t.phase as SessionShopRow["phase"],
          complete: Boolean(
            fx.pricePerDay && (fx.depositType || fx.depositNote) && fx.fulfillment
          ),
          isThisShop: t.vendor_id === thisVendorId,
          // Carried so the SWARM can act on this row, not only quote it: a
          // sibling re-bargain needs the number to build a thread key, and the
          // firm ladder to know which shops have already refused twice.
          toNumber: t.to_number ?? undefined,
          // THE FIRM LADDER, READ FROM WHERE IT IS ACTUALLY WRITTEN.
          //
          // This read `fields.digest.firmCount`, and firmCount is NOT a
          // persisted digest field - `persistableDigest` deliberately omits it
          // because it is projected per turn from the durable comprehension.
          // Both engines write the durable copy to `fields.firmCount`
          // (graph/state.ts applyExtractionToState, spte/live.ts
          // persistThreadOutcome). So this was undefined on every row ever
          // built, and `planSiblingRebargain`'s "a shop that has said last
          // price twice has answered" guard could never fire: the swarm would
          // re-open a conversation the shop had closed, which is precisely the
          // promise this app makes. The digest path is kept as a fallback for
          // any row that does carry it.
          firmCount:
            typeof fx.firmCount === "number"
              ? fx.firmCount
              : typeof fx.digest?.firmCount === "number"
                ? fx.digest.firmCount
                : undefined,
          // THE SESSION BRIEF'S FACTS (ask 5). Already in `fields`, already
          // loaded, and thrown away by this projection until now - so knowing
          // that shop C said no, that shop D is still silent, or that this is
          // the last shop left costs no extra query at all.
          declined: fx.declined === true ? true : undefined,
          outOfStock: fx.shopUnavailable === true ? true : undefined,
          rounds: typeof fx.rounds === "number" && fx.rounds > 0 ? fx.rounds : undefined,
          presented: fx.presented === true ? true : undefined,
        });
      }
      for (const o of offers) {
        const existing = rows.get(o.vendor_id);
        // A real `offers` row WINS over a PRICELESS thread row. Previously the
        // thread row always short-circuited (`if (rows.has) continue`), so a
        // stale/empty negotiation_threads row masked a genuine offer - which is
        // exactly why Shop A's confirmed 300 never reached Shop B's prompt.
        if (existing && typeof existing.pricePerDay === "number") {
          // ...but the basis must not be masked with it (owner report 6 C3):
          // when the winning thread row carries no provenance and the offers
          // row for the SAME number does, adopt it - otherwise a divided
          // package per-day re-enters siblings as a quoted daily rate.
          if (
            existing.quoteBasisDays == null &&
            o.quote_basis_days != null &&
            existing.pricePerDay === o.price_per_day
          ) {
            existing.quoteBasisDays = o.quote_basis_days;
          }
          continue;
        }
        rows.set(o.vendor_id, {
          vendorId: o.vendor_id,
          vendorName: o.vendor_name || o.vendor_id,
          pricePerDay: o.price_per_day,
          currency: o.currency,
          phase: existing?.phase,
          complete: existing?.complete,
          isThisShop: o.vendor_id === thisVendorId,
          quoteBasisDays: o.quote_basis_days ?? undefined,
          durationDays: o.duration_days ?? undefined,
          // THE ACTIONABLE HALF OF THE ROW, CARRIED THROUGH THE OFFERS JOIN.
          //
          // This branch REPLACES the thread row wholesale, and it used to
          // rebuild it without `toNumber` or `firmCount` - the only two fields
          // that make a row something the swarm can act on rather than merely
          // quote. `planSiblingRebargain` drops any row with no `toNumber`
          // ("no live thread to re-enter"), so the exact shops this join exists
          // to rescue - a live thread whose price lives in `offers` because the
          // thread fields never got one - were silently unreachable by the
          // sibling re-bargain. That is the owner's "we are not bargaining
          // enough" (report 5 #9) surviving its own fix.
          //
          // `numberByVendor` is the same thread-derived map the board-price
          // rescue below trusts; `existing` covers a thread row that was merged
          // first. Losing `firmCount` was the quieter half: a shop that has
          // said "last price" twice would have been re-opened anyway, breaking
          // the firm ladder in the one path that skipped it.
          toNumber: existing?.toNumber ?? numberByVendor.get(o.vendor_id),
          firmCount: existing?.firmCount,
          // The session brief's facts survive the replacement for exactly the
          // same reason: this branch rebuilds the row wholesale, so anything it
          // does not carry is lost for every shop whose price lives in offers.
          declined: existing?.declined,
          outOfStock: existing?.outOfStock,
          rounds: existing?.rounds,
          presented: existing?.presented,
        });
      }

      // A BOARD PHOTOGRAPHED IN THREAD A IS LEVERAGE IN THREAD B (owner
      // report 4). The vision pass stamps its MediaReading (prices included)
      // on the inbound message row - and that store was joined by nothing, so
      // a shop whose photographed prices never became a formal offer (a
      // multi-option board, a read that missed the traveller's exact spec)
      // was invisible to every sibling negotiation. Fold the cheapest read
      // price into rows that still lack one, at the SAME trust level thread
      // fields already get (the currency/phase validity filters in
      // validRivals apply downstream either way). Rows that have a price keep
      // it - a quote the shop typed beats a board we read.
      {
        // What every priced row in this hunt is stamped with - the fallback for
        // a board price the reader could not attach a currency to.
        const tally = new Map<string, number>();
        for (const r of rows.values()) {
          if (typeof r.pricePerDay === "number" && r.currency) {
            tally.set(r.currency, (tally.get(r.currency) ?? 0) + 1);
          }
        }
        const sessionCurrency = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const priceless = [...rows.values()].filter(
          (r) => typeof r.pricePerDay !== "number" && numberByVendor.has(r.vendorId)
        );
        if (priceless.length > 0) {
          // ONE query serves every priceless shop; number matching happens in
          // code (tolerant, like every other cross-spelling comparison).
          const { sameNumber } = await import("../wa/phone-key");
          // A CROSSED-OUT ROW IS NOT A RIVAL PRICE. `available === false` means
          // the board struck the row through - a model this shop no longer
          // rents - and this table is quoted at OTHER shops as "another shop
          // does 150". Taking `prices[0]` unfiltered told every sibling
          // negotiation a number nobody could book, and moved their floor to
          // match it. Only the panel honoured the flag; the two places that
          // turn a reading into a NUMBER did not (this one and /api/replies).
          const { pickBoardPrice } = await import("../media/reading");
          const readRows = await sbSelect<{
            from_number: string | null;
            raw: {
              reading?: {
                prices?: Array<{ pricePerDay?: number; currency?: string; available?: boolean }>;
              };
            } | null;
          }>(
            "whatsapp_messages",
            `select=from_number,raw&direction=eq.inbound&raw->>receiver=eq.${encodeURIComponent(
              userEmail
            )}&received_at=gte.${encodeURIComponent(since)}&raw->reading=not.is.null` +
              `&order=received_at.desc&limit=24`
          ).catch(() => []);
          for (const r of priceless) {
            const digits = numberByVendor.get(r.vendorId)!;
            const read = readRows.find(
              (m) =>
                m.from_number &&
                sameNumber(m.from_number, digits) &&
                // ...and a message whose ONLY rows are struck out must not
                // claim this shop, or the newest such message shadows an older
                // one that really did carry a quotable board.
                pickBoardPrice(
                  m.raw?.reading?.prices,
                  spec?.engineSizeCc ?? 0,
                  spec?.durationDays ?? 0
                ) !== null
            );
            // THE SAME CELL THE CARD SHOWS. cheapestQuotable filters only
            // crossed-out rows, so the cheapest LONG-STAY tier - a column a
            // short traveller cannot buy - became this shop's rival price, and
            // the cite-the-rival rail then obliged the agent to name it at
            // another shop. Leverage has to compare like with like or it is
            // fiction, and a tier the traveller cannot book is fiction.
            const cheapest = pickBoardPrice(
              read?.raw?.reading?.prices,
              spec?.engineSizeCc ?? 0,
              spec?.durationDays ?? 0
            );
            if (cheapest && typeof cheapest.pricePerDay === "number" && cheapest.pricePerDay > 0) {
              rows.set(r.vendorId, {
                ...r,
                pricePerDay: cheapest.pricePerDay,
                // A BOARD PRICE WITH NO CURRENCY IS A RIVAL NOBODY CAN USE.
                //
                // `validRivals` requires strict currency equality, and a
                // priceless thread row has no currency to inherit - so a price
                // rescued off a photo arrived with `currency: undefined` and
                // was dropped by the very next filter. Every one of these rows
                // came off a board in THIS session, and the session's own
                // currency is what every other row in it is stamped with.
                currency: cheapest.currency ?? r.currency ?? sessionCurrency,
              });
            }
          }
        }
      }
      // SORT BEFORE YOU TRUNCATE - the highest-value line in the leverage path.
      //
      // This was `[...rows.values()].slice(0, 10)` on a Map in INSERTION order
      // (threads by updated_at desc, then offers-only vendors). So in any hunt
      // with more than ten shops the cheapest quote could simply fall off the
      // end before `validRivals` ever saw it - and the cheapest quote is the
      // entire point of the leverage card. That is exactly the "the 300 shop
      // never heard about the 200" failure, and it got quietly more likely the
      // bigger the hunt got.
      //
      // The ranking and the two-ended truncation now live in `./session-table`
      // as pure functions, and the reason is a test-integrity one: the test
      // that guards this behaviour used to re-implement the comparator inside
      // the test file, so it passed no matter what this closure did. It runs
      // the real function now.
      return sessionTableRows([...rows.values()]);
    },
    async insertWakeup(row: WakeupRow) {
      // Stamp the owning user so purges match EXACTLY (user_email=eq.) instead
      // of LIKE patterns where '_' in an email is itself a wildcard. Retry
      // without the column until the owner has re-run schema.sql.
      const sep = row.threadKey.lastIndexOf(":");
      const base = {
        kind: row.kind,
        thread_key: row.threadKey,
        not_before: row.notBefore,
        payload: row.payload ?? null,
      };
      const ok = await sbInsert("graph_wakeups", [
        { ...base, user_email: sep > 0 ? row.threadKey.slice(0, sep) : null },
      ]);
      if (!ok) await sbInsert("graph_wakeups", [base]);
    },
    async clearWakeups(threadKey, kind) {
      const { sbDeleteReturning } = await import("../runtime-config");
      await sbDeleteReturning(
        "graph_wakeups",
        `thread_key=eq.${encodeURIComponent(threadKey)}${kind ? `&kind=eq.${kind}` : ""}`
      ).catch(() => {});
    },
    async queueOutbox({ senderKey, toNumber, body, notBeforeMs, meta }) {
      // Dedup: one pending row per shop. A re-run wakeup / repeated tick / new
      // compose REPLACES any older pending row instead of piling up duplicates.
      const { parkOutboxOnce } = await import("../wa/park");
      await parkOutboxOnce({ senderKey, toNumber, body, notBeforeMs, meta: meta ?? undefined });
    },
    async guardAndSend({ senderKey, toNumber, text, meta, shopOpenNow }) {
      const { guardOutbound, afterSend } = await import("../wa-guard");
      const { parkOutboxOnce } = await import("../wa/park");
      const verdict = await guardOutbound({
        senderKey,
        toDigits: toNumber,
        text,
        auto: true,
        queueIfBlocked: true,
        meta,
        shopOpenNow,
      });
      if (!verdict.allow) {
        // A COMPOSED REPLY MUST NOT DIE HERE.
        //
        // The drain has always known this rule - `needsRepark` in
        // wa/outbox-policy.ts says it in one line: "non-terminal reject that
        // did not re-queue -> re-park or lose it". But this INLINE path (which
        // is where replies actually go; parking is the exception) had no
        // equivalent, so a non-terminal verdict that did not queue - an
        // engagement-probe read that came back unavailable, a failed outbox
        // insert - returned "held" and the reply was simply gone. Worse,
        // agent-loop then settles the inbound claim, so the recovery sweep
        // will not retry it either. The shop asked a question and got silence,
        // permanently.
        //
        // PARK THE MESSAGE, KEEP THE CLAIM. Those are two different jobs and
        // one bug conflated them: the claim stops the same INBOUND being
        // reprocessed in a loop; the parked row is how the OUTBOUND still
        // gets delivered. A terminal verdict (cancelled, opted-out, duplicate)
        // is a deliberate drop and must NOT be resurrected.
        const { needsRepark } = await import("../wa/outbox-policy");
        if (needsRepark(verdict)) {
          const { parkOutboxOnce } = await import("../wa/park");
          await parkOutboxOnce({
            senderKey,
            toNumber,
            body: verdict.text ?? text,
            notBeforeMs: Date.now() + 60_000,
            meta: {
              ...(meta as Record<string, unknown>),
              reason: verdict.reason ?? "re-parked after a non-terminal hold",
            },
            alreadyHumanized: true,
          }).catch(() => {});
        }
        return {
          delivered: verdict.queuedUntil ? "queued" : "held",
          detail: verdict.reason ?? "held by the anti-ban gate",
          queuedUntil: verdict.queuedUntil,
          finalText: verdict.text,
          // The exact row, so Ops can say WHERE it is held rather than only
          // that it is (F10).
          outboxRowId: verdict.outboxRowId,
        };
      }
      // LAST-INSTANT FRESHNESS RE-CHECK: is this still the right thing to say?
      //
      // The freshness guard was built for PARKED drafts and lived only in the
      // drain - but parking is the exception. This path composes a reply and
      // sends it in the same request after a human-like pause of up to ten
      // seconds, and it never asked the question at all. So the exact Ko Tao
      // failure (an answer written at 12:23, sent at 12:39, into a conversation
      // that had moved on at 12:38) stayed fully reproducible on the path that
      // carries most of the traffic.
      //
      // A draft that no longer fits does not go out and does not vanish: the
      // thread is handed a fresh turn against the current state.
      try {
        const { threadMovedOn, scheduleRecompose } = await import("../wa/freshness-live");
        const stale = await threadMovedOn({
          senderKey,
          toNumber,
          composedAgainst: (meta as { composedAgainst?: import("../wa/freshness").ComposedAgainst })
            ?.composedAgainst,
          kind: (meta as { kind?: string } | undefined)?.kind,
        });
        if (stale.stale) {
          // to_number is the message-path join key; retried without it so an
          // un-migrated database loses the join, never the event.
          const staleEv = {
            kind: "wa-send-stale",
            user_email: senderKey,
            vendor_name: String((meta as { vendorName?: string } | undefined)?.vendorName ?? toNumber),
            detail: `inline ${stale.reason}: ${stale.detail ?? ""}`.slice(0, 300),
          };
          const staleOk = await sbInsert("agent_events", [{ ...staleEv, to_number: toNumber }]).catch(
            () => false
          );
          if (!staleOk) await sbInsert("agent_events", [staleEv]).catch(() => {});
          await scheduleRecompose(senderKey, toNumber, "stale-draft-recompose");
          return {
            delivered: "blocked",
            detail: `dropped as stale (${stale.reason}) - recomposing against what the shop just said`,
            finalText: verdict.text,
          };
        }
      } catch {
        /* fail open: an unreadable thread must never delete a good reply */
      }
      // LAST-INSTANT cancellation re-check: narrows the window between the
      // guard's verdict and the actual network send, so a user tapping Remove
      // right now still wins. (The sub-second residue is a documented limit.)
      try {
        const { isCancelled } = await import("../wa/cancellations");
        if ((await isCancelled(senderKey, toNumber)) === true) {
          return {
            delivered: "blocked",
            detail: "cancelled-by-user - removed moments before sending",
            finalText: verdict.text,
          };
        }
        // The same last-instant question for the OTHER absolute veto: the
        // traveller may have started typing in this shop's chat since the
        // guard ran. Fails closed on an unreadable store - talking over a
        // human is the harm this cannot risk.
        const { isThreadTakenOver } = await import("../session-flags");
        if ((await isThreadTakenOver(senderKey, toNumber)) !== false) {
          return {
            delivered: "blocked",
            detail: "human-takeover - the traveller is handling this thread",
            finalText: verdict.text,
          };
        }
      } catch {
        /* guard already enforced the readable cases */
      }
      // ATOMIC SEND SLOTS: serialize concurrent invocations (min-gap window)
      // and make delivery idempotent per unique message - the guard's own
      // checks are read-then-act and cannot do this alone.
      const { claimForSend, releaseSendClaim } = await import("../wa-guard");
      // A reply/follow-up to an engaged shop paces per-recipient (distinct
      // shops never serialize on each other); a cold intro keeps per-sender.
      const sendKind = (meta as { kind?: string } | undefined)?.kind;
      const isReplySend = sendKind !== "rfq" && sendKind !== "custom";
      let claim = await claimForSend(senderKey, toNumber, verdict.text, true, isReplySend);
      // WAIT, DON'T RE-PARK: the lane a REPLY loses frees in seconds (the
      // claim says exactly when), and this turn is already in-request with
      // its own deadline - sleeping to the edge and re-claiming ONCE delivers
      // the reply now instead of parking it 20-40s out and paying the next
      // drain's whole pipeline. One wait, bounded to a single lane window;
      // cold intros never wait (their minute-scale holds are the anti-ban
      // point, not an artefact).
      // A send crosses three lanes, so one wait clears at most one of them.
      // Waiting once and giving up meant the ordinary case - several shops
      // answering at once, losing the gap lane and then the fleet lane - parked
      // anyway, having already spent the wait. Bounded per-loss AND in total,
      // so a contended lane cannot hold this turn open indefinitely.
      let inlineWaitBudgetMs = 12_000;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!isReplySend || claim.ok || claim.kind !== "pacing") break;
        if (typeof claim.retryAtMs !== "number") break;
        const waitMs = claim.retryAtMs - Date.now();
        if (!(waitMs > 0) || waitMs > 8_000 || waitMs > inlineWaitBudgetMs) break;
        inlineWaitBudgetMs -= waitMs;
        await new Promise((res) => setTimeout(res, waitMs + 120 + Math.random() * 380));
        claim = await claimForSend(senderKey, toNumber, verdict.text, true, isReplySend);
      }
      if (!claim.ok) {
        if (claim.kind === "duplicate") {
          return {
            delivered: "blocked",
            detail: "duplicate in flight - another invocation is delivering this message",
            finalText: verdict.text,
          };
        }
        const { jitteredHold, RECIPIENT_LOCK_SEC } = await import("../wa/pacing");
        // LANE-PROPORTIONAL, AND THIS IS THE PATH THAT CARRIES THE REPLY.
        //
        // Wave 8's own reasoning - the lanes a reply loses are measured in
        // SECONDS, so anything beyond them is invented latency - was applied to
        // the drain and not here, on the INLINE path SPTE actually uses. So the
        // penalty stack the wave says it killed was still 20-40s for losing a
        // <=8s lane. The park is now sized to the lane, like the drain's, and
        // uses the refusing lane's own free-at instant when it named one.
        // A cold intro keeps the minute-scale hold: velocity to new numbers is
        // the ban vector, and that lane is 12s+ anyway.
        const replyParkMs =
          typeof claim.retryAtMs === "number"
            ? Math.max(2_000, Math.min(30_000, claim.retryAtMs - Date.now())) +
              Math.round(Math.random() * 3_000)
            : RECIPIENT_LOCK_SEC * 1000 + 2_000 + Math.round(Math.random() * 4_000);
        const notBefore = isReplySend
          ? new Date(Date.now() + replyParkMs).toISOString()
          : jitteredHold(Date.now(), 1, 2);
        // parkOutboxOnce, NOT a raw insert: the partial unique index rejects a
        // second pending auto row for this (shop, kind), and the bare insert
        // swallowed that 409 while the caller reported "queued" - a reply that
        // then never existed anywhere. The park helper dedups against the
        // existing row, arms the drain, and reports failure durably.
        const { parkOutboxOnce } = await import("../wa/park");
        await parkOutboxOnce({
          senderKey,
          toNumber,
          body: verdict.text,
          notBeforeMs: Date.parse(notBefore),
          meta: { ...meta, reason: claim.kind === "pacing" ? "human pacing gap" : "sync-retry" },
          // The text already went through guardOutbound's humanize pass.
          alreadyHumanized: true,
        }).catch(() => {});
        return {
          delivered: "queued",
          detail: claim.kind === "pacing" ? "held for human pacing" : "held - retrying sync",
          queuedUntil: notBefore,
          finalText: verdict.text,
        };
      }
      // A THROW from send() (transport reject, dynamic-import hiccup) must be
      // treated exactly like a failed send: release the idempotency claim and
      // re-queue. Without this the claim leaked and the identical reply was then
      // refused as a `duplicate` for the whole claim-GC horizon (audit DEFECT 4).
      let result: SendResult;
      try {
        result = await send(senderKey, toNumber, verdict.text);
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : "send threw" };
      }
      // Keep the claim on an AMBIGUOUS failure - it may have landed, and
      // releasing it lets a duplicate follow (OR11 H2.2, now honoured on this
      // path too, not only in the drain).
      if (!result.ok && !result.ambiguous)
        await releaseSendClaim(senderKey, toNumber, verdict.text).catch(() => {});
      if (result.ok) {
        await afterSend(senderKey, toNumber);
        await sbInsert("whatsapp_messages", [
          {
            // Provider id -> the webhook echo-check matches by id, never by body.
            wa_message_id: (result as { messageId?: string }).messageId ?? null,
            to_number: toNumber,
            body: verdict.text,
            type: "text",
            direction: "outbound",
            // confirmed=false: Evolution accepted the request but returned no
            // delivery receipt (see sendFromUser) - recorded honestly.
            raw: {
              ...meta,
              sender: senderKey,
              confirmed: (result as { unconfirmed?: boolean }).unconfirmed ? false : true,
            },
          },
        ]);
        return { delivered: "sent", detail: "sent through the user's WhatsApp", finalText: verdict.text };
      }
      // NEVER LOSE A COMPOSED REPLY. A transient send failure (reconnecting,
      // timeout, 5xx) must not drop the shop's answer on the floor - park it so
      // the next drain retries it. Dedup keeps it to one pending row per shop.
      await parkOutboxOnce({
        senderKey,
        toNumber,
        body: verdict.text,
        notBeforeMs: Date.now() + 30_000,
        meta: { ...(meta as Record<string, unknown>), reason: "reconnecting - reply resumes automatically" },
        // verdict.text already carries the guard's humanize pass - verbatim.
        alreadyHumanized: true,
      }).catch(() => {});
      return {
        delivered: "queued",
        detail: `send failed (${result.error ?? "unknown"}) - reply re-queued`,
        queuedUntil: new Date(Date.now() + 30_000).toISOString(),
        finalText: verdict.text,
      };
    },
    async markPresentable({ userEmail, vendorId, fulfillment }) {
      if (!vendorId) return;
      const rows = await sbSelect<{ id: number }>(
        "offers",
        `select=id&vendor_id=eq.${encodeURIComponent(vendorId)}${
          userEmail ? `&user_email=eq.${encodeURIComponent(userEmail)}` : ""
        }&simulated=eq.false&order=created_at.desc&limit=1`
      ).catch(() => []);
      if (!rows[0]?.id) return;
      await sbUpdate("offers", `id=eq.${rows[0].id}`, {
        presentable: true,
        ...(fulfillment ? { fulfillment } : {}),
      }).catch(() => {});
    },
    async insertBargainDraft({ userEmail, vendorId, tactic, message }) {
      await sbInsert("bargain_drafts", [
        {
          user_email: userEmail ?? null,
          vendor_id: vendorId ?? "",
          tactic,
          message,
        },
      ]);
    },
    async recentOutboundGlobal(hours, limit) {
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const rows = await sbSelect<{ body: string | null }>(
        "whatsapp_messages",
        `select=body&direction=eq.outbound&received_at=gte.${encodeURIComponent(
          since
        )}&order=received_at.desc&limit=${Math.min(500, limit)}`
      );
      return rows.map((r) => r.body ?? "").filter(Boolean);
    },
    writeTrace,
    async recordEvent({ kind, vendorId, vendorName, userEmail, toDigits, detail }) {
      const base = { kind, vendor_id: vendorId ?? "", vendor_name: vendorName ?? "", detail };
      // Addressed, so the message-path trail can find it. Same degrade ladder
      // the stale-draft event uses: retry bare if `to_number` is missing on a
      // pre-migration deployment - an unaddressed event still beats none.
      const addressed = {
        ...base,
        ...(userEmail ? { user_email: userEmail } : {}),
        ...(toDigits ? { to_number: toDigits } : {}),
      };
      const ok = await sbInsert("agent_events", [addressed]).catch(() => false);
      if (!ok) await sbInsert("agent_events", [base]);
    },
    llmAllowed: true,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Wakeup drain - the strategic-wait engine (mirrors drainOutbox)
// ---------------------------------------------------------------------------

interface WakeupRowDb {
  id: number;
  kind: string;
  thread_key: string;
  not_before: string;
  payload: Record<string, unknown> | null;
}

export type DrainWakeupOptions = {
  /**
   * Run only this user's wakeups. Set by request-scoped callers (a poll owns
   * one traveller's time, not everybody's); the heartbeat leaves it unset.
   */
  userEmail?: string;
};

/**
 * Claim and run every due wakeup. Called opportunistically wherever
 * drainOutbox already runs (webhook, wa/status 3s poll, replies 15s poll,
 * queue, ping) - zero new infrastructure, Hobby-tier friendly. Atomic
 * delete-returning claims mean a wakeup runs exactly once even when several
 * drainers race.
 */
export async function drainGraphWakeups(
  send: LiveSend,
  opts?: DrainWakeupOptions
): Promise<number> {
  let ran = 0;
  try {
    // SCOPED, WHEN THE CALLER OWNS ONLY ONE USER'S TIME.
    //
    // Unscoped, one traveller's 8s poll ran up to 24 OTHER users' wakeups -
    // each a full multi-agent LLM compose - inside their own request. Filtering
    // on thread_key rather than on the user_email column is deliberate:
    // user_email is stamped best-effort (there is a schema-graceful insert
    // without it), so rows written before that migration have it null and would
    // silently vanish from every scoped drain. thread_key is `<email>:<vendor>`
    // and has always been populated.
    //
    // The heartbeat still calls this with no scope - draining everyone is a
    // worker's job, not a poll's.
    const ownerFilter = opts?.userEmail
      ? // LIKE-ESCAPED: '_' in an email is a single-char wildcard, so
        // "a_b@x.com" scoped-drained "aXb@x.com"'s wakeups too - a cross-user
        // reach the exact-match purges were already fixed for.
        `&thread_key=like.${encodeURIComponent(
          `${opts.userEmail.replace(/([\\%_])/g, "\\$1")}:*`
        )}`
      : "";
    const due = await sbSelect<WakeupRowDb>(
      "graph_wakeups",
      `select=id,kind,thread_key,not_before,payload&not_before=lte.${encodeURIComponent(
        new Date().toISOString()
      )}${ownerFilter}&order=not_before.asc&limit=24`
    );
    if (due.length === 0) return 0;
    const { sbUpdateReturning, sbDelete } = await import("../runtime-config");
    // CONCURRENT drain: each due wakeup is an INDEPENDENT thread whose turn is a
    // full multi-agent LLM compose. Running them sequentially made 40 live
    // threads advance one-at-a-time (the "loses track of conversations it
    // initiated" bug). A bounded worker pool overlaps the composes for distinct
    // threads while the per-recipient send pacing keeps each shop paced.
    const processOne = async (cand: WakeupRowDb): Promise<void> => {
      // A LEASE, NOT A DELETE (owner report 11 C2.1). This used to CLAIM by
      // deleting the row, then run the (LLM) turn, then re-park only inside a
      // catch. So the row was gone the instant the claim won, and the only
      // recovery was a catchable throw. A poll route that abandons this drain
      // mid-flight (its time budget elapsed) or a Cloud Run instance reclaimed
      // between the delete and the compose left the wakeup DELETED with nothing
      // to reclaim it - the strategic-wait / quiet-thread follow-up simply never
      // fired. wa_outbox and wa_processed were both converted to leases to stop
      // exactly this; graph_wakeups was missed.
      //
      // The lease needs no new column: bump `not_before` into the future to
      // claim (only the drain's own SELECT reads not_before; session-close and
      // unlink purge by user_email), delete only on success, and a mid-run
      // death leaves the row to fall due again after WAKEUP_LEASE_MS. The
      // `not_before=lte` filter is what makes the claim atomic - the first PATCH
      // moves the row past `now`, so a second concurrent PATCH matches zero rows.
      const nowIso = new Date().toISOString();
      const leaseUntil = new Date(Date.now() + WAKEUP_LEASE_MS).toISOString();
      const claimed = await sbUpdateReturning<WakeupRowDb>(
        "graph_wakeups",
        `id=eq.${cand.id}&not_before=lte.${encodeURIComponent(nowIso)}`,
        { not_before: leaseUntil }
      );
      if (claimed.length === 0) return; // another drainer holds the lease
      const row = claimed[0];
      try {
        if (row.kind === "tick") {
          const input = await buildTurnFromThread(row.thread_key, "tick");
          if (input) {
            // PER-THREAD MUTUAL EXCLUSION - the same lock the inbound path
            // takes (agent-loop claimThreadTurn). Without it a tick and an
            // inbound reply on the SAME thread genuinely raced: two composes,
            // two sends, and the lost-race state merge dropping one side's
            // digest - the exact double-send class the turn lock was built to
            // stop, reachable through the one entry point that skipped it.
            // A lost claim re-parks the wakeup ~90s out (no retry burned -
            // the sibling turn IS the thread advancing).
            const sep = row.thread_key.lastIndexOf(":");
            const lockOwner = sep > 0 ? row.thread_key.slice(0, sep) : "";
            const lockDigits = sep > 0 ? row.thread_key.slice(sep + 1) : row.thread_key;
            const { claimThreadTurn, releaseThreadTurn } = await import("../wa/turn-lock");
            const turnClaimedAt = Date.now();
            const turn = await claimThreadTurn(lockOwner, lockDigits, turnClaimedAt);
            if (turn === "lost") {
              await sbUpdate("graph_wakeups", `id=eq.${row.id}`, {
                not_before: new Date(Date.now() + 90_000).toISOString(),
              }).catch(() => {});
              return;
            }
            // THE SAME BRAIN THE INBOUND PATH USES. This drain used to call
            // runGraphTurn directly, so every scheduled follow-up - the quiet-
            // thread return, the strategic wait - ran the engine that has none
            // of the current negotiation rules, while SPTE's own wakeups (which
            // stamp payload.engine = "v3" right here in this table) were routed
            // straight past it. See src/lib/engine-route.ts.
            const { runThreadTurn } = await import("../engine-route");
            // BILLED TO THE THREAD'S OWNER, like the inbound path.
            //
            // A scheduled wakeup is the cheapest way to spend someone's AI
            // budget without them doing anything - the quiet-thread return and
            // the strategic wait both fire on a timer. Ungoverned, a stalled
            // hunt with forty threads keeps composing forever. `input.ctx.sender`
            // is the same identity the inbound turn uses.
            const { runWithAiBudget } = await import("../ai-budget");
            try {
              const routed = await runWithAiBudget(input.ctx.sender ?? "", () =>
                runThreadTurn(input, liveGraphIO(send), "wakeup")
              );
              // A tick that sent nothing gives the thread back early, exactly
              // like the inbound path - a silent wakeup must not freeze the
              // shop's next message for the rest of the window.
              if (routed.spte?.delivered === "silent" || routed.engine === "none") {
                await releaseThreadTurn(lockOwner, lockDigits, turnClaimedAt).catch(() => {});
              }
            } catch (e) {
              await releaseThreadTurn(lockOwner, lockDigits, turnClaimedAt).catch(() => {});
              throw e;
            }
            ran++;
          }
          // input === null -> the thread was cancelled / taken over / closed:
          // the wakeup dies here WITHOUT reschedule (correct - see
          // buildTurnFromThread). Only a THROW below re-parks.
        } else if (row.kind === "judge" || row.kind === "session-judge") {
          const { runJudgeJob } = await import("./judge");
          // The judge is an LLM call too, and thread_key is `<email>:<vendor>`.
          const sepIdx = row.thread_key.lastIndexOf(":");
          const judgeOwner = sepIdx > 0 ? row.thread_key.slice(0, sepIdx) : "";
          // Captured before the closure so the union narrowing survives it.
          const judgeKind = row.kind;
          const { runWithAiBudget } = await import("../ai-budget");
          await runWithAiBudget(judgeOwner, () =>
            runJudgeJob(judgeKind, row.thread_key, row.payload ?? {})
          );
          ran++;
        }
      } catch {
        // A TRANSIENT failure mid-run (LLM 5xx, Supabase blip) must NOT silently
        // drop this claimed (deleted) wakeup - the negotiation would stall
        // forever with no future turn to reschedule it. Re-park with a bounded
        // backoff. On the retry, buildTurnFromThread re-checks
        // cancel/takeover/session-closed and the send guard dedups, so a retry
        // can neither resurrect a dead thread nor double-send. Stamp user_email
        // (with the schema-graceful fallback) so session-close still purges it.
        const { wakeupRetryDecision } = await import("./wakeup-retry");
        const prior = Number((row.payload as { retryAttempts?: number } | null)?.retryAttempts ?? 0);
        const decision = wakeupRetryDecision(prior);
        if (decision.reschedule) {
          // The row is still present (we leased it, did not delete it), so move
          // its not_before to the backoff and record the attempt - an UPDATE,
          // not an INSERT, or the retry would duplicate the wakeup.
          await sbUpdate(
            "graph_wakeups",
            `id=eq.${row.id}`,
            {
              not_before: new Date(Date.now() + decision.delayMs).toISOString(),
              payload: { ...(row.payload ?? {}), retryAttempts: decision.attempts },
            }
          ).catch(() => {});
        } else {
          // Out of retries: give up cleanly. Leaving the leased row would just
          // re-fire it once the lease elapsed.
          await sbDelete("graph_wakeups", `id=eq.${row.id}`).catch(() => {});
        }
        return;
      }
      // SUCCESS (or a dead/cancelled thread that yielded no input): the follow-up
      // is done, so retire the leased row. A mid-run death never reaches here,
      // which is the whole point - the row survives to be reclaimed.
      //
      // RETRIED, because a delete that quietly fails leaves a COMPLETED turn's
      // lease to elapse and re-fire it - a duplicate follow-up message to a
      // real shop. One retry; if the store still refuses, park the row far
      // out with a done marker instead of leaving a live time bomb.
      const retired =
        (await sbDelete("graph_wakeups", `id=eq.${row.id}`).catch(() => false)) ||
        (await sbDelete("graph_wakeups", `id=eq.${row.id}`).catch(() => false));
      if (!retired) {
        await sbUpdate("graph_wakeups", `id=eq.${row.id}`, {
          not_before: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
          payload: { ...(row.payload ?? {}), done: true },
        }).catch(() => {});
      }
    };
    // Bounded pool: at most CONCURRENCY composes in flight at once.
    const CONCURRENCY = 6;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const cand = due[next++];
        await processOne(cand);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, due.length) }, () => worker())
    );
  } catch {
    /* table missing / Supabase unset - nothing to drain */
  }
  return ran;
}

// ---------------------------------------------------------------------------
// Rebuilding a turn from a stored thread (ticks + user actions)
// ---------------------------------------------------------------------------

interface StoredMsg {
  direction: "inbound" | "outbound";
  body: string | null;
  raw: Record<string, unknown> | null;
  received_at: string;
  from_number?: string | null;
  to_number?: string | null;
}

export async function buildTurnFromThread(
  threadKey: string,
  kind: "tick" | "user-consent-pickup" | "user-close-deal",
  payload?: Record<string, unknown>
): Promise<GraphTurnInput | null> {
  const idx = threadKey.lastIndexOf(":");
  if (idx <= 0) return null;
  const userEmail = threadKey.slice(0, idx);
  const toDigits = threadKey.slice(idx + 1);

  // A claimed TICK for a thread the user cancelled or took over dies here -
  // without rescheduling. (On an unreadable tombstone we proceed: the guard
  // itself fails closed at send time, which preserves the message in the
  // outbox instead of silently losing the wakeup.)
  if (kind === "tick") {
    try {
      const { isCancelled, recordSuppressedSend } = await import("../wa/cancellations");
      if ((await isCancelled(userEmail, toDigits)) === true) {
        void recordSuppressedSend(userEmail, toDigits, "cancelled-send-blocked");
        return null;
      }
      const { isThreadTakenOver } = await import("../session-flags");
      if (await isThreadTakenOver(userEmail, toDigits)) return null;
    } catch {
      /* checks are best-effort here - the guard is the hard gate */
    }
  }

  // Use THE shared resolver (12-row RFQ window), not a limit=1 newest-row read.
  // The old query took only the single newest outbound, so a later takeover /
  // rfq-less row orphaned the whole thread and every strategic-wait wakeup died
  // silently here - the same class of bug as the live "RFQ anchor MISSING".
  const { resolveThreadContext } = await import("../wa/thread-context");
  const resolved = await resolveThreadContext(toDigits, userEmail);
  const ctx = (resolved.ctx ?? null) as GraphTurnInput["ctx"] & {
    rfq?: import("../types").StructuredRFQ | null;
  };
  if (!resolved.rfq || !ctx) return null;
  // Resolve the traveller's consented stay FRESH (never the frozen outbound
  // meta) so a hotel added after the thread started is used on the next tick.
  if (ctx.sender) {
    try {
      const { getUserStay } = await import("../access");
      const stay = await getUserStay(ctx.sender);
      if (stay) ctx.stay = stay;
    } catch {
      /* best-effort */
    }
  }

  // Session lifecycle: the same closed-session guard the live loop uses.
  let sessionClosed = false;
  if (ctx.sender && resolved.newestAt) {
    const marker = await sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&to_number=eq.session&raw->>sender=eq.${encodeURIComponent(
        ctx.sender
      )}&raw->>kind=eq.session-closed&order=received_at.desc&limit=1`
    ).catch(() => []);
    sessionClosed = Boolean(marker[0] && marker[0].received_at > resolved.newestAt);
  }

  const threadRows = await sbSelect<StoredMsg>(
    "whatsapp_messages",
    `select=direction,body,raw,received_at&or=(to_number.eq.${encodeURIComponent(
      toDigits
    )},from_number.eq.${encodeURIComponent(toDigits)})&order=received_at.desc&limit=40`
  );
  // PRIVACY: both directions scoped to this user - inbound by receiver (the
  // WhatsApp that got it), outbound by sender. Another user's chat with the
  // same digits must never enter this user's negotiation context.
  const mine = threadRows.filter((m) => {
    const raw = m.raw as { sender?: string; receiver?: string } | null;
    return m.direction === "inbound"
      ? raw?.receiver === userEmail
      : raw?.sender === userEmail;
  });
  const thread = mine.slice(0, 12).reverse();
  // Wider, budgeted HISTORY window than the working 12-row slice: head
  // preserved, voice transcripts inlined (wa/history-window.ts, owner
  // report 4). Counters/coalescing below keep their 12-row behavior.
  const { buildHistoryWindow } = await import("../wa/history-window");
  const history = buildHistoryWindow(mine.slice(0, 40).reverse());
  const outboundRows = thread.filter((m) => m.direction === "outbound" && (m.body ?? ""));
  // THE GLOSS, NOT THE LOCALIZED WIRE TEXT - same fix as the inbound path in
  // agent-loop, and for the same reason: the repetition guard compares these
  // against an ENGLISH draft, so raw Thai on this side made it inert.
  const priorOutbound = outboundRows.map(
    (m) => (m.raw as { englishGloss?: string } | null)?.englishGloss ?? m.body ?? ""
  );
  // Parallel to priorOutbound, same order and length. SPTE stamps the semantic
  // move in raw.move; the legacy paths use raw.kind. Either identifies a
  // message better than its wording can - see the note on the field.
  const priorOutboundKinds = outboundRows.map(
    (m) =>
      (m.raw as { move?: string; kind?: string } | null)?.move ??
      (m.raw as { move?: string; kind?: string } | null)?.kind ??
      undefined
  );
  const lastInbound = [...thread].reverse().find((m) => m.direction === "inbound");
  // COALESCE the unread inbound buffer for the tick path too, so a strategic-
  // wait re-evaluation sees the shop's whole recent burst (vehicle + price),
  // not just the last frame - mirrors the ingestion-path coalescing.
  const { coalesceUnreadInbound } = await import("../wa/coalesce");
  const lastOutboundAt = [...thread].reverse().find((m) => m.direction === "outbound")?.received_at ?? "";
  const coalescedTick = coalesceUnreadInbound(thread, lastOutboundAt);
  const countKind = (k: string) =>
    thread.filter(
      (m) => m.direction === "outbound" && (m.raw as { kind?: string } | null)?.kind === k
    ).length;

  // THE PRICE THE WAIT WAS SCHEDULED FOR.
  //
  // A strategic wait exists to come back to a shop that has already quoted -
  // "they said 400, hold, then push". The tick then ran the engine with
  // `usablePrice: undefined`, and on the PRIMARY engine that is not a missing
  // optimisation, it is amnesia: spte/live.ts reads `input.usablePrice`
  // directly with no fallback, so `found: Boolean(input.usablePrice)` was
  // false, `quotedPricePerDay` was undefined and `quote` was null. The
  // follow-up the wait was scheduled for is structurally impossible when the
  // engine cannot see the number it was waiting on.
  //
  // (The graph engine happened to survive this - it falls back to
  // `state.fields.pricePerDay`. That is exactly why nothing caught it: the
  // fallback path was fine and the default path was not.)
  //
  // `usablePrice` on a live turn means "the price this turn established". On a
  // tick there is no new inbound, so the honest value is the price the THREAD
  // has already established - which `offers` records durably, per user and
  // vendor. `extraction` stays null: that really is "no new information", and
  // conflating the two is what produced the bug.
  let threadPrice: number | undefined;
  let storedCurrency: string | null = null;
  if (ctx.sender && ctx.vendorId) {
    const priced = await sbSelect<{ price_per_day: number | string | null; currency?: string | null }>(
      "offers",
      // `currency` rides along - the row's own resolved currency is the
      // strongest evidence there is, and this read ignored it.
      `select=price_per_day,currency&user_email=eq.${encodeURIComponent(ctx.sender)}` +
        `&vendor_id=eq.${encodeURIComponent(ctx.vendorId)}` +
        `&order=created_at.desc&limit=1`
    ).catch(() => []);
    const n = Number(priced[0]?.price_per_day);
    storedCurrency = (priced[0]?.currency as string | undefined) ?? null;
    // A missing or unreadable offer leaves it undefined - the state this code
    // had unconditionally, so the failure direction is exactly today's
    // behaviour rather than a worse one.
    if (Number.isFinite(n) && n > 0) threadPrice = n;
  }

  const rfq = resolved.rfq; // non-null: guarded by `if (!resolved.rfq) return null`
  const { floorPriceFor } = await import("../market");
  // NOT `currencyForRegion(region) || "USD"`.
  //
  // currencyForRegion returns null for every label the geocoder actually
  // produces - "Ao Nang", "Krabi", "Canggu", "Da Nang", "Siargao", a raw
  // "8.0000, 98.0000" - so this resolved USD on the tick and user-action paths.
  // That USD then became SPTE's session currency, went into the prompt the
  // model composes from ("they have already quoted 250 USD/day"), went out on
  // the WIRE in the next bargain, and OVERWROTE the thread's correct stored
  // currency. The shared chain prefers what the thread already resolved, then
  // the region, then the shop's phone prefix, and leaves it UNDEFINED rather
  // than inventing dollars.
  const { resolveLocalCurrency } = await import("../local-currency");
  const cur = await resolveLocalCurrency({
    stored: storedCurrency,
    region: ctx.region,
    shopDigits: toDigits,
  });
  const floorRegion = ctx.region || undefined;
  const floor = await floorPriceFor(floorRegion, rfq).catch(() => null);
  const floorSameCur = floor && cur && floor.currency === cur ? floor : null;

  return {
    event: {
      kind,
      threadKey,
      userEmail,
      toDigits,
      // Coalesced burst ONLY on a tick (a strategic-wait re-eval); a user action
      // (close-deal/consent) must read the single latest frame so a stale "?" in
      // an earlier frame cannot flip shopAskedQuestion during that action.
      shopMessage: kind === "tick" ? coalescedTick || lastInbound?.body || "" : lastInbound?.body ?? "",
      images: [],
      audios: [],
      payload,
    },
    ctx,
    rfq,
    extraction: null, // no NEW inbound information on a tick/user action
    // ...but the price the thread already established is not new information
    // either - it is the standing fact the wait was scheduled around.
    usablePrice: threadPrice,
    // Empty rather than a fabricated "USD": every money renderer treats a
    // falsy code as unknown and prints a bare number with a chip, which is
    // honest. A wrong symbol is the trust-killer the owner reported.
    currency: cur ?? "",
    floorPrice: floorSameCur?.floor,
    floorTypical: floorSameCur?.typical ?? undefined,
    sessionClosed,
    history,
    priorOutbound,
    priorOutboundKinds,
    legacyCounts: {
      clarify: countKind("auto-clarify"),
      bargain: countKind("auto-bargain") + countKind("bargain"),
      answer: countKind("auto-answer"),
      close: countKind("auto-close"),
    },
    humanDelay: true,
    transcript: null,
    deadlineAt: Date.now() + 40_000,
  };
}

/** Entry point for user actions from the app (consent / close-deal). */
export async function runUserAction(args: {
  userEmail: string;
  toDigits: string;
  kind: "user-consent-pickup" | "user-close-deal";
  payload: Record<string, unknown>;
  shopOpenNow?: boolean;
  /** A ONE-OFF place to share instead of the saved stay - already resolved
   *  SERVER-SIDE from a Google place id (the traveller is on their way and not
   *  at the hotel yet). Label only, never coordinates: with no consented coords
   *  resolveShareableLocation emits address text and no pin. Not persisted -
   *  the saved stay is untouched. */
  stayLabelOverride?: string;
  send: LiveSend;
}): Promise<GraphTurnResult | null> {
  const threadKey = threadKeyFor(args.userEmail, args.toDigits);
  const input = await buildTurnFromThread(threadKey, args.kind, args.payload);
  if (!input) return null;
  if (args.stayLabelOverride && input.ctx) {
    // Drop any consented coords along with the label: they belong to the SAVED
    // stay, and pinning them to a different address would be a false location.
    // CHOOSING THIS PLACE FOR THIS SHARE *IS* THE CONSENT: the traveller
    // picked it in the share sheet moments ago, for this shop, on purpose.
    // There are still no coordinates, so no pin can be built - what the
    // consent unlocks is the by-NAME maps link (see resolveShareableLocation),
    // which spares the shop retyping an address into their own maps app.
    input.ctx.stay = { label: args.stayLabelOverride, shareConsent: true };
  }
  // User actions send promptly - the traveller is watching the screen.
  input.humanDelay = false;
  input.shopOpenNow = args.shopOpenNow;
  // THE SAME PER-THREAD LOCK EVERY OTHER ENTRY TAKES. A user close racing an
  // agent compose on the same thread was the one remaining interleave. The
  // traveller is watching, so a lost claim WAITS one beat and retries rather
  // than refusing; if the sibling still holds it, proceed - the send guard's
  // per-recipient pacing serializes the wire, and a traveller's deliberate
  // action outranks an automated turn.
  {
    const { claimThreadTurn } = await import("../wa/turn-lock");
    const claim = await claimThreadTurn(args.userEmail, args.toDigits);
    if (claim === "lost") {
      await new Promise((r) => setTimeout(r, 3_000));
      await claimThreadTurn(args.userEmail, args.toDigits);
    }
  }
  // THROUGH THE ROUTING AUTHORITY, like every other entry point. engine-route
  // dispatches user-action kinds to the graph engine deliberately (its nodes
  // own them) - the point is that the dispatch is SAID in one place, not that
  // this call bypasses it. The declared TurnEntry "user-action" finally has
  // its producer.
  const { runThreadTurn } = await import("../engine-route");
  const out = await runThreadTurn(input, liveGraphIO(args.send), "user-action");
  return out.graph ?? null;
}
