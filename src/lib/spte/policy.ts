// SPTE policy rails - the DETERMINISTIC, 0-token replacement for the graph's
// edge selection. This is the "if/else for SAFETY, not for STRATEGY" boundary:
// code computes which moves are LEGAL this turn; the single-pass LLM chooses
// freely among them and writes the message. Decision trees never dictate WHAT
// to say - only what is FORBIDDEN.

import type {
  ConfirmSubject,
  MoveKind,
  PendingConfirm,
  TurnContext,
  TurnArtifact,
  Uncertainty,
} from "./types";
import { menuUnresolved } from "../offer-options";
import { CONFIRM_WAIT_MS } from "./digest";
import { alreadyAsked, unaskedObligations, type ThreadLedger } from "../thread/ledger";
import type { ClaimSubject } from "../thread/claims";
import { passportOnlyDeposit, counterAlreadyMade } from "../negotiation/deposit-counter";

/**
 * Compute the legal move set for this turn from verified facts. Ordered by the
 * deterministic ladder priority (first = the fallback the coercion picks), so a
 * missing/invalid LLM choice degrades to a safe, sensible move.
 */
export function legalMovesFor(ctx: TurnContext): MoveKind[] {
  const v = ctx.inbound.verified;
  const d = ctx.thread.digest;
  const moves: MoveKind[] = [];

  // OUT OF STOCK OUTRANKS A DECLINE, and this order is the whole point.
  //
  // These two branches overlap constantly: a shop saying "sorry, I don't have
  // any bikes" reads as BOTH - it is a refusal in surface form and an
  // inventory fact in substance. Whichever branch runs first decides the
  // thread's fate, and `declined` used to run first, so a temporary,
  // completely normal stock-out was filed as a rejection and answered with a
  // goodbye. That is the Ko Tao 12:38 message: the shop had quoted 180 a
  // minute earlier, misread our "free" as a request for a free motorbike,
  // said it had none - and got farewelled by an agent that then agreed to the
  // price it had already been given.
  //
  // A decline ends a negotiation. A stock-out pauses one and gives us a
  // question worth asking. When a message can be read as either, it is the
  // one that keeps the thread alive.
  if (v.shopUnavailable) {
    if (!alreadyAskedStock(ctx)) moves.push("restock-probe");
    moves.push("silent");
    return dedupe(moves);
  }

  // THE BRUSH-OFF (W4.3). "You should try asking other shops; maybe they'll
  // give you one."
  //
  // With shopUnavailable=false, declined=false, wrongVehicle=false, no question
  // asked, firmCount 0 and no price, that message walked past every branch
  // below to the "no price yet" default - whose only legal moves ARE rate
  // re-asks - and coerceToLegal forced one. The shop had just told us to go
  // somewhere else and the agent replied "could you let me know your daily rate
  // for the automatic 125cc scooter?".
  //
  // It sits BELOW the stock branch on purpose, and the comprehension pass
  // enforces the same order on the reading itself: a shop with nothing to rent
  // today is not a shop that sent us away, and the one that keeps the thread
  // alive wins whenever a message can be read as either.
  if (v.deflected) {
    if (!hasClosed(ctx)) moves.push("graceful-close");
    moves.push("silent");
    return dedupe(moves);
  }

  // Terminal / silence conditions (highest precedence after stock).
  if (v.declined) {
    // First decline owes exactly ONE warm goodbye, then silence (the B7 rule,
    // now structural): a close is legal while we have not closed yet.
    if ((d.round ?? 0) >= 0 && !hasClosed(ctx)) moves.push("farewell");
    moves.push("silent");
    return dedupe(moves);
  }
  // TERMINAL ONLY ON A REAL MISMATCH. This branch returns early and erases every
  // other move, so it must fire only when the shop POSITIVELY named a different
  // vehicle class. It used to fire on "unclear" too, which is how a shop
  // answering "Normal scooters? Some models 200 and some new 250/day" got a
  // goodbye instead of a question.
  // A PENDING CHOICE PAUSES THE THREAD, WHATEVER SIGNAL FOUND IT.
  //
  // This lived INSIDE `if (v.wrongVehicle)`, and wrongVehicle is the pre-union
  // signal only (`vehicleVerdict === "mismatch"` or `matchesSpec === false`).
  // The whole point of the trigger union is the case where NEITHER fires - the
  // shop says "no Click, only Nmax" with matchesSpec true and the verdict
  // "unclear" - so on exactly the case the union exists for, the pause was
  // unreachable and the agent kept haggling for a vehicle the shop had said it
  // did not have, while the traveller's Yes/No sat unanswered on the card. The
  // shipped copy promises the opposite in as many words: "the thread is paused
  // while this sits here; the agent haggles nothing until the traveller
  // answers."
  //
  // Its own rung now, keyed on the parked choice alone. The TTL that stops a
  // stale choice holding the thread forever lives in vehicle/substitution.ts,
  // and the digest applies it before this ever sees it.
  if (ctx.thread.digest.alternativeOffer) {
    moves.push("silent");
    return dedupe(moves);
  }

  if (v.wrongVehicle) {
    // A SHOP THAT OFFERS SOMETHING ELSE IS NOT A SHOP THAT SAID NO - handled
    // by the rung above. Reaching here means a mismatch with NO parked choice:
    // the shop named a different vehicle and offered nothing to decide on.
    moves.push(hasClosed(ctx) ? "silent" : "redirect-close");
    return dedupe(moves);
  }

  // (The out-of-stock branch moved ABOVE `declined` - see the note there. It
  // outranks every price move for the same reason it outranks a decline: a
  // shop that has just said it has no vehicle is not a shop to haggle with.)

  // ...AND WAITS (W8.1). The half of the doctrine that was never enforced.
  //
  // The owner's rule has two clauses: ask when unsure, "THEN WAIT FOR THE SHOP
  // ANSWER". Only the asking was implemented. `awaitingConfirmation` was
  // recomputed from the CURRENT frame - it survived only while this turn's
  // message was still ambiguous - so a scheduled tick, which carries no message
  // at all, erased it and left `bargain` legal. The agent asked "you mean
  // passport OR 4,000 cash?" and then, with no answer, pushed on price. Proven
  // end to end.
  //
  // The wait is now a durable fact of the thread (digest.pending, state
  // "waiting"), and this is where it binds: while it holds, the only legal moves
  // are silence and - because a shop waiting on US is still owed its reply - an
  // answer. No bargain, no present, no probe, no second question. It sits BELOW
  // the terminal branches on purpose: a shop that declines or runs out of stock
  // while we wait gets its goodbye, not a stare.
  //
  // The bound lives in digest.ts (CONFIRM_WAIT_TURNS): the state machine is
  // arithmetic, and only the model decides whether their reply was an answer.
  const waiting = waitingOn(ctx);
  if (waiting) {
    if (v.askedQuestion || v.askedLicense || v.askedLicensePhoto) moves.push("answer");
    moves.push("silent");
    return dedupe(moves);
  }

  // ANSWER-FIRST when the shop asked something. This MUST precede bargain in the
  // ladder: coerceToLegal and the fallback both take legal[0], so if bargain led
  // the list a question would go unanswered (the live "agent ignored 'Around
  // what time?'" bug). A question the shop asks is owed a reply before any push.
  const askedQ = v.askedQuestion || v.askedLicense || v.askedLicensePhoto;
  // Only legal when there is something VERIFIED to share. With no stay on file
  // the honest move is to answer the question without an address (the UI asks
  // the traveller for one) - never to improvise a location.
  if (v.askedLocation && ctx.share?.addressText) moves.push("pickup-location");
  if (askedQ) moves.push("answer");

  // RESOLVE THE MENU BEFORE HAGGLING IT. When the shop has offered more than one
  // tier and we still cannot tell them apart, the next useful move is to ask
  // what separates them - not to bargain a number the traveller has not chosen.
  // Ordered ahead of `bargain` because coerceToLegal and the LLM-down fallback
  // both take legal[0]. This is a fact about the DATA (menuUnresolved), never a
  // rule about the shop's wording.
  // SETTLE THE VEHICLE BEFORE THE PRICE. The strongest ordering rule in the
  // ladder, because everything downstream is worthless if the number belongs to
  // a bike the traveller cannot legally ride. This is a fact about the DATA -
  // the identity gate's status - never a rule about the shop's wording, and it
  // sits ahead of every price move because coerceToLegal and the LLM-down
  // fallback both take legal[0].
  // ...and ONLY ONCE. The Thailand field test showed the stateless version of
  // this rule re-asking the same identity question after the shop had already
  // answered it: the gate is recomputed per message, and a direct answer that
  // names no vehicle looks "unconfirmed" forever. The durable thread state
  // (vehicleAsked, from negotiation_threads.fields.vehicleConfirmation) is the
  // ask-once fact - after one ask the engine proceeds with the assumed status.
  if (v.vehicleStatus === "needs-confirmation" && !v.vehicleAsked && !dealComplete(ctx)) {
    moves.push("confirm-vehicle");
  }

  // IF THE AGENT IS NOT SURE, IT ASKS - AS A QUESTION, THEN WAITS (W4.4).
  //
  // The move vocabulary was CLOSED and the only fact-confirmation move in it
  // was `confirm-vehicle`; `clarify` is defined to the model as price-only. So
  // the one thing an unsure agent could do about a deposit it had half-read was
  // write the half-read version down and move on. The extractor has emitted a
  // `confidence` field the whole time and the live engine read neither it nor
  // the `clarifyMessage` beside it.
  //
  // Ordered ahead of every price move for the same reason `confirm-vehicle` is:
  // haggling a number, or presenting terms, on a reading we do not trust is
  // worse than one more question. It is NOT ordered ahead of `answer` - a shop
  // waiting on us is owed its reply first, and our doubt can ride along.
  if (confirmableSubjects(ctx).length > 0) moves.push("confirm");

  const options = d.options ?? [];
  // A MENU THE SHOP HAS ANSWERED IS NOT A MENU (owner report 4/W2.2 - the
  // coherence golden seeds caught this). `menuUnresolved` reads the tiers
  // accumulated across the WHOLE thread, so after the shop answered the probe
  // ("the new one is 250, helmet included") - or simply moved the price
  // ("cannot, 280 is my price", which optionsFromThread accumulates as a
  // second tier) - the menu stayed "open" forever and option-probe outranked
  // bargain on every later turn: the agent re-asked a question the shop had
  // just answered. A confident single-price answer THIS turn resolves the
  // menu for negotiation purposes; a turn that itself carries variance or an
  // unclear vehicle keeps the probe legal.
  const menuAnswered =
    v.found && typeof v.pricePerDay === "number" && !v.variance && !v.vehicleUnclear;
  const menuOpen =
    (menuUnresolved(options) || (Boolean(v.variance) && !v.found)) && !menuAnswered;
  if (menuOpen && !dealComplete(ctx)) moves.push("option-probe");

  // FIRM LADDER (graph parity, the two-firms-stop rule). The shop said "last
  // price" firmCount times:
  //   - >=2  -> price bargaining is OVER. Never push again.
  //   - ===1 -> one more push is allowed ONLY with real leverage (a verified
  //             cheaper rival, or a price still far above the floor).
  //   -  0   -> bargain freely (subject to the round cap).
  const firmCount = d.firmCount ?? 0;
  // THE THREAD'S STANDING PRICE, not only this message's (W4.5).
  //
  // Every price test below read `v.pricePerDay`, which is rebuilt from the
  // CURRENT inbound frame. So the moment a shop replied without restating its
  // number - "ok for you?", "yes we have", a photo - bargain, deposit-probe and
  // present all became illegal, the ladder fell through to its no-price
  // default, and `momentum` turned on against a shop we were mid-negotiation
  // with. The quote is a fact about the THREAD; it lives in the digest, which
  // is now durable, and this is the one place that has to say so.
  const standingQuote = quoteOnTable(ctx);
  const rivalCheaper =
    typeof ctx.session.rivals?.[0]?.pricePerDay === "number" &&
    typeof standingQuote === "number" &&
    ctx.session.rivals[0].pricePerDay < standingQuote;
  const priceFarAboveFloor =
    typeof ctx.guards.floorPerDay === "number" &&
    typeof standingQuote === "number" &&
    // The owner's threshold, not a literal. Default 1.08 - the overlay's own
    // comment calls the old 1.25 "far too soft", and that tightening applied
    // only to the fallback engine until this line read it.
    standingQuote > ctx.guards.floorPerDay * (ctx.guards.priceFarAboveFloor ?? 1.25);
  const firmAllowsBargain =
    firmCount >= 2 ? false : firmCount === 1 ? rivalCheaper || priceFarAboveFloor : true;

  // A live price is the pivot: bargain-first is structural (never probe deposit/
  // delivery while a legal bargain move exists), BUT the firm ladder and the
  // round cap can retire bargaining, which is exactly what unlocks the
  // logistics close-out below.
  const priceKnown = typeof standingQuote === "number";
  const roundsLeft = (d.round ?? 0) < ctx.guards.maxRounds;
  // NEVER BARGAIN AGAINST YOUR OWN FLOOR - ONE NUDGE, THEN LOCK.
  //
  // `session.lowest` has been computed since the engine shipped and read by
  // nothing that decides anything: a swarm signal and a telemetry chip. So at
  // Ko Tao, with the session's best price at 180 and THIS shop quoting 180,
  // the engine bargained by construction - `rivalCheaper` and
  // `priceFarAboveFloor` are only consulted when firmCount === 1, and at
  // firmCount 0 bargain is unconditional. We answered the cheapest shop in the
  // session with "that's a bit high for me", against a floor we had set
  // ourselves. There is no rival to leverage, because we ARE the rival.
  //
  // The owner's rule, and it is the right one: exactly ONE price move at or
  // below the session low, then switch to terms whatever happens. The nudge
  // is worth having - shops move on a first ask - but a second one is
  // bargaining with ourselves, and it is how a won deal turns into a shop that
  // stops replying.
  const lockedAtFloor = atSessionLow(ctx) && alreadyPushedAtFloor(ctx);
  if (priceKnown && roundsLeft && firmAllowsBargain && !lockedAtFloor && !dealComplete(ctx)) {
    moves.push("bargain");
  }

  // Missing qualification info -> probe. Reachable now because bargain retires
  // on firm/round-cap: this IS the mandatory INFO_DISCOVERY phase. Once we have
  // a settled price we MUST learn deposit + delivery before going quiet.
  if (!moves.includes("bargain")) {
    if (!priceKnown) moves.push("clarify");
    if (priceKnown && !depositKnown(ctx)) moves.push("deposit-probe");
    // THE PASSPORT-DEPOSIT COUNTER (negotiation/deposit-counter): the shop's
    // known terms demand the ORIGINAL passport with no cash route, and we have
    // never asked for the alternative - ONE polite counter is legal. After we
    // send it the ask-once ledger gate holds it outstanding, and once the shop
    // answers, counterAlreadyMade keeps it retired forever - a decline is
    // accepted gracefully by construction.
    if (priceKnown && depositKnown(ctx) && passportCounterDue(ctx)) moves.push("deposit-probe");
    if (priceKnown && !fulfillmentKnown(ctx)) moves.push("fulfillment-probe");
    // ...AND ONE FOLLOW-UP FOR WHAT IT COSTS. The gate above closed on the word
    // "deliver", so "yes, we deliver to your hotel" retired the subject with the
    // fee never asked - and a delivery charge discovered at handover is exactly
    // the number this app exists to have found before the traveller chose.
    if (priceKnown && handoverCostDue(ctx)) moves.push("fulfillment-probe");
  }

  // A complete, priced deal -> steps 7-8 of the funnel, in order.
  //
  // ...UNLESS SOMETHING IN IT IS STILL A GUESS. The recap is where a reading
  // stops being an internal note and becomes the terms of the deal, so ANY
  // subject the thread is carrying a doubt about - not only the deposit -
  // withholds it. `confirm` sits above this in the ladder, so the thread's
  // answer to "we are not sure" is to ask; the turn bound in digest.ts stops a
  // doubt nobody resolves from holding the presentation forever.
  //
  // The order IS the funnel: verify-recap goes to the SHOP once (the latch is
  // digest.recapSent); `present` - state-only, traveller-facing - becomes
  // legal only after the shop confirmed the recap, or after the recap sat
  // unanswered past the wall-clock bound (the deal is then presented with the
  // honest caveat that the shop never re-confirmed; waiting forever on a shop
  // that already stated every term serves nobody).
  if (dealComplete(ctx) && !(ctx.thread.digest.pending ?? []).length) {
    const dg = ctx.thread.digest;
    const recapExpired =
      typeof dg.recapSentAt === "number" &&
      typeof ctx.nowMs === "number" &&
      ctx.nowMs - dg.recapSentAt > CONFIRM_WAIT_MS;
    if (!dg.recapSent) moves.push("verify-recap");
    else if (!ctx.thread.presented && (dg.recapConfirmedAt != null || recapExpired)) {
      moves.push("present");
    }
  }

  // DO NOT ASK WHAT WE HAVE ALREADY ASKED. A fact-question whose answer is still
  // outstanding is not a legal move - not discouraged in a prompt, ABSENT. This
  // is what stops "could you share your best price per day for the 4 days?" from
  // going out twice; the honest alternative is to wait, which is what falls out
  // below when nothing else is legal. Only FACT questions are gated: a bargain
  // is a push, not a question, and pushing twice is a strategy the model owns.
  const gated = withoutRepeatedAsks(ctx, moves);

  // NEVER GO QUIET OWING SOMETHING. A thread that has not established the
  // deposit or how the traveller collects the vehicle is not finished, and
  // silence used to be legal there simply because nothing was owed. An
  // obligation we have not even asked about outranks falling silent.
  //
  // ...BUT AN OBLIGATION IS NOT DUE BEFORE ITS PREREQUISITE. The ledger already
  // orders these (a deposit is a term OF a price), and `priceKnown` is the same
  // rule stated against the facts the ENGINE holds rather than the words in the
  // thread - a price read off a photo never appears as a text claim, and a
  // deposit question is just as premature either way. This is the fix for the
  // live "could you let me know your deposit?" that went out to a shop which had
  // sent nothing but an opening-hours auto-reply.
  if (gated.length === 0 && priceKnown) {
    for (const subject of unaskedObligations(ctx.thread.digest.ledger ?? EMPTY_LEDGER)) {
      if (subject === "deposit") gated.push("deposit-probe");
      if (subject === "handover") gated.push("fulfillment-probe");
    }
    // THE PRICED-THREAD DEAD END (the finding this rescues): every remaining
    // subject has been asked and never answered, so the ask-once ledger strips
    // the probes, dealComplete is false, and the old ladder fell to permanent
    // silence - a thread one message away from a deal, mute forever.
    // handoverCostDue's own comment stated the honest answer ("present the
    // deal with the fee marked unknown") and it was never implemented. This
    // is it: ONE recap, with the unanswered subjects asked inside it - the
    // single legitimate re-ask, bundled into the confirmation. Only on a
    // re-entry turn (a tick/wakeup - the shop is not mid-sentence), so a shop
    // that just spoke gets the normal answer flow first.
    if (
      gated.length === 0 &&
      !ctx.thread.digest.recapSent &&
      ctx.event !== "shop-message" &&
      !hasClosed(ctx)
    ) {
      gated.push("verify-recap");
    }
  }

  // A THREAD WITH NO PRICE IS NOT A FINISHED THREAD.
  //
  // Ko Tao, A & T Rental, 12:26: "Sorry,we do already discount." No price, no
  // question, no firm, no decline, no availability cue - so `clarify` was the
  // only move pushed, and the ask-once gate removed it (we asked "price" in
  // the opener, and their reply has no price token to settle it). Empty set,
  // reflex `silent`, and 28 minutes of nothing. That thread was one nudge away
  // from a quote and the engine had no way to send it, because the only move
  // it knew was the question it had already asked.
  //
  // `momentum` is that move. It has had a template since the graph engine
  // (pass.ts) and was never made legal anywhere on the SPTE path - a whole
  // move sitting unreachable. It is not the question again; it is a light
  // re-opening, which is exactly what a shop that answered vaguely needs.
  //
  // Once only, while the thing we came for is still missing - AND ONLY WHEN THE
  // THREAD IS ACTUALLY QUIET.
  //
  // `momentum` renders as "Hi again! Just checking in - any chance on that
  // better rate...". Nothing in its guard tested whether the shop had replied
  // THIS turn, so it was legal against a shop that had just spoken - including
  // one that had just dismissed us. Greeting a shop with "hi again, checking
  // in" ten seconds after it wrote to us is not a nudge, it is proof that
  // nobody read the message.
  //
  // A nudge belongs to a thread nothing is coming back to, which is precisely
  // what the wakeup below this file schedules: a silent, priceless turn parks a
  // 3-minute tick, the tick re-enters through the SAME engine (engine-route),
  // and `momentum` is legal there. So the A & T thread still gets its nudge -
  // it gets it as a re-opening rather than as a non-sequitur reply.
  //
  // A RELUCTANT SHOP IS NOT NUDGED AT ALL. Tone has been computed every turn
  // since the engine shipped and read by nothing on this path; this is the
  // first thing that acts on it, and "they sounded annoyed, so stop poking
  // them" is the least surprising thing it could possibly do.
  const shopSpokeThisTurn = ctx.event === "shop-message";
  if (
    gated.length === 0 &&
    !priceKnown &&
    !shopSpokeThisTurn &&
    d.tone !== "reluctant" &&
    !alreadyNudged(ctx) &&
    !v.declined &&
    !v.deflected
  ) {
    gated.push("momentum");
  }

  // Nothing owed -> silence is the most human move (the graph's default).
  if (gated.length === 0) gated.push("silent");
  return dedupe(gated);
}

