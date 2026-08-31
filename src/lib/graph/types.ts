// Digraph Negotiation Engine - shared types.
//
// The engine replaces the hardcoded reply pipeline with a TRUE directed graph:
// nodes are specialized agents (sense / director / act / tail gates), edges are
// TYPED conditions (no free text, no eval - the same safety philosophy as
// lib/branching.ts). The whole graph is owner-editable in the Pipeline Studio,
// persisted in app_config, and every live decision stamps the exact node/edge
// path into agent_traces so the Studio replays real conversations 1:1.
//
// Pure types only - no IO in this file.

import type { Condition, Direction } from "../branching";
import type { DepositType } from "../deposit";
import type { ExtractedOffer } from "../agents";
import type { StructuredRFQ } from "../types";

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeKind =
  // sense - understand what just arrived
  | "entry" // virtual inbound marker (renders the event source in the Studio)
  | "transcribe" // voice notes -> text (Groq Whisper, heavy-accent primed)
  | "extract" // offer extraction from text + photos (vision)
  | "media-coherence" // does the image/voice reading fit the whole thread?
  | "comparator" // market floor + cross-shop rival + round target math
  // chief
  | "director" // the Negotiation Director - picks ONE legal move (or waits)
  // act - compose exactly one outbound (or mutate state)
  | "answer"
  | "clarify"
  | "bargain"
  | "deposit-probe"
  | "fulfillment-probe"
  | "close"
  | "present" // no message: marks the offer presentable to the traveller
  | "pickup-location" // sends the traveller's location after explicit consent
  | "closing-message" // the traveller locked the deal - tell the shop
  | "silent" // deliberate no-reply (a first-class, visible move)
  | "momentum" // last-resort continuation after a brief acknowledgement ("Yes.")
  | "custom-llm" // owner-created node with a prompt template
  // tail gates - every outbound passes through, in order
  | "style-validator" // critique/revise + global uniqueness + emoji tone
  | "localize" // local-language stickiness (Ultra)
  | "safety" // content safety screen
  | "deliver"; // human pacing / anti-ban gate / actual send

export interface NodeSpec {
  id: string; // "bargain", "custom-x9k2"
  kind: NodeKind;
  label: string; // owner-renamable, shown on the canvas + traces
  emoji?: string; // canvas glyph
  enabled: boolean;
  // Owner text appended to the node's built-in prompt (LLM nodes).
  instructions: string;
  // Hard per-thread budget for act nodes (e.g. clarify: 1, deposit-probe: 2).
  maxRunsPerThread?: number;
  custom?: boolean;
  // custom-llm only: the prompt template. Available variables:
  // {history} {shopMessage} {state} {rfq} {numbers}
  promptTemplate?: string;
}

// ---------------------------------------------------------------------------
// Edges - typed conditions, superset of branching.Condition
// ---------------------------------------------------------------------------

export type ThreadPhase =
  | "opening"
  | "awaiting_price"
  | "negotiating"
  | "collecting_terms"
  | "complete"
  | "presented"
  | "closing"
  | "closed"
  | "dead";

export type GraphEventKind =
  | "inbound-text"
  | "inbound-image"
  | "inbound-audio"
  | "tick" // a strategic-wait wakeup fired
  | "user-consent-pickup"
  | "user-close-deal"
  | "session-closed";

export type DealField = "price" | "deposit" | "fulfillment";

export type GraphCondition =
  | Condition // every branching.ts kind evaluates unchanged
  | { kind: "phaseIs"; phase: ThreadPhase }
  | { kind: "fieldKnown"; field: DealField; value: boolean }
  | { kind: "depositPassportOnly" }
  | { kind: "cashAlternativeAskedAlready" }
  | { kind: "firmCountAtLeast"; min: number }
  // rounds so far < max; omit max to use settings.maxRoundsPerShop
  | { kind: "roundsBelow"; max?: number }
  | { kind: "toneDegraded" }
  | { kind: "dealComplete"; value: boolean }
  | { kind: "pickupOffered" }
  | { kind: "pickupConsentGiven" }
  | { kind: "hasMedia"; media: "image" | "audio" | "any" }
  | { kind: "mediaCoherent"; value: boolean }
  | { kind: "eventIs"; event: GraphEventKind }
  // quote still far above the real floor (>25%) - leverage to keep pushing
  | { kind: "priceFarAboveFloor" }
  // a strong-leverage bargain (cheaper rival / far-above-floor) is LEGAL right
  // now - probes/present/momentum are gated off so price is pushed FIRST
  | { kind: "strongBargainAvailable" }
  // the shop walked away from the deal ("take it there") - stop gracefully
  | { kind: "shopDeclinedDeal" }
  | { kind: "nodeRanBelow"; nodeId: string; max: number }
  | { kind: "notG"; of: GraphCondition }
  | { kind: "allG"; of: GraphCondition[] }
  | { kind: "anyG"; of: GraphCondition[] };

