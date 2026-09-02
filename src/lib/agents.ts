// The AI agent ecosystem. Every agent degrades gracefully to a deterministic
// heuristic when no LLM key is configured, so the product is always functional.

import "server-only";
import type { InboundImage } from "./media/orientation";
import { article, nDays } from "./copy/matrix";
import { deriveReturnDate } from "./rental-window";
import { chat, extractJson } from "./ai";
import type {
  StructuredRFQ,
  VehicleClass,
  Transmission,
  Fulfillment,
  Vendor,
  Offer,
} from "./types";
import { getTactics, recordOutcome } from "./memory";
import { parseDeposit } from "./deposit";
import { extractQuotedPrices, extractRentalDailyPrice } from "./wa/price-extract";
import { catalogueFactsFor } from "./vehicle/catalogue";
import { isEnglishSpeaking } from "./locale";
import { deAmbiguateFree } from "./wa/persona";
import { numbersPreserved } from "./integrity/translation";
import { beatRivalTarget } from "./negotiation/beat-rival";

// ---------------------------------------------------------------------------
// Profiler Agent - free text → structured, vendor-ready RFQ
// ---------------------------------------------------------------------------

/**
 * @param durationDaysHint The day count the traveller EXPLICITLY set on the
 *   window control. Outranks anything read from prose.
 * @param defaultDurationDays The day count the window control was SHOWING when
 *   they searched, untouched (W9). It does not outrank prose - "for a week"
 *   still wins - but it is what fills the gap when the traveller stated no
 *   length at all. Without it the gap was filled by a hard-coded 3 that
 *   contradicted the "For 4 days" card sitting above the search button.
 */
export async function runProfiler(
  input: string,
  durationDaysHint?: number,
  voiceKey?: string,
  defaultDurationDays?: number
): Promise<StructuredRFQ> {
  const { getPrompt } = await import("./prompts");
  const system = await getPrompt("profiler");

  // Variety seed: with hundreds of users, identical vendorMessages would look
  // like a bot blast to shops AND to WhatsApp's spam filters. Each request
  // gets a randomly different, natural phrasing style.
  const styles = [
    "start with a casual greeting and get straight to the point",
    "open by mentioning you're staying nearby, keep it warm and brief",
    "lead with the availability question, then the details",
    "sound easy-going and friendly, one light touch of humour is fine",
    "be brief and practical - a traveller typing on the go",
    "start with 'Good morning/afternoon' style politeness, then the request",
  ];
  const styleSeed = styles[Math.floor(Math.random() * styles.length)];

  // Stable persona: THIS user always sounds like the same distinct human.
  let persona = "";
  if (voiceKey) {
    const { voiceProfileFor, voiceDirectives } = await import("./voice");
    persona = ` ${voiceDirectives(voiceProfileFor(voiceKey))}`;
  }

  // Orchestrator opener stage: owner instructions apply to the first message.
  let openerRules = "";
  try {
    const { getOrchestratorConfig, ownerDirectives } = await import("./orchestrator");
    const ocfg = await getOrchestratorConfig();
    openerRules = ownerDirectives(ocfg, "opener");
    if (openerRules) openerRules = ` ${openerRules}`;
  } catch {
    /* opener rules are an enhancement */
  }

  // Tight budget: this call blocks the START of every search. If the AI is
  // slow, the deterministic heuristic (with its own message variety) takes
  // over - a fast search beats a marginally prettier first message.
  const llm = await chat(
    [
      {
        role: "system",
        content:
          system +
          ` VARIETY: for the vendorMessage, ${styleSeed}. Never reuse a stock template - each message must read like a different real person wrote it.` +
          " REGISTER: vendorMessage in SIMPLE everyday English - short words, short sentences; most shops speak English as a second language." +
          openerRules +
          persona,
      },
      { role: "user", content: input },
    ],
    { budgetMs: 9_000 }
  );

  if (llm) {
    const parsed = extractJson<StructuredRFQ>(llm);
    if (parsed && parsed.vehicleClass) {
      return normalizeRFQ(parsed, input, durationDaysHint, defaultDurationDays);
    }
  }
  return heuristicRFQ(input, durationDaysHint, defaultDurationDays);
}

/**
 * Build a valid StructuredRFQ from FULLY-STRUCTURED tap-to-build input (F2),
 * with ZERO LLM call - the tap panel already knows every field, so there is
 * nothing to parse. Reuses normalizeRFQ so the cheapest-by-default fills,
 * duration clamp and message assembly are byte-identical to the text path. A
 * Tier-R (0-token) request path.
 */
export function deterministicRFQ(fields: Partial<StructuredRFQ>): StructuredRFQ {
  // A tiny synthetic input string so buildMessage's opener/notes logic has
  // something human to anchor on when no free text was typed.
  const synthetic = fields.notes?.trim() || "";
  return normalizeRFQ(fields as StructuredRFQ, synthetic, fields.durationDays);
}

function normalizeRFQ(
  rfq: StructuredRFQ,
  input: string,
  durationHint?: number,
  defaultDurationDays?: number
): StructuredRFQ {
  // W4.1: THE HINT IS NOT A FALLBACK, IT IS THE TRAVELLER. `durationHint` only
  // exists when the picker was actually set (the page sends it on no other
  // occasion), so it is explicit input - and `rfq.durationDays || durationHint`
  // let any truthy LLM value (including an invented 1) beat the traveller's 3.
  // Explicit input outranks inference; the LLM only fills the gap when the
  // traveller stated nothing.
  // W9: ...AND THE UNTOUCHED CONTROL IS THE LAST RESORT, NOT 3. A traveller who
  // states no length gets the number their own screen was showing, which is the
  // only number they can be said to have seen. The hard-coded 3 inside
  // clampDuration remains for callers that pass nothing at all.
  const hinted = requestedDuration(durationHint);
  // The prompt makes durationDays OPTIONAL ("only if the traveller stated how
  // long"), so this field is genuinely absent on most parses even though the
  // type says number - read it defensively.
  const stated = Number(rfq.durationDays) > 0 ? Number(rfq.durationDays) : undefined;
  const durationDays = clampDuration(hinted ?? stated ?? defaultDurationDays);
  // One compute, reconciled once: the return date is start + duration, by the
  // one writer (lib/rental-window). An LLM returnDate that contradicts the
  // reconciled pair does not survive - it is the same lie in another field.
  const rental = deriveReturnDate({ ...rentalFields(rfq, input), durationDays });
  return {
    vehicleClass: (["car", "motorbike", "scooter"].includes(rfq.vehicleClass)
      ? rfq.vehicleClass
      : "car") as VehicleClass,
    // NO INVENTED ENGINE SIZE (owner report 5 #11 - the 110cc trap).
    //
    // "Cheapest by default" used to DECLARE 110cc for a traveller who had named
    // no size, and for one who explicitly tapped "Any / cheapest". Displacement
    // is a DISQUALIFYING attribute in the vehicle-identity gate (vehicle/spec),
    // and only attributes the traveller actually declared may block a quote -
    // the seats default above was removed for exactly this reason and left this
    // one standing. In a 125cc market like Thailand the consequence is total:
    // real quotes for the bikes the shops actually rent were stamped "wrong
    // vehicle" and barred from BEST PRICE, on a constraint the traveller never
    // asked for and could not see.
    //
    // "Any / cheapest" means NO cc constraint. Cheapest is then what it should
    // always have been - the lowest price the shops come back with - rather than
    // a displacement we picked on their behalf and then enforced against them.
    engineSizeCc: rfq.vehicleClass === "car" ? undefined : rfq.engineSizeCc,
    // NO SEAT DEFAULT. `seats` is a DISQUALIFYING attribute in the vehicle
    // identity gate (src/lib/vehicle/spec) - only attributes the traveller
    // actually declared may block a quote. Defaulting it to 4 meant every car
    // search silently demanded a seat count the traveller never gave, so a shop
    // quoting a car whose seat count it did not state could not be confirmed,
    // and the quote never reached the board. An undeclared seat count is not a
    // requirement; it is simply not a constraint.
    seats: rfq.vehicleClass === "car" ? rfq.seats : undefined,
    carType:
      rfq.vehicleClass === "car"
        ? rfq.carType && rfq.carType !== "any"
          ? rfq.carType
          : "economy"
        : undefined,
    transmission: (["automatic", "manual", "any"].includes(rfq.transmission)
      ? rfq.transmission
      : "any") as Transmission,
    maxMileageKm: rfq.maxMileageKm,
    accessories: Array.isArray(rfq.accessories) ? rfq.accessories.slice(0, 8) : [],
    fulfillment: (["hotel-delivery", "in-store", "any"].includes(rfq.fulfillment)
      ? rfq.fulfillment
      : "any") as Fulfillment,
    notes: rfq.notes,
    // `rental` carries the whole reconciled window - the rental fields, the
    // duration (traveller's picker over the LLM's read) and the returnDate
    // derived from that pair. It is spread ONCE, as the single source, so no
    // earlier key in this literal can quietly disagree with it.
    ...rental,
    // The message is built from the RECONCILED fields, so it can never state a
    // window the rest of the RFQ disagrees with.
    vendorMessage: rfq.vendorMessage || buildMessage({ ...rfq, ...rental }, input),
  };
}

/** A picker-provided day count, when the client sent a sane one (1-90). */
function requestedDuration(n: number | undefined): number | undefined {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 && v <= 90 ? v : undefined;
}

// A rental duration must be sane - it directly multiplies into totalPrice.
// 0 / negative / NaN / absurd values were passing straight through and
// producing garbage totals. Clamp to 1..90 days.
function clampDuration(n: number | undefined): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 3;
  return Math.min(v, 90);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Sanitized real-world rental fields, merged from the LLM parse + free text. */
function rentalFields(rfq: Partial<StructuredRFQ>, input: string): {
  startDate?: string;
  returnDate?: string;
  driverAge?: number;
  license?: { motorbike?: boolean; idp?: boolean };
  insuranceTier?: StructuredRFQ["insuranceTier"];
  oneWayDropOff?: string;
  helmetCount?: number;
} {
  const t = (input || "").toLowerCase();
  const startDate = rfq.startDate && ISO_DATE.test(rfq.startDate) ? rfq.startDate : undefined;
  const returnDate = rfq.returnDate && ISO_DATE.test(rfq.returnDate) ? rfq.returnDate : undefined;
  const ageM = t.match(/\b(1[6-9]|[2-9]\d)\s*(?:years?|yrs?|yo|y\/o)\b/);
  const driverAge =
    typeof rfq.driverAge === "number" && rfq.driverAge >= 16 && rfq.driverAge <= 99
      ? Math.floor(rfq.driverAge)
      : ageM
      ? parseInt(ageM[1], 10)
      : undefined;
  const idp = rfq.license?.idp ?? /\b(idp|international (driving )?(permit|licen[cs]e))\b/.test(t) ? true : undefined;
  const motorbike =
    rfq.license?.motorbike ?? /\bmotor(bike|cycle) licen[cs]e\b/.test(t) ? true : undefined;
  const license = idp || motorbike ? { ...(idp ? { idp: true } : {}), ...(motorbike ? { motorbike: true } : {}) } : undefined;
  const insuranceTier = (["none", "basic", "full", "any"] as const).includes(
    rfq.insuranceTier as never
  )
    ? rfq.insuranceTier
    : /\bfull (insurance|cover)/.test(t)
    ? "full"
    : /\b(no|without) insurance/.test(t)
    ? "none"
    : undefined;
  const helmetM = t.match(/(\d)\s*helmets?/);
  const helmetCount =
    typeof rfq.helmetCount === "number" && rfq.helmetCount > 0 && rfq.helmetCount <= 4
      ? Math.floor(rfq.helmetCount)
      : helmetM
      ? Math.min(parseInt(helmetM[1], 10), 4)
      : undefined;
  const oneWayDropOff =
    typeof rfq.oneWayDropOff === "string" && rfq.oneWayDropOff.trim()
      ? rfq.oneWayDropOff.trim().slice(0, 80)
      : undefined;
  return {
    ...(startDate ? { startDate } : {}),
    ...(returnDate ? { returnDate } : {}),
    ...(driverAge ? { driverAge } : {}),
    ...(license ? { license } : {}),
    ...(insuranceTier ? { insuranceTier } : {}),
    ...(oneWayDropOff ? { oneWayDropOff } : {}),
    ...(helmetCount ? { helmetCount } : {}),
  };
}

function heuristicRFQ(
  input: string,
  durationHint?: number,
  defaultDurationDays?: number
): StructuredRFQ {
  const t = input.toLowerCase();
  const vehicleClass: VehicleClass = /scooter|vespa|moped/.test(t)
    ? "scooter"
    : /bike|motor|cc\b|125|150|scoot/.test(t)
    ? "motorbike"
    : "car";

  const ccMatch = t.match(/(\d{2,4})\s*cc/);
  const mileageMatch = t.match(/(\d[\d,\.]{2,})\s*(k|km|kms|kilomet)/);
  const daysMatch = t.match(/(\d+)\s*(day|days|night|nights|week)/);
  // Car-specific: seats ("5 seats", "7-seater") and body type.
  const seatsMatch = t.match(/(\d)\s*(?:-)?\s*seat/);
  const seats = seatsMatch ? parseInt(seatsMatch[1], 10) : undefined;
  const carType: StructuredRFQ["carType"] = /suv|4x4|jeep/.test(t)
    ? "suv"
    : /van|minivan|people mover/.test(t)
    ? "van"
    : /luxury|premium|bmw|mercedes|audi/.test(t)
    ? "luxury"
    : /sedan|saloon/.test(t)
    ? "sedan"
    : /economy|cheap|small|compact/.test(t)
    ? "economy"
    : "any";

  const accessories: string[] = [];
  if (/phone|mount|holder/.test(t)) accessories.push("phone mount");
  if (/helmet/.test(t)) accessories.push("helmet");
  if (/gps|navigation/.test(t)) accessories.push("GPS");
  if (/child|baby|infant/.test(t)) accessories.push("child seat");
  if (/box|storage|top case/.test(t)) accessories.push("storage box");

  // W4.1: the picker hint - only ever sent when the traveller SET it - outranks
  // the prose read, same precedence as normalizeRFQ: the value on screen is the
  // statement, the sentence is the fallback.
  // W9: and the last resort is the window control's UNTOUCHED value, not a
  // hard-coded 3. This is the path a typed search takes in demo mode and on
  // every LLM miss, and it was answering "I need a scooter in Chiang Mai" with
  // 3 days while the card above the search button read "For 4 days".
  let prose: number | undefined;
  if (daysMatch) {
    const n = parseInt(daysMatch[1], 10);
    prose = clampDuration(/week/.test(daysMatch[2]) ? n * 7 : n);
  }
  const durationDays = clampDuration(
    requestedDuration(durationHint) ?? prose ?? defaultDurationDays
  );

  const rfq: StructuredRFQ = {
    vehicleClass,
    // NO INVENTED ENGINE SIZE - the same rule normalizeRFQ carries at :148, and
    // the same post-mortem (owner report 5 #11, the 110cc trap). That fix landed
    // on the tap-to-build panel and the LLM-success path and left THIS one
    // standing, which is the path every LLM miss takes: demo mode, an
    // unparseable answer, the 9s profiler budget expiring, or an exhausted
    // LIMIT_AI_PER_DAY. Displacement is DISQUALIFYING in the vehicle-identity
    // gate, so a 110 nobody asked for stamped every real 125cc quote
    // "wrong-vehicle", barred it from BEST PRICE and flagged the card red - in a
    // 125cc market the traveller saw no prices at all, on a constraint they
    // never stated and could not see. "Any / cheapest" means NO cc constraint;
    // cheapest is then the lowest price the shops come back with.
    engineSizeCc:
      vehicleClass === "car" ? undefined : ccMatch ? parseInt(ccMatch[1], 10) : undefined,
    // NO SEAT DEFAULT - the same rule normalizeRFQ carries at :122, and for
    // the same reason. This path was missed when that one was fixed, and it is
    // not a rare path: runProfiler returns heuristicRFQ DIRECTLY whenever the
    // LLM gives nothing back - no key, an unparseable answer, or the 9s budget
    // expiring. `seats` is disqualifying in the identity gate, so a phantom 4
    // meant every car search silently demanded a seat count the traveller never
    // gave: a shop that quoted a car without stating its seats could never be
    // confirmed, and its price never reached the board. The traveller saw "no
    // price yet" on shops that had answered with a price.
    //
    // `seats` here is whatever "5 seats" / "7-seater" was actually read out of
    // the text at :229, and undefined when they never said.
    seats: vehicleClass === "car" ? seats : undefined,
    carType: vehicleClass === "car" ? (carType !== "any" ? carType : "economy") : undefined,
    transmission: /manual|stick/.test(t)
      ? "manual"
      : /auto/.test(t)
      ? "automatic"
      : "any",
    maxMileageKm: mileageMatch
      ? parseInt(mileageMatch[1].replace(/[,\.]/g, ""), 10)
      : undefined,
    durationDays,
    accessories,
    fulfillment: /deliver|hotel|lobby/.test(t)
      ? "hotel-delivery"
      : /pickup|store|shop/.test(t)
      ? "in-store"
      : "any",
    notes: undefined,
    ...rentalFields({}, input),
    vendorMessage: "",
  };
  // Same one-writer rule as normalizeRFQ: a return date is start + duration,
  // never an independent fact that can contradict them.
  rfq.returnDate = deriveReturnDate(rfq).returnDate;
  rfq.vendorMessage = buildMessage(rfq, input);
  return rfq;
}