/** Fact-questions, and the subject each one asks about. A move not in here is
 *  not a question and is never gated by the ledger. */
const QUESTION_SUBJECT: Partial<Record<MoveKind, ClaimSubject>> = {
  clarify: "price",
  "deposit-probe": "deposit",
  "fulfillment-probe": "handover",
  "restock-probe": "availability",
};

const EMPTY_LEDGER: ThreadLedger = { claims: [], known: [], outstanding: [], owed: [] };

/**
 * Have we already nudged this quiet thread?
 *
 * A nudge is a re-opening, not a question, so the ask-once ledger has nothing
 * to say about it - it gates FACT questions, deliberately. The bound lives
 * here instead: our own recent messages are already in the digest, and one
 * check-in is a nudge while two is pestering.
 */
function alreadyNudged(ctx: TurnContext): boolean {
  return (ctx.thread.digest.lastOutbound ?? []).some((m) =>
    /\b(hi again|checking in|just following up|any chance on that|any update)\b/i.test(m ?? "")
  );
}

/** Have we already put the restock question, or has the shop already answered
 *  it? Either way, asking again is nagging a shop that told us it has nothing. */
function alreadyAskedStock(ctx: TurnContext): boolean {
  const ledger = ctx.thread.digest.ledger;
  if (ledger && alreadyAsked(ledger, "availability")) return true;
  if (ctx.inbound.verified.restockHint) return true; // they already said when
  return (ctx.thread.digest.lastOutbound ?? []).some((m) =>
    /\b(back in stock|available again|when.{0,20}(available|back))\b/i.test(m ?? "")
  );
}