export interface EdgeSpec {
  id: string;
  from: string; // node id ("inbound" is the virtual entry)
  to: string;
  priority: number; // deterministic first-match order (lower runs first)
  when: GraphCondition;
  enabled: boolean;
  label?: string; // shown on the canvas chip + in traces as the "why"
}

export interface GraphSettings {
  maxStepsPerEvent: number; // hard traversal cap per inbound event
  maxLlmCallsPerEvent: number;
  maxRoundsPerShop: number; // bargain rounds (multi-round negotiation)
  waitWindow: { minS: number; maxS: number }; // director "hold" bounds
  strategicWaitMaxMin: number; // director "defer" ceiling (minutes)
  emojiTone: boolean; // outbound carries exactly one warm emoji
  judgeSampleRate: number; // 0..1 share of outbounds the judge grades
  lowEnglish: boolean; // carried over from orchestrator config
  streetLocal: boolean;
}

export interface GraphSpec {
  version: 2;
  // Default-graph revision this spec was last migrated to (sanitizeGraphSpec
  // upgrades untouched built-in edges when DEFAULT_GRAPH_REVISION advances).
  revision?: number;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  settings: GraphSettings;
}

// ---------------------------------------------------------------------------
// Per-thread durable state (negotiation_threads)
// ---------------------------------------------------------------------------

export type FulfillmentKind = "pickup" | "delivery" | "on-shop";

