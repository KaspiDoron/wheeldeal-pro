// SPTE - Single-Pass Turn Engine (V2-4). The types for the Blackboard +
// single-pass agent that replaces the graph director/edge branching.
//
// Design (from docs/V2-BLUEPRINT.md section 4): at most ONE LLM call per
// compositional turn, ZERO for reflex turns. Numbers never originate in the LLM
// (deterministic price-extract seeds them; post-rails guards verify them). The
// move vocabulary is closed (safety keys on it); the strategy is open (the LLM
// picks freely among LEGAL moves and writes the message).

import type { StructuredRFQ } from "../types";
import type { VehicleOption } from "../offer-options";
import type { DialogueActs } from "../wa/dialogue-acts";

/** The closed move vocabulary. Every deterministic guard keys on these (the
 *  D-F1 invariant), which is why strategy is free but the vocabulary is not. */
export type MoveKind =
  | "bargain"
  | "answer"
  | "clarify"
  | "present"
  // STEP 7 OF THE FUNNEL: recap the agreed deal back to the SHOP - price,
  // duration, deposit, handover - and ask them to confirm it. Once per thread
  // (digest.recapSent), deterministic template (grounded by construction),
  // and the ONLY shop-facing move in the presentation family: `present`
  // itself is state-only (it marks the offer presentable to the TRAVELLER and
  // sends nothing - its composed text used to go to the shop under a haggling
  // prompt, which is how an internal recap leaked to the counterparty).
  | "verify-recap"
  // A WARM GOODBYE, and nothing else.
  //
  // It was called `close`, and the model was never told what that meant. The
  // prompt emits a bare `LEGAL MOVES: close, silent` with no glossary, so the
  // only definition available to it was the English word - which in a sales
  // conversation means CLOSE THE DEAL. On Ko Tao it did exactly that: the shop
  // said it had no bikes, `close` became legal, and the agent replied "great,
  // 180 baht per day is a good price!" to a shop that had just withdrawn.
  //
  // The name is now the definition. A move called `farewell` cannot be misread
  // as an agreement by anything that reads English, and `moveGlossary` states
  // it in the prompt anyway. `close` is still accepted on the way IN
  // (normalizeMove) because model output, stored owner corrections and golden
  // cases all predate the rename.
  | "farewell"
  | "deposit-probe"
  | "fulfillment-probe"
  | "pickup-location"
  // The shop offered a CHOICE ("some models 200, some new 250"). Resolve the
  // menu - what separates the tiers, and a photo of each - before haggling a
  // price the traveller has not picked yet.
  | "option-probe"
  // The price on the table cannot be tied to the vehicle the traveller
  // declared - a 110cc BeAT quoted to someone who asked for a 125, or a
  // nameplate that comes in several sizes and nobody said which. Settle the
  // vehicle before anything is haggled, presented or booked.
  | "confirm-vehicle"
  // The shop has just told us it has nothing to rent right now ("Now I don't
  // have bike."). Not a decline and not a dead end - acknowledge it warmly and
  // ask ONE question worth asking: when does it come back?
  | "restock-probe"
  | "redirect-close" // NEW (B7): wrong-vehicle / not-offering -> thank + close
  // THE BRUSH-OFF (W4.3). "You should try asking other shops; maybe they'll
  // give you one." That is a shop ending the conversation politely, and the
  // engine had no category for it at all: dialogue acts carry ASK kinds and
  // SHARE kinds with no refusal member, and the one terminal-refusal regex
  // lists "not interested" / "good luck" / "take it there". So the turn walked
  // the whole ladder to its "no price yet" default - whose only legal moves ARE
  // rate re-asks - and coerceToLegal sent one. The shop had just told us to go
  // away and we asked it for its daily rate.
  //
  // Distinct from `farewell` (a decline we were TOLD) and from `redirect-close`
  // (they do not stock what we need) because it is neither, and the model reads
  // these tokens as English: this one is "they are done with us, thank them and
  // stop". Never a re-ask, never a price, never a second message.
  | "graceful-close"
  // THE CONFIRM-QUESTION DOCTRINE (W4.4, the owner's rule verbatim): "if they
  // are not positive about something (anything) they should ask the shop, but
  // in a way of a question." Subject-parameterized (see ConfirmSubject) so one
  // move covers deposit, price, availability, conditions and vehicle instead of
  // the single hard-coded `confirm-vehicle` that was the entire vocabulary for
  // checking a fact. Legal only while the comprehension pass reports it is not
  // sure, and only ONCE per subject - see the ledger's third state.
  | "confirm"
  | "momentum"
  | "closing-message"
  | "silent";