/**
 * THE QUOTE ON THE TABLE - this message's number, or the thread's.
 *
 * Exported because `atSessionLow`, the leverage planner and the prompt all have
 * to agree on which number this negotiation is about; two modules disagreeing
 * about the shop's price is worse than either answer.
 */
export function quoteOnTable(ctx: TurnContext): number | undefined {
  const v = ctx.inbound.verified;
  if (v.found && typeof v.pricePerDay === "number") return v.pricePerDay;
  const standing = ctx.thread.digest.quotedPricePerDay;
  return typeof standing === "number" ? standing : undefined;
}

/**
 * WHICH FACTS MAY STILL BE PUT BACK AS A QUESTION.
 *
 * The comprehension pass says what it is unsure of; this says which of those we
 * are still ALLOWED to ask about. Two bounds, both arithmetic:
 *
 *   - ONCE PER SUBJECT, EVER (`digest.confirmAsked`, durable). A shop that
 *     answers a confirming question ambiguously a second time is not going to
 *     be clearer the third time, and asking again is how a negotiation turns
 *     into an interrogation.
 *   - NOT ON A DEAD THREAD. Nothing is worth confirming with a shop that has
 *     declined, deflected, or told us it has nothing - those branches return
 *     before this is ever consulted, and `dealComplete` retires it too.
 */
