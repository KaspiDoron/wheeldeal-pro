// Shared domain types for WheelDeal.

// One definition of a shop's price tier, shared by the engine and the UI.
// Defined in offer-options.ts (pure, unit-tested) and re-exported here so the
// client imports it from the same place as the rest of the domain.
export type { VehicleOption, OptionCondition, OptionGap } from "./offer-options";
import type { VehicleOption } from "./offer-options";

export type VehicleClass = "car" | "motorbike" | "scooter";
export type Transmission = "automatic" | "manual" | "any";
export type Fulfillment = "hotel-delivery" | "in-store" | "any";
export type Role = "owner" | "admin" | "user";

export interface StructuredRFQ {
  vehicleClass: VehicleClass;
  engineSizeCc?: number;
  transmission: Transmission;
  /**
   * THE ODOMETER, in km - the most the vehicle may already have done.
   *
   * Not a daily allowance. Every consumer has always read it this way
   * (agents.ts asks for a bike "under N km on the clock", graph/gaps.ts
   * asks for a photo of the odometer) while the one label the traveller
   * ever saw said "Max mileage per day" - which is how a 30,000 km option
   * reads as nonsense. The name is the meaning now, in both directions.
   */
  maxMileageKm?: number;
  // Car-specific: number of seats and the body type the traveller wants.
  seats?: number;
  carType?: "economy" | "sedan" | "suv" | "van" | "luxury" | "any";
  durationDays: number;
  accessories: string[];
  fulfillment: Fulfillment;
  notes?: string;
  // ---- Rental parameters (real-world funnel) --------------------------------
  // When the rental begins (YYYY-MM-DD). Availability quoted without a date is
  // worthless, so this is sent to shops when known.
  startDate?: string;
  // Return date; when absent it is derived from startDate + durationDays.
  returnDate?: string;
  // Driver details that gate eligibility at many shops.
  driverAge?: number;
  license?: { motorbike?: boolean; idp?: boolean };
  // Preferred insurance level (shops confirm what they actually offer).
  insuranceTier?: "none" | "basic" | "full" | "any";
  // One-way rentals: a different drop-off location (free text place).
  oneWayDropOff?: string;
  // Scooter/motorbike: how many helmets the traveller needs.
  helmetCount?: number;
  // A polished, vendor-ready message produced by the Profiler agent.
  vendorMessage: string;
}

export type TrackerStage =
  | "queued"
  | "locating-contact"
  | "found" // discovered + ready to ask (the honest resting state)
  | "no-contact" // no WhatsApp number could be found - cannot be messaged
  // The message is being delivered RIGHT NOW (its outbox row is claimed and
  // inside its lease - see src/lib/wa/outbox-lifecycle). Without this state the
  // send was an unrepresentable moment: the row was deleted to claim it and the
  // sent row did not exist yet, so the shop fell back to "found" - which matched
  // no status-panel bucket - and visibly disappeared mid-send.
  | "sending"
  | "rfq-sent"
  | "awaiting-response"
  | "negotiating"
  | "offer-received"
  | "counter-offer" // agent countered the shop's quote - active price haggling
  | "no-response"
  // The shop has nothing to rent right now ("Now I don't have bike"). NOT a
  // decline: a temporary, extremely common state that used to have no
  // representation at all, so the card sat waiting for a price forever.
  | "out-of-stock"
  | "declined";

/**
 * The shop asked to move the conversation to a VOICE CALL (K7). Written once
 * per read by the post-turn enrichment; the newest reading wins (a shop that
 * stops asking is a state change, not an event to accumulate).
 */
export interface CallIntentFact {
  /** Their own words, verbatim - the UI quotes rather than claims. */
  quote: string | null;
  urgency: "now" | "soon" | "whenever" | "none";
  /** ISO timestamp of the inbound turn that said it. */
  at: string;
}