function vehicleTerm(v: VehicleClass): string {
  return v === "scooter"
    ? "automatic scooter"
    : v === "motorbike"
    ? "manual motorcycle"
    : "car";
}

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/**
 * A freshly-varied first message for ONE shop. Called PER SHOP server-side so
 * that even within a single search, no two shops receive the same opening text
 * (the client's single rfq.vendorMessage was being reused for every shop - the
 * "all shops got the same message" bug). Hundreds of natural combinations.
 */
export function variedFirstMessage(rfq: StructuredRFQ): string {
  return buildMessage(rfq, "");
}

function buildMessage(rfq: StructuredRFQ, raw: string): string {
  // Authentic first-person message from the traveller. VARIETY MATTERS: with
  // hundreds of users, identical first messages look like a bot blast (to the
  // shops AND to WhatsApp's spam filters), so every slot is randomized - the
  // same request produces many natural phrasings.
  const spec: string[] = [];
  if (rfq.vehicleClass === "car") {
    // Cars: seats, body type and transmission matter (not engine cc).
    if (rfq.carType && rfq.carType !== "any") spec.push(rfq.carType);
    if (rfq.seats) spec.push(`${rfq.seats} seats`);
    if (rfq.transmission !== "any") spec.push(rfq.transmission);
  } else {
    if (rfq.engineSizeCc) spec.push(`${rfq.engineSizeCc}cc`);
    if (rfq.transmission !== "any") spec.push(rfq.transmission);
    if (rfq.maxMileageKm) spec.push(`under ${rfq.maxMileageKm.toLocaleString()} km on the clock`);
  }
  const vehicle = `${vehicleTerm(rfq.vehicleClass)}${spec.length ? ` (${spec.join(", ")})` : ""}`;
  const days = `${rfq.durationDays} day${rfq.durationDays === 1 ? "" : "s"}`;
  // WHEN the rental starts is what makes an availability quote real. Include it
  // whenever the request captured a date, phrased naturally.
  const when = rfq.startDate ? prettyDate(rfq.startDate) : "";

  // DIRECT, NATURAL opener (owner directive): "Hi! Do you have a [spec]
  // available for [X] days (starting [date])?" - a real person's first message,
  // never a wordy self-introduction. Variation stays in the greeting + verb so
  // no two shops get an identical payload, but every variant is this shape.
  // NEVER "free" FOR "available" - see CASUAL_SWAPS in wa/persona.ts. A shop
  // asked whether we can have a bike "free" hears a request for a free bike,
  // and the honest answer to that is no. These two variants used to say it
  // outright; "spare" carries the vacancy sense with none of the price sense.
  const opener = when
    ? pick([
        `Hi! Do you have ${article(vehicle)} ${vehicle} available for ${days} starting ${when}?`,
        `Hello! Is ${article(vehicle)} ${vehicle} available for ${days} from ${when}?`,
        `Hi there! Do you have a spare ${vehicle} for ${days} starting ${when}?`,
        `Hey! Could I rent ${article(vehicle)} ${vehicle} for ${days} from ${when}?`,
      ])
    : pick([
        `Hi! Do you have ${article(vehicle)} ${vehicle} available for ${days}?`,
        `Hello! Is ${article(vehicle)} ${vehicle} available for ${days}?`,
        `Hi there! Do you have a spare ${vehicle} for ${days}?`,
        `Hey! Could I rent ${article(vehicle)} ${vehicle} for ${days}?`,
      ]);
  const dropOff = rfq.oneWayDropOff
    ? ` I'd need to drop it off in ${rfq.oneWayDropOff} (one-way).`
    : "";
  const extras =
    rfq.accessories.length > 0
      ? pick([
          `I'd also need: ${rfq.accessories.join(", ")}.`,
          `Would you have ${rfq.accessories.join(" and ")} too?`,
          `Plus ${rfq.accessories.join(", ")} if possible.`,
        ])
      : "";
  const delivery =
    rfq.fulfillment === "hotel-delivery"
      ? pick([
          "Delivery to my hotel would be ideal.",
          "Could you bring it to my hotel?",
          "If you deliver to hotels, even better.",
        ])
      : "";
  const ask = pick([
    "What is your best price per day?",
    "What's your best price per day?",
    "What would your best daily rate be?",
    "How much per day, best price?",
  ]);
  const thanks = pick(["Thanks!", "Thank you!", "Thanks 🙏", "Thanks a lot!", "Ta!"]);

  return [opener + dropOff, extras, delivery, `${ask} ${thanks}`].filter(Boolean).join(" ");
}

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Human-friendly date for shop-facing messages: "20 Jan" - day-first, the
 * INTERNATIONAL order (US month-first "Jan 20" is ambiguous to most of the
 * world and this string goes into real messages to foreign shops). Deterministic
 * English month, so it never follows the server/device locale.
 */
function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()] ?? ""}`.trim();
}

// ---------------------------------------------------------------------------
// Safety Guardrail Agent - filters outbound custom messages
// ---------------------------------------------------------------------------

export interface SafetyVerdict {
  allowed: boolean;
  reason?: string;
  suggestion?: string;
}

// THE LIST MOVED, IT DID NOT CHANGE (W6.2). It used to be a private const here
// and was therefore unreachable from the feedback pipeline, which had no
// profanity screen of any kind - so the owner's "safe words feedback page" ask
// would have meant a second, drifting copy. See lib/safety/blocklist.ts.

export async function runSafety(message: string): Promise<SafetyVerdict> {
  const trimmed = message.trim();
  if (!trimmed) return { allowed: false, reason: "Message is empty." };
  if (trimmed.length > 600)
    return { allowed: false, reason: "Message is too long (max 600 chars)." };

  // Fast local screen first.
  const { matchesAny, OUTBOUND_BLOCKLIST } = await import("./safety/blocklist");
  if (matchesAny(trimmed, OUTBOUND_BLOCKLIST)) {
    return {
      allowed: false,
      reason:
        "This message contains language that could be unprofessional or harmful. Please rephrase.",
    };
  }

  const { getPrompt } = await import("./prompts");
  const system = await getPrompt("safety");

  const llm = await chat([
    { role: "system", content: system },
    { role: "user", content: trimmed },
  ]);

  if (llm) {
    const verdict = extractJson<SafetyVerdict>(llm);
    if (verdict && typeof verdict.allowed === "boolean") return verdict;
  }
  // No LLM available and it passed the local screen.
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Adaptive Bargaining Agent - composes real negotiation messages to SEND to
// the vendor. It never invents a price: prices come only from vendor replies.
// It learns from the shared tactic playbook and from real bargaining
// transcripts the owner teaches it, and it matches its English level to the
// region (simple, clear English for regions where English is a second
// language; natural fluent English elsewhere). Output is always plain text.
// ---------------------------------------------------------------------------

// Common rental-destination countries -> local currency, matched against the
// geocoded region string so the agent bargains in the money the shop uses.
// Global country -> local currency map so the agent ALWAYS bargains in the money
// the shop uses, anywhere on earth. Matched against the geocoded region string
// (which usually ends in the country name). Order matters only for overlaps.
const REGION_CURRENCY: [RegExp, string][] = [
  [/\bthai|\bthailand\b/i, "THB"],
  [/\bisrael\b|\bpalestin/i, "ILS"],
  [/\bindonesia|\bbali\b|\blombok|\bjakarta/i, "IDR"],
  [/\bvietnam\b|\bviet nam/i, "VND"],
  [/\bindia\b|\bgoa\b/i, "INR"],
  [/\bjapan\b|\bnippon/i, "JPY"],
  [/\bphilippin/i, "PHP"],
  [/\bmalaysia\b|\bkuala lumpur|\blangkawi/i, "MYR"],
  [/\bsingapore\b/i, "SGD"],
  [/\bturkey|\btürkiye|\bturkiye/i, "TRY"],
  [/\bmexico\b|\bméxico|\bcancun|\btulum/i, "MXN"],
  [/\bbrazil|\bbrasil/i, "BRL"],
  [/\bargentin/i, "ARS"],
  [/\bcolombia\b/i, "COP"],
  [/\bperu\b|\bperú/i, "PEN"],
  [/\bchile\b/i, "CLP"],
  [/\bunited arab emirates|\bdubai\b|\babu dhabi|\buae\b/i, "AED"],
  [/\bsaudi\b/i, "SAR"],
  [/\bqatar\b/i, "QAR"],
  [/\bmorocco|\bmarrakech/i, "MAD"],
  [/\begypt\b|\bcairo\b/i, "EGP"],
  [/\bsouth africa|\bcape town|\bjohannesburg/i, "ZAR"],
  [/\bkenya\b/i, "KES"],
  [/\bsri lanka|\bcolombo\b/i, "LKR"],
  [/\bnepal\b/i, "NPR"],
  [/\bcambodia|\bsiem reap|\bphnom penh/i, "USD"], // KHR quoted, USD common
  [/\blaos\b|\blao pdr/i, "LAK"],
  [/\bchina\b|\bbeijing|\bshanghai/i, "CNY"],
  [/\bhong kong/i, "HKD"],
  [/\btaiwan\b|\btaipei/i, "TWD"],
  [/\bsouth korea|\bkorea\b|\bseoul\b/i, "KRW"],
  [/\baustralia|\bsydney|\bmelbourne/i, "AUD"],
  [/\bnew zealand\b/i, "NZD"],
  [/\bcanada\b|\btoronto|\bvancouver/i, "CAD"],
  [/\bswitzerland|\bschweiz|\bsuisse/i, "CHF"],
  [/\bunited kingdom|\bengland|\bscotland|\bwales|\blondon\b/i, "GBP"],
  [/\bpoland\b|\bpolska/i, "PLN"],
  [/\bczech\b|\bprague/i, "CZK"],
  [/\bhungary|\bbudapest/i, "HUF"],
  [/\bsweden\b/i, "SEK"],
  [/\bnorway\b/i, "NOK"],
  [/\bdenmark\b/i, "DKK"],
  [/\brussia\b|\bmoscow/i, "RUB"],
  [
    /\beuro\b|\bspain|\bitaly|\bfrance|\bgermany|\bportugal|\bgreece|\bnetherlands|\bireland|\baustria|\bbelgium|\bcroatia|\bcyprus|\bmalta|\bfinland|\bslovak|\bsloven|\bestonia|\blatvia|\blithuania/i,
    "EUR",
  ],
  [/\bunited states|\busa\b|\bu\.s\.|\bamerica\b/i, "USD"],
];

/** Best-guess local currency for a geocoded region string (undefined if unknown). */
export function currencyForRegion(region?: string): string | undefined {
  if (!region) return undefined;
  for (const [re, cur] of REGION_CURRENCY) if (re.test(region)) return cur;
  return undefined;
}

// Symbols for currencies the agent quotes in. Anything not listed prints the
// ISO code after the number (e.g. "1200 CZK") - always correct, never wrong.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", THB: "฿", ILS: "₪", JPY: "¥", INR: "₹",
  IDR: "Rp", VND: "₫", PHP: "₱", MYR: "RM", SGD: "S$", AUD: "A$", NZD: "NZ$",
  CAD: "C$", CHF: "CHF", CNY: "¥", HKD: "HK$", TWD: "NT$", KRW: "₩", TRY: "₺",
  MXN: "$", BRL: "R$", ARS: "$", COP: "$", CLP: "$", PEN: "S/", AED: "د.إ",
  SAR: "﷼", QAR: "﷼", MAD: "DH", EGP: "E£", ZAR: "R", KES: "KSh", LKR: "Rs",
  NPR: "Rs", LAK: "₭", PLN: "zł", CZK: "Kč", HUF: "Ft", SEK: "kr", NOK: "kr",
  DKK: "kr", RUB: "₽",
};

/** Format money in the LOCAL rental currency (never force dollars). */
export function money(amount: number, currency?: string): string {
  const c = (currency || "USD").toUpperCase();
  const n = Math.round(amount).toLocaleString();
  const sym = CURRENCY_SYMBOLS[c];
  if (!sym) return `${n} ${c}`;
  return sym.length > 1 ? `${sym} ${n}` : `${sym}${n}`;
}

/**
 * Rewrite an outbound message NATIVELY in the main local language of the
 * region (Ultra local-language mode). Returns the original text untouched if
 * the AI is unavailable or the region is unknown - never blocks a send.
 * The English gloss is kept so the traveller can read what was sent.
 */
/**
 * Latin-dominant, real-sentence English detector. Used for LANGUAGE
 * ADAPTATION: when a shop writes an actual English sentence ("Hi Doron, do
 * you speak English?") on a local-language thread, the agent answers in
 * English - matching the human on the other side always beats a setting.
 * Emoji/punctuation are ignored; a bare "ok" (under 3 words) never flips.
 */
/** ONE Latin-dominance bar for both language decisions (owner report 4). It
 * used to be 0.9 here and 0.7 in translateToEnglish, leaving a dead band where
 * a romanized reply was simultaneously "not English" (no adaptation) and "not
 * foreign" (no gloss) - the traveller saw raw text nobody explained. */
export const LATIN_DOMINANT = 0.9;

// Latin script is not English: "bisa antar ke hotel bos" is 100% ASCII and
// used to pass this detector, flipping an Indonesian thread to English on the
// shop's own Indonesian. Real English carries English FUNCTION words; require
// one. (Deliberately no universal shop-speak like "ok"/"day"/"price" - those
// appear verbatim inside SE-Asian chat and would re-open the false flip.)
const ENGLISH_HINT =
  /\b(the|is|are|you|your|we|our|do|does|can|could|will|would|have|has|this|that|what|when|where|how|please|thanks|thank|hello|speak|english|available|sorry|from|with|for|and)\b/i;

export function looksEnglish(text: string): boolean {
  const t = (text || "").trim();
  const letters = t.replace(/[^\p{L}]/gu, "");
  if (!letters) return false;
  const ascii = letters.replace(/[^A-Za-z]/g, "");
  if (ascii.length / letters.length < LATIN_DOMINANT) return false; // another script dominates
  const words = t.split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w));
  if (words.length < 3) return false;
  return ENGLISH_HINT.test(t);
}

// W4.6 - `threadPrefersEnglish` IS GONE, DELIBERATELY.
//
// It flipped a whole thread to English on DEMONSTRATION: the shop's current
// inbound and its previous one both "looked English" - and, with no prior at
// all, the very first inbound flipped it too, because "no previous message" was
// read as agreement. Half the shops in the markets this app runs in type "ok
// 300 per day" at tourists, so the local-language feature quietly ended for
// them on their first reply.
//
// The owner's doctrine is the opposite (report 5, item 15): stay local; switch
// only when the shop SAYS they do not speak the local language. That is an
// explicit statement, read by the W4.3 comprehension pass (a typed model
// judgement, never a phrase list), decided by `wa/thread-language`
// .nextThreadLanguage and STORED on the thread - so it is a decision, not a
// re-derivation from whatever the last two messages happened to look like.
//
// `looksEnglish` survives: it is still the Latin-dominance bar that decides
// whether an inbound needs an English gloss (translateToEnglish below).

/**
 * English gloss for an INBOUND local-language shop reply, so the traveller
 * always understands the conversation their agent is having. Returns null
 * for already-Latin/English text (nothing to translate) or on LLM failure.
 */
export async function translateToEnglish(text: string): Promise<string | null> {
  const t = (text || "").trim();
  if (!t) return null;
  const letters = t.replace(/[^\p{L}]/gu, "");
  if (!letters) return null;
  // "NEEDS A GLOSS" IS NOT "IS NOT LATIN SCRIPT".
  //
  // This gated on Latin-dominance, so Indonesian, Malay, unaccented Vietnamese,
  // Filipino and Spanish - all ~100% ASCII - were never translated. The comment
  // above claimed the dead band was closed; it had only been MOVED, from
  // 0.7-0.9 to everything-Latin. And the consequence was not cosmetic: every
  // deterministic detector downstream (classifyActs, shopAskedQuestion,
  // shopAskedLocation, shopAskedLicense) is English-only regex reading
  // `gloss ?? raw`, so with no gloss they all returned false. An Indonesian
  // shop asking "how many days, can I deliver to your hotel?" produced
  // askedQuestion=false, which means `answer` was not even a LEGAL move, and
  // the agent replied by asking for a price again.
  //
  // The right question is the one looksEnglish already answers: does this carry
  // English function words? If not, gloss it - whatever script it is in.
  if (looksEnglish(t)) return null;
  // A one- or two-word reply ("ok", "500 bos") has nothing to translate and
  // would burn a provider call per turn; looksEnglish already refuses those on
  // word count, so exclude them explicitly rather than glossing every "ok".
  const words = t.split(/\s+/).filter((w) => /[\p{L}]{2,}/u.test(w));
  if (words.length < 3) return null;
  const out = await chat(
    [
      {
        role: "system",
        content:
          "Translate this rental-shop WhatsApp message into natural, plain English. " +
          "Keep every number, price, currency and model name EXACTLY as written. " +
          "Reply with the translation only - no notes.",
      },
      { role: "user", content: t },
    ],
    { budgetMs: 8_000 }
  );
  const res = (out ?? "").trim().slice(0, 600);
  return res || null;
}

/** WHY a localize call handed English back - so the event trail can tell
 * "we never asked" from "the AI failed" from "the AI drifted the numbers".
 * The old single false reason ("AI localization unavailable") blamed the AI
 * for shops whose country simply was not resolved. */
export type LocalizeFallbackReason =
  | "no-region"
  | "english-region"
  | "ai-unavailable"
  | "numbers-drifted";

export async function localizeMessage(
  message: string,
  region?: string,
  voiceKey?: string,
  street = true,
  /**
   * W4.7 - WHERE IN THE THREAD THIS MESSAGE SITS.
   *
   * Prompt rule 1 below explicitly ORDERS the model to write a local greeting.
   * That is right for the message that opens a thread and wrong for every other
   * one - and it silently defeated every greeting repair in the app, because a
   * deterministic strip runs in English and the greeting it re-introduced was
   * in Thai. `greet: false` forbids one instead. Defaults to true so an
   * un-updated caller behaves exactly as it did.
   */
  opts?: { greet?: boolean }
): Promise<{
  text: string;
  english?: string;
  localized: boolean;
  reason?: LocalizeFallbackReason;
}> {
  void voiceKey; // persona intentionally not applied to local-language output
  // ...but the ONE persona rule that is about meaning rather than register has
  // to run here too. `personaHumanize` (which carries deAmbiguateFree) is
  // skipped on this path, so an English source saying "free" for "vacant" got
  // translated with the no-cost sense intact - the Ko Tao failure, in a script
  // the traveller cannot proofread. Fix the SOURCE before the model sees it;
  // the prompt rule below is the second layer, not the only one.
  const source = deAmbiguateFree(message);
  if (!region) return { text: source, localized: false, reason: "no-region" };
  // ENGLISH -> ENGLISH IS NOT A TRANSLATION. Where the everyday language
  // already is English, this call spent up to two LLM round trips (9s budget
  // each, with a retry) to hand back the text it was given - pure latency on
  // the critical path between composing a reply and sending it. Same output,
  // no call. Any country not on the list simply behaves as before.
  if (isEnglishSpeaking(region)) return { text: source, localized: false, reason: "english-region" };
  // NB: we deliberately do NOT inject the English voice persona here - its
  // literal greeting ("Hey") was leaking into the local-language output. The
  // local register itself carries the human tone.
  //
  // DETERMINISM: one transient LLM hiccup must not flip a single shop in the
  // hunt to English while its neighbours get the local language - so a failed
  // attempt retries once before the (documented) English fallback applies.
  let numbersDrifted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await chat(
      [
        {
          role: "system",
          content:
            `Rewrite the traveller's WhatsApp message ENTIRELY in the everyday local language of ${region}, ` +
            "the casual friendly way a local customer messages a rental shop. " +
            (street
              ? "REGISTER: street-level everyday spoken language - short sentences, the words " +
                "people actually type in chats. NEVER formal or written-speech register. "
              : "") +
            "CRITICAL RULES:\n" +
            (opts?.greet === false
              ? // W4.7: MID-CONVERSATION. The English text handed in has already had
                // its greeting removed at the send-time choke point; if the model is
                // told to "use a natural LOCAL greeting" it simply puts one back, in
                // a script no downstream deterministic rail can read.
                "1. Translate the WHOLE message. Do NOT leave ANY English words (no 'Hey', 'Hi', " +
                "'Thanks', etc.). This message is MID-CONVERSATION with a shop we are already " +
                "chatting to: it must NOT begin with a greeting of any kind - no 'สวัสดี', no " +
                "'Hola', no local equivalent. Start straight at the point.\n"
              : "1. Translate the WHOLE message including the greeting and sign-off. Do NOT leave ANY English " +
                "words (no 'Hey', 'Hi', 'Thanks', etc.) - use a natural LOCAL greeting instead.\n") +
            "2. Keep every fact exactly (vehicle, cc, days, accessories, prices); numbers stay as given.\n" +
            // THE AMBIGUITY TRAVELS. The English rail (persona.deAmbiguateFree)
            // is deliberately not applied to local-language output, so if the
            // source says "free" meaning vacant, the translator carries that
            // sense straight into Thai - where "ฟรี" is unambiguously
            // no-charge, and asking a shop for a free motorbike ends the
            // conversation exactly as it did on Ko Tao.
            "2b. If the English says \"free\" about a VEHICLE, it always means AVAILABLE / not " +
            "rented out - never at no cost. Translate it as available/spare. Only translate " +
            "\"free\" as no-charge when it is clearly about something included " +
            "(free delivery, free helmet).\n" +
            "3. The \"english\" field MUST be a FAITHFUL, COMPLETE English translation of the local-language " +
            "message you wrote - the SAME meaning and detail, sentence for sentence, NOT a shortened summary. " +
            "The traveller reads it to know EXACTLY what was sent on their behalf.\n" +
            'Reply ONLY as JSON: { "message": "<full local-language text>", "english": "<faithful full English translation of that exact text>" }.',
        },
        { role: "user", content: source },
      ],
      { budgetMs: 9_000 }
    );
    if (out) {
      const parsed = extractJson<{ message?: string; english?: string }>(out);
      if (parsed?.message && parsed.message.trim().length > 5) {
        const { sanitizeAiText } = await import("./text");
        const text = sanitizeAiText(parsed.message);
        // THE FACTS HAVE TO SURVIVE THE TRIP. Everything upstream treats a
        // numeral as load-bearing - provenance, the duration rail, the rate
        // algebra - and then the last hop handed the text to a model and sent
        // whatever came back, in a script the traveller cannot proofread. A
        // dropped or drifted price is a wrong offer sent in their name. Only
        // 3+ digit numbers are enforced; see integrity/translation.ts for why.
        if (!numbersPreserved(source, text)) {
          // Attempt 0 retries (the loop); attempt 1 falls through to English,
          // which the shop can still read and which quotes the right number.
          numbersDrifted = true;
          continue;
        }
        return {
          text,
          // The gloss is the faithful translation of what we actually sent; if
          // the model omitted it, fall back to the original English source.
          english: parsed.english ? sanitizeAiText(parsed.english) : source,
          localized: true,
        };
      }
    }
  }
  // Honest, DOCUMENTED fallback: English beats a failed send. Callers log a
  // localize-fallback event so a language flip is never a silent mystery -
  // and the reason now says WHICH failure it was.
  return {
    text: source,
    localized: false,
    reason: numbersDrifted ? "numbers-drifted" : "ai-unavailable",
  };
}