export function confirmableSubjects(ctx: TurnContext): Uncertainty[] {
  const asked = new Set<ConfirmSubject>(ctx.thread.digest.confirmAsked ?? []);
  const seen = new Set<ConfirmSubject>();
  const out: Uncertainty[] = [];
  // THIS TURN'S DOUBTS, AND THE THREAD'S. `verified.uncertain` is rebuilt from
  // the current message, so on its own it means the engine forgets it was unsure
  // the moment the ambiguous message scrolls into history - and then acts on the
  // reading it had distrusted. The durable half (digest.pending) is what makes
  // "unsure" a property of the negotiation instead of a property of one frame.
  const durable: Uncertainty[] = (ctx.thread.digest.pending ?? [])
    .filter((p) => p.state === "open")
    .map((p) => ({
      subject: p.subject,
      reading: p.reading ?? "",
      question: p.question,
      // The model's own number, carried with the doubt, so the
      // least-understood-first ordering in `confirmSubjectFor` still means
      // something for a doubt raised three turns ago. 1 (fully confident, so
      // last in line) only when a stored row predates the field.
      confidence: typeof p.confidence === "number" ? p.confidence : 1,
    }));
  for (const u of [...(ctx.inbound.verified.uncertain ?? []), ...durable]) {
    if (asked.has(u.subject) || seen.has(u.subject)) continue;
    if (!u.question || !u.question.trim()) continue;
    seen.add(u.subject);
    out.push(u);
  }
  return out;
}

