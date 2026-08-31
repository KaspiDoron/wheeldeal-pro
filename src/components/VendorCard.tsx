"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { Vendor, StructuredRFQ, VehicleOption, OutreachReply } from "@/lib/types";
import { StageBadge, Pipeline, stageCaption } from "./Tracker";
import { Icon } from "./icons";
import { AnimatedNumber } from "./SavingsTicker";
import { LoadingDots } from "./LoadingDots";
import { PhotoGallery } from "./PhotoGallery";
import { ShopPhoto } from "./ShopPhoto";
import { friendlySendError } from "@/lib/wa/send-error";
import { fetchJson } from "@/lib/client/fetch-json";
import { useI18n } from "@/lib/i18n";
import { moneyLocal, convertApprox, savedCurrency, currencySymbol } from "@/lib/currency";
import { queueReasonLabel, queueReasonWhy, queueEta } from "@/lib/queue-reason";
import { VENDOR_TAG_LABELS } from "@/lib/labels";
import { ThreadPeek } from "./ThreadPeek";
import { OptionList } from "./OptionList";
import { ShopAvatar } from "./ShopAvatar";
import { vehicleStance } from "@/lib/offer-presentation";
import { offerBadge } from "@/lib/offer-badges";
import { InfoTip } from "./InfoTip";
import { parseDeposit } from "@/lib/deposit";
import { agentBusyLabel } from "@/lib/client/agent-busy";

