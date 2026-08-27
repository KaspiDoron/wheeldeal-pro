// WHAT WE MAY SAY ABOUT THE TRAVELLER.
//
// C5 gave the engine a disclosure policy for the OTHER shops - price and
// vehicle, never a name. It never had one for the person we are speaking as.
//
// Live, on a Chiang Mai thread, a shop asked two perfectly ordinary questions:
//
//     "Hello there, When would you like to start renting?"
//     "And where would you like to go with the bike please?"
//
// The agent writes in the traveller's own voice, from the traveller's own
// number, and the traveller was not in the room. There are only three things it
// can do with a question like that, and two of them are wrong: invent an answer
// ("Tuesday morning, riding to Pai"), which puts words in someone's mouth and
// commits them to plans they never made; or stall, which reads as evasive to a
// shop that is only trying to help. The third is what a person actually does
// when they have not decided yet - answer honestly at the level they HAVE
// decided:
//
//     "Just riding around town and nearby - nothing far."
//     "Still comparing prices today, then I'll fix the dates."
//
// So this file draws the line the engine was missing: every fact a shop can ask
// about the traveller is either GROUNDED (it is in the search request, so we may
// state it), GENERAL (we know the shape but not the specifics, so we answer at
// the shape) or WITHHELD (it is theirs to give, never ours).
//
// Pure. The rail in spte/rails.ts is what enforces it; this decides what is
// true and what is allowed.

import type { StructuredRFQ } from "../types";
import { nDays } from "../copy/matrix";

export type TravellerFact =
  | "start-date" // when the rental begins
  | "duration" // how many days
  | "vehicle" // what they want to ride
  | "area" // roughly where they will use it
  | "exact-route" // the specific itinerary
  | "address" // where they are staying / exact pickup point
  | "identity" // name, passport, nationality
  | "contact"; // another number, email, socials

export type Disclosure = "grounded" | "general" | "withheld";

/**
 * The policy, by fact. Note what is NOT here: any dependence on how the shop
 * phrased the question. A rule about wording is a rule that the next shop's
 * phrasing breaks.
 */
export const DISCLOSURE: Record<TravellerFact, Disclosure> = {
  "start-date": "grounded", // ...only if the request actually carries one
  duration: "grounded",
  vehicle: "grounded",
  area: "general",
  "exact-route": "general",
  address: "withheld",
  identity: "withheld",
  contact: "withheld",
};

// Detectors. Deliberately broad: a false positive costs one extra line of
// guidance in the prompt, a false negative costs an invented fact.
const ASKS: Array<{ fact: TravellerFact; rx: RegExp }> = [
  {
    fact: "start-date",
    rx: /\b(when (would|do) you|what date|which day|start(ing)? (date|renting|from)|from when|pick ?up date|arriv(e|ing))\b/i,
  },
  { fact: "duration", rx: /\b(how (many days|long)|for how long|number of days)\b/i },
  {
    fact: "exact-route",
    rx: /\b(where (would|will|do) you (like to )?(go|ride|travel)|which (city|town|province)|going to|destination|route|plan to (go|ride|visit))\b/i,
  },
  {
    fact: "address",
    rx: /\b(where (are|r) you (staying|now|located)|your (hotel|address|location)|which hotel|send (me )?your location|drop ?pin)\b/i,
  },
  {
    fact: "identity",
    rx: /\b(your (name|full name|passport|nationality)|who am i speaking|may i (have|know) your name)\b/i,
  },
  { fact: "contact", rx: /\b(another number|your email|line id|instagram|facebook|telegram)\b/i },
];

/** Which facts about the traveller did this shop message ask for? */
export function factsAsked(text: string): TravellerFact[] {
  const s = String(text ?? "");
  const out: TravellerFact[] = [];
  for (const a of ASKS) if (a.rx.test(s) && !out.includes(a.fact)) out.push(a.fact);
  return out;
}

export interface AnswerGuide {
  fact: TravellerFact;
  disclosure: Disclosure;
  /** What the agent may truthfully say, given this request. */
  guidance: string;
}

/**
 * IS THIS SHARE-STRING COARSE ENOUGH TO NAME AS AN AREA? (owner report 11 S3)
 *
 * The `area` fact answers "where will you ride?" with a general place. But the
 * only "where" the app holds is the traveller's stored stay LABEL - the precise
 * hotel/street they typed (`stay_label`) - and it is populated even without the
 * coordinate-sharing consent. Feeding it straight into the area answer made the
 * agent say "riding around Ibis Styles Krabi, 123 Beach Rd" when a shop asked
 * which city - stating the exact hotel, before any price, contradicting the
 * `address` fact one case below which is instructed to REFUSE a hotel.
 *
 * A bare town ("Krabi", "Ao Nang", "Chiang Mai") is a legitimate area and stays
 * friendly. Anything that looks like a precise address - a street number, a
 * comma-separated multi-part label, or just a long one - is withheld here and
 * reserved for the price-gated `pickup-location` move, which is the intended
 * disclosure point. Conservative on purpose: when unsure, share less.
 */
