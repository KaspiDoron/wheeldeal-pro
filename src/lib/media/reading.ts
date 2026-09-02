// WHAT THE AGENTS ACTUALLY READ IN THAT PHOTO.
//
// Most shops answer with a picture. A price board, a photo of the bike, a
// screenshot of their rate card. The vision agent reads it, the numbers become
// an offer - and then the reading itself evaporates. The image and the
// understanding of the image lived in two different places, and only one of
// them was ever shown.
//
// That is why the app could never prove it had understood anything. A traveller
// looking at "฿250/day" under a photo of a board has no way to know whether the
// agent read the board or guessed, and when it gets one wrong (a "6 days" read
// as a price) there is nothing to point at.
//
// A MediaReading is that missing artefact: the structured result of looking at
// one piece of media, stored beside the message it came from, in the shop's own
// terms. It is what the "agentic summary" under each photo renders, and it is
// the same object the negotiation already acts on - not a description written
// afterwards to look convincing.
//
// Pure, so the shape is testable without a model in the loop.

export interface ReadPrice {
  pricePerDay: number;
  currency?: string;
  /** The shop's own line, so a traveller can check the reading against the photo. */
  line?: string;
  /** Which vehicle this row was for, when the board said. */
  vehicle?: string;
  /** The stay this row applies to ("3-7 days"), for a duration ladder. */
  tierLabel?: string;
  /**
   * FALSE when the board CROSSED THIS ROW OUT (a red X, a line through it).
   *
   * A struck-through row is a model the shop no longer rents - it is still on
   * the board, so the reading still shows it, but its price is not on offer.
   * Undefined means the board said nothing either way, which is the norm.
   */
  available?: boolean;
}

/**
 * DID WE LOOK, AND WHAT DID WE SEE?
 *
 * - `read`          - the reader saw the media and got something out of it.
 * - `empty`         - the reader saw the media and there was NOTHING IN IT.
 *                     This one is a statement ABOUT THE PHOTO, and it is the
 *                     only one that is.
 * - `unavailable`   - THE READER NEVER RAN. Every provider failed (rejected
 *                     key, quota, timeout, safety block), so this reading is an
 *                     absence of a read, not a read that came up empty.
 * - `parse-failed`  - the model ANSWERED and we could not use its answer (the
 *                     JSON did not parse). Our failure, downstream of the
 *                     picture.
 * - `truncated`     - the model's answer was CUT OFF at the token ceiling
 *                     (a long board), so the JSON ended mid-row. Our ceiling,
 *                     not their board.
 * - `sanity-nulled` - we READ a price and then rejected it as implausible
 *                     (25,000/day). A number WAS seen; we refuse to quote it.
 *
 * THE FIELD FAILURE THIS TAXONOMY EXISTS FOR (owner report 5): a shop sent one
 * crisp photo of a typed 3x3 price menu - every cell machine-readable, the
 * traveller's exact model among them - and the panel said "We could not read
 * anything usable from this one. CONFIDENCE: LOW." Three different failures
 * (unparseable JSON, a MAX_TOKENS cut-off, and a price erased by the sanity
 * net) all collapsed into the ONE artefact reserved for "the photo was blank",
 * so a reader that broke was reported to the traveller as a photo that was bad.
 * Every member below `empty` is a failure OF OURS and must never render as a
 * fact about their picture.
 */
export type ReadingOutcome =
  | "read"
  | "empty"
  | "unavailable"
  | "parse-failed"
  | "truncated"
  | "sanity-nulled";

/**
 * The failures that happened on OUR side of the lens, after the shutter.
 * `unavailable` is here too: it is equally not a statement about the photo.
 */
export const READING_FAILURE_OUTCOMES: ReadonlySet<ReadingOutcome> = new Set<ReadingOutcome>([
  "unavailable",
  "parse-failed",
  "truncated",
  "sanity-nulled",
]);

/** WHAT THE MODEL PASS DID WRONG - the half of the taxonomy the reader stamps. */
export type ModelReadFailure = "parse-failed" | "truncated" | "sanity-nulled";

/**
 * THE VISION READ BROKE AND THE CAPTION CARRIED THE PRICE ANYWAY.
 *
 * `parse-failed` and `truncated` are failures of the PHOTO read. When the model
 * pass fails, the extractor still runs the deterministic reader over the
 * message text beside the photo (agents.ts, `deterministicPriceHit`) and
 * returns that hit WITH the failure marker still attached. The panel then
 * headlined "Your agent is re-reading this one" and hid the confidence chip,
 * directly above the rows it had read and a "-> used 250/day for your offer" -
 * one card contradicting itself twice.
 *
 * `sanity-nulled` is deliberately NOT recoverable: there the price we hold is
 * exactly the one we refuse to quote, so the refusal is still the whole story.
 */