export async function composeBargain(opts: {
  rfq: StructuredRFQ;
  vendor: Vendor;
  currentPricePerDay?: number;
  rivalPricePerDay?: number;
  /**
   * The rival per-day was DERIVED by dividing their multi-day package over this
   * many days, not quoted per day (owner report 5 #2 - the "167" screenshot).
   * When set, the message must say "their N-day price works out to about X/day"
   * and must never present X as a price that shop quoted for THIS rental.
   */
  rivalDerivedFromDays?: number;
  region?: string;
  round: number;
  // The LOCAL rental currency where the shop is (e.g. THB) - the agent must
  // bargain in THIS currency, never convert to dollars.
  currency?: string;
  // Ultra feature: bargain in the shop's LOCAL language, street-smart style.
  localLanguage?: boolean;
  // Ask-once discipline: the EXACT target to ask for (anchored to the market
  // floor for the area) and the floor itself - the agent may NEVER go below
  // the floor. Absurd lowballs (70 THB/day scooters) kill deals and trust.
  targetPricePerDay?: number;
  floorPricePerDay?: number;
  // Recent conversation, oldest first, so the agent never re-asks anything
  // the shop already answered.
  history?: string;
  // Identity of the human whose WhatsApp sends this - powers the stable
  // per-user voice persona and the anti-repetition memory.
  voiceKey?: string;
  // Orchestrator additions: owner stage instructions, edge rules, language
  // register and strategist leverage notes, appended to the system prompt.
  extraDirectives?: string;
}): Promise<{
  message: string;
  tacticId: string;
  tacticLabel: string;
  english?: string;
  // True when the AI was unreachable and a varied template was used instead.
  fallback?: boolean;
  // True when a LOCAL-LANGUAGE bargain could not be localized (template AND
  // localizer both failed): the message field holds fluent English, which on
  // a Thai/Spanish thread is a language flip mid-negotiation. AUTO callers
  // suppress the send (the next event recomposes); interactive callers may
  // still show the English draft to the traveller, who decides.
  localizeFailed?: boolean;
}> {
  const cur = opts.currency || currencyForRegion(opts.region) || "USD";
  // Owner-tuned thresholds (defaults = the historical literals below).
  const { getPolicyOverlay, DEFAULT_OVERLAY } = await import("./ops/overlay");
  const overlay = await getPolicyOverlay().catch(() => DEFAULT_OVERLAY);
  // Sane target: the market floor when we know it, otherwise a modest cut
  // (default 15%). The REAL floor is the honest lower bound - when we know it
  // we may ask it outright (the playbook's first push IS the floor); only
  // without a floor does the lowball guard protect against absurd asks.
  const quoted = opts.currentPricePerDay;
  let target = opts.targetPricePerDay;
  if (!target && quoted) {
    target = Math.round(quoted * overlay.defaultCut);
  }
  if (target && quoted) {
    const lowest = opts.floorPricePerDay ?? Math.round(quoted * overlay.lowballGuard);
    if (target < lowest) target = lowest;
    // Ask for a clean, human number (220, not 213) - odd figures read as
    // robotic and weaken the ask. When the ENGINE provided the target it is
    // already nice-rounded and recorded in thread state (lastTarget) - do not
    // re-round it here or the message would name a different number than the
    // ladder tracks.
    if (!opts.targetPricePerDay) target = roundNice(target);
    if (target >= quoted) target = undefined; // quote already at/below target
  }
  // BEAT, NEVER MATCH (owner report 5 #2). Whenever we hold a cheaper rival,
  // the number we ask for is strictly BELOW it - a target equal to the rival is
  // a match dressed as an ask, and the best outcome of a successful match is
  // the price the traveller already had. `roundNice` above can also land the
  // target exactly ON the rival, so this runs last and binds unconditionally.
  if (opts.rivalPricePerDay && opts.rivalPricePerDay > 0) {
    target = beatRivalTarget({
      rivalPricePerDay: opts.rivalPricePerDay,
      quotePerDay: quoted,
      floorPerDay: opts.floorPricePerDay,
    });
  }
  // Refresh the durable tactic table first (30s-cached, one query at most) so
  // win-rate learning from other instances/deploys reaches this compose.
  const { listTraining, hydrateTactics } = await import("./memory");
  await hydrateTactics();
  const tactics = getTactics();
  const tactic = tactics[Math.min(opts.round, tactics.length - 1)] ?? tactics[0];

  // Training examples: a balanced 2+2 mix of the owner's hand-taught
  // transcripts and Ops-Center learning (bookmarked exemplars + corrections),
  // so review-console feedback reaches every future bargain without ever
  // crowding out the original teaching. In-memory examples fill any gap.
  const { sbSelect } = await import("./runtime-config");
  const [classic, opsRows] = await Promise.all([
    sbSelect<{ text: string }>(
      "agent_training",
      "select=text&source=not.in.(ops-exemplar,ops-correction)&order=created_at.desc&limit=2"
    ).catch(() => []),
    sbSelect<{ text: string }>(
      "agent_training",
      "select=text&source=in.(ops-exemplar,ops-correction)&order=created_at.desc&limit=2"
    ).catch(() => []),
  ]);
  const examples = [
    ...classic.map((d) => d.text),
    ...opsRows.map((d) => d.text),
    ...listTraining().map((t) => t.text),
  ];
  const training = Array.from(new Set(examples)).slice(0, 4).join("\n---\n");

  const spec =
    opts.rfq.vehicleClass === "car"
      ? `${[
          opts.rfq.transmission !== "any" ? opts.rfq.transmission : "",
          opts.rfq.carType && opts.rfq.carType !== "any" ? opts.rfq.carType : "",
          "car",
          opts.rfq.seats ? `${opts.rfq.seats} seats` : "",
        ]
          .filter(Boolean)
          .join(" ")} for ${nDays(opts.rfq.durationDays)}`
      : `${opts.rfq.engineSizeCc ? opts.rfq.engineSizeCc + "cc " : ""}${vehicleTerm(
          opts.rfq.vehicleClass
        )} for ${nDays(opts.rfq.durationDays)}`;

  // Duration-based discount levers: long rentals deserve the weekly/monthly
  // rate framing - the strongest honest card a traveller holds.
  const rentalDays = opts.rfq.durationDays;
  const durationLever =
    rentalDays >= 25
      ? `The rental is ${rentalDays} days - essentially a MONTH. Frame the ask around the monthly rate ("for one month, what is your monthly price?") - monthly rates are always far below day-rate x days. `
      : rentalDays >= 7
      ? `The rental is ${rentalDays} days - a week or more. Frame the ask around the weekly rate ("for ${rentalDays} days, can you give the weekly price?") - shops always have a lower weekly number. `
      : "";
  // When the shop resists the number, value can still be won at THEIR price.
  const packagePivot =
    `If they push back on the number, pivot to PACKAGE value at their price instead of arguing: ` +
    `free helmet(s), free delivery to the hotel, a full tank, or free insurance - pick ONE that fits the chat. `;

  // Round-aware playbook directives - the owner's launch scripts, generalized.
  const roundPlay =
    (opts.round <= 0
      ? `FIRST PUSH (the owner's playbook): their opening quote is above the fair local price. ` +
        `Use the rental DAYS as leverage: warmly apologize that the quote is really expensive for you, ` +
        `mention you are renting for ${nDays(opts.rfq.durationDays)} (a long time), and ask for the target ` +
        `price per day like a friend would. The SHAPE to follow (NEVER these exact words - always fresh phrasing): ` +
        `"oh so sorry, <their price> is really expensive for me. I rent for <days> days, long time. ` +
        `Can you give me <target> a day my friend? <one warm emoji>". `
      : opts.round === 1
      ? `SECOND PUSH: they refused the first ask ("cannot give that price"). Come back relaxed and friendly ` +
        `with the new, slightly higher round-number target - meet them partway, make it feel easy to say yes, ` +
        `hint you are ready to book today. Never apologize twice, never sound needy. ` +
        packagePivot
      : `FINAL NUDGE: one last tiny, warm ask at the target - fully relaxed, zero pressure, ` +
        `and make clear you are happy either way. ` +
        packagePivot) +
    // Round 0 ALREADY leads with the days-leverage play, so appending the
    // weekly/monthly duration lever there double-states it (reads robotic).
    // Add the duration lever only from round 1 on, as a fresh angle.
    (opts.round <= 0 ? "" : durationLever);

  const system =
    "You write ONE short WhatsApp message from a real human traveller chatting " +
    "with a rental shop. Rules: plain text only, no markdown, no asterisks, no " +
    "emoji spam (max one), 1-3 sentences, warm and polite, never robotic, never " +
    "mention an app or assistant. Never invent prices we were not given. " +
    roundPlay +
    "Never repeat a question the shop already answered. " +
    "VARY YOUR ARGUMENTS: never reuse a lever already played in this " +
    "conversation (check the history) - if the many-days card was used, switch " +
    "to the weekly rate, a package ask (helmet/delivery/full tank), the rival " +
    "offer, or booking right now. A repeated argument reads as a bot. " +
    (opts.history
      ? "Conversation so far (oldest first) - do NOT re-ask anything answered here:\n" +
        opts.history +
        "\n"
      : "") +
    `Preferred tactic: "${tactic.label}" (${tactic.script}). ` +
    (target
      ? `THE ASK: ask if ${money(target, cur)}/day is possible for the ${opts.rfq.durationDays}-day rental - this number is anchored to the real local market floor. NEVER propose a number lower than ${money(opts.floorPricePerDay ?? Math.round((quoted ?? target) * overlay.lowballGuard), cur)} - unrealistic lowballs insult the shop. ` +
        (quoted
          ? `HARD ARITHMETIC RULE: you are asking the shop to LOWER their price, so the ONLY number you may propose is ${money(target, cur)}/day - never a number equal to or ABOVE their current ${money(quoted, cur)}/day (asking for MORE than they offered is nonsensical). `
          : "")
      : "Do NOT propose any specific number - just warmly ask for their best price. ") +
    "ABSOLUTE RULE: never claim another shop gave you a price unless one is stated in LEVERAGE below - do NOT invent a competitor, a rival number, or any price you were not given. " +
    `CRITICAL MONEY RULE: talk about price ONLY in ${cur} - the shop's own local currency. Never write a dollar sign or convert to USD unless ${cur} is USD. Match the numbers the shop uses. ` +
    (opts.localLanguage && opts.region
      ? `CRITICAL: think and write NATIVELY in the main local language of ${opts.region} from the first word - never compose in English and translate. Use the casual street register a savvy local uses at the market: local haggling phrases, local currency habits, natural slang (respectful, never rude). Short and punchy. `
      : `The shop speaks a different language than you, so write in SIMPLE, slightly BROKEN non-native English - the way a friendly foreign traveller who learned English as a second language actually types on WhatsApp. Short, telegraphic sentences. Basic common words only. It is FINE (and better) to drop small words or articles occasionally ("is too much for me", "I rent 5 days") - do NOT write polished, fluent, or business English. Stay polite, warm and 100% clear - never rude, never confusing. End with ONE warm emoji. NO idioms, NO wordplay, NO salesy tone. ` +
        (opts.region
          ? `The shop is in ${opts.region}; keep every sentence short and very simple. `
          : "")) +
    // The rental length is FACT, not something to improvise: state it as EXACTLY
    // this many days whenever you mention days - a wrong number (e.g. 3 when it
    // is 5) both looks incoherent and throws away a "discount for long term".
    `HARD FACT - the rental is EXACTLY ${opts.rfq.durationDays} day(s). If you mention the number of days, it MUST be ${opts.rfq.durationDays} - never any other number. ` +
    (training
      ? "Learn ONLY tone, warmth and sentence rhythm from these past bargains - " +
        "they are from DIFFERENT negotiations, so NEVER copy any number, price, " +
        "currency or day-count out of them (those belong to other shops and other " +
        "trips). Use ONLY this chat's real figures:\n" + training
      : "");

  // Owner-editable house rules for the bargaining agent (never removable).
  const { getPrompt } = await import("./prompts");
  const directives = await getPrompt("bargain_directives");
  let systemWithDirectives = directives ? `${system}\nHOUSE RULES: ${directives}` : system;
  // Orchestrator: owner stage instructions, edge rules, register, leverage.
  if (opts.extraDirectives?.trim()) {
    systemWithDirectives += `\n${opts.extraDirectives.trim()}`;
  }
  // Mid-conversation bargains never greet again - we are already talking.
  if (opts.history) {
    systemWithDirectives +=
      "\nYou are MID-CONVERSATION: do NOT start with a greeting (no hey/hi/hello) - go straight into the message.";
  }
  // HARD cross-shop leverage: when a real same-search competitor price exists it
  // is the strongest card the traveller holds - the model must NOT drop it under
  // the "vary your arguments" directive. Force the number + the rental days into
  // the message, in very simple broken English (many shops read basic English).
  //
  // BEAT, NEVER MATCH (owner report 5 #2). This block used to end "ask this shop
  // to match or beat it" and then MODEL the match in its own few-shot ("you can
  // do same or better?"). A match hands over the traveller's strongest card and
  // wins them nothing - the price they already had. The ask is now a concrete
  // number strictly below the rival, and spte/rails refuses any draft that asks
  // to match anyway, so this stopped being advice.
  if (opts.rivalPricePerDay) {
    const beat =
      target && target < opts.rivalPricePerDay
        ? target
        : beatRivalTarget({
            rivalPricePerDay: opts.rivalPricePerDay,
            quotePerDay: quoted,
            floorPerDay: opts.floorPricePerDay,
          });
    // HONEST PROVENANCE: a per-day we divided out of their package is stated as
    // the arithmetic it is, never as a price that shop quoted for these days.
    const derived = opts.rivalDerivedFromDays;
    const leverageFact =
      typeof derived === "number" && derived > 0
        ? `a real nearby shop in this same search quoted a ${derived}-day package that WORKS OUT TO about ${money(
            opts.rivalPricePerDay,
            cur
          )}/day. That is our arithmetic on their package, NOT a per-day price they gave for ${nDays(
            opts.rfq.durationDays
          )} - say "their ${derived}-day price works out to about ${money(
            opts.rivalPricePerDay,
            cur
          )} a day", never "they gave me ${money(opts.rivalPricePerDay, cur)} a day"`
        : `a real nearby shop in this same search gave ${money(
            opts.rivalPricePerDay,
            cur
          )}/day for the SAME ${vehicleTerm(opts.rfq.vehicleClass)} for these ${nDays(
            opts.rfq.durationDays
          )}`;
    systemWithDirectives +=
      `\nHARD LEVERAGE RULE: ${leverageFact}. You MUST name the ${money(
        opts.rivalPricePerDay,
        cur
      )} figure AND the ${nDays(
        opts.rfq.durationDays
      )} - never omit or soften them away. Then ask THIS shop for ${money(
        beat,
        cur
      )}/day, which is strictly LOWER than the other offer. ` +
      `NEVER ask them to "match" it, to do "the same", or to "get close to" it: a matching price leaves the traveller exactly where they already are, so the only outcome worth asking for is a LOWER one. ` +
      `Very simple broken English, e.g. "another shop give me ${opts.rivalPricePerDay} per day for ${nDays(
        opts.rfq.durationDays
      )}, you can do ${beat}? then i rent from you".`;
  }

  // ZERO-PATTERN AUTHENTICITY: (a) a stable per-user voice persona so every
  // user's agent sounds like ONE consistent, distinct human; (b) the user's
  // recent outbound messages injected as a DO-NOT-REPEAT list so no phrasing
  // is ever recycled across shops.
  if (opts.voiceKey) {
    const { voiceProfileFor, voiceDirectives } = await import("./voice");
    // W4.7: the persona's greeting habit belongs to the OPENER. A bargain with
    // history is mid-conversation, and naming a greeting here contradicted the
    // "do NOT start with a greeting" rule added twenty lines above.
    systemWithDirectives += `\n${voiceDirectives(voiceProfileFor(opts.voiceKey), {
      greeting: !opts.history,
    })}`;
    try {
      const recent = await sbSelect<{ body: string | null }>(
        "whatsapp_messages",
        `select=body&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
          opts.voiceKey
        )}&order=received_at.desc&limit=5`
      );
      const lines = recent.map((r) => (r.body ?? "").slice(0, 160)).filter(Boolean);
      if (lines.length) {
        systemWithDirectives +=
          "\nANTI-REPETITION (critical): these are messages this person sent recently. " +
          "Your new message must NOT reuse their openings, sentence structures or phrasings - " +
          "write something genuinely fresh:\n- " +
          lines.join("\n- ");
      }
    } catch {
      /* anti-repeat context is an enhancement */
    }
  }

  const user =
    `Vehicle: ${spec}. Currency: ${cur}. ` +
    (quoted ? `They quoted ${money(quoted, cur)}/day. ` : "No quote yet. ") +
    // BEAT, NEVER MATCH - the second of the two composeBargain sites that
    // carried "match or beat it" verbatim. See the HARD LEVERAGE RULE above.
    (opts.rivalPricePerDay
      ? `LEVERAGE (you MUST use this): ${
          typeof opts.rivalDerivedFromDays === "number" && opts.rivalDerivedFromDays > 0
            ? `another shop in the traveller's search quoted a ${
                opts.rivalDerivedFromDays
              }-day package that works out to about ${money(
                opts.rivalPricePerDay,
                cur
              )}/day for the same ${vehicleTerm(
                opts.rfq.vehicleClass
              )}. Say it as "works out to about" - they never quoted that as a daily price`
            : `another shop in the traveller's search ALREADY offered ${money(
                opts.rivalPricePerDay,
                cur
              )}/day for the same ${vehicleTerm(opts.rfq.vehicleClass)} for this ${
                opts.rfq.durationDays
              }-day rental`
        }. Your message MUST state that ${money(
          opts.rivalPricePerDay,
          cur
        )} figure and the ${nDays(
          opts.rfq.durationDays
        )}, and then ask THIS shop for a price BELOW it to close now - make clear you'll rent from whoever is cheaper. Never ask them to match it, to do the same, or to get close to it; matching wins the traveller nothing. Friendly, never threatening. Do NOT omit the ${money(
          opts.rivalPricePerDay,
          cur
        )} number or the ${nDays(opts.rfq.durationDays)}. `
      : "") +
    (target
      ? `Write our single friendly ask for ${money(target, cur)}/day. All amounts in ${cur}.`
      : `Write one friendly message asking their best price. All amounts in ${cur}.`);

  // When bargaining in the LOCAL language, ask for BOTH the local message and
  // a short plain-English gloss (as JSON) so the traveller can read what their
  // agent is saying on their behalf.
  const localSystem = opts.localLanguage
    ? systemWithDirectives +
      ' Reply ONLY as JSON: { "message": "<the local-language message>", "english": "<a short plain-English translation of it>" }.'
    : systemWithDirectives;

  const llm = await chat([
    { role: "system", content: localSystem },
    { role: "user", content: user },
  ]);

  const { sanitizeAiText } = await import("./text");
  if (llm) {
    if (opts.localLanguage) {
      const parsed = extractJson<{ message?: string; english?: string }>(llm);
      if (parsed?.message) {
        return {
          message: sanitizeAiText(parsed.message),
          english: parsed.english ? sanitizeAiText(parsed.english) : undefined,
          tacticId: tactic.id,
          tacticLabel: tactic.label,
        };
      }
    }
    return {
      message: sanitizeAiText(llm),
      tacticId: tactic.id,
      tacticLabel: tactic.label,
    };
  }

  // Deterministic fallback (AI unreachable). Varied templates so even the
  // fallback never sends the same message twice, and it is flagged so the UI
  // can tell the user this was a template, not the real agent brain.
  const days = opts.rfq.durationDays;
  const vt = vehicleTerm(opts.rfq.vehicleClass);
  const q = quoted ? money(quoted, cur) : undefined;
  // BEAT, NEVER MATCH - in the LLM-down path too.
  //
  // Every rival template below used `t ?? rival`, so with no computed target the
  // deterministic agent asked the shop for the rival's EXACT number, and the
  // later-round pool asked it to "get close to" it. Both are matches. The ask
  // here is always a real number strictly below the rival: `beatAsk` never
  // falls back to the rival itself, and the phrasing never softens to
  // "close to".
  const beatAsk =
    opts.rivalPricePerDay && opts.rivalPricePerDay > 0
      ? beatRivalTarget({
          rivalPricePerDay: opts.rivalPricePerDay,
          quotePerDay: quoted,
          floorPerDay: opts.floorPricePerDay,
        })
      : undefined;
  const t = target ? money(target, cur) : beatAsk ? money(beatAsk, cur) : undefined;
  const rival = opts.rivalPricePerDay ? money(opts.rivalPricePerDay, cur) : undefined;
  // Honest provenance for a per-day we divided out of their package.
  const rivalPhrase =
    typeof opts.rivalDerivedFromDays === "number" && opts.rivalDerivedFromDays > 0
      ? `another shop's ${opts.rivalDerivedFromDays}-day price works out to about ${rival}/day`
      : `another shop offered me ${rival}/day for the same ${vt}`;
  const ask = t ?? (beatAsk ? money(beatAsk, cur) : rival);
  const fallbackPool = rival
    ? opts.round <= 0
      ? [
          `Thanks! Just being upfront - ${rivalPhrase}. If you can go under that, I'll happily rent from you. Could you do ${ask}/day for the ${nDays(days)}? 🙂`,
          `Appreciate it! ${rivalPhrase[0].toUpperCase()}${rivalPhrase.slice(1)}. I'd honestly prefer your place - any chance you could do ${ask}/day for ${nDays(days)}? 🙏`,
        ]
      : [
          // Later rounds: don't re-wave the rival card the same way - soften the
          // TONE, never the number. "Get close to X" was a match in disguise.
          `Ok! Honestly I really want to rent from you - at ${ask}/day for the ${nDays(days)} I book right now. 🤝`,
          `I hear you! Just ${ask}/day and it's done - I'd rather give you the ${nDays(days)} than the other shop. 🙂`,
          `No pressure - ${ask}/day for ${nDays(days)} and I confirm today. I'd love it to be your place. 🙏`,
        ]
    : t && opts.round <= 0
    ? [
        // The owner's opener: days as leverage, ask the floor, warm as a friend.
        `Oh sorry${q ? `, ${q}` : ""} is really expensive for me 🫶 I'm renting ${nDays(days)}, long time - could you do ${t} a day my friend?`,
        `Ah that's a bit much for me honestly! Since I take it for ${nDays(days)}, can you make it ${t}/day? Would book right away 🙏`,
        `Ouch${q ? `, ${q}/day` : ""} is over my budget 😅 For ${nDays(days)} straight, would ${t} a day work? I'd confirm today.`,
      ]
    : t
    ? [
        `Okay I understand! Let's meet in the middle - ${t}/day for the ${nDays(days)} and I book now? 🙂`,
        `Fair enough! Could we say ${t}/day since it's ${days} full days? If yes I'm in.`,
        `Got it - what about ${t}/day for the ${nDays(days)}? That would seal it for me today 🤝`,
      ]
    : [
        `Thanks! What's the very best daily rate you could do for the ${nDays(days)}? I'm ready to book if it works.`,
        `Appreciate it! Any wiggle room on the daily price for a ${days}-day rental? I can confirm right away.`,
      ];
  const filled = fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
  // A LOCALIZED thread must not receive fluent English because the AI blinked
  // (owner report 4): mid-Thai-negotiation English is the bot tell. Try the
  // localizer once (its provider chain differs from the compose call that
  // just failed, so this is not futile); if it also fails, flag the draft so
  // AUTO callers suppress it instead of flipping the thread's language.
  if (opts.localLanguage && opts.region && !isEnglishSpeaking(opts.region)) {
    const localized = await localizeMessage(filled, opts.region, undefined, true);
    if (localized.localized) {
      return {
        message: localized.text,
        english: localized.english ?? sanitizeAiText(filled),
        tacticId: tactic.id,
        tacticLabel: tactic.label,
        fallback: true,
      };
    }
    return {
      message: sanitizeAiText(filled),
      tacticId: tactic.id,
      tacticLabel: tactic.label,
      fallback: true,
      localizeFailed: true,
    };
  }
  return {
    message: sanitizeAiText(filled),
    tacticId: tactic.id,
    tacticLabel: tactic.label,
    fallback: true,
  };
}