/**
 * The facts a confirming question may be put about. Closed, like the move
 * vocabulary it parameterizes, and mirrored by the zod enum in
 * semantic/classifiers.ts (the model may only name one of these).
 */
export type ConfirmSubject = "deposit" | "price" | "availability" | "conditions" | "vehicle";

/**
 * ONE THING THIS TURN IS NOT SURE IT READ RIGHT.
 *
 * `reading` is the fact we would otherwise have latched (and, before this,
 * always did - `depositKnown` went true on the bare word "passport" anywhere in
 * any inbound message, so a misread deposit was permanent). `question` is the
 * confirming question the model already phrased in the traveller's voice, so
 * even the LLM-down composer can send something that reads like a person.
 */
export interface Uncertainty {
  subject: ConfirmSubject;
  reading: string;
  question: string;
  /** The model's own confidence that this is genuinely worth asking about. */
  confidence: number;
}

/**
 * A DOUBT THE THREAD IS CARRYING - durable, with the state machine that bounds it.
 *
 * Uncertainty used to live for exactly one turn. `verified.uncertain` is rebuilt
 * from the CURRENT message, and `digest.depositKnown` is a regex over ALL inbound
 * text, so the moment the ambiguous message became history the engine decided it
 * knew the deposit again - on the very reading it had just told itself not to
 * trust. Worse, `policy.depositKnown` OR-ed in a scan of the durable model notes
 * that the per-turn ambiguity never suppressed, so `present` became legal on a
 * reading nobody had confirmed.
 *
 * So the doubt is a FACT OF THE THREAD, not a property of a frame:
 *
 *   open    - the model flagged it; the question has not gone out yet.
 *   waiting - we asked, and the thread WAITS (the owner's second half:
 *             "then wait for the shop answer").
 *
 * `turns` is the bound, and it is arithmetic - deterministic code owns the state
 * machine, the model owns every judgement about MEANING (did they answer?).
 * Without a bound a shop that never replies would freeze a thread forever.
 */
export interface PendingConfirm {
  subject: ConfirmSubject;
  /** The reading we refuse to latch until the shop settles it. */
  reading?: string;
  /** The confirming question, in the traveller's voice. */
  question: string;
  /** The model's own confidence that this is worth asking about, carried so a
   *  doubt raised three turns ago still sorts against a fresh one. */
  confidence?: number;
  state: "open" | "waiting";
  /** Turns spent in the CURRENT state. Incremented once per engine turn. */
  turns: number;
  /**
   * Wall clock (ms) when the wait STARTED - the second bound. The turn bound
   * only advances when a turn happens, and a shop that never replies causes no
   * turns: the freeze the confirm-wait finding proved. The live path stamps
   * this on the turn the confirm is delivered and arms one tick; when that
   * tick (or any later turn) sees the clock expired, the wait releases with
   * the same never-claim-they-confirmed note as the turn bound. Absent on
   * replays, which keep the pure turn arithmetic.
   */
  at?: number;
}

/** Where a shop stands with us, as a person would read it (W4.3). */
export type ShopStance = "engaged" | "deflecting" | "declining" | "unclear";

export type LeverageKind = "rival" | "benchmark" | "duration-volume" | "condition";