export interface ThreadFields {
  /** When pricePerDay was DIVIDED out of a package quote, the span it covered
   *  (owner report 6 C3) - the provenance the sessionTable merge carries into
   *  rival leverage and the session floor. */
  priceBasisDays?: number;
  /** The vehicle this thread negotiates (owner report 6 C4): thread keys have
   *  no vehicle dimension, so cross-vehicle rival leakage is filtered on this
   *  declared key. */
  vehicleKey?: string;
  pricePerDay?: number;
  currency?: string;
  priceVerified?: boolean;
  depositType?: DepositType;
  depositAmount?: number;
  depositCurrency?: string;
  depositNote?: string;
  fulfillment?: FulfillmentKind | null;
  deliveryFee?: number | null;
  pickupOffered?: boolean;
  pickupConsent?: boolean;
  cashAlternativeAsked?: boolean; // passport -> cash push happens ONCE
  firmCount: number; // times the shop held firm on price
  toneDegraded: boolean; // the shop sounded annoyed - stop pushing
  declined?: boolean; // the shop walked away - negotiation over
  /** The shop has no vehicle right now - temporary, and NOT a decline. */
  shopUnavailable?: boolean;
  /** The shop's own words about when stock returns ("maybe tomorrow"). */
  restockHint?: string;
  // Printed price-list anchor: the listed price of the chosen model. Keeps
  // bargaining asks credible against a posted board (never deep lowballs).
  sheetPricePerDay?: number;
  rounds: number; // bargain asks made in this thread
  lastTarget?: number; // our last asked price (concession ladder)
  lastLeverage?: string;
  presented?: boolean;
  // ---- extract-everything media memory (facts photos gave us for later) ----
  mileageKm?: number; // odometer seen in a photo - bargaining leverage
  conditionNotes?: string; // visible condition (scratches, worn tires...)
  mediaSummary?: string; // everything informative the last photo showed
  /**
   * PER-EXTRA VERDICTS. What the shop said about each thing the traveller
   * asked for (helmets, a phone mount, delivery). The request used to leave
   * the app in the opening message and never come back, so the booking screen
   * could show a helmet the shop had refused. Keyed by the traveller's own
   * wording - see thread/accessories.ts for the merge rules.
   */
  accessories?: import("../thread/accessories").AccessoryStatus[];
  /**
   * THE SHOP OFFERED A DIFFERENT VEHICLE and it is close enough to be worth
   * asking about. While this is set (and fresh) the thread PAUSES rather than
   * closing - see vehicle/substitution.ts. Cleared when the traveller accepts
   * or declines.
   */
  alternativeOffer?: import("../vehicle/substitution").AlternativeOffer | null;
  // The shop asked WHERE the traveller is staying (for delivery) and we had no
  // shareable address - the agent stops probing and the app prompts the user
  // for their hotel instead of looping the boilerplate delivery question.
  awaitingUserLocation?: boolean;
  // THREAD-level vehicle confirmation (src/lib/vehicle/confirmation.ts).
  // What the CONVERSATION has established about the vehicle, durable across
  // turns: "confirmed" never regresses on a vehicle-less price update, and
  // askedAt is the ask-once fact that retires the confirm question.
  vehicleConfirmation?: {
    status: "confirmed" | "assumed" | "unconfirmed";
    evidence: string;
    at: string;
    askedAt?: string;
  };
  /**
   * THE THREAD'S DURABLE MEMORY (W4.5) - the persisted half of the SPTE digest
   * (spte/digest persistableDigest): the model's durable facts, the standing
   * quote, the round count, the tone, and which confirming questions have been
   * spent.
   *
   * `runTurn` has always produced this and `runSpteLiveTurn` never read it
   * back, so `buildDigest` restarted from empty on every single turn: facts was
   * permanently [], which made the one-warm-goodbye rule unenforceable, and the
   * quote was rebuilt from the current message alone, so a shop that did not
   * repeat its number looked to the whole ladder like a shop that had never
   * quoted. Free-form JSON on purpose - it is read back defensively
   * (digestFromStored) so rows written before this existed simply seed empty.
   */
  digest?: Record<string, unknown>;
  /**
   * WHICH LANGUAGE THIS THREAD IS WRITTEN IN, AND WHY (W4.6).
   *
   * The language used to be re-derived from scratch every turn by
   * `agents.threadPrefersEnglish`, from nothing but what the last two inbound
   * messages happened to look like - so the same thread could flip back and
   * forth, and a shop merely REPLYING in English ended the local-language
   * feature for it. It is a decision now: taken once, on an explicit statement
   * the comprehension pass read, stored here with its reason and its timestamp,
   * and surfaced to the traveller (`/api/replies` -> the card + status panel).
   */
  language?: import("../wa/thread-language").ThreadLanguage;
  /**
   * A CONFIRMING QUESTION THE AGENT IS WAITING ON (W4.4). Set when the engine
   * put a fact back to the shop because it was not sure it had understood;
   * cleared once the fact reads cleanly. The card renders it as "double-
   * checking with the shop" so a paused thread explains itself.
   */
  awaitingConfirmation?: { subject: string; question: string; at: string };
}

export interface NegotiationThreadState {
  threadKey: string; // `${userEmail}:${toDigits}`
  userEmail: string;
  vendorId: string;
  vendorName: string;
  toNumber: string;
  phase: ThreadPhase;
  version: number; // optimistic concurrency
  fields: ThreadFields;
  nodeRuns: Record<string, number>; // per-node act counters
  waitingUntil?: string | null;
  lastDecisionId?: string;
  updatedAt: string;
}

// The session view the Director reads (assembled per event, never stored).
export interface SessionShopRow {
  vendorId: string;
  vendorName: string;
  pricePerDay?: number;
  currency?: string;
  phase?: ThreadPhase;
  complete?: boolean;
  isThisShop?: boolean;
  /**
   * PROVENANCE (owner report 5 #2): `pricePerDay` was DIVIDED out of a package
   * covering this many days rather than quoted per day. A rival carrying this
   * must be phrased as arithmetic ("their 3-day price works out to about
   * 167/day"), and is not like-for-like for a shorter rental at all.
   */
  quoteBasisDays?: number;
  /** How many days the traveller's RFQ asked this shop about, when the row came
   *  from an `offers` row that recorded it. Lets a package basis be judged
   *  against the rental it was quoted for. */
  durationDays?: number;
  /** The shop's WhatsApp number, when this row came from a live thread. It is
   *  what a thread key is built from, so it is what a sibling re-bargain needs
   *  to reach back into an EXPENSIVE thread when a cheaper quote lands. */
  toNumber?: string;
  /** How many times this shop has said "last price" - a shop that has refused
   *  twice is not re-opened by the swarm. */
  firmCount?: number;
}