/** Record a bargaining outcome so the playbook keeps learning. */
export function learnOutcome(tacticId: string, won: boolean, discountPct: number) {
  recordOutcome(tacticId, won, Math.max(0, Math.min(60, discountPct)));
}

/** Market-Rate Analyst Agent - estimates a fair local rate for the spec. */
export function marketRateFor(vendor: Vendor, rfq: StructuredRFQ): number {
  const classBase =
    rfq.vehicleClass === "car" ? 32 : rfq.vehicleClass === "motorbike" ? 16 : 11;
  const ccBump = rfq.engineSizeCc ? Math.max(0, (rfq.engineSizeCc - 125) / 125) * 4 : 0;
  const durationDiscount = rfq.durationDays >= 7 ? 0.85 : rfq.durationDays >= 3 ? 0.93 : 1;
  return Math.round((classBase + ccBump) * durationDiscount);
}

/** Vendor Sentiment Agent - infers responsiveness/warmth as a 0..1 score. */
export function sentimentFor(vendor: Vendor, round: number): number {
  const base = (vendor.rating - 3.5) / 1.4; // rating → 0..1-ish
  const warmth = Math.min(1, Math.max(0.1, base + round * 0.08));
  return Number(warmth.toFixed(2));
}

// ---------------------------------------------------------------------------
// Offer Extraction Agent - reads vendor replies (text AND price-list images),
// and never passes a price to the user unless it is certain the price matches
// the exact requested vehicle. When unsure it produces a clarification message
// for the vendor instead.
// ---------------------------------------------------------------------------

