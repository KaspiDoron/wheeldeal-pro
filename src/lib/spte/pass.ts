// SPTE single pass - the turn's ONE LLM call. A snapshot-grounded, tool-free
// structured generation: the worker pre-fetches the whole context (blackboard +
// thread digest + verified extraction), injects it, and the model runs exactly
// once returning a TurnArtifact JSON. No ReAct tool loop, no multi-agent debate.
//
// Zero-cost: routed through the existing multi-provider failover (Groq ->
// Gemini Flash -> Cerebras -> OpenRouter). On malformed JSON: one retry, then a
// deterministic fallback artifact (never throws, never silent).

import { chat, chatDetailed, extractJson } from "../ai";
import type { MoveKind, ModelRoute, TurnArtifact, TurnContext, LeverageKind } from "./types";
import { coerceToLegal, passportCounterDue, atSessionLow, confirmSubjectFor, quoteOnTable } from "./policy";
import { moveGlossary, normalizeMove } from "./moves";
import { composePassportCounter } from "../negotiation/deposit-counter";
import { isRepetitive } from "../wa/similarity";
import { clampWaitMinutes } from "./wait";
import { nextGap } from "../offer-options";
import { planLeverage, leadCard, cheapestCheaperRival } from "../negotiation/leverage";
import { normalizeDigits } from "../integrity/translation";
import { citesPrice } from "../integrity/money-context";
import { beatRivalTarget } from "../negotiation/beat-rival";
import { computeRoundTarget } from "../graph/math";
import { askVariantDirective, askVariantFor } from "../negotiation/ask-variant";
import { disclosureBlock } from "../negotiation/traveller-disclosure";
import { describeActs } from "../wa/dialogue-acts";
// The ONE place the day plural is decided (owner report 5 #7: shops were told
// "for the 1 days" - a template tell on a cold first contact).
import { nDays } from "../copy/matrix";

/** Pick the model tier. Multimodal/high-stakes -> Tier M (Gemini Flash);
 *  everything else -> Tier F (the standard failover chain). Reflex (Tier R) is
 *  decided BEFORE this is called and never reaches an LLM. */
export function pickRoute(ctx: TurnContext): ModelRoute {
  const highStakes =
    ctx.legalMoves.includes("farewell") ||
    ctx.legalMoves.includes("closing-message") ||
    // A goodbye to a shop that brushed us off is exactly as final as a farewell
    // to one that declined, and a confirming question is the turn where getting
    // the wording wrong ("so you want my passport?") reads as an accusation.
    ctx.legalMoves.includes("graceful-close") ||
    ctx.legalMoves.includes("confirm") ||
    (ctx.legalMoves.includes("bargain") && (ctx.thread.digest.round ?? 0) === 0);
  return highStakes
    ? { tier: "M", reason: "high-stakes" }
    : { tier: "F", reason: "default" };
}

/**
 * THE NUMBER THE SPECIFIC-NUMBER ARM NAMES - the real concession ladder.
 *
 * Exported so it can be driven directly: it is the whole of the live engine's
 * bargaining arithmetic, and it used to be four lines buried inside a 400-line
 * prompt builder that no test could reach.
 */
export function askTargetFor(ctx: TurnContext): number | undefined {
  const quoteNow = quoteOnTable(ctx);
  if (typeof quoteNow !== "number" || quoteNow <= 0) return undefined;
  const rival = cheapestCheaperRival(ctx.session.rivals, quoteNow)?.pricePerDay;
  // THE PRINTED-LIST CLAMP, on the engine that answers shops.
  //
  // A posted price board is a firmer anchor than a spoken quote: a deep lowball
  // against a list the shop printed and hung on the wall insults them and kills
  // the deal ("that's OK, take it there"). The graph engine has clamped against
  // it since the overlay shipped - and it needs `fields.sheetPricePerDay`,
  // which SPTE re-derived per turn and never persisted, so the lever was
  // structurally absent from the only path a traveller is served by.
  const sheet = ctx.thread.digest.sheetPricePerDay;
  const sheetAnchor =
    typeof sheet === "number" && sheet > 0
      ? Math.round(sheet * (ctx.guards.sheetAnchor ?? 0.8))
      : 0;
  const effFloor = Math.max(ctx.guards.floorPerDay ?? 0, sheetAnchor) || undefined;
  return computeRoundTarget({
    quoted: quoteNow,
    floorPrice: effFloor,
    rivalPrice: rival,
    rounds: ctx.thread.digest.round ?? 0,
    // What we asked LAST time, measured off the wire and persisted by live.ts.
    // Absent on round one and on threads written before it existed, which is
    // exactly the "no previous ask" case the ladder handles.
    lastTarget: ctx.thread.digest.lastAskPerDay,
  });
}