// A rental-shop card. Prices are NEVER invented - we first ask the shop, and
// only its real reply produces a price. Everything happens INSIDE the app:
// the RFQ is sent from here via the official WhatsApp Cloud API, and the
// shop's answer flows back into this card automatically through the webhook.
function VendorCardInner({
  vendor,
  rfq,
  plan,
  waConnected,
  localLang,
  region,
  searchEpoch,
  onBook,
  onReviews,
  onBargain,
  onStage,
  onQueued,
  onCustomMessage,
  onPickupConsent,
  onLocationRequest,
  whyDecisionId,
  onWhy,
  onOpenThread,
  riskNote,
  agentPending,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ | null;
  plan?: string;
  // null = still checking the link on first paint; treated the same as false
  // for gating (send disabled) but lets the parent avoid a "not connected" flash.
  waConnected: boolean | null;
  localLang?: boolean;
  region?: string;
  searchEpoch?: number;
  // The chosen tier travels with the action. Without it, locking the "older
  // 200" tier would book the headline price of the "newer 250" one, because
  // BookingSheet reads vendor.offer.pricePerDay directly.
  onBook: (vendor: Vendor, option?: VehicleOption) => void;
  onReviews: (vendor: Vendor) => void;
  onBargain: (vendor: Vendor, option?: VehicleOption) => void;
  onStage: (vendorId: string, stage: Vendor["stage"]) => void;
  // A send was parked in the outbox - stamp queuedUntil + the guard's real
  // reason instantly so every surface agrees without waiting for a poll.
  onQueued?: (vendorId: string, queuedUntil?: string, queuedReason?: string) => void;
  // ONE declared reply shape for every send in the app (lib/types). The prop
  // used to narrow it to three fields and the body then cast it back out with
  // `as`, which is how `ok` - a field the route has never returned - survived
  // as a success test for years.
  onCustomMessage: (vendorId: string, message: string) => Promise<OutreachReply>;
  // Pickup consent: the shop offered to pick the traveller up; sending the
  // exact location happens ONLY after the traveller approves it here.
  onPickupConsent?: (vendor: Vendor, sharePlace?: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Opens the location-share sheet: the shop asked WHERE the traveller is. */
  onLocationRequest?: (vendor: Vendor) => void;
  // "Why this move?" - the latest director decision for this shop (live data).
  whyDecisionId?: string;
  onWhy?: (decisionId: string) => void;
  // Open the full-screen per-agency dashboard (transcript + map + offer + state).
  onOpenThread?: (vendor: Vendor) => void;
  // Inbound-risk warning from the safety screen ("asked for your passport...").
  riskNote?: string;
  /**
   * WHAT THE AGENT IS ALREADY MID-SENTENCE WITH at this shop, from the
   * activity poll's `agentPending` rollup.
   *
   * The client could not see agent activity at all: the queue payload
   * carries INTRO kinds only, by design. So the Bargain button had nothing
   * to gate on - no `disabled`, no in-flight ref, no indicator, unlike the
   * RFQ button twenty lines below it - and two taps queued two pushes at
   * one shop, with only the server's 3-minute window in the way.
   */
  agentPending?: { count: number; sending: boolean; own?: boolean };
}) {
  const { t } = useI18n();
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // The exact risk text the traveller dismissed - a DIFFERENT reason (new
  // text) shows again on its own; the same one stays away.
  const [dismissedRisk, setDismissedRisk] = useState<string | null>(null);
  const [chatState, setChatState] = useState<{
    status: "idle" | "checking" | "sent" | "queued" | "blocked";
    reason?: string;
    suggestion?: string;
  }>({ status: "idle" });
  const [rfqState, setRfqState] = useState<
    "idle" | "sending" | "sent" | "queued" | "no-phone" | "not-connected" | "rate-limited"
  >("idle");
  const [rfqError, setRfqError] = useState<string | null>(null);
  // Every deferred UI step is tracked and cleared on unmount - an untracked
  // setTimeout kept firing stage changes after the card was gone.
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);
  // B3: a SYNCHRONOUS in-flight guard. `disabled` derives from React state that
  // only lands after a render commit, leaving a window where two near-instant
  // taps both dispatch a fetch (-> two outbox rows / a double send). This ref
  // flips before the first await, so the second tap is dropped immediately.
  const rfqInFlight = useRef(false);
  // ...and the same guard for BARGAIN, which never had one. `onBargain` opens
  // a composer rather than sending, so the ref clears on the next paint - long
  // enough to swallow a double tap, short enough that a cancelled composer
  // does not leave the button dead.
  const bargainInFlight = useRef(false);
  /**
   * The agent is already writing to this shop, so the traveller pressing
   * Bargain would stack a second push on top of it. Server truth, from the
   * activity poll - never this component's own state, which resets on every
   * remount and is why the composer's `sendState` guard was not enough.
   */
  const agentBusy = (agentPending?.count ?? 0) > 0;
  const startBargain = (option?: VehicleOption) => {
    if (bargainInFlight.current || agentBusy) return;
    bargainInFlight.current = true;
    timersRef.current.push(setTimeout(() => (bargainInFlight.current = false), 1_200));
    onBargain(vendor, option);
  };
  // "Already asked" survives navigation: it derives from the vendor's stage
  // (persisted with the search), not from this component's local state.
  const alreadyAsked = ["rfq-sent", "awaiting-response", "negotiating"].includes(
    vendor.stage ?? ""
  );
  const askDone = alreadyAsked || rfqState === "sent" || rfqState === "queued";
  // The user removed the queued message (server truth cleared queuedUntil):
  // this card's local "queued" latch must release too, so the button honestly
  // returns to "Ask for price" instead of staying stuck on a dead queue.
  useEffect(() => {
    if (rfqState === "queued" && !vendor.queuedUntil) setRfqState("idle");
  }, [rfqState, vendor.queuedUntil]);
  // TRUTH RULE: a message held in the outbox is QUEUED, never "Sent".
  // vendor.queuedUntil is the server-reconciled source (survives remounts),
  // rfqState covers the instant before the first poll.
  // PRESENCE, not a future timestamp: a committed outbox row means "do not
  // re-fire" whether its ETA is still in the future or already elapsed (a slow
  // drain / host blip leaves not_before in the past while the row is still
  // parked). Gating on `> now` re-enabled the button + relabelled it "Ask for
  // price" while the queued badge still showed - a self-contradiction that let
  // a tap enqueue a DUPLICATE. This matches the badge (vendor.queuedUntil &&
  // !offer) and the queue panel; the local latch releases via the effect above
  // once the server clears queuedUntil (delivered or removed).
  const queuedActive = rfqState === "queued" || Boolean(vendor.queuedUntil && !vendor.offer);
  // The shop has ANSWERED and the answer closes this card: a decline, or
  // nothing available today. Both are states, not calls to action - a live
  // green "Ask for price" over them is the same trap the queued chip fixed.
  const cardTerminal = vendor.stage === "declined" || vendor.stage === "out-of-stock";
  const [galleryOpen, setGalleryOpen] = useState(false);
  // The substitution choice. `altBusy` is a plain in-flight latch: this posts a
  // decision, and a double tap would be a second decision on a choice that is
  // already gone (the server answers 409, but the button should not invite it).
  const [altBusy, setAltBusy] = useState(false);
  const decideAlternative = async (accept: boolean) => {
    if (altBusy) return;
    setAltBusy(true);
    try {
      await fetch("/api/negotiate/alternative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId: vendor.id, accept }),
      });
      // The next poll carries the cleared choice and the thread's new state.
      // Nothing is sent to the shop from here - the ordinary turn does that,
      // inside the same rails as every other message.
      onStage(vendor.id, accept ? "negotiating" : "declined");
    } finally {
      setAltBusy(false);
    }
  };
  const [pickupState, setPickupState] = useState<"idle" | "sending" | "shared" | "failed">("idle");

  const offer = vendor.offer;
  // Facts the shop's replies established even when NO price was read (the
  // facts pass, lib/client/reply-facts). The substitution choice, the call
  // request and the deposit chips must render off these too - a shop that
  // counter-offered a different bike has no `offer` yet by definition.
  const facts = vendor.threadFacts;
  const altOffer = offer?.alternativeOffer ?? facts?.alternativeOffer;
  const callAsk = offer?.wantsCall ?? facts?.wantsCall;
  // ONE reading of the vehicle question for the whole card. Three separate
  // branches used to test `matchesSpec === false` independently, and that single
  // bit cannot tell "wrong bike" from "not established yet" - so a shop quoting
  // the exact 125cc asked for was told it had quoted something else.
  const stance = vehicleStance(offer);
  // The badge AND its plain-language explanation, from one entry - see
  // lib/offer-badges for why these four words needed a tooltip at all.
  const badge = offerBadge({
    stance,
    verified: offer?.verified,
    // A parked substitution is the traveller's decision, not a state that
    // resolves itself - and UNVERIFIED's copy promises the opposite.
    pendingChoice: Boolean(offer?.alternativeOffer),
  });
  // The offer's own currency symbol - prices display in the shop's money.
  const curSymbol = offer ? currencySymbol(offer.currency) : "$";
  // Traveller's own currency (item #6) - set after mount so SSR markup stays
  // deterministic. Used only for the "≈ in your money" hint under the total.
  const [myCur, setMyCur] = useState<string | null>(null);
  useEffect(() => setMyCur(savedCurrency()), []);
  const approxTotal =
    offer && myCur ? convertApprox(offer.totalPrice, offer.currency, myCur) : null;
  const savings =
    offer && rfq
      ? Math.max(0, (offer.listPricePerDay - offer.pricePerDay) * rfq.durationDays)
      : 0;

  // Send the RFQ WITHOUT leaving the app: safety-screened, dispatched via the
  // official Cloud API, thread logged so the reply lands here automatically.
  async function sendRfq() {
    if (!rfq) return;
    if (rfqInFlight.current) return; // B3: drop a double-tap before the first await
    rfqInFlight.current = true;
    setRfqState("sending");
    try {
      // THE APP ALREADY HAD A TRANSPORT THAT CANNOT HANG AND CANNOT THROW.
      //
      // `lib/client/fetch-json` was written for exactly this and the send path
      // never used it: this was a bare `fetch` + `await res.json()`, so an HTML
      // 500, a gateway 504 and a phone with no signal all landed in the same
      // catch arm - the one that says "Couldn't reach the server just now" -
      // and a request that stalled never landed anywhere at all, leaving the
      // button spinning. fetchJson keeps the three apart, always settles, and
      // returns the server's JSON body even on a non-2xx (which several
      // branches below rely on).
      //
      // The 50s deadline is deliberate: a send legitimately runs an LLM safety
      // screen, localization and the WhatsApp host, and the route's own 45s
      // budget answers first with a body we can explain. The default 10s would
      // abort perfectly healthy sends.
      const r = await fetchJson<OutreachReply>("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 50_000,
        body: JSON.stringify({
          to: vendor.whatsapp || undefined,
          placeId: vendor.placeId,
          vendorId: vendor.id,
          vendorName: vendor.name,
          message: rfq.vendorMessage,
          kind: "rfq",
          rfq,
          round: 0,
          region,
          openNow: vendor.openNow,
          localLang: Boolean(localLang),
          // WHICH HUNT this introduction belongs to. The plan's
          // concurrentCampaigns limit is metered on this - without it every
          // queued row looks like the same anonymous campaign.
          campaign: searchEpoch || undefined,
        }),
      });
      const d = r.data;
      if (!d) {
        // No body at all: a timeout, a dead connection, or an answer that was
        // not JSON. None of those is proof WhatsApp is unlinked, and none of
        // them is automatically the user's connection either - fetchJson has
        // already picked the honest line for whichever it was.
        setRfqState("rate-limited");
        setRfqError(
          r.timedOut
            ? t("That took too long - your message may still be on its way. Give it a few seconds before trying again.")
            : t(r.error ?? "Couldn't reach the server just now - it retries automatically. Try again in a moment.")
        );
        return;
      }
      if (d.duplicate) {
        // B3: the server recognised this exact ask is already on its way. This
        // is NOT a failure - the old code fell through to the generic "brief
        // hiccup" toast (the response has no `error` field), scaring the user.
        // Reflect the real state: the shop was already contacted.
        setRfqState("sent");
        onStage(vendor.id, "awaiting-response");
      } else if (d.sent) {
        setRfqState("sent");
        onStage(vendor.id, "rfq-sent");
        timersRef.current.push(setTimeout(() => onStage(vendor.id, "awaiting-response"), 1200));
      } else if (d.queued) {
        // The anti-ban engine parked the message (shop closed, safe pacing,
        // daily limit...). NOTHING was delivered, so the stage must NOT claim
        // "RFQ sent" - the queued badge is the whole truth. Stamp queuedUntil
        // + the real reason immediately so strip and card agree NOW.
        setRfqState("queued");
        onQueued?.(vendor.id, d.queuedUntil, d.queuedReason ?? undefined);
      } else if (d.halted) {
        // Already asked and awaiting the reply (server-side truth).
        setRfqState("sent");
        onStage(vendor.id, "awaiting-response");
      } else if (d.reason === "no-phone") {
        // Honest terminal state: this shop cannot be messaged at all.
        setRfqState("no-phone");
        onStage(vendor.id, "no-contact");
      } else if (d.rateLimited) {
        setRfqState("rate-limited");
        // Never render an upstream string: the traveller once read
        // `instance requires property "text"` - our own request-body bug -
        // inside their shop card.
        setRfqError(d.error ? friendlySendError(d.error).text : null);
      } else if (d.reconnecting) {
        // Transient drop (server waking) - no re-link needed, just retry.
        setRfqState("rate-limited");
        setRfqError(d.error ? friendlySendError(d.error).text : null);
      } else if (d.configured === false || d.connect) {
        // The server SAYS WhatsApp is not linked - only then do we ask the user
        // to connect. Never inferred from a generic failure.
        setRfqState("not-connected");
      } else {
        // Anything else (an individual send that failed while WhatsApp IS
        // linked - a host 5xx, a number hiccup) is a TRANSIENT problem, not a
        // disconnect. Say so honestly and keep WhatsApp shown as connected.
        setRfqState("rate-limited");
        setRfqError(
          d.error
            ? friendlySendError(d.error).text
            : t("Not sent - a brief hiccup reaching WhatsApp. It retries on its own; try again in a few seconds.")
        );
      }
    } catch {
      // postJson does not throw, so reaching here means something in OUR
      // branching did. Keep the safety net - it must never leave the button
      // spinning - but it is no longer the route every server fault takes.
      setRfqState("rate-limited");
      setRfqError(t("Couldn't reach the server just now - it retries automatically. Try again in a moment."));
    } finally {
      rfqInFlight.current = false; // B3: release the synchronous lock
    }
  }

  async function sendCustom() {
    if (!draft.trim()) return;
    setChatState({ status: "checking" });
    // No `as` cast: the prop is typed with the shared OutreachReply now, so a
    // field the route does not return is a compile error rather than a
    // permanently-true condition.
    const verdict = await onCustomMessage(vendor.id, draft.trim());
    if (verdict.allowed && !verdict.sent) {
      if (verdict.queued) {
        // Anti-ban queue (shop closed / pacing): NOTHING was delivered yet -
        // saying "Sent" here was a lie the queue card immediately disproved.
        setChatState({ status: "queued" });
        setDraft("");
        timersRef.current.push(
          setTimeout(() => {
            setChatOpen(false);
            setChatState({ status: "idle" });
          }, 2600)
        );
        return;
      }
      // Only claim "connect WhatsApp" when that is actually the problem -
      // a temporary reconnect or rate pause must never masquerade as it.
      setChatState({
        status: "blocked",
        reason:
          verdict.configured === false
            ? t("Not sent: connect your WhatsApp in Profile first - messages leave WheelDeal only through WhatsApp.")
            : verdict.error ??
              t("Not sent - a temporary hiccup on the WhatsApp connection. Try again in a few seconds."),
      });
      return;
    }
    if (verdict.allowed) {
      setChatState({ status: "sent" });
      setDraft("");
      timersRef.current.push(
        setTimeout(() => {
          setChatOpen(false);
          setChatState({ status: "idle" });
        }, 1600)
      );
    } else {
      setChatState({
        status: "blocked",
        reason: verdict.reason,
        suggestion: verdict.suggestion,
      });
    }
  }

  return (
    <div
      className={`surface lift overflow-hidden rounded-blob ${
        vendor.sponsored ? "sponsored-glow" : ""
      }`}
    >
      {/* M14: A PAID PLACEMENT SAYS SO.
          This banner read "Recommended shop", which is an editorial claim - and
          `sponsored` is set by `tagSponsored` from the owner's paid
          `sponsored_shops` table and pins the card first under EVERY sort,
          including "Closest". Nobody recommended it; somebody paid for it.
          A card that leads the list under a sort it did not win, wearing a word
          that implies we judged it best, is the same defect Tier 0.6 deleted
          eight of - a claim the code does not honour. The prominence is the
          owner's monetization decision and is kept; the word is corrected. */}
      {vendor.sponsored && (
        <div className="flex items-center justify-center gap-1 bg-gradient-to-r from-brandblue via-[#7c5cff] to-brandred py-1 text-[10px] font-extrabold uppercase tracking-wide text-white">
          ⭐ {t("Promoted - paid placement")}
        </div>
      )}
      {vendor.photoUrl && (
        <div className="relative h-32 w-full">
          <ShopPhoto src={vendor.photoUrl} className="h-full w-full" />
          {vendor.openNow !== undefined && (
            <span
              className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-[11px] font-extrabold ${
                vendor.openNow ? "bg-savings text-white" : "bg-brandred text-white"
              }`}
            >
              {vendor.openNow ? t("Open now") : t("Closed")}
            </span>
          )}
        </div>
      )}

      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* Only resolves for shops we have actually messaged, and only
                  while this search is open - see ShopAvatar. */}
              <ShopAvatar name={vendor.name} phone={vendor.whatsapp} retryKey={vendor.stage} photoUrl={vendor.photoUrl} />
              <h3 className="truncate text-[16px] font-extrabold text-strong">{vendor.name}</h3>
              {vendor.demo && (
                <span className="shrink-0 rounded-full bg-brandyellow-soft px-2 py-0.5 text-[10px] font-extrabold text-warn">
                  {t("Demo")}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-soft">
              <button
                onClick={() => onReviews(vendor)}
                className="chip inline-flex items-center gap-1 font-bold text-strong"
              >
                <Icon name="star" className="h-3.5 w-3.5 text-brandyellow" />
                {vendor.rating ? vendor.rating.toFixed(1) : t("New")}
                <span className="font-semibold text-brandblue underline decoration-dotted">
                  {vendor.reviews} {t("reviews")}
                </span>
              </button>
              <span className="inline-flex items-center gap-1">
                <Icon name="pin" className="h-3.5 w-3.5 text-brandred" />
                {vendor.distanceKm?.toFixed(1)} km
              </span>
              {(vendor.photoUrls?.length ?? 0) > 1 && (
                <button
                  onClick={() => setGalleryOpen(true)}
                  className="chip inline-flex items-center gap-1 font-bold text-brandblue"
                >
                  🖼 {vendor.photoUrls!.length} {t("photos")}
                </button>
              )}
            </div>
            {/* Real Google data chips */}
            <div className="mt-1 flex flex-wrap gap-1">
              {vendor.todayHours && (
                <span className="rounded-md bg-card2 px-1.5 py-0.5 text-[10px] font-bold text-soft">
                  🕒 {vendor.todayHours}
                </span>
              )}
              {(vendor.orders ?? 0) > 0 ? (
                <span className="rounded-md bg-savings-soft px-1.5 py-0.5 text-[10px] font-extrabold text-savings">
                  ✓ {vendor.orders} {t("booked here on WheelDeal")}
                </span>
              ) : (
                <span className="rounded-md bg-brandblue-soft px-1.5 py-0.5 text-[10px] font-extrabold text-brandblue">
                  ✨ {t("New on WheelDeal")}
                </span>
              )}
              {vendor.fastResponder && (
                <span className="rounded-md bg-brandyellow-soft px-1.5 py-0.5 text-[10px] font-extrabold text-warn">
                  ⚡ {t("Fast responder")}
                </span>
              )}
              {/* Reply-VERIFIED facts (item #13): the shop stated each of these
                  in at least TWO different replies before it earns a badge. */}
              {(vendor.verifiedTags ?? []).map((tg) => {
                const meta = VENDOR_TAG_LABELS[tg];
                if (!meta) return null;
                return (
                  <span
                    key={tg}
                    title={t("Confirmed by the shop in multiple replies")}
                    className="rounded-md bg-savings-soft px-1.5 py-0.5 text-[10px] font-extrabold text-savings"
                  >
                    {meta.emoji} {t(meta.label)} ✓
                  </span>
                );
              })}
            </div>
            {vendor.address && (
              <div className="mt-1 truncate text-[12px] text-faint">{vendor.address}</div>
            )}
          </div>
          {vendor.stage && <StageBadge stage={vendor.stage} />}
        </div>

        <div className="mt-3">
          {/* A held message shows the guard's REAL reason (shop closed / safe
              pacing / daily limit) + an honest ETA. The user can remove it
              from the status panel above. */}
          {vendor.queuedUntil && !offer && (
            <div className="mb-2 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-warn">
              <div className="flex items-center gap-1.5">
                🕘 {t(queueReasonLabel(vendor.queuedReason))}
                {queueEta(vendor.queuedUntil, vendor.queuedReason)
                  ? ` · ${t(queueEta(vendor.queuedUntil, vendor.queuedReason))}`
                  : ""}
              </div>
              {/* WHY, not just WHAT. Cold introductions now wait for the shop's
                  opening hours (FAST_DISPATCH off). Without the reason, a
                  traveller watching a shop sit untouched until tomorrow morning
                  reasonably concludes the app is broken - so the surfaces that
                  have room say why, and say plainly that shops already talking
                  to them are answered immediately. */}
              {queueReasonWhy(vendor.queuedReason) && (
                <p className="mt-1 font-semibold leading-snug opacity-90">
                  {t(queueReasonWhy(vendor.queuedReason) as string)}
                </p>
              )}
            </div>
          )}
          {/* The user removed this shop's queued messages: honest paused
              state - agents stay silent until a fresh send re-opens it. */}
          {vendor.cancelled && !vendor.queuedUntil && !offer && (
            <div className="mb-2 flex items-center gap-1.5 rounded-xl bg-card2 p-2 text-[11px] font-bold text-soft">
              ⏸ {t("Paused by you - sending a new message re-opens this shop")}
            </div>
          )}
          {/* THE SHOP OFFERED SOMETHING ELSE, AND IT MIGHT BE FINE.
              `wrongVehicle` used to make a goodbye the only legal move, so
              "no 125 today, but I have a 150 for 220" ended the conversation.
              The thread is paused while this sits here; the agent haggles
              nothing until the traveller answers, and declining ends it
              exactly where it would have ended anyway. */}
          {altOffer && (
            <div className="mt-2 rounded-2xl border-2 border-brandblue/40 bg-brandblue-soft p-2.5">
              <div className="text-[11px] font-extrabold text-brandblue">
                🔁 {t("This shop offered a different vehicle")}
              </div>
              <div className="mt-0.5 text-[12.5px] font-bold text-strong">
                {altOffer.vehicle}
                {typeof altOffer.pricePerDay === "number"
                  ? ` - ${altOffer.pricePerDay} ${altOffer.currency ?? ""}/${t("day")}`
                  : ""}
              </div>
              {altOffer.reason && (
                <p className="mt-0.5 text-[11px] leading-snug text-soft">{altOffer.reason}</p>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => decideAlternative(true)}
                  disabled={altBusy}
                  className="btn btn-primary flex-1 rounded-xl py-2 text-[12px] font-extrabold disabled:opacity-60"
                >
                  {altBusy ? <LoadingDots /> : t("Yes, negotiate this one")}
                </button>
                <button
                  onClick={() => decideAlternative(false)}
                  disabled={altBusy}
                  className="btn flex-1 rounded-xl border-2 border-line py-2 text-[12px] font-bold text-soft disabled:opacity-60"
                >
                  {t("No thanks")}
                </button>
              </div>
            </div>
          )}
          {/* THE SHOP ASKED TO TALK BY PHONE (K7). The model read it off the
              glossed thread; until this chip, "can you call me?" scrolled past
              inside a foreign-language transcript and the agent kept texting.
              Informational, never blocking - the traveller decides. */}
          {callAsk && (
            <div className="mt-2 rounded-xl border-2 border-line bg-card2 p-2 text-[11px] font-bold text-soft">
              📞 {t("This shop asked to talk by phone")}
              {callAsk.urgency === "now" ? ` (${t("right now")})` : ""}
              {callAsk.quote && (
                <span className="block font-medium text-strong">&ldquo;{callAsk.quote}&rdquo;</span>
              )}
            </div>
          )}
          {riskNote && dismissedRisk !== riskNote && (
            <div className="mt-2 flex items-start gap-1.5 rounded-xl border-2 border-brandred/40 bg-brandred-soft p-2 text-[11px] font-bold text-brandred">
              <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                {/* The reason is a sentence from the risk engine; terminate it
                    ourselves rather than trusting every reason string to end
                    in a full stop. The old suffix here said "Nothing was
                    sent" - FALSE copy: the risk screen informs the traveller
                    and never freezes the engine, and claiming otherwise is
                    exactly how a calm heads-up read as a dead conversation. */}
                {t("Will has flagged this shop's reply")}: {riskNote.replace(/\s*[.;,]?\s*$/, "")}.{" "}
                {t("Your agent keeps negotiating - this is a heads-up, not a block.")}
              </span>
              {/* Dismissible: a warning the traveller has read and weighed must
                  not latch onto the card for the rest of the session. A NEW
                  reason (different text) resurfaces on its own. */}
              <button
                onClick={() => setDismissedRisk(riskNote)}
                aria-label={t("Dismiss")}
                className="btn btn-sm -mr-1 -mt-1 h-5 w-5 shrink-0 rounded-full text-brandred/70 hover:text-brandred"
              >
                ✕
              </button>
            </div>
          )}
          <Pipeline stage={vendor.stage ?? "queued"} />
          {vendor.stage && vendor.stage !== "offer-received" && (
            <div className="mt-2 flex items-start gap-1.5 rounded-xl bg-card2 p-2 text-[11px] font-bold text-soft">
              <span className="shrink-0">{stageCaption(vendor.stage).emoji}</span>
              <span className="flex-1">{t(stageCaption(vendor.stage).text)}</span>
              {whyDecisionId && onWhy && (
                <button
                  onClick={() => onWhy(whyDecisionId)}
                  className="chip shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-brandblue"
                >
                  {t("Why?")}
                </button>
              )}
            </div>
          )}
          {/* Control: the last message we sent + the shop's last reply, each
              collapsible on its own, newest at the bottom. Server truth ONLY -
              the card never shows a client draft as "sent" (the real message
              may be localized/rewritten before it leaves). */}
          {vendor.stage &&
            !["queued", "locating-contact", "found", "no-contact"].includes(vendor.stage) && (
              <>
                <ThreadPeek
                  vendorId={vendor.id}
                  fallbackReceived={offer?.message}
                  fallbackReceivedEnglish={offer?.messageEnglish}
                  since={searchEpoch}
                />
                {onOpenThread && (
                  <button
                    onClick={() => onOpenThread(vendor)}
                    className="mt-1.5 w-full rounded-xl border-2 border-line py-1.5 text-[11px] font-extrabold text-brandblue lift"
                  >
                    💬 {t("Full conversation")}
                  </button>
                )}
              </>
            )}
        </div>

        {offer ? (
          <div className="mt-3 rounded-2xl bg-card2 p-3">
            <div className="flex items-end justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide text-faint">
                  {t("Shop's offer")}
                  {/* BUG 1B: an offer row is ALWAYS a real price a real shop
                      quoted for the requested vehicle - so the fallback is a
                      calm "Shop quote", never a scary "UNCONFIRMED" that made
                      genuine offers look fake. VERIFIED is the premium state
                      (exact vehicle match + high-confidence read); DIFFERENT
                      VEHICLE flags a mismatched quote. */}
                  {/* ONE VOCABULARY (lib/offer-badges): the badge text and the
                      sentence behind the "i" come from the same entry, so a
                      future wording change cannot leave the explanation
                      describing the old badge. The two states that SOUND
                      alarming - SHOP QUOTE and UNVERIFIED - are the two that
                      usually mean nothing is wrong, which is exactly why they
                      needed the tooltip most. */}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9px] font-extrabold ${
                      badge.id === "mismatch"
                        ? "bg-brandred-soft text-brandred"
                        : badge.id === "confirming"
                          ? "bg-brandblue-soft text-brandblue"
                          : badge.id === "verified"
                            ? "bg-savings-soft text-savings"
                            : "bg-card2 text-soft"
                    }`}
                  >
                    {t(badge.label)}
                  </span>
                  <InfoTip
                    id={`offer-badge-${vendor.id}`}
                    label={t(badge.label)}
                    what={t(badge.what)}
                    drift={badge.next ? t(badge.next) : undefined}
                  />
                </div>
                <div className="font-accent text-2xl font-extrabold text-strong">
                  {curSymbol}
                  <AnimatedNumber value={offer.pricePerDay} />
                  <span className="text-sm font-bold text-faint">/{t("day")}</span>
                </div>
                <div className="text-[12px] text-soft">
                  {moneyLocal(offer.totalPrice, offer.currency)} {t("total")} · {rfq?.durationDays}d
                  {approxTotal !== null && myCur && (
                    <span className="ml-1 text-[11px] font-bold text-faint">
                      ≈ {moneyLocal(approxTotal, myCur)}
                    </span>
                  )}
                </div>
                {/* PROVENANCE. A sourced price is real information the app was
                    hiding behind "No price yet" - the shop's photographed menu,
                    its option list, the thread's standing number. Shown WITH
                    where it came from, so the traveller can weigh it while the
                    agent confirms it; a confirmed reply clears the tag. */}
                {offer.priceSource && (
                  <div className="mt-0.5 text-[10px] font-bold text-brandblue">
                    {offer.priceSource === "menu-photo"
                      ? t("Read from their price-menu photo - being confirmed.")
                      : offer.priceSource === "menu"
                        ? t("From their price menu - being confirmed.")
                        : t("From the conversation - being confirmed.")}
                    {offer.priceSourceVehicle ? ` (${offer.priceSourceVehicle})` : ""}
                  </div>
                )}
                {/* Shop-CONFIRMED conditions only - never guessed */}
                {(offer.deposit || offer.depositType || offer.includesDelivery || offer.includesInsurance || offer.deliveryFee != null) && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(() => {
                      // Special deposit tag by the price: the exact kind the shop
                      // wants held (cash amount / passport / etc.), from the
                      // structured deposit, falling back to the raw label.
                      const type = offer.depositType;
                      const amt = offer.depositAmount;
                      const dCur = offer.depositCurrency || offer.currency;
                      if (!type && !offer.deposit) return null;
                      if (type === "none") {
                        return (
                          <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[9px] font-extrabold text-savings">
                            ✅ {t("No deposit")}
                          </span>
                        );
                      }
                      // A deposit is a set of ALTERNATIVES, each of which can be
                      // a BUNDLE. "Original passport, or a copy + ฿3,000" is
                      // two options; the old code joined every fragment with
                      // "or" and told the traveller they could leave a passport
                      // OR ฿3,000 - a cheaper, and wrong, deal. Options are
                      // parsed from the shop's own words (lib/deposit) and only
                      // fall back to the flat fields when none were readable.
                      const opts = parseDeposit(offer.deposit, dCur)?.options ?? [];
                      const fromOptions = opts
                        .map((o) =>
                          o.parts
                            .map((p) =>
                              p.kind === "cash" && p.amount != null
                                ? moneyLocal(p.amount, p.currency || dCur)
                                : p.kind === "cash"
                                  ? t("cash")
                                  : p.kind === "passport_original"
                                    ? t("Original passport")
                                    : p.kind === "passport_copy"
                                      ? t("Passport copy")
                                      : p.kind === "id"
                                        ? t("ID card")
                                        : t("Licence")
                            )
                            .join(" + ")
                        )
                        .filter(Boolean);
                      const doc =
                        type === "passport" ? t("Passport")
                        : type === "id" ? t("ID card")
                        : type === "license" ? t("Licence")
                        : "";
                      let text: string | undefined;
                      if (fromOptions.length) {
                        text = fromOptions.join(` ${t("or")} `);
                      } else {
                        const parts: string[] = [];
                        if (doc) parts.push(doc);
                        if (amt) parts.push(`${moneyLocal(amt, dCur)} ${t("cash")}`);
                        text = parts.length ? parts.join(` ${t("or")} `) : offer.deposit;
                      }
                      const emoji = doc ? "🛂" : "🔒";
                      return (
                        <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[9px] font-extrabold text-brandblue">
                          {emoji} {t("Deposit:")} {text}
                        </span>
                      );
                    })()}
                    {offer.includesDelivery && (
                      <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[9px] font-extrabold text-savings">
                        🛵 {offer.deliveryFee != null && offer.deliveryFee > 0
                          ? `${t("Delivery")} ${moneyLocal(offer.deliveryFee, offer.currency)}`
                          : t("Free delivery")}
                      </span>
                    )}
                    {/* How the traveller gets the vehicle - only when the shop
                        confirmed it.
                        DELIVERY HAS TWO SOURCES, and only one was rendered.
                        `includesDelivery` comes off the extraction; the engine
                        ALSO records a thread-state fulfillment of "delivery"
                        (from the fulfillment-probe answer), and a shop that
                        agreed to deliver mid-conversation set only the second.
                        Those cards showed NO handover chip at all - the one
                        fact the traveller most needs before booking. */}
                    {offer.fulfillment === "delivery" && !offer.includesDelivery && (
                      <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[9px] font-extrabold text-savings">
                        🛵 {t("Delivers to you")}
                      </span>
                    )}
                    {offer.fulfillment === "on-shop" && (
                      <span className="rounded-full bg-card px-2 py-0.5 text-[9px] font-extrabold text-soft">
                        🏪 {t("On shop")}
                      </span>
                    )}
                    {offer.fulfillment === "pickup" && (
                      <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[9px] font-extrabold text-brandblue">
                        🚗 {t("Pickup offered")}
                      </span>
                    )}
                    {offer.includesInsurance && (
                      <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[9px] font-extrabold text-savings">
                        🛡 {t("Insurance included")}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {savings > 0 && (
                <div className="text-right">
                  <div className="badge-flash rounded-full px-2 py-0.5 text-[10px] font-extrabold">
                    🤝 {t("Authentic bargain")}
                  </div>
                  <div className="mt-1 text-lg font-extrabold text-savings">
                    -{curSymbol}
                    <AnimatedNumber value={Math.round(savings)} />
                  </div>
                </div>
              )}
            </div>

            {/* THE VEHICLE, BEFORE THE PRICE.
                A quote whose vehicle is not settled is shown - hiding it would
                be its own kind of lie - but it is never called a deal, and the
                card says exactly what is still being established. Both live
                failures ended with a 110cc on screen as BEST PRICE; the gate
                that produces this note is what makes that unreachable. */}
            {offer.vehicleStatus && offer.vehicleStatus !== "confirmed" && offer.vehicleNote && (
              <div
                className={`mt-2 rounded-xl p-2 text-[11px] font-bold ${
                  offer.vehicleStatus === "wrong-vehicle"
                    ? "bg-brandred-soft text-brandred"
                    : "bg-brandyellow-soft text-warn"
                }`}
              >
                {offer.vehicleStatus === "wrong-vehicle" ? "🚫 " : "🔎 "}
                {t(offer.vehicleNote)}
              </div>
            )}

            {/* THE SHOP'S MENU. When a shop offers a choice ("some models 200
                and some new 250/day"), showing only the one price the app
                picked hides the actual decision from the traveller. Each tier
                gets its own lock/bargain/ask, so the choice is theirs. */}
            {offer.options && offer.options.length >= 2 && (
              <OptionList
                options={offer.options}
                currency={offer.currency}
                durationDays={rfq?.durationDays}
                onLock={(o) => onBook(vendor, o)}
                onBargain={(o) => startBargain(o)}
                onAsk={(o) => {
                  // Reuse the composer the card already owns, pre-filled with
                  // the tier so the traveller edits rather than types.
                  setChatOpen(true);
                  setDraft(
                    `${t("About the")} ${o.model || o.label} ${t("at")} ${o.pricePerDay}/${t("day")} - `
                  );
                }}
              />
            )}

            {/* Deal completeness: the agents keep confirming the deposit and
                how you get the vehicle before the deal is fully ready. We never
                hide the price - just flag what is still being confirmed. */}
            {vendor.stage === "declined" ? (
              <div className="mt-2 rounded-xl bg-card2 p-2 text-[11px] font-bold text-soft">
                🚫 {t("This shop passed on the deal - the offer above was their last word. Other shops are still in play.")}
              </div>
            ) : vendor.languageSwitch === "english" ? (
              // W4.6 - WHY THIS THREAD IS IN ENGLISH. The agent writes to shops
              // in their own local language on purpose; a thread that is NOT is
              // a decision, and the traveller is entitled to the reason. Only
              // ever rendered for an explicit request from the shop - a hunt run
              // in English never sets this.
              <div className="mt-2 rounded-xl bg-brandblue-soft p-2 text-[11px] font-bold text-brandblue">
                🌐 {t("Switched to English - this shop asked")}
                {vendor.languageSwitchQuote ? (
                  <div className="mt-0.5 text-[10px] font-normal italic text-soft">
                    &ldquo;{vendor.languageSwitchQuote}&rdquo;
                  </div>
                ) : null}
              </div>
            ) : vendor.confirming ? (
              // THE AGENT IS NOT SURE, SO IT ASKED (W4.4). Outranks the generic
              // completeness banner below because it is more specific and more
              // urgent: a number on this card may be about to change, and the
              // honest thing is to say we do not trust it yet rather than let
              // the traveller compare on a reading we are still checking.
              <div className="mt-2 rounded-xl bg-brandblue-soft p-2 text-[11px] font-bold text-brandblue">
                💬 {t("Double-checking something with the shop before we trust it.")}
              </div>
            ) : (
              // ONE banner per concern: the vehicle note above already tells
              // the mismatch/confirming story - repeating it here is exactly
              // the duplicated "Confirming this is the automatic 125cc..."
              // pair from the Thailand screenshots.
              stance === "ok" &&
              offer.presentable === false && (
                <div className="mt-2 rounded-xl bg-brandblue-soft p-2 text-[11px] font-bold text-brandblue">
                  💬 {t("Your agent is still confirming the deposit and how you get the vehicle.")}
                </div>
              )
            )}

            {/* THE SHOP ASKED WHERE YOU ARE. Distinct from the pickup offer
                below: this is their question, quoted back, so the traveller
                knows why anyone wants their location before deciding what to
                share. Nothing is sent until they choose in the sheet. */}
            {offer.askedLocationQuote && !offer.pickupConsent && onLocationRequest && (
              <button
                onClick={() => onLocationRequest(vendor)}
                className="mt-2 w-full rounded-xl border-2 border-brandyellow/40 bg-brandyellow-soft p-2.5 text-left"
              >
                <div className="text-[12px] font-extrabold text-warn">
                  📍 {t("This shop asked where you are")}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[11px] italic text-soft">
                  &ldquo;{offer.askedLocationQuote}&rdquo;
                </div>
                <div className="mt-1 text-[11px] font-bold text-brandblue">
                  {t("Choose what to share")} →
                </div>
              </button>
            )}

            {/* Pickup consent: the shop offered to come get you. We share your
                EXACT location only after you approve it here. */}
            {offer.pickupOffered && !offer.pickupConsent && onPickupConsent && (
              <div className="mt-2 rounded-xl border-2 border-brandblue/30 bg-brandblue-soft p-2.5">
                <div className="text-[12px] font-bold text-brandblue">
                  🚗 {t("This shop offers to pick you up. Share your exact location so they can come to you?")}
                </div>
                {pickupState === "shared" ? (
                  <div className="mt-1.5 text-[11px] font-bold text-savings">
                    ✓ {t("Location shared - the shop will arrange your pickup.")}
                  </div>
                ) : (
                  <div className="mt-2 flex gap-2">
                    {/* THROUGH THE SHEET, like every other share.
                        This button used to fire consent DIRECTLY, so the one
                        flow where the shop had actually offered to collect the
                        traveller was the one flow with no choice of WHERE -
                        it silently used the saved stay, and for a traveller
                        without one it simply failed. The sheet is the place
                        that choice lives. */}
                    <button
                      onClick={() => {
                        if (onLocationRequest) onLocationRequest(vendor);
                        else {
                          setPickupState("sending");
                          void onPickupConsent(vendor).then((r) =>
                            setPickupState(r.ok ? "shared" : "failed")
                          );
                        }
                      }}
                      disabled={pickupState === "sending"}
                      className="btn btn-primary flex-1 rounded-xl py-2 text-[12px] disabled:opacity-60"
                    >
                      {pickupState === "sending" ? (
                        <LoadingDots light label={t("Sharing")} />
                      ) : (
                        `📍 ${t("Share my location")}`
                      )}
                    </button>
                    <button
                      onClick={() => setPickupState("idle")}
                      className="btn btn-sm rounded-xl border-2 border-line px-3 py-2 text-[12px] font-bold text-soft"
                    >
                      {t("No thanks")}
                    </button>
                  </div>
                )}
                {pickupState === "failed" && (
                  <div className="mt-1.5 text-[11px] font-bold text-brandred">
                    {/* HONEST FAILURE. The old copy blamed the device ("allow location
                        access") for a server-side share the browser's
                        geolocation never touches - so the traveller went
                        hunting through iOS settings for a permission that was
                        never involved. */}
                    {t("Could not share that just now - try again in a moment.")}
                  </div>
                )}
              </div>
            )}

            <div className="mt-3 flex items-center gap-2">
              {/* You can never LOCK a price that is for the wrong vehicle -
                  that CTA stays. The manual "Confirm the model" button is
                  GONE: model verification is the agent's job, end to end
                  (thread-level confirmation resolves it automatically), and
                  the button never confirmed anything anyway - it opened the
                  generic bargain composer. An unverified offer is a real,
                  lockable offer wearing an honest badge. */}
              {stance === "mismatch" ? (
                <button
                  onClick={() => startBargain()}
                  disabled={agentBusy}
                  aria-disabled={agentBusy}
                  className="btn btn-primary flex-1 rounded-2xl px-3 py-2.5 text-sm disabled:opacity-60"
                >
                  {agentBusy ? agentBusyLabel(agentPending, t) : `🔎 ${t("Ask for the right vehicle")}`}
                </button>
              ) : (
                <>
                  <button
                    onClick={() => onBook(vendor)}
                    className="btn btn-primary flex-1 rounded-2xl px-3 py-2.5 text-sm"
                  >
                    {t("Lock this deal")}
                  </button>
                  {vendor.stage !== "declined" && (
                    <button
                      onClick={() => startBargain()}
                      // GATED LIKE THE RFQ BUTTON TWENTY LINES BELOW, which has
                      // always been. While the agent has a message of its own
                      // queued for this shop, a second push is a double message
                      // - and "queued" is a status, not a call to action, so it
                      // reads as a muted chip rather than a live button.
                      disabled={agentBusy}
                      aria-disabled={agentBusy}
                      className={`btn btn-sm chip rounded-2xl border-2 px-3 py-2.5 text-[12px] font-extrabold ${
                        agentBusy
                          ? "cursor-default border-line bg-card2 text-soft disabled:opacity-100"
                          : "border-brandred/30 bg-brandred-soft text-brandred"
                      }`}
                    >
                      {agentBusy ? agentBusyLabel(agentPending, t) : `🥊 ${t("Bargain")}`}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ) : facts?.replyUnparsed && !vendor.cancelled ? (
          /* REPLIED, BUT NOT UNDERSTOOD (owner problem #8). A blank card is
             ambiguous and looks like a rendering bug; this state says exactly
             what happened - the shop answered, no price could be read - quotes
             the shop's own words, shows any terms that WERE understood, and
             offers a real next action instead of a dead passive button. */
          <div className="mt-3 rounded-2xl border-2 border-brandyellow/50 bg-brandyellow-soft p-3">
            <div className="text-[12px] font-extrabold text-warn">
              💬 {t("The shop replied, but the price is unclear")}
            </div>
            {(facts.replyEnglish || facts.replyText) && (
              <p className="mt-1 text-[12px] leading-snug text-strong">
                &ldquo;{(facts.replyEnglish ?? facts.replyText ?? "").slice(0, 160)}&rdquo;
              </p>
            )}
            {(facts.depositType || facts.deposit || facts.delivers === true || facts.insuranceIncluded === true) && (
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10.5px] font-bold text-soft">
                {(facts.depositType || facts.deposit) && (
                  <span className="rounded-lg bg-card px-1.5 py-0.5">
                    🔐 {t("Deposit")}: {facts.deposit ?? facts.depositType}
                  </span>
                )}
                {facts.delivers === true && (
                  <span className="rounded-lg bg-card px-1.5 py-0.5">🛵 {t("Delivers")}</span>
                )}
                {facts.insuranceIncluded === true && (
                  <span className="rounded-lg bg-card px-1.5 py-0.5">🛡 {t("Insurance included")}</span>
                )}
              </div>
            )}
            <p className="mt-1.5 text-[11px] leading-snug text-soft">
              {t("Your agent keeps working on it. You can also nudge the shop for a number now.")}
            </p>
            <button
              onClick={sendRfq}
              disabled={!waConnected || rfqState === "sending" || queuedActive}
              className="btn mt-2 w-full rounded-2xl border-2 border-line bg-card py-2 text-[12px] font-extrabold text-strong disabled:opacity-60"
            >
              {rfqState === "sending" ? (
                <LoadingDots label={t("Sending")} />
              ) : (
                `🔁 ${t("Ask for the price again")}`
              )}
            </button>
          </div>
        ) : (
          <div className="mt-3 rounded-2xl bg-card2 p-3">
            <div className="text-[12px] font-bold text-soft">
              {/* STAGE-AWARE (D3). "We first ask the shop" was rendered for a
                  thread DEEP in negotiation (the ask long sent, price lists
                  received) - the copy reported the missing offer object, not
                  the conversation. Say where this thread actually is. */}
              {t(
                vendor.stage === "declined"
                  ? "This shop said no. Nothing further is being asked here."
                  : vendor.stage === "out-of-stock"
                    ? "Nothing available here right now - your agent asked when one is back."
                    : vendor.stage === "negotiating" || vendor.stage === "counter-offer"
                      ? "The shop replied - your agent is pinning the exact price down. It lands here the moment it's stated."
                      : // REPLIED IS NOT NEGOTIATING. This line claimed a price
                        // was being pinned down over a shop that had said
                        // "hello" - the caption the owner photographed - because
                        // any inbound promoted the card to `negotiating`. The
                        // ledger draws the line on whether the reply carried an
                        // actionable fact; the copy now respects it.
                        vendor.stage === "replied"
                        ? "The shop answered - your agent is reading their reply."
                        : vendor.stage === "rfq-sent" ||
                            vendor.stage === "awaiting-response" ||
                            vendor.stage === "sending" ||
                            askDone
                          ? "Price asked - the shop's reply lands here."
                          : "No price yet - we first ask the shop. Real prices come only from its reply."
              )}
            </div>
            {plan === "free" && (
              <div className="mt-1.5 text-[11px] font-bold text-brandyellow">
                {t("Free plan: same-day pickup scheduling only.")}
              </div>
            )}

            <div className="mt-2">
              <button
                onClick={sendRfq}
                // A message that is sending OR already queued/sent can NEVER be
                // re-fired: queuedActive must gate the button (a queued row is
                // committed - tapping again would enqueue a duplicate).
                //
                // TERMINAL IS TERMINAL TOO (the green-button trap's remainder).
                // A declined or out-of-stock card kept a LIVE green "Ask for
                // price" over copy explaining nothing had been asked - the shop
                // had answered and said no. Tapping it re-asks a shop that
                // already refused, which is both a wasted send on a rate-limited
                // personal number and a message the traveller did not intend.
                disabled={
                  !waConnected || rfqState === "sending" || askDone || queuedActive || cardTerminal
                }
                aria-disabled={
                  !waConnected || rfqState === "sending" || askDone || queuedActive || cardTerminal
                }
                className={`btn w-full rounded-2xl py-2.5 text-[13px] font-extrabold ${
                  (queuedActive || askDone || cardTerminal) && rfqState !== "sending"
                    ? // Queued AND "sent, waiting for a reply" are both STATUSES,
                      // not calls to action: a muted, clearly non-interactive
                      // chip, never the green primary. "Sent - reply lands here"
                      // in the green primary invited taps on an element that
                      // does nothing (the green-button trap).
                      "cursor-default bg-card2 text-soft disabled:opacity-100"
                    : `text-white disabled:opacity-60 ${
                        waConnected ? "bg-savings hover:brightness-95" : "bg-faint"
                      }`
                }`}
              >
                {rfqState === "sending" ? (
                  <LoadingDots light label={t("Sending")} />
                ) : cardTerminal ? (
                  vendor.stage === "declined" ? t("Shop said no") : t("None available now")
                ) : queuedActive ? (
                  // Queued is queued - it must NEVER read as "Sent", even
                  // after a remount (queuedActive derives from server state),
                  // and the reason is the guard's real one, never a guess.
                  `🕘 ${t(queueReasonLabel(vendor.queuedReason))}`
                ) : askDone ? (
                  // A reply has ALREADY landed once lastInboundAt is set - the
                  // "reply lands here" promise is stale then, and the card is
                  // showing the reply above. Say what is true.
                  vendor.lastInboundAt ? t("Reply received") : t("Sent - reply lands here")
                ) : waConnected ? (
                  t("Ask for price")
                ) : (
                  `🔒 ${t("Ask for price")}`
                )}
              </button>
              {!waConnected && (
                <a
                  href="/profile"
                  className="mt-1 block text-center text-[10px] font-bold text-brandblue underline"
                >
                  {t("Connect WhatsApp in Profile to unlock")} →
                </a>
              )}
            </div>

            {rfqState === "sent" && (
              <div className="mt-1.5 text-[11px] font-bold text-savings">
                {t("Sent from inside the app. When the shop answers, the agent reads it and the price appears here automatically.")}
              </div>
            )}
            {rfqState === "no-phone" && (
              <div className="mt-1.5 text-[11px] text-faint">
                {t("No phone number found for this shop yet - try another shop nearby.")}
              </div>
            )}
            {rfqState === "not-connected" && (
              <div className="mt-1.5 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-warn">
                {t("Nothing was sent. Connect your WhatsApp first - it takes 30 seconds and the agents handle everything after that.")}
                <a
                  href="/profile"
                  className="btn btn-sm mt-1.5 block w-full rounded-lg bg-card py-1.5 text-center text-[11px] font-extrabold text-brandblue"
                >
                  {t("Connect WhatsApp in Profile")} →
                </a>
              </div>
            )}
            {rfqState === "rate-limited" && (
              <div className="mt-1.5 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-warn">
                {rfqError ?? t("Taking a short break - try again in a few minutes.")}
              </div>
            )}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between">
          <button
            onClick={() => waConnected && setChatOpen((o) => !o)}
            disabled={!waConnected}
            className={`btn btn-sm text-[12px] font-bold ${
              waConnected ? "text-brandblue" : "text-faint"
            }`}
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="send" className="h-3.5 w-3.5" />{" "}
              {waConnected
                ? t("Message this shop yourself")
                : `🔒 ${t("Message this shop yourself")}`}
            </span>
          </button>
        </div>

        {galleryOpen && vendor.photoUrls && (
          <PhotoGallery
            name={vendor.name}
            photos={vendor.photoUrls}
            onClose={() => setGalleryOpen(false)}
          />
        )}

        {chatOpen && (
          <div className="mt-2 rounded-2xl border-2 border-brandblue/40 bg-card p-3">
            {/* THIS IS NOT A NOTE TO YOUR AGENT.
                What the traveller types here goes to the shop word for word,
                on WhatsApp, from their own number - and they were not told.
                One typed "Ask if he can give me 2 helmets" expecting Will to
                relay it, and the shop received exactly that sentence. So say
                it plainly, show the words as the shop will see them, and put
                the shop's name on the send button. */}
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-extrabold text-strong">
              <Icon name="whatsapp" className="h-3.5 w-3.5 text-[#25D366]" />
              {t("Your words go straight to the shop")}
            </div>
            <p className="mb-2 text-[10.5px] font-semibold leading-snug text-soft">
              {t(
                "Type it the way you want them to read it - we send this exact text to the shop on WhatsApp, from your number. To tell your agent what to do instead, use Ask Will."
              )}
            </p>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              maxLength={600}
              placeholder={t("e.g. Can you include 2 helmets at that price?")}
              className="w-full resize-none rounded-xl border-2 border-line bg-card2 p-2 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
            {/* Exactly what will land in their chat - no surprises. */}
            {draft.trim() && (
              <div className="mt-1.5 rounded-xl bg-[#25D366]/10 p-2">
                <div className="text-[9.5px] font-extrabold uppercase tracking-wide text-savings">
                  {t("The shop will receive")}
                </div>
                {/* ON A LOCAL-LANGUAGE HUNT THIS IS NOT WHAT THEY RECEIVE.
                    The traveller's own line used to be the ONE message that
                    went out in English while the agent wrote Thai in the same
                    thread - one person, two languages, one message apart. It is
                    translated now, which means the preview above is the
                    MEANING, not the words. Say so rather than let the panel
                    quietly become wrong. */}
                {localLang && (
                  <div className="mt-0.5 text-[9.5px] font-bold text-brandblue">
                    🌐 {t("Sent in the shop's language - you'll see both versions after it goes.")}
                  </div>
                )}
                <div className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] font-semibold text-strong">
                  {draft.trim()}
                </div>
              </div>
            )}
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-bold text-soft">
              <Icon name="shield" className="h-3 w-3 text-savings" />
              {t("Checked for anything unsafe first - nothing else is changed.")}
            </div>
            {chatState.status === "blocked" && (
              <div className="mt-1 rounded-xl bg-brandred-soft p-2 text-[12px] font-semibold text-brandred">
                {chatState.reason ?? t("Message blocked.")}
                {chatState.suggestion && (
                  <div className="mt-1 opacity-80">
                    {t("Try:")} {chatState.suggestion}
                  </div>
                )}
              </div>
            )}
            {chatState.status === "sent" && (
              <div className="mt-1 text-[12px] font-bold text-savings">✓ {t("Sent")}</div>
            )}
            {chatState.status === "queued" && (
              <div className="mt-1 text-[12px] font-bold text-brandblue">
                🕘 {t("Queued - it goes out automatically, you'll see it in the queue below")}
              </div>
            )}
            <button
              onClick={sendCustom}
              disabled={chatState.status === "checking" || !draft.trim()}
              className="btn btn-primary mt-2 w-full rounded-xl py-2 text-sm disabled:opacity-50"
            >
              {chatState.status === "checking" ? (
                <LoadingDots light label={t("Screening")} />
              ) : (
                `${t("Send to")} ${vendor.name}`
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Memoised: with stable handler identities from the page, a card only
// re-renders when ITS vendor object (or the search context) changes - key for
// long result lists on low-end phones.
export const VendorCard = memo(VendorCardInner);