export interface SessionSnapshot {
  sessionId: string;
  rfq: StructuredRFQ;
  currency: string;
  /** grounded=true only; an ungrounded number never reaches a prompt (F5). */
  benchmark: {
    pricePerDay: number;
    currency: string;
    sourceUrl: string;
    grounded: true;
  } | null;
  lowest: { vendorId: string; shop: string; pricePerDay: number } | null;
  rivals: Array<{
    vendorId: string;
    shop: string;
    pricePerDay: number;
    currency: string;
    /**
     * PROVENANCE (owner report 5 #2). The per-day figure was DIVIDED out of a
     * package covering this many days ("500 for 3 days" -> 167) rather than
     * quoted per day. It is real arithmetic on a real number, but it is not a
     * price any shop stated for THIS rental length, so every surface that
     * repeats it has to say "works out to about" instead of "they quoted".
     */
    derivedFromDays?: number;
  }>;
  /**
   * WHERE EVERY OTHER SHOP IN THIS HUNT STANDS - one bounded, anonymised block
   * (negotiation/session-brief).
   *
   * `rivals` above is the LEVERAGE set: live, priced, comparable-currency
   * quotes, capped at four. Everything else about the hunt was dropped on the
   * floor, so the agent answering shop B could not know that shop C had said
   * no, that shop D was still silent, or that B was the last shop left - and
   * each of those inverts how hard a human would push. Built from the session
   * rows the engine already loads, so it costs no extra read; empty string when
   * this is the only shop in the hunt.
   */
  brief?: string;
  /** Priors banked from past successful deals (self-improvement loop). */
  priors?: { medianAchieved?: number; typicalDiscountPct?: number; sampleSize: number } | null;
  /** Few-shot TONE/tactic coaching (owner teaching + Ops learning + distilled
   *  winning traces). Injected into the prompt; numbers are never copied. */
  coaching?: string;
}

/**
 * WHAT THE MODEL HAS UNDERSTOOD ABOUT THIS THREAD - DURABLE (A4).
 *
 * The comprehension pass was per-turn and nothing it decided survived the
 * response. From turn two onward every THREAD-LEVEL meaning was re-derived by
 * regex over raw history - `firmCount` by FIRM_RX, `depositKnown` by the bare
 * word "passport", `declined` by a phrase list - and the model only ever saw
 * the current frame. That is the architectural half of the owner's "they don't
 * get a live instant of the whole thread's situation together": the engine had
 * a brain for one message and a phrase list for the conversation.
 *
 * So the model's verdicts become facts OF THE THREAD, persisted beside the
 * doubts (`pending`) that already work this way. Everything here is written by
 * `mergeComprehension`, which is pure arithmetic over model verdicts: it never
 * invents one, and on a turn where no provider answered it carries forward what
 * an earlier turn actually read rather than re-deriving anything.
 */
export interface DurableComprehension {
  /** The latest stance the model actually read (not latched - a shop that
   *  re-engages is engaged again). */
  stance?: ShopStance;
  /** The shop walked away. Model-only; no regex may write this. */
  declined?: boolean;
  /** The shop is getting rid of us politely. Model-only. */
  deflected?: boolean;
  /** The availability read, carried so a stock-out survives a quiet turn. */
  availability?: "has" | "none" | "later" | "unclear";
  restockHint?: string;
  /**
   * HOW MANY TURNS THE MODEL READ AN EXPLICIT REFUSAL TO GO LOWER.
   *
   * Accumulates, because each refusal is a thing that happened. Two of them stop
   * the bargaining (spte/policy), which is why the read behind it has to be an
   * explicit statement and not a sales adjective - see
   * classifiers.ThreadComprehension.firmness.
   */
  firmTurns?: number;
  /** The shop stated its deposit terms (readDepositTerms.stated). */
  depositStated?: boolean;
  depositKind?: "cash" | "document" | "cash-or-document" | "card" | "none" | "unclear";
  /** The handover mode the shop has stated at any point in the thread. */
  handoverMode?: "delivery" | "pickup" | "both" | "unstated";
  /** The shop has said what the handover COSTS - a number, or that it is free. */
  handoverCostKnown?: boolean;
  /**
   * THIS THREAD IS CLOSED - a structured fact, written from the MOVE we took or
   * from the model's terminal stance.
   *
   * `hasClosed()` used to grep the durable notes for /closed|goodbye|declined/,
   * and those notes are PROSE THE LLM WROTE. A note reading "they have NOT
   * declined" muted the thread permanently. Prose is evidence, never a verdict.
   */
  closed?: boolean;
}