export interface Offer {
  pricePerDay: number;
  // The vendor's opening/list rate before the agent negotiated - savings basis.
  listPricePerDay: number;
  currency: string;
  totalPrice: number;
  includesInsurance: boolean;
  includesDelivery: boolean;
  message: string;
  /**
   * English gloss of `message` when the shop wrote in a local language
   * (vendor_replies.english_gloss). Every surface that quotes the shop's words
   * renders this as a second quiet line - the traveller must always be able to
   * read the bargain their agent is having. Absent for English replies.
   */
  messageEnglish?: string;
  round: number;
  // True only after the agent has confirmed the exact vehicle + price with the
  // vendor. Simulated (demo) offers are marked so the UI can label them.
  verified: boolean;
  // Whether the price the shop quoted is for the EXACT vehicle the traveller
  // asked for. false = the shop answered about a DIFFERENT vehicle (e.g. an
  // e-bike when a 125cc scooter was requested) - such a price must never be
  // shown as the best/lockable offer; it is only a signal for the agent to
  // clarify. undefined = legacy/unknown (pre this field) -> treated as matching.
  matchesSpec?: boolean;
  /**
   * The vehicle-identity gate's verdict for THIS price (src/lib/vehicle).
   * `confirmed` is the only state that may be presented as a deal; the others
   * carry `vehicleNote`, which says plainly what is still being established.
   */
  vehicleStatus?: "confirmed" | "assumed" | "needs-confirmation" | "wrong-vehicle";
  /** One line for the card: why this price is not (yet) being called a deal. */
  vehicleNote?: string;
  simulated: boolean;
  // Shop-confirmed conditions (shown as tags ONLY when explicitly stated).
  deposit?: string; // human label, e.g. "Passport only", "3,000 THB cash"
  // Structured deposit so the app can show a precise tag next to the price:
  // the KIND the shop wants held and (for cash) the exact amount + currency.
  depositType?: "cash" | "passport" | "id" | "license" | "other" | "none";
  depositAmount?: number; // when a cash figure was stated
  depositCurrency?: string; // currency of depositAmount (defaults to the offer's)
  /**
   * PER-EXTRA VERDICTS. One entry for every accessory the traveller asked for,
   * carrying what the shop actually said about it. The request used to leave
   * the app in the opening message and never return, so every surface could
   * only show what was ASKED - including a booking screen that ticked a helmet
   * the shop had refused.
   */
  accessories?: import("./thread/accessories").AccessoryStatus[] | null;
  /**
   * THE SHOP OFFERED A DIFFERENT VEHICLE, close enough to be worth asking
   * about. The thread is paused while this is set: the agent will not haggle a
   * bike the traveller has not agreed to, and will not close a shop that is
   * actively trying to do business.
   */
  alternativeOffer?: import("./vehicle/substitution").AlternativeOffer | null;
  /**
   * THE SHOP ASKED TO TALK BY PHONE (K7). Model-read (semantic readCallIntent,
   * which had zero callers until this landed), persisted on the thread so the
   * card can tell the traveller instead of the request scrolling past inside
   * a foreign-language transcript. `quote` is the shop's own words.
   */
  wantsCall?: CallIntentFact | null;
  // ---- Extra shop-confirmed rental terms (only when explicitly stated) ------
  deliveryFee?: number; // in the offer's currency; 0 = free delivery
  kmLimitPerDay?: number | "unlimited";
  fuelPolicy?: string; // e.g. "full-to-full", "same-to-same"
  // How the traveller gets the vehicle, once the shop has told us (item: show
  // the "on shop" / "delivery" / "pickup" chip only when confirmed).
  fulfillment?: "pickup" | "delivery" | "on-shop";
  // The deal is complete enough to PRESENT (price + deposit + fulfillment all
  // known). undefined = unknown (legacy / pre-migration) -> treated as ready.
  presentable?: boolean;
  // The shop offered to come PICK THE TRAVELLER up; consent gates sharing the
  // exact location with the shop.
  pickupOffered?: boolean;
  pickupConsent?: boolean;
  // Effective daily rate for the traveller's actual duration when the shop
  // quoted a better weekly/monthly rate (so long rentals do not collapse to a
  // single flat day price).
  effectiveDailyRate?: number;
  /**
   * Every tier this shop offered when it gave a CHOICE rather than one price
   * ("some models 200 and some new 250/day"). `pricePerDay` above stays the
   * cheapest on-spec tier so every existing surface keeps working; this is what
   * lets the traveller actually SEE the choice instead of a single number the
   * app picked for them. Absent for the ordinary one-price reply.
   */
  options?: VehicleOption[];
  /**
   * The shop's own words when they asked where the traveller is. Present only
   * while they are still waiting for an answer; drives the card's location
   * prompt, which explains WHY they asked before offering to share anything.
   */
  askedLocationQuote?: string;
  /**
   * WHERE THIS PRICE CAME FROM when it did not arrive as a plain confirmed
   * quote. The status panel used to say "No price yet - your agent is asking
   * for one" while the shop's photographed menu (raw.reading), its derived
   * option menu, or the thread's own standing price already carried one - the
   * app KNEW a price it refused to show. A sourced price renders with a
   * provenance chip and stays unverified until the agent confirms it.
   * Absent = the ordinary confirmed-reply path.
   */
  priceSource?: "menu" | "menu-photo" | "thread";
  /** The vehicle/tier the sourced price belongs to, in the shop's own words. */
  priceSourceVehicle?: string;
}

