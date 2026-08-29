// The agentic reply loop - shared by every inbound WhatsApp channel (official
// Meta Cloud API webhook AND per-user Evolution API sessions).
//
// Discipline (this is what makes the agent feel human, not robotic):
//   - The agent reads the WHOLE thread before speaking, so it never re-asks a
//     question the shop already answered.
//   - It clarifies AT MOST ONCE per shop. After that, any price the shop gave
//     is stored as an offer (unverified if needed) and the agent moves on.
//   - It bargains EXACTLY ONCE per shop: a single friendly ask anchored to the
//     real market floor for the area (see lib/market.ts). If the shop says no,
//     it thanks them and stops - no pushing, ever.
//   - Every automated outbound passes the Anti-Ban guard (lib/wa-guard.ts):
//     engagement halt, recipient business hours, dynamic reputation caps,
//     humanized content variance.

import "server-only";
import { sbInsert, sbSelect, sbSelectStrict, sbSelectDark, sbUpdate } from "./runtime-config";
import { finishBeforeResponse } from "./after";
import { isMediaPlaceholder as isMediaPlaceholderText } from "./wa/coalesce";
import { extractOffer, composeBargain, runSafety, currencyForRegion, money } from "./agents";
import {
  checkOutboundNumbers,
  claimedRivalNumber,
  correctDuration,
  buildSafeBargainAsk,
  stripRivalClaims,
  verbatimNumerals,
} from "./graph/guardrails";

/**
 * The strategist note is LLM free text. Pass it to the bargainer ONLY when it
 * does not assert a competitor PRICE we cannot vouch for: no rival number is
 * fine (a strategic hint), a number matching our one server-verified rival is
 * fine, anything else (an invented "another shop offered 220") is dropped whole.
 */
function safeLeverageNote(note: string | undefined, rivalPrice: number | undefined): string {
  const n = (note ?? "").trim();
  if (!n) return "";
  const claimed = claimedRivalNumber(n);
  if (claimed === undefined) return `Real leverage you may mention: ${n}.`;
  if (rivalPrice !== undefined && Math.abs(claimed - rivalPrice) <= Math.max(1, rivalPrice * 0.05)) {
    return `Real leverage you may mention: ${n}.`;
  }
  return ""; // asserts a rival price that is not our verified one - drop it
}
import { floorPriceFor, credibleFloor } from "./market";
import { runWithAiBudget } from "./ai-budget";
import {
  guardOutbound,
  afterSend,
  recordInboundEngagement,
  claimForSend,
  releaseSendClaim,
} from "./wa-guard";
import { noteInboundDropped } from "./wa/webhook-trace";
import { waDigits, numberFilter } from "./wa/phone-key";
import { resolveThreadContext } from "./wa/thread-context";
import type { TraceRow } from "./orchestrator";
import type { StructuredRFQ, Vendor } from "./types";
import type { SendResult } from "./wa/transport";
import { digitsOnly } from "./phone";

/**
 * The owner's fleet-wide local-language switch (`LOCAL_LANGUAGE` in the Key
 * Vault). Defaults ON, and an UNREADABLE config keeps that default: this switch
 * exists to stop the feature, not to be the reason a reply is composed in the
 * wrong language during an outage.
 */
async function localLanguageEnabled(): Promise<boolean> {
  try {
    const { getConfig } = await import("./runtime-config");
    const raw = (await getConfig("LOCAL_LANGUAGE"))?.trim().toLowerCase();
    if (!raw) return true;
    return !["off", "false", "0", "no"].includes(raw);
  } catch {
    return true;
  }
}

export interface ThreadContext {
  sender?: string;
  vendorId?: string;
  vendorName?: string;
  kind?: string;
  /**
   * The engine MOVE this outbound carried (`confirm-vehicle`, `bargain`, ...).
   *
   * It was already being written here by the dispatch site and read back by
   * `graph/engine.ts` through a cast - but it was never declared, so every
   * other consumer had to either cast too or fall back to guessing the fact
   * from our own prose. Both of those happened, and both produced the same
   * user-visible bug: a question asked twice.
   */
  move?: string;
  round?: number;
  rfq?: StructuredRFQ | null;
  region?: string;
  plan?: string;
  channel?: string;
  localLang?: boolean;
  // The traveller's consented accommodation, stamped on the outbound at send
  // time so a shop asking "where is your hotel?" can be answered - never guessed.
  stay?: { label: string; lat?: number; lng?: number; shareConsent: boolean };
}

interface OutboundRow {
  id: number;
  to_number: string | null;
  raw: ThreadContext | null;
}

interface ThreadMsg {
  direction: "inbound" | "outbound";
  body: string | null;
  raw: ThreadContext | null;
  received_at: string;
  /** Provider id - present on inbound rows so a coalescing turn can CLAIM
   *  the siblings it consumed (H1); older/outbound rows may lack it. */
  wa_message_id?: string | null;
}

export type SendFn = (to: string, message: string) => Promise<SendResult>;

// Gracious one-time closers (varied further by the anti-ban content variator).
// CRITICAL: these must NEVER imply a deal is accepted or a booking confirmed
// ("that works", "I'll confirm") - only the traveller decides to close a deal,
// and the booking flow sends the real confirmation. These just end the
// exchange warmly while keeping every option open.
const CLOSE_OK = [
  "Thanks so much for the info! Let me think it over and I'll message you again.",
  "Really appreciate it, thank you! I'll check my plans and get back to you.",
];
const CLOSE_NO = [
  "No worries at all, thanks for letting me know! I'll think it over and get back to you.",
  "All good, I understand! Thanks for your time - I'll be in touch.",
];

// Did the shop ask US something? A question must be ANSWERED, never met with a
// canned thank-you (replying "sounds good!" to "you mean motorbike or car?" is
// the exact nonsense that makes the agent look like a bot).
function shopAskedQuestion(text: string): boolean {
  return (
    /\?/.test(text) ||
    /\b(you mean|do you mean|which (one|type|kind|model)|what (kind|type|size|model|dates?|day|time)|motor ?bike or car|car or (motor ?)?bike|scooter or (motor ?)?bike|how (many|long|much time)|when (do|will|are) you|where (are|do) you|pick ?up or delivery)\b/i.test(
      text
    )
  );
}

// Deterministic fallback answer when the LLM is unavailable: restate the exact
// request. Never guesses beyond the RFQ.
function fallbackAnswer(rfq: StructuredRFQ): string {
  const days = `${rfq.durationDays} day${rfq.durationDays === 1 ? "" : "s"}`;
  if (rfq.vehicleClass === "car") {
    const parts = [
      rfq.carType && rfq.carType !== "any" ? rfq.carType : "",
      rfq.transmission !== "any" ? rfq.transmission : "",
      "car",
      rfq.seats ? `${rfq.seats} seats` : "",
    ].filter(Boolean);
    return `A ${parts.join(" ")}, for ${days}. What would the daily price be?`;
  }
  const cc = rfq.engineSizeCc ? `${rfq.engineSizeCc}cc ` : "";
  const kind = rfq.vehicleClass === "scooter" ? "automatic scooter" : "manual motorbike";
  return `The ${cc}${kind} (not a car), for ${days}. What would the daily price be?`;
}

/** Process one inbound vendor message; auto-extract + auto-respond (once). */
/**
 * The NEVER-SILENT photo fallback (Module 3): when a shop sent an image but
 * the media download permanently failed or the OCR produced nothing usable,
 * the agent must ask warmly for the price in text instead of leaving the shop
 * on read. Shaped exactly like extractOffer's own degraded result so the
 * engine routes it through the normal clarify path (guard + human delay +
 * uniqueness all apply). matchesSpec stays true - "unreadable" must never be
 * mistaken for "wrong vehicle" (false would freeze the whole negotiation).
 */
export function photoClarifyExtraction(): import("./agents").ExtractedOffer {
  return {
    found: false,
    matchesSpec: true,
    confidence: "low",
    // THE STAMP MUST FIRE ON THIS PATH TOO. Without imageRead this result was
    // indistinguishable from a text turn: holdsMediaReading() said false, no
    // reading (not even 'unavailable') was ever stored, and the transcript
    // showed the honest-placeholder "reading was never stored" under a photo
    // we KNEW we failed to download. The taxonomy's unavailable state was
    // unreachable exactly where nobody could look.
    imageRead: { seen: false, failure: "network", detail: "media download failed", retryable: true },
    clarifyMessage:
      "We couldn't read that photo clearly - could you type the daily price out for us? 🙂",
  } as import("./agents").ExtractedOffer;
}

/** The same never-silent guarantee for a video nobody could watch (too large,
 *  exotic codec, download failed): a reply exists, claims no price, and asks
 *  for the one thing we need in a form we can read. */
export function videoClarifyExtraction(): import("./agents").ExtractedOffer {
  return {
    found: false,
    matchesSpec: true,
    confidence: "low",
    clarifyMessage:
      "I could not watch the video - could you send a photo of the price list, or type the daily price? 🙂",
  } as import("./agents").ExtractedOffer;
}

/**
 * Record how long THIS turn actually took, at the point the reply left our
 * hands. `composeMs` is the honest cost of the whole chain (extraction, engine
 * pass, validator, localization); `plannedDelayS` is the deliberate human
 * pacing on top. Fire-and-forget - a metric never delays a reply.
 */
function stampTurnLatency(
  email: string | undefined,
  toDigits: string,
  detail: { composeMs: number; plannedDelayS: number; outcome: string }
): void {
  if (!email) return;
  void sbInsert("agent_events", [
    {
      kind: "turn-latency",
      user_email: email,
      vendor_name: toDigits,
      detail: JSON.stringify(detail),
    },
  ]).catch(() => {});
}