/**
 * THE DOUBT THIS THREAD IS WAITING ON AN ANSWER FOR, if any.
 *
 * Read from the durable state machine only. A turn with no inbound message
 * (a tick, a wakeup, a swarm poke) must see exactly what the previous turn left
 * behind - that is the entire difference between waiting and forgetting.
 */
export function waitingOn(ctx: TurnContext): PendingConfirm | undefined {
  return (ctx.thread.digest.pending ?? []).find((p) => p.state === "waiting");
}

/**
 * IS THIS FACT STILL UNCONFIRMED - from ANY source?
 *
 * A subject carried in `digest.pending` (flagged this turn or ten turns ago) is
 * one we have decided we do not understand. Until the shop settles it, or the
 * turn bound releases it, no reader may report it as known: not the thread-facts
 * regex, not the ledger's typed claim, and not the durable model notes.
 *
 * That last one was the hole the audit found. `depositKnown` OR-ed in a scan of
 * `digest.facts` that the per-turn ambiguity never suppressed, so the same
 * context with the deposit line in the model's notes read as KNOWN despite the
 * ambiguity - and `present` became legal on a reading nobody had confirmed.
 */
function unconfirmed(ctx: TurnContext, subject: ConfirmSubject): boolean {
  if ((ctx.thread.digest.pending ?? []).some((p) => p.subject === subject)) return true;
  // The live read still counts on the turn it lands, before anything is merged.
  return (ctx.inbound.verified.uncertain ?? []).some((u) => u.subject === subject);
}