/**
 * WHAT THE SHOP'S REPLY ESTABLISHED, independent of whether a price was read
 * (owner problem #8). The replies merge used to drop a no-price row whole, so
 * the deposit, the delivery offer, the call request, the location question and
 * the alternativeOffer all vanished and the card went blank. These facts land
 * here for every reply row; when an offer exists they are ALSO merged onto it,
 * so existing offer-driven surfaces keep working unchanged.
 */
export interface ThreadFacts {
  alternativeOffer?: import("./vehicle/substitution").AlternativeOffer | null;
  wantsCall?: CallIntentFact | null;
  askedLocationQuote?: string | null;
  deposit?: string | null;
  depositType?: string | null;
  depositAmount?: number | null;
  depositCurrency?: string | null;
  delivers?: boolean | null;
  insuranceIncluded?: boolean | null;
  deliveryFee?: number | null;
  fulfillment?: "pickup" | "delivery" | "on-shop" | null;
  accessories?: import("./thread/accessories").AccessoryStatus[] | null;
  /**
   * The shop replied and the agent could not read a price - and no other state
   * the card already explains (declined / out of stock / alternative offered /
   * double-checking) applies. The card renders an explicit "replied, but the
   * price is unclear" state with the shop's own words instead of a blank.
   */
  replyUnparsed?: boolean;
  /** The shop's line (and its English gloss) backing the unparsed state. */
  replyText?: string | null;
  replyEnglish?: string | null;
  /** When the newest fact-bearing row landed (server clock). */
  at?: string;
}

export interface Vendor {
  id: string;
  name: string;
  lat: number;
  lng: number;
  rating: number;
  reviews: number;
  vehicleClasses: VehicleClass[];
  /**
   * The shop's own listing NAMES the searched class (its name, its Google type,
   * its primary type). `vehicleClasses` above only records which search this
   * result came back for - a fact about our query, not about the shop - so it
   * can never answer "does this place definitely rent cars?". This can.
   * Strengthened later by what the shop actually quotes (vendor tags).
   */
  classEvidence?: boolean;
  fulfillment: Fulfillment[];
  whatsapp: string; // E.164, opted-in partner vendor ("" when unknown yet)
  basePricePerDay: number; // internal seed used by the demo simulator only
  partner: boolean;
  demo: boolean; // true = seeded demo vendor, false = real Google Places result
  placeId?: string;
  address?: string;
  openNow?: boolean;
  photoUrl?: string;
  photoUrls?: string[]; // gallery (Google Places photos, proxied)
  todayHours?: string; // e.g. "Monday: 8:00 AM - 8:00 PM"
  orders?: number; // WheelDeal bookings made at this shop
  priceLevel?: number;
  distanceKm?: number;
  fastResponder?: boolean; // in the fastest-replying quartile (Ultra insight)
  // Reply-VERIFIED shop facts (item #13): each tag was explicitly stated by
  // the shop in >= 2 different replies before it is ever shown.
  verifiedTags?: string[];
  sponsored?: boolean; // paid placement: glowing card, pinned to the top
  // live state (client-side)
  stage?: TrackerStage;
  offer?: Offer;
  /** What the shop's replies established even when no price was read - the
   *  facts pass writes it for every reply row (see lib/client/reply-facts). */
  threadFacts?: ThreadFacts;
  sentiment?: number; // 0..1 from the Sentiment agent
  // Status-panel detail (client-side): the EXACT text we sent, its faithful
  // English gloss, when the last state change happened, and - when the shop was
  // closed - the ISO time the queued message will auto-send.
  sentText?: string;
  sentGloss?: string;
  /**
   * The last thing THE SHOP said, and when. The status panel used to file every
   * contacted shop under "Awaiting reply" - including shops that had already
   * answered - because it only knew the stage, never whether words had come
   * back. A traveller watching the feed fill up with replies while the panel
   * said "awaiting reply" is being told something that is plainly untrue.
   */
  lastInboundText?: string;
  /** English gloss of lastInboundText (local-language shops) - same doctrine
   *  as Offer.messageEnglish: the raw words stay primary, the translation is
   *  the second quiet line. */
  lastInboundEnglish?: string;
  lastInboundAt?: string;
  /**
   * THE AGENT IS DOUBLE-CHECKING SOMETHING (W4.4). The fact it was not sure it
   * had understood and has put back to the shop as a question - "deposit",
   * "price", "availability", "conditions", "vehicle". A thread waiting on that
   * answer used to be indistinguishable from an idle one, so the panel told the
   * traveller their agent was chasing a price it had already been given.
   */
  confirming?: string;
  /**
   * WE CHANGED THE LANGUAGE OF THIS CONVERSATION, AND THE SHOP ASKED US TO
   * (W4.6). Set ONLY for an explicit request - "sorry, I don't speak Thai",
   * "English please". A thread that is English because the whole hunt is
   * English is not a switch and leaves this undefined.
   *
   * The owner's ask, verbatim: "present the user in the status panel and the
   * card map/vendor card that we switched to English because they are not
   * speaking the local language."
   */
  languageSwitch?: "english" | "local";
  /** Their own words for it, so the card quotes rather than claims. */
  languageSwitchQuote?: string;
  /** When the newest agent message left (from /api/activity's lastByVendor) -
   *  keeps sentText/sentGloss fresh past the first outreach response. */
  lastOutboundAt?: string;
  lastEventAt?: number;
  queuedUntil?: string;
  // The anti-ban guard's RAW hold reason ("human pacing gap", "shop is closed
  // now"...) - cards translate it honestly instead of guessing "shop closed".
  queuedReason?: string;
  // The user removed queued messages for this shop - agents stay silent until
  // an explicit new send (the card says "paused by you", never pretends).
  cancelled?: boolean;
  // WHO cancelled. "user-removed" is the only reason that may render as
  // "Removed by you" - a session-close or deal-close tombstone is the
  // system's own action and must never be attributed to the traveller.
  cancelReason?: "user-removed" | "session-closed" | "deal-closed" | "unknown";
  // When the tombstone was written (keys the dismissible notice, so a LATER
  // removal of the same shop is a new fact and reappears).
  cancelledAt?: string | null;
}