const RECOVERABLE_MODEL_FAILURES: ReadonlySet<string> = new Set<string>([
  "parse-failed",
  "truncated",
]);

const MODEL_FAILURES: ReadonlySet<string> = new Set<string>([
  "parse-failed",
  "truncated",
  "sanity-nulled",
]);

/**
 * WHAT THE AGENT ACTUALLY DID ABOUT IT, recorded by the turn that did it.
 *
 * The proof panel used to assert "your agent is asking the shop to type it
 * instead" from nothing but an empty reading - a promise no code had made and
 * nothing had observed. This is the observation; the UI renders it and claims
 * nothing when it is absent.
 */
export interface ReadingFollowUp {
  /** The move the engine chose on the turn this media arrived (a MoveKind). */
  move: string;
  /** Whether a message actually left, as the send path reported it. */
  delivered: "sent" | "queued" | "held" | "blocked" | "failed" | "silent";
  at: string;
}

/**
 * THE DEFERRED RE-READ'S STATE, carried on the reading it belongs to.
 *
 * When every vision rung is exhausted the failure is usually about THIS MINUTE
 * - a 429, a timeout, a provider blip - not about the photo. The reply already
 * went out (nothing about media ever blocks a reply), so retrying costs the
 * traveller nothing and can turn an unreadable price board into a real price
 * once the per-minute budgets reset. The retry needs the RFQ and the message
 * text the first read used; carrying them here is what makes the sweep
 * self-contained, with no thread context to re-resolve.
 */
export interface RereadState {
  /** How many deferred retries have already been spent. */
  attempts: number;
  /** ISO of the last attempt, so the cooldown is measurable. */
  lastAt: string;
  /** The RFQ the first read used. Opaque here - this module stays pure. */
  rfq?: unknown;
  /** The coalesced message text that accompanied the media. */
  text?: string;
  /** Set once every retry is spent: the honest counter that answers "do we
   *  actually need offline OCR" with evidence instead of assumption. */
  exhausted?: boolean;
}

export interface MediaReading {
  /** Did the reader run, and did it find anything? See ReadingOutcome. */
  outcome: ReadingOutcome;
  /** Deferred-re-read bookkeeping (media/reread.ts). Absent = never queued. */
  reread?: RereadState;
  /** Why the reader could not run, when `outcome` is "unavailable". */
  unavailableReason?: string;
  /** The follow-up the turn recorded - never a claim the UI invents. */
  followUp?: ReadingFollowUp;
  /** Every per-day rate the media contained, cheapest first. */
  prices: ReadPrice[];
  /** Vehicles or models the media named. */
  vehicles: string[];
  /** Deposit terms stated in the media, in the shop's words. */
  deposit?: string;
  /** Conditions, restrictions, inclusions - anything else that binds the deal. */
  conditions: string[];
  /** Raw text the reader recovered, trimmed. Proof, and a fallback to eyeball. */
  text?: string;
  /** How sure the reader is. Shown, never hidden. */
  confidence: "high" | "medium" | "low";
  /** The price this reading contributed to the traveller's offer, if any. */
  usedPricePerDay?: number;
  /** Why it did not contribute, when it did not. */
  notUsedReason?: string;
  /**
   * THE NUMBER WE READ AND THEN REFUSED, when `outcome` is "sanity-nulled".
   *
   * The plausibility net used to erase the price and flip found=false, which
   * made a photo we had read perfectly produce the identical "nothing usable"
   * panel. The traveller is owed the number: it is the difference between "we
   * are blind" and "we read 25,000/day and that cannot be right".
   */
  rejectedPricePerDay?: number;
  rejectedCurrency?: string;
  /**
   * THIS READING CAME FROM THE BURST LEADER'S FRAME.
   *
   * Burst coalescing runs ONE turn for an album and stamped only the newest
   * frame's row, so the second photo in the conversation carried no reading at
   * all (owner report 5, #6). Every frame now carries the burst's reading; this
   * points at the frame it was read from, so the panel never implies the shown
   * photo was read on its own.
   */
  fromBurstLeader?: string;
  /**
   * THE PHOTO'S OWN READ FAILED AND THE MESSAGE TEXT RESCUED THE PRICE.
   *
   * Set only when the failure was `parse-failed`/`truncated` AND a usable price
   * survived, which on the live path can only be the caption's deterministic
   * hit. The outcome is then an honest "read" - there ARE rows to show - and
   * this field is what stops the panel implying the picture is what was read.
   */
  recoveredFrom?: ModelReadFailure;
}