export interface ThreadDigest {
  facts: string[]; // <=10 durable one-liners; the compressed conversation
  quotedPricePerDay?: number;
  /**
   * A SUBSTITUTION WAITING ON THE TRAVELLER. The shop offered a different
   * vehicle that is close enough to be worth asking about, so this thread is
   * paused rather than closed until they accept or decline. See
   * vehicle/substitution.ts for the decision rules and the staleness TTL.
   */
  alternativeOffer?: import("../vehicle/substitution").AlternativeOffer | null;
  round: number;
  /**
   * THE NUMBER WE LAST ASKED THIS SHOP FOR - measured on the wire, not asserted.
   *
   * The live engine's ask was `Math.round(quoteNow * 0.85)`: a flat 15% off
   * whatever the shop had just said, recomputed from scratch every turn. So a
   * shop that held firm at 300 got asked for 255 in round 0, 255 in round 1 and
   * 255 in round 2 - three identical messages that read as a bot, and no
   * concession the shop could reciprocate. `graph/math.computeRoundTarget` is
   * the real ladder (it concedes upward across rounds, never re-asks below an
   * earlier ask, and clamps strictly below a cited rival) and it needs to know
   * what we asked last time. The graph engine keeps that in
   * `fields.lastTarget`; the engine that actually answers shops kept nothing.
   *
   * Derived from the SENT text rather than from the target we handed the model,
   * for the same reason `citedRival` is: the model may not have used it. The
   * lowest money numeral strictly below the standing quote is our ask - the
   * rival we cite is by construction ABOVE it (beat, never match).
   */
  lastAskPerDay?: number;
  tone?: "friendly" | "curt" | "eager" | "reluctant";
  /**
   * THE MODEL'S DURABLE READING OF THIS THREAD (A4). Persisted; every meaning
   * flag below is projected from it, never from a regex over raw history.
   */
  comprehension?: DurableComprehension;
  // Projected per turn from `comprehension` (meaning: the model) and from
  // spte/thread-facts (arithmetic over OUR OWN stamped moves). Never persisted
  // in projected form - the durable source above is what survives the turn.
  firmCount?: number; // turns on which the model read an explicit refusal
  depositKnown?: boolean; // the shop already told us its deposit terms
  fulfillmentKnown?: boolean; // the shop already told us delivery-vs-pickup
  /** The shop offered to BRING it - the only mode that can carry a fee. */
  deliveryOffered?: boolean;
  /** The shop said what the handover costs, or that it is free. */
  fulfillmentCostKnown?: boolean;
  /** How many handover questions we have already put (stamped moves). */
  handoverAsks?: number;
  lastOutbound?: string[]; // our last 5 messages - the anti-repetition memory
  /** Every tier this shop has offered, accumulated across the whole thread. */
  options?: VehicleOption[];
  /**
   * WHAT IS KNOWN, WHAT WE ASKED, WHAT IS STILL OWED (src/lib/thread/ledger).
   * Derived every turn like everything else here. This is what makes "we already
   * asked that" and "this thread owes the traveller a deposit answer" facts the
   * legal-move set can act on, instead of hopes expressed in a prompt.
   */
  ledger?: import("../thread/ledger").ThreadLedger;
  /**
   * SUBJECTS WE HAVE ALREADY PUT A CONFIRMING QUESTION ABOUT.
   *
   * The ask-once ledger is subject-keyed with a BOOLEAN answered state, so it
   * has no way to say "asked, answered, and the answer was ambiguous" - which
   * made a confirming re-ask structurally impossible. This is the bound on the
   * third state: one confirming question per subject, ever. Durable, because
   * the digest is now persisted (W4.5) - before that it restarted empty every
   * turn and any "we already asked" fact was a fiction.
   */
  confirmAsked?: ConfirmSubject[];
  /**
   * THE CONFIRMING QUESTION CURRENTLY IN FLIGHT. Surfaced on the shop card as
   * "double-checking with the shop", so a traveller watching a thread pause on
   * a question can see WHY instead of watching an idle card.
   *
   * A MIRROR of the `pending` entry in state "waiting" - it is what the card
   * reads, and it is written from the state machine rather than re-derived from
   * the current frame. It used to be the latter, which is how a scheduled tick
   * erased the wait: no inbound message meant nothing was uncertain, so the
   * engine forgot it had asked and bargained without its answer.
   */
  awaitingConfirmation?: { subject: ConfirmSubject; question: string } | null;
  /**
   * EVERY DOUBT THIS THREAD IS CARRYING, durable (see PendingConfirm).
   *
   * A subject in here is NOT known - from any source, including the durable
   * `facts` notes - until the model reads the shop's answer as an answer, or the
   * wait runs out of turns.
   */
  pending?: PendingConfirm[];
  /**
   * THE PRICE WATCH HAS ALREADY BEEN ARMED FOR THIS THREAD (owner report 5 #9).
   *
   * A priced thread schedules no return of its own: a wakeup is written only
   * when the model asked to wait (clamped to 3 minutes - a pause-before-replying
   * tactic, not a re-entry) or when the turn went silent with no price. So a
   * shop that quoted 300 and fell quiet could never hear about the 200 that
   * landed twenty minutes later, because no turn ever happened in which it
   * could be said.
   *
   * One long re-entry per thread, ever, recorded here. Durable because the
   * digest is (W4.5). The bound is the whole design: without it, every
   * re-entered turn that lands silent-and-priced would arm another watch, and a
   * negotiation assistant would become a slow broadcast loop.
   */
  priceWatchArmed?: boolean;
  /**
   * STEP 7-8 STATE (funnel: verifying -> shop_confirmed).
   *
   * `recapSent` is the deterministic once-per-thread latch (set by mergeDigest
   * when the verify-recap move is taken, so golden replays see it too);
   * `recapSentAt` is the wall clock the live path stamps for the answer bound;
   * `recapConfirmedAt` is set when the ConfirmAnswer read says the shop said
   * yes - which is what makes `present` legal and the ledger reach
   * shop_confirmed. A recap the shop CORRECTS clears the corrected subject and
   * (once, ever) re-opens the latch so one amended recap can go out.
   */
  recapSent?: boolean;
  recapSentAt?: number;
  recapConfirmedAt?: number;
  /** One amendment allowed, ever - see the correction path in live.ts. */
  recapAmended?: boolean;
  /** The silent-but-owing re-entry has been armed (same design as
   *  priceWatchArmed: once, durable, or the watch becomes a broadcast loop). */
  oweWatchArmed?: boolean;
}