export interface ExtractedOffer {
  found: boolean;
  pricePerDay?: number;
  // The shop's REGULAR/list price when it restated one ("normally it's
  // 300/day"). An anchor for the negotiator - never the traveller's price, and
  // never written to the offers table.
  listPricePerDay?: number;
  /**
   * Every tier the shop named when it offered a CHOICE ("some models 200 and
   * some new 250/day"). Empty for the ordinary one-price reply. `pricePerDay`
   * stays the cheapest on-spec tier so every existing caller keeps working.
   */
  options?: import("./offer-options").VehicleOption[];
  currency?: string;
  vehicleDescription?: string;
  /**
   * Does this price refer to the vehicle the traveller asked for?
   *
   * DERIVED from `vehicleVerdict` and kept because every existing surface reads
   * it. It is false ONLY for a real mismatch - an "unclear" reply is not a
   * wrong vehicle, and treating it as one used to close live negotiations.
   */
  matchesSpec: boolean;
  /**
   * The three-way truth behind `matchesSpec`. "unclear" means the shop has not
   * said yet (a bare price, a menu, a question back) - the negotiation carries
   * on and we ask. Absent on legacy/deterministic paths.
   */
  vehicleVerdict?: "match" | "mismatch" | "unclear";
  /**
   * The vehicle-identity gate's verdict for THIS price (src/lib/vehicle).
   * Present whenever a price was read. `status` is the only thing any surface
   * should trust when deciding whether a number is a deal: `confirmed` means
   * every disqualifying attribute the traveller declared has been resolved and
   * matches; anything else carries the question that has to be answered first.
   */
  vehicleAssessment?: {
    status: "confirmed" | "needs-confirmation" | "wrong-vehicle";
    reason: string;
    question: string;
    travellerNote: string;
    missing: string[];
    model?: string;
  };
  /**
   * The THREAD-level confirmation state (src/lib/vehicle/confirmation.ts),
   * resolved once per inbound turn in agent-loop and persisted with the
   * negotiation thread. Message-level `vehicleAssessment` says what THIS text
   * proves; this says what the CONVERSATION has established - a confirmed
   * thread never regresses on a vehicle-less price update.
   */
  vehicleConfirmation?: {
    status: "confirmed" | "assumed" | "unconfirmed";
    evidence: string;
    at: string;
    askedAt?: string;
  };
  /**
   * THE SHOP HAS NOTHING TO RENT right now. Resolved per turn from the thread's
   * own availability claims (thread/ledger stockState) and persisted with the
   * negotiation thread, exactly like `vehicleConfirmation` above - so the card
   * can say "out of stock" instead of waiting forever for a price, and a later
   * "we have one now" clears it with no special case.
   */
  shopUnavailable?: boolean;
  /** The shop's own words about when stock returns, when it gave any. */
  restockHint?: string;
  confidence: "high" | "medium" | "low";
  clarifyMessage?: string;
  // ONLY set when the shop explicitly confirmed them - never guessed.
  deposit?: string; // e.g. "Passport only", "3,000 THB cash"
  // Structured deposit derived from the label (see lib/deposit.ts).
  depositType?: import("./deposit").DepositType;
  depositAmount?: number;
  depositCurrency?: string;
  // What KIND of image the shop sent (set by the vision classifier). Lets the
  // branching engine thank the shop for a vehicle photo vs read a price sheet.
  imageKind?: "vehicle" | "price_sheet" | "document" | "other";
  /**
   * WHAT THE PICTURE SHOWS, judged from pixels rather than from any caption.
   * A closed vocabulary, so it can cross-check the text-derived verdict: a
   * photo of a car answering a scooter request is a wrong-vehicle signal even
   * when every word in the message says otherwise.
   */
  seenVehicleClass?: "scooter" | "motorbike" | "car" | "unclear";
  /** Does what we SEE match the traveller's declared class? null = unclear. */
  seenMatchesRequest?: boolean | null;
  delivers?: boolean | null;
  // Extra rental terms, only when the shop explicitly stated them.
  deliveryFee?: number | null; // in the reply's currency; 0 = free
  insuranceIncluded?: boolean | null;
  kmLimitPerDay?: number | "unlimited" | null;
  fuelPolicy?: string | null;
  // ---- Negotiation-state signals for the graph engine (never guessed) -------
  // The shop offered to COME PICK THE TRAVELLER UP (by car/bike) - distinct
  // from delivering the vehicle to the hotel.
  pickupOffered?: boolean | null;
  // The shop explicitly said in-store only ("come to shop", "no delivery").
  onShopOnly?: boolean | null;
  // The shop is holding firm on price ("last price", "cannot go lower").
  shopFirm?: boolean | null;
  // The shop WALKED AWAY: told the traveller to take the other offer, said
  // not interested / no thanks / goodbye. Ends the negotiation gracefully.
  shopDeclined?: boolean | null;
  // The shop's tone in THIS reply - "annoyed" stops further pushing.
  shopTone?: "warm" | "neutral" | "annoyed" | null;
  // Constrained fact tags (item #13) from the reply, e.g. "helmets-included".
  // Vocabulary is enforced in vendor-tags.ts; anything else is dropped.
  tags?: string[];
  // ---- Extract-everything media fields (photos carry facts nobody asked yet) --
  // Odometer reading in km when visible in a photo (never confused with price).
  mileageKm?: number | null;
  // Honest visible-condition note (scratches, worn tires, clean/new...).
  conditionNotes?: string | null;
  // 1-3 sentences listing EVERYTHING informative seen in the photo.
  imageSummary?: string | null;
  /**
   * DID WE ACTUALLY LOOK AT THE PHOTO?
   *
   * Present on every extraction that had images. `seen:false` means the vision
   * providers failed - a rejected key, a quota, a timeout, a safety block - so
   * this extraction's `found:false` is an ABSENCE OF A READ, not a reading that
   * found nothing. Without this the two were byte-identical, and an outage was
   * shown to the traveller as a confident "nothing readable in this one".
   */
  imageRead?: {
    seen: boolean;
    failure?: import("./ai").VisionFailure;
    detail?: string;
    retryable?: boolean;
    /**
     * THE READER RAN AND WE STILL HAVE NOTHING - and it is OUR fault, not the
     * photo's. `parse-failed` (the model answered, the JSON did not parse),
     * `truncated` (the answer was cut off at our token ceiling),
     * `sanity-nulled` (we read a price and rejected it as implausible). Without
     * this, all three arrived at the traveller as "the photo was blank".
     */
    modelFailure?: import("./media/reading").ModelReadFailure;
    /** The implausible number the sanity net rejected (`sanity-nulled`). */
    rejectedPricePerDay?: number;
    rejectedCurrency?: string;
  };
}

