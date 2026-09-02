// SPTE post-rails - the DETERMINISTIC, 0-token verification every drafted
// message passes before it can be sent. This is where price integrity and the
// protocol guarantees live: the LLM proposes text, these rails dispose.
//
// Reuses the exact same guards the graph engine used (checkOutboundNumbers,
// correctDuration) so a council-composed message is held to the same standard,
// plus the never-finalize-a-time protocol rule (Step 5).

import { checkOutboundNumbers, correctDuration, verbatimNumerals } from "../graph/guardrails";
import { rivalIdentityTokens, namesRival, cheapestCheaperRival } from "../negotiation/leverage";
import { citesAMatch } from "../negotiation/beat-rival";
import { inventsADate } from "../negotiation/traveller-disclosure";
import type { RailResult, TurnArtifact, TurnContext } from "./types";
import { quoteOnTable } from "./policy";
import { normalizeDigits } from "../integrity/translation";
import { citesPrice } from "../integrity/money-context";

// A drafted message must never AGREE a concrete pickup/delivery time - the
// traveller confirms that directly (Step 5 hard rule). These patterns catch an
// LLM that tried to lock a time.
const TIME_COMMIT_RX =
  /\b(see you|meet you|i'?ll be there|pick ?up at|come by at|let'?s meet|be there at)\b.*\b(\d{1,2}\s?(?:am|pm|:\d{2})|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const TIME_DEFER_LINE = " I'll confirm the exact time with you directly.";

// ONLY THE TRAVELLER MAY COMMIT, AND ONLY BY TAPPING LOCK THIS DEAL.
//
// The farewell rail below has always refused agreement language, but it only
// ran on three moves. Every other move - bargain, present, momentum, the
// deposit and pickup probes - could say "great, we'll take it" or "book it for
// me" and go straight out, from the traveller's own number, to a shop that then
// holds a vehicle for someone who has not decided. That is a promise the app
// made on a person's behalf.
//
// This list is deliberately NARROW and about ACTION, not approval. "Sounds
// good" while haggling is register, not a booking; "I'll take it" is a booking.
// The soft-approval words stay confined to the farewell rail, where a goodbye
// has no business carrying any of them.
//
// The `(?!\s+(?:that|with))` after accept/agree/confirm is a real false
// positive found by the paired near-miss tests: "I agree THAT 300 is a fair
// list price, but can you move on it?" is the CORE bargaining move, and the
// bare pattern rejected it - so the rail was quietly replacing good counters
// with a template. Bare "I agree." still commits; "I agree that/with ..." is
// conversation.
//
// "LOCK IT IN" WAS THE ONE THAT GOT THROUGH, AND IT CAME FROM OUR OWN TEMPLATE.
//
// `verify-recap` shipped "just to confirm before we lock it in", and this
// pattern did not match it: `lock` appears in no alternative, and the `confirm`
// branch requires a PRONOUN SUBJECT immediately before the verb
// (`i (?:accept|agree|confirm)`), while the template has an infinitive inside an
// adverbial phrase. So the one sentence in the whole engine that most sounds
// like a booking passed the rail built to stop exactly that - deterministically,
// to every shop that reached a full recap, and a shop may hold a vehicle on it.
// The template no longer says it; the pattern catches the phrase anyway,
// because the model can reach for it on its own.
const COMMIT_RX =
  /\b(?:i'?ll|i will|we'?ll|we will)\s+(?:take|book|reserve|have)\s+(?:it|that|the\s+\w+)\b|\b(?:it'?s a deal|we have a deal|deal!)|\bbook (?:it|that|me)\b|\b(?:please )?(?:reserve|hold|keep) (?:it|that|one) for (?:me|us)\b|\bput (?:my|our) name\b|\bi (?:accept|agree|confirm)\b(?!\s+(?:that|with))|\bwe (?:accept|agree|confirm)\b(?!\s+(?:that|with))|\blet'?s do it\b|\bi'?m (?:coming|on my way)\b|\bi'?ll come (?:pick|and pick|get)\b|\b(?:i'?ll|we'?ll|i will|we will)\s+(?:go|come)\s+(?:with|for)\s+(?:it|that|the\s+\w+)\b|\bcount me in\b|\bsign me up\b|\b(?:i'?m|we'?re|i am|we are)\s+in\b|\bwe'?ll take (?:it|that)\b|\b(?:that|this)\s+works?\s+for\s+(?:me|us)\s*[-,]?\s*(?:book|reserve|hold)\b|\b(?:confirmed|confirming)\s+(?:the\s+)?(?:booking|reservation|rental)\b|\bi'?ll pay\b|\bwe'?ll pay\b|\b(?:see you|meet you)\s+(?:tomorrow|today|then|at)\b|\block(?:ing)? (?:it|that|this|them) in\b|\block it down\b|\bfinali[sz](?:e|ing) (?:it|that|the (?:booking|rental|deal))\b/i;

// The ONE move that is allowed to commit, because it exists only after the
// traveller tapped Lock This Deal (graph/types.ts: "the traveller locked the
// deal - tell the shop"; it is emitted by /api/negotiate/close-deal and is
// never in the legal set a normal turn chooses from).
const COMMIT_ALLOWED_MOVE = "closing-message";

/**
 * Remove the sentence that committed, keeping the rest of the turn.
 *
 * Dropping the whole draft would usually throw away a legitimate question the
 * shop is waiting on, and replacing it wholesale with a template is how the
 * agent started repeating itself in the field. Sentence-level is the smallest
 * edit that removes the promise.
 */
export function stripCommitment(text: string): string {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .filter((sentence) => !COMMIT_RX.test(sentence))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * THE COMMITMENT RAIL, USABLE BY BOTH ENGINES.
 *
 * It lived inside runPostRails, which needs a full SPTE TurnContext - a session
 * snapshot, rivals, guards, a verified extraction. The GRAPH engine has none of
 * those, and the graph engine is the live fallback AND the sole engine on both
 * user-action routes. So on exactly the paths where a traveller has just tapped
 * something, nothing stopped a composed message from booking on their behalf.
 *
 * This rail needs two things: the text, and which move produced it. Nothing
 * else. Pulling it out means one definition of "what counts as committing"
 * rather than a second, drifting copy in the other engine.
 *
 * Returns the rejection, or null when the text is clean.
 */
export function checkCommitment(
  text: string,
  move: string
): { rule: "commitment"; detail: string } | null {
  if (move === COMMIT_ALLOWED_MOVE) return null;
  const committed = COMMIT_RX.exec(text);
  if (!committed) return null;
  return {
    rule: "commitment",
    detail: `a ${move} committed on the traveller's behalf ("${committed[0].trim()}") - only Lock This Deal may do that`,
  };
}

/**
 * Run all post-rails on a composed artifact. Returns the final wire text, or a
 * rejection the caller turns into a deterministic fallback (never a broken send).
 */
export function runPostRails(ctx: TurnContext, artifact: TurnArtifact): RailResult {
  // Silent / no-message moves have nothing to verify.
  if (artifact.move === "silent" || !artifact.message) {
    return { ok: true, finalText: undefined };
  }

  let text = artifact.message.trim();
  if (!text) return { ok: true, finalText: undefined };

  // 0) VEHICLE IDENTITY - before any number is even looked at.
  //
  // The gate in src/lib/vehicle decides whether the price on the table belongs
  // to the vehicle the traveller declared. While it says otherwise, a bargain
  // or a close is a message about someone else's bike: it pushes for a discount
  // on a 110cc, or agrees a deal for one, in the traveller's own voice and from
  // their own number. Both live failures ended exactly there.
  //
  // This is a rail rather than a prompt instruction because a prompt is advice
  // and a rail is a guarantee. The turn is rewritten into the gate's own
  // question, which is the move the policy made legal anyway.
  const gate = ctx.inbound.verified.vehicleStatus;
  const priceMove =
    artifact.move === "bargain" ||
    artifact.move === "farewell" ||
    artifact.move === "present" ||
    artifact.move === "momentum";
  // ASK ONCE, THEN PROCEED. The rewrite below is what made the agent re-send
  // a near-identical identity question in the field: every price move was
  // force-replaced while the per-message gate stayed "needs-confirmation",
  // even after the shop had answered our question. Once the confirm question
  // has gone out (vehicleAsked - the durable thread fact), price moves run
  // with the honest "assumed" status instead; only a positively WRONG vehicle
  // still blocks them.
  const identityBlocks =
    gate === "wrong-vehicle" ||
    (gate === "needs-confirmation" && !ctx.inbound.verified.vehicleAsked);
  if (priceMove && gate && identityBlocks) {
    const question = ctx.inbound.verified.vehicleQuestion;
    if (question) {
      return {
        ok: true,
        finalText: question,
        rejected: {
          rule: "vehicle-identity",
          detail: `${artifact.move} replaced with the identity question (${gate})`,
        },
      };
    }
    return {
      ok: false,
      rejected: {
        rule: "vehicle-identity",
        detail: `cannot ${artifact.move} a price whose vehicle is ${gate}`,
      },
    };
  }

  // 0.5) DISCLOSURE: never tell a shop WHICH shop undercut it.
  //
  // Cross-shop leverage is the traveller's strongest card, and its value is the
  // price, not the name. The prompt used to interpolate the rival's shop name
  // and instruct the model "you MUST name this" - so the cheaper shop's identity
  // was sent to its direct competitor, from the traveller's own number and in
  // their own voice. Nothing inspected the draft for it.
  //
  // A rail rather than a prompt line, for the same reason as every other rail
  // here: a prompt is advice, a rail is a guarantee. The name is simply not in
  // the prompt any more either (negotiation/leverage builds the card), so this
  // is the belt behind that - including for a model that recognises a shop name
  // from the rival list it can see.
  {
    const tokens = rivalIdentityTokens(ctx.session.rivals.map((r) => r.shop));
    const leaked = tokens.length ? namesRival(text, tokens) : null;
    if (leaked) {
      return {
        ok: false,
        rejected: {
          rule: "rival-disclosure",
          detail: `draft named a rival shop ("${leaked}") - leverage is the price and the vehicle, never the name`,
        },
      };
    }
  }

  // 0.7) DISCLOSURE, the other direction: never invent a fact about the
  // TRAVELLER.
  //
  // The agent writes in their voice, from their number, and they are not in the
  // room. A shop asking "when would you like to start renting?" is owed an
  // honest answer, and on a search with no dates chosen the honest answer is not
  // a day - it is "still comparing prices, I'll fix the dates once I pick".
  // A stated weekday is the one invented fact that costs the traveller
  // something real: the shop holds a bike, chases for confirmation, and reads a
  // later "no" as a cancellation.
  //
  // A rail rather than a prompt line, for the same reason as every rail here.
  if (inventsADate(text, ctx.session.rfq)) {
    return {
      ok: false,
      rejected: {
        rule: "traveller-disclosure",
        detail: "the draft states a rental date the traveller has not chosen",
      },
    };
  }

  // 0.8) A FAREWELL IS A GOODBYE. It may not carry a price or an agreement.
  //
  // Ko Tao, 12:43: the shop had said it had nothing to rent, the engine chose
  // the goodbye move, and the message that went out was "great, 180 baht per
  // day is a good price!" - an acceptance, sent to a shop that had already
  // withdrawn, five minutes after we had told it we found the price too high.
  //
  // The move was renamed (`close` -> `farewell`) and the prompt now states its
  // meaning, but both of those are instructions, and an instruction is advice.
  // This is the guarantee: whatever the model writes, a farewell that names a
  // number or agrees to one does not go out. `restock-probe` is held to the
  // same rule for the same reason - a shop that just ran out is the single
  // most dangerous moment to sound like we are accepting terms.
  // ...and `graceful-close` is a goodbye by any other name (W4.3): the shop
  // pointed us elsewhere, so a number or an agreement in that message is the
  // same failure wearing a new move token.
  if (
    artifact.move === "farewell" ||
    artifact.move === "redirect-close" ||
    artifact.move === "graceful-close" ||
    artifact.move === "restock-probe"
  ) {
    const AGREE_RX =
      /\b(deal|agreed?|i'?ll take it|we'?ll take it|book(ing|ed)? it|i'?ll book|confirm(ed|ing)?|sounds good|that works|good price|great price|perfect price|i accept|works for me)\b/i;
    const agreed = AGREE_RX.exec(text);
    // Any bare number of price magnitude. Deliberately blunt: a goodbye has no
    // legitimate reason to carry one, so there is nothing here to be precise
    // about. (Times were already refused by the rail below; this runs first.)
    const priced = /\d[\d,.]*\s*(?:\/|per\s|a\s)?\s*(?:day|night|baht|thb|฿|rp|idr|usd|\$|€|£)|(?:฿|\$|€|£|rp)\s*\d/i.exec(text);
    if (agreed || priced) {
      return {
        ok: false,
        rejected: {
          rule: "farewell-integrity",
          detail: agreed
            ? `a goodbye agreed to something ("${agreed[0]}")`
            : `a goodbye carried a price ("${priced?.[0]?.trim()}")`,
        },
      };
    }
  }

  // 0.9) THE COMMITMENT RAIL - now on EVERY move, not three of them.
  //
  // The traveller's decision has exactly one expression in this system: the
  // Lock This Deal button, which produces `closing-message`. Anything else
  // that books, reserves, accepts or announces we are on our way is the app
  // deciding for them - and a shop that holds a bike on that promise is a real
  // person losing a real rental when the traveller picks a cheaper shop.
  //
  // Information gathering is untouched by design (the owner's ruling): asking
  // what deposit they take or whether they deliver is a question, and questions
  // are how the traveller learns enough to decide.
  const commit = checkCommitment(text, artifact.move);
  if (commit) return { ok: false, rejected: commit };

  // 0.95) BEAT, NEVER MATCH (owner report 5 #2).
  //
  // "Could you match the 200 THB/day offer" went out on the wire. Matching is
  // not bargaining: it spends the traveller's single strongest card - that a
  // real competitor already quoted less - and the BEST outcome it can produce
  // is the price they already had. Every "never match" control in this repo was
  // a sentence in a prompt, and this file's own comments say what that is worth:
  // "a prompt is advice and a rail is a guarantee". Three independent prompt
  // builders carried "match or beat it" verbatim, and one of them modelled the
  // match in its own few-shot. Fixing the words was necessary; this is what
  // makes them binding.
  //
  // Scoped to the two moves that ask for a number. A `confirm` or an `answer`
  // that happens to contain "the same bike" is ordinary English, and the
  // patterns in negotiation/beat-rival are price-scoped for the same reason.
  //
  // Rejection rather than repair: the ask IS the message here, so there is no
  // sentence to strip that leaves a message behind. The orchestrator re-composes
  // through the deterministic fallback, whose bargain template cites at most
  // the rival PRICE (never a name) at a strictly-below target
  // number at all and therefore cannot match one.
  if (artifact.move === "bargain" || artifact.move === "momentum") {
    const matched = citesAMatch(text);
    if (matched) {
      return {
        ok: false,
        rejected: {
          rule: "beat-not-match",
          detail: `the draft asked the shop to match rather than beat ("${matched.phrase}") - a matched price wins the traveller nothing`,
        },
      };
    }
  }

  // 1) Duration integrity: rewrite any wrong day-count to the RFQ's real value.
  text = correctDuration(text, ctx.session.rfq.durationDays).text;

  // 2) Numeric integrity: fabricated-rival / below-floor / inverted-ask. The
  //    ONE real rival is the cheapest sibling offer; the ceiling is the shop's
  //    own live quote; the floor is the grounded/market floor.
  const rival = ctx.session.rivals[0]?.pricePerDay;
  const ceiling = ctx.inbound.verified.pricePerDay ?? ctx.thread.digest.quotedPricePerDay;
  const check = checkOutboundNumbers({
    text,
    ceiling,
    floor: ctx.guards.floorPerDay,
    rivalPrice: rival,
    // The prompt shows the model every rival in the session; the rail must back
    // every one of them, or citing rival #2 gets the whole draft rejected and
    // replaced by a template that names no rival at all.
    rivalPrices: ctx.session.rivals.map((r) => r.pricePerDay),
    // A price the shop itself posted on a board is a legitimate number to quote
    // back even when it sits above the current quote ("your list says 300, can
    // you do 250?") - without this it reads as an inverted ask and is rejected.
    allowAbove: [
      ctx.inbound.verified.sheetPricePerDay,
      ...(ctx.thread.digest.options ?? []).map((o) => o.pricePerDay),
    ].filter((n): n is number => typeof n === "number" && n > 0),
    excludeExact: [ctx.session.rfq.durationDays, ctx.session.rfq.engineSizeCc ?? 0].filter(Boolean),
    // PROVENANCE: every price-scale numeral must be a number this thread's
    // structured state holds or a closed derivation of one (total/days,
    // daily*days, rounding). Derived rates are legal - "1200 for 6 days"
    // grounds a "200/day" ask - but the field's invented "Your price 300"
    // (against a 250B greeting the extractor had missed) is not.
    // A pickup-location message is owned ENTIRELY by the location rail below
    // (verified address, approved link, no raw coordinates) - a street number
    // in a real address must never read as an ungrounded price.
    grounded: artifact.move === "pickup-location" ? [] : [
      ctx.inbound.verified.pricePerDay,
      ctx.thread.digest.quotedPricePerDay,
      ctx.inbound.verified.sheetPricePerDay,
      // The pass's own counter ask. It is not a free pass: for price moves
      // every text numeral still has to sit inside [floor, ceiling] below,
      // and a within-bounds ask IS the ladder - what provenance adds is that
      // no OTHER number ("Your price 300 is too much") can ride along.
      artifact.counterPricePerDay,
      ctx.session.benchmark?.pricePerDay,
      ...(ctx.thread.digest.options ?? []).map((o) => o.pricePerDay),
      // Every numeral the conversation VERBATIM contains - the shop's own
      // words and ours. A number either party already said is never an
      // invention; what this basis has no path to is the field's "Your
      // price 300 is too much" against a thread that never held a 300.
      ...verbatimNumerals([
        ctx.inbound.text,
        ...ctx.tail.map((m) => m.text),
        ...(ctx.thread.digest.lastOutbound ?? []),
      ]),
    ].filter((n): n is number => typeof n === "number" && n > 0),
    durationDays: ctx.session.rfq.durationDays,
    checkAskBounds: artifact.move === "bargain" || artifact.move === "momentum",
  });
  if (!check.ok) {
    // A number that fails verification is never sent (the anti-hallucination
    // guarantee). The caller falls back to a safe templated move.
    return { ok: false, rejected: { rule: check.violation ?? "numbers", detail: check.detail } };
  }

  // 2b) LOCATION INTEGRITY (graph/nodes.ts:490 parity). A message that shares
  //     where the traveller is must carry the VERIFIED address, and must not
  //     carry any map link other than the one the consent gate approved. A
  //     model that paraphrased the address into a nearby landmark, or minted
  //     its own maps URL, is rejected - the caller then sends the template,
  //     which is composed from the gate and cannot drift.
  if (artifact.move === "pickup-location") {
    const approved = ctx.share?.mapsLink;
    const address = ctx.share?.addressText;
    if (!address || !text.includes(address)) {
      return { ok: false, rejected: { rule: "location", detail: "verified address missing" } };
    }
    const links = text.match(/https?:\/\/\S+/gi) ?? [];
    if (links.some((l) => l.replace(/[).,]+$/, "") !== approved)) {
      return { ok: false, rejected: { rule: "location", detail: "unapproved link" } };
    }
    // Bare coordinates are never ours to write - the gate emits a link or text.
    if (/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/.test(text.replace(approved ?? "", ""))) {
      return { ok: false, rejected: { rule: "location", detail: "raw coordinates" } };
    }
  }

  // 3) Never finalize a time.
  if (TIME_COMMIT_RX.test(text) && !/confirm.*time/i.test(text)) {
    text = text.replace(TIME_COMMIT_RX, "").replace(/\s{2,}/g, " ").trim();
    text = `${text}${TIME_DEFER_LINE}`;
  }

  // 4) OWNER-BANNED PHRASES.
  //
  // The graph engine has scrubbed these since the overlay shipped
  // (engine.ts:1072) and SPTE never did - and SPTE is the engine that runs. So
  // a phrase the owner outlawed in the Ops Center went out on every real
  // message, and only the failover path honoured the ban. Deterministic and
  // last, matching the graph engine's placement, so nothing downstream can
  // reintroduce a banned phrase after the scrub.
  //
  // The phrases arrive on ctx.guards rather than being read here: rails are
  // pure and synchronous by design, and the one place that awaits config is
  // the context builder.
  for (const phrase of ctx.guards.bannedPhrases ?? []) {
    const rx = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    if (rx.test(text)) text = text.replace(rx, "").replace(/\s{2,}/g, " ").trim();
  }
  // A scrub that emptied the message is not a message. Dropping the turn is
  // right: the alternative is sending a fragment, and a banned phrase that
  // carried the whole sentence means the draft has to be rewritten, not
  // trimmed. The caller re-parks and the next turn composes fresh.
  if (!text) {
    return { ok: false, rejected: { rule: "banned-phrase", detail: "nothing left after scrub" } };
  }

  // SEND-WORTHINESS - after the scrub, deliberately (owner report 6 C2).
  //
  // The live evidence: the agent burned a real, anti-ban-paced send slot on
  // the literal message "thanks!". Two generators produce it: an LLM filler
  // turn the prompt only ADVISES against (a prompt is advice; a rail is a
  // guarantee - the doctrine this file states at its match rail), and the
  // scrub above deleting a draft's substance and leaving its courtesy tail.
  // Running after the scrub catches both.
  //
  // A non-terminal move must ADVANCE something: carry a question, a number,
  // or any substance beyond courtesy tokens. Terminal moves are exempt - a
  // bare goodbye is a farewell's whole job.
  {
    const TERMINAL: ReadonlyArray<string> = [
      "farewell",
      "redirect-close",
      "graceful-close",
      "silent",
    ];
    if (!TERMINAL.includes(artifact.move)) {
      const stripped = text
        .toLowerCase()
        .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
        .replace(
          /\b(thanks?|thank you|thankyou|ok(?:ay)?|great|perfect|awesome|cool|nice|sure|got it|no problem|cheers|khob khun|kha|krub|ka)\b/g,
          " "
        )
        .replace(/[\s!.,🙏👍]+/g, " ")
        .trim();
      const hasQuestion = /\?/.test(text);
      const hasNumber = /\d/.test(text);
      if (!hasQuestion && !hasNumber && stripped.length < 8) {
        return {
          ok: false,
          rejected: {
            rule: "send-worthiness",
            detail: `non-terminal ${artifact.move} carries no question, no number and no substance ("${text.slice(0, 60)}")`,
          },
        };
      }
    }
  }

  // CITE THE RIVAL - A PROMPT IS ADVICE, A RAIL IS A GUARANTEE.
  //
  //     This file already says that sentence about beat-not-match, and acted on
  //     it. The cheapest-rival cite - the owner's actual product requirement,
  //     "another shop offered 200, can you do 180?" - had every control EXCEPT
  //     a rail: leverage.ts tells the model it MUST name the figure, pass.ts
  //     puts the rival block at the top of the prompt, ask-variant repeats it.
  //     All advice. A model that ignored all of it produced "any chance of a
  //     better daily rate?", which the send-worthiness gate happily passed
  //     (it has a question mark), and the strongest card in the hand was never
  //     played.
  //
  //     Runs AFTER send-worthiness on purpose: "thanks! 👍" is empty before it
  //     is leverage-free, and naming the shallower defect first would hide the
  //     real one behind a confusing reason.
  //
  //     Rejection re-composes through `templateFor('bargain')`, which cites the
  //     rival price AND a strictly-below target deterministically - so the
  //     failure mode of this rail is the message the owner asked for.
  //
  //     Only fires when there IS a cheaper rival to cite. No rival, no
  //     obligation - and a draft that already names the number passes
  //     untouched, whatever else it says.
  if (artifact.move === "bargain") {
    const rival = cheapestCheaperRival(ctx.session.rivals, quoteOnTable(ctx));
    if (rival) {
      const target = Math.round(rival.pricePerDay);
      // ANY REAL RIVAL COUNTS, not only the cheapest one.
      //
      // Requiring the cheapest specifically would reject "another shop quoted
      // me 280 - can you beat it?" on a board that also holds a 250, which is
      // perfectly good leverage and already validated as real by
      // checkOutboundNumbers below. The defect this rail exists for is a
      // bargain that names NO rival at all.
      const quotable = ctx.session.rivals
        .map((r) => r.pricePerDay)
        .filter((n): n is number => typeof n === "number" && n > 0)
        .concat(target);
      // Tolerant on purpose: the composer may round, localize digits, or write
      // "200฿". Any numeral within 1 unit of a real rival counts as the cite.
      // Normalised, for the same reason citedRival is: this app supports Thai,
      // Lao, Khmer and Myanmar numerals (integrity/translation.ts folds them
      // all), and a rail that cannot read the digits in front of it would
      // reject a draft that cites the rival perfectly well in local script -
      // rejecting correct output is a downgrade, not a guarantee.
      //
      // ...BUT THE NUMERAL HAS TO BE MONEY. This counted ANY numeral within 1
      // unit of a real rival, so a bargain that never named the rival could
      // satisfy the rail built to require it: "can you do it for the 17 Aug?"
      // passed against a rival at 17/day, "we need it for 5 days" against a
      // rival at 5, "the 125cc one" against 125. A coincidence detector is not
      // a guarantee. `citesPrice` applies the same tolerance to numerals that
      // read as prices in the sentence they appear in, and deliberately does
      // NOT require a currency token - that would reject the owner's own
      // sentence, "another shop offered 200, can you do 180?".
      const cited = citesPrice(normalizeDigits(text), quotable);
      if (!cited) {
        return {
          ok: false,
          rejected: {
            rule: "cite-the-rival",
            detail: `a cheaper rival is on the board at ${target} and the draft never named it - the deterministic bargain template does`,
          },
        };
      }
    }
  }


  return { ok: true, finalText: text };
}