export interface VerifiedExtraction {
  found: boolean;
  pricePerDay?: number;
  currency?: string;
  declined?: boolean;
  /** The shop positively named a DIFFERENT vehicle class. Terminal. */
  wrongVehicle?: boolean;
  /**
   * The vehicle-identity gate (src/lib/vehicle). `needs-confirmation` means a
   * disqualifying attribute the traveller declared is still unresolved for the
   * price on the table - the engine may not bargain or present until it is.
   */
  vehicleStatus?: "confirmed" | "needs-confirmation" | "wrong-vehicle";
  /** The exact question to put to the shop, already phrased by the gate. */
  vehicleQuestion?: string;
  /** We ALREADY asked the confirm question in this thread (ask-once fact from
   *  the durable thread confirmation state). A second identity ask is never
   *  legal - the engine proceeds with the assumed status instead. */
  vehicleAsked?: boolean;
  /** The shop has not said which vehicle yet. NOT terminal - we ask. */
  vehicleUnclear?: boolean;
  askedLocation?: boolean;
  askedQuestion?: boolean;
  /** WHAT THE SHOP DID this turn - shared facts, asked something, or sent an
   *  automated greeting. Derived per turn (lib/wa/dialogue-acts); this is what
   *  `askedQuestion` is computed FROM, so a bare "?" can no longer make the
   *  engine think it owes an answer. */
  acts?: DialogueActs;
  /** The shop asked whether the traveller HAS a (international) license. */
  askedLicense?: boolean;
  /** The shop asked to SEE / get a photo/copy of the license. */
  askedLicensePhoto?: boolean;
  /** The shop refused to lower a price it already gave ("last price"). */
  firm?: boolean;
  /** THE SHOP HAS NOTHING TO RENT right now (thread/ledger stockState). A real,
   *  temporary state - the card says so and the agent asks when it returns. */
  shopUnavailable?: boolean;
  /** The shop's own words about when stock returns, when it offered them. */
  restockHint?: string;
  /** The tiers this reply offered, when the shop gave a CHOICE rather than a
   *  single price. Empty/absent for an ordinary one-price reply. */
  options?: VehicleOption[];
  /** The shop said the price depends on a choice, even if only one number
   *  parsed ("it depends what you choose"). */
  variance?: boolean;
  // ---- what the shop SENT, not just what it said ---------------------------
  /** This turn carried a photo. The primary engine was blind to this. */
  hadImage?: boolean;
  /** What the photo was: a price board, the vehicle itself, a document. */
  imageKind?: "vehicle" | "price_sheet" | "document" | "other";
  /** Everything the vision pass could read off the photo, in plain words. */
  imageSummary?: string;
  /**
   * THE PHOTO ARRIVED AND NOBODY LOOKED AT IT. Every vision provider failed - a
   * rejected key, a quota, a timeout, a safety block - so this turn has an image
   * it has never seen. Distinct from a photo that was read and carried nothing:
   * that one is answered with "which line is mine?", this one cannot be, and
   * pretending otherwise is how the app claimed to have read a board it had not.
   */
  imageUnread?: boolean;
  /** A price that came from a PHOTO rather than typed text. */
  sheetPricePerDay?: number;
  // ---- the comprehension pass (spte/comprehension.ts) -----------------------
  /**
   * THE SHOP IS GETTING RID OF US POLITELY. Read by a model over the whole
   * message, never by a phrase list - "you should try asking other shops" is
   * a brush-off in every language and matches no refusal vocabulary in any of
   * them. Terminal, like `declined`, but its own state so the card can say
   * "they passed" rather than inventing a decline the shop never made.
   */
  deflected?: boolean;
  /** The comprehension pass's stance verdict, carried for the trace + prompt. */
  stance?: ShopStance;
  /** The shop's own words behind the stance, so nothing has to be paraphrased. */
  stanceQuote?: string;
  /**
   * FACTS THIS TURN IS NOT SURE IT READ RIGHT (W4.4). Empty on a plain message.
   * Non-empty makes `confirm` a legal move - the engine asks rather than
   * latching a reading it does not trust.
   */
  uncertain?: Uncertainty[];
  /**
   * The comprehension pass could not run - no reachable provider. Distinct from
   * "it ran and found nothing": one is an outage that must degrade to the old
   * deterministic behaviour, the other is a clean read.
   */
  comprehensionDegraded?: boolean;
}