/** The shape the vision/extraction step produces. Deliberately loose - this is
 *  a boundary with a model, and a missing field is normal, not exceptional. */
export interface ExtractionLike {
  found?: boolean;
  pricePerDay?: number;
  currency?: string;
  confidence?: string;
  deposit?: string;
  options?: Array<{
    pricePerDay?: number;
    currency?: string;
    label?: string;
    model?: string;
    tierLabel?: string;
    /** false = the board crossed this row out (see ReadPrice.available). */
    available?: boolean | null;
  }>;
  vehicleAssessment?: { model?: string; status?: string; reason?: string };
  // THESE ARE THE NAMES THE EXTRACTOR ACTUALLY PRODUCES.
  //
  // This shape used to declare `conditions: string[]` and `visionText: string`,
  // and ExtractedOffer has never had either field - it emits `conditionNotes`
  // and `imageSummary`. Both reads were therefore permanently `undefined`, and
  // because `readingIsEmpty` requires prices AND vehicles AND deposit AND
  // conditions AND text to all be empty, a photo the model read perfectly well
  // was reported to the traveller as "Nothing readable in this one" whenever it
  // carried no parsed price - a proof panel telling them the agents were blind
  // while the agents were, in fact, reading it.
  //
  // The old names are kept as optional aliases so any caller still passing them
  // (the studio/simulator mirrors) keeps working.
  conditionNotes?: string | null;
  imageSummary?: string | null;
  /** What the vision classifier called the media - present only on image turns. */
  imageKind?: "vehicle" | "price_sheet" | "document" | "other";
  vehicleDescription?: string | null;
  conditions?: string[];
  visionText?: string;
  /** The vision pass's own provenance (src/lib/ai readImages). `seen:false`
   *  means no provider ever looked at this media. */
  imageRead?: {
    seen?: boolean;
    failure?: string;
    detail?: string;
    retryable?: boolean;
    /**
     * THE MODEL ANSWERED AND WE STILL HAVE NOTHING - and that is OUR problem.
     *
     * `seen:true` used to be the end of the story, so an unparseable answer, a
     * truncated one and a price the sanity net erased all arrived at the panel
     * looking exactly like a blank board. This names which of them happened.
     */
    modelFailure?: string;
    /** The implausible number the sanity net rejected (`sanity-nulled`). */
    rejectedPricePerDay?: number;
    rejectedCurrency?: string;
  };
}

/**
 * DOES THIS TURN HOLD A READING OF MEDIA?
 *
 * The stamp that writes a MediaReading onto the message used to ask a
 * different question - "did the caller hand me image BYTES?" - and on the
 * production path the answer is always no. The vision Flow reads the photo in
 * an isolated worker and the CONTINUATION composes the reply, calling the
 * engine with `images: []` and the finished extraction. So the summary was
 * only ever written on the inline path, and in the field every photo rendered
 * with no agent reading under it.
 *
 * The right question is about the EXTRACTION, which carries its own vision
 * provenance whether or not the bytes travelled with it. Pure, so the exact
 * continuation shape is testable without a queue or a database.
 */
export function holdsMediaReading(
  imageCount: number,
  extraction: ExtractionLike | null | undefined
): boolean {
  if (imageCount > 0) return true;
  const e = extraction ?? {};
  // `imageRead` is set by readImages on EVERY extraction that had images -
  // including the ones where every provider failed, which are exactly the
  // turns a traveller most needs an honest "nobody could look at this" for.
  return Boolean(e.imageRead || e.imageKind || clean(e.imageSummary));
}

/**
 * THE ONE WINDOW THAT DEFINES A BURST, for the coalescer AND for the stamp.
 *
 * It lives here, in the pure module, because `wa/image-burst` is server-only
 * and the stamp selection has to be testable without a database - but it is the
 * SAME number by contract: a frame is a follower of this leader if and only if
 * the coalescer would have handed it to the leader's reader.
 */
export const BURST_WINDOW_MS = 6_000;