// ---------------------------------------------------------------------------
// Facts - the pure input to edge-condition evaluation
// ---------------------------------------------------------------------------

// Extends the legacy DecisionContext shape so every branching.Condition kind
// keeps evaluating byte-for-byte (legacy parity), plus the graph-only facts.
export interface GraphFacts {
  // ---- legacy DecisionContext (unchanged semantics) ----
  sessionClosed: boolean;
  shopAskedQuestion: boolean;
  shopSentVehiclePhoto: boolean;
  hasUsablePrice: boolean;
  verified: boolean;
  hasClarifyMessage: boolean;
  matchesSpecNotFalse: boolean;
  priceAtOrBelowFloor: boolean;
  priceFarAboveFloor: boolean; // quote >25% above the known floor
  // Derived by the ENGINE (not buildFacts): strong leverage exists AND a
  // bargain edge is actually legal - the price-first gate for other edges.
  strongBargainAvailable: boolean;
  targetIsRealSaving: boolean;
  rivalCheaper: boolean;
  counts: { clarify: number; bargain: number; answer: number; close: number };
  // ---- graph facts ----
  event: GraphEventKind;
  phase: ThreadPhase;
  priceKnown: boolean;
  depositKnown: boolean;
  fulfillmentKnown: boolean;
  depositPassportOnly: boolean;
  cashAlternativeAsked: boolean;
  firmCount: number;
  rounds: number;
  maxRounds: number; // settings.maxRoundsPerShop (roundsBelow default)
  toneDegraded: boolean;
  shopDeclined: boolean; // the shop walked away - negotiation over
  dealComplete: boolean;
  pickupOffered: boolean;
  pickupConsent: boolean;
  hasImage: boolean;
  hasAudio: boolean;
  mediaCoherent: boolean;
  nodeRuns: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Events + the engine's per-turn input bundle
// ---------------------------------------------------------------------------

export interface GraphEvent {
  kind: GraphEventKind;
  threadKey: string;
  userEmail?: string;
  toDigits: string;
  shopMessage: string; // the inbound text (or transcript) driving this turn
  images: { mime: string; base64: string }[];
  audios: { mime: string; base64: string }[];
  // Optional payload for user-action events (e.g. deal summary for closing).
  payload?: Record<string, unknown>;
}

// Everything the ingest layer (agent-loop) already computed for this turn -
// the engine NEVER re-queries what the caller already knows.
export interface GraphTurnInput {
  event: GraphEvent;
  ctx: {
    sender?: string;
    vendorId?: string;
    vendorName?: string;
    round?: number;
    rfq?: StructuredRFQ | null;
    region?: string;
    plan?: string;
    channel?: string;
    localLang?: boolean;
    // Where the traveller is staying, resolved server-side from their profile
    // ONLY when they consented to share it with shops (privacy). Coordinates are
    // present only with consent; label-only otherwise.
    stay?: { label: string; lat?: number; lng?: number; shareConsent: boolean };
    /**
     * Provider id of the inbound message this turn is answering.
     *
     * Carried so a composed draft can be STAMPED with what it is a reply to,
     * and the drain can refuse to send it once the shop has moved past that
     * message (wa/freshness.ts). Absent on ticks, which answer nothing.
     */
    inboundId?: string;
  };
  rfq: StructuredRFQ;
  extraction: ExtractedOffer | null;
  usablePrice?: number;
  /** When usablePrice was DIVIDED out of a package quote, the span it covered
   *  (owner report 6 C3): every surface that persists or cites the number
   *  needs the provenance, or a 3-day package's 167/day re-enters siblings as
   *  a quoted daily rate and depresses the session floor. */
  priceBasisDays?: number;
  currency: string;
  floorPrice?: number;
  floorTypical?: number;
  sessionClosed: boolean;
  history: string;
  /**
   * THE ENGLISH GLOSS OF THIS INBOUND, when the loop produced one.
   *
   * Every comprehension judgement in spte/comprehension.ts is written in
   * English and, until this field existed, was applied to the shop's raw words
   * whatever language they were in - which is the root of the misreads this
   * wave exists to fix. The gloss is already computed on the reply path and
   * stamped on the stored row (agent-loop inbound-gloss); it simply never
   * reached the engine. Absent -> the classifiers read the raw text, exactly as
   * before.
   *
   * NOT a language decision about what we SEND: that is `fields.language`
   * (W4.6), decided from an explicit statement the comprehension pass reads off
   * this very gloss and stored on the thread.
   */
  inboundEnglish?: string;
  priorOutbound: string[];
  // The semantic move stamped on each `priorOutbound` entry, SAME ORDER, SAME
  // LENGTH; `undefined` where the row carries no stamp. The round counter needs
  // it because our own non-bargain templates are indistinguishable from a push
  // by wording alone: the `answer` template ("is 250/day the best you can do
  // for 4 days?") contains both "/day" and "can you do", and the price-board
  // read-back contains "/day", so a regex over the text counted our own
  // ANSWERS as bargain rounds. Optional: the simulator and the legacy
  // orchestrator pass text only, and fall back to the regex.
  priorOutboundKinds?: (string | undefined)[];
  // Every inbound (shop) message body in this thread, chronological - the SPTE
  // engine derives firm-count / deposit-known / fulfillment-known from these.
  priorInbound?: string[];
  // Legacy message-scan counters (dual-read backstop during migration).
  legacyCounts: { clarify: number; bargain: number; answer: number; close: number };
  humanDelay: boolean;
  // Transcription result when the event carried audio (task: voice agent).
  transcript?: { text: string; language?: string; source: string } | null;
  deadlineAt: number; // Date.now() + remaining serverless budget
  // Pinned policy overlay for DETERMINISTIC replay (golden regression suite);
  // live traffic omits it and the engine reads the active overlay from config.
  overlay?: import("../ops/overlay").PolicyOverlay;
  // Google "open now" from the card (user actions) - the hours gate must
  // never queue a deal-close on a shop the app itself shows as open.
  shopOpenNow?: boolean;
}

// ---------------------------------------------------------------------------
// Node handler contracts
// ---------------------------------------------------------------------------

export interface NodeResult {
  // The composed outbound message (act nodes). Absent = state-only move.
  message?: string;
  englishGloss?: string;
  // The wa "kind" recorded with the outbound (auto-bargain, auto-close, ...).
  kind?: string;
  // Human-readable reasoning for the trace row.
  reasoning: string;
  // Trace verdict column (deterministic / ok / revised / veto ...).
  verdict?: string;
  // Patch applied to state.fields after the node runs.
  fieldsPatch?: Partial<ThreadFields>;
  // Round number to stamp on the outbound context.
  nextRound?: number;
  // Tactic id (bargain node) for learning + judge attribution.
  tacticId?: string;
  // True stops the traversal after this node (silent/present handle flow).
  terminal?: boolean;
}

export interface DeliverResult {
  delivered: "sent" | "queued" | "held" | "blocked" | "failed";
  detail: string;
  finalText?: string;
  queuedUntil?: string;
  /** The wa_outbox row the message is parked in - the Ops join key (F10). */
  outboxRowId?: number;
}

// ---------------------------------------------------------------------------
// Director
// ---------------------------------------------------------------------------

export interface LegalEdge {
  edgeId: string;
  label: string;
  toNodeId: string;
  toKind: NodeKind;
}

export interface DirectorChoice {
  action: "act" | "wait-hold" | "wait-defer" | "silent";
  edgeId: string | null;
  waitSeconds?: number; // hold: deliver delay; defer: wakeup delay
  leverageNote?: string;
  reasoning: string;
  fromAi: boolean;
}

// ---------------------------------------------------------------------------
// Scores (judge team)
// ---------------------------------------------------------------------------

export interface ScoreRecord {
  decisionId: string;
  threadKey: string;
  nodeId: string;
  scorer: "move-judge" | "chief-judge" | "deterministic";
  rubricVersion: "v1";
  scores: {
    tacticFit?: number;
    tone?: number;
    uniqueness?: number;
    outcomeDelta?: number;
  };
  tacticId?: string;
  provider?: string;
  verdict: string;
}

// ---------------------------------------------------------------------------
// IO seam - live Supabase/WhatsApp vs dry-run simulator/tests
// ---------------------------------------------------------------------------

export interface WakeupRow {
  kind: "tick" | "judge" | "session-judge";
  threadKey: string;
  notBefore: string;
  payload?: Record<string, unknown>;
}

export interface GraphIO {
  loadState(threadKey: string): Promise<NegotiationThreadState | null>;
  saveState(state: NegotiationThreadState): Promise<void>;
  cheapestRival(args: {
    userEmail: string;
    vendorId: string;
    currency: string;
    vehicleKey: string;
    belowPrice: number;
    /**
     * The traveller's rental length.
     *
     * WITHOUT IT EVERY PACKAGE-DERIVED RIVAL IS SILENTLY DROPPED, even when the
     * rental fully covers the package: cheapestRivalQuoteFor keeps a derived
     * rate only when `durationDays >= quote_basis_days`, and an undefined
     * duration can never satisfy that. So the graph engine - the failover, and
     * the path every user action takes - lost real leverage it was entitled to
     * cite, silently, in exactly the case (a longer rental) where package
     * pricing is most common.
     */
    durationDays?: number;
  }): Promise<number | undefined>;
  /**
   * `vehicleKey` scopes the session's other quotes to the SAME vehicle. Without
   * it a "rival" could be a different machine entirely - a price for a 150cc
   * quoted in another search inside the same window, cited at a shop that
   * quoted a 125cc. Leverage has to compare like with like or it is fiction.
   */
  sessionTable(
    userEmail: string,
    thisVendorId?: string,
    vehicleKey?: string | null,
    /**
     * The traveller's own spec, for the BOARD-PHOTO rescue inside.
     *
     * A photographed price board is tiered: its "15-29 days" column is not
     * available to a 5-day traveller, and its 160cc row is not the 125cc they
     * asked for. The card path already picks the right cell (pickBoardPrice);
     * the RIVAL path used cheapestQuotable, which filters only crossed-out
     * rows - so the cheapest long-stay tier became cross-thread leverage and
     * the rails then REQUIRED the draft to cite it. Without these two numbers
     * the rescue cannot tell which cell applies.
     */
    spec?: { engineSizeCc?: number; durationDays?: number }
  ): Promise<SessionShopRow[]>;
  insertWakeup(row: WakeupRow): Promise<void>;
  clearWakeups(threadKey: string, kind?: string): Promise<void>;
  // Park a composed message with a not_before delay (human pacing / hold).
  queueOutbox(args: {
    senderKey: string;
    toNumber: string;
    body: string;
    notBeforeMs: number;
    meta: Record<string, unknown>;
  }): Promise<void>;
  // Anti-ban gate + actual send + whatsapp_messages persistence.
  guardAndSend(args: {
    senderKey: string;
    toNumber: string;
    text: string;
    meta: Record<string, unknown>;
    // Google "open now" truth for the hours gate (user actions pass it).
    shopOpenNow?: boolean;
  }): Promise<DeliverResult>;
  markPresentable(args: {
    userEmail?: string;
    vendorId?: string;
    fulfillment?: FulfillmentKind | null;
  }): Promise<void>;
  insertBargainDraft(args: {
    userEmail?: string;
    vendorId?: string;
    tactic: string;
    message: string;
  }): Promise<void>;
  recentOutboundGlobal(hours: number, limit: number): Promise<string[]>;
  writeTrace(rows: import("../orchestrator").TraceRow[]): Promise<void>;
  /** Optional observability sink (live IO only - simulators omit it).
   *
   *  ADDRESSING IS PART OF THE EVENT, not an afterthought: the message-path
   *  panel finds a thread's trail by (user_email, to_number), so a row written
   *  without them is invisible on the one screen built to read it. `userEmail`
   *  and `toDigits` are what make an event belong to a conversation. */
  recordEvent?(args: {
    kind: string;
    vendorId?: string;
    vendorName?: string;
    userEmail?: string | null;
    toDigits?: string | null;
    detail: string;
  }): Promise<void>;
  llmAllowed: boolean; // simulator can force deterministic-only runs
  now(): number;
}