export interface VendorReview {
  author: string;
  rating: number;
  text: string;
  timeAgo: string;
  timestamp: number;
}

export interface NegotiationTactic {
  id: string;
  label: string;
  script: string;
  // Learning stats - updated by the Continuous Learning Engine.
  uses: number;
  wins: number;
  avgDiscountPct: number;
  /** True while the counters sit exactly at the shipped starter priors -
   *  a ranking aid, not a measurement. Stamped by analytics(). */
  seeded?: boolean;
}

export interface AnalyticsSnapshot {
  totalRuns: number;
  totalOffers: number;
  avgDiscountPct: number;
  avgCycleSeconds: number;
  bestTactic: string | null;
  tactics: NegotiationTactic[];
  /** True while EVERY tactic is still seeded - nothing has been measured. */
  allSeeded?: boolean;
}

export type PlanId = "free" | "pro" | "ultra";

export interface Session {
  email: string;
  role: Role;
  // Owner and management are automatically Ultra, free of charge.
  plan: PlanId;
  issuedAt: number;
}

/**
 * WHAT `POST /api/outreach` CAN ANSWER WITH - one declared shape, shared by
 * every caller.
 *
 * Note what is NOT here: `ok`. The route has never returned it, but the callers
 * read `res.json()` as `any` and tested `r?.ok !== false`, which is
 * `undefined !== false` - permanently true. Every send reported success,
 * including the refused ones. Naming the shape is what made that visible.
 *
 * `error` is always user-safe prose (see lib/http/json-route): the shop card
 * renders it directly, so a raw exception message must never land in it.
 */
export interface OutreachReply {
  allowed?: boolean;
  /** The message left for the shop. */
  sent?: boolean;
  /** Parked by the anti-ban pacer - NOTHING was delivered. */
  queued?: boolean;
  queuedUntil?: string;
  queuedReason?: string | null;
  /** This exact ask is already on its way (idempotency claim). */
  duplicate?: boolean;
  /** Already asked and awaiting the reply - the agent keeps the thread going. */
  halted?: boolean;
  reason?: string;
  rateLimited?: boolean;
  reconnecting?: boolean;
  /** The server SAYS WhatsApp is linked. Never inferred from a failure. */
  configured?: boolean;
  connect?: boolean;
  channel?: string;
  phone?: string;
  /** false when the send landed but our record of it did not. */
  logged?: boolean;
  /** One user move per (traveller, shop) window - this tap was inside it.
   *  Nothing was sent; `error` carries the honest explanation. */
  held?: boolean;
  notice?: string | null;
  blocked?: boolean;
  cooldownMinutes?: number;
  underReview?: boolean;
  upgrade?: boolean;
  suggestion?: string;
  error?: string;
}