export interface TurnContext {
  session: SessionSnapshot;
  thread: {
    threadKey: string;
    vendorId: string;
    shop: string;
    digest: ThreadDigest;
    /** fields.presented, read in by the live glue - the once-latch that stops
     *  `present` re-marking an already-presented deal on every later inbound. */
    presented?: boolean;
  };
  /** Wall clock for the live path's wall-clock bounds (confirm wait, recap
   *  wait). ABSENT on replays and unit runs, which then use pure turn
   *  arithmetic - determinism is the property the golden gate needs. */
  nowMs?: number;
  tail: Array<{ dir: "in" | "out"; text: string; at: string }>;
  /**
   * THE THREAD DID NOT FIT, AND THE MODEL IS TOLD SO.
   *
   * `wa/history-window` marks its elision explicitly - "never silent" is its
   * own stated rule - and `buildTail` parsed the marker away, so the composer
   * saw a contiguous-looking transcript with a hole in the middle and no way to
   * know. A model that believes it has the whole conversation will confidently
   * re-ask something the shop answered in the part it cannot see. Carried as a
   * flag rather than a fake turn: nobody said it, so it must not enter the
   * repetition corpus or the counter-already-made check.
   */
  tailElided?: boolean;
  inbound: {
    text: string;
    /**
     * The English gloss of `text`, when the shop wrote in another language.
     *
     * COMPUTED ON THE CRITICAL PATH AND NEVER SHOWN TO THE COMPOSER. The app
     * pays up to 8s per turn for this translation, stamps it on the message
     * row and threads it through the engine - and it reached only the
     * comprehension pass and the regex detectors. The model that actually
     * writes the reply was negotiating against raw Indonesian while the English
     * sat one field away.
     */
    english?: string;
    verified: VerifiedExtraction;
  };
  /** The ONLY moves the single pass may choose from (policy rails output). */
  legalMoves: MoveKind[];
  /** The ONE location disclosure gate (resolveShareableLocation). Composed from
   *  the server-verified stay only - client-posted coordinates never reach it.
   *  Absent addressText means we have nothing shareable, so `pickup-location`
   *  is not a legal move and the UI asks the traveller instead. */
  share?: { addressText?: string; mapsLink?: string };
  /**
   * THE OWNER'S SLIDERS REACH THIS ENGINE, OR THEY REACH NOTHING.
   *
   * Nothing under src/lib/spte imported the policy overlay, and SPTE is the
   * PRIMARY engine (the graph engine is the failover). So every threshold the
   * owner moved in Admin -> Ops applied only to the path that usually does not
   * run: `priceFarAboveFloor` was hard-coded 1.25 here while the overlay's own
   * default is 1.08 with a comment calling 1.25 "far too soft"; `maxRounds` was
   * hard-coded 6 while the graph spec's owner-editable maxRoundsPerShop
   * defaults to 4, so the live engine allowed 50% more pushes per shop than the
   * configured policy; and bannedPhrases was enforced only in the graph engine,
   * so a phrase the owner banned still went out on every real message.
   *
   * Both numbers are OPTIONAL with the historical literal as the fallback, so a
   * caller that cannot read config (replay, the simulator, a unit test) behaves
   * exactly as before rather than silently adopting a different policy.
   */
  guards: {
    floorPerDay?: number;
    maxRounds: number;
    /** overlay.priceFarAboveFloor; falls back to the historical 1.25. */
    priceFarAboveFloor?: number;
    /** overlay.bannedPhrases - scrubbed from the finished draft by the rails. */
    bannedPhrases?: string[];
  };
  /** Event that triggered this turn - a real inbound, a wakeup, or a swarm poke. */
  event: "shop-message" | "tick" | "rival-improved";
  /** REPLAY ONLY. Skips the single LLM pass and composes from the deterministic
   *  templates, so a frozen thread yields the same move and the same bytes on
   *  every run - what makes the golden suite usable as an eval gate. The live
   *  path never sets this (the graph engine's `llmAllowed:false` equivalent). */
  deterministic?: boolean;
}