export function coarseArea(label: string | null | undefined): string | null {
  const t = String(label ?? "").trim();
  if (!t) return null;
  if (/\d/.test(t)) return null; // a street/unit number is not an area
  if (t.includes(",")) return null; // "Hotel, Road, District" is an address
  if (t.length > 24) return null; // a long label is a precise place, not a town
  if (t.split(/\s+/).length > 3) return null; // more than three words is not a town
  return t;
}

/**
 * The honest answer to each fact the shop asked about, for THIS request.
 *
 * A grounded fact that the request does not actually carry degrades to general
 * - which is the whole point. "When do you start?" on a search with no dates
 * chosen has a true answer, and it is not a date.
 */
export function answerGuide(
  ctx: { rfq?: StructuredRFQ; town?: string },
  asked: TravellerFact[]
): AnswerGuide[] {
  const rfq = ctx.rfq;
  // Only a coarse, town-like value may be named as an AREA. A precise stay
  // label is withheld here and shared only via the price-gated pickup move.
  const town = coarseArea(ctx.town) ?? "";
  const days = rfq?.durationDays;
  const start = (rfq as { startDate?: string } | undefined)?.startDate;

  const guideFor = (fact: TravellerFact): AnswerGuide => {
    switch (fact) {
      case "start-date":
        return start
          ? { fact, disclosure: "grounded", guidance: `Starting ${start} - say so plainly.` }
          : {
              fact,
              disclosure: "general",
              guidance:
                "No date has been chosen. Say you are comparing prices today and will fix the dates once you pick a shop. Never name a day.",
            };
      case "duration":
        return days
          ? { fact, disclosure: "grounded", guidance: `About ${nDays(days)} - say so.` }
          : { fact, disclosure: "general", guidance: "Say it is still flexible." };
      case "vehicle":
        return {
          fact,
          disclosure: "grounded",
          guidance: "The requested vehicle is in the request - state it exactly.",
        };
      case "exact-route":
      case "area":
        return {
          fact,
          disclosure: "general",
          guidance: town
            ? `Say you are riding around ${town} and nearby - general sightseeing. Never name a specific destination, trip or itinerary.`
            : "Say you are riding around locally. Never name a specific destination or itinerary.",
        };
      case "address":
        return {
          fact,
          disclosure: "withheld",
          guidance:
            "Do NOT give an address or a hotel. Offer to come to the shop, or say you will share a pickup point once the price is agreed.",
        };
      case "identity":
        return {
          fact,
          disclosure: "withheld",
          guidance:
            "Do NOT give a name, passport or nationality. Say you will bring your documents at pickup.",
        };
      case "contact":
        return {
          fact,
          disclosure: "withheld",
          guidance: "Do NOT give another number or handle. This chat is fine.",
        };
    }
  };

  return asked.map(guideFor);
}

/**
 * The prompt block. Empty when the shop asked nothing about the traveller, so
 * an ordinary price turn carries none of this.
 */
export function disclosureBlock(
  ctx: { rfq?: StructuredRFQ; town?: string },
  inboundText: string
): string {
  const asked = factsAsked(inboundText);
  if (asked.length === 0) return "";
  const lines = answerGuide(ctx, asked).map((g) => `- ${g.fact}: ${g.guidance}`);
  return [
    "THE SHOP ASKED ABOUT YOU. Answer like a person who has not decided yet:",
    "warm, specific about what you know, general about what you do not. Never",
    "invent a detail about yourself - you are writing as the traveller, and they",
    "are not here to be quoted.",
    ...lines,
  ].join("\n");
}

// ---- enforcement ----------------------------------------------------------

/**
 * A calendar date the draft states that the request does not contain.
 *
 * This is the one invented fact that actually costs the traveller something:
 * a shop that believes a date has been agreed will hold a bike, chase for
 * confirmation, and treat a "no" as a cancellation. Weekday names and explicit
 * dates only - "today" and "tomorrow" are about our own availability, not a
 * booking, and the rental-window authority already governs those.
 */
const DATE_CLAIM_RX =
  /\b(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{4}-\d{2}-\d{2}\b/i;

export function inventsADate(draft: string, rfq: StructuredRFQ | undefined): boolean {
  const m = DATE_CLAIM_RX.exec(String(draft ?? ""));
  if (!m) return false;
  const start = (rfq as { startDate?: string } | undefined)?.startDate;
  if (!start) return true; // nothing on file - any stated date is invented
  // A date IS on file: allow it only when the draft is naming that same date.
  return !String(draft).includes(start);
}
