// SPTE LIVE GLUE - the production wiring that runs the Single-Pass Turn Engine
// on a real inbound WhatsApp turn, reusing the graph engine's hardened IO
// (guardAndSend / queueOutbox / insertWakeup / sessionTable). This is the bridge
// the blueprint called for: the graph engine's runGraphTurn and this share the
// SAME GraphTurnInput + GraphIO, so processVendorReply can try V3 first and fall
// back to the graph engine on ANY error with zero behavioural drift.
//
// ROBUSTNESS CONTRACT (the reason a fallback can never double-send):
//   - Everything that can throw runs BEFORE the send decision (context build).
//   - Once runTurn has decided the move, this function OWNS the turn and never
//     throws again - the send, wakeups and telemetry are all best-effort. So a
//     throw only ever escapes before a message leaves, and the caller's fallback
//     to the graph engine is always safe.

import type { GraphIO, GraphTurnInput, NegotiationThreadState } from "../graph/types";
import { runTurn } from "./orchestrator";
import { newDecisionId } from "../orchestrator";
import { clampWaitMinutes } from "./wait";
import { optionsFromThread, signalsVariance } from "../offer-options";
import { digestFromStored, emptyDigest, mergeComprehension, persistableDigest } from "./digest";
import {
  ambiguousLedgerSubjects,
  isHighStakesComprehension,
  readTurnComprehension,
  type TurnComprehension,
} from "./comprehension";
import { quoteOnTable } from "./policy";
import { HISTORY_ELISION, HISTORY_HEAD_LINES } from "../wa/history-window";
import { normalizeDigits } from "../integrity/translation";
import { citesPrice, findNumerals } from "../integrity/money-context";
import { cheapestCheaperRival } from "../negotiation/leverage";
import { deriveThreadFacts } from "./thread-facts";
import { getPolicyOverlay, DEFAULT_OVERLAY, type PolicyOverlay } from "../ops/overlay";
import { getGraphSpec } from "../graph/engine";
import { clampTurnDetail } from "./turn-detail";
/** The historical literal, kept as the config-outage fallback. It is the graph
 *  spec's own default (default-graph.ts:44), not the 6 that used to be here. */
const DEFAULT_MAX_ROUNDS = 4;
/**
 * How long a priced thread waits before looking again (owner report 5 #9).
 *
 * Long enough to span the gap the owner described - an expensive quote at 10:00
 * and a cheaper one at 10:20 - and short enough that a shop still remembers the
 * conversation. Deliberately NOT routed through clampWaitMinutes: that band
 * (1-3 minutes) bounds a MODEL-proposed pause, and this is the engine's own
 * re-entry, armed at most once per thread.
 */
const PRICE_WATCH_MINUTES = 22;
import { buildLedger } from "../thread/ledger";
import type { MoveKind, SessionSnapshot, ThreadDigest, TurnContext, VerifiedExtraction } from "./types";
import { shopAskedLocation, shopAskedLicense, shopAskedLicensePhoto } from "../wa/detectors";
import { shopAskedQuestion } from "../graph/nodes";
import { classifyActs } from "../wa/dialogue-acts";
import { vehicleKeyFor, groundedBenchmarkFor } from "../market";
import { enqueueCorpus } from "../corpus/sidecar";
import { askVariantFor, variantHonoured } from "../negotiation/ask-variant";
import {
  nextThreadLanguage,
  threadLanguageFromStored,
  threadWritesEnglish,
  type ThreadLanguage,
} from "../wa/thread-language";

export interface SpteLiveResult {
  ran: true;
  move: MoveKind;
  tier: "R" | "F" | "M";
  provider?: string;
  delivered: "sent" | "queued" | "held" | "blocked" | "failed" | "silent";
  text?: string;
}

/** Map the graph engine's ExtractedOffer + resolved price into the SPTE verified
 *  signal set. Numbers come ONLY from the deterministic extractor (never the
 *  LLM), exactly as the blueprint requires. */
function mapVerified(input: GraphTurnInput): VerifiedExtraction {
  const ex = input.extraction;
  const text = input.event.kind === "inbound-text" || input.event.kind === "inbound-image"
    ? input.event.shopMessage ?? ""
    : "";
  // GLOSS BEFORE DETECTORS. Every deterministic detector below is an English
  // phrase test, and it used to read only the raw local-language text - so a
  // Thai "คุณอยู่ที่ไหน" (where are you?) matched no location ask and a
  // localized license request was never seen. The English gloss (threaded from
  // the agent loop) is CONCATENATED, never substituted: a raw text that
  // happens to carry English words keeps every hit it had.
  const gloss = (input.inboundEnglish ?? "").trim();
  const detText = gloss && text && gloss.toLowerCase() !== text.trim().toLowerCase()
    ? `${text}\n${gloss}`
    : text || gloss;
  // WHAT THE SHOP DID, before anything decides how to answer it.
  const acts = classifyActs({
    text: detText,
    hadImage: input.event.kind === "inbound-image" || Boolean(ex?.imageKind),
    imageKind: ex?.imageKind,
    pricePerDay: input.usablePrice,
    optionCount: Array.isArray(ex?.options) ? ex.options.length : 0,
  });
  // The legacy phrase list still widens the ask - it recognises real questions
  // the classifier's grammar test can miss ("you mean the 125?") - but it can
  // no longer promote a bare "?" or an automated greeting.
  if (acts.ask === "none" && !acts.autoReply && detText && shopAskedQuestion(detText) && /\?/.test(detText)) {
    const stripped = detText.replace(/\?/g, "");
    if (shopAskedQuestion(stripped)) acts.ask = "substantive";
  }
  return {
    found: Boolean(input.usablePrice),
    pricePerDay: input.usablePrice,
    currency: input.currency,
    declined: Boolean(ex?.shopDeclined),
    // ONLY a positively-named different class ends a thread. "unclear" (a bare
    // price, a menu, a question back) used to land here as wrongVehicle and made
    // `redirect-close` the single legal move - a goodbye to a shop that was
    // still talking to us.
    wrongVehicle: ex?.vehicleVerdict === "mismatch" || (!ex?.vehicleVerdict && ex?.matchesSpec === false),
    vehicleUnclear: ex?.vehicleVerdict === "unclear",
    // The identity gate's own verdict, which outranks the extractor's opinion:
    // it is computed from what the shop stated plus what the catalogue knows.
    vehicleStatus: ex?.vehicleAssessment?.status,
    vehicleQuestion: ex?.vehicleAssessment?.question,
    // The ask-once fact from the durable thread state (resolved in agent-loop,
    // persisted with the negotiation thread): once our confirm question has
    // gone out, a repeat is never legal - the engine proceeds as "assumed".
    vehicleAsked: Boolean(ex?.vehicleConfirmation?.askedAt),
    // The shop offered a CHOICE. Without these two the primary engine could not
    // tell "I have two bikes at different prices" from "here is my price", and
    // read the ambiguity as "wrong vehicle" - closing a live negotiation.
    options: Array.isArray(ex?.options) ? ex.options : undefined,
    variance: detText ? signalsVariance(detText) : false,
    askedLocation: detText ? shopAskedLocation(detText) : false,
    // A QUESTION MARK IS NOT A QUESTION. `shopAskedQuestion` is `/\?/` plus a
    // phrase list, so a price board captioned "...which model would you like?"
    // and an auto-reply's rhetorical "How many days rental?" both counted as
    // the shop waiting on us - which made `answer` the top legal move and fired
    // the "Good question!" template at a shop that had asked nothing. The acts
    // classifier decides now; the old detector stays as a widening OR only for
    // the phrase list it recognises, never for bare punctuation.
    askedQuestion: acts.ask !== "none",
    acts,
    askedLicense: detText ? shopAskedLicense(detText) : false,
    askedLicensePhoto: detText ? shopAskedLicensePhoto(detText) : false,
    // The shop refused to lower ("last price") - the deterministic extractor
    // read it (agents.ts FIRM_RX) and it USED to be dropped on the floor here.
    firm: Boolean((ex as { shopFirm?: boolean } | null)?.shopFirm),
    // OUT OF STOCK IS A STATE, and it is read from the thread's own claims -
    // the shop's last word on whether it has a vehicle at all. A later "we
    // have one now" un-sticks it with no special case.
    // (filled in by buildTurnContext from the thread ledger - the shop's own
    // last word on whether it has a vehicle at all)
    shopUnavailable: false,
    // WHAT THE SHOP SENT. These all existed on ExtractedOffer and none of them
    // reached the primary engine, so a shop that answered with four price boards
    // looked identical to one that said nothing - and got asked to type it out.
    hadImage: input.event.kind === "inbound-image" || Boolean(ex?.imageKind),
    imageKind: ex?.imageKind,
    imageSummary: ex?.imageSummary || undefined,
    // Our own read's provenance, not the shop's. `seen:false` means the vision
    // providers failed, so the engine must not act as though it had looked.
    imageUnread: (() => {
      const ir = (ex as { imageRead?: { seen?: boolean; modelFailure?: string } } | null)?.imageRead;
      // parse-failed/truncated mean the reader ran and WE still have nothing -
      // the composer must not act as though it had looked, exactly as when the
      // ladder never answered. (sanity-nulled keeps its number and is handled
      // by the panel; blinding the composer over it would hide a real price.)
      return ir?.seen === false ||
        ir?.modelFailure === "parse-failed" ||
        ir?.modelFailure === "truncated"
        ? true
        : undefined;
    })(),
    sheetPricePerDay:
      ex?.imageKind === "price_sheet" && typeof input.usablePrice === "number"
        ? input.usablePrice
        : undefined,
  };
}

/**
 * Reconstruct the thread digest: DERIVED facts from the rows the caller already
 * loaded, seeded by the one half that cannot be derived.
 *
 * THE AMNESIA (W4.5). `runTurn` has always computed `mergeDigest(...)` and
 * returned it as `outcome.digest`, and this function has always started from
 * `emptyDigest()`. Nothing ever read the outcome back, so `digest.facts` was
 * permanently `[]` - which made `hasClosed()` permanently false, so the "one
 * warm goodbye then silence" rule was unenforced on the live path; and
 * `quotedPricePerDay` was rebuilt from the CURRENT message alone, so a shop
 * that replied without repeating its number looked, to the whole ladder, like a
 * shop that had never quoted.
 *
 * `stored` is the persisted half (spte/digest persistableDigest): the model's
 * durable notes, the standing quote, the round count, the tone and the
 * confirming questions already spent. Everything else below is still recomputed
 * from the messages every turn, so nothing derived can go stale.
 */