/**
 * EVERY FRAME OF A BURST CARRIES THE BURST'S READING.
 *
 * A shop sent two menu photos. Burst coalescing (wa/image-burst) makes the
 * NEWEST frame run one turn holding every frame - and the stamp then wrote the
 * reading onto that one row. The older frame kept its media, so it rendered in
 * the conversation with no reading panel at all: the traveller saw one photo
 * explained and an identical one beside it explained by nothing (owner report
 * 5, #6).
 *
 * The frames that stood down never get a turn of their own, so the leader's
 * reading is the only reading they will ever have. This picks the rows that
 * are owed it: same shop, same burst window, media on them, and NO reading of
 * their own (a row that was read on its own turn is never overwritten).
 *
 * A FRAME IS ONLY EVER STAMPED WITH A READING THAT INCLUDED IT.
 *
 * This window was 30s while the coalescer's is 6s, and stand-downs CHAIN: three
 * frames at t=0/5/11 hand off 0 -> 5 -> 11, and the leader at t=11 froze its
 * window at t=5, so its reader never saw the t=0 frame. The 30s stamp reached
 * it anyway and labelled it "Read together with the other photos in this
 * batch", under prices read off a different picture. The window is now the
 * coalescer's own, and one-sided: the leader is by construction the NEWEST
 * frame it saw, so anything that landed after it is a leader of its own and
 * gets its own turn - never this reading.
 *
 * Pure, so the selection is testable without a database.
 */
export function burstFollowerRows<
  T extends {
    id: number;
    received_at?: string | null;
    raw?: { media?: unknown; reading?: unknown } | null;
  }
>(rows: T[], leader: { id: number; received_at?: string | null }, windowMs = BURST_WINDOW_MS): T[] {
  const leaderAt = Date.parse(String(leader.received_at ?? "")) || 0;
  return rows.filter((r) => {
    if (r.id === leader.id) return false;
    if (!r.raw?.media) return false;
    if (r.raw?.reading) return false; // it was read on its own turn - leave it
    if (!leaderAt) return false;
    const at = Date.parse(String(r.received_at ?? "")) || 0;
    // `leaderAt - at` deliberately, not an absolute difference.
    return at > 0 && leaderAt - at >= 0 && leaderAt - at <= windowMs;
  });
}

/** Plain-English reason per failure kind, for the traveller (never a status code). */
const UNAVAILABLE_REASON: Record<string, string> = {
  unconfigured: "no image reader is configured",
  auth: "the image reader rejected our key",
  "rate-limit": "the image reader was over its quota",
  "bad-model": "the image reader was unavailable",
  blocked: "the image reader declined to describe this one",
  timeout: "the image reader did not answer in time",
  network: "we could not reach the image reader",
  upstream: "the image reader was having problems",
};

/**
 * WHICH OF THE FIVE THINGS HAPPENED, from the provenance alone.
 *
 * Pure and exported so the taxonomy is testable without a model, a queue or a
 * database - the classification is the fix, so it is the thing under test.
 *
 * Order matters: a model failure OUTRANKS "nobody looked", because a truncated
 * generation is a `seen:false` ladder result whose cause is our token ceiling,
 * not an outage - telling the traveller "the image reader was unavailable"
 * there would be the same lie in a different costume.
 */
export function classifyReading(
  extraction: ExtractionLike | null | undefined,
  blank: boolean
): ReadingOutcome {
  const r = extraction?.imageRead;
  const stamped = clean(r?.modelFailure);
  // A BROKEN PHOTO READ THE TURN THEN RECOVERED FROM IS NOT A FAILED READING.
  // The panel used to headline "Your agent is re-reading this one", suppress
  // the confidence chip, and print the prices and "-> used 250/day for your
  // offer" immediately below it. See `recoveredModelFailure`.
  if (recoveredModelFailure(extraction)) return "read";
  if (MODEL_FAILURES.has(stamped)) return stamped as ReadingOutcome;
  // The ladder itself can end on our ceiling rather than on an outage.
  if (clean(r?.failure) === "truncated") return "truncated";
  if (r?.seen === false) return "unavailable";
  return blank ? "empty" : "read";
}

/** A per-day price survived, from wherever the extractor got it. */
function hasUsablePrice(e: ExtractionLike): boolean {
  if (Number(e.pricePerDay) > 0) return true;
  return (e.options ?? []).some((o) => Number(o?.pricePerDay) > 0);
}

/**
 * WHICH BROKEN PHOTO READ THIS READING RECOVERED FROM, if any.
 *
 * Exported so the panel can say the true thing - the picture was not what we
 * read - instead of either lying about a re-read or hiding the failure.
 */
export function recoveredModelFailure(
  extraction: ExtractionLike | null | undefined
): ModelReadFailure | undefined {
  const e = extraction ?? {};
  const stamped = clean(e.imageRead?.modelFailure);
  const kind = RECOVERABLE_MODEL_FAILURES.has(stamped)
    ? (stamped as ModelReadFailure)
    : clean(e.imageRead?.failure) === "truncated"
      ? ("truncated" as const)
      : undefined;
  if (!kind) return undefined;
  return hasUsablePrice(e) ? kind : undefined;
}