function buildPrompt(ctx: TurnContext): { system: string; user: string } {
  const s = ctx.session;
  // RIVAL QUOTES WITHOUT RIVAL NAMES. The model never needs to know WHICH shop
  // quoted what - only that a real, live, cheaper quote exists in this search.
  // Handing it the names is how a name ends up in a message to a competitor;
  // not handing them over is the structural half of the disclosure rule.
  const rivalLines = s.rivals.length
    ? s.rivals.map((r) => `- another shop this search: ${r.pricePerDay} ${r.currency}/day`).join("\n")
    : "(no other shop has quoted yet)";
  const bench = s.benchmark
    ? `Grounded market rate: ${s.benchmark.pricePerDay} ${s.benchmark.currency}/day (verified from a real listing).`
    : "No verified market rate yet - do NOT invent one.";
  const prior = s.priors?.medianAchieved
    ? `Past travellers here landed around ${s.priors.medianAchieved} ${s.currency}/day (${s.priors.sampleSize} deals).`
    : "";
  const digest = ctx.thread.digest.facts.length
    ? ctx.thread.digest.facts.map((f) => `- ${f}`).join("\n")
    : "(nothing durable yet)";
  // THE ELISION IS STATED, NOT HIDDEN. `wa/history-window` marks a thread it
  // had to cut - "never silent" is its own rule - and that marker used to be
  // parsed away, leaving the composer a transcript with an invisible hole. A
  // model that believes it has the whole conversation will confidently re-ask
  // what the shop answered in the part it cannot see.
  const tail = ctx.tail.map((m) => `${m.dir === "in" ? "SHOP" : "YOU"}: ${m.text}`).join("\n");
  const tailBlock = ctx.tailElided
    ? `(this thread is long - some middle messages are not shown; the oldest and newest are)\n${tail}`
    : tail;

  const system =
    "You are one traveller haggling on WhatsApp for the cheapest real rental of a specific vehicle. " +
    "Act EXACTLY like a smart human bargainer: warm, brief, never robotic, one clear ask at a time. " +
    "You will output ONE JSON object and nothing else.\n" +
    "HARD RULES:\n" +
    "- Pick `move` ONLY from the LEGAL MOVES list. Nothing else is allowed.\n" +
    "- NEVER invent a competitor price or a market rate. Use ONLY the verified numbers given here. " +
    "If you cite a rival, cite one from the RIVAL OFFERS list verbatim.\n" +
    "- NEVER agree an exact pickup/delivery time - say the traveller will confirm the time directly.\n" +
    "- When asking about deposit or delivery/pickup, make it clear we are still deciding between a few shops - never imply a guaranteed booking.\n" +
    // The rail behind this refuses the draft outright, which costs a turn. Say
    // it here so the model rarely reaches it.
    "- NEVER commit on the traveller's behalf. You may ask anything and accept a price as GOOD, " +
    "but you may not say we'll take it, book it, reserve it, hold it, that you accept/agree/confirm, " +
    "or that you are on your way. The traveller books it themselves, later, in the app.\n" +
    "- If the shop has said its price is final/last more than once, DO NOT ask for a lower price again - accept warmly or move to logistics.\n" +
    "- LICENSE POLICY: if the shop asks whether you have a (international) driving license, answer firmly: " +
    "you have a valid international driving license for this vehicle category. If the shop asks to SEE or get a " +
    "photo/copy of the license, politely defer: you will share it once the rate and rental details are agreed - " +
    "never refuse outright, never send documents, and steer back to the price.\n" +
    "- Keep the message to 1-2 short sentences in simple, everyday English.\n" +
    // THE WORD THAT COST A REAL BOOKING.
    //
    // "Is that one of the bikes you have free?" meant vacant. The shop - which
    // had quoted 180 baht a minute earlier - read it as asking for a bike at no
    // charge and told us to try somewhere else. A regex rail catches the shapes
    // we have seen; only the model can avoid the ones we have not, so it is
    // taught the distinction rather than merely corrected afterwards.
    "- NEVER use the word \"free\" to mean available/vacant/in stock. To a shop " +
    "owner reading quickly, \"free\" means AT NO COST, and asking for a free " +
    "motorbike ends the conversation. Say available, spare, or in stock. " +
    "\"Free\" is only ever correct for something genuinely included at no charge " +
    "(free delivery, free helmet).\n" +
    (ctx.session.coaching && ctx.session.coaching.trim()
      ? `${ctx.session.coaching.trim()}\n`
      : "") +
    "OUTPUT JSON shape: { \"read\": {intent, priceMentioned?, declined?, wrongVehicle?, askedLocation?}, " +
    "\"think\": string (<=1 sentence, private), \"move\": string (from LEGAL MOVES), \"message\"?: string, " +
    "\"counterPricePerDay\"?: number, \"leverageUsed\": string[], \"digestPatch\": string[] (<=3 new facts), " +
    "\"waitMinutes\"?: number }.";

  // Duration is real leverage: a multi-day rental earns a longer-stay discount,
  // and the cheapest session rival is the strongest anchor to cite verbatim.
  const days = s.rfq.durationDays;
  const dg = ctx.thread.digest;
  const round = dg.round ?? 0;

  // ROUND-AWARE directive (ported from composeBargain): each push has a distinct
  // shape so four turns never read as one template. The model varies the words;
  // this varies the ANGLE.

  // FIRM state - the two-firms-stop rule made explicit to the model too.
  const firmNote =
    (dg.firmCount ?? 0) >= 2
      ? `The shop has said this is their LAST/BEST price ${dg.firmCount} times. STOP asking for a lower price - do not haggle again. Instead move on to logistics (deposit, delivery/pickup) or accept warmly.\n`
      : (dg.firmCount ?? 0) === 1
        ? `The shop called this their best price once. Only push again if you have real leverage (a cheaper rival or a price well above market); otherwise switch to logistics.\n`
        : "";

  // QUESTION obligation - answer what the shop asked, first.
  //
  // Now says WHAT was asked. Told only "the shop asked you something" on the
  // strength of a question mark, the model opened with filler praise ("Good
  // question!") for turns that contained no question at all.
  const acts = ctx.inbound.verified.acts;
  const askedSomething =
    (acts ? acts.ask !== "none" : ctx.inbound.verified.askedQuestion) ||
    ctx.inbound.verified.askedLocation;
  const questionNote = askedSomething
    ? `The shop ASKED YOU about ${acts && acts.ask !== "none" ? acts.ask.replace(/-/g, " ") : "something"} in their last message. Your reply MUST answer that first, in a natural way, before anything else.\n`
    : `The shop did NOT ask you anything. Do not thank them for a question and do not open with filler - acknowledge what they actually sent, then make your move.\n`;

  // ONE-SHOT PASSPORT-DEPOSIT COUNTER: when the shop's stated terms demand the
  // original passport with no cash route (and we have never asked), the legal
  // deposit-probe IS the polite alternative ask - coach the composed message
  // to match the deterministic template's strategy.
  const depositCounterNote = passportCounterDue(ctx)
    ? "DEPOSIT TERMS: the shop requires leaving the ORIGINAL passport, with no cash option offered. If you pick deposit-probe, make ONE ultra-polite counter: say we'd prefer a cash deposit plus a PHOTO of the passport, framed as a preference (never a refusal, never a safety lecture). If they decline, we accept their terms graciously - this is asked once and never again.\n"
    : "";

  // ANTI-REPETITION - the real fix for "same sentence every turn". The model
  // never saw its own prior sends; now it does, with a hard rule.
  const priorSends = (dg.lastOutbound ?? []).filter(Boolean);
  const repetitionNote = priorSends.length
    ? `YOUR PREVIOUS MESSAGES in this chat (NEVER reuse their sentence structure or a lever you already played - a repeated line reads as a bot):\n${priorSends
        .map((m) => `  • ${m}`)
        .join("\n")}\n`
    : "";

  // THE LEDGER, in the model's own words. The legal move set already makes a
  // repeated fact-question impossible (spte/policy), but a move that IS legal
  // can still carry a redundant question inside its text - "and what's the
  // deposit?" tacked onto a bargain the shop already answered. Stating what is
  // established and what is still outstanding removes the reason to ask.
  // WHAT WE MAY SAY ABOUT THE TRAVELLER. Empty on an ordinary price turn; it
  // appears only when the shop asked something personal, which is exactly when
  // an agent writing in someone else's voice is most likely to invent a fact.
  const aboutYouBlock = (() => {
    // The town is the only place fact we may state, and only when the
    // traveller has already consented to sharing it.
    const b = disclosureBlock({ rfq: s.rfq, town: ctx.share?.addressText }, ctx.inbound.text || "");
    return b ? `${b}\n\n` : "";
  })();

  const ledger = dg.ledger;
  const ledgerBlock = ledger
    ? [
        ledger.known.length
          ? `ALREADY ESTABLISHED by this shop (never ask again): ${ledger.known.join(", ")}.`
          : "",
        ledger.outstanding.length
          ? `ALREADY ASKED and still unanswered (do NOT repeat the question): ${ledger.outstanding.join(", ")}.`
          : "",
        ledger.owed.length
          ? `STILL OWED to the traveller before this thread can close: ${ledger.owed.join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join("\n") + "\n"
    : "";

  // THE MENU. When the shop has offered a choice, the turn's job is to make the
  // tiers comparable - what separates them and a photo of each - and the gaps
  // below say exactly what is still unknown, so we never re-ask what they told
  // us. Stated as the situation, not as a script: the model writes the question.
  const options = dg.options ?? [];
  const menuBlock = options.length
    ? `THIS SHOP'S OPTIONS (they offered a CHOICE - do NOT collapse it to one price):\n` +
      options
        .map(
          (o) =>
            `- ${o.label}: ${o.pricePerDay} ${o.currency ?? s.currency}/day` +
            (o.mileageKm ? `, ${o.mileageKm} km` : "") +
            (o.gaps.length ? ` [still unknown: ${o.gaps.join(", ")}]` : " [fully known]")
        )
        .join("\n") +
      `\n`
    : "";
  // THE VEHICLE GATE'S FINDING, handed to the model as a fact rather than left
  // for it to re-derive. Two live threads ended with a 110cc on the traveller's
  // screen as BEST PRICE because the model was asked to infer what a nameplate
  // is; here it is simply told what is unresolved and what to ask.
  const vehiclePlay = ctx.legalMoves.includes("confirm-vehicle")
    ? `YOUR JOB THIS TURN: the price on the table cannot be tied to the vehicle the traveller declared - ${
        ctx.inbound.verified.vehicleQuestion || "confirm exactly which vehicle it is"
      } Ask that, warmly, in ONE short message. Do NOT bargain, do NOT confirm a deal and do NOT repeat the price as if it were theirs: a number for the wrong vehicle is worse than no number, because the traveller's licence covers only what they searched for.\n`
    : "";
  // WHEN YOU ARE NOT SURE, ASK - AS A QUESTION - AND WAIT (the owner's rule).
  //
  // The engine has already decided WHICH fact is unsettled; this hands the
  // model the reading it would otherwise have written down and the question
  // that settles it, and forbids the two things an unsure agent must not do:
  // guess, or carry on as though it had understood.
  const doubt = confirmSubjectFor(ctx);
  const confirmPlay =
    ctx.legalMoves.includes("confirm") && doubt
      ? `YOUR JOB THIS TURN: you are NOT certain you understood what they said about the ${doubt.subject}. ` +
        `What you would otherwise have assumed: "${doubt.reading}". Do NOT assume it. Put it back to ` +
        `them as ONE short, warm question in the traveller's own voice - something very close to: ` +
        `"${doubt.question}" - and nothing else. No price talk, no second question, no moving on. ` +
        `Getting this wrong is worse than asking: a misread deposit is a passport handed over that ` +
        `never had to be.\n`
      : "";

  // WHERE THIS SHOP STANDS, in the model's own reading rather than ours. Only
  // ever appears when the comprehension pass was sure enough to act on it.
  const stancePlay =
    ctx.legalMoves.includes("graceful-close")
      ? `THIS SHOP IS DONE WITH US. They pointed us elsewhere or bowed out${
          ctx.inbound.verified.stanceQuote
            ? ` - their words: "${ctx.inbound.verified.stanceQuote}"`
            : ""
        }. Thank them warmly for their time in ONE short line and stop. Do NOT ask for a price, do ` +
        `NOT ask anything, do NOT try to change their mind, do NOT mention other shops.\n`
      : "";

  // TONE, FINALLY READ BY SOMETHING. It has been computed on every turn since
  // the engine shipped and consumed by nothing on this path.
  const tonePlay =
    dg.tone === "reluctant"
      ? "THEIR TONE: this shop has sounded reluctant or short with us. Be extra brief and extra warm, ask for less, and never push twice in one message.\n"
      : dg.tone === "friendly"
        ? "THEIR TONE: this shop has been friendly. Match it - a little warmth here is worth more than a clever argument.\n"
        : "";

  const optionPlay = ctx.legalMoves.includes("option-probe")
    ? `YOUR JOB THIS TURN: the traveller cannot choose between these yet. In ONE short message, ask what actually separates them - ${
        nextGap(options) === "mileage"
          ? "how old each one is and roughly how many km"
          : nextGap(options) === "photo"
            ? "for a quick photo of each"
            : nextGap(options) === "condition"
              ? "which is the newer one"
              : "the deposit for each"
      } - and ask for a photo of each if you have not already. Do NOT bargain yet: haggling a price the traveller has not picked wastes the one discount this shop will give.\n`
    : "";

  // THE ONLY LOCATION THE MODEL MAY WRITE. Everything else - a guessed area, a
  // coordinate, a maps link we did not build - is a privacy incident, so it is
  // stated as a verbatim fact rather than left to the model's judgement.
  const locationBlock = ctx.legalMoves.includes("pickup-location")
    ? `THE TRAVELLER'S LOCATION (server-verified, the ONLY one you may write): ${ctx.share?.addressText}${
        ctx.share?.mapsLink
          ? `\nAPPROVED MAPS LINK - reproduce it EXACTLY, character for character: ${ctx.share.mapsLink}`
          : `\nThere is NO approved maps link. Never invent one and never write coordinates.`
      }\n`
    : "";

  // THE LEVERAGE PLAN, RANKED BY EVIDENCE (lib/negotiation/leverage).
  //
  // The round directive above still shapes the ANGLE, but it no longer decides
  // WHICH card to play. It used to: "use the N-day rental as your reason" was
  // hard-coded onto the first push, so the strongest card in the negotiation -
  // another real shop in this same search quoting less for the same vehicle -
  // was played late or never, because many threads never got a later push.
  // Duration is the weakest lever we have; a live competing quote is the
  // strongest. Now the engine computes the order from the evidence and the model
  // leads with whatever actually is strongest.
  //
  // AND IT CARRIES NO SHOP NAME. The line this replaces interpolated
  // `${cheaperRival.shop}` and ordered the model to name it, which sent the
  // cheaper shop's identity to its direct competitor from the traveller's own
  // number. The price and the vehicle are the leverage; the name is not ours to
  // give away. spte/rails enforces it on the finished draft as well.
  const quoteNow = quoteOnTable(ctx);
  // Which arm of the owner's phrasing A/B this thread is in. Read here, before
  // the leverage plan, because the rival card must not name a counter-price in
  // the open-ended arm - two halves of one prompt contradicting each other is
  // not an experiment, it is noise in both arms.
  const askVariant = askVariantFor(ctx.thread.threadKey);
  const plan = ctx.legalMoves.includes("bargain")
    ? planLeverage({
        rivals: s.rivals,
        quotePerDay: quoteNow,
        currency: s.currency,
        durationDays: days,
        round,
        vehicleLabel: vehicleLine(ctx),
        // BEAT, NEVER MATCH needs a number, and a number needs a floor: the
        // rival card names a concrete target strictly below the rival, and the
        // floor is what stops that target becoming an insulting lowball.
        floorPerDay: ctx.guards.floorPerDay,
        // A rival per-day we DIVIDED out of their multi-day package is not a
        // quote for these days. The card says so rather than welding our
        // duration onto their arithmetic.
        rivalDerivedFromDays: s.rivals[0]?.derivedFromDays,
        // BEAT-NEVER-MATCH holds in both arms; only whether we NAME the number
        // differs (negotiation/ask-variant).
        nameATarget: askVariant !== "open-ended-below",
        // The same fact the policy uses to retire `bargain`, read from the
        // same place. Two modules disagreeing about who the cheapest shop is
        // would be worse than either answer.
        isSessionLow: atSessionLow(ctx),
      })
    : [];
  const lead = leadCard(plan);
  // WE WERE HANDING BACK THE CARD leverage.ts HAD JUST TAKEN AWAY.
  //
  // planLeverage returns an EMPTY list when this shop is the session's cheapest
  // and no round has been played, and says why at length: being the floor is
  // "a position with no argument in it", so returning nothing "lets the caller
  // do the right thing (terms, not price) instead of the least-wrong thing".
  //
  // Both fallbacks below key on `!lead` - which is PRECISELY the state that
  // suppression creates. So the prompt turned around and told the model to
  // "give the N-day rental as your reason" and that "Duration is your lever
  // this first push": the exact message leverage.ts exists to prevent, argued
  // against a floor we set ourselves. One nudge at the session low is still
  // legal by design; what it must not be is a price argument.
  const atLow = atSessionLow(ctx);
  const rivalLeverage = lead
    ? `LEVERAGE, STRONGEST FIRST - lead with the first one:\n` +
      plan.map((c, i) => `  ${i + 1}. ${c.line}`).join("\n") +
      `\nNEVER write the name of another rental shop in a message. Not the one that quoted less, not any other - say "a better offer" and give the price and the vehicle.\n`
    : "";
  // THE ANGLE IS A SHAPE; THE REASON COMES FROM THE EVIDENCE.
  //
  // This used to hard-code "use the {days}-day rental as your reason" on the
  // first push - the duration lever, always, no matter what the session knew.
  // So when a rival shop had already quoted less for the same vehicle, the
  // ranked plan put that card first and the prompt simultaneously instructed
  // the model to argue from duration instead. The strongest card in the deck
  // was computed, printed, and then talked over. Now the angle describes only
  // the SHAPE of the push and defers the reason to `lead` whenever one exists,
  // which is exactly what leverage.ts was built to decide.
  const roundPlay = ctx.legalMoves.includes("bargain")
    ? round <= 0
      ? atLow
        ? `BARGAIN ANGLE (first push, and they are ALREADY the best price you have): do NOT argue the number - you have nothing to argue with, and saying it is high against your own floor reads as haggling for its own sake. Warmly ask for something thrown in instead - a helmet, fuel, or free delivery - or a small round-number gesture if they would rather. Vary the exact wording.\n`
        : `BARGAIN ANGLE (first push): warmly say the quote is a bit high for you, give ${lead ? "the leverage above as your reason" : `the ${days}-day rental as your reason`}, and ask for a friendly better daily rate. Vary the exact wording.\n`
      : round === 1
        ? `BARGAIN ANGLE (second push): DO NOT reuse the reason you already gave - switch lever. ${lead ? "Use the next card in the leverage list." : "Ask for a small round-number discount, or a free extra (helmet/fuel/delivery), or mention you're ready to book right now."}\n`
        : `BARGAIN ANGLE (final gentle nudge): one last soft ask, then you will accept. Use a DIFFERENT phrasing and lever from your earlier messages.\n`
    : "";

  // THE PHRASING A/B (owner report 5 #2, second half).
  //
  // "Measure the times of successful bargain that we suggested a lower price
  // (we gave them a specific number) Vs the times we didn't give a specific
  // price and just asked for a lower price than X - in both ways we write them
  // the high price we already have 'X'."
  //
  // Both arms state the shop's own quote; only our counter differs. Assigned
  // PER THREAD (negotiation/ask-variant), so one traveller runs both arms in
  // parallel against comparable shops instead of a whole hunt landing in one.
  // Recorded on the turn telemetry and attributed by learnFromReply one turn
  // later, which is where the concession is actually visible.
  // The number the specific-number arm names. Strictly below a cheaper rival
  // when we hold one (BEAT, NEVER MATCH - the same helper the rival card uses,
  // so the two can never name different figures), otherwise the ordinary
  // floor-clamped cut.
  //
  // THE REAL LADDER, NOT A FLAT PERCENTAGE. The no-rival arm was
  // `Math.round(quoteNow * 0.85)` - 15% off whatever the shop had just said,
  // recomputed from scratch on every turn. Three consequences, all of them the
  // opposite of how a human bargains:
  //
  //   - a shop that holds firm at 300 gets asked for 255, then 255, then 255.
  //     Identical numbers read as a bot, and offer the shop nothing to
  //     reciprocate.
  //   - there is no concession. A negotiation where one side never moves is not
  //     a negotiation, and it is exactly what makes shops stop replying.
  //   - the number is ugly. 255 is not a figure a person says out loud;
  //     `niceRound` exists for precisely this and was never reached.
  //
  // `graph/math.computeRoundTarget` is the ladder the failover engine has always
  // used: it opens near the floor, concedes upward across rounds, never re-asks
  // BELOW an earlier ask, clamps strictly below a cited rival (beat, never
  // match - it calls the same `beatRivalTarget` this branch used to call
  // directly), and finishes through `niceRound`/`niceRoundBelow`. It is pure and
  // was already reachable from here; the live engine simply never called it.
  const askTarget = askTargetFor(ctx);
  const askShape = ctx.legalMoves.includes("bargain")
    ? `${askVariantDirective(askVariant, {
        quotePerDay: quoteNow,
        currency: s.currency,
        target: askTarget,
      })}\n`
    : "";

  // THE BOARD IS A FACT ABOUT THE NEGOTIATION, so the composer is told about
  // it in words as well as clamped by it in arithmetic. Same line the failover
  // engine has always carried (graph/nodes.ts) and the primary never did.
  const sheetPlay =
    typeof dg.sheetPricePerDay === "number" && dg.sheetPricePerDay > 0 && ctx.legalMoves.includes("bargain")
      ? `THEY POSTED A PRICE LIST showing ${dg.sheetPricePerDay} ${s.currency}/day. Acknowledge their printed price warmly and keep your ask credible against it - a deep lowball against a board they printed insults the shop and kills the deal.\n`
      : "";
  // What the photo showed, carried across turns (mileage, condition, the tiers
  // on the board). Durable now, so a scratch noticed on turn one is still
  // honest leverage on turn four.
  const mediaPlay = dg.mediaSummary ? `THEIR PHOTO SHOWED: ${dg.mediaSummary}\n` : "";

  // Kept as its own line only when there is nothing stronger to lead with.
  const durationLeverage =
    !lead && !atLow && round <= 0 && days >= 3 && ctx.legalMoves.includes("bargain")
      ? `Duration is your lever this first push: ${nDays(days)} is a long rental.\n`
      : "";

  const user =
    `VEHICLE WANTED: ${vehicleLine(ctx)} for ${s.rfq.durationDays} days.\n` +
    `${bench}\n${prior}\n` +
    `RIVAL OFFERS (other shops, this search):\n${rivalLines}\n\n` +
    // WHERE THE REST OF THE HUNT STANDS. The block above is the four quotes we
    // are ALLOWED TO CITE; this one is everything else the traveller knows -
    // who said no, who has none left, who has not answered. A human negotiator
    // holds that in their head and it changes the tactic completely: four live
    // rivals means push hard, and "every other shop is out" means secure this
    // one warmly. Anonymised and bounded by negotiation/session-brief; "" when
    // this is the only shop in the hunt, so a heading never sits over no rows.
    (s.brief ? `${s.brief}\n` : "") +
    menuBlock +
    roundPlay +
    askShape +
    sheetPlay +
    mediaPlay +
    firmNote +
    depositCounterNote +
    questionNote +
    stancePlay +
    confirmPlay +
    tonePlay +
    vehiclePlay +
    optionPlay +
    locationBlock +
    durationLeverage +
    rivalLeverage +
    repetitionNote +
    ledgerBlock +
    aboutYouBlock +
    `THIS SHOP so far:\n${digest}\n\n` +
    `RECENT MESSAGES:\n${tailBlock || "(none yet)"}\n\n` +
    `SHOP JUST SAID: ${ctx.inbound.text || "(nothing - a scheduled follow-up)"}\n` +
    // THEIR WORDS, AND WHAT THEY MEAN. The translation is computed on the
    // critical path for every non-English inbound, stamped on the row and
    // threaded through the engine - and the model writing the reply never saw
    // it. It negotiated against raw local-language text while the English sat
    // one field away. Rendered as a SECOND line rather than a replacement: the
    // shop's own numbers and model names are in their message verbatim, and a
    // translation is the only place a digit can quietly change.
    (ctx.inbound.english && ctx.inbound.english !== ctx.inbound.text
      ? `IN ENGLISH: ${ctx.inbound.english}\n`
      : "") +
    // WHAT THEY SENT, not only what they typed. `imageSummary` has always been
    // computed and never reached the model, so a shop that answered with four
    // price boards looked to the LLM like a shop that said nothing.
    (ctx.inbound.verified.acts
      ? `SHOP'S TURN: ${describeActs(ctx.inbound.verified.acts)}\n`
      : "") +
    (ctx.inbound.verified.imageSummary
      ? `FROM THEIR PHOTO we read: ${ctx.inbound.verified.imageSummary}\n`
      : "") +
    // OUR READER FAILED, THEIR PHOTO IS FINE. Without this the model has an
    // image it was never shown and no way to know it, so it composes as though
    // it had looked - "which line is mine?" at a board nobody read.
    (ctx.inbound.verified.imageUnread
      ? "THEIR PHOTO COULD NOT BE OPENED on our side - we have NOT seen it. Never " +
        "imply you read it, never describe it, never ask which line is yours. " +
        "Thank them and ask for the number in plain text.\n"
      : "") +
    (ctx.inbound.verified.found && ctx.inbound.verified.pricePerDay
      ? `VERIFIED: the shop's live quote is ${ctx.inbound.verified.pricePerDay} ${ctx.inbound.verified.currency ?? s.currency}/day.\n`
      : // THE QUOTE THEY ALREADY GAVE US STANDS. Without this line the model saw
        // a thread with no number every time a shop replied without restating
        // one ("ok for you?"), and asked for the price it had already been told.
        typeof quoteNow === "number"
        ? `VERIFIED: this shop's standing quote is ${quoteNow} ${s.currency}/day (from an earlier message in this chat - they did not repeat it just now, and you must NOT ask for it again).\n`
        : "") +
    (ctx.guards.floorPerDay ? `Do not ask below ${ctx.guards.floorPerDay}/day.\n` : "") +
    // WITH THEIR MEANINGS. A bare token list left the model to infer what each
    // word meant, and on Ko Tao it inferred that `close` meant close the deal.
    // A closed vocabulary is closed for the code, not for the reader.
    `LEGAL MOVES (pick exactly one):\n${moveGlossary(ctx.legalMoves)}\n` +
    `Choose the best move and write the message.`;

  return { system, user };
}

/** "a", "a and b", "a, b and c" - so an acknowledgment reads like a person. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function vehicleLine(ctx: TurnContext): string {
  const r = ctx.session.rfq;
  if (r.vehicleClass === "car") return `${r.carType ?? "economy"} car`;
  const cc = r.engineSizeCc ? ` ${r.engineSizeCc}cc` : "";
  const tr = r.transmission !== "any" ? `${r.transmission} ` : "";
  return `${tr}${r.vehicleClass}${cc}`;
}

/** The safe templated message for a move, or undefined when a template would
 *  have to invent facts (present/closing need real data; pickup-location needs
 *  the consented stay resolver). */
export function templateFor(ctx: TurnContext, move: MoveKind): string | undefined {
  const v = ctx.inbound.verified;
  const days = ctx.session.rfq.durationDays;
  switch (move) {
    case "bargain": {
      // LEVERAGE-BLIND NO MORE. This template is what actually goes out on
      // EVERY provider-failure and rail-rejection turn - the exact live weak
      // message the owner screenshotted ("any chance you can do a bit
      // better?") sent while a cheaper sibling quote sat in ctx.session. The
      // rival cite and the beat target are pure arithmetic the prompt builder
      // already computes; the fallback now plays the same hand. Never the
      // rival's NAME (the disclosure rail's rule) - the price and the vehicle
      // are the leverage.
      const quoteNow = quoteOnTable(ctx);
      const rival = cheapestCheaperRival(ctx.session.rivals, quoteNow);
      if (rival && typeof quoteNow === "number" && quoteNow > 0) {
        const cur = rival.currency ?? ctx.session.currency ?? "";
        const target = beatRivalTarget({
          rivalPricePerDay: rival.pricePerDay,
          quotePerDay: quoteNow,
          floorPerDay: ctx.guards.floorPerDay,
        });
        const money = (n: number) => `${cur ? `${cur} ` : ""}${n}`;
        return target > 0 && target < rival.pricePerDay
          ? `Thanks! Another shop offered ${money(rival.pricePerDay)}/day for the same ${ctx.session.rfq.vehicleClass} - could you do ${money(target)}/day for ${nDays(days)}?`
          : `Thanks! Another shop offered ${money(rival.pricePerDay)}/day for the same ${ctx.session.rfq.vehicleClass} - could you go lower than that for ${nDays(days)}?`;
      }
      return v.pricePerDay
        ? `Thanks! Any chance you can do a bit better for ${nDays(days)}?`
        : `Could you share your best price for ${nDays(days)}?`;
    }
    case "confirm-vehicle":
      // The gate already phrased the question from the traveller's own declared
      // spec; the fallback simply sends it. Never invents a price.
      return (
        ctx.inbound.verified.vehicleQuestion ||
        `Quick check - is that for the exact ${
          ctx.session.rfq.engineSizeCc ? `${ctx.session.rfq.engineSizeCc}cc ` : ""
        }${ctx.session.rfq.vehicleClass} I asked about? Want to be sure before we go further 🙂`
      );
    case "option-probe": {
      // Names the tiers we already read, so even the LLM-down path proves we
      // were listening and asks the ONE thing still missing.
      const opts = ctx.thread.digest.options ?? [];
      const gap = nextGap(opts);
      const list = opts
        .slice(0, 3)
        .map((o) => `${o.pricePerDay}`)
        .join(" and ");
      const ask =
        gap === "photo"
          ? "could you send a quick photo of each"
          : gap === "mileage"
            ? "how old are they and roughly how many km"
            : gap === "deposit"
              ? "what's the deposit for each"
              : "which one is the newer one";
      return list
        ? `Thanks! You mentioned ${list} - ${ask}? Want to make sure I pick the right one 🙂`
        : `Thanks! Which options do you have, and what's the difference between them?`;
    }
    case "clarify":
      // NEVER ask a shop to retype a board we can read. If a photo came in, say
      // what we got from it and ask a yes/no - that answer is what verifies the
      // read. Asking "send it as text" after four price boards is what made the
      // app look like it had not looked at them at all.
      // ...UNLESS WE NEVER OPENED IT. "Which line is the one for me?" claims a
      // read that did not happen, and the shop cannot act on it. This is the one
      // case where asking for text IS the honest move.
      if (v.hadImage && v.imageUnread) {
        return `Thanks for sending that! It didn't open properly on my phone - could you type the price per day for ${nDays(days)}? 🙂`;
      }
      if (v.hadImage) {
        return v.pricePerDay
          ? `Thanks for the price list! I read ${v.pricePerDay}${v.currency ? " " + v.currency : ""}/day for the ${nDays(days)} - is that right for me? 🙂`
          : `Thanks for the price list! Which line is the one for me, for ${nDays(days)}? 🙂`;
      }
      return `Could you share your best price per day for the ${nDays(days)}? 🙂`;
    case "pickup-location": {
      // The address comes from the disclosure gate, never from the shop's
      // message or the model. No verified stay = not a legal move at all
      // (policy.ts), so reaching here means we have one.
      const where = ctx.share?.addressText;
      if (!where) return undefined;
      const pin = ctx.share?.mapsLink ? ` (${ctx.share.mapsLink})` : "";
      return `I'm staying at ${where}${pin} - can you deliver there, and when would suit you?`;
    }
    case "redirect-close":
      return `No worries, thanks for letting me know - have a great day!`;
    case "graceful-close":
      // WARM, SHORT, AND WITHOUT A SINGLE QUESTION IN IT. This is the move that
      // exists because the ladder's no-price default sent "could you let me
      // know your daily rate?" to a shop that had just told us to try
      // elsewhere; a template with a question mark in it would rebuild the bug.
      return `No problem at all - thanks for your time and have a great day! 🙏`;
    case "confirm": {
      // THE MODEL ALREADY PHRASED IT. The comprehension pass returns the
      // confirming question in the traveller's voice precisely so that the
      // LLM-down path can still send something a person would write, instead of
      // silently latching the reading it was unsure of.
      const d = confirmSubjectFor(ctx);
      if (d?.question?.trim()) return d.question.trim();
      return undefined;
    }
    case "farewell":
      return `All good, thank you so much for your time!`;
    case "answer":
      // NEVER-SILENT (the live "agent never replied to my question" failure):
      // license asks get the exact policy lines; any other question gets an
      // honest, safe redirect to the one thing we always want - the daily rate.
      if (v.askedLicensePhoto)
        return `Sure - I'll share a photo of my license once we finalize the rate and rental details 👍 What's your best price per day?`;
      if (v.askedLicense)
        return `Yes, I have a valid international driving license for this. What would your best price per day be?`;
      // ACKNOWLEDGE WHAT THEY ACTUALLY DID.
      //
      // This branch used to open "Good question!" unconditionally and then ask
      // for a price - so a shop that had just sent its price board, its hours
      // and its deposit terms got thanked for a question it never asked, and
      // asked for the number it had already given. Both halves are now
      // conditioned on the turn's acts and on what we already read.
      const shared = v.acts?.shared ?? [];
      const got: string[] = [];
      if (v.pricePerDay || v.sheetPricePerDay) got.push("the price");
      else if (shared.includes("price-board")) got.push("the price list");
      if (shared.includes("deposit")) got.push("the deposit info");
      if (shared.includes("hours")) got.push("your hours");
      const thanks = got.length ? `Thanks - got ${listOf(got)}.` : "";
      // Never re-ask for a price we can already see.
      const known = v.pricePerDay ?? v.sheetPricePerDay;
      if (known) {
        return `${thanks} Just to confirm - is ${known}${v.currency ? " " + v.currency : ""}/day the best you can do for ${nDays(days)}? 🙂`.trim();
      }
      // ANSWER THE QUESTION THEY ASKED.
      //
      // This move is chosen BECAUSE the shop asked something, and the fallback
      // then asked for a price - so on a provider outage the agent's reply to
      // "how many days?" was "what's your best price per day?". A human would
      // answer first. The two questions shops actually ask that we can answer
      // from the RFQ without a model are the dates and the vehicle, so answer
      // those and put the price ask second, where it belongs.
      const asked = v.acts?.ask;
      if (asked === "vehicle-choice" || asked === "substantive") {
        // The two things a shop asks that we can answer from the RFQ without a
        // model are WHICH BIKE and HOW LONG - and between them they cover most
        // real questions ("what bike do you want?", "how many days?", "when do
        // you need it?"). Stating both answers either, and reads naturally
        // whichever was meant.
        const rfq = ctx.session.rfq;
        const cc = rfq.engineSizeCc;
        const tx = rfq.transmission && rfq.transmission !== "any" ? ` ${rfq.transmission}` : "";
        const spec = `${cc ? `${cc}cc ` : ""}${rfq.vehicleClass}${tx}`.trim();
        return `${thanks} I'm after a ${spec} for ${nDays(days)}. What would your best price per day be?`.trim();
      }
      return `${thanks} What would your best price per day be for ${nDays(days)}?`.trim();
    case "deposit-probe":
      // THE ONE-SHOT PASSPORT COUNTER: when the shop's stated terms demand the
      // original passport with no cash route, this probe IS the polite
      // alternative ask (seeded wording, one attempt ever - see
      // negotiation/deposit-counter). Otherwise it is the ordinary terms probe.
      if (passportCounterDue(ctx)) return composePassportCounter(ctx.thread.threadKey);
      // Non-commitment guardrail (issue 5): learn the terms while making clear
      // we are still comparing shops - never imply a guaranteed booking.
      return `Thanks! We're finalizing our pick between a few shops today - could you let me know your deposit? Cash amount or passport?`;
    case "restock-probe": {
      // OUT OF STOCK IS NORMAL. No disappointment, no pressure, no goodbye -
      // just the one question worth asking. Seeded per thread so shops do not
      // all receive the same sentence, and stable for golden replays.
      const FAMILY = [
        `No worries at all, thanks for letting me know! Any idea when you'll have one available again?`,
        `Ah okay, thanks for telling me! When do you expect to have one back?`,
        `That's alright - thanks for the honesty! Do you know when you'll have one back in stock?`,
      ];
      let h = 5381;
      const seed = ctx.thread.threadKey;
      for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
      return FAMILY[Math.abs(h) % FAMILY.length];
    }
    case "fulfillment-probe":
      // TWO DIFFERENT QUESTIONS WEAR THIS ONE MOVE.
      //
      // The first asks HOW the traveller gets the vehicle. The second - legal
      // only once the shop has offered to bring it and has not said what that
      // costs - asks HOW MUCH, and offers collection as the alternative in the
      // same breath, so the shop can answer with either number. A single
      // template here would have re-sent "do you deliver?" to a shop that had
      // just said it delivers, which is the repeat this move is gated against.
      return ctx.thread.digest.deliveryOffered === true &&
        ctx.thread.digest.fulfillmentCostKnown !== true
        ? `Great, thanks! Is there a charge for delivery to the hotel - and would it be cheaper if I collect it from the shop instead?`
        : `One more thing while we compare options - do you deliver to the hotel, or is it pickup at your shop?`;
    case "momentum":
      // W4.7: NO GREETING. `momentum` is by definition a re-opening of a thread
      // we are already in, so "Hi again!" was a second greeting by construction
      // - and wa-guard's variance pass then matched the leading "Hi " and
      // substituted a whole greeting for it, shipping "Hey there! again!" on
      // every single nudge. The nudge is warmer without either.
      return `Just checking in - any chance on that better rate for ${nDays(days)}?`;
    case "verify-recap": {
      // STEP 7 - DETERMINISTIC BY DESIGN, grounded by construction: every
      // number is the digest's own standing quote (verified extraction wrote
      // it), never composed. A subject the thread still does not know is asked
      // INSIDE the recap - the one legitimate re-ask, bundled into the
      // confirmation, which is exactly what the priced-dead-end rescue needs.
      const q = quoteOnTable(ctx);
      if (typeof q !== "number" || q <= 0) return undefined; // no price, no recap
      const cur = v.currency ?? ctx.session.currency ?? "";
      const dg = ctx.thread.digest;
      const kind = dg.comprehension?.depositKind;
      const depositLine =
        kind === "none"
          ? "no deposit"
          : kind === "cash"
            ? "the cash deposit you mentioned"
            : kind === "document"
              ? "passport as deposit"
              : kind === "cash-or-document"
                ? "cash or passport as deposit"
                : kind === "card"
                  ? "card deposit"
                  : undefined;
      const mode = dg.comprehension?.handoverMode;
      const handoverLine =
        mode === "delivery" || mode === "both" || dg.deliveryOffered === true
          ? "delivered to where I'm staying"
          : mode === "pickup"
            ? "you pick me up"
            : dg.fulfillmentKnown
              ? "I collect it at your shop"
              : undefined;
      const known = [`${q}${cur ? " " + cur : ""}/day for ${nDays(days)}`, depositLine, handoverLine]
        .filter(Boolean)
        .join(", ");
      const asks: string[] = [];
      if (!depositLine) asks.push("what deposit you need");
      if (!handoverLine) asks.push("whether you deliver or I collect it");
      const askTail = asks.length ? ` And could you also confirm ${listOf(asks)}?` : "";
      return `Perfect - just to confirm before we lock it in: ${known}. All correct?${askTail}`;
    }
    default:
      return undefined; // present / closing-message / silent
  }
}

/** A deterministic, never-silent fallback when the LLM is unavailable or its
 *  output is unusable. Walks the LEGAL ladder and takes the FIRST move that has
 *  a safe template - so a turn that owes the shop a reply never goes silent
 *  just because the top-priority move needed composed content. */
/**
 * Did this deterministic message actually play the rival card?
 *
 * `leverageUsed` was hard-coded to `[]` on every fallback, which made the one
 * path that DETERMINISTICALLY cites a rival - the bargain template above -
 * report that it had not. That is the half of owner report 8's B1 telemetry fix
 * that never landed, and it biases the owner's leverage KPI downward exactly
 * where the leverage is most reliable.
 *
 * Derived from the composed TEXT rather than asserted, for the same reason
 * `citedRival` is derived from the wire: a self-report is not evidence.
 */
export function fallbackLeverage(
  ctx: TurnContext,
  move: MoveKind,
  message: string | undefined
): LeverageKind[] {
  if (move !== "bargain" || !message) return [];
  const rival = cheapestCheaperRival(ctx.session.rivals, quoteOnTable(ctx));
  if (!rival) return [];
  const target = Math.round(rival.pricePerDay);
  // MONEY, NOT ANY NUMERAL. A bare numeral scan reported ["rival"] whenever the
  // message happened to carry a date, a duration or an engine size within a
  // unit of the rival's price - so the leverage KPI counted "for the 17 Aug" as
  // leverage against a rival at 17/day. Same helper as the cite-the-rival rail
  // and the citedRival instrument, so all three agree on what a citation is.
  const cited = citesPrice(normalizeDigits(message), [target]);
  return cited ? ["rival"] : [];
}

export function fallbackArtifact(ctx: TurnContext): TurnArtifact {
  let move: MoveKind = "silent";
  let message: string | undefined;
  for (const m of ctx.legalMoves) {
    const t = templateFor(ctx, m);
    if (t) {
      move = m;
      message = t;
      break;
    }
  }
  return {
    read: { intent: "fallback" },
    think: "deterministic fallback (no usable LLM output)",
    move: message ? move : "silent",
    message,
    leverageUsed: fallbackLeverage(ctx, move, message),
    digestPatch: [],
  };
}

/** Run the single pass. Returns a validated TurnArtifact (never throws). */
export async function runSinglePass(ctx: TurnContext): Promise<{ artifact: TurnArtifact; route: ModelRoute }> {
  const route = pickRoute(ctx);
  const { system, user } = buildPrompt(ctx);
  const recent = (ctx.thread.digest.lastOutbound ?? []).filter(Boolean);

  for (let attempt = 0; attempt < 2; attempt++) {
    // On the retry, add a hard anti-repetition nudge (the keyless backstop for
    // the Redis signature guard that is dark on Cloud Run).
    const userMsg =
      attempt === 0
        ? user
        : `${user}\n\nYour previous draft repeated an earlier message almost word for word. Rewrite it from scratch with a DIFFERENT sentence structure and a DIFFERENT lever.`;
    // chatDetailed, not chat, for ONE reason: it returns which provider
    // answered, and `chat()` was throwing that away. `route.provider` has been
    // declared since the engine shipped and assigned by nobody, so Ops showed
    // its `mock/local` fallback chip on every turn - including the ones a real
    // model composed - while the help text explained that meant no live key
    // was used. A cosmetic omission that read as a broken deployment.
    const { text: raw, provider, error } = await chatDetailed(
      [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      // pickRoute's tier is REAL now (owner report 5 #13): Tier M (high-stakes
      // - first push, farewell, close) runs the PAID providers first when the
      // owner has keyed any; Tier F keeps the free chain with paid as the last
      // resort. Before this, the computed tier reached nothing - every turn,
      // including the ones the router itself classified as high-stakes, took
      // the same default chain.
      { maxTokens: 500, budgetMs: 9000, ...(route.tier === "M" ? { tier: "premium" as const } : {}) }
    );
    if (provider) route.provider = provider;
    if (!raw) {
      // WHY THE MODEL DID NOT ANSWER, KEPT.
      //
      // chatDetailed returns the last provider's actual failure - a bad key, a
      // 429, a timeout - and this line dropped it. Downstream, "no key
      // configured" and "eight keys configured and every one of them is
      // failing" produced the identical outcome: a deterministic template and
      // provider:null on the turn. The Ops panel rendered both as its
      // mock/local chip, so a live outage was indistinguishable from a demo
      // deployment. It is one string; carry it.
      route.error = error ?? "no provider available";
      break; // fall through to the deterministic composer
    }
    const parsed = extractJson<Partial<TurnArtifact>>(raw);
    if (parsed && typeof parsed.move === "string") {
      const artifact: TurnArtifact = {
        read: parsed.read ?? { intent: "" },
        think: typeof parsed.think === "string" ? parsed.think.slice(0, 200) : "",
        // Old vocabulary in, current vocabulary out. A model coached by an
        // exemplar written before the rename still says "close"; coercing that
        // to legal[0] would throw away a choice that was actually right.
        move: normalizeMove(parsed.move) as MoveKind,
        message: typeof parsed.message === "string" ? parsed.message : undefined,
        counterPricePerDay:
          typeof parsed.counterPricePerDay === "number" ? parsed.counterPricePerDay : undefined,
        leverageUsed: Array.isArray(parsed.leverageUsed) ? (parsed.leverageUsed as TurnArtifact["leverageUsed"]) : [],
        digestPatch: Array.isArray(parsed.digestPatch) ? parsed.digestPatch.slice(0, 3).map(String) : [],
        // NEVER trust a raw wait either: an unclamped waitMinutes once parked a
        // live thread until 08:28 the next morning. See spte/wait.ts.
        waitMinutes: clampWaitMinutes(parsed.waitMinutes),
      };
      // NEVER trust an out-of-set move (the B7 lesson, generalized).
      artifact.move = coerceToLegal(artifact, ctx.legalMoves);
      // Anti-repetition: a near-duplicate of a recent send is rejected ONCE (so
      // the retry above fires); on the second pass we accept it rather than go
      // silent - a slightly repetitive reply still beats no reply.
      if (
        attempt === 0 &&
        artifact.message &&
        recent.length > 0 &&
        isRepetitive(artifact.message, recent)
      ) {
        continue;
      }
      return { artifact, route };
    }
    // malformed JSON -> retry once, then fall through.
  }
  return { artifact: fallbackArtifact(ctx), route: { tier: "R", reason: "quota-overflow" } };
}