/** The single subject a `confirm` move is about - the most-doubted one first.
 *  The move vocabulary is closed, so the SUBJECT is what parameterizes it. */
export function confirmSubjectFor(ctx: TurnContext): Uncertainty | undefined {
  const all = confirmableSubjects(ctx);
  if (!all.length) return undefined;
  // Least confident first: the thing we understand worst is the thing worth the
  // thread's one question. Ties keep the model's own ordering.
  return [...all].sort((a, b) => a.confidence - b.confidence)[0];
}

/** One cash-deposit counter is due: original-passport-only terms, never asked. */
export function passportCounterDue(ctx: TurnContext): boolean {
  return (
    passportOnlyDeposit(ctx.thread.digest.ledger) &&
    !counterAlreadyMade(ctx.thread.digest.lastOutbound ?? []) &&
    !counterAlreadyMade(ctx.tail.filter((m) => m.dir === "out").map((m) => m.text))
  );
}

function withoutRepeatedAsks(ctx: TurnContext, moves: MoveKind[]): MoveKind[] {
  const ledger = ctx.thread.digest.ledger;
  if (!ledger) return moves;
  return moves.filter((m) => {
    const subject = QUESTION_SUBJECT[m];
    return !subject || !alreadyAsked(ledger, subject);
  });
}

/** Human vehicle word for the license answer ("this vehicle category"). */
function vehicleWord(ctx: TurnContext): string {
  const r = ctx.session.rfq;
  if (r.vehicleClass === "car") return "car";
  if (r.vehicleClass === "motorbike") return "motorbike";
  return "scooter";
}

/**
 * REFLEX TIER (Tier R): resolve the turn with ZERO LLM calls when the facts
 * fully determine it. Returns the move to take (optionally with the exact wire
 * text for protocol answers), or null to fall through to the single pass. This
 * is what keeps most protocol turns free - and what makes the license protocol
 * work even when every LLM provider is down.
 */