// Deterministic negotiation-signal readers - the no-LLM fallback AND the
// arithmetic backstop that always runs (a model can miss "last price"; the
// regex never does). Word boundaries keep "no discount" from matching inside
// unrelated text.
const FIRM_RX =
  /\b(last price|final price|best price already|fix(?:ed)? price|cannot (?:go )?lower|can'?t (?:go )?lower|no discount|no lower|lowest (?:price|already)|same price for everyone|price is firm)\b/i;
const PICKUP_RX =
  /\b(pick you up|come pick you|we pick you|i pick you|pick[- ]?up service|we (?:can )?come (?:get|take) you)\b/i;
const ON_SHOP_RX =
  /\b(only (?:at|in) (?:the )?shop|come (?:to|at) (?:the )?shop|no delivery|pick ?up at (?:the )?shop|you come (?:to )?(?:the )?shop|at shop only|in[- ]store only)\b/i;
const ANNOYED_RX =
  /\b(go (?:to )?(them|others?)( then)?|stop asking|already told you|how many times|waste (?:my|our) time|no more|enough|final answer)\b/i;
// The shop walks away from the deal ("that's OK you can take it there",
// "not interested", "no thanks", "good luck") - the negotiation is over.
const DECLINED_RX =
  /\b(you can take it there|take (?:it|that) (?:one|offer|deal)( then)?|go with (?:them|the other)|not interested|no,? thank(?:s| you)[.! ]*$|good luck( then)?|we (?:can'?t|cannot) help|sorry,? (?:no|cannot))\b/i;

/**
 * MODEL-FIRST TONE (K6). The old merge OR-ed the regex in: ANNOYED_RX could
 * force "annoyed" over a model that read the whole glossed message as warm,
 * while nothing could ever force "warm" - a one-way ratchet built from
 * keywords ("enough", "no more") that appear in perfectly friendly replies
 * ("no more than 300 and it's yours"). The model's verdict now wins BOTH
 * ways; the regex answers only when the model was silent or off-vocabulary.
 */
export function mergeShopTone(
  model: unknown,
  heuristic: "warm" | "neutral" | "annoyed" | null
): "warm" | "neutral" | "annoyed" | null {
  if (model === "warm" || model === "neutral" || model === "annoyed") return model;
  return heuristic === "annoyed" ? "annoyed" : null;
}

export function readNegotiationSignals(text: string): {
  pickupOffered: boolean | null;
  onShopOnly: boolean | null;
  shopFirm: boolean | null;
  shopDeclined: boolean | null;
  shopTone: "warm" | "neutral" | "annoyed" | null;
} {
  const t = text || "";
  return {
    pickupOffered: PICKUP_RX.test(t) ? true : null,
    onShopOnly: ON_SHOP_RX.test(t) ? true : null,
    shopFirm: FIRM_RX.test(t) ? true : null,
    shopDeclined: DECLINED_RX.test(t) ? true : null,
    shopTone: ANNOYED_RX.test(t) ? "annoyed" : null,
  };
}

/**
 * Deterministic deposit reader - the no-LLM backstop. Only fires when the
 * message actually talks about a deposit/passport/cash-guarantee (never turns
 * a daily price into a deposit), then reuses the same parseDeposit the LLM
 * path uses so "Passport only" / "Deposit 3000 cash" / "3000 cash is fine"
 * register even when every AI provider is down.
 */
export function heuristicDepositFields(
  text: string,
  fallbackCurrency?: string
): Pick<ExtractedOffer, "deposit" | "depositType" | "depositAmount" | "depositCurrency"> {
  const t = (text || "").trim();
  if (!t || !/(deposit|passport|id card|licen[cs]e|\bcash\b)/i.test(t)) return {};
  // Work sentence-by-sentence so we grab the deposit clause, not the price.
  const sentence = t
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .find((s) => {
      if (!/(deposit|passport|id card|licen[cs]e|\bcash\b)/i.test(s)) return false;
      // "200 per day cash" is a PRICE clause - only accept a cash-only clause
      // when it cannot be the daily rate.
      if (/per\s*day|\/\s*day|a day|daily/i.test(s) && !/deposit|passport/i.test(s)) return false;
      return true;
    });
  if (!sentence) return {};
  const parsed = parseDeposit(sentence, fallbackCurrency);
  if (!parsed || parsed.type === "other") return {};
  return {
    deposit: sentence.slice(0, 80),
    depositType: parsed.type,
    depositAmount: parsed.amount,
    depositCurrency: parsed.currency,
  };
}

/**
 * ONE structured call that settles a genuine per-day-vs-total disagreement
 * between the LLM extractor and the deterministic reader. The algebra decides
 * the clear cases without it (a division artifact reconstructs the other
 * engine's number); this runs only when the two engines read genuinely
 * different semantics out of the same words. The answer is only ever adopted
 * when it lands ON one of the two grounded candidates - the arbiter picks,
 * it never invents.
 */
export async function arbitratePriceBasis(input: {
  message: string;
  durationDays: number;
  candidateA: number;
  candidateB: number;
}): Promise<number | null> {
  const out = await chat(
    [
      {
        role: "system",
        content:
          "You resolve ONE ambiguity in a rental-price message: what is the true PER-DAY price? " +
          `The traveller asked for ${input.durationDays} day(s). Two readings exist: ` +
          `${input.candidateA} per day, or ${input.candidateB} per day. ` +
          "Shops often quote the TOTAL for the whole stay; a number the shop marked per day " +
          '("per day", "/day", "a day") is a daily rate and is never divided. ' +
          'Reply ONLY JSON: {"perDay": <number>} - it MUST be one of the two readings.',
      },
      { role: "user", content: input.message.slice(0, 600) },
    ],
    { maxTokens: 60, budgetMs: 6_000 }
  );
  if (!out) return null;
  const j = extractJson<{ perDay?: number }>(out);
  const n = typeof j?.perDay === "number" ? j.perDay : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The slice the failure-class re-read may spend (owner report 5, #5).
 *
 * readImages owns a 45s total budget and the webhook route is capped at 60s, so
 * a second FULL ladder after a failed first read would blow the turn. One
 * targeted pass, explicitly bounded, is the whole mechanism.
 */
const VISION_REREAD_BUDGET_MS = 14_000;
/**
 * The most the PRIMARY board read may take when the caller supplies a turn
 * clock. ai.ts's own ceiling is 45s, which is the whole request budget on a
 * route that also has to run media retries, a possible re-read and the SPTE
 * turn afterwards.
 */
const VISION_TOTAL_BUDGET_CAP_MS = 30_000;
/**
 * The re-read is a SECOND full vision call and it fires exactly on the slow
 * cases (nothing found, parse failed, truncated). Below this much remaining
 * turn it is the difference between a late answer and no answer at all, so it
 * stands down and leaves the recovery to the vision worker and the sweep.
 */
const VISION_REREAD_MIN_LEFT_MS = 26_000;

export async function extractOffer(
  rfq: StructuredRFQ,
  text: string,
  images: InboundImage[] = [],
  history?: string,
  region?: string,
  /**
   * The wall clock left for the WHOLE turn, not for this call.
   *
   * The vision budgets here (45s read + a 14s failure-class re-read) were
   * absolute, so on the production route - where images run INLINE, the vision
   * offload being worker-only - they summed with the media retries and the
   * SPTE turn past Cloud Run's 90s ceiling. A kill there costs a 10-minute
   * claim lease, so the shop's photo simply goes unanswered.
   */
  msLeft?: () => number
): Promise<ExtractedOffer> {
  const { readImages } = await import("./ai");
  // Full spec INCLUDING car details - "car" alone can never be verified
  // against "automatic 5-seat SUV", so extraction was blind for car rentals.
  const spec =
    rfq.vehicleClass === "car"
      ? [
          rfq.transmission !== "any" ? rfq.transmission : "",
          rfq.carType && rfq.carType !== "any" ? rfq.carType : "",
          "car",
          rfq.seats ? `${rfq.seats} seats` : "",
        ]
          .filter(Boolean)
          .join(" ")
      : `${rfq.engineSizeCc ? rfq.engineSizeCc + "cc " : ""}${
          // Respect an EXPLICIT transmission - "manual scooter" and "automatic
          // motorcycle" exist and matter for matchesSpec. Only when the traveller
          // left it "any" do we fall back to the class default (scooters are
          // automatic, motorcycles manual).
          rfq.transmission === "manual"
            ? "manual "
            : rfq.transmission === "automatic"
            ? "automatic "
            : rfq.vehicleClass === "scooter"
            ? "automatic "
            : "manual "
        }${rfq.vehicleClass === "scooter" ? "scooter" : "motorcycle"}${
          rfq.maxMileageKm ? `, under ${rfq.maxMileageKm.toLocaleString()} km on the clock` : ""
        }`;

  // The local currency of the shop. When a shop replies with a bare number and
  // no symbol ("250 per day"), it means 250 in THEIR money - never dollars.
  const localCur = currencyForRegion(region);
  // Did the reply contain ANY explicit currency token? Word boundaries matter:
  // "aud" must not match inside "audience", "rm" not inside "room".
  const symbolMatch = text.match(
    /\$|€|฿|₱|₹|₫|\b(?:usd|idr|rp|eur|thb|aud|nzd|myr|rm|php|inr|vnd)\b/i
  );

  const system =
    "You extract rental price offers from a vendor's reply (text and/or a photo " +
    "of a price list). The traveller asked for: " +
    spec +
    ". " +
    // Explicit vehicle-CLASS guard - the single most important correctness rule.
    // The reported failure: an ELECTRIC BICYCLE was passed to the traveller as if
    // it matched a 125cc scooter request. These classes are NEVER interchangeable.
    "VEHICLE CLASS IS ABSOLUTE. matchesSpec is TRUE only when the offered vehicle " +
    "is the SAME CLASS the traveller asked for. Treat these as distinct, " +
    "non-matching classes: (a) petrol motorbike / scooter / moped (has an engine, " +
    "cc rating - e.g. 110cc, 125cc, 150cc); (b) electric scooter / e-moped " +
    "(battery, stated in Watts/kW, NO cc); (c) electric bicycle / e-bike / pedal " +
    "bicycle (has PEDALS); (d) electric kick-scooter (stand-on, tiny wheels); " +
    "(e) car / van; (f) other. A request for a petrol scooter/motorbike with a cc " +
    "figure is NOT matched by an electric bicycle, an e-bike, a kick-scooter, a " +
    "pedal bike or a car - for ANY of those set vehicleVerdict='mismatch', " +
    "imageKind 'other' (or 'vehicle' if it is clearly a vehicle photo), and write " +
    "a short clarifyMessage asking whether they have the actual vehicle class " +
    "requested (mention the specific class, e.g. 'a 125cc automatic scooter'). " +
    // THREE-WAY, deliberately. Collapsing "I cannot tell" into "wrong vehicle"
    // ended a live negotiation: a shop answering "Normal scooters? Some models
    // 200 and some new 250/day" was recorded as not stocking the vehicle and
    // got a goodbye. Not-yet-known is not a mismatch.
    "vehicleVerdict is a THREE-WAY judgement and 'mismatch' is a STRONG claim: " +
    "use it ONLY when the shop positively named a DIFFERENT class. If the reply " +
    "simply does not say which vehicle it is about - a bare price, a menu of " +
    "options, a question back to you - that is 'unclear', NOT 'mismatch'. Use " +
    "'match' when the class lines up. NEVER guess 'match', and never punish a " +
    "shop for not repeating the cc. When the classes DO match, judge " +
    "cc/transmission as described below. " +
    // The menu the model must stop flattening.
    "OPTIONS: when the shop names MORE THAN ONE price for different vehicles or " +
    "conditions ('some models 200 and some new 250/day', 'old one 150, new one " +
    "250', '1000 or 1250 total'), that is a MENU. Return every tier in options[] " +
    "with the shop's own wording as label, and set pricePerDay to the CHEAPEST " +
    "tier that matches the request. Never drop a tier. " +
    "Reply ONLY as JSON: { \"found\": boolean, \"pricePerDay\": number, " +
    '"currency": string, "vehicleDescription": string, ' +
    '"vehicleVerdict": "match"|"mismatch"|"unclear", ' +
    // currency + tierLabel ARE RENDERED, so they have to be ASKED FOR. The
    // reading panel reads `options[].currency` and `options[].tierLabel` and
    // draws a duration-tier chip from them - and the contract had never
    // mentioned either field, so on the live path the chip could not exist
    // (owner report 5, #7). `available` is the crossed-out row (see below).
    '"options": [{"label": string, "pricePerDay": number, "currency": string|null, ' +
    '"tierLabel": string|null, "available": boolean|null, ' +
    '"condition": "new"|"older"|"unknown", "mileageKm": number|null, "model": string|null}], ' +
    '"confidence": "high"|"medium"|"low", "clarifyMessage": string, ' +
    '"deposit": string, "delivers": boolean|null, "deliveryFee": number|null, ' +
    '"insuranceIncluded": boolean|null, "kmLimitPerDay": number|"unlimited"|null, ' +
    '"fuelPolicy": string|null, "imageKind": "vehicle"|"price_sheet"|"document"|"other"|null, ' +
    '"pickupOffered": boolean|null, "onShopOnly": boolean|null, ' +
    '"shopFirm": boolean|null, "shopDeclined": boolean|null, ' +
    '"shopTone": "warm"|"neutral"|"annoyed"|null, ' +
    '"mileageKm": number|null, "conditionNotes": string|null, "imageSummary": string|null, ' +
    // VISUAL VEHICLE CLASSIFICATION. A closed vocabulary, answered from the
    // PICTURE rather than from any text - a photo of a car sent to someone who
    // asked for a scooter is a wrong-vehicle signal even when nothing in the
    // caption says so, and a board headed with a vehicle we cannot read is
    // better reported as "unclear" than silently assumed to be ours.
    '"seenVehicleClass": "scooter"|"motorbike"|"car"|"unclear"|null, ' +
    '"seenMatchesRequest": boolean|null, ' +
    '"tags": string[] }. ' +
    // The Krabi failure: after agreeing 250/day the shop wrote "that is a
    // discount already, normally it's 300/day" and the app replaced the live
    // 250 with 300. A defended discount is not a price rise.
    "REGULAR vs OFFERED price: a price the shop calls normal / regular / usual / " +
    "standard / original / list, or a 'was X now Y' pair, is the REGULAR price - " +
    "an anchor, not what they are charging. pricePerDay is ALWAYS what the shop " +
    "is offering the traveller right now. If THIS reply only restates the regular " +
    "price to defend a discount it already gave, set found=false and quote no " +
    "price - the discounted price we already have still stands. " +
    // THE LIMIT OF THAT RULE, AND IT IS THE ONE THAT COST A LIVE READ.
    //
    // Owner report 5: a shop sent ONE clear photo of a typed price menu with
    // some old prices struck out, which reads exactly like a 'was X now Y'
    // pair - so the rule above fired and the model returned found=false on a
    // board where every cell was machine-readable, including the traveller's
    // exact bike. That rule is about a SENTENCE the shop wrote in THIS reply.
    "THAT RULE IS ABOUT A SENTENCE, NEVER ABOUT A PHOTO OF A BOARD. A price " +
    "sheet / menu / board is a LIST OF CURRENT PRICES: never set found=false on " +
    "a board because it also shows old, replaced or crossed-out numbers. Read " +
    "the board and quote the current row. " +
    "CROSSED-OUT / STRUCK-THROUGH / OVERWRITTEN entries, including a red X over " +
    "a row: (a) a whole ROW crossed out means that MODEL IS UNAVAILABLE - keep " +
    "it in options[] with \"available\": false and its label, and NEVER quote " +
    "its price as pricePerDay; (b) a crossed-out PRICE with a new number beside " +
    "or above it means the NEW number is the current price for that row - quote " +
    "the new one, set \"available\": true, and mention the old one in " +
    "imageSummary only. Every other row is \"available\": true. Crossing-out " +
    "NEVER makes a board unreadable, and it never justifies found=false. " +
    "If the row the traveller asked for is crossed out but other rows are not, " +
    "still return the board: found=true on the cheapest AVAILABLE matching row, " +
    "and say in imageSummary that their exact model is marked unavailable. " +
    "pickupOffered: true ONLY if the shop offered to come pick the TRAVELLER up " +
    "(by car or motorbike) and bring them to the shop - this is different from " +
    "delivering the vehicle; null when not mentioned. " +
    "onShopOnly: true only if the shop clearly said in-store only / come to the " +
    "shop / no delivery; null otherwise. " +
    "CRITICAL for the signals pickupOffered/onShopOnly/shopFirm/shopTone: they " +
    "describe ONLY the NEWEST reply above, NEVER earlier messages in the " +
    "history. shopFirm: true only if THIS reply refuses to lower a price it " +
    "already gave ('last price', 'cannot lower', 'fixed price'); a firm-sounding " +
    "line with NO price quoted yet is null, and a reply that LOWERS the price " +
    "is never firm. " +
    "shopTone: how the shop sounds in THIS reply - 'annoyed' if irritated or " +
    "telling us to stop asking, 'warm' if friendly, else 'neutral'. " +
    "shopDeclined: true ONLY if THIS reply walks away from the deal - tells the " +
    "traveller to take the other shop's offer ('that's OK you can take it " +
    "there'), says not interested / no thanks / can't help / goodbye. A refusal " +
    "to LOWER a price is shopFirm, NOT shopDeclined. null when neither. " +
    "imageKind: ONLY when a photo is attached, classify it - \"vehicle\" if it is " +
    "a photo of the actual scooter/motorbike/car, \"price_sheet\" if it shows " +
    "prices/rates/a menu, \"document\" for papers/contracts/IDs, else \"other\"; " +
    "null when there is no image. If the photo is just the VEHICLE (no prices), " +
    "set found=false and do NOT invent a price - we will simply thank the shop. " +
    "EXTRACT EVERYTHING FROM PHOTOS, even facts nobody asked about yet - they " +
    "become leverage or save a question later: mileageKm = the odometer reading " +
    "in km if visible (never a price); conditionNotes = a short honest note on " +
    "visible condition (scratches, dents, worn tires, broken mirror, clean/new " +
    "look, interior state for cars); imageSummary = 1-3 plain sentences listing " +
    "EVERYTHING informative you can see (every model + its price, deposit lines, " +
    "opening hours, phone numbers, shop name, insurance/helmet notes...). All " +
    "three are null when there is no image or nothing visible. " +
    "PRICE-SHEET PHOTOS: rental shops post boards listing MANY models, each with " +
    "its own per-day price (e.g. Honda Click 125cc 300, Yamaha NMAX 155cc 500). " +
    "Pick the model row that MATCHES the traveller's request above (same class " +
    "and closest cc) and return THAT price with found=true, vehicleVerdict='match' and " +
    "the model name in vehicleDescription. " +
    "WHEN SEVERAL ROWS MATCH the requested class and cc, ALWAYS return the " +
    "CHEAPEST matching row - the traveller wants the lowest price that fits, " +
    "NEVER a premium/new-model/bigger-engine row when a cheaper matching row " +
    "exists (e.g. asked: automatic 125cc; sheet has Yamaha Fino 125 at 280, " +
    "Click 125 LED at 300, Click 125 New Model at 350 -> return 280, and name " +
    "the cheaper alternatives in imageSummary). " +
    "DURATION LADDERS ARE NOT A MENU. Many boards price ONE vehicle by LENGTH " +
    "OF STAY: '1-2 days 650 / 3-7 days 600 / 8-14 days 550 / 15-29 days 500 / " +
    "Monthly 450'. Those rows are not options to pick between - each is the rate " +
    "you get by staying that long. Return the row whose range CONTAINS the " +
    "traveller's rental length, never the cheapest row: for a 5-day rental on " +
    "that board the answer is 600, NOT 500 and NOT 450. The 'cheapest matching " +
    "row' rule above is about different MODELS, never about duration tiers. " +
    "EVERY options[] ROW CARRIES ITS OWN currency, and a duration-ladder row " +
    "carries the shop's own words for its range as tierLabel ('1-2 days', " +
    "'3-7 days', 'Monthly') - the traveller is shown that label beside the " +
    "price, so a row without it reads as if it applied to any stay. " +
    "A BOARD'S HEADING BINDS ITS ROWS: if the board is titled '155 CC' or 'Honda " +
    "Click - V2 125 CC', every row underneath is that vehicle. When the heading " +
    "names a vehicle the traveller did NOT ask for, that whole board is the " +
    "wrong vehicle - set vehicleVerdict='mismatch' and do not quote from it, " +
    "even if the rows themselves mention no engine size. " +
    "TRANSMISSION MATTERS: a 'semi automatic'/'semi-auto' model is NOT an " +
    "automatic scooter - exclude semi-automatic rows when the traveller asked " +
    "automatic (and vice versa); 'automatic'/CVT scooters (Click, Fino, Scoopy, " +
    "Filano, PCX, NMAX...) match an automatic request. " +
    "WEEKLY/MONTHLY COLUMNS: sheets often list both a day rate and a week rate " +
    "('300 Baht/Day, 1,900 Baht/Week'). pricePerDay is the DAY rate of the " +
    "chosen row, but ALWAYS spell out the weekly rate and its per-day value in " +
    "imageSummary (1,900/7 = ~271/day) - for 7+ day rentals it is the honest " +
    "bargaining anchor. " +
    // VISUAL CLASSIFICATION, from the PICTURE and nothing else.
    "seenVehicleClass: when a photo shows an actual VEHICLE, say what it is " +
    "from the picture alone - \"scooter\" (step-through, flat footboard, no " +
    "visible gear lever), \"motorbike\" (manual/geared, fuel tank between the " +
    "knees), \"car\", or \"unclear\" when the photo is a board, a document or " +
    "too poor to judge. NEVER infer it from the caption or the model name - " +
    "this field exists precisely to CROSS-CHECK those. seenMatchesRequest: " +
    "true when what you SEE is the class the traveller asked for, false when " +
    "it plainly is not, null when unclear. " +
    "The sheet may be in ANY language " +
    "(Thai, Hungarian, Indonesian...) - deposit lines like 'Letet: Utlevel vagy " +
    "3000 Baht' mean 'Deposit: passport or 3000 baht', so read deposit tiers per " +
    "model size too. Opening hours on the sheet (e.g. OPEN 08.00AM) are context, " +
    "never a price. An odometer/mileage number (e.g. 45,000 km) is NEVER a price. " +
    // MESSY BUSINESS TEMPLATES: shops often reply with a whole price list mixing
    // NON-rental services (airport/port/pier transfers priced 'per trip', island
    // tours, shuttle, boat, habal-habal) alongside the actual vehicle RENTAL line
    // priced 'per day'. IGNORE every transfer/tour/shuttle/trip line - those are
    // not what the traveller is renting - and pick the vehicle rental '/day' line
    // that matches the requested class. Example: a reply listing 'Airport 250 " +
    "PHP/trip, Port 350 PHP/trip, Scooter: 350 PHP/day, Island tour available' " +
    "for a scooter request -> found=true, pricePerDay=350 (the '/day' scooter " +
    "line), NEVER the 250 or 350 '/trip' transfer numbers. " +
    // Relax the verdict so a plain class word matches even without cc/transmission
    // restated: a shop that just writes 'Scooter: 350/day' for a scooter request
    // DOES match (same class). Only a DIFFERENT class (a car line for a scooter
    // request, an e-bike, a pedal bicycle) is a mismatch.
    "A bare class word that MATCHES the requested class ('Scooter', 'Motorbike', " +
    "'Car') is a MATCH even if cc/transmission are not restated - do NOT demand " +
    "the shop repeat the cc to set 'match'; only a genuinely DIFFERENT class is " +
    "'mismatch', and anything you simply cannot tell is 'unclear'. " +
    "Combine the reply with the conversation history for CONTEXT, but " +
    "NEVER attribute a number to the shop that appears only in OUR (traveller) " +
    "messages - our own asks and counter-offers are NOT the shop's price. " +
    "pricePerDay must come from the SHOP's own words or photo; the ONE " +
    "exception is when the shop explicitly AGREES to a number we proposed " +
    "('ok', 'deal', 'yes can do') - then that agreed number is their price. " +
    "Only when something is genuinely still unknown, " +
    "write a short, polite clarifyMessage - and it must NEVER repeat a question " +
    "the vendor already answered anywhere in the thread. " +
    `THE MOST IMPORTANT ARITHMETIC RULE: the traveller wants ${rfq.durationDays} day(s), ` +
    "and shops OFTEN quote the TOTAL for the whole rental, not per day. " +
    '"3 days 900" or "900 for 3 day" means 900 TOTAL, so pricePerDay is 300 (900/3). ' +
    "pricePerDay MUST be the true PER-DAY price: when the quote covers the whole " +
    "period, DIVIDE by the number of days. Only treat a number as per-day when the " +
    'shop says so ("per day", "/day", "a day") or quotes for 1 day. ' +
    'AND THE RULE\'S OWN LIMIT: a number the shop already marked per-day is NEVER divided. ' +
    '"6 days 180 per day" means 180/day (the day count is the STAY, the marked rate is the price) - ' +
    "dividing a marked per-day rate by the stay is the exact misread this rule exists to prevent, in reverse. " +
    "deposit: ONLY if the shop explicitly stated a deposit requirement, a short " +
    "label like 'Passport only', '3,000 THB cash', 'Passport or 2,000 THB' - " +
    "otherwise an empty string. NEVER guess. " +
    "delivers: true only if they clearly said they deliver / bring the vehicle, " +
    "false only if they clearly said no delivery, null when not mentioned. " +
    "deliveryFee: the delivery charge as a plain number in the same currency " +
    "(0 if they said delivery is free), null if not mentioned. " +
    "insuranceIncluded: true only if they said insurance is included, false if " +
    "they said it costs extra / is not included, null if not mentioned. " +
    "kmLimitPerDay: the daily km/mileage limit as a number, \"unlimited\" if they " +
    "said unlimited, null if not mentioned. fuelPolicy: a short label like " +
    "'full-to-full' or 'same-to-same' only if stated, else null. NEVER guess any of these. " +
    "tags: facts the shop EXPLICITLY stated in this reply, chosen ONLY from: " +
    "delivery, pickup-only, airport-delivery, no-deposit, passport-deposit, " +
    "cash-deposit, helmets-included, insurance-included, cards-accepted, " +
    "flexible-dates. Empty array when nothing applies - NEVER guess or infer. " +
    "clarifyMessage register: SIMPLE everyday English a non-native shop owner " +
    "instantly understands - short words, short sentences, never formal, and " +
    "never a greeting (we are mid-conversation). " +
    (localCur
      ? `IMPORTANT: this shop is in a place whose local currency is ${localCur}. ` +
        `If the reply gives a bare number with no currency symbol, the currency is ` +
        `${localCur} - NEVER assume US dollars. Return currency "${localCur}" in that case.`
      : "If the reply gives a bare number with no symbol, return the shop's local currency, not USD.") +
    (history
      ? "\nConversation so far (oldest first):\n" + history
      : "") +
    // GROUND TRUTH ABOUT THE NAMEPLATES THIS REPLY MENTIONS.
    //
    // A model that has to infer what a "Honda BeAT" is will sometimes infer it
    // is the traveller's 125 - which is exactly what happened, twice. The same
    // catalogue the code checks against is rendered here, for only the models
    // this reply actually names, so the extractor and the gate reason from one
    // set of facts instead of two.
    (() => {
      const facts = catalogueFactsFor(`${text}\n${history ?? ""}`);
      return facts
        ? "\nKNOWN FACTS about the models named above - treat these as authoritative, " +
          "they are not guesses:\n" +
          facts +
          "\nIf one of these does NOT match the traveller's declared vehicle, that " +
          "vehicle's price is NOT their price. A reply may name several vehicles: " +
          "return the price of THEIR vehicle, never the cheapest number."
        : "";
    })();

  // Vision path (handles price-list photos) when Gemini is available.
  // NOTHING below may throw: a provider error must NEVER abort processVendorReply
  // before the reply is stored - it would leave the shop hanging "awaiting reply"
  // for minutes (the exact Sun House failure). A thrown call degrades to the
  // deterministic heuristic instead.
  if (images.length > 0) {
    let read: import("./ai").VisionRead;
    try {
      // The extractor's whole contract is a JSON row set - ask the provider
      // for JSON rather than fishing it back out of prose or a half-fence.
      // The primary read gets what the TURN has left, capped at its own budget
      // and floored so a late arrival still gets one honest attempt.
      const visionBudget = msLeft
        ? Math.max(8_000, Math.min(VISION_TOTAL_BUDGET_CAP_MS, msLeft() - 20_000))
        : undefined;
      read = await readImages(system, text || "See attached price list.", images, {
        json: true,
        ...(visionBudget ? { budgetMs: visionBudget } : {}),
      });
    } catch (e) {
      read = {
        ok: false,
        failure: "network",
        retryable: true,
        detail: e instanceof Error ? e.message : "vision call threw",
        attempts: [],
      };
    }
    // THE PROVENANCE TRAVELS WITH THE RESULT. Everything downstream - the proof
    // panel, the ops feed, the decision about whether to ask the shop to type it
    // out - needs to know whether the picture was looked at, and until now the
    // only signal was a `null` that a good read of a blank board also returns.
    const imageRead: ExtractedOffer["imageRead"] = read.ok
      ? { seen: true }
      : {
          seen: false,
          failure: read.failure,
          detail: read.detail.slice(0, 300),
          retryable: read.retryable,
          // A ladder that ended on OUR token ceiling is not an outage. Carried
          // through so the panel says "too long to read in one go", never "the
          // image reader was unavailable" (owner report 5, #1/#2).
          ...(read.failure === "truncated" ? { modelFailure: "truncated" as const } : {}),
        };

    // REGION-DIRECTED RE-READ (the "multi-crop" retry, without pixels).
    //
    // A dense, low-contrast or badly-lit board is the case where one pass
    // reliably under-reads: the model answers from the rows it attended to and
    // the rest are simply absent - which is how a real Thai board came back
    // with no usable row at all. We cannot CROP: there is no image library in
    // this runtime, and adding one is the tens-of-MB weight the vision plan
    // deliberately rejected for a 1GB worker. What we can do is direct
    // ATTENTION, which costs one call and no dependencies: ask the model to
    // transcribe the board region by region, verbatim, then extract from its
    // own transcription.
    //
    // GATED ON THE FAILURE CLASS, NOT ON THE MODEL'S SELF-REPORT (owner report
    // 5, #5). It used to require `imageKind === "price_sheet"`, so the cases
    // that most needed it - unparseable JSON, a cut-off answer, an omitted or
    // "other"/"document" imageKind - all skipped it: the mechanism built for
    // dense boards never fired for the boards that actually failed.
    //
    // BUDGETED: readImages helps itself to 45s and the webhook route is capped
    // at 60s, so this second pass is given an explicit slice instead of a
    // second full ladder.
    const regionReRead = async (): Promise<ExtractedOffer | null> => {
      try {
        // Not worth the request's life. See VISION_REREAD_MIN_LEFT_MS.
        if (msLeft && msLeft() < VISION_REREAD_MIN_LEFT_MS) return null;
        const focused = await readImages(
          system +
            " SECOND PASS - THE FIRST READ CAME BACK UNUSABLE. Work the board in " +
            "regions: TOP third, then MIDDLE, then BOTTOM. For each region " +
            "transcribe EVERY line you can see verbatim (model name, engine " +
            "size, every number, the unit beside it), including faint, " +
            "angled, glare-covered, crossed-out or handwritten lines. THEN " +
            "extract from your own transcription. Put the full transcription in " +
            "imageSummary so a human can check it against the photo. Keep the " +
            "answer COMPACT so it fits: no repetition, no commentary.",
          text || "Read this price board region by region.",
          images,
          { json: true, budgetMs: VISION_REREAD_BUDGET_MS }
        );
        if (!focused.ok) return null;
        const retried = extractJson<ExtractedOffer>(focused.text);
        if (!retried || typeof retried.found !== "boolean") return null;
        const second = normalizeExtraction(retried, spec);
        // Only ADOPT a second read that actually recovered something.
        if (second.found || (second.options?.length ?? 0) > 0) {
          return { ...second, imageRead: { seen: true } };
        }
        return null;
      } catch {
        /* the re-read is an upgrade - its failure keeps the first result */
        return null;
      }
    };

    if (read.ok) {
      const parsed = extractJson<ExtractedOffer>(read.text);
      if (parsed && typeof parsed.found === "boolean") {
        const first = normalizeExtraction(parsed, spec);
        // The failure class "we looked and got nothing usable out of it" - no
        // longer conditioned on the model having classified the photo for us.
        const gotNothing = !first.found && (first.options?.length ?? 0) === 0;
        // A "mismatch" that read NOTHING AT ALL is a self-report, not a
        // finding: no row, no price, no description of what it saw. Those are
        // re-read like any other empty result. A mismatch that DID read the
        // board (a 155cc heading, a car) is a real observation and is never
        // re-read into an offer for a vehicle the traveller cannot ride.
        const unsupportedMismatch =
          first.vehicleVerdict === "mismatch" && !first.imageSummary && !first.vehicleDescription;
        const worthReReading =
          gotNothing &&
          (first.vehicleVerdict !== "mismatch" || unsupportedMismatch) &&
          first.imageKind !== "vehicle";
        if (!worthReReading) return { ...first, imageRead };
        const second = await regionReRead();
        if (second) return second;
        return { ...first, imageRead };
      }
      // THE MODEL ANSWERED AND WE COULD NOT PARSE IT (owner report 5, #1).
      //
      // This is the branch that produced the field failure. It fell straight
      // through to the blank-photo fallback below with `imageRead.seen = true`
      // and no marker, so readingFrom classified it "empty" and the traveller
      // was told, about a crisp typed menu, "We could not read anything usable
      // from this one. CONFIDENCE: LOW." The re-read gets a chance first, and
      // whatever happens the failure is named as OURS.
      const second = await regionReRead();
      if (second) return second;
      imageRead.modelFailure = "parse-failed";
      imageRead.detail = `model answered ${read.text.length} chars of unparseable JSON`;
    } else if (read.failure === "truncated") {
      // The whole ladder ended cut off (the raised-ceiling retry inside
      // readImages did not rescue it). One compact, budgeted re-read is the
      // last cheap thing worth trying before we admit it.
      const second = await regionReRead();
      if (second) return second;
    }

    // A photo with NO usable model output: still try the caption text with the
    // deterministic extractor before giving up (many captions carry the price).
    const capHit = deterministicPriceHit();
    if (capHit) return { ...capHit, imageRead };
    return {
      found: false,
      // "unknown" must never read as "wrong vehicle": matchesSpec=false is the
      // WRONG-vehicle signal and freezes every director move downstream.
      matchesSpec: true,
      confidence: "low",
      // The negotiation still has to move, so we still ask - a shop cannot fix
      // our outage and a stalled thread helps nobody. What changes is that we
      // no longer TELL THE TRAVELLER we read their photo and found it wanting:
      // `imageRead` carries the truth (which failed: the reader, our parser,
      // our ceiling) to every surface that reports.
      clarifyMessage: `Thanks for the photo! Could you confirm in text the daily price for the ${spec}? Just want to be sure we quote the right vehicle.`,
      imageRead,
      ...heuristicDepositFields(text, localCur),
      ...readNegotiationSignals(text),
    };
  }

  // Text path via any configured LLM.
  //
  // BUDGETED, like every other call on the reply path. This one inherited the
  // 38-second default while its siblings run on 6-9s, and it sits at the FRONT
  // of the turn: nothing else - not the director, not the composer - starts
  // until it returns. One slow provider therefore spent most of a reply's
  // latency budget before a single word was written. On timeout the
  // deterministic extractor below still reads the price, so the ceiling costs
  // accuracy only in the cases the model would have rescued.
  let llm: string | null = null;
  try {
    llm = await chat(
      [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      { budgetMs: 9_000 }
    );
  } catch {
    llm = null;
  }
  if (llm) {
    const parsed = extractJson<ExtractedOffer>(llm);
    if (parsed && typeof parsed.found === "boolean") {
      const norm = normalizeExtraction(parsed, spec);
      // BACKSTOP: the model said "no price" but a deterministic line-aware read
      // finds a genuine per-day rental rate (the messy Sun House template the LLM
      // choked on). Trust the deterministic price rather than stalling the thread.
      if (!norm.found) {
        const rescue = deterministicPriceHit();
        if (rescue) return rescue;
      }
      return norm;
    }
  }

  // Heuristic fallback: find a price, but never auto-verify it.
  const hit = deterministicPriceHit();
  if (hit) return hit;
  return {
    found: false,
    matchesSpec: true,
    confidence: "low",
    clarifyMessage: `Could you share your best daily price for the ${spec}? Thank you!`,
    ...heuristicDepositFields(text, localCur),
    ...readNegotiationSignals(text),
  };

  // Deterministic, LLM-free price read. Runs the human-grade line-aware extractor
  // first (skips transfer/tour lines, picks the requested vehicle class, handles
  // "350 PHP/day" with the currency in ANY position) and only then the legacy
  // "last/final/best price" phrasing. Returns a full ExtractedOffer or null.
  function deterministicPriceHit(): ExtractedOffer | null {
    const rentalHit = extractRentalDailyPrice(text, {
      vehicleClass: rfq.vehicleClass,
      durationDays: rfq.durationDays,
      localCurrency: localCur || undefined,
      engineSizeCc: rfq.engineSizeCc,
    });
    if (rentalHit && rentalHit.pricePerDay > 0) {
      return {
        found: true,
        pricePerDay: rentalHit.pricePerDay,
        currency: rentalHit.currency || (symbolMatch ? currencyFromToken(symbolMatch[0]) : localCur || "USD"),
        // A wrong-class line (classMatch===false) is NOT a match; a same-class or
        // class-agnostic line is treated as matching so the funnel keeps moving.
        // "unknown" must never read as "wrong vehicle" (false mutes the engine).
        matchesSpec: rentalHit.classMatch === false ? false : true,
        confidence: "medium",
        clarifyMessage:
          rentalHit.classMatch === false
            ? `Thanks! Do you also have a ${spec}? That's what the traveller needs.`
            : `Great, thank you! Just to confirm: is that the daily price for the ${spec} exactly? Once you confirm I'll pass it to the traveller.`,
        ...heuristicDepositFields(text, localCur),
        ...readNegotiationSignals(text),
      };
    }
    // "170 last price" / "final price 400" - a firm quote is still a quote.
    const m =
      text.match(/(\d{2,3}(?:[.,]\d{3})*)\s*(?:is\s*)?(?:my\s*|the\s*)?(?:last|final|best)\s*price/i) ??
      text.match(/(?:last|final|best)\s*price\s*(?:is\s*)?[,:]?\s*(\d{2,3}(?:[.,]\d{3})*)/i);
    const price = m ? parseFloat(m[1].replace(/[,\s]/g, "")) : NaN;
    if (m && price > 0 && price !== rfq.durationDays) {
      return {
        found: true,
        pricePerDay: price,
        currency: symbolMatch ? currencyFromToken(symbolMatch[0]) : localCur || "USD",
        matchesSpec: true,
        confidence: "medium",
        clarifyMessage: `Great, thank you! Just to confirm: is that the daily price for the ${spec} exactly? Once you confirm I'll pass it to the traveller.`,
        ...heuristicDepositFields(text, localCur),
        ...readNegotiationSignals(text),
      };
    }
    return null;
  }

  function normalizeExtraction(e: ExtractedOffer, specStr: string): ExtractedOffer {
    let conf = ["high", "medium", "low"].includes(e.confidence) ? e.confidence : "low";
    // THREE-WAY VEHICLE VERDICT -> the boolean every surface still reads.
    // "unclear" resolves to matchesSpec TRUE: not-yet-known must never present
    // as "this shop has the wrong vehicle" (that reading ended a live thread).
    // A model that only returned the old boolean still works.
    const verdict: NonNullable<ExtractedOffer["vehicleVerdict"]> =
      e.vehicleVerdict === "match" || e.vehicleVerdict === "mismatch" || e.vehicleVerdict === "unclear"
        ? e.vehicleVerdict
        : e.matchesSpec === false
        ? "mismatch"
        : "match";
    e = { ...e, vehicleVerdict: verdict, matchesSpec: verdict !== "mismatch" };
    // THE PICTURE CROSS-CHECKS THE WORDS. A photo the model itself classified as
    // a different class from the one the traveller asked for downgrades a
    // confident "match" to "unclear" - never straight to mismatch, because a
    // shop may simply have sent a photo of a different bike it also rents. The
    // engine then ASKS, which is exactly the behaviour an unestablished vehicle
    // is supposed to produce. Only fires when the model actually judged the
    // pixels (a closed value, never "unclear", and an explicit false).
    if (
      verdict === "match" &&
      e.seenMatchesRequest === false &&
      e.seenVehicleClass &&
      e.seenVehicleClass !== "unclear"
    ) {
      e = { ...e, vehicleVerdict: "unclear", matchesSpec: true };
    }
    // LIST PRICE IS NOT AN OFFER. When a shop defends a discount it already gave
    // ("that is a discount already, normally it's 300/day"), the only number in
    // the message is the REGULAR price. Reading it as a fresh quote replaced a
    // live 250/day with a worse 300 in the app while the negotiator, reading the
    // sentence properly, carried on from 250. The deterministic reader knows the
    // difference, so it overrules the model here.
    if (e.found && typeof e.pricePerDay === "number" && images.length === 0) {
      const quoted = extractQuotedPrices(text, {
        vehicleClass: rfq.vehicleClass,
        durationDays: rfq.durationDays,
        localCurrency: localCur || undefined,
        engineSizeCc: rfq.engineSizeCc,
      });
      const isListEcho =
        !quoted.offer &&
        quoted.listPrice != null &&
        Math.abs(quoted.listPrice.pricePerDay - e.pricePerDay) <= 1;
      if (isListEcho) {
        return {
          ...e,
          found: false,
          pricePerDay: undefined,
          confidence: "low",
          listPricePerDay: quoted.listPrice!.pricePerDay,
          currency: quoted.listPrice!.currency || localCur || e.currency,
          clarifyMessage: undefined,
          ...readNegotiationSignals(text),
        };
      }
    }
    // VERIFIED-GATE: a "high confidence" price that appears NOWHERE in the
    // shop's actual reply (no photo carried it either) is at best an
    // inference from the thread - and in the worst observed case it was OUR
    // OWN counter-offer read back as the shop's quote (350 asked at 315 ->
    // card showed "315 VERIFIED"). Unless the shop explicitly agreed to a
    // proposed number, such a price can never rank as verified.
    if (
      e.found &&
      typeof e.pricePerDay === "number" &&
      conf === "high" &&
      images.length === 0
    ) {
      const plain = (text || "").replace(/(\d)[,.\s](?=\d{3}\b)/g, "$1");
      const perDay = String(Math.round(e.pricePerDay));
      const total = String(Math.round(e.pricePerDay * Math.max(1, rfq.durationDays)));
      const tokenRx = (n: string) => new RegExp(`(^|[^\\d])${n}([^\\d]|$)`);
      const inReply = tokenRx(perDay).test(plain) || tokenRx(total).test(plain);
      const agreed = /\b(ok(?:ay)?|yes|deal|sure|fine|no problem|agreed|can do)\b/i.test(text || "");
      if (!inReply && !agreed) conf = "medium";
    }
    const verifiedEnough = e.found && e.matchesSpec && conf === "high";
    // Negotiation signals: the deterministic regex layer ALWAYS backs the model
    // (true from either source wins; the model can add what the regex missed).
    const sig = readNegotiationSignals(text);
    // If the model returned no currency (or defaulted to USD for a bare number
    // in a non-USD country), stamp the real local currency.
    let cur = e.currency;
    const hadSymbol = symbolMatch != null;
    if (localCur && (!cur || (cur.toUpperCase() === "USD" && localCur !== "USD" && !hadSymbol))) {
      cur = localCur;
    }
    // The deterministic deposit reader backs the model here too - a model that
    // skips "Passport only" must not erase a deposit the regex clearly sees.
    const deposit =
      (typeof e.deposit === "string" ? e.deposit.trim().slice(0, 80) : "") ||
      heuristicDepositFields(text, localCur).deposit ||
      "";
    // Derive a structured deposit from the label so the app can show a precise
    // "cash amount / passport" tag next to the price and filter by kind.
    const depositStruct = deposit ? parseDeposit(deposit, cur) : null;
    const km =
      e.kmLimitPerDay === "unlimited"
        ? "unlimited"
        : typeof e.kmLimitPerDay === "number" && e.kmLimitPerDay > 0
        ? Math.round(e.kmLimitPerDay)
        : null;
    return {
      ...e,
      currency: cur,
      confidence: conf,
      deposit: deposit || undefined,
      depositType: depositStruct?.type,
      depositAmount: depositStruct?.amount,
      depositCurrency: depositStruct?.currency,
      imageKind:
        e.imageKind && ["vehicle", "price_sheet", "document", "other"].includes(e.imageKind)
          ? e.imageKind
          : undefined,
      // CLOSED VOCABULARY, enforced here rather than trusted from the model -
      // anything outside the set is "we could not tell", never a guess.
      seenVehicleClass:
        e.seenVehicleClass &&
        ["scooter", "motorbike", "car", "unclear"].includes(e.seenVehicleClass)
          ? e.seenVehicleClass
          : undefined,
      seenMatchesRequest:
        typeof e.seenMatchesRequest === "boolean" ? e.seenMatchesRequest : null,
      delivers: typeof e.delivers === "boolean" ? e.delivers : null,
      deliveryFee: typeof e.deliveryFee === "number" && e.deliveryFee >= 0 ? e.deliveryFee : null,
      insuranceIncluded: typeof e.insuranceIncluded === "boolean" ? e.insuranceIncluded : null,
      kmLimitPerDay: km,
      fuelPolicy: typeof e.fuelPolicy === "string" && e.fuelPolicy.trim() ? e.fuelPolicy.trim().slice(0, 40) : null,
      pickupOffered: e.pickupOffered === true || sig.pickupOffered === true ? true : null,
      onShopOnly: e.onShopOnly === true || sig.onShopOnly === true ? true : null,
      shopFirm: e.shopFirm === true || sig.shopFirm === true ? true : null,
      // MODEL-ONLY (K2): the DECLINED_RX half used to OR in here, making the
      // regex un-overrulable two layers deep. It remains computed (sig) as a
      // pre-filter/telemetry signal; the VERDICT that can kill a thread is
      // the model's alone.
      shopDeclined: e.shopDeclined === true ? true : null,
      shopTone: mergeShopTone(e.shopTone, sig.shopTone),
      tags: Array.isArray(e.tags)
        ? e.tags.filter((t) => typeof t === "string").map((t) => t.toLowerCase().trim()).slice(0, 10)
        : [],
      mileageKm:
        typeof e.mileageKm === "number" && e.mileageKm > 0 && e.mileageKm < 1_000_000
          ? Math.round(e.mileageKm)
          : null,
      conditionNotes:
        typeof e.conditionNotes === "string" && e.conditionNotes.trim()
          ? e.conditionNotes.trim().slice(0, 200)
          : null,
      imageSummary:
        typeof e.imageSummary === "string" && e.imageSummary.trim()
          ? e.imageSummary.trim().slice(0, 500)
          : null,
      clarifyMessage: verifiedEnough
        ? undefined
        : e.clarifyMessage ||
          `Thanks! Could you confirm the exact daily price for the ${specStr}?`,
    };
  }
}

// Map a currency token found in text ("฿", "rp", "rm") to an ISO code.
function currencyFromToken(tok: string): string {
  const t = tok.toLowerCase();
  if (/\$|usd/.test(t)) return "USD";
  if (/฿|thb/.test(t)) return "THB";
  if (/€|eur/.test(t)) return "EUR";
  if (/rp|idr/.test(t)) return "IDR";
  if (/rm|myr/.test(t)) return "MYR";
  if (/₱|php/.test(t)) return "PHP";
  if (/₹|inr/.test(t)) return "INR";
  if (/₫|vnd/.test(t)) return "VND";
  return "USD";
}

/** Round a bargain target to a clean, human number (nearest 10, or 50/100 for
 *  larger amounts) so the agent asks for 220, not 213. */
export function roundNice(n: number): number {
  if (n <= 0) return n;
  if (n < 100) return Math.round(n / 10) * 10;
  if (n < 1000) return Math.round(n / 10) * 10;
  if (n < 10000) return Math.round(n / 50) * 50;
  return Math.round(n / 100) * 100;
}

// ---------------------------------------------------------------------------
// Feedback Triage Agent - keeps real bugs, filters spam before it emails staff
// ---------------------------------------------------------------------------

export interface FeedbackVerdict {
  isRealIssue: boolean;
  severity: "low" | "medium" | "high";
  summary: string;
  reason: string;
}

const NOISE = [
  /^(hi|hey|hello|test+|asdf|qwerty|lol|nice|cool|great app|love it)\b/i,
  /(buy followers|crypto|casino|loan|seo services|http:\/\/|https:\/\/)/i,
];

export async function triageFeedback(
  category: string,
  text: string
): Promise<FeedbackVerdict> {
  const trimmed = text.trim();

  // Cheap local screen: too short or obvious noise/marketing.
  const tooShort = trimmed.length < 12;
  const noise = NOISE.some((rx) => rx.test(trimmed));

  const { getPrompt } = await import("./prompts");
  const system = await getPrompt("triage");

  const llm = await chat([
    { role: "system", content: system },
    { role: "user", content: `Category: ${category}\nFeedback: ${trimmed}` },
  ]);

  if (llm) {
    const v = extractJson<FeedbackVerdict>(llm);
    if (v && typeof v.isRealIssue === "boolean") return v;
  }

  // Heuristic fallback.
  if (tooShort || noise) {
    return {
      isRealIssue: false,
      severity: "low",
      summary: trimmed.slice(0, 60) || "empty",
      reason: tooShort ? "Too short to be actionable." : "Looks like spam or noise.",
    };
  }
  const hasSignal =
    /(bug|crash|error|broken|doesn'?t|not work|can'?t|fail|freeze|wrong|slow|missing|blank|stuck|glitch|typo|overlap|cut ?off)/i.test(
      trimmed
    );
  return {
    isRealIssue: hasSignal,
    severity: /(crash|broken|can'?t|fail|freeze|stuck)/i.test(trimmed)
      ? "high"
      : "medium",
    summary: trimmed.slice(0, 60),
    reason: hasSignal
      ? "Contains a concrete problem description."
      : "No concrete issue detected; queued for review.",
  };
}

/** Feedback Writer Agent - turns rough notes into a clear report. */
export async function writeFeedback(
  category: string,
  notes: string
): Promise<string> {
  const { getPrompt } = await import("./prompts");
  const system = await getPrompt("writer");
  const llm = await chat([
    { role: "system", content: system },
    { role: "user", content: `Category: ${category}\nNotes: ${notes}` },
  ]);
  if (llm) {
    const { sanitizeAiText } = await import("./text");
    return sanitizeAiText(llm);
  }

  // Fallback: lightly structure the raw notes.
  const n = notes.trim();
  return `[${category}] ${n}${/[.!?]$/.test(n) ? "" : "."} Expected the app to behave correctly; please investigate.`;
}

/** Final spec-verification message the agent sends before locking a booking. */
export function verificationMessage(rfq: StructuredRFQ): string {
  // For a CAR, seats + body type are the whole point of the check - the old
  // message dropped them and just said "car". Include them, plus the dates.
  const vehicle =
    rfq.vehicleClass === "car"
      ? [
          rfq.carType && rfq.carType !== "any" ? rfq.carType : "",
          rfq.seats ? `${rfq.seats}-seat` : "",
          "car",
        ]
          .filter(Boolean)
          .join(" ")
      : `${vehicleTerm(rfq.vehicleClass)}${rfq.engineSizeCc ? ` (${rfq.engineSizeCc}cc)` : ""}`;
  const period = rfq.startDate
    ? `${rfq.durationDays} day${rfq.durationDays === 1 ? "" : "s"} from ${prettyDate(rfq.startDate)}`
    : `${rfq.durationDays} day${rfq.durationDays === 1 ? "" : "s"}`;
  const checks = [
    vehicle,
    rfq.transmission !== "any" ? rfq.transmission : null,
    rfq.maxMileageKm ? `under ${rfq.maxMileageKm.toLocaleString()} km on the clock` : null,
    period,
    ...rfq.accessories,
  ].filter(Boolean);
  return (
    "Before we confirm, can you verify the vehicle matches: " +
    checks.join(", ") +
    "? Please confirm availability and the exact model. Thank you!"
  );
}