function clean(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function confidenceOf(v: unknown): MediaReading["confidence"] {
  const c = clean(v).toLowerCase();
  return c === "high" ? "high" : c === "low" ? "low" : "medium";
}

/**
 * Turn an extraction into the artefact a traveller can check.
 *
 * Every field is something the reader genuinely produced. Nothing is invented
 * to fill the panel out: an empty reading renders as "we could not read this",
 * which is a true and useful thing to say.
 */
export function readingFrom(
  extraction: ExtractionLike | null | undefined,
  opts: {
    usedPricePerDay?: number;
    notUsedReason?: string;
    /** Only ever set by the turn that actually took the follow-up move. */
    followUp?: ReadingFollowUp;
  } = {}
): MediaReading {
  const e = extraction ?? {};
  const prices: ReadPrice[] = [];
  const seen = new Set<number>();

  for (const o of e.options ?? []) {
    const p = Number(o?.pricePerDay);
    if (!(p > 0) || seen.has(p)) continue;
    seen.add(p);
    prices.push({
      pricePerDay: p,
      currency: clean(o.currency) || clean(e.currency) || undefined,
      line: clean(o.label) || undefined,
      vehicle: clean(o.model) || undefined,
      tierLabel: clean(o.tierLabel) || undefined,
      // A crossed-out row stays in the reading (the board really does list it)
      // and is marked, so nothing quotes it and the traveller sees why.
      available: typeof o.available === "boolean" ? o.available : undefined,
    });
  }
  const headline = Number(e.pricePerDay);
  if (headline > 0 && !seen.has(headline)) {
    prices.push({ pricePerDay: headline, currency: clean(e.currency) || undefined });
    seen.add(headline);
  }
  // CHEAPEST FIRST - AMONG THE ROWS THAT ARE ACTUALLY ON OFFER.
  //
  // A plain price sort put a CROSSED-OUT row at `prices[0]`, and both consumers
  // that turn a reading into a number take the head of this list: the rival
  // table the live engine quotes to other shops, and the traveller's own card
  // ("Read from their price-menu photo"). We were advertising a model the shop
  // no longer rents, at a price nobody could book. Struck rows still travel -
  // the board really does list them and the owner wants to see them - they just
  // sink below every quotable row. Consumers filter as well (readings stored
  // before this sort existed keep the old order forever).
  prices.sort(
    (a, b) =>
      Number(a.available === false) - Number(b.available === false) ||
      a.pricePerDay - b.pricePerDay
  );

  const vehicles: string[] = [];
  for (const v of [e.vehicleAssessment?.model, ...(e.options ?? []).map((o) => o?.model)]) {
    const name = clean(v);
    if (name && !vehicles.includes(name)) vehicles.push(name);
  }

  // `conditionNotes` is one free-text line; `conditions` is the legacy array.
  const conditions = (
    e.conditions?.length
      ? e.conditions
      : String(e.conditionNotes ?? "")
          .split(/[;\n•]+/)
  )
    .map(clean)
    .filter(Boolean)
    .slice(0, 6);

  const deposit = clean(e.deposit) || undefined;
  const text =
    (clean(e.imageSummary) || clean(e.visionText) || clean(e.vehicleDescription)).slice(0, 600) ||
    undefined;

  // THE STATES THAT DID NOT EXIST. A vision pass that never ran cannot report
  // an empty read - it has nothing to report at all - and neither can a pass
  // whose answer we failed to parse, cut off at our ceiling, or overruled.
  // Saying otherwise is the false negative this whole artefact exists to make
  // impossible.
  const blank =
    prices.length === 0 && vehicles.length === 0 && !deposit && conditions.length === 0 && !text;
  const outcome = classifyReading(e, blank);
  const rejected = Number(e.imageRead?.rejectedPricePerDay);

  return {
    outcome,
    unavailableReason:
      outcome === "unavailable"
        ? UNAVAILABLE_REASON[String(e.imageRead?.failure ?? "")] ?? "the image reader was unavailable"
        : undefined,
    rejectedPricePerDay: outcome === "sanity-nulled" && rejected > 0 ? rejected : undefined,
    rejectedCurrency:
      outcome === "sanity-nulled" ? clean(e.imageRead?.rejectedCurrency) || undefined : undefined,
    recoveredFrom: recoveredModelFailure(e),
    followUp: opts.followUp,
    prices: prices.slice(0, 8),
    vehicles: vehicles.slice(0, 6),
    deposit,
    conditions,
    text,
    confidence: confidenceOf(e.confidence),
    usedPricePerDay: opts.usedPricePerDay,
    notUsedReason: opts.notUsedReason,
  };
}

/**
 * THE ROWS THIS SHOP WILL ACTUALLY RENT.
 *
 * `available === false` means the board CROSSED THE ROW OUT. Until this
 * existed, only the proof panel honoured the flag - the two places that turn a
 * reading into a NUMBER (graph/engine's cross-thread rival table, and the
 * card's "Read from their price-menu photo") both took `prices[0]` straight,
 * so a struck-out row became a live quote: to the traveller on their own card,
 * and to every OTHER shop as "another shop does 150".
 *
 * Availability SELECTION from an already-parsed structure is arithmetic, so it
 * belongs here in code and not in any model's judgement. Generic over the row
 * shape because the persisted `raw.reading.prices` JSON is read back with
 * narrower local types.
 */
export function quotablePrices<T extends { available?: boolean | null }>(
  prices: readonly T[] | null | undefined
): T[] {
  return (prices ?? []).filter((p) => p?.available !== false);
}

/** The cheapest row that is genuinely on offer, or null when none is. */
export function cheapestQuotable<
  T extends { pricePerDay?: number | null; available?: boolean | null }
>(prices: readonly T[] | null | undefined): T | null {
  let best: T | null = null;
  for (const p of quotablePrices(prices)) {
    const v = Number(p?.pricePerDay);
    if (!(v > 0)) continue;
    if (!best || v < Number(best.pricePerDay)) best = p;
  }
  return best;
}

/**
 * THE PRICE A PHOTOGRAPHED BOARD CONTRIBUTES TO THE TRAVELLER'S CARD.
 *
 * /api/replies runs this when the reply row itself carries no price: the
 * cheapest row of the shop's photographed menu, preferring a row that names
 * the displacement the traveller declared, tagged so the card can say WHERE the
 * number came from ("Read from their price-menu photo - being confirmed").
 *
 * It lives here, beside `quotablePrices`, because the availability rule and the
 * pick are one decision: the route used to reduce over EVERY row and advertise
 * the cheapest struck-through model on the board - a price that does not exist,
 * for a bike the shop no longer has. Pure, so the pick is executed under test
 * instead of pinned by a grep over a route handler.
 */
export function pickBoardPrice<
  T extends {
    pricePerDay?: number | null;
    available?: boolean | null;
    vehicle?: string | null;
    line?: string | null;
    tierLabel?: string | null;
  }
>(prices: readonly T[] | null | undefined, engineSizeCc = 0, durationDays = 0): T | null {
  const live = quotablePrices(prices).filter((p) => Number(p?.pricePerDay) > 0);
  if (!live.length) return null;
  // DURATION TIERS BIND. A board's "15-29 days" column is not available to a
  // 5-day traveller, yet this pick used to run over every row - so the
  // CHEAPEST (long-stay) tier became the card price and cross-thread rival
  // leverage. Rows whose tier does not cover this stay are out; untiered rows
  // always qualify; if NOTHING covers the stay, the answer is honestly null.
  const covered =
    durationDays > 0 ? live.filter((p) => tierCoversStay(p.tierLabel, durationDays)) : live;
  if (!covered.length) return null;
  const cc = engineSizeCc > 0 ? String(engineSizeCc) : null;
  const onSpec = cc
    ? covered.filter((p) => `${p.vehicle ?? ""} ${p.line ?? ""}`.includes(cc))
    : [];
  const pool = onSpec.length ? onSpec : covered;
  return pool.reduce((a, b) => (Number(a.pricePerDay) <= Number(b.pricePerDay) ? a : b));
}

/**
 * Does a board row's own tier wording ("3-7 days", "8+ days", "Monthly")
 * cover a stay of `days`? Unlabelled rows always do - a bare price is the
 * shop's general rate. Pure and deliberately forgiving: an unparseable label
 * counts as covering, because dropping a row over wording we cannot read
 * would hide a real price.
 */
export function tierCoversStay(label: string | null | undefined, days: number): boolean {
  const l = (label ?? "").trim().toLowerCase();
  if (!l) return true;
  const range = l.match(/(\d{1,3})\s*(?:-|to|–)\s*(\d{1,3})/);
  if (range) return days >= Number(range[1]) && days <= Number(range[2]);
  const plus = l.match(/(\d{1,3})\s*\+|(\d{1,3})\s*days?\s*(?:or more|and up|\+)/);
  if (plus) return days >= Number(plus[1] ?? plus[2]);
  if (/month/.test(l)) return days >= 28;
  if (/week/.test(l)) return days >= 7;
  const single = l.match(/(\d{1,3})\s*d/);
  if (single) return days >= Number(single[1]);
  return true;
}

/** Did the reader get anything at all out of this? Drives the empty state. */
export function readingIsEmpty(r: MediaReading | null | undefined): boolean {
  if (!r) return true;
  return (
    r.prices.length === 0 &&
    r.vehicles.length === 0 &&
    !r.deposit &&
    r.conditions.length === 0 &&
    !r.text
  );
}

/** The reader never ran on this one - distinct from running and finding nothing. */
export function readingUnavailable(r: MediaReading | null | undefined): boolean {
  return r?.outcome === "unavailable";
}

/**
 * DID WE FAIL, RATHER THAN THE PHOTO?
 *
 * The one question the panel has to ask before it says anything at all. Every
 * true answer forbids "nothing readable in this one" AND forbids a confidence
 * chip: "CONFIDENCE: LOW" on a failed read is not a statement about the photo,
 * it is the constant the failure branches happened to hardcode.
 */
export function readingIsFailure(r: MediaReading | null | undefined): boolean {
  return Boolean(r && READING_FAILURE_OUTCOMES.has(r.outcome));
}

/**
 * WHAT ACTUALLY HAPPENED WITH THIS ONE, in one line, for the empty state.
 *
 * Every branch says only what is recorded. The panel used to state flatly that
 * "your agent is asking the shop to type it instead" whenever a reading came up
 * blank - on the live engine nothing had been asked at the moment that rendered,
 * and when the thread had already asked about the price the engine's legal move
 * set had deliberately removed the question, so the sentence was doubly untrue.
 */
export function readingEmptyLine(r: MediaReading | null | undefined): string {
  if (!r) return "Nothing to show for this one.";
  // WHAT THE TURN ACTUALLY DID, appended to whichever failure sentence applies.
  //
  // THE PROMISE HALF OF THE SAME BUG (owner report 5, second pass). The
  // replacement copy for the failure branches said "it is being retried",
  // "your agent is reading it again with more room", "your agent reads it
  // again on the next message" and "your agent is asking the shop to confirm
  // it" - four dispatches nothing had scheduled. The retries these describe
  // all happened INSIDE the turn (agents.ts `regionReRead`, one budgeted
  // second pass) and there is no queue, no wakeup and no code path that looks
  // at the photo a second time afterwards. So every branch below states what
  // happened, in the past tense, and the only forward-looking clause is the
  // one the turn RECORDED in `followUp`.
  const did = followUpClause(r.followUp);
  if (r.outcome === "unavailable") {
    return `We did not get to read this one - ${r.unavailableReason ?? "the image reader was unavailable"}. Nothing here was guessed.${did}`;
  }
  // OUR FAILURES, IN OUR OWN NAME. None of these three may borrow the sentence
  // below: that one says the picture held nothing, and here the picture is
  // fine - a typed 3x3 price menu, in the reported case - while our reader,
  // our token ceiling or our own plausibility check is what came up short.
  if (r.outcome === "parse-failed") {
    return `Our reader answered about this one with something we could not use, and the closer second look we took straight afterwards did not recover it either. That is our side failing, not your photo.${did}`;
  }
  if (r.outcome === "truncated") {
    return `This board is longer than our reader was allowed to answer, so its reading was cut off part-way - and the compact second pass we ran on it did not finish it either. That is our limit, not your photo.${did}`;
  }
  if (r.outcome === "sanity-nulled") {
    const amount = r.rejectedPricePerDay
      ? `${r.rejectedPricePerDay}${r.rejectedCurrency ? " " + r.rejectedCurrency : ""}`
      : "a price";
    return `We read ${amount}/day off this one, which cannot be right for this area - so we did not quote it.${did}`;
  }
  const base = "We could not read anything usable from this one";
  // The empty branch keeps its own phrasing: the clause reads as a
  // continuation of the sentence rather than a new one.
  const f = r.followUp;
  if (!f) return `${base}.`;
  if (f.move === "silent") {
    return `${base} - your agent had already asked for this, so it is waiting rather than asking twice.`;
  }
  const pair = MOVE_ACTION[f.move];
  if (!pair) return `${base}.`;
  if (f.delivered === "sent") return `${base} - your agent ${pair[1]}.`;
  if (f.delivered === "queued") return `${base} - your agent is ${pair[0]}.`;
  // held / blocked / failed: something stopped the message. Claim nothing.
  return `${base}.`;
}

/**
 * The observed follow-up as a trailing sentence, or "" when nothing was
 * recorded - the panel then claims nothing, which is the whole rule.
 */
function followUpClause(f: ReadingFollowUp | undefined): string {
  if (!f) return "";
  if (f.move === "silent") {
    return " Your agent had already asked for this, so it is waiting rather than asking twice.";
  }
  const pair = MOVE_ACTION[f.move];
  if (!pair) return "";
  if (f.delivered === "sent") return ` Your agent ${pair[1]}.`;
  if (f.delivered === "queued") return ` Your agent is ${pair[0]}.`;
  // held / blocked / failed: something stopped the message. Claim nothing.
  return "";
}

/** [in flight, already done] per move. Only moves that can follow media appear. */
const MOVE_ACTION: Record<string, [string, string]> = {
  clarify: ["asking the shop to type the price out", "asked the shop to type the price out"],
  "deposit-probe": ["asking the shop about the deposit", "asked the shop about the deposit"],
  "fulfillment-probe": [
    "asking how you collect the vehicle",
    "asked how you collect the vehicle",
  ],
  "option-probe": [
    "asking what separates their options",
    "asked what separates their options",
  ],
  "confirm-vehicle": [
    "asking the shop to confirm the vehicle",
    "asked the shop to confirm the vehicle",
  ],
  answer: ["answering the shop's question", "answered the shop's question"],
  bargain: ["pushing for a better price", "pushed for a better price"],
  present: ["bringing you the offer", "brought you the offer"],
  "pickup-location": ["sending the pickup details", "sent the pickup details"],
  momentum: ["nudging the shop", "nudged the shop"],
  close: ["wrapping the conversation up", "wrapped the conversation up"],
  "redirect-close": ["wrapping the conversation up", "wrapped the conversation up"],
  "closing-message": ["wrapping the conversation up", "wrapped the conversation up"],
};

/**
 * AN IMAGE ROW WITH NO READING AT ALL - THE STATE THAT RENDERED AS SILENCE.
 *
 * The bubble drew the photo unconditionally and the panel only when a reading
 * existed, so every stamp failure degraded to a picture with nothing under it.
 * The traveller could not tell "still working" from "we are blind" from "the
 * panel is broken" - the field report verbatim, and the half of the owner's
 * "reading placeholder then repaint" that was never built.
 *
 * The two states are separated by the clock, which is the only evidence there
 * is: a turn that is going to stamp does it within its own budget (the vision
 * ladder is capped at 45s inside a 60s route, plus the burst defer), so past
 * the grace the absence IS the finding. Pure, and exported so both sentences
 * are testable without a browser.
 */
export const READING_GRACE_MS = 120_000;

/** Is this photo still inside the window in which a reading may yet land? */
export function readingIsPending(mediaAtIso: string | null | undefined, nowMs: number): boolean {
  const at = Date.parse(String(mediaAtIso ?? ""));
  // An unparseable timestamp is not evidence that anything failed.
  if (!Number.isFinite(at)) return true;
  return nowMs - at < READING_GRACE_MS;
}

/** The collapsed row for a photo we hold no reading for. */
export function missingReadingHeadline(pending: boolean): string {
  return pending ? "Reading this photo" : "No reading was recorded for this one";
}

/** ...and the sentence inside it. Neither invents anything about the picture. */
export function missingReadingLine(pending: boolean): string {
  return pending
    ? "Your agent is looking at this photo - what it reads appears here as soon as it lands."
    : "Your agent's reading of this photo was never stored, so there is nothing to show you about it. That is our side failing, not your photo - the photo itself is above, exactly as it arrived.";
}

/** A one-line headline for the collapsed state - what the traveller sees first. */
export function readingHeadline(r: MediaReading | null | undefined): string {
  if (readingUnavailable(r)) return "Could not read this one yet";
  // A COLLAPSED ROW LIES FASTEST. These three used to fall through to "Nothing
  // readable in this one" - the single line most travellers ever see - about
  // photos we had, in two of the three cases, already read.
  // ...and none of the three may promise a retry either: the collapsed row is
  // the line most travellers ever see, and "re-reading"/"checking" described
  // work that had already finished inside the turn (see readingEmptyLine).
  if (r?.outcome === "parse-failed") return "Our reader could not handle this one";
  if (r?.outcome === "truncated") return "Too long for our reader to finish";
  if (r?.outcome === "sanity-nulled") return "One price here cannot be right";
  if (readingIsEmpty(r)) return "Nothing readable in this one";
  const parts: string[] = [];
  if (r!.prices.length === 1) parts.push("1 price");
  else if (r!.prices.length > 1) parts.push(`${r!.prices.length} prices`);
  if (r!.vehicles.length) parts.push(`${r!.vehicles.length} vehicle${r!.vehicles.length > 1 ? "s" : ""}`);
  if (r!.deposit) parts.push("deposit terms");
  if (r!.conditions.length) parts.push(`${r!.conditions.length} condition${r!.conditions.length > 1 ? "s" : ""}`);
  return parts.length ? `Read ${parts.join(", ")}` : "Read this image";
}