export function reflexTurn(
  ctx: TurnContext
): { move: MoveKind; reason: string; message?: string } | null {
  const legal = ctx.legalMoves;
  const v = ctx.inbound.verified;

  // LICENSE PROTOCOL (deterministic policy, owner directive):
  // - asked for a PHOTO/copy -> politely defer until the deal is agreed.
  // - asked IF we have one -> firm yes, for this vehicle category.
  // Only reflex when the message carries no price - a "license? 300/day" combo
  // still gets the full single pass (which answers both under the prompt rules).
  const priceInMessage = v.found && typeof v.pricePerDay === "number";
  if (!priceInMessage && legal.includes("answer")) {
    if (v.askedLicensePhoto) {
      return {
        move: "answer",
        reason: "license-photo ask - defer until rates agreed (policy)",
        message:
          "Sure - I'll share a photo of my license once we finalize the rate and rental details 👍 What's your best price per day?",
      };
    }
    if (v.askedLicense) {
      return {
        move: "answer",
        reason: "license ask - firm yes for this vehicle category (policy)",
        message: `Yes, I have a valid international driving license for a ${vehicleWord(ctx)}. What would your best price per day be?`,
      };
    }
  }

  // Only one legal move AND it needs no composition -> take it reflexively.
  if (legal.length === 1 && legal[0] === "silent") {
    return { move: "silent", reason: "nothing owed - silence" };
  }
  // A pure decline where the goodbye was already sent -> silence, no LLM.
  if (legal.length === 1 && legal[0] === "silent" && ctx.inbound.verified.declined) {
    return { move: "silent", reason: "already said goodbye" };
  }
  return null;
}

/**
 * Coerce an LLM move to the legal ladder (the B7 lesson generalized): never
 * trust an out-of-set choice. Falls back to the first (highest-priority) legal
 * move, exactly as the deterministic director did.
 */
export function coerceToLegal(artifact: TurnArtifact, legal: MoveKind[]): MoveKind {
  if (legal.includes(artifact.move)) return artifact.move;
  return legal[0] ?? "silent";
}

/**
 * Is THIS shop's live quote the cheapest thing in the whole session?
 *
 * `<=` and not `===`: `session.lowest` is computed from the stored rows, and
 * this turn's quote may be newer than the snapshot that produced it (a shop
 * that just dropped 250 -> 200 while the ledger still says 210). Whenever our
 * own number is at or under the session floor, there is nobody left to
 * leverage.
 *
 * Exported because the leverage planner needs the same answer, and two modules
 * disagreeing about who the cheapest shop is would be worse than either
 * answer.
 */
export function atSessionLow(ctx: TurnContext): boolean {
  const low = ctx.session.lowest?.pricePerDay;
  const mine = ctx.inbound.verified.pricePerDay ?? ctx.thread.digest.quotedPricePerDay;
  return typeof low === "number" && typeof mine === "number" && mine <= low;
}

/**
 * Have we already spent our one nudge at this price?
 *
 * Derived, not stored: our own last messages are already in the digest as the
 * anti-repetition memory, and a bargain always names the number it asks for.
 * So "did we already push below this quote" is a question the thread can
 * answer, with no new column and no counter to keep in sync.
 *
 * A PRICE NAMES A PRICE; A MEASUREMENT NAMES A UNIT. That is what separates
 * the two, and it has to, because a band cannot: "125cc" for a 180/day quote
 * sits squarely inside any plausible price range. So a number carrying a unit
 * is not an ask - "3 days", "125cc", "9am" - while "160" and "160/day" are.
 * The band then catches what is left.
 */