export async function processVendorReply(opts: {
  fromDigits: string;
  text: string;
  waMessageId?: string;
  images?: { mime: string; base64: string }[];
  // Voice notes: the raw audio (transcribed here) and/or a pre-computed
  // transcript. The webhook downloads the audio; the engine's transcribe node
  // and the media-coherence validator handle the rest.
  audios?: { mime: string; base64: string }[];
  transcript?: { text: string; language?: string; source: string } | null;
  // The user whose WhatsApp received this reply. CRITICAL for multi-user
  // correctness: two users can bargain with the SAME shop, and the reply must
  // attach to THIS user's thread, never someone else's.
  senderEmail?: string;
  // The inbound message's TRUE origin chat JID (data.key.remoteJid). When
  // provided, we assert digitsOnly(remoteJid) === fromDigits before attributing
  // the reply, so a mis-scoped caller can never staple a personal chat onto a
  // shop thread. Defense-in-depth behind the per-message JID filter upstream.
  remoteJid?: string;
  // Queue the agent's reply with a natural "thinking" delay instead of
  // answering within seconds (instant replies are the biggest bot tell).
  // Only for senders whose own session can deliver from the queue.
  humanDelay?: boolean;
  // Module 3 (vision offload): a pre-computed extraction from the isolated
  // vision worker. When set, the in-turn extractOffer call is skipped - the
  // LLM-heavy OCR already ran at the vision queue's strict concurrency, and
  // this turn only composes/guards/sends. Also carries the NEVER-SILENT
  // fallback (photoClarifyExtraction) when the media/OCR pipeline failed.
  preExtracted?: import("./agents").ExtractedOffer;
  send: SendFn;
}): Promise<void> {
  // TURN LATENCY, MEASURED NOT ASSUMED. "Replies land in ~1-2 min" was a claim
  // nobody could check: the composer's delay was visible in the trace, but the
  // part that actually blew the ceiling - how long the LLM chain took before
  // that delay even started - was never recorded. This stamps the real number
  // at each terminal point so the doctor can show p50/p95 instead of a promise.
  const turnStartedAt = Date.now();
  let text = opts.text.trim();
  const images = opts.images ?? [];
  const transcript = opts.transcript ?? null;
  // A voice note carries its transcript as the message text so the whole
  // pipeline (extract -> coherence -> director) treats it exactly like an
  // inbound text, marked so the reasoning is transparent in traces.
  if (isMediaPlaceholderText(text) && transcript?.text) text = `(voice note) ${transcript.text}`.trim();
  // A price-list PHOTO or voice note with no caption is still a real reply.
  // When the media download FAILED (images empty, no text, but a real message
  // id exists), the shop DID answer - going silent here makes the app look
  // like the shop ghosted the user. Synthesize an honest placeholder so the
  // reply is visible everywhere and the agent politely asks for text.
  if (!text && images.length === 0) {
    if (!opts.waMessageId) return; // synthetic/system event - nothing real
    text = "(the shop sent a photo/attachment that couldn't be loaded)";
  }
  // waDigits (not digitsOnly): strips the multi-device JID suffix (":12") so a
  // multi-device reply keys to the same shop as the outbound anchor.
  const from = waDigits(opts.fromDigits);
  // ORIGIN ASSERTION (privacy): if the caller gave us the message's true chat
  // JID, it MUST match the number we are about to attribute this reply to. A
  // mismatch means the message came from a different chat (a personal contact
  // swept in by a mis-scoped read) - refuse to attribute it as a shop reply.
  if (opts.remoteJid) {
    const originDigits = waDigits(opts.remoteJid);
    const isPhoneJid = /@s\.whatsapp\.net$|@c\.us$/.test(opts.remoteJid);
    // Phone JIDs must match by digits; a privacy @lid JID cannot be verified
    // against a phone number, so we fail closed (do not attribute).
    if (!isPhoneJid || originDigits !== from) return;
  }
  const senderFilter = opts.senderEmail
    ? `&raw->>sender=eq.${encodeURIComponent(opts.senderEmail)}`
    : "";

  // Find the thread through THE shared resolver (src/lib/wa/thread-context.ts).
  // It scans a window of recent outbound rows for the newest one carrying an
  // RFQ, instead of demanding that the very newest row carry it. That single
  // change is what stops one human-manual takeover row - or one send whose
  // client omitted body.rfq - from orphaning a live negotiation forever.
  // Number matching is spelling-tolerant, so threads stored under a national
  // format ("09661952196") still resolve for an international inbound.
  const resolved = await resolveThreadContext(from, opts.senderEmail ?? "");
  const ctx = resolved.ctx as (OutboundRow["raw"] & { rfq?: unknown }) | null;
  // ATTRIBUTION FALLBACK: the RFQ anchor row and the identity row (newest
  // raw.vendorId) can be DIFFERENT rows. When the anchor lost its vendorId,
  // every derived row (vendor_replies, offers, events) was written with
  // vendor_id "" - persisted but unreadable by every card surface, the
  // textbook stored-but-invisible reply. The identity row's vendorId fills
  // the gap; a thread with neither leaves a trace instead of writing rows
  // no card can ever find.
  if (ctx && !ctx.vendorId && resolved.vendorId) ctx.vendorId = resolved.vendorId;
  if (ctx && !ctx.vendorId) {
    void noteInboundDropped(opts.senderEmail, from, "derived-unattributed", {
      note: "thread carries no vendorId - derived rows would be invisible to cards",
    });
  }
  if (!resolved.rfq || !ctx) {
    // Still no anchor: we genuinely never sent this number an RFQ. Trace it so
    // the WA doctor can explain "why no agent reply" instead of going silent.
    void noteInboundDropped(opts.senderEmail, from, "no-rfq-thread", {
      anchors: resolved.anchors,
      gate: resolved.reason,
    });
    return; // reply without a known thread - stored, not processed
  }

  // ---- EXACTLY ONE TURN, AND ONLY WHILE WE ARE ACTUALLY TAKING IT ----------
  //
  // Both claims live HERE, after the thread resolves, for reasons that are the
  // opposite sides of one mistake:
  //
  //   - The reply claim used to be taken at the very top, before we even knew
  //     whether this was a thread we own, and was never released. Any turn that
  //     threw left the message permanently un-replyable and un-replayable, with
  //     no trace: one shop out of seven silently never answered. It is a LEASE
  //     now - released in `finally` unless we actually delivered something.
  //
  //   - There was no per-THREAD exclusion at all. Two webhook frames from the
  //     same shop each won their own message claim and each composed a reply,
  //     because every "have we already said this?" counter reads the outbound
  //     row, which is written only after the send. Two duplicate bargains in
  //     the same minute.
  const senderKeyForTurn = opts.senderEmail ?? "";
  let holdsTurn = false;
  let claimedReply = false;
  let turnDelivered = false;

  if (opts.waMessageId) {
    const { sbInsertReturning } = await import("./runtime-config");
    const { claimKey, quotedInList } = await import("./wa/inbound-claim");
    // Receiver-scoped (H4): the bare provider id is not unique across
    // RECEIVERS - a shop's broadcast delivers the same id to two travellers,
    // and a global claim dropped the second one's copy as a duplicate.
    // Legacy bare-id rows still count as claimed (the in.() check below).
    const replyKey = claimKey(opts.senderEmail, opts.waMessageId);
    const claimed = await sbInsertReturning<{ wa_message_id: string }>("wa_processed", [
      { wa_message_id: replyKey },
    ]);
    if (claimed.length === 0) {
      const keys = replyKey === opts.waMessageId ? [replyKey] : [replyKey, opts.waMessageId];
      const filter = `wa_message_id=in.(${quotedInList(keys)})&limit=1`;
      // ZERO ROWS BACK FROM THE INSERT DOES NOT MEAN "SOMEBODY ELSE HAS IT".
      // `sbInsertReturning` returns [] for a duplicate key AND for a missing
      // table AND for a network error AND for demo mode, so the follow-up read
      // is what actually decides. It therefore has to distinguish "no claim
      // row" from "I could not read", which `.catch(() => [])` could not:
      // both arrived as an empty array and both fell through to the election.
      //
      // That mattered, because the election is only a dedupe among frames that
      // ENTER it. The frame that won the insert proceeds without ever
      // competing, so a losing frame that reaches `wa_send_claims` wins it
      // UNCONTESTED and answers the same shop a second time. The reachable
      // case is not exotic: `settled_at` is an additive column, and on a
      // deployment where `supabase/schema.sql` has not been re-run this select
      // fails on EVERY duplicate frame - which is exactly the shape the audit
      // reported and I could not confirm until reading the insert's contract.
      const read = await sbSelectStrict<{
        wa_message_id: string;
        created_at?: string | null;
        settled_at?: string | null;
      }>("wa_processed", `select=wa_message_id,created_at,settled_at&${filter}`);
      let existing: { wa_message_id: string; created_at?: string | null; settled_at?: string | null }[] = [];
      if ("error" in read) {
        // The lease column could not be read. Ask the NARROWER question that a
        // pre-migration schema can still answer: is there a claim row at all?
        const bare = await sbSelectDark<{ wa_message_id: string }>(
          "wa_processed",
          `select=wa_message_id&${filter}`
        );
        // `null` = truth unknown; a row = a claim demonstrably exists and
        // cannot be judged. Either way, STAND DOWN. The holder answers, or the
        // recovery sweep retakes the message later against a real lease. A
        // duplicate bargain to a shop is the one outcome we cannot take back,
        // and a late reply is recoverable where a double reply is not.
        if (bare === null || bare.length > 0) return;
        // `[]` = no claim row (table absent, or the row is genuinely gone), so
        // the insert failed for some other reason and the election below is
        // the right dedupe.
      } else {
        existing = read.rows;
      }
      if (existing.length > 0) {
        // ...UNLESS THE HOLDER IS GONE. A claim is a lease: a turn that fails
        // hands it back, so only an instance killed mid-turn leaves one
        // hanging. Past the lease with nothing settled, that message has been
        // sitting answered-by-nobody, and this is the one place that can take
        // it over. Deleting first keeps the retake atomic - whoever wins the
        // re-insert owns the turn.
        const { claimIsDeadTurn } = await import("./wa/inbound-claim");
        if (!claimIsDeadTurn(existing[0])) return; // a live delivery owns it
        const { sbDelete } = await import("./runtime-config");
        await sbDelete(
          "wa_processed",
          `wa_message_id=eq.${encodeURIComponent(existing[0].wa_message_id)}`
        ).catch(() => {});
        const retaken = await sbInsertReturning<{ wa_message_id: string }>("wa_processed", [
          { wa_message_id: replyKey },
        ]);
        if (retaken.length === 0) return; // someone else retook it first
        claimedReply = true;
      }

      // wa_processed is missing or unreachable. The old fallback here COUNTED
      // stored inbound rows and stood down when it saw more than one - which
      // is symmetric, and therefore the worst possible answer: both concurrent
      // deliveries see the same two rows, both conclude "someone else has
      // this", and the shop gets ZERO replies. A dedupe that can silence a
      // conversation entirely is worse than no dedupe at all.
      //
      // Elect a winner instead, on `wa_send_claims` - an atomic conditional
      // insert in a DIFFERENT table, so the very outage that took wa_processed
      // out does not take the election with it. Exactly one delivery wins.
      if (!claimedReply) {
        const { electReplyOwner } = await import("./wa/inbound-claim");
        if (!(await electReplyOwner(opts.senderEmail, replyKey))) return;
      }
    } else {
      claimedReply = true;
    }
  }

  // E1 (owner report 6): the informational risk screen, deferred off the
  // reply's critical path. Declared HERE so the turn body (runVendorTurn)
  // can arm it and the finally below can run it on every exit path.
  let riskScreenDeferred: (() => Promise<void>) | null = null;
  // Captured ONCE so claim and release compute the SAME buckets - a release
  // computed at its own time deleted a slot the claim never took whenever
  // the turn straddled a 60s bucket boundary (see wa/turn-lock).
  const turnClaimedAtMs = Date.now();
  try {
    const { claimThreadTurn, releaseThreadTurn } = await import("./wa/turn-lock");
    const turn = await claimThreadTurn(senderKeyForTurn, from, turnClaimedAtMs);
    if (turn === "lost") {
      // A sibling turn owns this thread right now. Do NOT compose a second
      // reply against a thread state that is about to change. Hand the message
      // back so the burst is answered once, as one coalesced turn.
      if (claimedReply && opts.waMessageId) {
        const { releaseReplyClaim } = await import("./wa/inbound-claim");
        await releaseReplyClaim(opts.waMessageId, opts.senderEmail);
      }
      void noteInboundDropped(opts.senderEmail, from, "turn-in-flight", {
        note: "another delivery is mid-turn for this thread; released for the winner to coalesce",
      });
      return;
    }
    holdsTurn = turn === "won";
    void releaseThreadTurn; // released in the finally below

    // EVERY LLM CALL IN THIS TURN IS BILLED TO THE TRAVELLER WHO OWNS IT.
    //
    // One wrap covers the whole turn - extraction, safety, strategist, the
    // engine pass, the judge - because runVendorTurn is already the single
    // inner function. The scope is checked once and debited once, so a
    // multi-call turn costs one read and one write rather than one of each per
    // call.
    //
    // Over-cap does NOT abort the turn: chatDetailed refuses the model calls
    // and the deterministic composer answers instead, so the shop still gets a
    // reply and the traveller still gets a negotiation - just without the
    // model. Freezing the thread would be a worse answer to "you have used
    // your AI allowance" than degrading it.
    return await runWithAiBudget(opts.senderEmail ?? "", runVendorTurn);
  } finally {
    // E1: the informational risk screen, off the reply's critical path but
    // never off the request - Cloud Run freezes the CPU after the response,
    // so it must still finish (bounded) before this function returns.
    if (riskScreenDeferred) await finishBeforeResponse("risk-screen", riskScreenDeferred);
    const { releaseThreadTurn } = await import("./wa/turn-lock");
    if (holdsTurn) await releaseThreadTurn(senderKeyForTurn, from, turnClaimedAtMs);
    // A turn that did not deliver has not consumed the message. Give the claim
    // back so a redelivery or the recovery sweep can answer it.
    if (claimedReply && !turnDelivered && opts.waMessageId) {
      const { releaseReplyClaim } = await import("./wa/inbound-claim");
      await releaseReplyClaim(opts.waMessageId, opts.senderEmail);
    } else if (claimedReply && turnDelivered && opts.waMessageId) {
      // SETTLE it. A kept claim used to mean two different things - "answered"
      // and "the instance died holding this" - and the recovery sweep could
      // not tell them apart, so a turn killed mid-flight silenced that message
      // forever. Now only a settled claim means answered.
      const { settleReplyClaim } = await import("./wa/inbound-claim");
      await settleReplyClaim(opts.waMessageId, opts.senderEmail);
    }
  }

  async function runVendorTurn(): Promise<void> {
  // Already guaranteed by the guard above; restated because narrowing does not
  // cross the closure boundary.
  if (!ctx) return;
  const priorAt = resolved.newestAt;
  // "(unverified)" PURGE at the source: a historical thread whose outbound meta
  // carries the legacy drill suffix must not propagate it into pushes, events,
  // offers or engine turns.
  if (ctx.vendorName) {
    const { cleanShopName } = await import("./text");
    ctx.vendorName = cleanShopName(ctx.vendorName);
  }

  // SESSION LIFECYCLE GUARD: if the user closed the search session AFTER our
  // last outbound in this thread, the thread is DEAD. We still store the reply
  // below (data is never lost) but the agent says nothing more - a closed
  // session must never keep talking to shops. A new search re-opens the shop
  // with a fresh outbound, which then postdates the marker.
  let sessionClosed = false;
  // WHY closed, for the drop trace: a user-cleared hunt and a quietly expired
  // one are different stories when the owner asks "why did the agent go quiet".
  let sessionClosedReason: "session-terminated" | "session-expired" = "session-terminated";
  // THE SEARCH BOUNDARY (owner report 6 B). The newest session-closed marker
  // is not only the dead-thread gate: it is where the CURRENT search begins.
  // Every context read below (history window, working thread, coalescing,
  // ask-once counters) is cut at it, so a re-contacted shop's turns from the
  // PREVIOUS hunt can never feed this hunt's composer - the '5 days' the
  // agent kept citing on a 4-day search came from exactly that leak.
  let sessionBoundaryAt: string | null = null;
  if (ctx.sender) {
    const marker = await sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&raw->>sender=eq.${encodeURIComponent(
        ctx.sender
      )}&to_number=eq.session&raw->>kind=eq.session-closed&order=received_at.desc&limit=1`
    );
    sessionBoundaryAt = marker[0]?.received_at ?? null;
    if (priorAt) sessionClosed = Boolean(sessionBoundaryAt && sessionBoundaryAt > priorAt);
  }
  // ...OR THE HUNT SIMPLY EXPIRED. The 3h TTL was enforced only by the CLIENT
  // dropping sessionStorage - the server kept no tombstone, so a shop replying
  // five hours later found an agent happy to keep negotiating a search the
  // traveller had forgotten about, and a push pipeline happy to buzz them
  // about it. Fail toward LIVE: an unreadable liveness read must not mute a
  // real negotiation mid-flight.
  if (ctx.sender && !sessionClosed) {
    try {
      const { huntState } = await import("./notify/liveness");
      const hunt = await huntState(ctx.sender);
      if (hunt.live === false && hunt.reason === "ttl-expired") {
        sessionClosed = true;
        sessionClosedReason = "session-expired";
        // MAKE IT DURABLE, once. The full close (outbox purge, wakeup purge,
        // recipient tombstones, the marker) runs exactly like a user clear -
        // and because the marker now postdates the hunt, huntState answers
        // "cleared" from here on, so this branch cannot re-fire. Without it,
        // the stand-down lived only in this turn's memory while strategic
        // waits and queued sends stayed armed against a dead hunt.
        const { closeSearchSession } = await import("./session-close");
        void closeSearchSession(ctx.sender, { reason: "ttl-expired" }).catch(() => {});
      }
    } catch {
      // Unreadable -> live. The marker gate above still stands on its own.
    }
  }

  // W9: THE RECONCILED PROMISE, NOT THE ROW'S STAMP.
  //
  // This read `ctx.rfq` - the raw anchor - while the wakeup/tick entry read
  // `resolved.rfq`, the promise-reconciled value. Same thread, same shop, two
  // durations: a scheduled follow-up said 3 days and the shop's own reply said
  // 1. It flows straight into turnInput.rfq -> SPTE's session -> the duration
  // rail, which then "corrected" a right draft into the wrong number. The
  // resolver no longer lets the two disagree (ctx.rfq === resolved.rfq by
  // construction); reading it from `resolved` here says so out loud.
  const rfq = resolved.rfq as StructuredRFQ; // non-null: guarded at the top
  const round = Number(ctx.round ?? 0);

  // A reply arrived: build the sender's trust score (anti-ban engagement).
  if (ctx.sender) await recordInboundEngagement(ctx.sender, from);

  // Read the recent thread so the agent has real memory - SCOPED AT THE DB so a
  // co-user's chat with the SAME shop number can never (a) leak into this
  // context or (b) evict this user's rows out of a shared limit window (the
  // old fetch-ALL-then-filter with limit=20 let a busy co-user starve this
  // user's memory and re-trigger ask-once). Two receiver/sender-scoped reads,
  // merged. Fail CLOSED: with no receiver scope we cannot build a cross-user-
  // safe history, so we use none rather than the unfiltered set.
  let mine: ThreadMsg[] = [];
  if (opts.senderEmail) {
    const encMe = encodeURIComponent(opts.senderEmail);
    // Cut at the search boundary: one search, one memory. (No marker = no
    // previous search = unbounded, exactly as before.)
    const sinceBound = sessionBoundaryAt
      ? `&received_at=gt.${encodeURIComponent(sessionBoundaryAt)}`
      : "";
    const [outRows, inRows] = await Promise.all([
      sbSelect<ThreadMsg>(
        "whatsapp_messages",
        `select=direction,body,raw,received_at&direction=eq.outbound&raw->>sender=eq.${encMe}${sinceBound}&order=received_at.desc&limit=24${numberFilter(
          "to_number",
          from
        )}`
      ),
      sbSelect<ThreadMsg>(
        "whatsapp_messages",
        `select=direction,body,raw,received_at,wa_message_id&direction=eq.inbound&raw->>receiver=eq.${encMe}${sinceBound}&order=received_at.desc&limit=24${numberFilter(
          "from_number",
          from
        )}`
      ),
    ]);
    mine = [...outRows, ...inRows].sort(
      (a, b) => Date.parse(b.received_at) - Date.parse(a.received_at)
    );
  }
  const thread = mine.slice(0, 12).reverse();
  // The HISTORY window is wider than the working `thread` slice (counters and
  // coalescing keep their 12-row behavior): char-budgeted, head-preserved,
  // voice transcripts inlined - see wa/history-window.ts (owner report 4).
  const { buildHistoryWindow } = await import("./wa/history-window");
  const history = buildHistoryWindow(mine.slice(0, 40).reverse());
  // MULTI-MESSAGE COALESCING (critical data-loss fix): a shop often sends a
  // burst of separate messages - "Good day!" / "We have available Fazzio" /
  // "Regular rate is 550, we can give you 400 per day" - each arriving as its
  // OWN webhook. Extracting from the single triggering frame binds a bare price
  // to no vehicle (matchesSpec=false -> the offer is dropped, UI stuck on "No
  // price yet"). Instead, extract from the WHOLE unread inbound buffer since our
  // last outbound, chronologically, so one read sees the vehicle AND its price.
  const { coalesceUnreadInbound } = await import("./wa/coalesce");
  const extractText = coalesceUnreadInbound(thread, priorAt ?? "", text) || text;
  // PENDING REPLIES COUNT TOO. A reply parked in wa_outbox with a human
  // "thinking" delay is NOT yet in whatsapp_messages. Without counting it, a
  // SECOND shop message arriving inside that 45-240s window reads the counters
  // as zero and queues ANOTHER bargain/clarify - the exact double-ask this
  // discipline exists to prevent. Include the pending outbox for this thread.
  const pendingOutbox = ctx.sender
    ? await sbSelect<{ meta: { kind?: string } | null }>(
        "wa_outbox",
        `select=meta&sender_key=eq.${encodeURIComponent(ctx.sender)}&limit=20${numberFilter(
          "to_number",
          from
        )}`
      ).catch(() => [])
    : [];
  const pendingKind = (k: string) =>
    pendingOutbox.filter((r) => r.meta?.kind === k).length;

  const autoClarifies =
    thread.filter((m) => m.direction === "outbound" && m.raw?.kind === "auto-clarify").length +
    pendingKind("auto-clarify");
  // COUNT EVERY BARGAIN, including the ones the USER tapped from the app
  // (kind "bargain"). Counting only auto-bargains made the loop push a SECOND
  // ask after a user-initiated one - the "asked twice after the shop said no"
  // bug. One ask per shop means one ask, whoever triggered it.
  const autoBargains =
    thread.filter(
      (m) =>
        m.direction === "outbound" &&
        // SPTE stamps the semantic move in raw.move; the legacy paths use
        // raw.kind. Count BOTH so a thread whose sends were mis-stamped "reply"
        // (the round-cap-never-binds bug) still heals its round counter.
        (m.raw?.kind === "auto-bargain" ||
          m.raw?.kind === "bargain" ||
          (m.raw as { move?: string } | null)?.move === "bargain")
    ).length +
    pendingKind("auto-bargain") +
    pendingKind("bargain");
  const autoAnswers =
    thread.filter((m) => m.direction === "outbound" && m.raw?.kind === "auto-answer").length +
    pendingKind("auto-answer");
  const autoCloses =
    thread.filter((m) => m.direction === "outbound" && m.raw?.kind === "auto-close").length +
    pendingKind("auto-close");

  // Funnel-gap detector: shops that dodge with "come to the shop and we'll
  // talk" / "depends" answers are logged as an owner signal, so real gaps can
  // be turned into new branching rules in the decision graph (Admin -> Agents).
  const vague =
    /\b(come (to|by|visit)|visit (us|our shop|the shop)|see for yourself|talk (at|in) the shop|depends|not sure|we'?ll see|call us|stop by)\b/i.test(
      text
    );
  if (vague) {
    sbInsert("agent_events", [
      {
        kind: "vague-reply",
        vendor_id: ctx.vendorId ?? "",
        vendor_name: ctx.vendorName ?? "",
        detail: text.slice(0, 500),
      },
    ]).catch(() => {});
  }

  // INBOUND SAFETY SCREEN - STARTED BEFORE THE EXTRACTION IT USED TO FOLLOW.
  // It is fire-and-forget either way, so it never blocked the turn; but sitting
  // after the extractor meant its own LLM call only BEGAN once the extraction
  // had finished, and the traveller learned a message was dangerous seconds
  // after their agent had already answered it. Nothing here depends on the
  // extraction, so the two run side by side and the warning arrives first.
  // INBOUND SAFETY SCREEN (fire-and-forget): flag risky shop asks - passport
  // photos, off-platform transfers, shady links - for the USER. Never touches
  // what the engine replies.
  //
  // NEVER SELF-FLAG: a message the user wrote themselves (a lost fromMe flag
  // upstream can mislabel it inbound) must not be screened as "the shop's
  // reply" - anything matching our recent outbound to this number is skipped.
  // E1 (owner report 6): the screen is INFORMATIONAL - it warns the traveller
  // and never freezes the engine - yet it sat on the reply's critical path,
  // spending its budget (a DB read, a possible model link-clearing call, a
  // push round trip) BEFORE extraction even started. The one part that must
  // precede composing is the opt-out veto, which is a regex: it stays here,
  // costing nothing on ordinary messages. Everything else is ARMED here and
  // run by the enclosing function's finally, whichever way the turn ends.
  if (ctx.sender && text) {
    try {
      const { detectOptOutIntent } = await import("./inbound-risk");
      if (detectOptOutIntent(text)) {
        const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const ours = await sbSelect<{ body: string }>(
          "whatsapp_messages",
          `select=body&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
            ctx.sender
          )}&received_at=gte.${encodeURIComponent(
            new Date(Date.now() - 24 * 3600_000).toISOString()
          )}&order=received_at.desc&limit=30${numberFilter("to_number", from)}`
        ).catch(() => [] as { body: string }[]);
        if (!ours.some((o) => norm(o.body || "") === norm(text))) {
          const { markRecipientOptedOut } = await import("./wa-guard");
          await markRecipientOptedOut(ctx.sender, from, ctx.vendorName ?? undefined).catch(() => {});
        }
      }
    } catch {
      /* the full screen below still runs post-turn */
    }
    riskScreenDeferred = async () => {
      try {
        const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const ours = await sbSelect<{ body: string }>(
          "whatsapp_messages",
          `select=body&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
            ctx.sender!
          )}&received_at=gte.${encodeURIComponent(
            new Date(Date.now() - 24 * 3600_000).toISOString()
          )}&order=received_at.desc&limit=30${numberFilter("to_number", from)}`
        ).catch(() => [] as { body: string }[]);
        if (ours.some((o) => norm(o.body || "") === norm(text))) return;
        const { screenInbound } = await import("./inbound-risk");
        const verdict = await screenInbound(text, { vendorName: ctx.vendorName ?? undefined });
        // "Stop messaging me" is honored BEFORE the risk-none return - an
        // opt-out is not a risk, so it must not depend on one. The stamp is
        // what makes guardOutbound's permanent veto fire; the self-flag skip
        // above already protects it from the user's own mislabeled text.
        if (verdict.optOut) {
          const { markRecipientOptedOut } = await import("./wa-guard");
          await markRecipientOptedOut(ctx.sender!, from, ctx.vendorName ?? undefined).catch(() => {});
        }
        if (verdict.risk === "none") return;
        // user_email column = EXACT ownership scoping for the risk feed (the
        // old detail LIKE *email* filter leaked alerts across users whose
        // emails were substrings). Retry without the column pre-migration.
        const riskRow = {
          kind: "inbound-risk",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          detail: JSON.stringify({
            email: ctx.sender,
            risk: verdict.risk,
            reasons: verdict.reasons,
            excerpt: text.slice(0, 200),
          }),
        };
        const stamped = await sbInsert("agent_events", [
          { ...riskRow, user_email: ctx.sender ?? null },
        ]);
        if (!stamped) await sbInsert("agent_events", [riskRow]);
        // THROUGH THE GATE, like everything else. A risk always passes it -
        // it is a handover, not news, and is deliberately exempt from the
        // budget - but it must go through the ONE door so it is recorded, and
        // so the ceiling counts what actually reached the phone. This site
        // bypassed both and never called markPushSent, which is what made the
        // 4-per-hour limit advisory rather than real.
        const { worthAnInterruption } = await import("./notify/significance");
        const { notifyState, markPushSent } = await import("./notify/state");
        const pushState = await notifyState(ctx.sender!);
        const gate = worthAnInterruption({ kind: "risk" }, pushState);
        if (!gate.notify) return;
        const { sendPushToUser } = await import("./push");
        await sendPushToUser(ctx.sender!, {
          title: verdict.risk === "high" ? "⚠️ Check this reply" : "Heads up on a reply",
          body: `${ctx.vendorName || "A shop"}: ${verdict.reasons[0] ?? "review this message before acting"}`,
          url: ctx.vendorId ? `/?shop=${encodeURIComponent(ctx.vendorId)}` : "/",
          // ITS OWN LANE. A safety warning must never be collapsed away by an
          // ordinary reply push (the shared default tag did exactly that), and
          // it must not silently replace one either.
          tag: `risk:${from}`,
        });
        await markPushSent(ctx.sender!, `risk: ${gate.reason}`);
      } catch {
        /* screening is best-effort */
      }
    };
  }

  const extraction =
    opts.preExtracted ??
    (await extractOffer(
      rfq,
      extractText || "(the shop sent a price-list photo)",
      images,
      history,
      ctx.region || undefined
    ));
  // NOTE: evaluated lazily (a getter-style function, not a const) because the
  // vehicle gate + thread-confirmation blocks below may still upgrade or
  // downgrade the extraction. VERIFIED now also requires the VEHICLE to be
  // established: with unconfirmed prices becoming real (unverified) offers,
  // a high-confidence read alone must not wear the green badge.
  const isVerified = () =>
    Boolean(
      extraction.found &&
        extraction.matchesSpec &&
        extraction.confidence === "high" &&
        (!extraction.vehicleAssessment || extraction.vehicleAssessment.status === "confirmed")
    );
  // After we've clarified once, a found price counts even if not fully
  // verified - the human can see it; the agent must not nag the shop again.
  let usablePrice =
    extraction.found && extraction.pricePerDay
      ? extraction.pricePerDay
      : undefined;
  /** The span `usablePrice` was DERIVED over, when it was derived at all (a
   *  package total divided out). Undefined = the shop stated a per-day rate.
   *  Filled by the menu block below and written onto the offers row. */
  let priceBasisDays: number | undefined;

  // THE LOCAL CURRENCY OF RECORD, resolved ONCE and NEVER defaulted to USD here.
  // The old chain read `currencyForRegion(ctx.region)`, a free-text regex that
  // returns undefined for a region with no country token ("Ao Nang", "Krabi"),
  // and every site then fell back to USD - so a +66 shop's bare "250 per day"
  // was stored as $250/day, the trust-killer the owner reported. The shop's
  // phone prefix is a far more reliable signal and it was never consulted:
  // resolve region -> shop-prefix country, and only leave it undefined (not USD)
  // when truly nothing is known.
  const { countryForShop: _countryForShop } = await import("./copy/region");
  const localCur =
    currencyForRegion(ctx.region || undefined) ??
    currencyForRegion(_countryForShop(from) || undefined);

  // DETERMINISTIC BACKSTOP (the "3 of 4 offers vanished" fix): the LLM
  // extractor can miss/fail (quota, odd phrasing) - but a price a human can
  // read in the text must NEVER be dropped. extractRentalDailyPrice reads the
  // reply line-by-line (monthly/weekly totals, k-notation, bare-number answers)
  // and rescues the quote; a wrong-vehicle line (classMatch=false) is never
  // rescued into the requested vehicle's offer.
  if (!usablePrice && extractText) {
    const { extractRentalDailyPrice } = await import("./wa/price-extract");
    const det = extractRentalDailyPrice(extractText, {
      vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
      durationDays: rfq.durationDays,
      localCurrency: localCur ?? undefined,
      engineSizeCc: rfq.engineSizeCc,
    });
    if (det && det.classMatch !== false) {
      usablePrice = det.pricePerDay;
      extraction.found = true;
      extraction.pricePerDay = det.pricePerDay;
      if (!extraction.currency && det.currency) extraction.currency = det.currency;
      // A deterministic rescue is honest but not "high" confidence.
      if (extraction.confidence !== "high") extraction.confidence = "medium";
    }
  }

  // ===== TWO ENGINES, ONE TRUTH (reconciliation) ============================
  //
  // The LLM extractor and the deterministic reader used to run in SEQUENCE -
  // deterministic only on an LLM miss - so an LLM MISREAD was never
  // cross-checked. Thailand: "6 days 180 per day" divided by the model into
  // ฿30/day while the deterministic reader had the correct 180 all along, and
  // "1100b./6days" vanished entirely when the model missed and the (then
  // token-blind) reader had no net. Now every LLM price is reconciled against
  // the deterministic read: algebra decides the clear cases (a division
  // artifact reconstructs the other engine's number), and a genuine semantic
  // disagreement goes to ONE structured arbiter call - the LLM owns semantics,
  // the algebra owns arithmetic, neither is trusted alone.
  if (usablePrice && extractText) {
    try {
      const { extractRentalDailyPrice } = await import("./wa/price-extract");
      const det = extractRentalDailyPrice(extractText, {
        vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
        durationDays: rfq.durationDays,
        localCurrency: localCur ?? undefined,
        engineSizeCc: rfq.engineSizeCc,
      });
      const dur = rfq.durationDays;
      const close = (a: number, b: number) => b > 0 && Math.abs(a - b) / b <= 0.1;
      if (det && det.classMatch !== false && det.pricePerDay > 0 && det.pricePerDay !== usablePrice) {
        const adopt = async (why: string) => {
          await sbInsert("agent_events", [
            {
              kind: "price-reconciled",
              vendor_id: ctx.vendorId ?? "",
              vendor_name: ctx.vendorName ?? "",
              user_email: ctx.sender ?? "",
              detail: `${why}: LLM read ${usablePrice}, deterministic read ${det.pricePerDay} - using ${det.pricePerDay}. "${(extractText ?? "").slice(0, 160)}"`,
            },
          ]).catch(() => {});
          usablePrice = det.pricePerDay;
          extraction.pricePerDay = det.pricePerDay;
          if (det.currency) extraction.currency = det.currency;
          if (extraction.confidence === "high") extraction.confidence = "medium";
        };
        if (dur > 1 && close(usablePrice * dur, det.pricePerDay)) {
          // The model divided a number the shop stated whole/per-day.
          await adopt("misdivision (LLM = deterministic / days)");
        } else if (dur > 1 && close(det.pricePerDay * dur, usablePrice)) {
          // The model took the whole-rental total at face value; the reader
          // saw the denominator and divided it.
          await adopt("total taken as daily (deterministic = LLM / days)");
        } else if (Math.abs(det.pricePerDay - usablePrice) / usablePrice > 0.25) {
          // Semantic disagreement - ask once, with the full context.
          const { arbitratePriceBasis } = await import("./agents");
          const llmBefore = usablePrice;
          const pick = await arbitratePriceBasis({
            message: extractText,
            durationDays: dur,
            candidateA: llmBefore,
            candidateB: det.pricePerDay,
          }).catch(() => null);
          if (pick !== null && close(pick, det.pricePerDay)) {
            await adopt("arbiter sided with the deterministic read");
          } else if (pick !== null && !close(pick, llmBefore)) {
            // The arbiter named a third number - never adopt an un-grounded
            // amount; keep the LLM read and record the disagreement.
            await sbInsert("agent_events", [
              {
                kind: "price-arbiter-odd",
                vendor_id: ctx.vendorId ?? "",
                vendor_name: ctx.vendorName ?? "",
                user_email: ctx.sender ?? "",
                detail: `Arbiter said ${pick}; candidates were ${llmBefore} (LLM) and ${det.pricePerDay} (det). Kept ${llmBefore}.`,
              },
            ]).catch(() => {});
          }
        }
      }
    } catch {
      /* reconciliation is a net - its failure must never drop a reply */
    }
  }

  // DURATION-LADDER OVERRIDE. A price board is not a list of numbers to choose
  // from - each row is the rate you earn by staying that long. The vision half
  // has no way to know that, and on 26 Jul it quoted a five-day traveller the
  // 15-29 day rate off a board it had also read the wrong vehicle from. The
  // ladder is fully determined by the text, so code decides it, not the model:
  // whichever row COVERS the traveller's dates is the price, full stop.
  if (extractText) {
    const { ladderRateFor } = await import("./wa/rate-ladder");
    const board = ladderRateFor(extractText, rfq.durationDays, {
      localCurrency: localCur ?? undefined,
    });
    if (board && board.pricePerDay > 0) {
      usablePrice = board.pricePerDay;
      extraction.found = true;
      extraction.pricePerDay = board.pricePerDay;
      if (board.tier.currency) extraction.currency = board.tier.currency;
      // The board states its own terms - reading a row off it is a fact, not a
      // guess, so it may confirm but never downgrade a verified read.
      if (extraction.confidence !== "high") extraction.confidence = "medium";
    }
  }

  // ===== VEHICLE IDENTITY GATE ============================================
  //
  // The single choke point where "is this price even for their vehicle?" is
  // decided, for both engines and for every surface downstream.
  //
  // Two live threads reached the traveller's screen as "BEST PRICE ₱400" for a
  // 110cc when they had declared a 125:
  //
  //   "for the Honda beat sir 400 pesos sir for the honda click 125 500 pesos"
  //   "I already gave 500 for you. If you want 110cc 400 per day"
  //
  // Neither was a parsing failure. There was no concept of a price BELONGING to
  // a vehicle, so the cheapest number won and an unnamed vehicle defaulted to
  // "must be theirs". src/lib/vehicle owns that concept now: it pairs every
  // quote with the vehicle beside it, resolves that vehicle's attributes from
  // what the shop stated and what the catalogue knows, and returns one of three
  // states. Only `confirmed` may become an offer - `needs-confirmation` becomes
  // a question the agent has to ask first, and it cannot be skipped.
  const declared = {
    class: rfq.vehicleClass === "car" ? ("car" as const) : (rfq.vehicleClass as "scooter" | "motorbike"),
    displacementCc: rfq.engineSizeCc,
    transmission: rfq.transmission === "any" ? undefined : rfq.transmission,
    seats: rfq.seats,
  };
  if (extractText && usablePrice) {
    const { assessPrice } = await import("./vehicle/resolution");
    const { pickOurPrice } = await import("./vehicle/resolution");
    const { extractQuotedPrices } = await import("./wa/price-extract");
    const { amountIndexIn } = await import("./wa/rate-expr");

    // Every amount the shop wrote, each with WHERE it sits - the position is
    // what lets one sentence carrying two vehicles be read as two offers.
    const quoted = extractQuotedPrices(extractText, {
      vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
      durationDays: rfq.durationDays,
      localCurrency: localCur ?? undefined,
      engineSizeCc: rfq.engineSizeCc,
    });
    const candidates = quoted.allOffers.map((h) => ({
      pricePerDay: h.pricePerDay,
      currency: h.currency,
      index: amountIndexIn(extractText, h.pricePerDay),
    }));
    // The price the model chose is a candidate like any other, judged the same.
    if (!candidates.some((c) => c.pricePerDay === usablePrice)) {
      candidates.push({
        pricePerDay: usablePrice,
        currency: extraction.currency ?? undefined,
        index: amountIndexIn(extractText, usablePrice),
      });
    }

    const ours = candidates.length > 1 ? pickOurPrice(extractText, declared, candidates) : null;
    if (ours && ours.price !== usablePrice) {
      // A different amount in the same reply is the one that belongs to the
      // traveller's vehicle. This is the Joh's Matics correction: 500, not 400.
      usablePrice = ours.price;
      extraction.pricePerDay = ours.price;
      if (ours.currency) extraction.currency = ours.currency;
    }

    const assessment = assessPrice(extractText, declared, {
      pricePerDay: usablePrice,
      currency: extraction.currency ?? undefined,
      index: amountIndexIn(extractText, usablePrice),
    });
    extraction.vehicleAssessment = {
      status: assessment.status,
      reason: assessment.judgement.reason,
      question: assessment.question,
      travellerNote: assessment.travellerNote,
      missing: assessment.missing,
      model: assessment.judgement.identity.model?.name,
    };
    // THE OVERRIDE. The catalogue outranks the model's opinion about what a
    // nameplate is: a BeAT is 110cc whether or not the extractor noticed.
    if (assessment.status === "wrong-vehicle") {
      extraction.vehicleVerdict = "mismatch";
      extraction.matchesSpec = false;
    } else if (assessment.status === "needs-confirmation") {
      extraction.vehicleVerdict = "unclear";
      // NOT forced to matchesSpec=false anymore. "Unresolved" starved every
      // downstream surface at once in the field: no offers row, no BEST PRICE,
      // no rival for the leverage engine, a card frozen on the old quote. An
      // unconfirmed price is now an UNVERIFIED offer, and the thread-level
      // resolution below is what retires the question.
    }
  }

  // ===== THREAD-LEVEL VEHICLE CONFIRMATION =================================
  //
  // The assessment above judges THIS message in isolation - and a shop that
  // answers our question about a 125cc automatic with "6 days 180 per day"
  // proves nothing to it, forever. The conversation proves it: our own
  // outbound named the vehicle, the shop answered it directly. That fact is
  // durable (negotiation_threads.fields.vehicleConfirmation, persisted by
  // applyExtractionToState), never regresses, and retires the confirm
  // question after ONE ask.
  if (extractText && ctx.sender) {
    try {
      const { resolveConfirmation } = await import("./vehicle/confirmation");
      const { loadThreadState, threadKeyFor } = await import("./graph/state");
      const prevState = await loadThreadState(threadKeyFor(ctx.sender, from)).catch(() => null);
      const prevConf = (prevState?.fields as {
        vehicleConfirmation?: import("./vehicle/confirmation").VehicleConfirmationState;
      } | null)?.vehicleConfirmation;
      // `raw` as well as `body`: the MOVE we chose when we sent that message is
      // already recorded there. The confirmation resolver used to re-derive
      // "did we ask?" by regex over `body` - our own LLM-composed prose, in a
      // randomized template family with no rail constraining its shape for this
      // move. When the phrasing missed the pattern, the ask-once latch never
      // set and the engine asked the same question again, which is exactly what
      // the owner watched happen after the shop had answered "Click 125 cc yes".
      const lastOut = await sbSelect<{ body: string; raw: { move?: string } | null }>(
        "whatsapp_messages",
        `select=body,raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
          ctx.sender
        )}&order=received_at.desc&limit=1${numberFilter("to_number", from)}`
      ).catch(() => [] as { body: string; raw: { move?: string } | null }[]);
      const conf = resolveConfirmation(prevConf, {
        declared,
        inboundText: extractText,
        lastOutboundText: lastOut[0]?.body ?? "",
        lastOutboundMove: lastOut[0]?.raw?.move ?? null,
        messageStatus: extraction.vehicleAssessment?.status ?? null,
        hasPrice: Boolean(usablePrice),
      });
      extraction.vehicleConfirmation = conf;
      // W-15: AND WRITE IT DOWN. `prev` above comes out of
      // negotiation_threads.fields.vehicleConfirmation, whose only writer was
      // applyExtractionToState - reached solely from the graph engine, which
      // the SPTE route makes unreachable on an ordinary turn. So `prev` was
      // null every single turn and the ask-once latch survived only while the
      // confirm question was still our most recent outbound. One bargain later
      // the thread had forgotten, `vehicleAsked` read false, and the engine
      // asked a question the shop had already answered.
      //
      // Persisted HERE, next to where it is resolved, so it holds whichever
      // engine then runs. Never blocks the turn: a thread that cannot write its
      // memory must still get a reply.
      const { saveVehicleConfirmation } = await import("./graph/state");
      await saveVehicleConfirmation(
        {
          threadKey: threadKeyFor(ctx.sender, from),
          userEmail: ctx.sender,
          vendorId: ctx.vendorId,
          vendorName: ctx.vendorName,
          toNumber: from,
        },
        conf
      ).catch(() => {});
      // A confirmed THREAD upgrades this message's verdict: the price on the
      // table belongs to the vehicle the conversation already established, so
      // no surface may keep asking and no offer stays "unverified".
      if (conf.status === "confirmed" && extraction.vehicleAssessment?.status === "needs-confirmation") {
        extraction.vehicleAssessment = {
          ...extraction.vehicleAssessment,
          status: "confirmed",
          question: "",
          travellerNote: "",
          reason: conf.evidence,
        };
        extraction.vehicleVerdict = undefined;
      }
      // OUT OF STOCK IS A STATE, resolved from the same conversation and made
      // durable the same way. "Now I don't have bike." used to match nothing
      // anywhere: no claim, no state, no card - so the agent kept haggling
      // over a scooter that did not exist and the traveller kept waiting for a
      // price. A later "we have one now" flips it back with no special case,
      // because it is read from the shop's LAST availability claim.
      const { buildLedger, stockState } = await import("./thread/ledger");
      const stock = stockState(
        buildLedger({
          inbound: thread
            .filter((m) => m.direction === "inbound")
            .map((m) => m.body ?? "")
            .filter(Boolean),
          outbound: thread
            .filter((m) => m.direction === "outbound")
            .map((m) => m.body ?? "")
            .filter(Boolean),
          currentInbound: extractText,
        })
      );
      extraction.shopUnavailable = stock.state === "out-of-stock";
      extraction.restockHint = stock.restockHint;
    } catch {
      /* confirmation is an upgrade - its failure must never drop a reply */
    }
  }

  // CURRENCY TRUTH. A currency other than the shop's own is honoured only when
  // the shop actually typed it - a photo-only reply or a mis-read token can
  // never turn a Thai quote into ringgit ("RM 300/day" on a Krabi thread).
  const { reconcileCurrency } = await import("./wa/price-extract");
  // Resolve against the shop-prefix-aware localCur, not the region alone. USD
  // is only the ABSOLUTE last resort - when the region, the shop's prefix and
  // the reply all fail to name a currency - so a Thai shop's bare number is
  // stored as THB, not dollars.
  const cur = reconcileCurrency(extraction.currency, localCur, extractText || "") || localCur || "USD";

  // THE SHOP'S MENU. A reply naming more than one price is a CHOICE, not a
  // quote: "some models 200 and some new 250/day". Collapsing that to one number
  // is what hid the 200 tier from the traveller and left the agent haggling a
  // price nobody had picked. Derived deterministically from the same reader that
  // produced the price, then merged with anything the model itself listed.
  {
    const { extractQuotedPrices } = await import("./wa/price-extract");
    const { optionsFromHits, mergeOptions, sectionHeaders } = await import("./offer-options");
    const quoted = extractQuotedPrices(extractText || "", {
      vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
      durationDays: rfq.durationDays,
      localCurrency: cur,
      engineSizeCc: rfq.engineSizeCc,
    });
    const derived = optionsFromHits(quoted.allOffers, {
      depositNote: extraction.deposit || undefined,
      source: images.length > 0 ? "photo" : "text",
      // The traveller's declared vehicle scopes the menu, and a board's heading
      // is where its vehicle is written - without both, a 155cc board's rows
      // all read as offers to someone who asked for 125cc.
      spec: {
        vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
        engineSizeCc: rfq.engineSizeCc,
        transmission: rfq.transmission,
      },
      headers: sectionHeaders(extractText || ""),
    });
    const fromModel = Array.isArray(extraction.options) ? extraction.options : [];
    const options = mergeOptions(fromModel, derived);
    if (options.length >= 2) extraction.options = options;

    // WAS THIS PER-DAY QUOTED, OR DID WE DIVIDE IT OUT? (owner report 5 #2)
    //
    // "500 for 3 days" gives 167/day, and until now nothing recorded that no
    // shop ever said 167. That figure then reached another shop as a rival's
    // daily price for a ONE-day rental, with our duration welded on - the
    // "167 บาท/วัน สำหรับ 1 วัน" screenshot. The reader knows the span it
    // divided by; this is where that fact is carried out of the reader and
    // into the offers row, so the rival predicate can refuse a package price
    // as like-for-like and every prompt can phrase it honestly.
    priceBasisDays = quoted.allOffers.find((h) => h.pricePerDay === usablePrice)?.derivedFromDays;
  }

  // TOTAL vs PER-DAY sanity net. Shops constantly quote the WHOLE rental
  // ("3 day 900 B" = 900 TOTAL = 300/day) and a mis-read here made the agent
  // "bargain" for MORE than the shop's real daily price - the worst possible
  // move. If the number is wildly above the area's typical daily price but
  // divides into a plausible daily price over the rental length, it was a
  // total: divide it. (The extraction prompt now rules this too; this is the
  // arithmetic backstop for when the model slips.)
  const floor = await floorPriceFor(ctx.region || undefined, rfq);
  let floorSameCur = floor && floor.currency === cur ? floor : null;
  if (usablePrice && rfq.durationDays > 1 && floorSameCur) {
    const typical = floorSameCur.typical ?? Math.round(floorSameCur.floor * 1.6);
    const perDayIfTotal = Math.round(usablePrice / rfq.durationDays);
    if (usablePrice >= typical * 2 && perDayIfTotal >= floorSameCur.floor * 0.55) {
      usablePrice = perDayIfTotal;
    }
  }
  // ...AND THE SAME NET ON THE OTHER SIDE. A number far BELOW the regional
  // floor is not a bargain, it is a misread - "Click 125cc 6 days discount
  // 250/1day" reached a traveller's card as ฿1/day. wa/rate-expr stops that
  // phrasing at the source; this stops the CLASS, because the next phrasing
  // will be different. A misread almost always sits beside the real number, so
  // the recovery is the cheapest believable amount from the SAME message, and
  // failing that, no price at all - which makes the agent ask instead of
  // bargaining up from something the shop never said.
  if (usablePrice && floorSameCur) {
    const { sanePrice } = await import("./wa/price-sanity");
    const { extractQuotedPrices } = await import("./wa/price-extract");
    const others = extractQuotedPrices(extractText || "", {
      vehicleClass: rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass,
      durationDays: rfq.durationDays,
      localCurrency: cur,
      engineSizeCc: rfq.engineSizeCc,
    }).allOffers.map((h) => h.pricePerDay);
    const verdict = sanePrice(usablePrice, others, floorSameCur, {
      durationDays: rfq.durationDays,
    });
    if (verdict.corrected) {
      await sbInsert("agent_events", [
        {
          kind: "price-implausible",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          user_email: ctx.sender ?? "",
          detail: `${verdict.reason ?? ""} (${cur}, ${ctx.region ?? "?"})`.slice(0, 500),
        },
      ]).catch(() => {});
      // THE NET MUST NOT REWRITE THE READING INTO A LIE (owner report 5, #4).
      //
      // This ran ~400 lines BEFORE readingFrom, and on an implausible read it
      // nulled pricePerDay, flipped found=false and forced confidence="low" by
      // direct mutation - so a photo the model had read perfectly produced the
      // byte-identical "We could not read anything usable from this one.
      // CONFIDENCE: LOW" panel as a genuinely blank picture. The negotiation
      // still refuses to quote the number (found=false is what keeps the agent
      // from bargaining off a misread); what changes is that the READING keeps
      // the number and says out loud that it was seen and rejected.
      const rejected = typeof extraction.pricePerDay === "number" ? extraction.pricePerDay : undefined;
      usablePrice = verdict.pricePerDay ?? undefined;
      extraction.pricePerDay = verdict.pricePerDay ?? undefined;
      if (!verdict.pricePerDay) {
        extraction.found = false;
        // `confidence` stays "low" for the ENGINE (a rejected read is not a
        // confident one) - the panel no longer renders a confidence at all on a
        // failure outcome, so it can no longer be read as a claim about the
        // photo (readingIsFailure, media/reading.ts).
        extraction.confidence = "low";
        if (images.length > 0 || extraction.imageRead) {
          extraction.imageRead = {
            ...(extraction.imageRead ?? { seen: true }),
            modelFailure: "sanity-nulled",
            rejectedPricePerDay: rejected,
            rejectedCurrency: cur,
          };
        }
      }
    }
  }
  // UNGROUNDED-PRICE RAIL (owner problem #4: hallucinated prices on automated /
  // no-price template replies). The model can return found=true with a number
  // that appears NOWHERE - not in the shop's message, not as a total, not in a
  // photo, and not as a number we proposed and the shop agreed to. There is no
  // honest source for such a price, so we must never show it: prefer "unknown"
  // over inventing information. Deliberately conservative - it only fires when
  // the price is groundless on EVERY source, so a real quote is never dropped:
  //   - a photo/board was read      -> the price can come from the image
  //   - the price is DERIVED        -> the total is in the text (priceBasisDays)
  //   - the number (or number x days) is verbatim in the shop's reply
  //   - the number is in the recent conversation (a proposal the shop agreed to)
  if (usablePrice && extractText && images.length === 0 && priceBasisDays === undefined) {
    const { isPriceGrounded } = await import("./wa/price-grounding");
    if (!isPriceGrounded(usablePrice, rfq.durationDays, [extractText, history])) {
      await sbInsert("agent_events", [
        {
          kind: "price-ungrounded",
          user_email: ctx.sender ?? null,
          to_number: from,
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          detail: `Model read ${usablePrice} ${extraction.currency ?? "?"} but it is nowhere in the reply, no photo, no agreement - dropped rather than shown. "${(extractText ?? "").slice(0, 160)}"`,
        },
      ]).catch(() => {});
      usablePrice = undefined;
      extraction.found = false;
      extraction.pricePerDay = undefined;
    }
  }
  // CREDIBILITY CLAMP (the Bargained-0 kill): a "floor" at/above the shop's
  // own live quote is bad data, not a reason to go mute - it used to flip
  // priceAtOrBelowFloor true and make the bargain edge illegal for EVERY shop
  // in the region (PH seed 350 vs live 300 quotes). Clamp below the quote so
  // the engine always has room to counter, and record the suspect data point.
  if (usablePrice && floorSameCur) {
    const credible = credibleFloor(floorSameCur.floor, usablePrice);
    if (credible.clamped && credible.floor) {
      await sbInsert("agent_events", [
        {
          kind: "suspect-floor",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          detail: `Market floor ${floorSameCur.floor} ${cur} >= live quote ${usablePrice} ${cur} (${ctx.region ?? "?"}) - clamped to ${credible.floor} so bargaining stays possible. Fix the floor data.`,
        },
      ]).catch(() => {});
      floorSameCur = { ...floorSameCur, floor: credible.floor };
    }
  }
  // DID WE READ THEIR PRICE BOARD RIGHT? Most shops answer with a photo, and
  // until now nothing ever checked the OCR - so the agent asked shops to retype
  // boards it had already read, and a misread number could be bargained from
  // for the rest of the thread. When a TYPED price lands on a thread where we
  // previously read a price off a photo, the two get compared and the verdict
  // is recorded. This is the source for the visionAccuracy KPI.
  if (images.length === 0 && usablePrice && ctx.vendorId && ctx.sender) {
    try {
      const prior = await sbSelect<{ price_per_day: number | null }>(
        "vendor_replies",
        `select=price_per_day&user_email=eq.${encodeURIComponent(
          ctx.sender
        )}&vendor_id=eq.${encodeURIComponent(
          ctx.vendorId
        )}&image_count=gt.0&price_per_day=not.is.null&order=created_at.desc&limit=1`
      );
      const sheet = prior[0]?.price_per_day ?? undefined;
      if (typeof sheet === "number" && sheet > 0) {
        const { reconcileVisionPrice } = await import("./vision-reconcile");
        const verdict = reconcileVisionPrice({
          sheetPricePerDay: sheet,
          textPricePerDay: usablePrice,
          durationDays: rfq.durationDays,
        });
        await sbInsert("agent_events", [
          {
            kind: "vision-check",
            vendor_id: ctx.vendorId,
            vendor_name: ctx.vendorName ?? "",
            user_email: ctx.sender,
            // vendor_name here is the shop's NAME, which the message-path
            // panel cannot join on - without to_number every vision row was
            // written for a screen that could never find it.
            to_number: from,
            detail: JSON.stringify({
              agreement: verdict.agreement,
              sheet,
              text: usablePrice,
              deltaPct: verdict.deltaPct ?? null,
              note: verdict.detail,
            }).slice(0, 500),
          },
        ]).catch(() => {});
        // FUNNEL LEDGER: a typed price agreeing with the price we read off the
        // shop's own photo is the strongest verification the funnel has.
        if (verdict.agreement === "confirmed" && extraction.matchesSpec !== false) {
          const { advanceThreadStage } = await import("./funnel/stages");
          await advanceThreadStage(
            { userEmail: ctx.sender ?? "", toNumber: from, vendorId: ctx.vendorId, vendorName: ctx.vendorName, transport: "evolution" },
            "price_verified",
            "typed price matches the price sheet photo"
          ).catch(() => {});
        }
      }
    } catch {
      /* the reconciliation is telemetry - it must never break a turn */
    }
  }

  const replyBase = {
    user_email: ctx.sender ?? null,
    vendor_id: ctx.vendorId ?? "",
    vendor_name: ctx.vendorName ?? "",
    reply_text: text.slice(0, 4000),
    image_count: images.length,
    found: extraction.found,
    // The SANITY-CORRECTED per-day price (total quotes divided by days), so the
    // app never shows a 3-day total as a daily rate.
    price_per_day: usablePrice ?? extraction.pricePerDay ?? null,
    matches_spec: extraction.matchesSpec,
    confidence: extraction.confidence,
    auto: true,
  };
  // The shop's own money + confirmed conditions, so the app can show the real
  // local price and honest tags. sbInsert fails SILENTLY on an unknown column,
  // so if the owner has not run the newest schema yet we retry without the new
  // columns - a reply must NEVER vanish from the feed over a pending migration.
  const fullOk = await sbInsert("vendor_replies", [
    {
      ...replyBase,
      currency: cur,
      deposit: extraction.deposit ?? null,
      deposit_type: extraction.depositType ?? null,
      deposit_amount: extraction.depositAmount ?? null,
      deposit_currency: extraction.depositCurrency ?? null,
      delivers: extraction.delivers ?? null,
      insurance_included: extraction.insuranceIncluded ?? null,
      delivery_fee: extraction.deliveryFee ?? null,
    },
  ]);
  // Retry without the newest columns as the schema rolls out (silent-fail).
  if (!fullOk) {
    const okBasic = await sbInsert("vendor_replies", [
      { ...replyBase, currency: cur, deposit: extraction.deposit ?? null, delivers: extraction.delivers ?? null },
    ]);
    if (!okBasic) await sbInsert("vendor_replies", [replyBase]);
  }
  // ---- FUNNEL LEDGER: what this reply proved (src/lib/funnel/stages.ts) ------
  //
  // `replied` was stamped at ingest when the frame was stored; HERE is where the
  // reply becomes understanding, so here is where the ledger learns it. One
  // progression stamp (the highest stage this reply's facts support) plus at
  // most one lateral - each internally deduped, so a repeat costs one select.
  // matchesSpec===false keeps a substitute's price out of price_received for
  // the same reason it never becomes an offers row: the REQUESTED vehicle has
  // no price yet.
  {
    const { advanceThreadStage } = await import("./funnel/stages");
    const stageArgs = {
      userEmail: ctx.sender ?? "",
      toNumber: from,
      vendorId: ctx.vendorId,
      vendorName: ctx.vendorName,
      transport: "evolution",
    };
    // The shop explicitly said the vehicle IS available - the one evidence
    // class allowed to pull a thread back out of out_of_stock.
    const stageOpts = { overridesOutOfStock: extraction.shopUnavailable === false };
    const priced = Boolean(usablePrice) && extraction.matchesSpec !== false;
    const understood =
      priced ||
      extraction.found ||
      (extraction.options?.length ?? 0) > 0 ||
      Boolean(extraction.deposit || extraction.depositType) ||
      extraction.delivers != null ||
      extraction.insuranceIncluded != null ||
      extraction.deliveryFee != null ||
      extraction.pickupOffered != null ||
      extraction.onShopOnly != null ||
      typeof extraction.shopUnavailable === "boolean" ||
      extraction.shopDeclined === true;
    if (priced) {
      await advanceThreadStage(stageArgs, "price_received", "shop quoted a grounded price", stageOpts);
    } else if (understood) {
      await advanceThreadStage(stageArgs, "understood", "reply carried an actionable fact", stageOpts);
    }
    if (extraction.shopDeclined === true) {
      await advanceThreadStage(stageArgs, "declined", "shop walked away");
    } else if (extraction.shopUnavailable === true) {
      await advanceThreadStage(stageArgs, "out_of_stock", "shop said the vehicle is not available");
    }
  }
  // Verified shop tags (item #13): record what this reply explicitly stated.
  // A tag only ever SHOWS after >= 2 distinct replies confirm it.
  if (ctx.vendorId) {
    const { tagsFromExtraction, recordTagSignals } = await import("./vendor-tags");
    await recordTagSignals(
      ctx.vendorId,
      ctx.sender ?? undefined,
      text,
      tagsFromExtraction(extraction, text)
    ).catch(() => {});
  }
  // Only a price for the EXACT requested vehicle becomes an OFFER (best-price
  // card, deals dashboard, market-rate warehouse). A price the shop quoted for a
  // DIFFERENT vehicle (matchesSpec === false - e.g. an e-bike when a 125cc
  // scooter was asked) is NOT the traveller's offer: presenting it as the
  // cheapest/lockable price misleads the user, and filing it under the requested
  // vehicle_key would poison the market rate. It stays in vendor_replies (so the
  // reply is still visible and the agent can clarify), but never an offers row.
  if (usablePrice && extraction.matchesSpec !== false) {
    // Tag the offer with area + vehicle bucket + a delivery signal, so the
    // owner's shop-intelligence warehouse can aggregate real market data.
    const { vehicleKeyFor, regionKeysFor } = await import("./market");
    const regionKey = regionKeysFor(ctx.region || undefined)[0] ?? null;
    const vehicleKey = vehicleKeyFor(rfq);
    // Prefer the AI's explicit read; fall back to a conservative text signal.
    const delivers =
      extraction.delivers ??
      (/\b(deliver|drop off|bring it|to your hotel|free delivery)\b/i.test(text) ? true : null);
    const offerBase = {
      user_email: ctx.sender ?? null,
      vendor_id: ctx.vendorId ?? "",
      vendor_name: ctx.vendorName ?? "",
      price_per_day: usablePrice,
      // The shop's OWN starting price, so the discount we won is measurable.
      // This was set to usablePrice, which made list === paid on every row and
      // pinned the bargain-margin KPI at 0% no matter how well the agent did.
      // The real list price is the restated regular price when the shop gave
      // one, else the priciest tier it offered, else the current price.
      list_price_per_day:
        extraction.listPricePerDay ??
        (extraction.options?.length
          ? Math.max(...extraction.options.map((o) => o.pricePerDay))
          : undefined) ??
        usablePrice,
      currency: cur,
      round,
      simulated: false,
      verified: isVerified(),
      region_key: regionKey,
      vehicle_key: vehicleKey,
      duration_days: rfq.durationDays ?? null,
      delivers,
    };
    // Session attribution for exact rival grouping (analytics + deals).
    let searchId: number | null = null;
    if (ctx.sender) {
      const s = await sbSelect<{ id: number }>(
        "searches",
        `select=id&user_email=eq.${encodeURIComponent(ctx.sender)}&order=created_at.desc&limit=1`
      ).catch(() => []);
      searchId = s[0]?.id ?? null;
    }
    // THE GUARD THAT WAS DECLARED, READ, AND NEVER WRITTEN (owner report 5 #2).
    //
    // `offers.effective_daily_rate` is in the schema and `pickCheapestRival`
    // reads it - `Math.min(effectiveDailyRate, pricePerDay)` is the whole
    // duration-aware half of the rival predicate. Nothing in the repo ever
    // wrote the column, so that min() fell through to the sticker price on
    // every row ever inserted and the guard was inert by construction.
    //
    // What it means here: the honest daily rate FOR THE RENTAL WE ASKED ABOUT.
    // A price the shop stated per day is that rate. A price we divided out of a
    // package is that rate only when the traveller is actually renting long
    // enough to earn the package - a 3-day deal does not apply to a 1-day hire,
    // and 500/3 = 167 is not a number that shop would honour for one day. In
    // that case there is no known effective rate, and null is the honest value:
    // the predicate then falls back to the sticker price, and `quote_basis_days`
    // below tells every reader the figure is package arithmetic.
    const packageApplies =
      priceBasisDays === undefined || priceBasisDays <= (rfq.durationDays ?? 1);
    const provenance = {
      effective_daily_rate: packageApplies ? usablePrice : null,
      quote_basis_days: priceBasisDays ?? null,
    };
    // A SESSION STAMP THAT SURVIVES THE GRACEFUL RETRY.
    //
    // `search_id` lived only on the richest insert attempt, and
    // `pickCheapestRival` REQUIRES `o.searchId === args.searchId` whenever the
    // session id is known. So any row that fell back - one un-migrated column
    // anywhere in the wide insert - was silently excluded from every rival
    // lookup for the rest of the hunt, even minutes old. It belongs in the base
    // row: `search_id` has shipped since the intel migration, and it is the key
    // the whole cross-shop leverage mechanism is scoped by.
    const base = { ...offerBase, search_id: searchId };
    // Retry without the newest columns if the migration has not run yet.
    const offerOk = await sbInsert("offers", [
      {
        ...base,
        ...provenance,
        deposit_note: extraction.deposit ?? null,
        deposit_type: extraction.depositType ?? null,
        deposit_amount: extraction.depositAmount ?? null,
        deposit_currency: extraction.depositCurrency ?? null,
        delivery_fee: extraction.deliveryFee ?? null,
        insurance_included: extraction.insuranceIncluded ?? null,
        km_limit_per_day: extraction.kmLimitPerDay != null ? String(extraction.kmLimitPerDay) : null,
        fuel_policy: extraction.fuelPolicy ?? null,
      },
    ]);
    if (!offerOk) {
      // Step down one column set at a time, keeping the session stamp and the
      // provenance for as long as the schema allows.
      const okDep = await sbInsert("offers", [
        { ...base, ...provenance, deposit_note: extraction.deposit ?? null },
      ]);
      if (!okDep) {
        const okBase = await sbInsert("offers", [base]);
        if (!okBase) await sbInsert("offers", [offerBase]);
      }
    }
    // HOT-STATE WRITE-THROUGH (Module 2): mirror the offer into the Redis
    // session aggregates (lowest-rival ZSET + OFFERS IN / BARGAINED HSET) and
    // publish the delta for the SSE stream. REDIS_URL-gated no-op when unset;
    // never throws; Postgres above remains the source of truth.
    if (searchId != null) {
      const { recordSessionOffer } = await import("./rival-cache");
      await recordSessionOffer({
        searchId,
        vendorId: ctx.vendorId ?? "",
        vehicleKey,
        currency: cur,
        pricePerDay: usablePrice,
        // First write pins the list anchor; later rounds only lower the score.
        listPricePerDay: usablePrice,
        durationDays: rfq.durationDays ?? 1,
      }).catch(() => {});
    }
  }

  // Web Push: alert the traveller a shop replied even if the app is CLOSED, so
  // they can leave the app and come back. Fire-and-forget; no-op without VAPID.
  // COLLAPSED per shop (the duplicate-notification fix): a 3-message burst from
  // one shop = ONE push. A price landing is important and bypasses the collapse.
  //
  // ...AND ONLY WHEN IT IS WORTH THE INTERRUPTION. The collapse window answers
  // "how often"; it cannot answer "whether", and a hunt contacts a dozen shops
  // that mostly answer with an opening-hours auto-reply. Fifteen different
  // shops are fifteen different collapse keys, so the traveller got fifteen
  // buzzes carrying nothing they could act on. lib/notify/significance judges
  // what an event CHANGES for them - a first price, a new best price, the
  // moment the hunt comes alive - and everything else stays in the app, where
  // it is still perfectly visible.
  if (ctx.sender && !sessionClosed) {
    // ^ THE OWNER'S "buzzed hours after the hunt ended" BUG. This push fired
    // ~250 lines BEFORE the session-terminated gate stood the agent down, so
    // a late reply to a dead hunt was silenced in chat and loud on the lock
    // screen. The significance gate now also refuses on `huntLive === false`
    // (belt), but a marker-closed session can still be inside a fresh TTL -
    // this early skip is the half the gate cannot see from liveness alone.
    await finishBeforeResponse("reply-push", async () => {
      try {
        const { classifyReply, worthAnInterruption } = await import("./notify/significance");
        const { notifyState, markPushSent } = await import("./notify/state");
        // WITH THE VENDOR, so "this shop came down from 250" is a fact the
        // gate can see. Without it, a shop moving while another sits cheaper
        // produced nothing at all.
        const state = await notifyState(ctx.sender!, Date.now(), ctx.vendorId);
        const { classifyActs } = await import("./wa/dialogue-acts");
        const acts = classifyActs({ text, pricePerDay: usablePrice ?? null });
        const event = classifyReply({
          pricePerDay: usablePrice,
          currency: cur,
          anyReplyYet: state.anyReplyYet,
          termsLanded: acts.shared.includes("deposit"),
        });
        const verdict = worthAnInterruption(event, state);
        if (!verdict.notify) return;

        const shop = ctx.vendorName || "A rental shop";
        const body = usablePrice
          ? `${shop} offered ${usablePrice} ${cur}/day - tap to see the deal.`
          : `${shop} answered - your hunt is live.`;
        const m = await import("./push");
        await m.sendPushCollapsed(
          ctx.sender!,
          `reply:${ctx.vendorId || from}`,
          {
            title: usablePrice ? "New price 💰" : "Your hunt is live 🛵",
            body,
            // A DESTINATION, NOT JUST A BUZZ. Every push in the app pointed at
            // "/" - so a tap after the app had been killed landed on a cold
            // home screen with the thread nowhere in sight. The id is enough
            // for the app to restore the hunt and open this shop.
            url: ctx.vendorId ? `/?shop=${encodeURIComponent(ctx.vendorId)}` : "/",
            // SAME TAG AS THE INGEST BUZZ. This push is an UPGRADE of "the shop
            // replied" that already fired the moment the message landed, so it
            // must replace it on the lock screen instead of adding a second
            // buzz for the same event.
            tag: `shop:${from}`,
          },
          { windowSec: 180, important: Boolean(usablePrice) }
        );
        await markPushSent(ctx.sender!, `${event.kind}: ${verdict.reason}`);
      } catch {
        /* a notification is never worth breaking the reply loop for */
      }
    });
  }

  // INBOUND GLOSS (fire-and-forget): translate a local-language shop reply to
  // English and stamp it on the stored inbound row (raw.english), so every
  // surface (card peek, transcript) shows the translation under the original.
  // The traveller must always understand the conversation their agent is
  // having - that IS the product.
  //
  // ...AND SO MUST THE ENGINE. The gloss was computed here, written to the
  // database, and never handed to the brain that answers the shop - so every
  // comprehension judgement downstream (all of them written in English) was
  // applied to raw Thai. `inboundEnglish` closes that loop; it is threaded onto
  // the turn input below and read by spte/comprehension.ts.
  let inboundEnglish: string | undefined;
  if (ctx.sender && text) {
    await finishBeforeResponse("inbound-gloss", async () => {
      try {
        const { translateToEnglish } = await import("./agents");
        const english = await translateToEnglish(text);
        if (!english) return;
        inboundEnglish = english;
        // PRIVACY: the no-id fallback is receiver-scoped, so the gloss can
        // never be stamped onto ANOTHER user's inbound row with these digits.
        const receiverScope = ctx.sender
          ? `&raw->>receiver=eq.${encodeURIComponent(ctx.sender)}`
          : "";
        const rows = await sbSelect<{ id: number; raw: Record<string, unknown> | null }>(
          "whatsapp_messages",
          opts.waMessageId
            ? `select=id,raw&direction=eq.inbound&wa_message_id=eq.${encodeURIComponent(
                opts.waMessageId
              )}&limit=1`
            : `select=id,raw&direction=eq.inbound${receiverScope}&order=received_at.desc&limit=1${numberFilter(
                "from_number",
                from
              )}`
        );
        const row = rows[0];
        if (row) {
          // Merge preserves receiver/instance - the scoping keys must survive.
          await sbUpdate("whatsapp_messages", `id=eq.${row.id}`, {
            raw: { ...(row.raw ?? {}), english },
          });
        }
        // THE SAME GLOSS LANDS ON THE vendor_replies ROW THIS TURN JUST WROTE
        // (W1.5: the gloss is visible everywhere). The raw-JSON stamp above
        // only serves the transcript; the status panel excerpt, the activity
        // feed's reply items and the trips timeline are all fed from
        // vendor_replies, which stored only the raw local text - so those
        // surfaces structurally COULD NOT show the translation. The gloss is
        // computed after the insert (it needs the LLM), so it arrives as a
        // best-effort follow-up update on the newest row for this shop - the
        // row written moments ago in this very turn. Before the english_gloss
        // migration the update silently no-ops and every surface keeps
        // working on the raw text (the established degrade pattern).
        if (ctx.vendorId && ctx.sender) {
          const vr = await sbSelect<{ id: number }>(
            "vendor_replies",
            `select=id&user_email=eq.${encodeURIComponent(
              ctx.sender
            )}&vendor_id=eq.${encodeURIComponent(
              ctx.vendorId
            )}&order=created_at.desc&limit=1`
          );
          if (vr[0]?.id) {
            await sbUpdate("vendor_replies", `id=eq.${vr[0].id}`, { english_gloss: english });
          }
        }
      } catch {
        /* gloss is an enhancement - never blocks the loop */
      }
    });
  }

  // THE READING, STORED BESIDE THE PICTURE IT CAME FROM.
  //
  // The vision agent already read this board; until now that reading became an
  // offer and then evaporated, so the image and the understanding of the image
  // lived in two different places and only one was ever shown. A traveller
  // looking at a price under a photo had no way to tell whether we read the
  // board or guessed - and when we get one wrong there was nothing to point at.
  //
  // Stamped onto the message's own `raw` (JSON - no column, no migration), so
  // the transcript can render exactly what was understood, per photo.
  //
  // The reading is computed HERE (it is pure) and kept in scope, so the turn
  // that follows can stamp what it actually DID about the photo onto the same
  // artefact - see `recordMediaFollowUp` below. Writing the whole object again
  // rather than patching it also makes the two writes order-independent.
  let mediaReading: import("./media/reading").MediaReading | null = null;
  /** The stood-down frames of this burst get the leader's reading. See below. */
  const stampBurstFollowers = async (
    leader: { id: number; wa_message_id?: string | null; received_at?: string | null },
    reading: import("./media/reading").MediaReading
  ) => {
    if (!ctx.sender) return;
    try {
      const { burstFollowerRows } = await import("./media/reading");
      const siblings = await sbSelect<{
        id: number;
        wa_message_id: string | null;
        received_at: string | null;
        raw: { media?: unknown; reading?: unknown } | null;
      }>(
        "whatsapp_messages",
        `select=id,wa_message_id,received_at,raw&direction=eq.inbound` +
          `&raw->>receiver=eq.${encodeURIComponent(ctx.sender)}` +
          `&order=received_at.desc&limit=12${numberFilter("from_number", from)}`
      );
      const leaderRow =
        siblings.find((r) => r.id === leader.id) ??
        ({ ...leader, received_at: leader.received_at ?? null } as { id: number; received_at: string | null });
      for (const follower of burstFollowerRows(siblings, leaderRow)) {
        await sbUpdate("whatsapp_messages", `id=eq.${follower.id}`, {
          raw: {
            ...(follower.raw ?? {}),
            reading: {
              ...reading,
              fromBurstLeader: leader.wa_message_id ?? String(leader.id),
            },
          },
        }).catch(() => {});
      }
    } catch {
      /* the follower stamp is an upgrade on the leader's - never the turn */
    }
  };
  const stampMediaReading = async (reading: import("./media/reading").MediaReading) => {
    try {
      const receiverScope = `&raw->>receiver=eq.${encodeURIComponent(ctx.sender!)}`;
      const rows = await sbSelect<{
        id: number;
        wa_message_id: string | null;
        received_at: string | null;
        raw: Record<string, unknown> | null;
      }>(
        "whatsapp_messages",
        opts.waMessageId
          ? `select=id,wa_message_id,received_at,raw&direction=eq.inbound&wa_message_id=eq.${encodeURIComponent(
              opts.waMessageId
            )}&limit=1`
          : `select=id,wa_message_id,received_at,raw&direction=eq.inbound${receiverScope}&order=received_at.desc&limit=1${numberFilter(
              "from_number",
              from
            )}`
      );
      const row = rows[0];
      if (row) {
        await sbUpdate("whatsapp_messages", `id=eq.${row.id}`, {
          raw: { ...(row.raw ?? {}), reading },
        });
        // EVERY FRAME OF A BURST, NOT JUST THE ONE THAT RAN THE TURN.
        //
        // A shop sent two menu photos; the second got no reading panel at all
        // (owner report 5, #6). Burst coalescing gives the whole album to the
        // NEWEST frame's invocation - the earlier frames stand down and never
        // get a turn of their own - and the stamp wrote onto that one row. The
        // stood-down rows keep their media, so they render, forever unexplained.
        // They get the leader's reading, marked as coming from it.
        await stampBurstFollowers(row, reading);
        return;
      }
      // NO ROW TO STAMP is itself the bug we spent a field test chasing. An
      // empty catch made a missing summary indistinguishable from a summary
      // nobody looked for; the trace makes it a thing the doctor can show.
      await sbInsert("agent_events", [
        {
          kind: "reading-stamp-failed",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          detail: `no inbound row matched (waMessageId=${opts.waMessageId ?? "none"})`.slice(0, 500),
        },
      ]).catch(() => {});
    } catch (e) {
      // The summary is a proof surface - it never blocks the reply, but it
      // never disappears silently either.
      await sbInsert("agent_events", [
        {
          kind: "reading-stamp-failed",
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          detail: (e instanceof Error ? e.message : "stamp threw").slice(0, 500),
        },
      ]).catch(() => {});
    }
  };
  /** Record the move this turn took on the media, so the panel can stop guessing. */
  const recordMediaFollowUp = async (
    move: string,
    delivered: import("./media/reading").ReadingFollowUp["delivered"]
  ) => {
    if (!mediaReading) return;
    mediaReading = { ...mediaReading, followUp: { move, delivered, at: new Date().toISOString() } };
    await stampMediaReading(mediaReading);
  };

  // THE TURN THAT LOOKED IS NOT ALWAYS THE TURN THAT HOLDS THE BYTES.
  //
  // This gate used to be `images.length > 0`, which is true only on the inline
  // path. In production the vision Flow reads the photo in an isolated worker
  // and the CONTINUATION composes the reply - calling this function with
  // `images: []` and the finished extraction in `preExtracted`. So on the path
  // every real traveller is served by, the stamp never ran: the photo rendered
  // in the conversation and the agent's summary under it never existed. The
  // question the gate must ask is "does this turn HOLD a reading of media?",
  // and the extraction answers that whether or not the bytes came with it.
  const { holdsMediaReading: turnHoldsMedia } = await import("./media/reading");
  if (turnHoldsMedia(images.length, extraction as never) && ctx.sender) {
    const { readingFrom, readingIsFailure } = await import("./media/reading");
    const draft = readingFrom(extraction as never, { usedPricePerDay: usablePrice });
    // "No usable price in this image" IS A CLAIM ABOUT THE IMAGE, so it may
    // only be made when the image is genuinely what came up short. On a
    // parse-failed / truncated / sanity-nulled / unavailable reading the panel
    // states OUR failure instead (readingEmptyLine), and this line - printed
    // right under it in the same box - would have contradicted it.
    mediaReading =
      !usablePrice && extraction.found === false && !readingIsFailure(draft)
        ? { ...draft, notUsedReason: "No usable price in this image." }
        : draft;
    // AWAITED: `void` here meant the stamp rode a detached promise, and on
    // Cloud Run a detached promise dies the instant the response flushes
    // (after.ts documents exactly this) - the other half of every
    // "reading was never stored" placeholder the owner photographed.
    await stampMediaReading(mediaReading);

    // A FAILURE IS AN EVENT, AND WHICH FAILURE IS THE WHOLE POINT.
    //
    // The only event here used to be `vision-unavailable`, fired only when the
    // entire provider ladder failed - so the three failures that actually hurt
    // (an unparseable answer, a cut-off answer, a price we read and rejected)
    // left NO trace at all and were indistinguishable, in the feed and in the
    // panel, from a blank photo. One kind per outcome, so telemetry can tell
    // model-failed from photo-bad.
    const READING_EVENT: Partial<Record<string, string>> = {
      unavailable: "vision-unavailable",
      "parse-failed": "vision-parse-failed",
      truncated: "vision-truncated",
      "sanity-nulled": "vision-sanity-nulled",
      empty: "vision-empty",
    };
    const eventKindForReading = READING_EVENT[mediaReading.outcome];
    if (eventKindForReading) {
      const ir = extraction.imageRead;
      void sbInsert("agent_events", [
        {
          kind: eventKindForReading,
          vendor_id: ctx.vendorId ?? "",
          vendor_name: ctx.vendorName ?? "",
          user_email: ctx.sender ?? "",
          to_number: from,
          detail: (
            mediaReading.outcome === "sanity-nulled"
              ? `read ${ir?.rejectedPricePerDay ?? "?"} ${ir?.rejectedCurrency ?? ""} /day and rejected it as implausible`
              : `${ir?.failure ?? mediaReading.outcome}${ir?.retryable ? " (retryable)" : ""}: ${
                  ir?.detail ?? ""
                }`
          ).slice(0, 500),
        },
      ]).catch(() => {});
    }
  }

  // HUMAN TAKEOVER GATE (pre-engine): the user typed in this shop's thread
  // themselves - the agents stand down for THIS thread until handback. The
  // reply was stored and pushed above; we just don't answer it.
  if (ctx.sender && !sessionClosed) {
    try {
      const { isThreadTakenOver } = await import("./session-flags");
      // Fail CLOSED: skip the auto-reply on true (taken over) OR null (store
      // unreadable) - talking over a human is an absolute-veto violation, so an
      // unknown state must not proceed. The inbound is already stored/pushed;
      // only the automated answer is withheld, and it resumes once readable.
      const takeover = await isThreadTakenOver(ctx.sender, from);
      if (takeover !== false) {
        // Distinguish a genuine takeover from an unreadable store (which also
        // fails closed): a Supabase blip silently muting every reply is exactly
        // the kind of failure this trace surfaces.
        void noteInboundDropped(opts.senderEmail, from, "takeover-hold", {
          state: takeover === true ? "taken-over" : "unreadable",
        });
        return;
      }
    } catch {
      void noteInboundDropped(opts.senderEmail, from, "takeover-hold", { state: "error" });
      return; // unreadable -> fail closed (do not auto-reply)
    }
  }

  // SESSION PAUSE GATE (pre-engine, same philosophy as sessionClosed): the
  // user told Will to hold everything. The reply was stored and the push sent
  // above - the agents just say NOTHING until the user resumes.
  if (ctx.sender && !sessionClosed) {
    try {
      const { isSessionPaused } = await import("./session-flags");
      // Fail CLOSED on true (paused) OR null (unreadable): "hold everything" is
      // absolute, so an unknown pause state withholds the auto-reply.
      const paused = await isSessionPaused(ctx.sender);
      if (paused !== false) {
        void noteInboundDropped(opts.senderEmail, from, "pause-hold", {
          state: paused === true ? "paused" : "unreadable",
        });
        return;
      }
    } catch {
      void noteInboundDropped(opts.senderEmail, from, "pause-hold", { state: "error" });
      return; // unreadable -> fail closed
    }
  }

  // SESSION TERMINATED GATE (HARD). A closed / deal-closed session must never
  // keep talking to shops - this was the "agents replied overnight after I
  // cleared the search" bug. It used to be only a SOFT director fact the LLM
  // could override; now it is an absolute stop. The reply is already stored
  // above (data is never lost); the agent simply says nothing more. A new
  // search re-opens the shop with a fresh RFQ that postdates the marker.
  if (sessionClosed) {
    void noteInboundDropped(opts.senderEmail, from, sessionClosedReason);
    return;
  }

  // ==== THE DIGRAPH NEGOTIATION ENGINE (v2) ==================================
  // The default path: a true directed graph of specialized agents driven by a
  // chief Negotiation Director (multi-round bargaining, deposit + fulfillment
  // probing, strategic waits, media coherence, judge scoring). The legacy
  // inline pipeline below is kept behind GRAPH_ENGINE=off for one release.
  // Resolve the traveller's consented stay FRESH from their profile at turn time
  // (never the frozen outbound meta), so once they add their hotel the very next
  // shop message is answered with it - the delivery-loop fix.
  if (ctx.sender) {
    try {
      const { getUserStay } = await import("./access");
      const stay = await getUserStay(ctx.sender);
      if (stay) (ctx as ThreadContext).stay = stay;
    } catch {
      /* no stay resolvable -> the loop-stop branch prompts the user */
    }
  }

  const { liveGraphIO } = await import("./graph/engine");
  const { threadKeyFor } = await import("./graph/state");
  const eventKind: "inbound-text" | "inbound-image" =
    images.length > 0 ? "inbound-image" : "inbound-text";
  // The ONE input both engines share, so the V3 -> graph fallback is behaviour-
  // identical at the boundary (same context, same IO, same deadline).
  const turnInput: import("./graph/types").GraphTurnInput = {
    event: {
      kind: eventKind,
      threadKey: threadKeyFor(ctx.sender ?? undefined, from),
      userEmail: ctx.sender ?? undefined,
      toDigits: from,
      // The coalesced unread buffer, so the director/answer nodes see the
      // shop's full recent burst (question + vehicle + price together).
      shopMessage: extractText,
      images,
      audios: [],
    },
    // WHAT THIS TURN IS ANSWERING. Threaded so every engine can stamp its
    // parked draft with it, and the drain can refuse a reply the shop has
    // already moved past (wa/freshness.ts).
    ctx: { ...ctx, inboundId: opts.waMessageId },
    rfq,
    extraction,
    usablePrice,
    priceBasisDays,
    currency: cur,
    floorPrice: floorSameCur?.floor,
    floorTypical: floorSameCur?.typical ?? undefined,
    sessionClosed,
    history,
    // THE GLOSS REACHES THE BRAIN (W4.3/W4.6 note): comprehension runs on the
    // English rendering when we have one, on the shop's own words when we do
    // not. This changes nothing about what language we SEND in.
    inboundEnglish,
    priorOutbound: thread
      .filter((m) => m.direction === "outbound")
      .map((m) => m.body ?? "")
      .filter(Boolean),
    // THE SAME BUG AS THE CONFIRM LOOP, ON THE SAME TURN.
    //
    // `deriveThreadFacts` prefers the recorded MOVE and falls back to matching
    // BARGAIN_TEXT_RX against our own prose. `priorOutboundKinds` is what feeds
    // it the recorded moves - and it was populated in exactly ONE place, the
    // graph TICK path (graph/engine.ts buildTurnFromThread). The INBOUND path,
    // which is the one that runs when a shop actually replies, never set it. So
    // the primary engine re-derived "have we bargained yet?" from wording on
    // every live turn, while the answer was sitting in `raw.move` on rows this
    // very function had already loaded (`thread` carries `raw`).
    //
    // Deliberately NOT filtered like `priorOutbound` above: the kinds array is
    // positional against the outbound rows, so dropping empties would shift
    // every subsequent move onto the wrong message.
    priorOutboundKinds: thread
      .filter((m) => m.direction === "outbound")
      .map((m) => m.raw?.move ?? m.raw?.kind ?? undefined),
    priorInbound: thread
      .filter((m) => m.direction === "inbound")
      .map((m) => m.body ?? "")
      .filter(Boolean),
    legacyCounts: {
      clarify: autoClarifies,
      bargain: autoBargains,
      answer: autoAnswers,
      close: autoCloses,
    },
    humanDelay: Boolean(opts.humanDelay && ctx.sender),
    transcript: opts.transcript ?? null,
    deadlineAt: Date.now() + 45_000,
  };
  const io = liveGraphIO(opts.send);

  // ENGINE_V3 (SPTE - Shared Session Blackboard + single-pass) is the PRIMARY
  // negotiation engine. ZERO-DOWNTIME FALLBACK: runSpteLiveTurn only ever throws
  // from its pre-send context build (never after a message leaves), so on ANY
  // error we log the telemetry and fail over to the repaired graph engine
  // WITHOUT dropping or double-sending the reply.
  // ONE routing authority, shared with the wakeup drain (engine-route.ts), so
  // an inbound reply and a scheduled follow-up on the same thread can never be
  // answered by different engines with different rules.
  const { runThreadTurn } = await import("./engine-route");
  const routed = await runThreadTurn(turnInput, io, "inbound");
  if (routed.engine !== "none") {
    // THE SPEED PANEL'S ONLY WRITER, on the path that actually runs. Its only
    // callers used to live in the legacy orchestrator block (now deleted), so
    // the WA doctor's turn-latency panel was structurally empty for every
    // routed (i.e. every real) turn. Outcome vocabulary maps
    // onto the panel's three buckets: sent stays "sent", queued/held read as
    // "parked", blocked/failed read as "send-failed"; a deliberate silent turn
    // is not stamped - there was nothing to deliver, so it has no latency.
    {
      const d = routed.spte?.delivered ?? "sent";
      if (d !== "silent") {
        stampTurnLatency(ctx.sender, from, {
          composeMs: Date.now() - turnStartedAt,
          plannedDelayS: 0,
          outcome:
            d === "sent" ? "sent" : d === "queued" || d === "held" ? "parked" : "send-failed",
        });
      }
    }
    // WHAT WE ACTUALLY DID ABOUT THE PHOTO, written next to the photo. The
    // proof panel renders this; with nothing recorded it now claims nothing.
    if (routed.spte) await recordMediaFollowUp(routed.spte.move, routed.spte.delivered);
    // WHAT THE SHOP SAID ABOUT EACH EXTRA THE TRAVELLER ASKED FOR.
    //
    // The request - helmets, a phone mount, delivery - left the app in the
    // opening message and never came back, so the booking screen could show a
    // helmet the shop had already refused. Read AFTER the reply has gone, so
    // it never sits on the path between a shop's message and our answer, and
    // only when there is actually something to read: no requested extras, no
    // call. Awaited rather than detached, because Cloud Run freezes the CPU
    // the moment the response flushes.
    // A SHOP THAT OFFERS SOMETHING ELSE IS NOT A SHOP THAT SAID NO.
    //
    // `wrongVehicle` made redirect-close the only legal move, so "no 125
    // today, but I have a 150 for 220" ended the thread - the same ride,
    // twenty baht more, from a shop trying to do business. Read the offer
    // after the turn (never on the reply path), and if it is close enough,
    // park a choice for the traveller; the policy then holds the thread silent
    // instead of closing it.
    // TRIGGER ON THE UNION, not on matchesSpec alone (owner problem #6). The old
    // gate only fired when the extractor had ALREADY set matchesSpec=false - i.e.
    // when a DIFFERENT CLASS word or an explicit cc mismatch appeared. The common
    // phrasing "no Click today, only Nmax, 300 per day" has 'nmax' in the scooter
    // vocabulary and no cc token, so classMatch was true, matchesSpec was true,
    // and the substitution read never ran: the 300 landed as the requested
    // vehicle's price. Run the read whenever a substitution is plausible, then
    // let the LLM's own "a different vehicle was offered" judgement (read.offered)
    // drive wrongVehicle - decideSubstitution still gates on closeness/confidence,
    // so a genuine same-vehicle reply is a no-op.
    const substitutionHint =
      /\b(?:no|dont|don'?t|out of|sold out|instead|only have|only got|we have|i have|but (?:i|we)|another|other|different|alternative)\b/i.test(
        opts.text ?? ""
      );
    const assessmentSuspect =
      extraction?.vehicleAssessment != null && extraction.vehicleAssessment.status !== "confirmed";
    const substitutionSuspected =
      extraction?.matchesSpec === false || assessmentSuspect || substitutionHint;
    if (substitutionSuspected && ctx.sender && ctx.vendorId) {
      const email = ctx.sender;
      const vendorId = ctx.vendorId;
      const inboundText = opts.text ?? "";
      const threadKey = turnInput.event.threadKey;
      const assessmentWrong = extraction?.vehicleAssessment?.status === "wrong-vehicle";
      await finishBeforeResponse("substitution-offer", async () => {
        const { readAlternativeOffer } = await import("./semantic/classifiers");
        const { decideSubstitution } = await import("./vehicle/substitution");
        const context =
          `The traveller asked for: ${rfq?.vehicleClass ?? "a vehicle"}` +
          (rfq?.engineSizeCc ? ` around ${rfq.engineSizeCc}cc` : "") +
          (rfq?.transmission && rfq.transmission !== "any" ? `, ${rfq.transmission}` : "");
        const read = await readAlternativeOffer(inboundText, context).catch(() => null);
        // The shop genuinely offered a DIFFERENT vehicle when: the extractor
        // flagged a class/cc mismatch, the assessment says wrong-vehicle, OR the
        // classifier read a distinct vehicle offer. Any of these makes it a real
        // substitution rather than a same-vehicle quote.
        const wrongVehicle =
          extraction?.matchesSpec === false || assessmentWrong || Boolean(read?.value?.offered);
        const decision = decideSubstitution({
          wrongVehicle,
          alternative: read?.value ?? null,
          currency: cur,
          now: Date.now(),
        });
        if (decision.kind !== "offer-choice") return;
        const { persistAlternativeOffer } = await import("./vehicle/substitution-store");
        await persistAlternativeOffer({ email, vendorId, threadKey, offer: decision.offer });
      });
    }
    if (rfq?.accessories?.length && ctx.sender && ctx.vendorId) {
      const email = ctx.sender;
      const vendorId = ctx.vendorId;
      const inboundText = opts.text ?? "";
      await finishBeforeResponse("accessory-verdicts", async () => {
        const { recordAccessoryVerdicts, persistAccessoryStatus } = await import(
          "./thread/accessory-pass"
        );
        const { verdicts } = await recordAccessoryVerdicts({
          email,
          vendorId,
          requested: rfq.accessories,
          inboundText,
        });
        if (verdicts)
          await persistAccessoryStatus({
            email,
            vendorId,
            requested: rfq.accessories,
            verdicts,
          });
      });
    }
    // "CAN YOU CALL ME?" WAS INVISIBLE (K7). readCallIntent existed, was
    // zod-validated, and had zero callers - a shop asking to talk by phone
    // scrolled past inside a foreign-language transcript while the agent kept
    // texting. Read AFTER the reply has gone (never on the send path), gated
    // by a SKIP-ONLY hint over the gloss + raw text so quiet turns cost no
    // model call; the verdict that sets the chip is the model's alone.
    if (ctx.sender && ctx.vendorId) {
      const email = ctx.sender;
      const vendorId = ctx.vendorId;
      const { callIntentHint } = await import("./semantic/classifiers");
      if (callIntentHint(`${text}\n${inboundEnglish ?? ""}`)) {
        await finishBeforeResponse("call-intent", async () => {
          const { readCallIntent } = await import("./semantic/classifiers");
          const read = await readCallIntent(inboundEnglish ?? text).catch(() => null);
          const v = read?.value;
          if (!v || v.confidence < 0.6) return;
          if (!v.wantsCall) return; // a phone number for messaging is not a call ask
          const { persistCallIntent } = await import("./thread/call-intent");
          await persistCallIntent({
            email,
            vendorId,
            intent: { quote: v.quote, urgency: v.urgency, at: new Date().toISOString() },
          });
        });
      }
    }
    // The turn reached an engine and produced its own outcome (sent, held or
    // deliberately silent). The message is CONSUMED either way - keeping the
    // claim is what stops an endless redelivery loop; releasing it is only
    // for turns that never got this far.
    turnDelivered = true;
    // ...AND SO ARE THE SIBLINGS IT COALESCED (H1). This turn read the WHOLE
    // unread burst - "Good day!" / "We have Fazzio" / "400 per day" - and
    // answered it as one message, but only the triggering frame's id was ever
    // claimed. wa-sync then found the siblings unclaimed and re-answered a
    // burst the shop had already had its reply to: duplicate turns, duplicate
    // messages, on the anti-ban surface of all places. Claim what was
    // consumed. sbInsertReturning is conflict-safe per id - a sibling another
    // delivery claimed first simply stays theirs.
    if (opts.waMessageId) {
      const consumed = thread
        .filter(
          (m) =>
            m.direction === "inbound" &&
            (!priorAt || m.received_at > priorAt) &&
            m.wa_message_id &&
            m.wa_message_id !== opts.waMessageId
        )
        .map((m) => m.wa_message_id as string);
      if (consumed.length) {
        await finishBeforeResponse("claim-coalesced", async () => {
          const { sbInsertReturning } = await import("./runtime-config");
          const { claimKey, settleReplyClaim } = await import("./wa/inbound-claim");
          for (const id of consumed) {
            // CLAIM the sibling so no other frame answers it again...
            await sbInsertReturning("wa_processed", [
              { wa_message_id: claimKey(opts.senderEmail, id) },
            ]).catch(() => {});
            // ...and SETTLE it in the same breath. This turn's reply answered
            // the WHOLE burst, so every coalesced sibling is DONE - but the bare
            // claim carries no settled_at, and wa_processed rows are leases:
            // past CLAIM_LEASE_MS an unsettled claim reads as a dead turn
            // (claimIsDeadTurn), so the recovery sweep re-answered the entire
            // burst ten minutes later. The primary message was settled after its
            // send (see above); its siblings never were. settleReplyClaim
            // no-ops on a pre-migration schema, so this degrades to today's
            // behaviour rather than breaking the claim.
            await settleReplyClaim(id, opts.senderEmail).catch(() => {});
          }
        });
      }
    }
    return;
  }

  // ==== BOTH ENGINES EXPLICITLY OFF ==========================================
  //
  // The ~630-line legacy orchestrator pipeline that lived here was UNREACHABLE
  // for every configuration except "both engines switched off by hand": the
  // routed block above returns for v3 and graph alike, and engineV3Enabled
  // returns true even when config is unreadable. Unreachable code with its own
  // divergent leverage logic is not a fallback, it is drift waiting for a
  // config accident - so it is deleted (see engine-route for the ladder, and
  // the dead-code pin in engine-route.test.ts). Both engines off is an owner's
  // explicit choice; the honest behaviour is to say so loudly and send
  // nothing, never to answer shops with a third brain nobody maintains.
  await sbInsert("agent_events", [
    {
      kind: "engine-disabled",
      user_email: ctx.sender ?? "",
      to_number: from,
      vendor_id: ctx.vendorId ?? "",
      vendor_name: ctx.vendorName ?? "",
      detail: `reply stored but unanswered: ${routed.fallbackReason ?? "both engines disabled"}`,
    },
  ]).catch(() => {});
  }
}