function buildDigest(
  input: GraphTurnInput,
  stored: ThreadDigest,
  ambiguous: import("../thread/claims").ClaimSubject[] = [],
  comp: import("./comprehension").TurnComprehension | null = null
): ThreadDigest {
  const base = { ...emptyDigest(), ...stored };
  // THE MODEL'S DURABLE READING, FOLDED (A4/K). One turn of comprehension
  // merges into what earlier turns actually read; on a degraded turn nothing
  // changes - memory, not fabrication. Every meaning fact below projects from
  // this, never from a regex over the shop's words.
  const comprehension = mergeComprehension(base.comprehension, comp);
  const tone = ((): ThreadDigest["tone"] => {
    const t = (input.extraction as { shopTone?: string } | null)?.shopTone;
    if (t === "annoyed") return "reluctant";
    if (t === "warm") return "friendly";
    // A tone read once STICKS until the shop reads differently: a shop that
    // snapped at us on message three has not become neutral by sending a
    // message with no tone cues in it, and `momentum` now reads this.
    return stored.tone;
  })();
  // THREAD-DERIVED STATE (thread-facts.ts): round / firm / deposit / fulfillment
  // recomputed from the actual message history the caller loaded, so the round
  // cap and the two-firms-stop rule finally bind. The current inbound firm read
  // (from the extractor) is OR-ed in so "last price" counts on the turn it lands.
  const inbound = input.priorInbound ?? [];
  const outbound = input.priorOutbound ?? [];
  // GLOSS BEFORE THE SCANNERS (same doctrine as mapVerified): thread-facts,
  // the claim ledger and the options accumulator are all English phrase tests,
  // and the current message used to reach them raw. Concatenated, never
  // substituted, so English words in the raw text keep their hits.
  const curRaw =
    input.event.kind === "inbound-text" || input.event.kind === "inbound-image"
      ? input.event.shopMessage ?? ""
      : "";
  const curGloss = (input.inboundEnglish ?? "").trim();
  const curInbound =
    curGloss && curRaw && curGloss.toLowerCase() !== curRaw.trim().toLowerCase()
      ? `${curRaw}\n${curGloss}`
      : curRaw || curGloss;
  const facts = deriveThreadFacts({
    outbound,
    outboundKinds: input.priorOutboundKinds,
    priorBargainCount: input.legacyCounts?.bargain ?? 0,
    comprehension,
  });
  // The extractor's per-turn shopFirm (its own model read, with the regex as
  // its pre-filter) may land before the comprehension counter has - ensure at
  // least 1 on the turn it fires so "last price" counts immediately.
  const curFirm = Boolean((input.extraction as { shopFirm?: boolean } | null)?.shopFirm);
  // A DETERMINISTIC BACKSTOP FOR WHEN THE MODEL IS NOT THERE.
  //
  // Firmness is single-sourced on the LLM: comprehension's `firm` verdict and
  // the extractor's `shopFirm`, both riding the SAME provider chain. Chain
  // exhaustion is a modelled, instrumented production state - so with the
  // providers down, firmCount reads 0, `bargain` stays legal, the pass falls
  // through to its deterministic template, and the agent asks "any chance you
  // can do a bit better?" of a shop that just said "last price, cannot lower".
  // Repeatedly, up to maxRounds.
  //
  // The old FIRM_RX was deleted because it fired on an opening "best price".
  // This one cannot: it needs a standing quote already on the table AND an
  // explicit refusal shape, and it only ever ADDS firmness. It reads detText,
  // so it inherits the English gloss.
  const REFUSAL =
    /\b(?:cannot|can'?t|no|not)\s+(?:lower|reduce|discount|go\s+lower|come\s+down)\b|\b(?:last|final|best|fixed|net)\s+price\b|\bno\s+(?:discount|bargain|negotiat)/i;
  // A standing quote is the guard that keeps this off an opening "best price":
  // either this turn carries a price, or the thread already had one.
  const quoteOnTable =
    Boolean((input.extraction as { pricePerDay?: number } | null)?.pricePerDay) ||
    (input.usablePrice ?? 0) > 0;
  const deterministicFirm = quoteOnTable && REFUSAL.test(curInbound);
  const firmCount =
    curFirm || deterministicFirm ? Math.max(facts.firmCount, 1) : facts.firmCount;
  // THE SHOP'S MENU, read across the WHOLE thread - a tier named three messages
  // ago is still on the table. Derived, never stored, for the same reason the
  // facts above are: the conversation is the state.
  const options = optionsFromThread([...inbound, curInbound], {
    vehicleClass: input.rfq.vehicleClass === "car" ? "car" : input.rfq.vehicleClass,
    // The declared spec scopes the menu: a shop's full price board must never
    // become a list of things to pick, and the traveller's licence declaration
    // covers only what they searched for.
    engineSizeCc: input.rfq.engineSizeCc,
    transmission: input.rfq.transmission,
    durationDays: input.rfq.durationDays,
    localCurrency: input.currency,
    depositNote: (input.extraction as { deposit?: string } | null)?.deposit || undefined,
  });
  // THE LEDGER: typed claims with POLARITY, the questions we have already put,
  // and the facts this thread still owes the traveller. Derived from the same
  // rows as everything else above, for the same reason.
  //
  // ...and `ambiguous` is the ledger's THIRD state (W4.4): a subject the
  // comprehension pass read but does not trust is struck from `known`, so a
  // half-understood deposit can no longer retire the deposit question forever.
  const ledger = buildLedger({ inbound, outbound, currentInbound: curInbound, ambiguous });
  return {
    ...base,
    comprehension,
    round: Math.max(base.round ?? 0, facts.bargainRounds),
    // THE STANDING QUOTE. `input.usablePrice` is this message only; the stored
    // digest carries what the shop said before and never repeated.
    quotedPricePerDay: input.usablePrice ?? base.quotedPricePerDay,
    // THE BOARD, THIS TURN OR ANY EARLIER ONE. A price list photographed on
    // turn one is still a printed anchor on turn four; the stored seed carries
    // it and this turn can only ADD to it.
    sheetPricePerDay:
      (input.extraction as { imageKind?: string } | null)?.imageKind === "price_sheet" &&
      typeof input.usablePrice === "number" &&
      input.usablePrice > 0
        ? input.usablePrice
        : base.sheetPricePerDay,
    mediaSummary:
      ((input.extraction as { imageSummary?: string } | null)?.imageSummary ?? "").trim() ||
      base.mediaSummary,
    tone,
    firmCount,
    // "No deposit" settles the deposit question exactly as firmly as "3000
    // baht". The old boolean only counted the second kind, so the friendliest
    // possible terms read as "unknown" and got asked about forever.
    //
    // ...BUT A HALF-READ DEPOSIT IS NOT A KNOWN ONE (W4.4). `facts.depositKnown`
    // is a regex that fires on the bare word "passport" anywhere in any inbound
    // message, so "We have deposit passport or money4000" latched a single
    // reading permanently and there was no way back. An ambiguous subject
    // suppresses BOTH sources, which is what makes the confirming question
    // reachable at all.
    depositKnown:
      !ambiguous.includes("deposit") &&
      (facts.depositKnown ||
        ledger.known.includes("deposit") ||
        // Deposit terms read from a PHOTO never touch the ledger's text
        // claims (the agreement-sign case: "passport OR 2,000-3,000 baht"
        // photographed, stored, shown to the traveller - and the engine
        // re-probed anyway). The extraction's deposit field IS the shop
        // stating its terms, whatever medium carried them.
        Boolean((input.extraction as { deposit?: string } | null)?.deposit)),
    fulfillmentKnown: facts.fulfillmentKnown || ledger.known.includes("handover"),
    deliveryOffered: facts.deliveryOffered,
    // The MODE and its PRICE are two facts. `fulfillmentKnown` went true on the
    // word "deliver", which retired the handover probe before anyone had asked
    // what delivery costs - so the traveller compared per-day rates and met the
    // fee at handover. The ledger's "handover" subject settles the mode, so it
    // is deliberately NOT OR-ed in here: knowing HOW is not knowing HOW MUCH.
    fulfillmentCostKnown: facts.fulfillmentCostKnown,
    handoverAsks: facts.handoverAsks,
    momentumNudges: facts.momentumNudges,
    lastOutbound: facts.lastOutbound,
    options: options.length >= 2 ? options : undefined,
    ledger,
  };
}


/** Build the session snapshot (blackboard read) from the shared session table:
 *  rivals = other shops' live quotes in the SAME currency; lowest = the session's
 *  cheapest quote across all shops. Best-effort - a read failure yields an empty
 *  snapshot (the single pass still composes a safe move, never invents a rival). */
async function buildSession(
  input: GraphTurnInput,
  io: GraphIO,
  verified: VerifiedExtraction
): Promise<SessionSnapshot> {
  const email = input.ctx.sender ?? "";
  const thisVendor = input.ctx.vendorId ?? "";
  let rivals: SessionSnapshot["rivals"] = [];
  let lowest: SessionSnapshot["lowest"] = null;
  let brief = "";
  if (email) {
    // SAME VEHICLE. A quote for a different machine is not a rival, and citing
    // one at a shop is an argument we made up.
    const rows = await io
      .sessionTable(email, thisVendor, vehicleKeyFor(input.rfq), {
        engineSizeCc: input.rfq.engineSizeCc,
        durationDays: input.rfq.durationDays,
      })
      .catch(() => []);
    // WHICH CURRENCY IS THIS SESSION IN? Comparing across currencies without FX
    // would invent leverage, so the filter below is strict equality - but when
    // THIS thread is the odd one out (a single mis-stamped currency, exactly
    // what the "RM 300 in Krabi" bug produced), strict equality silently threw
    // away every rival and the shop quoting 300 never heard about the 250.
    // Trust the session's own majority over one thread's stamp.
    const priced = rows.filter((r) => typeof r.pricePerDay === "number" && r.currency);
    const tally = new Map<string, number>();
    for (const r of priced) tally.set(r.currency!, (tally.get(r.currency!) ?? 0) + 1);
    const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const compareCur =
      dominant && !tally.has(input.currency) && tally.get(dominant)! >= 2 ? dominant : input.currency;
    // ONE AGGREGATOR, AND IT KNOWS WHAT A RIVAL IS.
    //
    // This loop used to accept every priced row the session read returned, with
    // no test of whether the quote behind it was still one anyone could take.
    // A rival is a THREAT - "another shop is at 200" only moves a price because
    // the traveller could plausibly go there - so a withdrawn, dead or closed
    // shop is not leverage, it is noise that spends the one disclosure this
    // thread gets. validRivals is the shared predicate; it is pure, so the rule
    // is reviewable and testable in one screen.
    //
    // This runs inside buildSession, which every entry point reaches through
    // runThreadTurn - inline reply, scheduled wakeup and user action alike. It
    // used to be the inline path only, which before the routing fix meant every
    // scheduled follow-up negotiated with no cross-chat leverage at all.
    const { validRivals, sessionFloor } = await import("../negotiation/session-rivals");
    rivals = validRivals(rows, {
      excludeVendorId: thisVendor,
      currency: compareCur,
      limit: 4,
      // A rival per-day divided out of a longer package is not a like-for-like
      // price for a shorter rental (owner report 5 #2, the "167").
      durationDays: input.rfq.durationDays,
    });
    lowest = sessionFloor(rows, compareCur);
    // WHERE EVERY OTHER SHOP STANDS - not just the four we can cite.
    //
    // `validRivals` is a LEVERAGE filter: it keeps live, priced,
    // comparable-currency quotes and drops everything else. That is right for
    // the rival card and wrong as the agent's only knowledge of the hunt: a
    // shop that said no, a shop still silent, and "this is the last shop left"
    // are all facts a human negotiator holds in their head and each one changes
    // the tactic. Built from the SAME `rows` already in hand, so it adds no
    // read; bounded in lines and characters so it cannot crowd the prompt.
    const { buildSessionBrief } = await import("../negotiation/session-brief");
    brief = buildSessionBrief({ rows, excludeVendorId: thisVendor });
  }
  // Grounded market benchmark (F5): the ONLY market rate allowed into the
  // prompt - web-grounded with a source URL, and ONLY when its currency matches
  // this session (never cross-currency). Best-effort; null when none exists yet.
  let benchmark: SessionSnapshot["benchmark"] = null;
  try {
    const gb = await groundedBenchmarkFor(input.ctx.region || undefined, input.rfq);
    if (gb && gb.currency === input.currency) benchmark = gb;
  } catch {
    /* no grounded benchmark -> the pass refuses to invent one */
  }
  // WHAT PAST TRAVELLERS ACTUALLY LANDED HERE.
  //
  // This was pinned to `null`, and `dealPrior` - which computes the median
  // achieved price and typical discount from `deal_memory` - had ZERO callers.
  // `rememberDeal` IS wired (negotiate/close-deal:208), so the table filled up
  // forever and was never read: after a thousand closed deals in Koh Samui, the
  // thousand-and-first negotiation anchored on exactly the same information as
  // the first. The prompt line that consumes it (pass.ts:47, "Past travellers
  // here landed around N/day") was permanently empty, and the self-improvement
  // loop the module header advertises was a no-op.
  //
  // Same region key the writer uses (lowercased free text), and dealPrior
  // already returns null below three samples so a thin prior cannot over-anchor.
  let priors: SessionSnapshot["priors"] = null;
  try {
    const regionKey = String(input.ctx.region ?? "").trim().toLowerCase();
    if (regionKey) {
      const { dealPrior } = await import("./memory");
      priors = await dealPrior(regionKey, input.rfq);
    }
  } catch {
    /* a prior is grounding, never a requirement - the turn proceeds without it */
  }
  // Few-shot coaching (owner teaching + Ops learning + distilled winning
  // traces) - the primary engine now learns like the graph engine does.
  // Best-effort; "" when nothing has been taught/distilled yet.
  // SITUATIONAL retrieval: the owner's lessons about THIS kind of message
  // (a menu on screen, a price board, a location request) instead of one
  // global tone block on every turn. Derived from verified facts, never from
  // the shop's wording.
  const { situationKinds } = await import("../ops/misread");
  const situation = situationKinds({
    optionCount: verified.options?.length,
    variance: verified.variance,
    hadImage: verified.hadImage,
    imageKind: verified.imageKind,
    askedLocation: verified.askedLocation,
    askedQuestion: verified.askedQuestion,
    declined: verified.declined,
    firm: verified.firm,
  });
  const { loadCoaching } = await import("./coaching");
  const coaching = await loadCoaching(situation).catch(() => "");
  return {
    sessionId: input.event.threadKey,
    rfq: input.rfq,
    currency: input.currency,
    benchmark,
    lowest,
    rivals,
    brief,
    priors,
    coaching,
  };
}

/**
 * How many transcript lines reach the prompt.
 *
 * THIS BOUND WAS THROWING AWAY THE PART THE WINDOW WORKS HARDEST TO KEEP.
 *
 * `buildHistoryWindow` is char-budgeted at 4000 and, when a thread overflows,
 * preserves the four OLDEST lines verbatim - the RFQ and the vehicle-naming
 * turns, "the part a misunderstanding destroys deals over" in its own words -
 * marks the elision, and fills the tail newest-backwards. `buildTail` then
 * parsed that carefully-shaped window back into turns, dropped the elision
 * marker, and took the last EIGHT lines: on any thread longer than eight
 * messages the preserved head was discarded, and with it the dates, the vehicle
 * and any early promise. The engine that is supposed to remember the whole
 * conversation remembered four exchanges.
 *
 * The real bound is the window's character budget, which is already applied
 * upstream. This stays only as a safety valve for a pathological thread of very
 * short lines - and when it binds it now keeps the HEAD as well as the tail,
 * exactly as the window intended.
 */
export const TAIL_LINES = 40;

/**
 * THE CONVERSATION, BOTH SIDES OF IT (W4.5).
 *
 * `RECENT MESSAGES` in the prompt was built from `priorOutbound` alone - our
 * own last three sends, and NOT ONE SHOP TURN. The model was shown a monologue
 * and asked to continue a dialogue, which is a large part of why it re-asked
 * things the shop had answered two messages earlier.
 *
 * The budgeted, head-preserved thread window the caller already built
 * (wa/history-window, `input.history`) is exactly the right object and SPTE
 * ignored it completely. It renders "Us: ..." / "Shop: ..." lines with voice
 * transcripts inlined, so parsing it back into the tail is lossless.
 *
 * Falls back to the old outbound-only tail when no window was supplied (the
 * simulator, the older call sites and every existing unit test), so nothing
 * that does not pass `history` changes behaviour.
 */
export function buildThreadTail(input: GraphTurnInput): {
  tail: TurnContext["tail"];
  elided: boolean;
} {
  const at = new Date(input.deadlineAt - 40_000).toISOString();
  const parsed: TurnContext["tail"] = [];
  // The window says so itself when it had to drop the middle. Carried through
  // as a FLAG rather than as a fake turn: it is not something anyone said, so
  // it must not enter the repetition corpus or the counter-already-made check.
  let elided = String(input.history ?? "").includes(HISTORY_ELISION);
  for (const line of String(input.history ?? "").split("\n")) {
    const l = line.trim();
    if (l.startsWith("Shop: ")) parsed.push({ dir: "in", text: l.slice(6).trim(), at });
    else if (l.startsWith("Us: ")) parsed.push({ dir: "out", text: l.slice(4).trim(), at });
    // The elision marker and anything else the window emitted are not turns.
  }
  const kept = parsed.filter((m) => m.text.length > 0);
  if (!kept.length) {
    return {
      tail: (input.priorOutbound ?? []).slice(-3).map((text) => ({ dir: "out" as const, text, at })),
      elided: false,
    };
  }
  if (kept.length <= TAIL_LINES) return { tail: kept, elided };
  // KEEP BOTH ENDS, the way the window does. Taking only the newest lines is
  // what discarded the RFQ and the vehicle on every long thread.
  const head = kept.slice(0, HISTORY_HEAD_LINES);
  const rest = kept.slice(-(TAIL_LINES - HISTORY_HEAD_LINES));
  elided = true;
  return { tail: [...head, ...rest], elided };
}

/** The turns alone - the shape every existing caller and test expects. */
export function buildTail(input: GraphTurnInput): TurnContext["tail"] {
  return buildThreadTail(input).tail;
}

/** Map a closed MoveKind to the outbox meta.kind used by drain/pacing AND by the
 *  round/answer counters in agent-loop. A bargain MUST stamp "auto-bargain" or
 *  the round cap never binds (the 4-pushes-to-one-shop bug); an answer stamps
 *  "auto-answer". None of these are the cold "rfq" kind, so reply-lane pacing is
 *  preserved (only "rfq" is a cold intro). */
function metaKindFor(move: MoveKind): string {
  switch (move) {
    case "bargain":
      return "auto-bargain";
    case "clarify":
      return "auto-clarify";
    // A confirming question is a question, not a push - it must never reach the
    // round counter, and it must not be paced as a cold intro either.
    case "confirm":
      return "auto-confirm";
    // The step-7 recap: its own kind, so the transcript can say "final
    // verification" instead of filing it as a generic reply.
    case "verify-recap":
      return "auto-recap";
    case "answer":
      return "auto-answer";
    // PROBES ARE NOT ANSWERS. Collapsing them into "auto-answer" (a) hid the
    // deposit/pickup discovery from every transcript and admin panel (the
    // whole INFO_DISCOVERY phase rendered as generic answers), (b) counted
    // them into legacyCounts.answer - a cap they were never meant to spend -
    // and (c) gave them the answer's 10-25s pacing instead of the 15-40s the
    // graph engine's jitter table already assigns these very kinds. The graph
    // engine has stamped them distinctly all along; SPTE now speaks the same
    // vocabulary.
    case "deposit-probe":
      return "auto-deposit-probe";
    case "fulfillment-probe":
      return "auto-fulfillment-probe";
    case "pickup-location":
      return "auto-pickup-location";
    case "option-probe":
      return "auto-option-probe";
    case "confirm-vehicle":
      return "auto-confirm-vehicle";
    case "farewell":
    case "closing-message":
    case "redirect-close":
    case "graceful-close":
      return "auto-close";
    default:
      return "reply";
  }
}

/**
 * The owner-tunable half of the policy: the clamped overlay and the graph
 * spec's round cap. `input.overlay` is set on the REPLAY path so the golden
 * suite stays bit-stable regardless of live config - the same contract the
 * graph engine uses at engine.ts:384.
 */
async function resolvePolicy(
  input: GraphTurnInput
): Promise<{ overlay: PolicyOverlay; maxRounds: number }> {
  const overlay =
    input.overlay ?? (await getPolicyOverlay().catch(() => DEFAULT_OVERLAY));
  const maxRounds = await getGraphSpec()
    .then((spec) => spec.settings.maxRoundsPerShop)
    .catch(() => DEFAULT_MAX_ROUNDS);
  return { overlay, maxRounds };
}

/**
 * THE COMPREHENSION PHASE, wired into the live turn.
 *
 * Runs on the ENGLISH GLOSS when one exists (W1.5 stamps it on both inbound
 * surfaces) and on the shop's raw words otherwise, because English-only
 * judgement over raw Thai is the root of every misread in this wave. Only ever
 * on a real shop message - a tick has nothing to comprehend.
 *
 * Everything it decides is ADDITIVE and every failure mode is the status quo:
 * no provider, a timeout, a schema it could not satisfy, or a stance it is not
 * confident about all leave `verified` exactly as the deterministic readers
 * left it. That is the contract that lets this sit on the reply path at all.
 */
async function runComprehension(
  input: GraphTurnInput,
  verified: VerifiedExtraction,
  digestSeed: ThreadDigest
): Promise<TurnComprehension | null> {
  const raw =
    input.event.kind === "inbound-text" || input.event.kind === "inbound-image"
      ? (input.event.shopMessage ?? "").trim()
      : "";
  if (!raw) return null;
  // THE GLOSS FIRST. Not a language decision (that is W4.6's) - a COMPREHENSION
  // one: the judgement below is written in English and every one of its failure
  // reports came from reading a language it was not written for.
  const gloss = (input.inboundEnglish ?? "").trim();
  const text = gloss || raw;
  const r = input.rfq;
  const context =
    `The traveller wants: ${r.vehicleClass}${r.engineSizeCc ? ` ${r.engineSizeCc}cc` : ""}` +
    `${r.transmission && r.transmission !== "any" ? ` (${r.transmission})` : ""} for ${r.durationDays} days.\n` +
    (digestSeed.facts.length ? `This thread so far: ${digestSeed.facts.join("; ")}\n` : "") +
    (typeof digestSeed.quotedPricePerDay === "number"
      ? `They have already quoted ${digestSeed.quotedPricePerDay} ${input.currency}/day.\n`
      : "");
  try {
    return await readTurnComprehension({
      text,
      context,
      highStakes: isHighStakesComprehension({
        hasStandingPrice:
          typeof input.usablePrice === "number" ||
          typeof digestSeed.quotedPricePerDay === "number",
        declined: verified.declined,
        firm: verified.firm,
        vehicleUnclear: verified.vehicleUnclear,
      }),
    });
  } catch {
    // The pass owns its own failures; this is the last net, and its answer is
    // always "change nothing".
    return null;
  }
}

async function buildTurnContext(
  input: GraphTurnInput,
  io: GraphIO
): Promise<{ tc: TurnContext; state: NegotiationThreadState | null; comp: TurnComprehension | null }> {
  const policy = await resolvePolicy(input);
  const verified = mapVerified(input);
  // ONE state read for the whole turn: the persisted digest (W4.5), the pending
  // substitution choice, and the row the outcome is written back onto.
  // Wrapped in a resolved promise rather than called bare: an IO object that
  // does not implement `loadState` (the simulator, a unit-test double) throws
  // SYNCHRONOUSLY, which `.catch()` cannot catch - the same trap documented on
  // the trace write below.
  const state = await Promise.resolve()
    .then(() => io.loadState(input.event.threadKey))
    .catch(() => null);
  const seed = ((): ThreadDigest => {
    const d = digestFromStored((state?.fields as { digest?: unknown } | undefined)?.digest);
    // THE PRINTED BOARD AND WHAT THE PHOTO SHOWED LIVE ON `fields`, NOT IN THE
    // DIGEST BLOB - that is where both engines write them (graph/state.ts
    // applyExtractionToState, and now persistThreadOutcome). Seeding them here
    // is what carries "the shop posted a list at 300" from turn one into turn
    // two, which is the difference between the printed-list clamp existing and
    // being dead code on the engine that actually answers shops.
    const f = (state?.fields ?? {}) as { sheetPricePerDay?: number; mediaSummary?: string };
    if (typeof f.sheetPricePerDay === "number" && f.sheetPricePerDay > 0) {
      d.sheetPricePerDay = f.sheetPricePerDay;
    }
    if (typeof f.mediaSummary === "string" && f.mediaSummary.trim()) {
      d.mediaSummary = f.mediaSummary;
    }
    return d;
  })();

  // COMPREHENSION BEFORE DERIVATION: the ledger's third state and the deposit
  // latch both depend on what the model could not settle, so it has to run
  // before the digest is built from the thread's text.
  const comp = await runComprehension(input, verified, seed);
  if (comp) {
    verified.stance = comp.stance;
    verified.stanceQuote = comp.stanceQuote;
    verified.deflected = comp.deflected;
    // MODEL-OWNED (K2). This used to OR the regex verdict in, so the model
    // was structurally forbidden from saying "no, they are still selling" -
    // one ordinary sentence ("Sorry cannot deliver... Scooter 300 baht per
    // day") matched `sorry,? cannot` and a shop QUOTING A PRICE was filed as
    // one that had walked away, permanently. When the model ANSWERED, its
    // verdict IS the verdict. A degraded pass decided nothing and may erase
    // nothing - the extractor's own model read stands on those turns.
    if (!comp.degraded) verified.declined = comp.declined;
    verified.uncertain = comp.uncertain;
    verified.comprehensionDegraded = comp.degraded;
  }
  const ambiguous = ambiguousLedgerSubjects(comp);

  const digest = buildDigest(input, seed, ambiguous, comp);
  // OUT OF STOCK IS A STATE (thread/ledger stockState), derived from the same
  // claims every other durable fact comes from - so "we have one now" un-sticks
  // it with no special case, and nothing has to be persisted.
  {
    const { stockState } = await import("../thread/ledger");
    const stock = stockState(digest.ledger);
    verified.shopUnavailable = stock.state === "out-of-stock";
    verified.restockHint = stock.restockHint;
    // `readAvailability` returns exactly this state and had ZERO callers. Its
    // own schema says "none" is a stock-out and "explicitly not a refusal to
    // deal" - which is the distinction the claim scanner cannot make from
    // wording alone, and the one that decides whether a thread pauses or dies.
    if (comp?.availability === "none") {
      verified.shopUnavailable = true;
      verified.restockHint = verified.restockHint ?? comp.restockHint;
    } else if (comp?.availability === "has") {
      verified.shopUnavailable = false;
      verified.restockHint = undefined;
    }
  }
  // A SUBSTITUTION WAITING ON THE TRAVELLER pauses this thread instead of
  // closing it (policy.ts). Read from the stored thread state, so every entry
  // point - inbound reply, scheduled wakeup, user action - sees the same
  // pending choice.
  //
  // STALENESS IS JUDGED ON READ, not at write time, because a choice goes stale
  // by the passage of time and nothing writes to the row while a thread waits.
  // A shop that offered a 150 six hours ago has rented it, and a thread paused
  // on a tap that is never coming is a dead thread the traveller cannot see.
  try {
    const stored = (state?.fields as { alternativeOffer?: { at?: number } } | undefined)
      ?.alternativeOffer;
    const { CHOICE_TTL_MS } = await import("../vehicle/substitution");
    digest.alternativeOffer =
      stored && typeof stored.at === "number" && Date.now() - stored.at < CHOICE_TTL_MS
        ? (stored as ThreadDigest["alternativeOffer"])
        : null;
  } catch {
    digest.alternativeOffer = null;
  }
  const session = await buildSession(input, io, verified);
  const text = input.event.kind === "inbound-text" || input.event.kind === "inbound-image"
    ? input.event.shopMessage ?? ""
    : "";
  // THE ONE DISCLOSURE GATE (parity with graph/nodes.ts:468). The primary
  // engine used to have no location facts at all, so `pickup-location` fell
  // through to `default: undefined` and the shop's "where are you?" went
  // unanswered. Composed ONLY from the server-verified stay - a client-posted
  // coordinate never reaches this.
  const { resolveShareableLocation } = await import("../location");
  const resolved = resolveShareableLocation(input.ctx.stay ?? null);
  const share = {
    addressText: resolved.addressText ?? undefined,
    mapsLink: resolved.mapsLink,
  };
  const tc: TurnContext = {
    session,
    share,
    thread: {
      threadKey: input.event.threadKey,
      vendorId: input.ctx.vendorId ?? "",
      shop: input.ctx.vendorName ?? input.ctx.vendorId ?? "shop",
      digest,
      // The once-latch that stops `present` re-marking an already-presented
      // deal on every later inbound (fields.presented is the durable truth).
      presented: Boolean((state?.fields as { presented?: boolean } | undefined)?.presented),
    },
    // Wall clock for the confirm-wait and recap-answer bounds. Live only -
    // replays leave it unset and keep pure turn arithmetic.
    nowMs: io.now(),
    // THE PERSONA AND THE REGION REACH THE ENGINE THAT ANSWERS SHOPS.
    // Both were wired only to the failover; see TurnContext.userKey.
    userKey: input.ctx.sender ?? undefined,
    region: input.ctx.region || undefined,
    ...(() => {
      const t = buildThreadTail(input);
      return { tail: t.tail, tailElided: t.elided };
    })(),
    // The gloss the app already paid for, finally reaching the composer.
    inbound: { text, english: (input.inboundEnglish ?? "").trim() || undefined, verified },
    legalMoves: [], // computed deterministically inside runTurn (legalMovesFor)
    guards: {
      floorPerDay: input.floorPrice,
      // THE OWNER'S POLICY, READ WHERE IT IS ACTUALLY USED.
      //
      // `maxRounds: 6` was a literal, and the graph spec's owner-editable
      // `maxRoundsPerShop` defaults to 4 - so the PRIMARY engine allowed 50%
      // more pushes per shop than the configured policy, and the Ops slider
      // that sets it moved only the failover engine. Same for the two below.
      //
      // Both reads are already 30s-cached (getGraphSpec / getPolicyOverlay) and
      // both fall back to the historical literal, so a config outage keeps
      // today's behaviour rather than adopting a different one.
      maxRounds: policy.maxRounds,
      priceFarAboveFloor: policy.overlay.priceFarAboveFloor,
      bannedPhrases: policy.overlay.bannedPhrases,
      // The printed-list clamp the graph engine has always had and this one
      // never did (see TurnContext.guards.sheetAnchor).
      sheetAnchor: policy.overlay.sheetAnchor,
    },
    event: input.event.kind === "tick" ? "tick" : "shop-message",
  };
  return { tc, state, comp };
}

/**
 * WRITE THE THREAD'S MEMORY BACK (W4.3 persistence + W4.5).
 *
 * Two separate gaps, one row.
 *
 * `negotiation_threads.fields.declined` / `.shopUnavailable` are what
 * /api/replies reads to tell the card "this shop passed" or "they have run
 * out", and the ONLY writer was `applyExtractionToState` - which lives on the
 * graph engine, the FAILOVER. SPTE is the engine that actually answers shops,
 * so on the live path those fields were never written and the card could not
 * say either thing, whatever the agent had understood.
 *
 * `fields.digest` is the durable half of the thread digest (W4.5). Without it
 * `buildDigest` restarted from empty every turn: no facts, so `hasClosed()` was
 * permanently false; no standing quote, so a shop that did not repeat its
 * number looked unquoted.
 *
 * Best-effort by construction. This runs AFTER the move is decided, where this
 * file's contract is that nothing throws - a throw here would risk the caller
 * failing over to the graph engine and sending the same message twice.
 */
async function persistThreadOutcome(args: {
  input: GraphTurnInput;
  io: GraphIO;
  prior: NegotiationThreadState | null;
  digest: ThreadDigest;
  verified: VerifiedExtraction;
  /** Where the turn's message ended up - a question that never left is not a
   *  question the card may claim we are waiting on. */
  delivered?: SpteLiveResult["delivered"];
  /** W4.6 - the thread's language decision after this turn. */
  language?: ThreadLanguage;
  /** The move this turn composed - "present" flips fields.presented so the
   *  funnel phase can reach "presented"/"complete". */
  move?: string;
}): Promise<void> {
  const { input, io, prior, digest, verified, delivered, language, move } = args;
  try {
    const { newThreadState, derivePhase, depositKnown, fulfillmentKnown } =
      await import("../graph/state");
    const base =
      prior ??
      newThreadState({
        threadKey: input.event.threadKey,
        userEmail: input.ctx.sender ?? "",
        vendorId: input.ctx.vendorId ?? "",
        vendorName: input.ctx.vendorName ?? "",
        toNumber: input.event.toDigits,
      });
    const fields = { ...base.fields };
    // PROJECT THE DEAL-TERM FIELDS, so the funnel phase can leave "negotiating".
    //
    // `derivePhase` reads depositType/depositNote, fulfillment, rounds and
    // presented off `fields` - but the ONLY writer of those was the graph
    // engine's `applyExtractionToState`, which the SPTE route makes unreachable
    // on an ordinary turn. So on the live engine every thread's phase was
    // mechanically pinned at "opening"/"negotiating" no matter how much the shop
    // had told us: the exact "stuck in negotiating" the owner reported. We
    // project the deal-term fields HERE (declined/price/tone stay owned by the
    // careful SPTE reads below - this is not a wholesale re-run of the graph
    // extraction). A fact stated on THIS turn comes from the extraction; a fact
    // stated on an EARLIER turn survives via the durable comprehension.
    const ex = input.extraction;
    if (ex?.depositType) {
      fields.depositType = ex.depositType;
      if (typeof ex.depositAmount === "number") fields.depositAmount = ex.depositAmount;
      fields.depositCurrency = ex.depositCurrency ?? fields.currency;
    }
    if (ex?.deposit) fields.depositNote = ex.deposit;
    if (ex?.pickupOffered === true) {
      fields.pickupOffered = true;
      if (!fields.fulfillment) fields.fulfillment = "pickup";
    }
    if (ex?.delivers === true) fields.fulfillment = "delivery";
    else if (ex?.onShopOnly === true && fields.fulfillment !== "delivery") fields.fulfillment = "on-shop";
    if (typeof ex?.deliveryFee === "number") fields.deliveryFee = ex.deliveryFee;
    // The durable comprehension carries deposit/fulfillment facts the shop stated
    // on EARLIER turns (this turn's extraction may be empty). OR them in so a
    // fact once learned survives a quiet turn and keeps the phase advanced.
    if (digest.depositKnown && !depositKnown(fields)) {
      const kind = digest.comprehension?.depositKind;
      fields.depositType =
        kind === "cash" || kind === "cash-or-document"
          ? "cash"
          : kind === "document"
            ? "passport"
            : kind === "card"
              ? "other"
              : kind === "none"
                ? "none"
                : fields.depositType;
      if (!fields.depositType) fields.depositNote = fields.depositNote ?? "stated";
    }
    if (digest.fulfillmentKnown && !fulfillmentKnown(fields)) {
      const mode = digest.comprehension?.handoverMode;
      fields.fulfillment =
        mode === "delivery" || mode === "both"
          ? "delivery"
          : mode === "pickup"
            ? "pickup"
            : "on-shop";
    }
    // Round count and firm count are the model's durable read; keep the higher of
    // the two sources so a projection can never walk them backwards.
    fields.rounds = Math.max(fields.rounds ?? 0, digest.round ?? 0);
    fields.firmCount = Math.max(fields.firmCount ?? 0, digest.firmCount ?? 0);
    // A PRINTED BOARD IS A FIRMER ANCHOR, AND IT HAS TO SURVIVE THE TURN.
    //
    // `applyExtractionToState` - the FAILOVER engine - has written these two
    // since they existed. SPTE re-derived the sheet price per turn from the
    // current frame and persisted neither, so from turn two onward the engine
    // that actually answers shops had no idea a board had ever been posted:
    // the printed-list clamp and the "what the photo showed" memory were both
    // absent from the only path a traveller is served by. Never walked
    // backwards - a board photographed once stays photographed.
    if (typeof verified.sheetPricePerDay === "number" && verified.sheetPricePerDay > 0) {
      fields.sheetPricePerDay = verified.sheetPricePerDay;
    }
    if (digest.mediaSummary) fields.mediaSummary = digest.mediaSummary.slice(0, 500);
    // A deal the agent PRESENTED to the traveller is past negotiation - and a
    // recap the SHOP has confirmed is presented by definition (step 8): the
    // confirm turn already marked the offer presentable, so the phase and the
    // UI flip together off the same digest fact.
    if (move === "present" || digest.recapConfirmedAt != null) fields.presented = true;
    fields.digest = persistableDigest(digest);
    // The vehicle this thread negotiates (owner report 6 C4): the thread key
    // is user:number with no vehicle dimension, so the sessionTable's rival
    // join needs a declared key to keep a car hunt's price out of a scooter
    // hunt's leverage.
    fields.vehicleKey = vehicleKeyFor(input.rfq);
    // WHICH LANGUAGE THIS THREAD IS IN, AND WHY (W4.6). The one field
    // /api/replies reads to tell the card and the status panel "Switched to
    // English - this shop asked". Written unconditionally so the decision is a
    // stored fact rather than something re-derived from the last two messages
    // on every single turn.
    if (language) fields.language = language;

    // A THREAD IS DEAD ONLY WHILE IT STAYS DEAD. Same rule the graph engine
    // applies: a fresh, concrete price on a declined thread is a re-engagement
    // ("ok ok, 250 is fine, come"), and it clears the flag rather than leaving
    // the card frozen on a goodbye the shop has taken back.
    const freshPrice = typeof input.usablePrice === "number" && input.usablePrice > 0;
    if (verified.declined === true || verified.deflected === true) fields.declined = true;
    else if (freshPrice && base.fields.declined === true) fields.declined = false;

    if (typeof verified.shopUnavailable === "boolean") {
      fields.shopUnavailable = verified.shopUnavailable;
      fields.restockHint = verified.shopUnavailable ? verified.restockHint : undefined;
    }
    if (typeof input.usablePrice === "number" && input.usablePrice > 0) {
      fields.pricePerDay = input.usablePrice;
      // A RESOLVED CURRENCY IS NEVER OVERWRITTEN BY A GUESS. The tick and
      // user-action paths used to resolve USD for any region the geocoder
      // labelled without a country token ("Ao Nang", "Canggu", raw coords), and
      // this line then wrote that USD over the correct value the inbound path
      // had already established from the shop's phone prefix. One tick was
      // enough to turn a THB thread into a dollar thread for good.
      if (input.currency) fields.currency = input.currency;
      // Provenance travels with the number (owner report 6 C3): without it,
      // the thread row wins the sessionTable merge and a divided package
      // per-day re-enters every sibling as a quoted daily rate.
      if (typeof input.priceBasisDays === "number" && input.priceBasisDays > 0) {
        fields.priceBasisDays = input.priceBasisDays;
      } else {
        delete fields.priceBasisDays;
      }
    }
    // WHAT THE CARD SHOWS WHILE THE AGENT WAITS ON AN ANSWER (W4.4). Only for a
    // question that actually reached the shop: "blocked" and "failed" mean
    // nobody was asked anything.
    //
    // ...BUT DELIVERY IS ONLY ASKED ON THE TURN THAT ASKS. Every turn after it -
    // a scheduled tick, a swarm poke, an unrelated inbound - delivers nothing,
    // so `asked` was false and this field was blanked while the engine was
    // still, correctly, waiting. The card then dropped its "double-checking
    // with the shop" chip and read as though the agent had moved on, which is
    // the same class of dishonesty as a stale price: the traveller is told the
    // thread is doing something other than what it is doing. Once the question
    // has reached the shop, the chip belongs to the WAIT (which is durable on
    // the digest), not to this turn's delivery.
    const asked =
      delivered === undefined || delivered === "sent" || delivered === "queued" || delivered === "held";
    const alreadyAsked = Boolean(
      (base.fields as { awaitingConfirmation?: { subject?: string } } | undefined)
        ?.awaitingConfirmation
    );
    fields.awaitingConfirmation =
      digest.awaitingConfirmation && (asked || alreadyAsked)
        ? {
            subject: digest.awaitingConfirmation.subject,
            question: digest.awaitingConfirmation.question.slice(0, 220),
            // Keep the ORIGINAL asked-at through the wait - restamping it every
            // tick would make a three-turn wait look permanently brand new.
            at:
              (base.fields as { awaitingConfirmation?: { at?: string } } | undefined)
                ?.awaitingConfirmation?.at ?? new Date(io.now()).toISOString(),
          }
        : undefined;

    const next: NegotiationThreadState = { ...base, fields };
    next.phase = derivePhase(next);
    await io.saveState(next);
  } catch {
    /* memory is an enhancement to the turn, never a condition of it */
  }
}

/**
 * THE PRIMARY ENGINE FINALLY SPEAKS THE LOCAL LANGUAGE (W4.6).
 *
 * `localizeMessage` was imported nowhere under src/lib/spte. SPTE is the engine
 * that actually answers shops - `engineV3Enabled` returns true even when config
 * is unreadable, and engine-route demoted the graph engine to failover - so
 * EVERY message the live path sent went out in English, and the Ultra
 * local-language feature ran only on the two engines that almost never run.
 * That is not a switch that was off; it is a feature that was never wired to
 * the thing it describes.
 *
 * Parity with the graph engine's `localize` tail gate, deliberately, so the two
 * engines cannot drift again:
 *   - the COUNTRY comes from the shop's own phone number when the thread has no
 *     region label (`countryForShop`) - the label-only lookup was the
 *     4-country ceiling that sent English to every +52/+51/+90 shop;
 *   - the number-integrity rail is `localizeMessage`'s own (it refuses a
 *     rewrite whose 3+ digit numbers drifted, retries once, then falls back to
 *     English that at least quotes the right figure), re-asserted here so a
 *     future change to that function cannot silently ship a drifted price in a
 *     script the traveller cannot proofread;
 *   - a fallback emits the same honest `localize-fallback` event, with this
 *     path named;
 *   - the English gloss is returned so the caller can stamp it on the outbound
 *     row as `raw.englishGloss`, which is what W1.5 already renders everywhere.
 *
 * NEVER throws and never blocks a send: every failure returns the English text.
 */
async function localizeSpteOutbound(args: {
  text: string;
  input: GraphTurnInput;
  io: GraphIO;
  language: ThreadLanguage;
  /** Wall-clock left in this serverless turn. */
  remainingMs: number;
}): Promise<{ text: string; gloss?: string; skipped?: string }> {
  const { text, input, io, language } = args;
  const fallbackEvent = async (reason: string, region?: string) => {
    await io
      .recordEvent?.({
        kind: "localize-fallback",
        vendorId: input.ctx.vendorId,
        vendorName: input.ctx.vendorName ?? input.event.toDigits,
        userEmail: input.ctx.sender,
        toDigits: input.event.toDigits,
        detail: JSON.stringify({ reason, region: region ?? null, path: "spte-reply" }).slice(0, 500),
      })
      .catch(() => {});
  };
  try {
    // THE THREAD'S OWN DECISION OUTRANKS THE HUNT'S SETTING. A shop that asked
    // for English gets English until they ask otherwise - that is the whole
    // point of persisting the switch rather than re-deriving it per turn.
    if (threadWritesEnglish(language)) return { text, skipped: "thread-english" };
    const { localLanguageAllowed } = await import("../entitlements");
    if (!localLanguageAllowed({ requested: input.ctx.localLang, plan: input.ctx.plan })) {
      return { text, skipped: "not-entitled" };
    }
    // A LOCALIZE IS UP TO TWO LLM ROUND TRIPS (9s each). The reply path has a
    // hard serverless deadline and a message in English beats no message at
    // all, so the pass is skipped - honestly, with an event - when the budget
    // cannot hold it.
    if (args.remainingMs < 12_000) return { text, skipped: "budget" };
    const { countryForShop } = await import("../copy/region");
    const region = input.ctx.region || countryForShop(input.event.toDigits) || undefined;
    const street = await getGraphSpec()
      .then((spec) => spec.settings.streetLocal)
      .catch(() => true);
    const { localizeMessage } = await import("../agents");
    const localized = await localizeMessage(text, region, input.ctx.sender, street, {
      // W4.7: SPTE only ever runs on a turn INSIDE an open thread (an inbound
      // reply or a tick), so a greeting here is always a repeat greeting.
      greet: false,
    });
    if (localized.localized && localized.text && localized.text !== text) {
      // BELT AND BRACES on the one rail that matters. localizeMessage already
      // refuses a drifted rewrite; asserting it again here means a change to
      // that function can never quietly ship a wrong price to a shop.
      const { numbersPreserved } = await import("../integrity/translation");
      if (!numbersPreserved(text, localized.text)) {
        await fallbackEvent("numbers-drifted", region);
        return { text, skipped: "numbers-drifted" };
      }
      return { text: localized.text, gloss: localized.english ?? text };
    }
    if (!localized.localized && localized.reason && localized.reason !== "english-region") {
      await fallbackEvent(localized.reason, region);
    }
    return { text, skipped: localized.reason };
  } catch {
    // A localization is an enhancement to a message, never a condition of it.
    return { text: args.text, skipped: "threw" };
  }
}

/**
 * Run ONE live SPTE turn. Throws ONLY from the pre-send context build (so the
 * caller's graph-engine fallback is always safe). After runTurn decides the
 * move, the send + wakeups + telemetry are best-effort and never throw.
 */
export async function runSpteLiveTurn(input: GraphTurnInput, io: GraphIO): Promise<SpteLiveResult> {
  // Turn wall-clock, stamped on the telemetry event -> the response-latency KPI.
  const startedAt = Date.now();
  // ---- pre-send (fallible): build the blackboard context + run the pass ------
  const { tc, state: priorState, comp } = await buildTurnContext(input, io);

  // WHAT THE LAST MOVE ACHIEVED. The learning update needs the shop's ANSWER,
  // so it is credited one turn late - the digest still holds the quote the shop
  // was on before this reply, and the extraction holds the one it just gave.
  // Best-effort and awaited only because it is a memory write, not a send: it
  // can never fail the turn (see lib/learning/outcomes).
  {
    const { learnFromReply } = await import("../learning/outcomes");
    const { lastMove } = await import("../learning/last-move");
    const played = await lastMove(input.ctx.sender ?? "", input.event.toDigits);
    await learnFromReply({
      tacticId: played?.tacticId,
      previousQuote: tc.thread.digest.quotedPricePerDay,
      newQuote: tc.inbound.verified.pricePerDay,
      // WHICH PHRASING EARNED THE CONCESSION (owner report 5 #2, second half).
      // The arm was stamped on the outbound row this reply is answering, so the
      // credit lands on the phrasing that was actually used, not on the move
      // name both arms share.
      askVariant: played?.askVariant,
    }).catch(() => null);
  }

  // ---- STEP 8: DID THE SHOP CONFIRM THE RECAP? (funnel: shop_confirmed) -----
  //
  // Runs BEFORE the turn so the policy sees the confirmation when it decides
  // the move. Two readers, in order of trust:
  //   - DETERMINISTIC correction: a fresh verified quote that differs from the
  //     standing one on an unconfirmed recap is the shop amending the terms -
  //     the latch re-opens for ONE amended recap (recapAmended bounds it) and
  //     the new number flows through the ordinary digest merge.
  //   - The ConfirmAnswer read (the same schema-validated judgement the
  //     confirm-wait uses): "yes correct", "ok see you", a thumbs-up sentence
  //     all confirm; talking about something else does not. On yes: the clock
  //     stamps, the funnel reaches shop_confirmed, and the offer is marked
  //     presentable - fields.presented flips in persistThreadOutcome off the
  //     same digest fact, so every surface agrees.
  // Internally total: an outage reads as "not confirmed yet" and the recap
  // wall-clock bound (policy) eventually presents with the honest caveat.
  if (
    tc.thread.digest.recapSent &&
    tc.thread.digest.recapConfirmedAt == null &&
    tc.event === "shop-message" &&
    tc.inbound.text.trim()
  ) {
    try {
      const dg = tc.thread.digest;
      const freshQuote = tc.inbound.verified.found ? tc.inbound.verified.pricePerDay : undefined;
      const priceCorrected =
        typeof freshQuote === "number" &&
        typeof dg.quotedPricePerDay === "number" &&
        freshQuote !== dg.quotedPricePerDay;
      if (priceCorrected && !dg.recapAmended) {
        dg.recapSent = undefined;
        dg.recapSentAt = undefined;
        dg.recapAmended = true;
      } else if (!priceCorrected) {
        const { readConfirmAnswer } = await import("../semantic/classifiers");
        const read = await readConfirmAnswer(
          "We recapped the agreed rental terms (price, length, deposit, handover) and asked the shop to confirm they are all correct.",
          tc.inbound.text,
          undefined,
          { budgetMs: 6_000 }
        ).catch(() => null);
        if (read?.value?.answered && !read.value.stillUnclear) {
          dg.recapConfirmedAt = io.now();
          const { advanceThreadStage } = await import("../funnel/stages");
          await advanceThreadStage(
            {
              userEmail: input.ctx.sender ?? "",
              toNumber: input.event.toDigits,
              vendorId: input.ctx.vendorId,
              vendorName: input.ctx.vendorName,
              transport: "evolution",
              engine: "v3",
            },
            "shop_confirmed",
            "shop confirmed the recap"
          ).catch(() => {});
          await io
            .markPresentable({
              userEmail: input.ctx.sender,
              vendorId: input.ctx.vendorId,
              fulfillment: priorState?.fields.fulfillment ?? null,
            })
            .catch(() => {});
        }
      }
    } catch {
      /* not confirmed yet - the wall-clock bound is the net */
    }
  }

  const outcome = await runTurn(tc); // never throws, never silent on a composable move

  // ---- from here we OWN the turn: never throw (would risk a double send) -----
  const senderKey = input.ctx.sender ?? "system";
  const toNumber = input.event.toDigits;
  // THE OPS PANEL COULD NOT EXPLAIN A SINGLE MESSAGE THE PRIMARY ENGINE SENT.
  //
  // "Why behind this message" joins `whatsapp_messages.raw.decisionId` to
  // `agent_traces.decision_id`. The graph engine stamps both. SPTE - which is
  // the engine that actually runs, since `engineV3Enabled` returns true even
  // when config is UNREADABLE - stamped neither and wrote zero trace rows. Its
  // entire record of a turn was one `agent_events` row whose reasoning is
  // capped at 180 characters.
  //
  // So the owner's request in item 16 - "record the path of each reply from the
  // agent's thinking all the way to WhatsApp" - was not a missing feature so
  // much as a missing KEY: the surfaces existed and had nothing to join on.
  const decisionId = newDecisionId();
  // WHICH PHRASING ARM THIS THREAD IS IN (owner report 5 #2, second half).
  //
  // Stamped on the OUTBOUND row, not only on the telemetry: `lastTacticId`
  // reads the newest outbound row to decide which move the shop's next reply is
  // answering, and that is the exact join the attribution needs. Without the
  // arm on that row the concession detector can say "the bargain worked" and
  // never which bargain it was.
  const askVariant = askVariantFor(input.event.threadKey);
  const meta: Record<string, unknown> = {
    kind: metaKindFor(outcome.move),
    vendorId: input.ctx.vendorId,
    vendorName: input.ctx.vendorName,
    engine: "v3",
    move: outcome.move,
    tacticId: outcome.move,
    // Only a bargain is in the experiment; labelling a deposit probe with an
    // arm would credit that arm for a concession it never asked for.
    ...(outcome.move === "bargain"
      ? {
          askVariant,
          // THE DISCRIMINATOR ITSELF. "Did we name a number" is exactly what
          // separates the two arms, and `counterPricePerDay` is the pass's own
          // structured answer to it - so the label needs no text parsing and
          // cannot disagree with what was sent.
          counterPricePerDay: outcome.artifact.counterPricePerDay ?? null,
        }
      : {}),
    decisionId,
    // The freshness fingerprint - see wa/freshness.ts. A parked reply carries
    // what it was an answer to, so the drain can tell whether it still is one.
    composedAgainst: {
      inboundId: input.ctx.inboundId,
      inboundAt: new Date(startedAt).toISOString(),
      quotePerDay: tc.inbound.verified.pricePerDay,
      stockState: tc.inbound.verified.shopUnavailable ? "out-of-stock" : "unknown",
      move: outcome.move,
    },
  };

  // THE FULL REASONING, UNDER THAT KEY. The `engine-v3-turn` event stays as the
  // cheap always-on summary (metrics first, 1600 chars, reasoning clipped to
  // 180); this is the durable record the review console reads. Best-effort and
  // never awaited into the send path: a lost trace is a blind spot, while a
  // throw here would cost a negotiation turn that has already been decided.
  //
  // Wrapped in a resolved promise rather than called bare: this runs AFTER the
  // move is decided, where this file's contract is that nothing throws (a throw
  // here risks the caller falling back to the graph engine and sending twice).
  // A bare `io.writeTrace(...)` throws SYNCHRONOUSLY when the io object does not
  // implement it, which `.catch()` cannot catch.
  void Promise.resolve()
    .then(() =>
      io.writeTrace([
      {
        decisionId,
        userEmail: input.ctx.sender ?? undefined,
        vendorId: input.ctx.vendorId,
        vendorName: input.ctx.vendorName,
        stage: `spte:${outcome.move}`,
        // A STABLE DECISION IDENTITY, so owner branch verdicts COMPILE. The
        // learning compiler aggregates agent_reviews per edge_id, and the review
        // route denormalizes edge_id from this very trace row - with it null,
        // every review of a production (SPTE) turn was dropped by the compiler
        // and edgePriorLines was dead on live traffic. `spte:<move>` is the
        // engine's real branching unit; the compiler renders it as
        // "move <x> (primary engine)".
        nodeId: "spte",
        edgeId: `spte:${outcome.move}`,
        input: JSON.stringify({
          inboundId: input.ctx.inboundId,
          inbound: tc.inbound.text,
          quotePerDay: tc.inbound.verified.pricePerDay,
          floor: input.floorPrice ?? null,
          lowest: tc.session.lowest?.pricePerDay ?? null,
          legalMoves: tc.legalMoves,
        }),
        reasoning: outcome.artifact?.think ?? "",
        output: outcome.text ?? "",
        verdict: outcome.move,
      },
      ])
    )
    .catch(() => {});

  let delivered: SpteLiveResult["delivered"] = "silent";
  // WHERE THE MESSAGE ENDED UP, when it did not go out. `delivered` is written
  // once into the turn detail at compose time and agent_events is append-only,
  // so a turn parked at 12:23 reads `queued` forever - which is a display bug
  // that has been read as a delivery bug more than once. Ops can now join to
  // the row and render what it is ACTUALLY doing right now.
  let outboxRowId: number | null = null;
  // ---- W4.6: WHICH LANGUAGE THIS THREAD IS IN --------------------------------
  //
  // A DECISION, not a per-turn recomputation. `nextThreadLanguage` changes it
  // only on an EXPLICIT statement the comprehension pass read ("sorry, I don't
  // speak Thai", "English please") - a shop merely replying in English changes
  // nothing, which is the inversion owner report 5 item 15 asked for. Ticks are
  // guarded inside the doctrine, so both engines behave the same on one (the
  // graph engine guarded ticks and the legacy loop did not).
  const langOutcome = nextThreadLanguage({
    persisted: threadLanguageFromStored(priorState?.fields?.language),
    statement: comp?.languageRequest,
    isTick: input.event.kind === "tick",
    localRequested: Boolean(input.ctx.localLang),
    now: io.now(),
  });

  // PRESENT IS STATE-ONLY (the graph node's own rule, finally on the live
  // path): it marks the deal presentable to the TRAVELLER and sends NOTHING.
  // Its composed text used to go out through guardAndSend to the SHOP - an
  // internal "state the deal so the traveller can decide" note, transmitted to
  // the counterparty under a haggling prompt. The shop-facing half of the
  // presentation family is `verify-recap`, which has its own template.
  let send =
    outcome.text && outcome.move !== "silent" && outcome.move !== "present"
      ? outcome.text
      : undefined;
  if (outcome.move === "present") {
    await io
      .markPresentable({
        userEmail: input.ctx.sender,
        vendorId: input.ctx.vendorId,
        fulfillment: priorState?.fields.fulfillment ?? null,
      })
      .catch(() => {});
  }

  if (send) {
    // THE PRIMARY ENGINE LOCALIZES (W4.6). Before the human pause, so the pause
    // is computed from what is actually left, and before the guard, because
    // guardOutbound is where the message becomes final.
    const local = await localizeSpteOutbound({
      text: send,
      input,
      io,
      language: langOutcome.language,
      remainingMs: input.deadlineAt - io.now(),
    });
    send = local.text;
    // The gloss rides the outbound row as `raw.englishGloss` (guardAndSend
    // spreads `meta` into `raw`), which is the field W1.5 already renders in
    // the thread peek, the activity feed, the deals view and the Ops
    // transcript. Without it a localized reply was unreadable to the traveller
    // whose name it went out in.
    if (local.gloss) meta.englishGloss = local.gloss;
    meta.localized = Boolean(local.gloss);
    meta.language = langOutcome.language.mode;
    // LIVE TAIL GATES (graph parity, the audit's "never run on the live
    // engine" pair): the global-uniqueness re-vary (hundreds of users must
    // never repeat a sentence - a fleet-level anti-ban property that only
    // protected the failover) and the warm-emoji tone policy. Localized
    // output skips the English trigram store but keeps the emoji policy,
    // exactly like the graph path. Deterministic re-vary never touches
    // digits, so the rails' number verification survives it. Best-effort:
    // the gates are polish, never the send.
    // WHOSE MESSAGE THIS IS, AND WHETHER THIS SHOP USES EMOJI AT ALL.
    //
    // The emoji rule appended one to EVERY outbound message, which is itself
    // the fleet pattern it was meant to soften - and it overrode a persona that
    // may have drawn "never". It now takes the traveller's own appetite, a read
    // of whether THIS shop has used an emoji with us (people mirror), and a
    // deterministic seed so a re-park composes the same bytes.
    const emojiTone = await (async () => {
      const { hasEmoji } = await import("../graph/uniqueness");
      const { voiceProfileFor } = await import("../voice");
      const shopUsesEmoji = (input.priorInbound ?? []).some((m) => hasEmoji(m));
      return {
        appetite: input.ctx.sender ? voiceProfileFor(input.ctx.sender).emoji : undefined,
        shopUsesEmoji,
        seed: `${input.event.threadKey}|${tc.thread.digest.round ?? 0}|${outcome.move}`,
      };
    })();
    try {
      const spec = await getGraphSpec();
      if (!local.gloss) {
        const recent = await io.recentOutboundGlobal(6, 200).catch(() => []);
        const { ensureGloballyUnique, enforceEmojiTone } = await import("../graph/uniqueness");
        const fresh = await ensureGloballyUnique(send, recent);
        send = enforceEmojiTone(fresh.text, spec.settings.emojiTone, emojiTone);
      } else {
        const { enforceEmojiTone } = await import("../graph/uniqueness");
        send = enforceEmojiTone(send, spec.settings.emojiTone, emojiTone);
      }
    } catch {
      /* gates are polish - the decided message still goes out */
    }
    try {
      // INLINE DELIVERY (the "agent never replies" structural fix): the reply
      // leaves in the SAME serverless invocation that received the shop's
      // message. The old path parked it 18-45s out and depended on a later
      // drain invocation + a live Evolution host - which in live testing left
      // replies stuck as "queued". Now: a bounded human thinking pause (never
      // blowing the serverless budget), then guardAndSend directly - the guard
      // still paces per-recipient, and on a guard block or transient send
      // failure guardAndSend itself queues/re-queues, so nothing is lost.
      if (input.humanDelay) {
        const remaining = input.deadlineAt - io.now();
        const pauseMs = Math.max(0, Math.min(10_000, remaining - 20_000));
        if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
      }
      const res = await io.guardAndSend({ senderKey, toNumber, text: send, meta, shopOpenNow: input.shopOpenNow });
      delivered = res.delivered;
      outboxRowId = res.outboxRowId ?? null;
    } catch {
      // Post-decision send failure: park it so the drain retries, never re-run
      // the whole turn (that path belongs to the pre-send fallback only).
      try {
        await io.queueOutbox({
          senderKey,
          toNumber,
          body: send,
          notBeforeMs: io.now() + 30_000,
          meta: { ...meta, reason: "reply re-queued after send error" },
        });
        delivered = "queued";
      } catch {
        delivered = "failed";
      }
    }
  }

  // ---- WALL-CLOCK STAMPS for the two waits (steps 7-8 + confirm-wait) -------
  //
  // Stamped on the digest BEFORE persistThreadOutcome writes it, and only on a
  // delivery that actually reached the wire (queued/held count - the drain
  // delivers them verbatim). These are what the wall-clock bounds in policy.ts
  // and advanceConfirmState measure against; without them a shop that never
  // replies freezes the thread forever (the confirm-wait finding).
  const reachedWire = send && delivered !== "blocked" && delivered !== "failed";
  if (reachedWire && outcome.move === "verify-recap") {
    outcome.digest.recapSentAt = io.now();
  }
  if (reachedWire && outcome.move === "confirm") {
    const w = outcome.digest.pending?.find((p) => p.state === "waiting");
    if (w && w.at == null) w.at = io.now();
  }
  // ---- THE CONCESSION LADDER'S MEMORY ---------------------------------------
  //
  // What we actually ASKED this shop for, read off the wire. The live engine's
  // ask was a flat 15% off whatever the shop had just said, recomputed from
  // scratch every turn, so a firm shop got the identical number three rounds
  // running. `computeRoundTarget` fixes that but needs `lastTarget`, and the
  // engine that answers shops was persisting nothing of the sort.
  //
  // Measured, not asserted, for the same reason `citedRival` is: the model may
  // have ignored the target we handed it. The lowest MONEY numeral strictly
  // below the standing quote is our ask - any rival we cite sits above it by
  // construction, because the ladder beats a rival rather than matching it.
  if (reachedWire && send && outcome.move === "bargain") {
    const standing = quoteOnTable(tc);
    if (typeof standing === "number" && standing > 0) {
      const asks = findNumerals(normalizeDigits(send))
        .filter((n) => n.money && n.value > 0 && n.value < standing)
        .map((n) => n.value);
      if (asks.length) outcome.digest.lastAskPerDay = Math.min(...asks);
    }
  }

  // ---- judge enqueue (never inline - a cheap later invocation grades it) -----
  //
  // The graph engine has sampled every delivery into a {kind:"judge"} wakeup
  // since the judge existed - but SPTE, the engine that actually runs, never
  // enqueued one, so `agent_scores` was EMPTY for all real traffic and every
  // surface built on it (Studio Scores, judge calibration, the chief-judge
  // thread verdicts, tactic learning's realized outcomes) read a structural
  // zero. Same shape as the graph's gate: sampled by the spec's
  // judgeSampleRate; skip blocked/failed deliveries (nothing reached the shop
  // to grade - queued/held WILL go out verbatim, so those are gradable); skip
  // the farewell (the graph excludes "deal-close" for the same reason - a
  // goodbye is not a negotiation move a rubric can score). The payload matches
  // runJudgeJob's contract exactly: `text` is required, decisionId joins the
  // score to this turn's trace row, nodeId/tacticId mirror what writeTrace
  // stamped above so the review console and the compiler see one identity.
  if (send && delivered !== "blocked" && delivered !== "failed" && outcome.move !== "farewell") {
    const sampleRate = await getGraphSpec()
      .then((spec) => spec.settings.judgeSampleRate)
      // The default spec's own value (default-graph.ts): config-unreadable
      // must not silently turn the judge off.
      .catch(() => 1);
    if (Math.random() < sampleRate) {
      await io
        .insertWakeup({
          kind: "judge",
          threadKey: input.event.threadKey,
          notBefore: new Date(io.now() + 90_000).toISOString(),
          payload: {
            decisionId,
            nodeId: "spte",
            tacticId: outcome.move,
            text: send,
            kind: outcome.move,
            userEmail: input.ctx.sender,
            vendorId: input.ctx.vendorId,
            vendorName: input.ctx.vendorName,
          },
        })
        .catch(() => {});
    }
  }

  // THE THREAD REMEMBERS THIS TURN (W4.3 + W4.5).
  //
  // AFTER the send, deliberately, for two reasons. It is three Supabase round
  // trips (the optimistic-version dance in graph/state) and the reply path has
  // a latency budget the traveller can feel; and `awaitingConfirmation` is a
  // claim that we ASKED the shop something - a card that says "double-checking
  // with the shop" about a message the guard blocked would be a lie.
  //
  // A PRICED THREAD MUST ALSO BE ABLE TO COME BACK (owner report 5 #9).
  //
  // The block further down schedules a return for a thread with NO price. A
  // thread that HAS one schedules nothing at all - the only other wakeup is the
  // model's own strategic pause, clamped to three minutes because it is a
  // pause-before-replying tactic, not a re-entry. Three minutes cannot span the
  // gap between an expensive quote at 10:00 and a cheaper one landing at 10:20,
  // and that gap is exactly where the owner's "we are not bargaining enough"
  // lives: the shop at 300 never heard about the 200 because no turn ever
  // happened in which it could be said.
  //
  // So a thread that is priced, still open and NOT the session's best price
  // arms ONE long watch. When it fires, the ordinary policy decides - if a
  // cheaper rival has landed by then the rival card is live and the bargain is
  // legal; if nothing changed the turn goes silent and costs nothing.
  //
  // ONCE, EVER, and the bound is durable (digest.priceWatchArmed). Without it
  // every re-entered silent-and-priced turn would arm another watch and the
  // negotiator would become a slow broadcast loop - which is the failure mode
  // this whole feature has to be designed against, not the one it creates.
  const pricedNow = tc.inbound.verified.pricePerDay ?? tc.thread.digest.quotedPricePerDay;
  const sessionLow = tc.session.lowest?.pricePerDay;
  const armPriceWatch =
    !outcome.digest.priceWatchArmed &&
    typeof pricedNow === "number" &&
    pricedNow > 0 &&
    // Being the cheapest shop in the hunt is not a position to re-open: there
    // is no rival that could arrive to argue with (spte/policy's lockedAtFloor
    // and negotiation/leverage's isSessionLow make the same ruling).
    (typeof sessionLow !== "number" || pricedNow > sessionLow) &&
    (tc.thread.digest.firmCount ?? 0) < 2 &&
    !tc.inbound.verified.declined &&
    !tc.inbound.verified.deflected &&
    !tc.inbound.verified.shopUnavailable;
  if (armPriceWatch) outcome.digest.priceWatchArmed = true;
  // ...and the ONCE-PER-THREAD owe-watch: a delivered PROBE whose answer never
  // comes causes no turn, and with no turn no bound is ever evaluated (the
  // priced-dead-end freeze). Flag set HERE - before the digest is persisted -
  // for the same reason priceWatchArmed is; the wakeup itself is inserted in
  // the wakeup section below.
  const armOweWatch =
    reachedWire &&
    (outcome.move === "deposit-probe" ||
      outcome.move === "fulfillment-probe" ||
      outcome.move === "option-probe" ||
      outcome.move === "confirm-vehicle" ||
      outcome.move === "clarify") &&
    !outcome.digest.oweWatchArmed;
  if (armOweWatch) outcome.digest.oweWatchArmed = true;

  // Awaited, not detached: Cloud Run freezes the CPU the moment the response
  // flushes, so a detached write is a write that may never happen. Internally
  // total - it can never fail a turn that has already been sent.
  await persistThreadOutcome({
    input,
    io,
    prior: priorState,
    digest: outcome.digest,
    verified: tc.inbound.verified,
    delivered,
    move: outcome.move,
    // W4.6: the language SWITCH is durable. Persisted whenever the thread has a
    // decision at all (not only when it changed), so a row written before this
    // existed adopts the hunt's setting once and stops re-deriving it.
    language: langOutcome.language,
  });

  // ---- FUNNEL LEDGER: what this TURN proved (src/lib/funnel/stages.ts) -------
  //
  // The comprehension stamps (replied/understood/price_received and the
  // laterals) happen upstream where the reply was read; the ENGINE's moves are
  // the evidence for the negotiation rungs, so they stamp here. One progression
  // stamp per turn - the highest stage the turn supports - and all three rungs
  // are gated on a standing quote, because negotiating/terms without a price on
  // the table would overstate the funnel (terms can be learned pre-price; the
  // ladder claims them only once the money conversation exists). Best-effort
  // and deduped inside advanceThreadStage; never on the throw path.
  {
    const quoted = (outcome.digest.quotedPricePerDay ?? 0) > 0;
    const askedTerms =
      outcome.move === "deposit-probe" ||
      outcome.move === "fulfillment-probe" ||
      outcome.move === "pickup-location";
    const recapDelivered =
      outcome.move === "verify-recap" && delivered !== "blocked" && delivered !== "failed";
    const stage = !quoted
      ? undefined
      : recapDelivered
        ? ("verifying" as const)
        : outcome.digest.depositKnown && outcome.digest.fulfillmentKnown
          ? ("terms_collected" as const)
          : askedTerms
            ? ("terms_pending" as const)
            : outcome.move === "bargain" || (outcome.digest.round ?? 0) > 0
              ? ("negotiating" as const)
              : undefined;
    if (stage) {
      const { advanceThreadStage } = await import("../funnel/stages");
      await advanceThreadStage(
        {
          userEmail: input.ctx.sender ?? "",
          toNumber: input.event.toDigits,
          vendorId: input.ctx.vendorId,
          vendorName: input.ctx.vendorName,
          decisionId,
          transport: "evolution",
          engine: "v3",
        },
        stage,
        stage === "verifying"
          ? "verify-recap sent to the shop"
          : stage === "terms_collected"
            ? "deposit and handover both known"
            : stage === "terms_pending"
              ? `asked the shop (${outcome.move})`
              : `bargaining (round ${outcome.digest.round ?? 0})`,
        { overridesOutOfStock: tc.inbound.verified.shopUnavailable === false }
      ).catch(() => {});
    }
  }

  // Strategic wait (deliberate patience) -> a wakeup re-enters this thread later.
  // Clamped AGAIN here: this is the last gate before a durable not_before, and a
  // wait measured in hours is never a tactic, only a bug (the "until 08:28 AM"
  // incident on a thread the shop was actively typing in).
  // THE BEST SHOP JUST FELL OVER.
  //
  // A shop declining or running out is ordinary and stays in the app. The
  // CHEAPEST shop of the session doing it is a different event entirely: the
  // traveller's whole plan was that number, everything else on the board is
  // dearer, and the agent has nothing left to do about it. That is the
  // agent-blocked class - not news competing for attention, the system saying
  // it cannot continue without them.
  //
  // Ko Tao, 12:38: LLL had quoted 180, the best of the hunt, and withdrew. The
  // phone said nothing.
  if (
    input.ctx.sender &&
    (tc.inbound.verified.declined ||
      tc.inbound.verified.deflected ||
      tc.inbound.verified.shopUnavailable)
  ) {
    const low = tc.session.lowest;
    const mine = tc.inbound.verified.pricePerDay ?? tc.thread.digest.quotedPricePerDay;
    const wasBest =
      Boolean(low) &&
      (low!.vendorId === input.ctx.vendorId ||
        (typeof mine === "number" && typeof low!.pricePerDay === "number" && mine <= low!.pricePerDay));
    if (wasBest) {
      void (async () => {
        try {
          const { worthAnInterruption } = await import("../notify/significance");
          const { notifyState, markPushSent } = await import("../notify/state");
          const g = worthAnInterruption({ kind: "agent-blocked" }, await notifyState(input.ctx.sender!));
          if (!g.notify) return;
          const m = await import("../push");
          await m.sendPushToUser(input.ctx.sender!, {
            title: "Your best price just fell through",
            body: `${input.ctx.vendorName ?? "The cheapest shop"} is out - your agents are still on the others, but this one needs your call.`,
            url: "/",
            tag: `lost:${input.ctx.vendorId ?? "best"}`,
          });
          await markPushSent(input.ctx.sender!, `agent-blocked: ${g.reason}`);
        } catch {
          /* a notification is never worth breaking a turn for */
        }
      })();
    }
  }

  // A SILENT TURN ON A PRICELESS THREAD MUST STILL COME BACK.
  //
  // `silent` schedules nothing - it is the reflex for "nothing is owed", and
  // for a thread that has its price and its terms that is exactly right. But
  // the same move is also where a thread lands when the shop said something
  // the engine could not act on ("Sorry,we do already discount."), and there
  // it means the opposite: everything is still owed and there is no event
  // coming that will re-enter this thread. The shop has answered, so no
  // inbound is due; nothing else ticks a specific thread. It simply stops.
  //
  // That is the A & T thread on Ko Tao - 28 minutes of silence on a shop that
  // was one nudge away from a quote. So a silent turn with no price on the
  // table schedules its own return, and the move set it comes back to now
  // contains `momentum` (see policy.ts).
  //
  // Bounded by the same one-nudge rule downstream: the wakeup re-runs the
  // policy, and a thread that has already been nudged simply goes silent again
  // - once, this time for good.
  const silentAndPriceless =
    outcome.move === "silent" &&
    typeof (tc.inbound.verified.pricePerDay ?? tc.thread.digest.quotedPricePerDay) !== "number" &&
    !tc.inbound.verified.declined &&
    !tc.inbound.verified.deflected &&
    !tc.inbound.verified.shopUnavailable;
  const waitMinutes = clampWaitMinutes(outcome.waitMinutes) ?? (silentAndPriceless ? 3 : undefined);
  if (waitMinutes) {
    await io
      .insertWakeup({
        kind: "tick",
        threadKey: input.event.threadKey,
        notBefore: new Date(io.now() + waitMinutes * 60_000).toISOString(),
        payload: {
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          engine: "v3",
          // The feed reads this instead of inventing generic copy - so it has
          // to say which of the two this actually is.
          reason: silentAndPriceless
            ? `no price from them yet - checking back in ~${waitMinutes} min`
            : `giving the shop ~${waitMinutes} min before the next nudge`,
          vendorName: input.ctx.vendorName,
        },
      })
      .catch(() => {});
  }

  // ...AND THE LONG ONE. Deliberately separate from the clamped block above:
  // that clamp guards a MODEL-proposed pause (the "until 08:28 AM" incident),
  // and loosening it would give a hallucinated wait the run of the thread
  // again. This wait is the engine's own, its horizon is a fixed constant, and
  // it is armed at most once per thread.
  //
  // NOT gated on `!waitMinutes` any more: the flag was persisted as armed
  // either way, so a thread whose model happened to pause this turn recorded
  // "watch armed" with NO watch ever scheduled - once, ever, means it then
  // never could be. A short pause tick and the long watch coexist harmlessly
  // (the earlier one that finds nothing to say goes silent and costs nothing).
  if (armPriceWatch) {
    await io
      .insertWakeup({
        kind: "tick",
        threadKey: input.event.threadKey,
        notBefore: new Date(io.now() + PRICE_WATCH_MINUTES * 60_000).toISOString(),
        payload: {
          userEmail: input.ctx.sender,
          vendorId: input.ctx.vendorId,
          engine: "v3",
          reason: `watching for a better price elsewhere - back in ~${PRICE_WATCH_MINUTES} min`,
          vendorName: input.ctx.vendorName,
        },
      })
      .catch(() => {});
  }

  // A QUESTION ON THE WIRE IS OWED A RE-ENTRY (the confirm-wait and
  // priced-dead-end findings). A confirm or a verify-recap the shop ignores
  // causes NO turn, and with no turn neither the turn bound nor the wall-clock
  // bound is ever EVALUATED - the freeze was not the bound's size but the
  // absence of any turn to apply it in. So every delivered confirm/recap arms
  // one tick just past its wall-clock bound; and a delivered PROBE arms the
  // once-per-thread owe-watch (same doctrine as the price watch: one durable
  // re-entry, or the negotiator becomes a broadcast loop). The tick re-enters
  // through the same engine; if the shop answered meanwhile the ordinary flow
  // runs, and if not the bound releases / the recap rescue takes over.
  {
    const wantAnswerTick =
      reachedWire && (outcome.move === "confirm" || outcome.move === "verify-recap");
    if (wantAnswerTick || armOweWatch) {
      const { CONFIRM_WAIT_MS } = await import("./digest");
      const delayMs = wantAnswerTick ? CONFIRM_WAIT_MS + 5 * 60_000 : 35 * 60_000;
      await io
        .insertWakeup({
          kind: "tick",
          threadKey: input.event.threadKey,
          notBefore: new Date(io.now() + delayMs).toISOString(),
          payload: {
            userEmail: input.ctx.sender,
            vendorId: input.ctx.vendorId,
            engine: "v3",
            reason: wantAnswerTick
              ? "waiting for the shop's answer - checking back if it never comes"
              : "an open question is still unanswered - one check-back scheduled",
            vendorName: input.ctx.vendorName,
          },
        })
        .catch(() => {});
    }
  }

  // THE SIBLING RE-BARGAIN - the swarm behaviour `materialDrop` has promised in
  // its own docstring since the engine shipped ("the caller enqueues bounded
  // re-bargain wakeups for sibling threads") while its only consumers were a
  // telemetry field, an admin chip and the distiller.
  //
  // The bounds live in negotiation/rebargain, deliberately pure: dearest shops
  // first, at most four, never the shop that just quoted, never a thread that
  // has refused twice, never a dead one, and staggered so wa-guard is not
  // handed a burst. This is the difference between a negotiation swarm and a
  // broadcast engine, and it is why none of it is decided here.
  if (outcome.materialDrop && input.ctx.sender) {
    try {
      const newLow = tc.inbound.verified.pricePerDay;
      if (typeof newLow === "number" && newLow > 0) {
        const rows = await io
          .sessionTable(input.ctx.sender, input.ctx.vendorId ?? "", vehicleKeyFor(input.rfq), {
            engineSizeCc: input.rfq.engineSizeCc,
            durationDays: input.rfq.durationDays,
          })
          .catch(() => []);
        const { planSiblingRebargain } = await import("../negotiation/rebargain");
        const { threadKeyFor } = await import("../graph/state");
        const targets = planSiblingRebargain({
          rows,
          excludeVendorId: input.ctx.vendorId ?? "",
          newLowPerDay: newLow,
          currency: input.currency,
        });
        for (const t of targets) {
          await io
            .insertWakeup({
              kind: "tick",
              threadKey: threadKeyFor(input.ctx.sender, t.toNumber),
              notBefore: new Date(io.now() + t.delayMinutes * 60_000).toISOString(),
              payload: {
                userEmail: input.ctx.sender,
                vendorId: t.vendorId,
                vendorName: t.vendorName,
                engine: "v3",
                reason: `another shop just came in cheaper - going back to ${t.vendorName} with it`,
              },
            })
            .catch(() => {});
        }
        if (targets.length) {
          await io
            .recordEvent?.({
              kind: "swarm-rebargain",
              vendorId: input.ctx.vendorId,
              vendorName: input.ctx.vendorName,
              detail: JSON.stringify({
                newLow,
                currency: input.currency,
                targets: targets.map((t) => ({ shop: t.vendorName, at: t.pricePerDay, inMin: t.delayMinutes })),
              }).slice(0, 500),
            })
            .catch(() => {});
        }
      }
    } catch {
      /* the swarm is an enhancement to a turn that has already been decided */
    }
  }

  // TRANSPARENCY telemetry (feeds the Session Blackboard Inspector): the exact
  // move, model tier/provider, the private scratchpad, and the wire text.
  await io
    .recordEvent?.({
      kind: "engine-v3-turn",
      vendorId: input.ctx.vendorId,
      vendorName: input.ctx.vendorName,
      userEmail: input.ctx.sender,
      toDigits: input.event.toDigits,
      // BOUNDED BY FIELD, NEVER BY SLICE (clampTurnDetail): the old
      // stringify-then-slice cap cut mid-token, so any turn crossing 1600
      // chars stopped being JSON and silently dropped out of every metric -
      // and the crossers were exactly the degraded turns worth studying.
      detail: clampTurnDetail({
        move: outcome.move,
        tier: outcome.route.tier,
        provider: outcome.route.provider ?? null,
        // The provider's own failure reason when none answered. "no key" and
        // "every key is failing" used to look identical here.
        providerError: outcome.route.error ?? null,
        reason: outcome.route.reason,
        legalMoves: tc.legalMoves,
        floor: input.floorPrice ?? null,
        lowest: tc.session.lowest?.pricePerDay ?? null,
        rivals: tc.session.rivals.length,
        quote: input.usablePrice ?? null,
        materialDrop: outcome.materialDrop,
        delivered,
        outboxRowId,
        // I5 (owner report 6): a BLIND turn - an image arrived and the read
        // failed - was indistinguishable from a sighted one in this record,
        // so "the agent ignored the price board" and "the agent never saw
        // it" could not be told apart after the fact.
        imageUnread: tc.inbound.verified.imageUnread === true ? true : undefined,
        // Response latency (ms) for this turn - feeds the p50/p95 KPI. Only a
        // real reply that actually went out is a meaningful latency sample.
        latencyMs: delivered === "sent" ? Date.now() - startedAt : null,
        vehicleKey: vehicleKeyFor(input.rfq),
        // THE CONTAMINATION SENSOR (owner report 6 B5). The '5 days on a
        // 4-day search' bug was unreconstructable after the fact because no
        // turn record said which duration the turn believed. Now every turn
        // states its terms, so a drift shows in the record, not a screenshot.
        durationDays: input.rfq.durationDays ?? null,
        startDate: (input.rfq as { startDate?: string }).startDate ?? null,
        // WHICH LEVERAGE ACTUALLY GOT PLAYED. `leverageUsed` was written by the
        // model every turn and read by nobody, so "the agents never use the
        // other shop's price" could not be measured, only noticed.
        leverage: outcome.artifact.leverageUsed ?? [],
        // MEASURED ON THE WIRE, NOT ON THE MODEL'S WORD.
        //
        // This used to be `leverageUsed.includes("rival")` - a field the model
        // writes about itself, unvalidated. A draft could name 200 and report
        // [], or report ["rival"] and name nothing. Worse, `fallbackArtifact`
        // hard-codes `leverageUsed: []`, so the ONE path that cites the rival
        // deterministically always recorded citedRival:false. The instrument
        // that was supposed to answer "do the agents actually use the other
        // shop's price?" was measuring a self-report and reading the
        // best-behaved path as the worst.
        //
        // Now: did the text we actually SENT contain the cheapest rival's
        // number? Same tolerance as the cite-the-rival rail.
        citedRival: (() => {
          const rival = cheapestCheaperRival(tc.session.rivals, quoteOnTable(tc));
          if (!rival || !send) return false;
          const target = Math.round(rival.pricePerDay);
          // NORMALISED FIRST, because `send` is the LOCALIZED wire text. This
          // app deliberately supports Thai, Lao, Khmer and Myanmar numerals
          // (integrity/translation.ts folds all of them) precisely because a
          // translator is free to render a price in local script - and those
          // are the markets the local-language feature is SOLD for. A bare
          // ASCII \d therefore reported citedRival:false on every Ultra
          // local-language send: the owner's leverage KPI read zero exactly
          // where the leverage was working.
          //
          // ...AND THE NUMERAL HAS TO BE MONEY. A bare numeral scan counted
          // dates, durations and engine sizes: a send reading "for the 17 Aug"
          // recorded citedRival:true against a rival at 17/day, so the KPI that
          // answers "do the agents actually use other shops' prices" was
          // inflated by coincidence. Same tolerance, narrower question - and
          // the same helper the cite-the-rival rail now uses, so the rail and
          // the instrument can never disagree about what counts as a citation.
          return citesPrice(normalizeDigits(send), [target]);
        })(),
        // The shop's menu + what it sent, so the option and vision KPIs have a
        // source that is not a guess.
        // THE ROW THE A/B IS COMPUTED FROM (owner report 5 #2, second half).
        //
        // This blob already carried the move, rival availability, citedRival,
        // the quote and the wire text - everything except the one field that
        // separates "we named 210" from "we asked them to beat 250". Without
        // it the two phrasings were one indistinguishable statistic.
        // `variantOk` records whether the draft actually honoured its arm, so a
        // contaminated sample is visible rather than silently averaged in.
        askVariant: outcome.move === "bargain" ? askVariant : null,
        counterPricePerDay: outcome.artifact.counterPricePerDay ?? null,
        variantOk:
          outcome.move === "bargain"
            ? variantHonoured(askVariant, outcome.artifact.counterPricePerDay)
            : null,
        options: tc.thread.digest.options?.length ?? 0,
        hadImage: Boolean(tc.inbound.verified.hadImage),
        imageKind: tc.inbound.verified.imageKind ?? null,
        // WHAT THE COMPREHENSION PASS UNDERSTOOD, and what it cost. Without
        // these, "the agent misread them" is an anecdote: the stance it acted
        // on, the facts it did not trust, whether it ran at all, and its wall
        // clock against the reply budget are the four things Ops needs to tell
        // a bad reading from an outage from a timeout.
        stance: tc.inbound.verified.stance ?? null,
        deflected: Boolean(tc.inbound.verified.deflected),
        unsure: (tc.inbound.verified.uncertain ?? []).map((u) => u.subject),
        comprehension: comp ? (comp.degraded ? "degraded" : "ok") : "skipped",
        comprehensionMs: comp?.ms ?? null,
        standingQuote: tc.thread.digest.quotedPricePerDay ?? null,
        think: outcome.artifact.think?.slice(0, 180),
        text: send?.slice(0, 180) ?? null,
      }),
    })
    .catch(() => {});

  // THE SEMANTIC CORPUS, ENQUEUED - NOT EMBEDDED (lib/corpus/sidecar.ts).
  //
  // Here, after `delivered` is resolved and the telemetry is written, is the
  // last point in the turn where nothing can still affect what the shop
  // receives. This performs ONE insert of a row with embedding = null: no AI
  // call, no vector arithmetic, no Redis. The embedding itself happens on the
  // /api/wa/ping backfill, charged to nobody.
  //
  // Bounded twice over and awaited on purpose: the hook has its own 1.5s
  // ceiling (every sb* helper's timedFetch is 8s, far too long to spend after a
  // send) and refuses to start at all below 2s of remaining turn. Awaiting a
  // bounded promise is what makes the "adds no reply-path round trip" claim
  // testable - a floating promise would merely make it unobservable.
  //
  // What is stored is what the SHOP said, keyed by the inbound message id, so
  // the corpus row and the message row erase and prune together.
  await enqueueCorpus({
    sourceTable: "whatsapp_messages",
    sourceId: input.ctx.inboundId ?? "",
    text: tc.inbound.english?.trim() || tc.inbound.text,
    userEmail: input.ctx.sender ?? null,
    remainingMs: input.deadlineAt - io.now(),
  }).catch(() => "error" as const);

  return {
    ran: true,
    move: outcome.move,
    tier: outcome.route.tier,
    provider: outcome.route.provider,
    delivered,
    text: send,
  };
}