const MEASUREMENT_UNIT =
  /^\s*(cc|km|kms|kilometers?|kg|mm|cm|hp|l|lit(er|re)s?|%|days?|nights?|weeks?|months?|years?|hours?|hrs?|mins?|minutes?|people|persons?|pax|am|pm|o'clock)\b/i;

/**
 * A CALENDAR DATE IS NOT A PRICE ASK, AND WE WERE READING OURS AS ONE.
 *
 * `compileOpener` renders the rental start through `formatRentalDate`, which
 * produces "12 Aug" - a bare day number followed by a month name. A month name
 * is not a measurement unit, so the day number fell straight through the guard
 * above and into the band below.
 *
 * That was enough to silence the cheapest shop in the hunt. Greece, scooter,
 * start 12 Aug: shop B quotes EUR 18, `atSessionLow` is true, and the opener's
 * bare "12" satisfies `12 < 18 && 12 >= 9` - so `alreadyPushedAtFloor` returned
 * true, `lockedAtFloor` followed, and `bargain` never entered the legal set.
 * The single nudge the cheapest shop is entitled to was never sent. It is
 * currency-scoped: a day-of-month between 13 and 31 lands inside the band for
 * EUR/USD/GBP/AUD/MYR/SGD/ILS day-rates, while THB/IDR/PHP quotes are large
 * enough that a day number falls below the 0.5 floor - which is exactly why it
 * never showed up in testing.
 *
 * Both orders, because locales write both: "12 Aug" and "Aug 12".
 */
const MONTH_NAME =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
/** "12 Aug", and the ordinal forms a person types: "12th Aug", "12 of Aug". */
const DATE_AFTER = new RegExp(`^\\s*(?:st|nd|rd|th)?\\s*(?:of\\s+)?(?:${MONTH_NAME})\\b`, "i");
/** "Aug 12" - the month sits before the number instead. */
const DATE_BEFORE = new RegExp(`(?:${MONTH_NAME})\\s*$`, "i");
/** "12/08", "2026-08-12" - a separator on either side means a date field. */
const DATE_SEPARATOR_AFTER = /^\s?[/-]\s?\d/;
const DATE_SEPARATOR_BEFORE = /\d\s?[/-]\s?$/;

function alreadyPushedAtFloor(ctx: TurnContext): boolean {
  const quote = ctx.inbound.verified.pricePerDay ?? ctx.thread.digest.quotedPricePerDay;
  if (typeof quote !== "number" || quote <= 0) return false;
  const mine = ctx.thread.digest.lastOutbound ?? [];
  for (const msg of mine) {
    const text = String(msg);
    for (const m of text.matchAll(/\d[\d,.]*/g)) {
      const after = text.slice(m.index + m[0].length);
      const before = text.slice(0, m.index);
      if (MEASUREMENT_UNIT.test(after)) continue;
      // A date, in any of the shapes our own opener and a person's reply use.
      // Skipping it is the safe direction: a missed ask means we push once more
      // than we might have, while a false ask silences the shop entirely.
      if (DATE_AFTER.test(after) || DATE_BEFORE.test(before)) continue;
      if (DATE_SEPARATOR_AFTER.test(after) || DATE_SEPARATOR_BEFORE.test(before)) continue;
      const n = Number(m[0].replace(/[,.](?=\d{3}\b)/g, "").replace(/,/g, ""));
      if (!Number.isFinite(n)) continue;
      // Below the quote, but not absurdly below - an ask, not a house number.
      if (n < quote && n >= quote * 0.5) return true;
    }
  }
  return false;
}

// ---- fact helpers (read from the thread-derived digest; all deterministic) ---
function hasClosed(ctx: TurnContext): boolean {
  // STRUCTURED, NEVER PROSE (K5). This used to grep the durable notes for
  // /closed|goodbye|declined/ - and those notes are free text the model
  // wrote: "they have NOT declined" read as declined and muted the thread
  // forever. The verdict is DurableComprehension.closed, written from the
  // MOVE we took or the model's terminal stance; legacy rows migrate by
  // exact-equality in digest.comprehensionFromStored.
  return ctx.thread.digest.comprehension?.closed === true;
}
function dealComplete(ctx: TurnContext): boolean {
  return depositKnown(ctx) && fulfillmentKnown(ctx) && typeof ctx.thread.digest.quotedPricePerDay === "number";
}
// deposit/fulfillment now come from thread-facts (digest.depositKnown /
// .fulfillmentKnown), computed from the real message history. The old `facts`
// scan was permanently false (facts was always []), which is why the logistics
// close-out never triggered. Keep the facts scan as a belt-and-braces OR.
function depositKnown(ctx: TurnContext): boolean {
  // A HALF-READ DEPOSIT IS NOT A KNOWN ONE, WHICHEVER SOURCE SAYS IT IS. The
  // suppression has to sit here, above the OR, because the `facts` scan below
  // re-latched the subject from the model's own durable notes on every later
  // turn - the ambiguity had no way to reach it. See `unconfirmed`.
  if (unconfirmed(ctx, "deposit")) return false;
  // digest.depositKnown is already the full projection (model-read durable
  // comprehension + ledger claims + photo extraction). The prose scan that
  // used to OR in here read verdicts out of MODEL-WRITTEN notes - the exact
  // trap hasClosed() documents above.
  return ctx.thread.digest.depositKnown === true;
}
function fulfillmentKnown(ctx: TurnContext): boolean {
  return ctx.thread.digest.fulfillmentKnown === true;
}

/**
 * KNOWING HOW IS NOT KNOWING HOW MUCH.
 *
 * The handover probe retired the instant a shop's message contained the word
 * "deliver", so "yes, we can deliver to your hotel" closed the subject and the
 * FEE was never asked. The traveller compared per-day rates across shops,
 * picked one, and met the delivery charge at handover - the single number a
 * price-comparison app exists to surface before the choice, not after it.
 *
 * One follow-up is due when the shop has offered to bring it and has not
 * priced that: a number, or "free", either settles it. Bounded to ONE by the
 * stamped move history, because a shop that simply will not answer must not be
 * asked a third time - at that point the honest thing is to present the deal
 * with the fee marked unknown, which is what the traveller can act on.
 */
const HANDOVER_COST_ASKS_MAX = 1;

function handoverCostDue(ctx: TurnContext): boolean {
  const d = ctx.thread.digest;
  if (d.fulfillmentCostKnown === true) return false;
  if (d.deliveryOffered !== true) return false;
  const asked = d.handoverAsks ?? 0;
  // The first probe establishes the MODE; the follow-up prices it. Anything
  // past that is nagging a shop that has already been asked twice.
  return asked >= 1 && asked <= HANDOVER_COST_ASKS_MAX;
}
function dedupe(m: MoveKind[]): MoveKind[] {
  return Array.from(new Set(m));
}