/** The single pass's entire structured JSON output. */
export interface TurnArtifact {
  read: {
    intent: string;
    priceMentioned?: number;
    declined?: boolean;
    wrongVehicle?: boolean;
  /**
   * The vehicle-identity gate (src/lib/vehicle). `needs-confirmation` means a
   * disqualifying attribute the traveller declared is still unresolved for the
   * price on the table - the engine may not bargain or present until it is.
   */
  vehicleStatus?: "confirmed" | "needs-confirmation" | "wrong-vehicle";
  /** The exact question to put to the shop, already phrased by the gate. */
  vehicleQuestion?: string;
    askedLocation?: boolean;
  };
  think: string; // <=80 tok scratchpad - logged, never sent
  move: MoveKind; // MUST be in legalMoves (validated + coerced)
  message?: string; // the draft (absent for silent)
  /** Which fact a `confirm` move is putting back to the shop. Set by the
   *  engine from the legal-move computation, never by the model - the model
   *  picks the MOVE, the policy already decided which subject is unsettled. */
  confirmSubject?: ConfirmSubject;
  counterPricePerDay?: number; // guards verify against floor/quote/rival
  leverageUsed: LeverageKind[];
  digestPatch: string[]; // <=3 new durable facts
  waitMinutes?: number;
}

export interface RailResult {
  ok: boolean;
  finalText?: string; // post guards + uniqueness + humanize-once
  rejected?: { rule: string; detail: string };
}

export interface ModelRoute {
  tier: "R" | "F" | "M";
  /**
   * WHICH PROVIDER ACTUALLY ANSWERED.
   *
   * Declared here since the engine shipped and assigned by nobody, so the Ops
   * turn row fell through to its `mock/local` chip on one hundred percent of
   * turns - including every turn a real model composed. The help text then
   * explained that "'mock/local' means no live key was used", which made a
   * cosmetic omission read as a broken deployment.
   *
   * The failover chain has always known the answer (chatDetailed returns it);
   * `chat()` simply threw it away at the call site. The hand-written union
   * knew four of the nine configurable providers, which is its own way of
   * losing the truth, so it reads the real list now.
   */
  provider?: import("../ai").ProviderName;
  /**
   * WHY NO PROVIDER ANSWERED, when none did.
   *
   * Without it, "no key is configured" and "every configured key is failing"
   * are the same observation from the outside: a deterministic template, a null
   * provider, and an Ops chip reading mock/local. One is a demo deployment and
   * the other is an outage in progress, and the owner needs to tell them apart
   * at a glance - especially now that eight providers are configured.
   */
  error?: string;
  model?: string;
  reason:
    | "reflex"
    | "default"
    | "multimodal"
    | "high-stakes"
    | "quota-overflow"
    | "replay"
    // A post-rail rejected the model's draft and the deterministic fallback
    // went out instead - suffixed with the rule that fired. This used to be
    // recorded as "quota-overflow", so Ops could not tell an outage from a
    // misbehaving model.
    | `rail-rejected:${string}`;
}
