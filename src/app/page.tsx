"use client";

import { useCallbackRef } from "@/components/useCallbackRef";
import { useRouter } from "next/navigation";
import { useHeaderCollapse } from "@/components/useHeaderCollapse";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Vendor,
  StructuredRFQ,
  Session,
  TrackerStage,
  Offer,
  VehicleOption,
  OutreachReply,
} from "@/lib/types";
import { offerForOption } from "@/lib/offer-options";
import {
  trackerStageForLedger,
  LEDGER_TERMINAL_CARD_STAGES,
} from "@/lib/client/ledger-stage";
import { stageRank } from "@/lib/client/stage-order";
import { vehicleLabel } from "@/lib/labels";
import { Icon } from "@/components/icons";
import { Filters, DEFAULT_FILTERS, type FilterState } from "@/components/Filters";
import { VendorCard } from "@/components/VendorCard";
import { StatusFab } from "@/components/StatusFab";
import { BrandPulse } from "@/components/BrandPulse";
import { ShopAvatar, clearShopAvatars } from "@/components/ShopAvatar";
const BookingSheet = dynamic(
  () => import("@/components/BookingSheet").then((m) => m.BookingSheet),
  { ssr: false }
);
import { AnimatedNumber } from "@/components/SavingsTicker";
import { TabBar } from "@/components/TabBar";
const FeedbackModal = dynamic(
  () => import("@/components/FeedbackModal").then((m) => m.FeedbackModal),
  { ssr: false }
);
import { GoogleWordmark } from "@/components/GoogleWordmark";
import { Modal } from "@/components/Modal";
import { BrandMark } from "@/components/BrandMark";
import { WillAvatar } from "@/components/will/WillAvatar";
import { OriginPicker, type Origin } from "@/components/OriginPicker";
import { RequestBuilder } from "@/components/RequestBuilder";
import { RentalWindowField, usePlanWindow } from "@/components/RentalWindowField";
import { FaqSection } from "@/components/FaqSection";
import { SiteFooter } from "@/components/SiteFooter";
import { SearchSummaryBar } from "@/components/SearchSummaryBar";
import { can } from "@/lib/entitlements";
import { checkAction, outcomeFor, compareOutcome, type ActionOutcome } from "@/lib/actions/registry";
import { FixedLayer } from "@/components/FixedLayer";
import { saveSearch } from "@/lib/client/search-persist";
import { isSessionFresh, SEARCH_SESSION_TTL_MS } from "@/lib/session-life";
import { fetchJson } from "@/lib/client/fetch-json";
import { reconcileList, reconcileRecord, staggerIndex } from "@/lib/client/reconcile";
import { dismissalKey, loadDismissals, saveDismissals } from "@/lib/client/dismissals";
import { sendProgress } from "@/lib/batch-progress";
// F4's funnel bar and its type. NOTE the division of labour, because merging
// these two would recreate the defect F4 exists to avoid: `sendProgress`
// answers "what is still waiting and when does it leave" (dispatch timing, from
// the queue rows); `BatchProgress` answers "how far through reaching shops and
// collecting quotes am I" (the funnel, derived once on the server). Different
// questions, different denominators, and neither is allowed to restate the
// other's number.
import BatchProgressBar from "@/components/BatchProgressBar";
import type { BatchProgress } from "@/lib/progress";
import { formatClock } from "@/lib/clock";

// W2: honest queue ETA label. A due row never shows a past clock time - it
// shows the paced-slot copy; otherwise a "~10:20-10:25" envelope (collapsed to
// a single time when both ends land in the same minute).
function etaRangeLabel(
  from: string | undefined,
  to: string | undefined,
  due: boolean,
  notBefore: string,
  t: (s: string) => string
): string {
  if (due) return t("sending at the next safe slot - paced to protect your number");
  const start = from ?? (notBefore || undefined);
  if (!start) return "";
  const a = formatClock(start);
  // A far-out hold must read as a WAIT, not as a clock promise: a bare
  // "~05:38" on an overnight park scans as minutes away. Past ~75 minutes
  // the label leads with the magnitude and keeps the clock as detail.
  const startMs = Date.parse(start);
  const waitMin = Math.round((startMs - Date.now()) / 60_000);
  if (Number.isFinite(startMs) && waitMin >= 75) {
    const hours = Math.max(1, Math.round(waitMin / 60));
    return `${t("sends in about")} ${hours} ${t("h")} (~${a})`;
  }
  const b = to ? formatClock(to) : a;
  return a === b ? `~${a}` : `~${a}-${b}`;
}
import { ActivityFeed, type FeedItem } from "@/components/activity/ActivityFeed";
import { WhyThisSheet } from "@/components/activity/WhyThisSheet";
import { TranscriptSheet } from "@/components/activity/TranscriptSheet";
// Heavy full-screen surface, opened on demand - out of the route's first
// parse, like MapView below. No ssr: it renders only after a tap.
// L8 (owner report 6): every tap-gated overlay below follows the same rule -
// none of them belongs in the route's first parse. Each loads on first open.
const ThreadDashboard = dynamic(
  () => import("@/components/ThreadDashboard").then((m) => m.ThreadDashboard),
  { ssr: false }
);
import { LocationShareSheet } from "@/components/LocationShareSheet";
import { WaSafetyBadge, type WaSafety } from "@/components/WaSafetyBadge";
import { useWill } from "@/lib/useWill";
import type { WillContext } from "@/lib/will-commands";
import { WillSheet } from "@/components/will/WillSheet";
import { WillGuideOverlay, type WillAction } from "@/components/will/WillGuideOverlay";
import { useWillAssistant } from "@/components/will/WillAssistantProvider";
import { deriveWillStep } from "@/lib/will-assistant";
import { CompareSheet } from "@/components/will/CompareSheet";
import { ReviewsSheet } from "@/components/ReviewsSheet";
const UpgradeSheet = dynamic(
  () => import("@/components/UpgradeSheet").then((m) => m.UpgradeSheet),
  { ssr: false }
);
const BargainDraftModal = dynamic(
  () => import("@/components/BargainDraftModal").then((m) => m.BargainDraftModal),
  { ssr: false }
);
const Onboarding = dynamic(
  () => import("@/components/Onboarding").then((m) => m.Onboarding),
  { ssr: false }
);
import { AdBanner } from "@/components/AdBanner";
import { LoadingDots } from "@/components/LoadingDots";
import { AgentKillSwitch } from "@/components/AgentKillSwitch";
import { AlertsChip } from "@/components/AlertsChip";
import { WaLockVeil } from "@/components/WaLockVeil";
import { probeWaStatus } from "@/lib/wa-status";
import { startNav } from "@/components/NavVeil";
import { raiseAmbient, lowerAmbient } from "@/components/AmbientGlow";
import { WaitGame } from "@/components/WaitGame";
import { LanguageButton } from "@/components/LanguageButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useI18n } from "@/lib/i18n";
import { moneyLocal, currencySymbol } from "@/lib/currency";
import { depositSummary } from "@/lib/deposit";
import { cheapestPresentable, offerConfidence } from "@/lib/offer-presentation";
import { digitsOnly } from "@/lib/phone";
import { addDays, deviceTimeZone } from "@/lib/rental-window";
import { massBargainTargets, massBargainCap } from "@/lib/mass-bargain";
import { MassBargainPreview } from "@/components/MassBargainPreview";
import { VirtualVendorList } from "@/components/VirtualVendorList";
import { QuotesRail } from "@/components/QuotesRail";
import { HorizontalVendorRail } from "@/components/HorizontalVendorRail";
import { loadPublicConfig } from "@/lib/client/public-config";

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <LoadingDots label="Loading map" />
    </div>
  ),
});

// Dozens of ready-made searches; each visit shows a random 3-4 of them so the
// home screen always feels fresh.
const ALL_EXAMPLES = [
  "125cc automatic scooter with a phone mount, under 20,000 km, for 3 days",
  "Automatic SUV, 5 seats, 5 days, GPS + child seat, cheapest possible",
  "Economy automatic car, 7 days, hotel delivery, best price",
  "Manual motorcycle with helmet and storage box, cheapest possible, 1 week",
  "160cc scooter (NMax or PCX), 2 helmets, 5 days, delivery to my hotel",
  "Cheap 110cc scooter for 2 weeks, long-term discount",
  "Automatic scooter for 1 day, need it in the next hour",
  "300cc manual motorcycle, 3 days, helmet + gloves",
  "Big bike 650cc+, weekend ride, 2 days",
  "7-seater van, airport pickup, 4 days, cheapest",
  "Luxury sedan for 2 days, wedding, white if possible",
  "Small automatic car, 10 days, unlimited mileage",
  "Scooter with 2 helmets and a child seat, 4 days",
  "125cc scooter, month-long rental, best monthly rate",
  "4x4 SUV for a mountain trip, 3 days, full insurance",
  "Manual motorcycle 150cc, 5 days, phone mount + raincoat",
  "Electric scooter or small EV, 2 days, city only",
  "Automatic car with GPS, 6 days, hotel delivery, no deposit if possible",
  "Vespa-style scooter, 3 days, photo-friendly color",
  "Cheapest anything with 2 wheels for tomorrow, 1 day",
  "Sedan with driver-quality comfort, 8 days, best total price",
  "Scooter under 15,000 km with new tires, 1 week",
  "Motorbike for two people with top box, 5 days",
  "Compact car, 3 days, need child booster seat",
];

// Free plan is today-pickup only, so never suggest future-scheduling searches.
const FUTURE_HINT = /tomorrow|next (hour|day|week)|weekend|month|long-term|\d+ weeks?/i;

/**
 * How coarsely the measured clock skew is allowed to reach the render tree.
 *
 * A real device clock is wrong by minutes or not at all; it does not drift by
 * 400ms between two polls eight seconds apart. Anything finer than this is
 * network noise, and network noise passed as a prop is what re-rendered the
 * whole vendor board and restarted every child poll on every tick.
 *
 * 30s is well below the drift that actually eats replies (the bug this
 * correction exists for was a phone minutes fast) and far above the jitter.
 */
const SKEW_STEP_MS = 30_000;
function pickExamples(plan?: string): string[] {
  const pool =
    plan === "free" ? ALL_EXAMPLES.filter((e) => !FUTURE_HINT.test(e)) : ALL_EXAMPLES;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3 + Math.floor(Math.random() * 2)); // 3-4 chips
}

export default function Home() {
  // Client-side navigation: the tab hop keeps the React tree alive, so the
  // destination paints from cache instead of re-parsing the whole bundle.
  const router = useRouter();
  const { t, tShared, lang } = useI18n();
  const [session, setSession] = useState<Session | null>(null);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [originHint, setOriginHint] = useState<string | null>(null);
  const [radiusKm, setRadiusKm] = useState(8);
  const [examples, setExamples] = useState<string[]>(ALL_EXAMPLES.slice(0, 4));
  const [rawText, setRawText] = useState(ALL_EXAMPLES[0]);
  const [rfq, setRfq] = useState<StructuredRFQ | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [source, setSource] = useState<"google" | "demo" | "google-error" | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  // "profiling" and "discovering" are separate because they ARE separate waits.
  // One label covered both, so a slow shop lookup was reported as "Structuring
  // your request" for a minute - the app describing the wrong stage of itself.
  const [phase, setPhase] = useState<
    "idle" | "profiling" | "discovering" | "running" | "done"
  >("idle");
  const [view, setView] = useState<"list" | "map" | "activity">("list");
  // THE LIST'S AXIS (owner report 3, item 12): the same vendor cards, swiped
  // sideways or scrolled down - the traveller's choice, remembered across
  // sessions like the language (wd_local_lang pattern). Default vertical.
  const [listAxis, setListAxisState] = useState<"vertical" | "horizontal">("vertical");
  useEffect(() => {
    try {
      if (localStorage.getItem("wd_list_axis") === "horizontal") setListAxisState("horizontal");
    } catch {}
  }, []);
  const setListAxis = (a: "vertical" | "horizontal") => {
    setListAxisState(a);
    try {
      localStorage.setItem("wd_list_axis", a);
    } catch {}
  };
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bookingVendor, setBookingVendor] = useState<Vendor | null>(null);
  const [reviewsVendor, setReviewsVendor] = useState<Vendor | null>(null);
  const [bargainVendor, setBargainVendor] = useState<Vendor | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  // TRI-STATE: null = still checking (first paint), true = linked, false =
  // confirmed unlinked. Starting at null kills the "NOT CONNECTED / Pair
  // WhatsApp" flash that showed for a beat on every load before the status
  // call answered.
  const [waConnected, setWaConnected] = useState<boolean | null>(null);
  // Did the status read ever ACTUALLY answer? Distinct from `waConnected`,
  // because "we could not reach our own API" and "you are not linked" are
  // different facts and only the second one may draw the lock.
  const [waReachable, setWaReachable] = useState(true);
  const [massState, setMassState] = useState<"idle" | "running" | "done">("idle");
  const [massNote, setMassNote] = useState<string | null>(null);
  /** Row the list should bring into view - see VirtualVendorList's prop. */
  // A SCROLL REQUEST, NOT A POSITION.
  //
  // This was a bare index, and setting state to the value it already holds is a
  // React bail-out - so the effect in VirtualVendorList did not re-run and
  // jumping to the SAME shop a second time did nothing at all. Tap a shop under
  // "Offers & negotiations", scroll away to read others, tap the same shop
  // again: silence. Every other shop still worked, which made it read as
  // random. The rAF fallback could not save it either, because the list is
  // windowed and a row scrolled out of view has no DOM node.
  //
  // The nonce makes each request distinct, so a repeat jump is a new request.
  const [scrollRequest, setScrollRequest] = useState<{ index: number; nonce: number } | null>(
    null
  );
  const scrollNonceRef = useRef(0);
  /** The pre-dispatch preview: who the run picked, before anything is sent. */
  const [massPreview, setMassPreview] = useState<{
    targets: Vendor[];
    eligibleCount: number;
    cap: number;
  } | null>(null);
  // The premium beta-quality note shown before a mass bargain runs.
  const [massInfoOpen, setMassInfoOpen] = useState(false);
  // Ultra option: let the agents bargain in the shop's LOCAL language. OFF by
  // default (optional), persisted, and gated - free/pro see the upgrade sheet.
  const [localLang, setLocalLang] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [restored, setRestored] = useState(false);
  // Progressive disclosure: once results are in, the big search card folds
  // into a one-row summary (the form stays mounted so tour anchors survive).
  const [formOpen, setFormOpen] = useState(true);
  const [builderOpen, setBuilderOpen] = useState(false);
  // Live structured selections from the tap builder. Non-null = STRUCTURED MODE:
  // the free-text box greys out and the ONE bottom "Find my deal" button runs
  // the structured search (input-mode disambiguation, owner directive).
  const [builderFields, setBuilderFields] = useState<Partial<StructuredRFQ> | null>(null);
  // W-7: THE RENTAL WINDOW IS THE PAGE'S, NOT THE TAP BUILDER'S.
  //
  // "From" and "For" were private state inside RequestBuilder, which is mounted
  // only under `{builderOpen && ...}`. Typing a request - the default mode -
  // therefore never asked WHEN, and the page posted `{ text, timeZone }` to
  // /api/profile while that route's free-text branch destructured a
  // `durationDays` no client had ever sent. Both modes now read and write these
  // two values, so they cannot describe different trips.
  const planWindow = usePlanWindow(session?.plan);
  const [startDate, setStartDate] = useState("");
  const [days, setDays] = useState(4);
  // Whether the traveller has ACTUALLY touched the window - TWO controls, TWO
  // flags. It matters: the control always shows a date, but an untouched default
  // must not out-rank a date the profiler read from their own words ("from the
  // 20th for a week"). Touched, it wins - a visible control that a hidden parse
  // silently overrides is the same class of lie this whole item is about.
  //
  // W9: ONE flag for both was the bug. Either handler set it, so a single tap on
  // the DATE picker promoted the untouched 4-day default into an explicit
  // duration override: "scooter for a week from the 20th" shipped as a 4-day
  // rental, and the "we searched for N days, not M" note could not fire because
  // the app had asked for 4 and got 4. The symmetric case (tap the stepper,
  // lose a stated date) was just as reachable.
  const [startTouched, setStartTouched] = useState(false);
  const [daysTouched, setDaysTouched] = useState(false);
  // What the SERVER did to the window on the last search. `clampRfqWindow` has
  // always returned a `reason`; every caller discarded it, so a clamped date
  // just looked like a typo the traveller had made.
  const [windowNote, setWindowNote] = useState<string | null>(null);
  // The plan window resolves after mount (the device zone is not the server's),
  // so the picker starts empty and adopts the soonest bookable day once known.
  useEffect(() => {
    setStartDate((d) => (d && d >= planWindow.startDate && d <= planWindow.maxStartDate ? d : planWindow.startDate));
  }, [planWindow.startDate, planWindow.maxStartDate]);
  // IDP disclaimer (owner directive): search stays disabled until the traveller
  // declares they hold a valid International Driving Permit for the category.
  //
  // NEVER PERSISTED, AND RESET AFTER EVERY SEARCH. It used to be remembered in
  // localStorage, so one tick months ago silently spoke for every search since -
  // including searches for a DIFFERENT vehicle category, which is precisely the
  // thing the declaration is about. A declaration is an act, not a preference:
  // it has to be made about the request actually being sent, by the person
  // sending it, at the moment they send it. Anything else is us asserting
  // something on their behalf.
  const [idpConsent, setIdpConsent] = useState(false);
  const structuredMode = builderOpen && Boolean(builderFields?.vehicleClass);
  // Card windowing: render the first batch and reveal more on demand - keeps
  // long result lists cheap on low-end phones.
  // Live status panel (expandable) + user-facing queued-message list (bug #1/#9).
  const [statusOpen, setStatusOpen] = useState(false);
  // AUTO-EXPAND once sending actually begins (issue 5.2): the live progress is
  // the whole point of the panel, and defaulting it closed meant the user
  // watched a static summary while messages were flying. Fires once per search
  // so a deliberate collapse is never fought.
  const autoOpenedRef = useRef(false);
  // Play-while-you-wait mini-game + closed-app reply alerts (Web Push).
  const [showGame, setShowGame] = useState(false);
  // Living workspace: the cross-shop activity feed + honest WA safety state,
  // all from ONE /api/activity poll (which also replaced the queue poll).
  const [activityItems, setActivityItems] = useState<FeedItem[]>([]);
  const [waHealth, setWaHealth] = useState<WaSafety | null>(null);
  const [whyByVendor, setWhyByVendor] = useState<Record<string, string>>({});
  // F9: which shops the AGENT already has a queued message for. The queue
  // payload carries intro kinds only (by design - an agent's counter-reply is
  // part of the conversation, not of the "your messages are going out" panel),
  // so until this rollup the client could not see agent activity at all and
  // the Bargain button had nothing to gate on.
  const [agentPending, setAgentPending] = useState<Record<string, { count: number; sending: boolean; own?: boolean }>>({});
  const [whyDecision, setWhyDecision] = useState<string | null>(null);
  const [transcriptFor, setTranscriptFor] = useState<{ id: string; name: string } | null>(null);
  const [dashboardFor, setDashboardFor] = useState<Vendor | null>(null);
  /** A shop a push asked us to open, held until the vendor list is restored. */
  const pendingShopRef = useRef<string | null>(null);
  // The shop asked where the traveller is - the sheet that lets them choose
  // what to answer. Nothing is shared until they pick.
  const [locationAskFor, setLocationAskFor] = useState<Vendor | null>(null);
  // Live-poll health. clockSkewRef corrects `since` against the SERVER clock
  // (the filter runs on server timestamps); feedStale surfaces a failing poll
  // instead of freezing the screen on a stale snapshot.
  const clockSkewRef = useRef(0);
  // ...AND THE QUANTIZED COPY THE RENDER TREE IS ALLOWED TO SEE.
  //
  // The raw skew is `serverNow - Date.now()`, where serverNow is stamped at the
  // END of the /api/activity handler - so it carries the full response transit
  // and JSON parse, on an endpoint that awaits up to ~16s of drain work. It
  // therefore moves by tens to thousands of milliseconds on EVERY poll, and the
  // page re-renders on every poll regardless.
  //
  // That number was passed as a prop to every memoised child. `VendorCard` is
  // memo()'d with a shallow compare; vendors keep identity through
  // reconcileList, agentPending through reconcileRecord, handlers through
  // useCallbackRef - every other memo-stability defence in this file holds, and
  // then one jittering number broke all of them, re-rendering the whole board
  // twice per poll cycle. Worse, it is an effect DEPENDENCY downstream:
  // ThreadPeek, ThreadDashboard and TranscriptSheet all key their polls on it,
  // so each tick tore down and rebuilt those effects - aborting the in-flight
  // request every ~6s, which on a slow connection meant the conversation peek
  // never completed at all.
  //
  // Quantized, it changes ~never, so identity holds. FLOOR rather than round:
  // the epoch feeds `since=` filters, and an epoch that can only move EARLIER
  // widens the window. A later epoch would drop replies, which is the exact
  // failure the skew correction exists to prevent.
  const [clockSkew, setClockSkew] = useState(0);
  const [feedStale, setFeedStale] = useState(false);
  // Will - the conversational layer. Session pause + compare live here too.
  const [willOpen, setWillOpen] = useState(false);
  // W7: per-stage dismissal of the inline Will guide. Dismissing hides the
  // banner for THAT stage only (persisted for the session); a stage change
  // resurfaces it - it is guidance, not chrome. A small summon chip stays so
  // Will is always one tap away.
  const [dismissedStages, setDismissedStages] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("wd_will_dismissed");
      if (raw) setDismissedStages(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* private mode - in-memory only */
    }
  }, []);
  const dismissWillStage = useCallbackRef((stage: string) => {
    setDismissedStages((prev) => {
      const next = new Set(prev).add(stage);
      try {
        sessionStorage.setItem("wd_will_dismissed", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  });
  const [paused, setPaused] = useState(false);
  // The VERSION of `paused`. Pause state is cached per server instance, so a
  // poll answered by a different instance right after a resume carries the
  // pre-resume value - old, not wrong. The version is what lets the switch tell
  // the difference instead of flipping itself back (see lib/versioned).
  const [pausedVersion, setPausedVersion] = useState(0);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  // Poll cadence from the server (SCALE_MODE stretches these under load). Fast
  // by default so a shop's WhatsApp reply surfaces in the app within seconds
  // (owner: "it should be instant") - the focus/visibility wake forces an
  // immediate refresh on top of this.
  const [pollCfg, setPollCfg] = useState({ activityMs: 6000, repliesMs: 6000, tagsMs: 120000 });
  useEffect(() => {
    let alive = true;
    void loadPublicConfig().then((d) => {
      if (alive && d.poll?.activityMs) setPollCfg(d.poll);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Fold the search card away when the agents take over the screen; a phase
  // transition re-collapses it, a tap on the summary row re-opens it.
  useEffect(() => {
    if (phase === "running" || phase === "done") setFormOpen(false);
    // A NEW HUNT STARTS AT THE TOP. The windowed list has no page counter to
    // reset any more, but a stale scroll target from the previous search would
    // still fire once the new vendors land.
    if (phase === "profiling" || phase === "discovering") setScrollRequest(null);
  }, [phase]);
  const formCollapsed = !formOpen && vendors.length > 0 && (phase === "running" || phase === "done");

  // A shop with a MENU hands the chosen tier along with the vendor. Apply it to
  // the offer before anything downstream reads a price: the booking sheet, the
  // server-side total and the bargain draft all take `offer.pricePerDay`
  // directly, so a tier carried alongside would book the wrong bike.
  // STABLE HANDLER IDENTITY. This used to be called inline in the render -
  // `onBook={pickVendorOption(setBookingVendor)}` - which built a brand-new
  // function on every render and handed it to a memo'd VendorCard. The memo
  // could therefore never hold: one changed field on one shop re-rendered every
  // card on the board, twice per poll cycle, which is what made the list feel
  // like scrolling through treacle. The closure has to be created once.
  function pickVendorOption(set: (v: Vendor) => void) {
    return (v: Vendor, option?: VehicleOption) => {
      if (!option || !v.offer) return set(v);
      set({ ...v, offer: offerForOption(v.offer, option, rfq?.durationDays ?? 1) });
    };
  }

  // Jump straight to a shop's card from the status panel: switch to the list,
  // highlight it, and smooth-scroll it into view.
  // CONSUME THE PUSH'S DESTINATION once the hunt is actually on screen. The
  // vendor list arrives asynchronously (session restore, then the activity
  // poll), so the id a notification carried is held in a ref until there is
  // something to open - then used exactly once.
  useEffect(() => {
    const want = pendingShopRef.current;
    if (!want || vendors.length === 0) return;
    const target =
      vendors.find((v) => v.id === want) ||
      vendors.find((v) => digitsOnly(v.whatsapp ?? "").endsWith(digitsOnly(want).slice(-8)));
    if (!target) return;
    pendingShopRef.current = null;
    scrollToVendor(target.id);
    setDashboardFor(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendors]);

  function scrollToVendor(id: string) {
    setView("list");
    setSelectedId(id);
    // HORIZONTAL MODE: every card is mounted (plain flex, no windowing), and
    // the movement is the STRIP's, not the page's - inline centring inside
    // the rail, block "nearest" so the page never jumps vertically.
    if (listAxis === "horizontal") {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          document
            .getElementById(`vendor-${id}`)
            ?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
        })
      );
      return;
    }
    // THE TARGET MAY NOT BE MOUNTED. The list is windowed, so a card far down
    // it has no DOM node to scroll to - the old fix was to grow a "show more"
    // window past the index, which the virtualizer replaced. Scroll the page to
    // the row's position instead and let the virtualizer mount it on the way;
    // the two frames below then centre the real element once it exists.
    {
      const idx = filtered.findIndex((v) => v.id === id);
      if (idx >= 0) setScrollRequest({ index: idx, nonce: ++scrollNonceRef.current });
    }
    // Two frames: let React commit the larger window before scrolling.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.getElementById(`vendor-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      })
    );
  }

  /**
   * Take the traveller TO a section, not to the top of the page.
   *
   * "See the full live activity feed →" used to switch the view and then call
   * `window.scrollTo({top: 0})`, which threw them back to the search box - the
   * feed they had just asked for was hundreds of pixels below. Everything that
   * moves between sections now goes through here: flip the view, wait for the
   * commit, and scroll the section itself into view under the sticky header.
   */
  function goToSection(selector: string, nextView?: "list" | "map" | "activity") {
    if (nextView) setView(nextView);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.querySelector(selector);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      })
    );
  }

  const [queueItems, setQueueItems] = useState<
    { id: number; vendorId: string | null; vendorName: string | null; toNumber: string; notBefore: string; due: boolean; reason: string; etaFrom?: string; etaTo?: string }[]
  >([]);
  // The plan's rolling introductions budget (Free ~10/6h, Pro ~15/4h, Ultra
  // ~40/3h), shown as a standing meter in the queued panel so the pacing limit
  // is always visible - not just a one-time toast.
  const [introBudget, setIntroBudget] = useState<{
    remaining: number;
    cap: number;
    windowHours: number;
    nextFreeAt: string;
  } | null>(null);
  // F4: the two-segment funnel bar, computed SERVER-SIDE on the authoritative
  // per-shop rung and rendered verbatim. Held as one opaque object on purpose -
  // there is nothing here for the client to recompute, and the moment it starts
  // deriving a percentage of its own this becomes the fifth disagreeing number
  // on the most-watched surface in the app.
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  // CLIENT TOMBSTONES for queue removals: keys ("id:<n>" / "v:<vendorId>")
  // mapped to the time they were tombstoned. Any poll that raced the server
  // delete still holds pre-delete rows - without this filter it would
  // resurrect the removed row + card badge for one poll cycle (the reported
  // remove-flicker). Entries expire after 30s (by then the server state is
  // authoritative either way) and are cleared early on fetch failure so the
  // row honestly reappears instead of silently vanishing.
  const pendingRemovals = useRef<Map<string, number>>(new Map());
  // Queue rows currently being removed (disables their Remove button).
  const [removingIds, setRemovingIds] = useState<Set<number>>(new Set());
  // REMOVED BY YOU IS A NOTICE, NOT A LEDGER. It was an unconditional section
  // that stayed on screen for the rest of the session, so a shop the traveller
  // had already dealt with kept taking up space in the panel they use to watch
  // live ones. Dismissal is per shop rather than a single "hide it" flag, so a
  // NEW removal after a dismissal brings the notice back - which is what makes
  // it behave like every other alert in the app instead of a wall.
  // PERSISTED: TabBar navigation is a full document load and the vendor list
  // (with cancelled=true) is restored from sessionStorage - a bare in-memory
  // set here meant one hop to Deals resurrected the whole notice, which is
  // why DISMISS read as "does nothing". Keys carry the tombstone's timestamp
  // so a LATER removal of the same shop still reappears.
  const [dismissedRemovals, setDismissedRemovals] = useState<Set<string>>(() =>
    loadDismissals(typeof window !== "undefined" ? window.sessionStorage : null)
  );
  // Local going-rate hint (item #6): what the cheapest scooter / economy car
  // honestly costs per day around the chosen stay, in the LOCAL currency.
  const [priceHint, setPriceHint] = useState<{
    scooter: { floor: number; typical: number | null; currency: string } | null;
    car: { floor: number; typical: number | null; currency: string } | null;
  } | null>(null);
  const [priceHintLoading, setPriceHintLoading] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // D1 (owner report 6): id -> CONTENT FINGERPRINT of the reply row as last
  // applied. The old Set applied each row id exactly once - but the server
  // merges live thread state (deposit, fulfillment, presentable, verified,
  // wantsCall...) onto the SAME newest row every poll, so everything learned
  // after the row's first appearance was silently frozen out of the card.
  // Content deciding (not id-once) re-applies the winning row whenever what
  // it says has changed; the round counter still bumps only on a NEW row.
  const appliedReplies = useRef<Map<number, string>>(new Map());
  // ATOMIC SESSION: a monotonic epoch stamped when a search starts. Only shop
  // replies created AFTER this moment belong to THIS session - anything older
  // (a previous search's offers/threads) is rejected, so a "New search" can
  // never resurrect a stale bargain from a shop you already left.
  const [searchEpoch, setSearchEpoch] = useState<number>(0);
  // SERVER-CLOCK epoch. `searchEpoch` is stamped from THIS device's clock, but
  // every `since=` filter it feeds runs against SERVER timestamps - a phone
  // running a couple of minutes fast silently ate replies that arrived right
  // after the search started. The activity poll already measures the skew
  // (clockSkewRef); every server-facing use of the epoch goes through here.
  // Reads the QUANTIZED skew, never the raw ref - see its declaration.
  const epochOnServerClock = () => (searchEpoch ? searchEpoch + clockSkew : 0);

  // Restore the local-language preference.
  useEffect(() => {
    try {
      setLocalLang(localStorage.getItem("wd_local_lang") === "1");
    } catch {}
  }, []);

  // Refresh the going-rate hint whenever the stay changes. Best-effort only -
  // a missing hint never blocks the search.
  useEffect(() => {
    const label = origin?.label?.trim();
    if (!label || label === "My current location") {
      setPriceHint(null);
      return;
    }
    let cancelled = false;
    setPriceHintLoading(true);
    fetch(`/api/market/hint?region=${encodeURIComponent(label)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setPriceHint(d.scooter || d.car ? { scooter: d.scooter ?? null, car: d.car ?? null } : null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPriceHintLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [origin?.label]);
  const localLangActive = localLang && can(session?.plan, "local-language");
  // ONCE A HUNT IS UNDER WAY, THE LANGUAGE IS SETTLED.
  //
  // Flipping this switch mid-hunt changed the language of every ALREADY-OPEN
  // conversation, so a shop that had been messaged in Thai for ten minutes got
  // the next line in English and the one after that in Thai again - which reads
  // as a bot, not a bilingual customer. The server refuses the change per
  // thread whatever the client sends (wa/thread-language); this is the half
  // that makes the refusal visible instead of silently ignoring a tap.
  const languageLocked = vendors.some(
    (v) =>
      Boolean(v.sentText) ||
      Boolean(v.queuedUntil) ||
      ["rfq-sent", "awaiting-response", "negotiating"].includes(v.stage ?? "")
  );

  // Fresh random suggestion chips on every visit (client-only so SSR markup
  // stays deterministic). Free users never see future-day pickup suggestions.
  useEffect(() => {
    const picked = pickExamples(session?.plan);
    setExamples(picked);
    setRawText((prev) => (ALL_EXAMPLES.includes(prev) ? picked[0] : prev));
  }, [session?.plan]);

  // Restore a previous search so it survives navigating to Profile/Admin and
  // back. Kept in sessionStorage; cleared by the explicit Clear button - or by
  // its own age.
  //
  // THE AGE TEST IS THE POINT. sessionStorage nominally dies with the tab, but
  // an installed iOS PWA is routinely left open for days, so this slot really
  // did hand back hunts that had long since ended - and then fed their ancient
  // `searchEpoch` to /api/activity and /api/replies as `since=`, dragging a
  // week of traces onto the board. `loadSearch` now refuses and clears anything
  // past the TTL; the hunt is still in Trips.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("wd_search");
      if (raw) {
        const s = JSON.parse(raw);
        if (!isSessionFresh(s?.searchEpoch, Date.now(), SEARCH_SESSION_TTL_MS)) {
          // Clear rather than merely skip: the next write measures its quota
          // ladder against an empty slot instead of a blob nothing will read.
          sessionStorage.removeItem("wd_search");
        } else if (s.vendors?.length) {
          setVendors(s.vendors);
          setRfq(s.rfq ?? null);
          setSource(s.source ?? null);
          setSourceError(s.sourceError ?? null);
          setRawText(s.rawText ?? ALL_EXAMPLES[0]);
          if (s.origin) setOrigin(s.origin);
          if (typeof s.radiusKm === "number") setRadiusKm(s.radiusKm);
          if (s.filters) setFilters(s.filters);
          if (typeof s.searchEpoch === "number") setSearchEpoch(s.searchEpoch);
          // Re-seed the applied-reply set - without this, every restore
          // re-applied all replies over the restored offers, inflating the
          // round count and (with out-of-order rows) reverting the price.
          if (Array.isArray(s.appliedReplyIds)) {
            // "" = known row, content unknown: the next poll re-applies it
            // idempotently (no round bump - the id is not new) so a restore
            // can refresh thread facts without inflating counters.
            for (const id of s.appliedReplyIds) appliedReplies.current.set(id, "");
          }
          setPhase("done");
        }
      }
    } catch {}
    setRestored(true);
  }, []);

  // COLD START AFTER AN EVICTION. The live hunt lives in sessionStorage, and
  // sessionStorage does not survive an iOS PWA being killed - which iOS does
  // aggressively, in the background, while the agents are mid-negotiation. The
  // traveller re-opens the app and finds the search screen, as if nothing had
  // ever run. Every shop, offer and thread is still on the server; only this
  // device forgot.
  //
  // /api/deals/restore can rebuild the whole workspace and has been able to
  // since it shipped - it just had to be asked, by hand, from the Trips tab.
  // The NEWEST session is ungated for every plan (it IS the live workspace), so
  // asking for it automatically opens no paid door.
  //
  // WHAT COMES BACK IS ONLY EVER A LIVE HUNT. The route now refuses `ts=latest`
  // for a session past its TTL, or one the traveller explicitly cleared, with a
  // 404 - so a hunt from last week lands the app on a clean search screen
  // instead of pretending to be today's work. Nothing is deleted; it is still in
  // Trips, which is where a finished hunt belongs.
  useEffect(() => {
    if (!restored || vendors.length || phase !== "idle") return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/deals/restore?ts=latest", { cache: "no-store" });
        if (!r.ok || !alive) return;
        const d = await r.json().catch(() => null);
        const p = d?.payload;
        if (!alive || !p?.vendors?.length) return;
        // Do not stomp a search the traveller started while this was in flight.
        if (sessionStorage.getItem("wd_search")) return;
        // BELT AND BRACES ON THE AGE. The server is the authority and has
        // already refused a stale hunt, but this is the one line that decides
        // whether an ancient epoch becomes the `since=` of every live poll -
        // which is how a week of old traces got dragged onto the board last
        // time. A payload that fails the same test here is simply not applied.
        if (!isSessionFresh(p.searchEpoch, Date.now(), SEARCH_SESSION_TTL_MS)) return;
        setVendors(p.vendors);
        setRfq(p.rfq ?? null);
        setSource(p.source ?? null);
        setRawText(p.rawText ?? ALL_EXAMPLES[0]);
        if (p.origin) setOrigin(p.origin);
        if (typeof p.radiusKm === "number") setRadiusKm(p.radiusKm);
        if (typeof p.searchEpoch === "number") setSearchEpoch(p.searchEpoch);
        setPhase("done");
        setActionNote({
          tone: "info",
          text: t("Picked your hunt back up - the agents never stopped."),
        });
      } catch {
        /* offline / signed out: the search screen is the honest fallback */
      }
    })();
    return () => {
      alive = false;
    };
    // Runs once, on the cold mount that found nothing. `restored` flips exactly
    // once; the guards above cover the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored]);

  // Persist the search whenever the vendor list changes.
  useEffect(() => {
    if (!restored) return;
    try {
      if (vendors.length) {
        // A BUDGET, NOT A HOPE. The full blob crosses the sessionStorage quota
        // in the middle of a busy hunt, and `setItem` throws rather than
        // failing quietly - which this `catch` used to turn into a silently
        // lost session. saveSearch sheds galleries, then message bodies, until
        // the write lands; identity, stage and offer always survive.
        const res = saveSearch(sessionStorage, "wd_search", {
          vendors,
          rfq,
          source,
          sourceError,
          rawText,
          origin,
          radiusKm,
          filters,
          searchEpoch,
          appliedReplyIds: [...appliedReplies.current.keys()].slice(-200),
        });
        if (!res.ok) {
          setActionNote({
            tone: "info",
            text: t("This hunt is too big to hold on this device - keep the app open to stay live."),
          });
        }
      } else {
        sessionStorage.removeItem("wd_search");
      }
    } catch {}
  }, [vendors, rfq, source, sourceError, rawText, origin, radiusKm, filters, restored, searchEpoch]);

  function clearSearch() {
    timers.current.forEach(clearTimeout);
    setVendors([]);
    setRfq(null);
    setSource(null);
    setSourceError(null);
    setPhase("idle");
    setClearConfirm(false);
    appliedReplies.current = new Map();
    // The mass-bargain blast belongs to the OLD hunt (D6): its "running"
    // spinner and "Asked N shops" note must never survive into the next one.
    setMassState("idle");
    setMassNote(null);
    // Shop avatars are ephemeral: a new search must never show the previous
    // session's shops (they belong to people who never signed up here).
    clearShopAvatars();
    setQueueItems([]);
    // Future replies belong to a NEW session - anything before now is dead.
    const clearEpoch = Date.now();
    setSearchEpoch(clearEpoch);
    // HARD close on the server too: purge every queued message, tombstone the
    // recipients and stamp the session-closed marker so the agents stop
    // talking to the old shops. AWAITED with one retry - a silently failed
    // close would leave server-side sends alive, which is exactly the lie
    // the user asked us to kill. On double failure, say so honestly.
    // SCOPED to the closing session's own window, so the retry stays safe.
    void (async () => {
      const payload = JSON.stringify({ from: searchEpoch || undefined, before: clearEpoch });
      const close = () =>
        fetch("/api/session/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }).then((r) => r.ok);
      let ok = await close().catch(() => false);
      if (!ok) {
        await new Promise((r) => setTimeout(r, 1500));
        ok = await close().catch(() => false);
      }
      if (!ok) {
        setMassNote(
          t("The search was cleared here, but the server could not confirm stopping pending messages - check the queue in a moment.")
        );
      }
    })();
    try {
      sessionStorage.removeItem("wd_search");
    } catch {}
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  useEffect(() => {
    // Middleware already gates unauthenticated visitors; here we just load the
    // session (with one retry - never cached). Track the retry timers and a
    // mounted flag so a late retry can't setState after unmount.
    let mounted = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const loadMe = async (attempt = 0) => {
      try {
        const r = await fetch("/api/auth/me", { cache: "no-store" });
        const d = await r.json();
        if (!mounted) return;
        if (d.session) setSession(d.session);
        else if (attempt < 2) retry = setTimeout(() => loadMe(attempt + 1), 700);
        else window.location.href = "/login";
      } catch {
        if (mounted && attempt < 2) retry = setTimeout(() => loadMe(attempt + 1), 700);
      }
    };
    loadMe();

    const params = new URLSearchParams(window.location.search);
    // First-run walkthrough (or explicitly requested with ?welcome=1).
    try {
      if (params.get("welcome") === "1" || !localStorage.getItem("wd_onboarded")) {
        setOnboarding(true);
      }
    } catch {}
    // Deep link from Will's edge companion (?will=1): open his chat directly.
    if (params.get("will") === "1") {
      setWillOpen(true);
      window.history.replaceState({}, "", "/");
    }
    // A PUSH NOW HAS SOMEWHERE TO GO.
    //
    // Every notification the app sent pointed at "/", so tapping "New price"
    // after iOS had evicted the app landed on a cold home screen with the
    // thread nowhere in sight - the traveller had to find the shop themselves,
    // which is the moment they stop trusting the alerts. The shop id (or its
    // number, from the ingest buzz) is remembered here and consumed once the
    // vendor list exists, since the restore is asynchronous.
    const deepShop = params.get("shop") || params.get("from");
    if (deepShop) {
      pendingShopRef.current = deepShop;
      window.history.replaceState({}, "", "/");
    }
    // Returning from PayPal Checkout. The subscription id PayPal appends is
    // forwarded so the server can verify it directly - the webhook stays the
    // durable record, but a lost or misconfigured webhook no longer leaves a
    // traveller who paid sitting on the free tier.
    const plan = params.get("plan");
    if (params.get("billing") === "success" && plan) {
      fetch("/api/billing/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan,
          subscriptionId: params.get("subscription_id") || undefined,
        }),
      }).then(() => window.history.replaceState({}, "", "/"));
    }

    return () => {
      mounted = false;
      if (retry) clearTimeout(retry);
      // Clear the CURRENT timers array, not a mount-time snapshot: runFunnel
      // replaces timers.current with a new array, so a captured `scheduled`
      // reference would clear nothing on unmount (audit: stale-ref timers).
      timers.current.forEach(clearTimeout);
    };
  }, []);

  // WHATSAPP GATE. Read through the shared probe (bounded, retried, never
  // cached) and re-read whenever the answer can have changed.
  //
  // The bug this replaces: a single un-retried fetch whose failure was recorded
  // as `false` - a CONFIRMED unlink. When the Evolution host was cold the status
  // call could take ~25s, the fetch never landed, and a traveller whose
  // WhatsApp was connected got "Link WhatsApp to unlock the search" over their
  // search form, with no way back short of a reload. A read we could not
  // complete is not evidence of anything, so it no longer draws the lock.
  const refreshWaStatus = useCallbackRef(async () => {
    if (!session) return;
    const s = await probeWaStatus();
    if (!s.reachable) {
      setWaReachable(false);
      return;
    }
    setWaReachable(true);
    setWaConnected(s.connected);
  });
  useEffect(() => {
    if (!session) return;
    void refreshWaStatus();
    // Linking happens on ANOTHER screen (Profile). Coming back here has to
    // re-ask, or the gate keeps showing a lock the traveller already cleared.
    const onWake = () => {
      if (!document.hidden) void refreshWaStatus();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [session, refreshWaStatus]);

  // EVERY traveller defaults to "My location": ask for GPS as soon as the page
  // is up (covered by the Terms of Use accepted at signup). The point is shown
  // instantly, then reverse-geocoded to a REAL named place so local currency +
  // language work (a bare "My location" has no country to read). A restored
  // search keeps its own origin; a manual pick made while GPS was still
  // resolving always wins.
  useEffect(() => {
    if (!restored) return;
    // Don't override a restored search's origin with the phone location.
    let hasSaved = false;
    try {
      hasSaved = Boolean(sessionStorage.getItem("wd_search"));
    } catch {}
    if (hasSaved) return;
    let cancelled = false;
    navigator.geolocation?.getCurrentPosition(
      async (pos) => {
        if (cancelled) return;
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setOrigin((prev) =>
          prev ? prev : { label: "My current location", lat, lng, myLocation: true }
        );
        setOriginHint(null);
        try {
          const d = await (await fetch(`/api/geocode?lat=${lat}&lng=${lng}`)).json();
          if (!cancelled && d?.place?.label) {
            setOrigin((prev) =>
              // Only refine the GPS origin - never clobber a manual pick.
              !prev || prev.myLocation
                ? { label: d.place.label, lat, lng, myLocation: true }
                : prev
            );
          }
        } catch {}
      },
      () => {
        /* Permission denied / unavailable: the picker's hint takes over. */
      }
    );
    return () => {
      cancelled = true;
    };
  }, [restored]);

  // RECONCILE, don't rebuild. `vs.map(v => ({...v, ...patch}))` allocated a new
  // object for every shop on every tick whether or not anything about it
  // changed - and `memo(VendorCard)` compares by reference, so a new object is
  // a new prop and every card re-rendered, twenty at a time, twice per poll
  // cycle. mergeIfChanged returns the SAME reference when a patch changes
  // nothing, which is what lets React skip a card that did not move.
  const patchVendor = useCallbackRef((id: string, patch: Partial<Vendor>) => {
    setVendors((vs) => reconcileList(vs, (v) => (v.id === id ? patch : null)));
  });
  // Stable identity so the memoised VendorCard doesn't re-render on every
  // parent state change.
  const handleStage = useCallbackRef((id: string, stage: Vendor["stage"]) =>
    patchVendor(id, { stage })
  );
  // A send was parked in the outbox: stamp queuedUntil + the guard's REAL
  // reason NOW so strip and card agree instantly (the activity poll keeps it
  // fresh). Nothing was delivered, so the stage is deliberately untouched.
  const handleQueued = useCallbackRef(
    (id: string, queuedUntil?: string, queuedReason?: string) =>
      patchVendor(id, {
        queuedUntil: queuedUntil ?? new Date().toISOString(),
        queuedReason: queuedReason || undefined,
      })
  );
  const openWhy = useCallbackRef((decisionId: string) => setWhyDecision(decisionId));

  // ---- Will's bridge: natural language -> the EXISTING setters ------------
  // Will can only ever do what the visible controls can do; every command
  // lands on the same state the buttons use.
  // Latest-ref wrapper: the bridge memo must NEVER capture a stale
  // startSearch closure (it reads rawText/origin/radius at call time) -
  // "search now" through Will always runs the CURRENT request.
  const startSearchStable = useCallbackRef((text?: string) => startSearch(text));

  const willBridge = useMemo(
    () => ({
      getContext: (): WillContext => ({
        phase,
        radiusKm,
        vehicleClass: filters.vehicleClass,
        maxPricePerDay: filters.maxPricePerDay,
        vendors: vendors.slice(0, 12).map((v) => ({
          id: v.id,
          name: v.name,
          stage: v.stage,
          pricePerDay: v.offer?.pricePerDay,
          currency: v.offer?.currency,
          verified: v.offer?.verified,
          // WHAT WILL COULD NOT SEE. Every one of these already lives on the
          // vendor the page is holding; the snapshot simply never carried them,
          // so Will would report a shop as "leading" when it had offered a
          // different bike, said it had nothing, or had a reply still sitting
          // in the outbox waiting for opening hours.
          vehicleStatus: v.offer?.vehicleStatus,
          alternativeOffered: Boolean(v.offer?.alternativeOffer),
          outOfStock: v.stage === "out-of-stock",
          openingPricePerDay: v.offer?.listPricePerDay,
          queuedUntil: v.queuedUntil,
          queuedReason: v.queuedReason ?? undefined,
        })),
        offersIn: vendors.filter((v) => v.offer).length,
        // Will treats "still checking" as not-yet-linked (boolean contract).
        waConnected: waConnected === true,
        plan: session?.plan ?? "free",
        originLabel: origin?.label,
        paused,
        notes: [],
      }),
      setRadius: (km: number) => setRadiusKm(km),
      patchFilters: (patch: Record<string, unknown>) =>
        setFilters((f) => ({ ...f, ...(patch as Partial<FilterState>) })),
      setBudget: (v: number | null) => setFilters((f) => ({ ...f, maxPricePerDay: v })),
      startSearch: (text?: string) => void startSearchStable(text),
      clearSearch: () => setClearConfirm(true), // always through the confirm dialog
      pause: async () => {
        setPaused(true);
        await fetch("/api/session/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "pause" }),
        }).catch(() => {});
      },
      resume: async () => {
        setPaused(false);
        await fetch("/api/session/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "resume" }),
        }).catch(() => {});
      },
      massBargain: () => runMassBargain(),
      // Will and the buttons now share ONE vocabulary of what this app can do.
      // A capability the traveller has and the assistant does not is a
      // capability that drifts - and one of the two ends up wrong.
      runAction: (id: string, args?: Record<string, unknown>, confirmed?: boolean) =>
        runAction(id, args ?? {}, Boolean(confirmed)),
      openVendor: (id: string) => scrollToVendor(id),
      compare: (ids: string[]) => setCompareIds(ids),
      openFeedback: () => setFeedbackOpen(true),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phase, radiusKm, filters, vendors, waConnected, session, origin, paused]
  );
  const will = useWill(willBridge);
  const lastWillSay = will.messages.length
    ? [...will.messages].reverse().find((m) => m.role === "will")?.text
    : undefined;

  // Restore the pause flag from the server once per session (survives reloads).
  useEffect(() => {
    if (!session) return;
    fetch("/api/session/pause")
      .then((r) => r.json())
      .then((d) => setPaused(Boolean(d.paused)))
      .catch(() => {});
  }, [session]);

  // The traveller's own held-for-opening-hours queue (bug #9). They can see it
  // and remove any queued message; the matching card clears its queued badge.
  const refreshQueue = useCallbackRef(async () => {
    if (!session) return;
    try {
      // One consolidated poll: activity feed + queue + WA safety state.
      // cache:"no-store" + a changing cache-buster: the URL was byte-identical
      // on every poll, so the browser could serve the first (empty) response
      // forever - the "Nothing on the wire yet" freeze.
      // skewMs corrects the client clock against the server's: `since` filters
      // SERVER row timestamps, so a phone running minutes fast hid every row
      // written in that window.
      const sentAt = Date.now();
      const res = await fetch(
        `/api/activity?since=${(searchEpoch || Date.now() - 86400000) + clockSkewRef.current}&t=${sentAt}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`activity ${res.status}`);
      const d = await res.json();
      if (typeof d.now === "string") {
        const serverNow = Date.parse(d.now);
        if (Number.isFinite(serverNow)) {
          // Midpoint estimate: the server stamped `now` somewhere between the
          // request leaving and the response being parsed, so half the round
          // trip is the least-wrong guess. `sentAt` is captured just before the
          // fetch below.
          const raw = serverNow - (sentAt + Date.now()) / 2;
          clockSkewRef.current = raw;
          const quantized = Math.floor(raw / SKEW_STEP_MS) * SKEW_STEP_MS;
          // Only when it actually moved - setState with the same number is a
          // React bail-out, but being explicit keeps the intent readable.
          setClockSkew((prev) => (prev === quantized ? prev : quantized));
        }
      }
      setFeedStale(false);
      // The kill switch and the queue rows now read the SAME poll: a session
      // paused after mount can no longer show "Agents active" over a queue of
      // "Paused by you" rows.
      if (typeof d.sessionPaused === "boolean") {
        // Move forward only: an older answer is dropped, never applied.
        const v = Number(d.sessionPausedVersion) || 0;
        setPausedVersion((prev) => {
          if (v && v <= prev) return prev;
          setPaused(d.sessionPaused);
          return v || prev;
        });
      }
      // IDENTITY-PRESERVING (L4): these three setters replaced their state
      // with a brand-new object every tick whether anything changed or not,
      // and everything memoised or effect-keyed on them woke with it - the
      // whole 5,000-line Home re-rendered on every quiet poll. Same payload
      // keeps the same reference; only a real change wakes the tree.
      if (Array.isArray(d.items)) {
        const next = d.items as FeedItem[];
        setActivityItems((prev) =>
          prev.length === next.length && JSON.stringify(prev) === JSON.stringify(next)
            ? prev
            : next
        );
      }
      if (d.waHealth) {
        setWaHealth((prev) =>
          prev && JSON.stringify(prev) === JSON.stringify(d.waHealth) ? prev : d.waHealth
        );
      }
      if (d.whyByVendor) setWhyByVendor((prev) => reconcileRecord(prev, d.whyByVendor));
      // RECONCILE, don't replace. This handed every card a brand-new
      // `agentPending` object every tick whether or not that shop's agent had
      // moved, and `memo(VendorCard)` compares by reference - so this one line
      // re-rendered the whole board twice a poll cycle, defeating the vendor
      // reconciliation twenty lines below it.
      setAgentPending((prev) =>
        reconcileRecord(
          prev,
          d.agentPending && typeof d.agentPending === "object"
            ? (d.agentPending as Record<string, { count: number; sending: boolean; own?: boolean }>)
            : {}
        )
      );
      // AUTHORITATIVE per-vendor conversation state (messaged / active / offer)
      // straight from the DB rollup - the single source of truth that keeps the
      // card status in lock-step with the Live Status panel, so a messaged shop
      // never stays stuck in the "queued message" visual (split-brain fix).
      const vendorStates: Record<string, "messaged" | "active" | "offer"> =
        d.vendorStates && typeof d.vendorStates === "object" ? d.vendorStates : {};
      // THE FUNNEL LEDGER, WHICH THIS SURFACE HAD NEVER READ.
      //
      // /api/activity has served `vendorStages` - the durable, evidence-based
      // `negotiation_threads.stage` written by advanceThreadStage - since the
      // ledger shipped, and grep found every reader of it inside the producing
      // route. Meanwhile the card kept deriving its stage from `vendorStates`,
      // whose "active" fires on ANY stored inbound: a greeting, a sticker, even
      // an `extract` trace. That is owner problem 2 in one line - the ledger
      // knows the difference between `replied` and `understood` and the card
      // was not asking. Where the ledger has an opinion it WINS.
      const vendorStages: Record<string, { stage?: unknown }> =
        d.vendorStages && typeof d.vendorStages === "object" ? d.vendorStages : {};
      const lastByVendor: Record<
        string,
        {
          lastInboundText?: string;
          lastInboundEnglish?: string;
          lastInboundAt?: string;
          // The agent's newest REAL sent text + its English gloss (W1.5).
          // lastOutboundText was computed server-side from day one and the
          // client type silently dropped it - the panel's "sent" line froze
          // on the first outreach response forever.
          lastOutboundText?: string;
          lastOutboundEnglish?: string;
          lastOutboundAt?: string;
        }
      > = d.lastByVendor && typeof d.lastByVendor === "object" ? d.lastByVendor : {};
      // Forward-only stage ranking - the DB state can only ADVANCE a card, never
      // rewind it, and never overrides a terminal decline / no-contact.
      const stageForState = (s: "messaged" | "active" | "offer") =>
        s === "offer" ? "offer-received" : s === "active" ? "negotiating" : "awaiting-response";
      // J: vendorIds where the agent has countered the shop's quote this session
      // (derived server-side from offer rounds / bargain-after-quote). Applied as
      // a FINAL stage relabel - after the offer/price is seeded - so the priced
      // offer still surfaces on the card while the stage reads "counter-offer".
      const counteredSet = new Set<string>(
        Array.isArray(d.countered) ? (d.countered as string[]) : []
      );
      const canAdvance = (cur: string | undefined, target: string) =>
        cur !== "declined" &&
        cur !== "no-contact" &&
        // "Out of stock" is terminal for the activity poll: an inbound row exists
        // (that is how it went out of stock), so the poll would otherwise re-bump
        // it to "negotiating" every ~6s while the replies poll pushed it back -
        // the amber<->red flap the traveller saw. Only an explicit unavailable:
        // false reply (handled in the replies poll) may revive it.
        cur !== "out-of-stock" &&
        // A "no-response" card (we waited, nothing came) must not be rewound to
        // "awaiting-response" by the mere existence of its RFQ row - only a real
        // reply (active/offer) revives it.
        !(cur === "no-response" && target === "awaiting-response") &&
        stageRank(target) > stageRank(cur);
      // J: relabel a card's stage to "counter-offer" once the agent has countered
      // this shop's quote - applied LAST (after offer seeding) at every return
      // site so the priced offer still shows; canAdvance keeps it off terminal
      // cards and makes it stick once reached (active haggling in progress).
      const finalizeStage = (b: Vendor): Vendor =>
        b.id && counteredSet.has(b.id) && canAdvance(b.stage, "counter-offer")
          ? { ...b, stage: "counter-offer" }
          : b;
      // Drop rows the user just removed (tombstoned) - a poll that read the
      // server BEFORE the delete committed must not resurrect them. Expired
      // tombstones (>30s) fall away so a genuinely failed delete resurfaces.
      const nowMs = Date.now();
      for (const [k, at] of pendingRemovals.current) {
        if (nowMs - at > 30_000) pendingRemovals.current.delete(k);
      }
      const tombstoned = (row: { id?: number; vendorId?: string | null }) =>
        pendingRemovals.current.has(`id:${row.id}`) ||
        (row.vendorId ? pendingRemovals.current.has(`v:${row.vendorId}`) : false);
      const rawItems: {
        id: number;
        vendorId: string | null;
        notBefore: string;
        /** The row is claimed by a drainer and being delivered right now. */
        sending?: boolean;
        rawReason?: string | null;
      }[] = Array.isArray(d.queue) ? d.queue : [];
      const items = rawItems.filter((i) => !tombstoned(i));
      // A poll whose payload no longer contains a tombstoned row confirms the
      // server delete landed - retire those tombstones.
      for (const k of [...pendingRemovals.current.keys()]) {
        if (k.startsWith("v:") && !rawItems.some((i) => `v:${i.vendorId}` === k)) {
          pendingRemovals.current.delete(k);
        }
      }
      // B4 client mitigation: collapse any duplicate rows for the same shop to
      // ONE entry (keep the earliest-due), so a legacy duplicate outbox row can
      // never render as two identical queue cards. The DB unique index is the
      // real guard; this keeps older sessions clean too.
      {
        const rows = (d.queue ?? []).filter(
          (i: { id: number; vendorId: string | null }) => !tombstoned(i)
        );
        const byVendor = new Map<string, (typeof rows)[number]>();
        const deduped: typeof rows = [];
        for (const r of rows) {
          const key = r.vendorId ? `v:${r.vendorId}` : `n:${r.toNumber}`;
          const prev = byVendor.get(key);
          if (!prev) {
            byVendor.set(key, r);
            deduped.push(r);
          } else if (new Date(r.notBefore).getTime() < new Date(prev.notBefore).getTime()) {
            // Replace the kept row with the earlier-due one, in place.
            const idx = deduped.indexOf(prev);
            if (idx >= 0) deduped[idx] = r;
            byVendor.set(key, r);
          }
        }
        // Identity-preserving (L4): an unchanged queue keeps its reference.
        setQueueItems((prev) =>
          prev.length === deduped.length && JSON.stringify(prev) === JSON.stringify(deduped)
            ? prev
            : deduped
        );
      }
      setIntroBudget(d.introBudget ?? null);
      setProgress((d.progress as BatchProgress | undefined) ?? null);
      // Tombstoned shops WITH the actor behind each tombstone. Only
      // "user-removed" may ever render as "Removed by you" - the system's
      // own session-close/deal-close sweeps are its actions, not the
      // traveller's (six never-removed shops once carried that blame).
      const cancelledInfo = new Map<string, { reason: string; at: string | null }>();
      for (const c of (Array.isArray(d.cancelledShops) ? d.cancelledShops : []) as {
        digits?: string;
        reason?: string;
        at?: string | null;
      }[]) {
        if (c.digits) cancelledInfo.set(c.digits, { reason: c.reason ?? "unknown", at: c.at ?? null });
      }
      // Legacy digest fallback (older payloads): digits with no reason.
      for (const dgt of (Array.isArray(d.cancelledNumbers) ? d.cancelledNumbers : []) as string[]) {
        if (!cancelledInfo.has(dgt)) cancelledInfo.set(dgt, { reason: "unknown", at: null });
      }
      const cancelledDigits = new Set<string>(cancelledInfo.keys());
      // Reconcile the cards with the SERVER (single source of truth for the
      // queued badge, covering every send path): set badge + REAL reason for
      // shops with a held message; when the row leaves the outbox, decide
      // HONESTLY what happened using delivery evidence from the same payload:
      //   sent event exists  -> the message left: the shop is now contacted
      //   no sent evidence   -> it was removed: the shop goes back to "found"
      //                         (never a phantom "messaged")
      const byVendor = new Map<
        string,
        { until: string; reason?: string | null; sending?: boolean }
      >();
      for (const i of items)
        if (i.vendorId)
          byVendor.set(i.vendorId, {
            until: i.notBefore,
            reason: i.rawReason,
            sending: Boolean(i.sending),
          });
      const sentVendors = new Set<string>(
        (Array.isArray(d.items) ? d.items : [])
          .filter((it: { kind?: string; vendorId?: string }) => it.kind === "sent" && it.vendorId)
          .map((it: { vendorId: string }) => it.vendorId)
      );
      // OFFERS from the fast activity feed: /api/activity already returns priced
      // offers (kind:"offer"), but only the slower 15-30s replies poll was
      // setting v.offer - so OFFERS IN sat at 0 for minutes even after a shop
      // quoted a price. Seed a minimal offer here so the counter + deals view
      // advance on the 6-12s activity cadence; the richer replies poll enriches
      // it (deposit/delivery/etc.) later. Items are newest-first, so the first
      // per vendor is the latest.
      const offerByVendor = new Map<
        string,
        { pricePerDay: number; currency: string; round: number; verified: boolean }
      >();
      for (const it of (Array.isArray(d.items) ? d.items : []) as {
        kind?: string;
        vendorId?: string;
        meta?: { pricePerDay?: number; currency?: string; round?: number; verified?: boolean };
      }[]) {
        if (
          it.kind === "offer" &&
          it.vendorId &&
          it.meta &&
          typeof it.meta.pricePerDay === "number" &&
          !offerByVendor.has(it.vendorId)
        ) {
          offerByVendor.set(it.vendorId, {
            pricePerDay: it.meta.pricePerDay,
            currency: String(it.meta.currency ?? "USD"),
            round: Number(it.meta.round ?? 0),
            verified: Boolean(it.meta.verified),
          });
        }
      }
      setVendors((vs) =>
        vs.map((v) => {
          if (!v.id) return v;
          // "Paused by you" flag - independent of the queue badge; shown when
          // the user removed messages for this shop and has not re-engaged.
          const digits = digitsOnly(v.whatsapp);
          // THE TOMBSTONE IS AUTHORITATIVE FOR THE SHOP, NOT ONLY FOR THE ROW.
          //
          // `pendingRemovals` already suppressed the removed QUEUE row, but this
          // merge recomputed `cancelled` straight from the server list - and a
          // poll that started before the delete committed still answers "not
          // cancelled". So the optimistic removal was reverted for exactly one
          // cycle, `queuedUntil` came back with it, and the shop visibly popped
          // into CONTACTING before settling into REMOVED BY YOU. One local
          // decision, two views, and only one of them respected it.
          const tombstonedVendor = pendingRemovals.current.has(`v:${v.id}`);
          const isCancelled =
            tombstonedVendor || Boolean(digits && cancelledDigits.has(digits));
          // The ACTOR rides along: a local optimistic removal is by
          // definition the user's; a server tombstone carries its reason.
          const serverInfo = digits ? cancelledInfo.get(digits) : undefined;
          const cancelReason = !isCancelled
            ? undefined
            : tombstonedVendor
              ? ("user-removed" as const)
              : ((serverInfo?.reason ?? "unknown") as Vendor["cancelReason"]);
          const cancelledAt = isCancelled ? (serverInfo?.at ?? null) : undefined;
          let base =
            v.cancelled === isCancelled && v.cancelReason === cancelReason && v.cancelledAt === cancelledAt
              ? v
              : { ...v, cancelled: isCancelled, cancelReason, cancelledAt };
          // A cancellation outranks any stale schedule, whoever wrote it: the
          // rows are terminally dropped at drain, so a lingering queuedUntil
          // is a promise already broken.
          if (isCancelled && (base.queuedUntil || base.queuedReason)) {
            base = { ...base, queuedUntil: undefined, queuedReason: undefined };
          }
          // Mirror the authoritative DB state onto the card's stage (forward
          // only) so a messaged / actively-negotiating shop shows the right
          // status regardless of soft filters or feed truncation.
          // The ledger first; the legacy rollup only where the ledger is silent
          // (a thread with no stage row yet, or one still pre-contact, where the
          // card models sending/rfq-sent with better resolution than the poll).
          const ledgerStage = trackerStageForLedger(
            typeof vendorStages[base.id]?.stage === "string"
              ? (vendorStages[base.id].stage as string)
              : null
          );
          const dbState = vendorStates[base.id];
          const target = ledgerStage ?? (dbState ? stageForState(dbState) : null);
          if (target) {
            // A lateral claim (declined / out of stock / unreachable) is not an
            // advance and must land even when it moves the card backwards - it
            // is the ledger refusing to keep pretending.
            if (LEDGER_TERMINAL_CARD_STAGES.has(target)) base = { ...base, stage: target };
            else if (canAdvance(base.stage, target)) base = { ...base, stage: target };
          }
          // THE SHOP'S OWN LAST WORDS. /api/activity has always returned this
          // and nothing consumed it, which is why the panel could file a shop
          // that had already answered under "Awaiting reply".
          const last = lastByVendor[base.id];
          if (last?.lastInboundAt && last.lastInboundAt !== base.lastInboundAt) {
            base = {
              ...base,
              lastInboundText: last.lastInboundText,
              lastInboundEnglish: last.lastInboundEnglish,
              lastInboundAt: last.lastInboundAt,
            };
          }
          // THE AGENT'S OWN LAST WORDS, kept fresh. sentText/sentGloss were
          // stamped once from the outreach response and never again, so the
          // "Awaiting reply" panel showed the opener forever while the agent
          // kept talking. The activity rollup carries the newest real sent
          // body + its gloss - consume it (W1.5).
          if (last?.lastOutboundAt && last.lastOutboundAt !== base.lastOutboundAt) {
            base = {
              ...base,
              sentText: last.lastOutboundText ?? base.sentText,
              // The gloss travels WITH its text - a newer English send must
              // clear the old gloss, never wear it (a mismatched pair lies).
              sentGloss: last.lastOutboundText ? last.lastOutboundEnglish : base.sentGloss,
              lastOutboundAt: last.lastOutboundAt,
            };
          }
          // Seed the offer from the activity feed so OFFERS IN advances fast
          // (only when the card has no richer offer yet - never overwrite the
          // detailed one the replies poll builds).
          if (!base.offer) {
            const o = offerByVendor.get(base.id);
            // Never rewind a terminal card (declined / no-contact) into a
            // bookable deal, and mark the seed not-yet-presentable so the card
            // still shows "confirming deposit + how you get it" until the richer
            // replies poll fills those in (no premature "Lock this deal").
            if (o && canAdvance(base.stage, "offer-received")) {
              base = {
                ...base,
                stage: "offer-received",
                offer: {
                  pricePerDay: o.pricePerDay,
                  listPricePerDay: o.pricePerDay,
                  currency: o.currency,
                  totalPrice: o.pricePerDay * (rfq?.durationDays ?? 1),
                  includesInsurance: false,
                  includesDelivery: false,
                  message: "",
                  round: o.round,
                  verified: o.verified,
                  simulated: false,
                  presentable: false,
                },
              };
            }
          }
          // B8: a re-quote on an ALREADY-priced shop must also land on the fast
          // activity cadence, not wait for the slower replies poll. When the
          // feed carries a newer round (or a changed price) for a card that
          // already has an offer, update just the price fields - preserving the
          // richer deposit/delivery/presentable data the replies poll built.
          if (base.offer) {
            const o = offerByVendor.get(base.id);
            if (
              o &&
              (o.round > (base.offer.round ?? 0) || o.pricePerDay !== base.offer.pricePerDay)
            ) {
              base = {
                ...base,
                offer: {
                  ...base.offer,
                  pricePerDay: o.pricePerDay,
                  currency: o.currency,
                  totalPrice: o.pricePerDay * (rfq?.durationDays ?? 1),
                  round: Math.max(o.round, base.offer.round ?? 0),
                  verified: o.verified || base.offer.verified,
                },
              };
            }
            return finalizeStage(base); // an offer supersedes any queue badge
          }
          const held = byVendor.get(base.id);
          if (held) {
            // A message being DELIVERED right now is its own stage. It used to
            // be no state at all - the row was deleted to claim it and the sent
            // row did not exist yet - so the card fell to "found" and dropped
            // out of every status bucket mid-send.
            const stage: Vendor["stage"] =
              held.sending && (base.stage === "found" || base.stage === "rfq-sent" || !base.stage)
                ? "sending"
                : !held.sending && base.stage === "sending"
                  ? "rfq-sent"
                  : base.stage;
            if (
              base.queuedUntil !== held.until ||
              base.queuedReason !== (held.reason ?? undefined) ||
              stage !== base.stage
            ) {
              return finalizeStage({
                ...base,
                stage,
                queuedUntil: held.until,
                queuedReason: held.reason ?? undefined,
              });
            }
          }
          if (!held && base.queuedUntil) {
            const delivered = sentVendors.has(base.id);
            return finalizeStage({
              ...base,
              queuedUntil: undefined,
              queuedReason: undefined,
              stage: delivered
                ? base.stage === "found" || base.stage === "rfq-sent"
                  ? "awaiting-response"
                  : base.stage
                : base.stage === "rfq-sent"
                  ? "found"
                  : base.stage,
            });
          }
          return finalizeStage(base);
        })
      );
    } catch {
      // NEVER silently freeze. The old blanket catch kept the last snapshot with
      // zero indication, so a failing poll was indistinguishable from a stalled
      // agent - the UI simply stopped updating and nobody could tell why.
      setFeedStale(true);
    }
  });

  async function removeQueued(id: number, vendorId: string | null, toNumber?: string) {
    // TOMBSTONE FIRST: every poll from now on drops this row/badge, so an
    // interleaved poll that read pre-delete server state cannot resurrect it
    // (the remove-flicker). Optimistic clear follows.
    const nowMs = Date.now();
    pendingRemovals.current.set(`id:${id}`, nowMs);
    if (vendorId) pendingRemovals.current.set(`v:${vendorId}`, nowMs);
    setRemovingIds((s) => new Set(s).add(id));
    setQueueItems((items) => items.filter((i) => i.id !== id && (!vendorId || i.vendorId !== vendorId)));
    if (vendorId) {
      setVendors((vs) =>
        vs.map((v) =>
          v.id === vendorId
            ? {
                ...v,
                queuedUntil: undefined,
                queuedReason: undefined,
                cancelled: true,
                lastEventAt: Date.now(),
                stage: v.stage === "rfq-sent" ? "found" : v.stage,
              }
            : v
        )
      );
    }
    try {
      // SERVER-AUTHORITATIVE + ID-CHURN PROOF: the drain loop re-queues held
      // rows under new ids, so the server sweeps EVERY pending row for this
      // shop (not just the tapped id). "sent" comes back only with real
      // delivery evidence - never inferred from a lost id race.
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // toNumber lets the server tombstone the recipient even when every
        // outbox row already drained - "remove" must survive wakeups too.
        body: JSON.stringify({ action: "delete", id, vendorId, toNumber }),
      });
      if (!res.ok) throw new Error(`queue delete ${res.status}`);
      const d = await res.json().catch(() => ({ removed: true }));
      if (d.ok === false && d.error) {
        // The server removed rows but could NOT confirm permanence - say so
        // honestly instead of a silent success.
        setMassNote(t(String(d.error)));
      }
      if (d.sent === true) {
        setMassNote(t("Too late to remove that one - it had already left for the shop."));
        if (vendorId) patchVendor(vendorId, { stage: "awaiting-response", lastEventAt: Date.now() });
      }
    } catch {
      // OFFLINE/FAILURE HONESTY: nothing changed on the server - drop the
      // tombstones so the row honestly reappears, and tell the user.
      pendingRemovals.current.delete(`id:${id}`);
      if (vendorId) pendingRemovals.current.delete(`v:${vendorId}`);
      setMassNote(t("Couldn't reach the server - nothing was removed. Try again."));
    } finally {
      setRemovingIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      refreshQueue();
    }
  }

  // THE PANEL WAS STRUCTURALLY GUARANTEED TO BE SHUT WHILE SHOPS WERE WRITING.
  //
  // The owner's report was "I can't see the status panel, only the status bar,
  // while the rental shops write me". That is not a flaky effect - it is what
  // this code did by construction:
  //
  //   1. `autoOpenedRef` latched per MOUNT, so the effect fired at most once
  //      ever, no matter what happened afterwards.
  //   2. Its predicate matched only OUTBOUND states - queued, rfq-sent,
  //      awaiting-response. The one open it was allowed therefore spent itself
  //      the moment the first message went out.
  //   3. When a shop replied the stage advanced to negotiating / counter-offer
  //      or an offer landed, the predicate went false, and the latch was
  //      already gone. So the panel could only ever open BEFORE anything had
  //      been said, and never once a conversation was live.
  //
  // The fix latches per EVENT rather than per mount. Inbound evidence - a shop
  // that has answered, or an offer that has landed - is counted, and any
  // INCREASE reopens the panel. A traveller who collapses it keeps it collapsed
  // until the next shop writes, which is the only moment reopening is welcome
  // rather than rude.
  const inboundLevel = useMemo(
    () =>
      vendors.reduce(
        (n, v) =>
          n +
          (v.offer ? 1 : 0) +
          (v.lastInboundAt || v.stage === "negotiating" || v.stage === "counter-offer" ? 1 : 0),
        0
      ),
    [vendors]
  );
  const lastInboundLevelRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = lastInboundLevelRef.current;
    lastInboundLevelRef.current = inboundLevel;
    // First observation is a baseline, not an event: a cold load into a hunt
    // that already has five replies must not fight the traveller's own choice
    // of what to look at.
    if (prev === null) return;
    if (inboundLevel > prev) setStatusOpen(true);
  }, [inboundLevel]);

  // The ORIGINAL open still happens - once per mount, when the first batch is
  // on the wire - because seeing the send start is genuinely useful. It is the
  // inbound half above that was missing, not this.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    const sending =
      queueItems.length > 0 ||
      vendors.some(
        (v) => v.queuedUntil || v.stage === "rfq-sent" || v.stage === "awaiting-response"
      );
    if (sending) {
      autoOpenedRef.current = true;
      setStatusOpen(true);
    }
  }, [queueItems.length, vendors]);

  // REALTIME FEEL: the moment the app regains focus/visibility (user flips
  // back from WhatsApp), bump this nonce - both pollers below depend on it,
  // so they re-run their tick IMMEDIATELY instead of waiting a full interval.
  const [syncNonce, setSyncNonce] = useState(0);
  useEffect(() => {
    const wake = () => {
      if (!document.hidden) setSyncNonce((n) => n + 1);
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    // B8 stage 1: the service worker postMessages the open tab the instant a
    // push arrives (or a notification is tapped) - wake the polls immediately
    // instead of waiting out the 6-15s interval that caused "push says a price,
    // card still says waiting".
    const onSwMessage = (e: MessageEvent) => {
      if (e.data?.type === "wd-refresh") setSyncNonce((n) => n + 1);
    };
    navigator.serviceWorker?.addEventListener?.("message", onSwMessage);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      navigator.serviceWorker?.removeEventListener?.("message", onSwMessage);
    };
  }, []);

  // Alerts (browser push) are owned end-to-end by AlertsChip / usePushAlerts,
  // whose truth is the push_subscriptions row on the server. This page used to
  // carry a second, parallel implementation seeded from localStorage - which is
  // how the funnel could show "Alerts on" as a dead label while Profile's real
  // toggle disagreed, with no way to turn them off from here at all.

  // Poll the consolidated activity endpoint while there are vendors on
  // screen (cheap, user-scoped). Pauses in hidden tabs - no wasted requests.
  // ONE POLL AT A TIME. /api/activity awaits real drain work - up to roughly
  // sixteen seconds of it on a busy hunt - while this interval fires every six.
  // With no in-flight guard three or more requests stacked per tab, each one
  // re-entering the same drains, and every extra tab multiplied it. The guard
  // is a ref rather than state because it must not cause a render and must be
  // read synchronously by the very next tick.
  const activityInFlight = useRef(false);
  useEffect(() => {
    if (!session || vendors.length === 0) return;
    const tick = async () => {
      if (document.hidden || activityInFlight.current) return;
      activityInFlight.current = true;
      try {
        await refreshQueue();
      } finally {
        // ALWAYS cleared, including on unmount mid-flight. A guard that can
        // stay stuck true is worse than no guard - it stops the polling
        // permanently instead of merely stacking it.
        activityInFlight.current = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), pollCfg.activityMs);
    return () => clearInterval(id);
  }, [session, vendors.length, refreshQueue, pollCfg.activityMs, syncNonce]);

  // Reply-VERIFIED shop tags (item #13): one batched fetch per result set,
  // plus a slow refresh while the search is on screen - a shop's second
  // confirming reply can promote a tag mid-session.
  const vendorIdsKey = useMemo(
    () => vendors.map((v) => v.id).filter(Boolean).sort().join(","),
    [vendors]
  );
  useEffect(() => {
    if (!session || !vendorIdsKey) return;
    let cancelled = false;
    const load = async () => {
      try {
        const d = await (
          await fetch(`/api/vendors/tags?ids=${encodeURIComponent(vendorIdsKey)}`)
        ).json();
        if (cancelled || !d?.tags) return;
        setVendors((vs) =>
          vs.map((v) => {
            const next = (Array.isArray(d.tags[v.id]) ? d.tags[v.id] : []).slice().sort();
            const curTags = (v.verifiedTags ?? []).slice().sort();
            if (next.join("|") === curTags.join("|")) return v;
            return { ...v, verifiedTags: next };
          })
        );
      } catch {}
    };
    load();
    const id = setInterval(load, pollCfg.tagsMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session, vendorIdsKey, pollCfg.tagsMs]);

  // THE REPLY POLL'S CONCURRENCY GUARD LIVES ABOVE THE EFFECT, ON PURPOSE.
  //
  // Refs, not `let`s inside the effect: the effect is re-created on wake, and a
  // per-effect flag is a guard that resets exactly when it is needed most (see
  // the long note at the effect itself).
  const repliesInFlight = useRef(false);
  const repliesAbort = useRef<AbortController | null>(null);

  // Live loop: while agents are in ANY active conversation, poll the reply
  // feed so shop answers pop into the cards automatically. This must include
  // offer-received/negotiating - after a bargain is sent the shop's counter
  // must still arrive without a manual refresh.
  // Poll while anything is genuinely in flight. A COMPLETE presented offer is
  // settled - polling it forever burns battery and quota for nothing (the
  // activity poll + focus-resync still catch a late surprise reply).
  const waiting =
    vendors.some(
      (v) =>
        // "counter-offer" is the stage a shop enters right after the agent
        // counters - reply polling MUST stay alive for the shop's response, and
        // this poll is also the outbox + graph-wakeup drain. Omitting it stalled
        // a hunt where every shop had been countered. "out-of-stock" keeps the
        // restock-clear path (in the replies poll) running so the card can
        // rejoin the live flow on its own.
        ["sending", "rfq-sent", "awaiting-response", "negotiating", "counter-offer", "out-of-stock"].includes(
          v.stage ?? ""
        ) ||
        (v.stage === "offer-received" && v.offer && v.offer.presentable !== true)
    ) ||
    // Keep the reply loop (which also drives inbound recovery + the outbox drain)
    // alive while ANY message is still queued. Otherwise, once every card settled
    // to a presentable offer the poll stopped - and the agent's parked
    // counter-reply never drained and late shop replies never surfaced (the
    // "agents never message back / app never updates" reports).
    queueItems.length > 0 ||
    // BUG 2: during the ACTIVE dispatch window (openers going out / just sent),
    // always poll so a shop's first offer lands in the card within seconds even
    // if the vendor's client-side stage has not caught up yet. Bounded: `running`
    // is the dispatch phase and resets on a new search / idle.
    phase === "running";
  useEffect(() => {
    if (!session || !waiting || !rfq) return;
    // Stale-run guard: an unmounted/reconfigured effect must never apply its
    // in-flight response to fresh state (the epoch may have changed).
    let cancelled = false;
    // ONE POLL AT A TIME - AND THE GUARD HAS TO OUTLIVE THE EFFECT.
    //
    // /api/replies does real work on the server - it flushes this traveller's
    // due WhatsApp sends and runs their due agent turns - so it can take longer
    // than the interval that fires it. With no guard, a slow request simply had
    // the next one launched on top of it, and on a bad host that stacks
    // indefinitely: N concurrent drains of the same queue, all contending for
    // the same claims, on a phone that has stopped showing anything new.
    //
    // W8 #17: the flag was a `let` DECLARED INSIDE THE EFFECT, and the effect
    // is re-created on wake (`syncNonce` is in its deps, and waking is exactly
    // when a slow drain is likeliest to still be running). The new closure got
    // a brand-new `inFlight = false` and launched a second concurrent drain on
    // top of the first, which nothing aborted - so returning to the tab did the
    // one thing the comment above promises it does not. A ref survives the
    // re-creation, and the AbortController makes cleanup actually cancel the
    // request instead of only ignoring its answer.
    const inFlight = repliesInFlight;
    const tick = async () => {
      // Pause in a hidden tab (parity with the activity poll) - no wasted
      // /api/replies requests while backgrounded; resumes on focus.
      if (typeof document !== "undefined" && document.hidden) return;
      if (inFlight.current) return;
      inFlight.current = true;
      const ctl = new AbortController();
      repliesAbort.current = ctl;
      try {
        // Scope to THIS session both server-side (since=) and client-side, so a
        // previous search's replies can never render on the new results.
        // The declared spec travels with the poll so the shop's menu is scoped
        // to the vehicle they actually asked for (and hold a licence for).
        const spec = new URLSearchParams({
          since: String(epochOnServerClock()),
          t: String(Date.now()),
        });
        if (rfq?.engineSizeCc) spec.set("cc", String(rfq.engineSizeCc));
        if (rfq?.durationDays) spec.set("days", String(rfq.durationDays));
        if (rfq?.vehicleClass) spec.set("vclass", rfq.vehicleClass);
        if (rfq?.transmission && rfq.transmission !== "any") spec.set("tx", rfq.transmission);
        const res = await fetch(`/api/replies?${spec.toString()}`, {
          cache: "no-store",
          signal: ctl.signal,
        });
        const d = await res.json();
        if (cancelled) return;
        // Shops that walked away: the card says so honestly - it never keeps
        // pretending the agent is "still confirming" a dead conversation.
        const declinedIds = new Set<string>(
          (d.replies ?? []).filter((r: { declined?: boolean }) => r.declined).map((r: { vendorId: string }) => r.vendorId)
        );
        if (declinedIds.size > 0) {
          setVendors((vs) =>
            vs.map((v) =>
              declinedIds.has(v.id) && v.stage !== "declined" ? { ...v, stage: "declined" } : v
            )
          );
        }
        // THE AGENT IS NOT SURE, SO IT ASKED (W4.4). A thread paused on a
        // confirming question is doing something specific and useful; from
        // outside it looked exactly like an idle one, and the panel filled the
        // silence with "your agent is asking for a price" - which was false and
        // made a careful agent look like a stuck one.
        const confirmingByVendor = new Map<string, string>();
        // W4.6: ...and WHICH LANGUAGE we are writing to this shop in, when the
        // shop themselves asked us to change it. Carried on the same rows so
        // the status panel and the card tell the traveller the same thing.
        const langByVendor = new Map<string, { mode: "english" | "local"; quote?: string }>();
        for (const r of (d.replies ?? []) as Array<{
          vendorId: string;
          confirming?: string | null;
          languageSwitch?: "english" | "local" | null;
          languageSwitchQuote?: string | null;
        }>) {
          if (r.confirming && !confirmingByVendor.has(r.vendorId)) {
            confirmingByVendor.set(r.vendorId, r.confirming);
          }
          if (r.languageSwitch && !langByVendor.has(r.vendorId)) {
            langByVendor.set(r.vendorId, {
              mode: r.languageSwitch,
              quote: r.languageSwitchQuote ?? undefined,
            });
          }
        }
        // ABSENCE IS NOT EVIDENCE (owner report 6, L7/D). The feed is capped
        // at 40 rows ACROSS ALL SHOPS - on a busy hunt an older shop's rows
        // fall out of the window while its state is unchanged. Clearing a
        // fact because its row scrolled away is how "confirming" flapped and
        // out-of-stock shops sprang back to life. Only a shop with rows IN
        // this payload gets its state re-derived; the rest keep what they had.
        const inWindow = new Set<string>(
          ((d.replies ?? []) as Array<{ vendorId: string }>).map((r) => r.vendorId)
        );
        setVendors((vs) =>
          vs.map((v) => {
            if (!inWindow.has(v.id)) return v;
            const c = confirmingByVendor.get(v.id);
            const lang = langByVendor.get(v.id);
            if (c === v.confirming && lang?.mode === v.languageSwitch) return v;
            return {
              ...v,
              confirming: c,
              languageSwitch: lang?.mode,
              languageSwitchQuote: lang?.quote,
            };
          })
        );
        // OUT OF STOCK is its own state - the shop is willing, it simply has no
        // vehicle today. A card that sat on "awaiting reply" forever is what
        // this replaces; when they restock the flag clears and the card returns
        // to the live flow on its own.
        const outOfStockIds = new Set<string>(
          (d.replies ?? [])
            .filter((r: { unavailable?: boolean }) => r.unavailable)
            .map((r: { vendorId: string }) => r.vendorId)
        );
        setVendors((vs) =>
          vs.map((v) => {
            // Absence is not evidence (L7): a shop whose rows fell out of the
            // 40-row window keeps its state - only an explicit row may flip it.
            if (!inWindow.has(v.id)) return v;
            const out = outOfStockIds.has(v.id);
            if (out && v.stage !== "out-of-stock" && !declinedIds.has(v.id)) {
              return { ...v, stage: "out-of-stock" as TrackerStage };
            }
            // Restocked: hand the card back to the normal flow.
            if (!out && v.stage === "out-of-stock") {
              return { ...v, stage: (v.offer ? "offer-received" : "awaiting-response") as TrackerStage };
            }
            return v;
          })
        );
        // FACTS PASS (owner problem #8). The priced merge below still gates on
        // a price - but a reply with no readable price is NOT a reply with
        // nothing in it: the server computed the deposit, the delivery offer,
        // the call request, the location question and the alternativeOffer for
        // that same row, and skipping it dropped them all (the blank card, and
        // the substitution Yes/No UI that had never rendered while the agent
        // held the thread silent waiting for an answer the traveller was never
        // shown). Apply the newest row's FACTS for every vendor in the window,
        // price or no price - the pure merge lives in lib/client/reply-facts so
        // it is executable under test.
        {
          const { applyReplyFacts } = await import("@/lib/client/reply-facts");
          type FactsRow = Parameters<typeof applyReplyFacts>[1];
          const newestAnyByVendor = new Map<string, FactsRow>();
          for (const r of (d.replies ?? []) as FactsRow[]) {
            if (searchEpoch && r.createdAt && Date.parse(r.createdAt) < epochOnServerClock())
              continue;
            const cur = newestAnyByVendor.get(r.vendorId);
            if (
              !cur ||
              Date.parse(String(r.createdAt ?? 0)) > Date.parse(String(cur.createdAt ?? 0))
            ) {
              newestAnyByVendor.set(r.vendorId, r);
            }
          }
          if (newestAnyByVendor.size) {
            setVendors((vs) =>
              vs.map((v) => {
                const r = newestAnyByVendor.get(v.id);
                return r ? applyReplyFacts(v, r) : v;
              })
            );
          }
        }
        // NEWEST ROW PER VENDOR WINS. The feed arrives newest-first; applying
        // every row would make the OLDEST functional update win (React applies
        // them in order), silently reverting a fresher negotiated price to an
        // older, higher one and inflating the round counter.
        //
        // AND A SOURCED PRICE IS A PRICE. `!r.found` used to skip the row
        // entirely, which dropped everything ON it - the shop's option menu,
        // the price read off its photographed board, the thread's standing
        // price - and the card sat on "No price yet" while its own excerpt
        // showed one. A row whose server-side effectivePrice carries a number
        // is admitted; a CONFIRMED row always outranks a sourced one for the
        // same shop, whatever their timestamps.
        const newestByVendor = new Map<string, (typeof d.replies)[number]>();
        for (const r of d.replies ?? []) {
          const confirmed = Boolean(r.found && r.pricePerDay);
          if (!confirmed && !r.effectivePrice?.pricePerDay) continue;
          if (searchEpoch && r.createdAt && Date.parse(r.createdAt) < epochOnServerClock())
            continue;
          const cur = newestByVendor.get(r.vendorId);
          const curConfirmed = Boolean(cur && cur.found && cur.pricePerDay);
          if (
            !cur ||
            (confirmed && !curConfirmed) ||
            (confirmed === curConfirmed && Date.parse(r.createdAt) > Date.parse(cur.createdAt))
          ) {
            newestByVendor.set(r.vendorId, r);
          }
        }
        for (const r of newestByVendor.values()) {
          // Content decides (D1). Same id, changed payload = the thread
          // learned something (a deposit landed, presentable flipped, the
          // vehicle got confirmed) - re-apply it. Same id, same payload =
          // nothing new, skip exactly like the old id-once gate.
          const fp = JSON.stringify(r);
          const prev = appliedReplies.current.get(r.id);
          if (prev === fp) continue;
          const isNewRow = prev === undefined;
          appliedReplies.current.set(r.id, fp);
          // Confirmed rows carry the price on themselves; sourced rows carry it
          // in effectivePrice with a provenance tag the card will show.
          const confirmedRow = Boolean(r.found && r.pricePerDay);
          const price: number = confirmedRow ? r.pricePerDay : r.effectivePrice.pricePerDay;
          const priceSource = confirmedRow ? undefined : r.effectivePrice.source;
          setVendors((vs) =>
            vs.map((v) => {
              if (v.id !== r.vendorId) return v;
              // A sourced price must never REPLACE a confirmed offer - it only
              // fills the silence before one exists (or refreshes an earlier
              // sourced one).
              if (!confirmedRow && v.offer && !v.offer.priceSource) return v;
              return {
                    ...v,
                    stage: declinedIds.has(r.vendorId)
                      ? ("declined" as TrackerStage)
                      : ("offer-received" as TrackerStage),
                    offer: {
                      priceSource,
                      priceSourceVehicle: confirmedRow
                        ? undefined
                        : r.effectivePrice.vehicle ?? undefined,
                      pricePerDay: price,
                      listPricePerDay: v.offer?.listPricePerDay ?? price,
                      // The shop's OWN currency from the reply (server-derived);
                      // never a silent USD default.
                      currency: confirmedRow
                        ? r.currency ?? v.offer?.currency ?? "USD"
                        : r.effectivePrice.currency ?? r.currency ?? v.offer?.currency ?? "USD",
                      totalPrice: Math.round(price * rfq.durationDays),
                      // Now wired from the shop's confirmed reply (was always
                      // false, so an "insurance included" quote never showed).
                      includesInsurance:
                        r.insuranceIncluded === true || v.offer?.includesInsurance === true,
                      includesDelivery: r.delivers === true || v.offer?.includesDelivery === true,
                      deliveryFee: r.deliveryFee ?? v.offer?.deliveryFee,
                      message: r.replyText?.slice(0, 200) ?? "",
                      // English gloss of a local-language reply (W1.5) - every
                      // surface that quotes the shop can show the translation.
                      messageEnglish: r.english?.slice(0, 200) ?? undefined,
                      // A sourced price is not a negotiation round - only a
                      // NEW confirmed reply advances the counter (a re-apply
                      // of the same row for fresher thread facts is not a
                      // round, or every poll would inflate it).
                      round: v.offer
                        ? confirmedRow && isNewRow
                          ? v.offer.round + 1
                          : v.offer.round
                        : 0,
                      verified: confirmedRow && Boolean(r.verified),
                      // false = the shop quoted a DIFFERENT vehicle; the card
                      // flags it and it is excluded from the best-price picker.
                      // undefined (legacy) is treated as matching. A SOURCED
                      // price must not inherit the found:false row's verdict -
                      // its vehicle is whatever tier the source named, which is
                      // exactly what the provenance chip discloses.
                      matchesSpec: confirmedRow ? r.matchesSpec ?? true : true,
                      // The vehicle-identity gate. Only "confirmed" may ever be
                      // presented as a deal (see offer-presentation).
                      vehicleStatus: r.vehicleStatus ?? undefined,
                      vehicleNote: r.vehicleNote ?? undefined,
                      simulated: false,
                      deposit: r.deposit ?? v.offer?.deposit,
                      depositType: r.depositType ?? v.offer?.depositType,
                      depositAmount: r.depositAmount ?? v.offer?.depositAmount,
                      depositCurrency: r.depositCurrency ?? v.offer?.depositCurrency,
                      // Digraph engine: how the traveller gets the vehicle, deal
                      // completeness gating, and pickup-consent status.
                      fulfillment: r.fulfillment ?? v.offer?.fulfillment ?? undefined,
                      presentable: r.presentable ?? v.offer?.presentable,
                      pickupOffered:
                        r.pickupOffered === true || v.offer?.pickupOffered === true || undefined,
                      pickupConsent:
                        r.pickupConsent === true || v.offer?.pickupConsent === true || undefined,
                      // The shop's price MENU when it offered a choice. Kept on
                      // the vendor object because VendorCard is memo'd - a
                      // sibling prop would not re-render the card.
                      options: r.options ?? v.offer?.options,
                      // The shop's counter-proposal of a DIFFERENT vehicle, and
                      // the per-extra verdicts. The old literal omitted both,
                      // so a priced row silently wiped what the facts pass (or
                      // an earlier row) had established - and the substitution
                      // Yes/No UI could never survive to render.
                      alternativeOffer: r.alternativeOffer ?? v.offer?.alternativeOffer,
                      accessories: r.accessories ?? v.offer?.accessories,
                      // K7: the shop asked to talk by phone - the model read
                      // it, the thread stored it, the card wears the chip.
                      wantsCall: r.wantsCall ?? v.offer?.wantsCall,
                      // Their own question, so the card can say why they want
                      // it. Cleared the moment we have shared something.
                      askedLocationQuote:
                        r.pickupConsent === true || v.offer?.pickupConsent === true
                          ? undefined
                          : r.askedLocationQuote ?? v.offer?.askedLocationQuote,
                    },
              };
            })
          );
        }
      } catch {
      } finally {
        if (repliesAbort.current === ctl) repliesAbort.current = null;
        inFlight.current = false;
      }
    };
    tick();
    const id = setInterval(tick, pollCfg.repliesMs);
    return () => {
      cancelled = true;
      clearInterval(id);
      // ABORT, don't just ignore. The old cleanup left a slow drain running and
      // the re-created effect started a second one beside it.
      repliesAbort.current?.abort();
      repliesAbort.current = null;
      inFlight.current = false;
    };
  }, [session, waiting, rfq, searchEpoch, pollCfg.repliesMs, syncNonce]);

  function runFunnel(list: Vendor[], _activeRfq: StructuredRFQ) {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const schedule = (fn: () => void, ms: number) =>
      timers.current.push(setTimeout(fn, ms));

    list.forEach((vendor, i) => {
      const base = i * 200;
      schedule(() => {
        // Sentiment is a pure function of rating - computing it here instead of
        // one HTTP call PER VENDOR makes every search dramatically faster.
        const warmth = Math.min(1, Math.max(0.1, (vendor.rating - 3.5) / 1.4));
        patchVendor(vendor.id, {
          stage: "locating-contact",
          sentiment: Number(warmth.toFixed(2)),
        });
      }, base + 300);
      // HONESTY: "Locating" is a brief transition, never a resting state - a
      // card must not claim ongoing work that isn't happening. The real number
      // resolution runs inside /api/outreach when the user (or Will) asks.
      // Only advance locating -> found; never stomp a stage that moved on.
      schedule(() => {
        setVendors((vs) =>
          vs.map((v) =>
            v.id === vendor.id && v.stage === "locating-contact" ? { ...v, stage: "found" } : v
          )
        );
      }, base + 1500);
    });
    schedule(() => setPhase("done"), list.length * 200 + 1400);
  }

  async function startSearch(overrideText?: string, structuredFields?: Partial<StructuredRFQ>) {
    // Will can hand in fresh request text ("find me a 125cc scooter...") -
    // it becomes the visible textarea value AND this search's request.
    const ov = typeof overrideText === "string" ? overrideText.trim() : "";
    if (ov) setRawText(ov);
    // HEADER RESET (structured mode): a tap-built search must never leave the
    // previous free-text query visible anywhere - the structured chips are the
    // only description of the active session.
    if (structuredFields) setRawText("");
    const requestText = ov || rawText;
    // The tap-to-build panel (F2) supplies fully-structured fields instead of
    // free text - no requestText needed in that path.
    //
    // M9/M1: THIS USED TO BE A SILENT `return`. Tapping the one CTA with an
    // empty box and no vehicle picked did literally nothing - no message, no
    // scroll, no disabled state - which reads as a broken button, not as
    // "you have not told me what you want yet". The two guards below it were
    // already honest about their reason; this one now matches them.
    if (!structuredFields && !requestText.trim()) {
      setMassNote(
        t("Tell me what you are looking for first - pick a vehicle above or describe it in your own words.")
      );
      document
        .querySelector("[data-tour='request']")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    // PAIRING GATE, enforced not just painted. The blur-lock makes the form
    // inert, but Will can call startSearch directly - and a search whose agents
    // can never message anyone is a dead end. Only block on a CONFIRMED unlink
    // (false), never while the status read is still pending (null).
    if (waConnected === false) {
      setMassNote(
        t("Link your WhatsApp first - your agents bargain from your own number.")
      );
      document
        .querySelector("[data-tour='request']")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    // No coordinates, no search - there is no silent default city anymore.
    if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) {
      setOriginHint("Set your location first - allow GPS or type your hotel / area.");
      document
        .querySelector("[data-tour='stay']")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setOriginHint(null);
    // A search starting is the celebration's natural end.
    clearJustLinked();
    // The whole-screen wash answers the tap on this very frame and holds
    // through profiling + discovery. Every exit below lowers it; a thrown
    // fetch is caught by AmbientGlow's own timeout escape.
    raiseAmbient();
    setPhase("profiling");
    setVendors([]);
    setRfq(null);
    setSource(null);
    setSourceError(null);
    // Open a fresh atomic session: stamp the epoch and forget every reply id
    // applied by the previous session.
    const epoch = Date.now();
    setSearchEpoch(epoch);
    appliedReplies.current = new Map();
    // The mass-bargain blast belongs to the OLD hunt (D6): its "running"
    // spinner and "Asked N shops" note must never survive into the next one.
    setMassState("idle");
    setMassNote(null);
    // Shop avatars are ephemeral: a new search must never show the previous
    // session's shops (they belong to people who never signed up here).
    clearShopAvatars();
    setQueueItems([]);
    // THREE CALLS THAT DID NOT NEED TO QUEUE BEHIND EACH OTHER.
    //
    // This was strictly serial - close the old session, then structure the
    // request, then find the shops - and every stage waits out the one before
    // it. Each is a network round trip, discovery talks to Google with its own
    // retry chain, and the traveller watched "Structuring your request" for
    // over a minute while nothing on screen said what was actually happening.
    //
    // The dependencies are narrower than the order suggested:
    //
    //   - Closing the previous session must precede SENDING, not searching. It
    //     stops old threads being messaged; nothing about finding shops depends
    //     on it. So it starts now and is awaited just before the funnel runs.
    //   - Discovery needs an origin, a radius and a vehicle CLASS. When the
    //     request panel built the request we already hold the class, so
    //     discovery starts in the same tick as the profiler instead of after
    //     it. On the free-text path the class genuinely is the profiler's
    //     answer, and only that path still waits.
    const closing = (async () => {
      // SCOPED close: the server only touches the session bounded by these
      // epochs (from = the closing session's start, before = this new
      // session's start). That is what makes the retry below SAFE - a
      // retried close can never reach shops the new session queues in the
      // meantime, which is how six never-removed shops once rendered as
      // "REMOVED BY YOU".
      const payload = JSON.stringify({ from: searchEpoch || undefined, before: epoch });
      const close = () =>
        fetch("/api/session/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }).then((r) => r.ok);
      let closed = await close().catch(() => false);
      if (!closed) {
        await new Promise((r) => setTimeout(r, 1200));
        closed = await close().catch(() => false);
      }
      return closed;
    })();

    const profileP = fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(structuredFields
          ? { structured: true, fields: structuredFields }
          : { text: requestText }),
        // W-7 / W9: THE TYPED PATH CARRIES A WINDOW TOO - ON EVERY SEARCH.
        //
        // This used to be gated on the traveller having touched the control, so
        // the DEFAULT search sent no window at all: no start date reached the
        // shops and the server's duration fell back to a hard-coded 3, while the
        // card right above this button read "From <today> - For 4 days". The
        // window the traveller can SEE is the window that must go on the wire.
        //
        // `windowExplicit` carries the other half of the truth: which control
        // they actually set. Untouched values fill what their sentence left
        // unsaid and yield to what it states ("from the 20th for a week");
        // touched values are statements and win outright. Two independent flags,
        // because they are two independent controls.
        ...(!structuredFields
          ? {
              startDate: startDate || planWindow.startDate,
              durationDays: days,
              windowExplicit: { startDate: startTouched, durationDays: daysTouched },
            }
          : {}),
        // THE TRAVELLER'S DAY, not Greenwich's. clampRfqWindow already accepted
        // a zone and already did the right thing with one - the client simply
        // never sent it, so every rental window in Asia was decided against a
        // date that was still yesterday.
        timeZone: deviceTimeZone(),
      }),
    });

    const discover = (vehicleClass: string, rfqSnap?: StructuredRFQ) =>
      fetch("/api/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The LABEL travels with the coordinates: it is the app's `region`,
          // and the search row is what a restored hunt reads it back from.
          origin: { lat: origin.lat, lng: origin.lng, label: origin.label ?? "" },
          radiusKm,
          vehicleClass,
          lang,
          fulfillment: rfqSnap?.fulfillment === "any" ? undefined : rfqSnap?.fulfillment,
          // Snapshot-forward: hand the full RFQ so the search row can store it
          // and this hunt is restorable later from Trips (issue 8). On the fast
          // path the fields are handed over instead and the route derives the
          // same snapshot with the same pure function - no LLM either way.
          rfq: rfqSnap,
          fields: rfqSnap ? undefined : structuredFields,
        }),
      });

    // The fast path: shops are already being looked up while the request is
    // still being structured.
    const earlyVendorsP = structuredFields?.vehicleClass
      ? discover(structuredFields.vehicleClass)
      : null;

    const pRes = await profileP;
    // PARSE DEFENSIVELY, AND ONLY AFTER res.ok (OR11 F2.1). A non-JSON body - a
    // 502/504 HTML error page from Cloud Run, a gateway timeout, an upstream
    // that returned text - made `pRes.json()` THROW here, BEFORE the !ok branch
    // could reset the funnel. The throw rejected the whole async startSearch, so
    // "Structuring your request" hung forever with no way back and no error. A
    // guarded parse turns every failure - malformed OR non-ok - into the same
    // honest, recoverable message.
    const pData = await pRes.json().catch(() => null);
    if (!pRes.ok || !pData) {
      lowerAmbient();
      setPhase("idle");
      // M5: alert() is the one surface in the app that looks like a browser
      // crash - the same in-page channel every other failure uses.
      setSourceError(
        (pData && pData.error) || t("Could not parse your request - try rephrasing it.")
      );
      return;
    }
    setRfq(pData.rfq);
    // W-7: THE PICKER NOW SHOWS THE WINDOW THE SEARCH ACTUALLY RAN WITH.
    //
    // The server is the rental-window authority and always was; what it never
    // did was say so. `clampRfqWindow` returns `{adjusted, reason}` and every
    // caller dropped both, so a free-plan traveller who picked next Tuesday got
    // today's rental and no explanation - the control still read "Tuesday".
    // Syncing the control back from the compiled RFQ also settles the other
    // direction: a date the PROFILER read out of their prose ("from the 20th")
    // appears in the picker instead of being invisible.
    //
    // W9: SYNCING THE DISPLAY IS NOT THE TRAVELLER TOUCHING THE CONTROL. This
    // used to flip the touched flag, which was the only way an unstated window
    // could survive to the next search - and now that the window travels on
    // every search anyway, flipping it would only mean search #2 silently
    // overruling a date search #2's own prose states. The picker shows what ran;
    // "explicit" still means they set it.
    if (pData.rfq?.startDate) setStartDate(pData.rfq.startDate);
    // W4.1: A DURATION OVERWRITE IS NOT ALLOWED TO BE SILENT.
    //
    // The picker is overwritten from the server's answer (right below) with no
    // word to the traveller, and the only explanation channel was wired
    // exclusively to the PLAN clamp. So when the search collapsed 3 days into 1
    // - the profiler inventing a length the traveller never stated - the
    // control simply read "1" afterwards and twenty shops were asked about a
    // one-day rental. The fix upstream stops the collapse; this makes any
    // remaining disagreement visible, on the channel the clamp already uses.
    //
    // W9: the comparison is against what the CARD SAID when they pressed the
    // button, touched or not - that is the number they saw, so that is the
    // number a change has to be explained against. Gated on `windowTouched` it
    // could not fire at all on the default search (the flag was false), which is
    // exactly the search that was silently collapsing 4 days into 3.
    const askedDays = days;
    const gotDays = Number(pData.rfq?.durationDays);
    const durationChanged = Number.isFinite(gotDays) && gotDays !== askedDays;
    if (Number.isFinite(pData.rfq?.durationDays)) setDays(pData.rfq.durationDays);
    setWindowNote(
      pData.windowAdjusted
        ? pData.windowReason ?? null
        : durationChanged
          ? t("We searched for {n} days, not {asked} - tap the dates to change it.")
              .replace("{n}", String(gotDays))
              .replace("{asked}", String(askedDays))
          : null
    );
    // The active filter always follows the requested vehicle class.
    setFilters({ ...DEFAULT_FILTERS, vehicleClass: pData.rfq.vehicleClass });
    setPhase("discovering");

    const vRes = await (earlyVendorsP ?? discover(pData.rfq.vehicleClass, pData.rfq));
    if (!vRes.ok) {
      // A failed discovery call must NEVER masquerade as "no shops found
      // near your stay" - that sends users widening the radius for nothing.
      const err = await vRes.json().catch(() => ({}));
      lowerAmbient();
      setPhase("idle");
      setSourceError(
        err.error ?? t("The shop search hiccuped - tap Find my deal to try again.")
      );
      return;
    }
    const vData = await vRes.json();
    const list: Vendor[] = (vData.vendors ?? []).map((v: Vendor) => ({
      ...v,
      stage: "queued" as TrackerStage,
    }));
    setSource(vData.source ?? "demo");
    setSourceError(vData.sourceError ?? null);
    setVendors(list);

    // NOW the close matters: nothing may be SENT until the previous session's
    // queue and wakeups are gone. By this point it has had the whole discovery
    // round trip to finish, so it almost never costs anything.
    if (!(await closing)) {
      setMassNote(
        t("Starting a fresh search - but the server could not confirm stopping the previous session's messages. Check the queue in a moment.")
      );
    }

    // A declaration is made about THIS request. The next search asks again.
    setIdpConsent(false);
    // The shops are on screen - the WAIT is over even though the funnel keeps
    // working. Holding the wash through the whole negotiation would teach
    // travellers to ignore it.
    lowerAmbient();
    setPhase("running");
    runFunnel(list, pData.rfq);
  }

  function applyOffer(vendorId: string, offer: Offer) {
    patchVendor(vendorId, { stage: "offer-received", offer });
  }

  // Pickup consent: the traveller approved sharing their EXACT location with a
  // shop that offered to pick them up. Prefer a fresh precise GPS fix; fall back
  // to the search origin's coordinates. The location is sent ONLY from here.
  // MODULE 5: the tap only AUTHORIZES the share - no client coordinates are
  // ever posted (the old getCurrentPosition/stale-origin fallback leaked a
  // previous trip's GPS to a shop). The server composes from the VERIFIED stay
  // (typed address; precise pin only with the default-OFF toggle). reason
  // "no-stay" means the user must configure their stay first - the caller
  // opens the location settings.
  // `sharePlace` is an optional ONE-OFF place NAME the traveller picked instead
  // of their saved stay (they are on the way, not at the hotel yet). It is a
  // name, never coordinates, and the server re-resolves it against Google
  // before anything reaches a shop.
  const pickupConsent = useCallbackRef(async (
    vendor: Vendor,
    sharePlace?: string
  ): Promise<{ ok: boolean; reason?: string }> => {
    try {
      const res = await fetch("/api/negotiate/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: vendor.whatsapp || undefined,
          placeId: vendor.placeId,
          shareQuery: sharePlace || undefined,
        }),
      });
      const d = await res.json();
      if (d.ok)
        patchVendor(vendor.id, {
          offer: { ...vendor.offer!, pickupConsent: true, askedLocationQuote: undefined },
        });
      return { ok: Boolean(d.ok), reason: d.reason };
    } catch {
      return { ok: false, reason: "network" };
    }
  });

  // Created ONCE. Passing `pickVendorOption(setBookingVendor)` inline meant a
  // fresh function on every render, so `memo(VendorCard)` compared a new prop
  // every time and re-rendered all of them - the whole list, twice per poll.
  const onBookVendor = useCallbackRef((v: Vendor, option?: VehicleOption) =>
    pickVendorOption(setBookingVendor)(v, option)
  );
  const onBargainVendor = useCallbackRef((v: Vendor, option?: VehicleOption) =>
    pickVendorOption(setBargainVendor)(v, option)
  );
  // The last two inline arrows on the card. `onX={(v) => setState(v)}` reads as
  // free, but it allocates a new function on every render of this page and
  // hands it to a memo'd child - which is the same memo break as passing a
  // rebuilt object, just harder to see.
  const onLocationRequest = useCallbackRef((v: Vendor) => setLocationAskFor(v));
  const onOpenThread = useCallbackRef((v: Vendor) => setDashboardFor(v));

  const customMessage = useCallbackRef(async (
    vendorId: string,
    message: string,
    opts?: { userMove?: boolean }
  ): Promise<OutreachReply> => {
    const vendor = vendors.find((v) => v.id === vendorId);
    // `res.json()` threw here on any non-JSON response - an HTML 500, a gateway
    // 504 - and the rejection surfaced to Will and to the composer as an
    // unhandled failure. `fetchJson` always settles, never throws, keeps the
    // server's JSON body even on a non-2xx, and bounds the wait.
    const r = await fetchJson<OutreachReply>("/api/outreach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeoutMs: 50_000,
      body: JSON.stringify({
        to: vendor?.whatsapp || undefined,
        placeId: vendor?.placeId,
        vendorId,
        vendorName: vendor?.name,
        message,
        kind: "custom",
        rfq,
        region: origin?.label || undefined,
        openNow: vendor?.openNow,
        // Action-chip sends (Push harder, Ask deposit, ...) mark themselves so
        // the server's one-move-per-window debounce applies; a hand-typed
        // message never sets this and is never throttled by it.
        userMove: Boolean(opts?.userMove),
      }),
    });
    if (r.data) return r.data;
    // No body at all - a timeout, a dead connection, or a non-JSON answer. The
    // shape every caller already branches on, with a readable reason instead of
    // a thrown promise.
    return { allowed: true, sent: false, error: r.error ?? "The send did not go through." };
  });

  // THE ACTION REGISTRY, MOUNTED (lib/actions/registry).
  //
  // Will's "Push harder" used to resolve to `setWillOpen(true)` - it opened a
  // panel. That was not a prompt problem: the bridge he had exposed view-state
  // setters only, so the only thing an assistant could do was move the
  // traveller's eyes, and every offer to help ended in the traveller doing the
  // work. These executors give the registry's named actions real bodies, and
  // every outbound one goes through `customMessage` - the same /api/outreach
  // path, the same guard, the same anti-ban pacing and cancellation vetoes an
  // agent message passes. Nothing an assistant does gets a shortcut around it.
  // What the last action did. One place, one renderer - see outcomeFor.
  const [actionNote, setActionNote] = useState<ActionOutcome | null>(null);
  useEffect(() => {
    if (!actionNote) return;
    const id = setTimeout(() => setActionNote(null), 6000);
    return () => clearTimeout(id);
  }, [actionNote]);

  // ONE ACTION PER SHOP AT A TIME (the client half of the user-move debounce).
  // A slow /api/outreach round-trip left the chip live, and every extra tap
  // started a WHOLE NEW compose+send - the server window (wa/turn-lock) is the
  // guarantee, this ref is the instant, zero-latency first line.
  const actionsInFlight = useRef<Set<string>>(new Set());

  const runAction = useCallbackRef(
    async (id: string, rawArgs?: Record<string, unknown>, wasConfirmed?: boolean) => {
      const args = rawArgs ?? {};
      const check = checkAction({
        id,
        args,
        plan: session?.plan,
        confirmed: wasConfirmed === true,
        can: (p, f) => can(p as never, f),
      });
      if (!check.ok) {
        if (check.reason === "not-entitled") setUpgradeOpen(true);
        // NEVER SILENT. A refusal the traveller cannot see is identical, on
        // screen, to a dead button - which is exactly how "Push harder does
        // nothing" was reported.
        setActionNote(outcomeFor(id, check));
        return check;
      }
      const vendorId = String(args.vendorId ?? "");
      const vendor = vendors.find((v) => v.id === vendorId);
      const vehicle =
        rfq?.vehicleClass === "car"
          ? "car"
          : rfq?.vehicleClass === "motorbike"
            ? "motorbike"
            : "scooter";
      const outbound = ["push-harder", "ask-deposit", "request-photo", "counter-at"].includes(
        check.spec.id
      );
      const flightKey = `${check.spec.id}:${vendorId}`;
      if (outbound) {
        if (actionsInFlight.current.has(flightKey)) {
          // A repeat tap while the first is still travelling: say so, do nothing.
          setActionNote(
            outcomeFor(check.spec.id, { ok: true }, t("On it - your agent is already making this move."))
          );
          return { ok: false as const, reason: "in-flight" as const };
        }
        actionsInFlight.current.add(flightKey);
        // Instant acknowledgement - the traveller sees movement the moment they
        // tap, not after the network settles.
        setActionNote(
          outcomeFor(
            check.spec.id,
            { ok: true },
            t("On it - messaging {shop} now.").replace("{shop}", vendor?.name ?? t("the shop"))
          )
        );
      }
      try {
      switch (check.spec.id) {
        case "push-harder": {
          // A BARGAIN IS COMPOSED SERVER-SIDE, WHERE THE LEVERAGE LIVES.
          //
          // This used to interpolate a literal here and post it verbatim, so a
          // tap on "Push harder" produced "Hi again! Any chance of a better
          // daily rate for the scooter?" - generic by construction. It never
          // touched planLeverage, so a live rival quoting less for the same
          // vehicle in the same search was never mentioned; and it skipped the
          // post-rails, so nothing checked it for a rival's NAME or a number we
          // never verified. The server draft knows all of that. The literal
          // stays only as the offline fallback, which is the one case where
          // there is no leverage to cite anyway.
          // ...AND THE PAYLOAD HAS TO CARRY THE LEVERAGE (owner report 5 #11).
          //
          // This posted `{ vendor, rfq }` and nothing else, which quietly
          // disabled every server-side lever the comment above describes. With
          // no `region` the route resolves currency to USD - so a Thai shop was
          // asked for a price in DOLLARS - and the market floor, which is only
          // adopted when its currency matches, was dropped on the floor. With
          // no `currentPricePerDay` the whole rival lookup is skipped (it is
          // gated on `quoted`) and no target can be computed at all, and with
          // no `round` every push composed as the first one. The one action
          // named "Push harder" was the one with nothing behind it.
          const drafted = vendor && rfq
            ? await fetch("/api/bargain-draft", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  vendor,
                  rfq,
                  region: origin?.label || undefined,
                  currentPricePerDay: vendor.offer?.pricePerDay,
                  round: vendor.offer?.round ?? 0,
                }),
              })
                .then((res) => (res.ok ? res.json() : null))
                .then((d) => (typeof d?.message === "string" ? d.message.trim() : ""))
                .catch(() => "")
            : "";
          const r = await customMessage(
            vendorId,
            drafted ||
              `Hi again! Any chance of a better daily rate for the ${vehicle}? Ready to book if the price works 🙏`,
            { userMove: true }
          );
          // THE OUTREACH ROUTE HAS NEVER RETURNED `ok`. This read
          // `r?.ok !== false` against an untyped `res.json()`, so it was
          // `undefined !== false` - permanently true - and "Push harder"
          // reported success even when the message was refused, queued behind a
          // pacing hold or lost to a server fault. Judge it on the fields the
          // route actually sets.
          const accepted = Boolean(r?.sent || r?.queued || r?.duplicate || r?.halted);
          setActionNote(
            outcomeFor(
              "push-harder",
              { ok: accepted },
              accepted
                ? `Pushing ${vendor?.name ?? "the shop"} for a better rate - I'll tell you the moment they answer.`
                : r?.error || undefined
            )
          );
          return r;
        }
        case "ask-deposit":
          return await customMessage(vendorId, `One more thing - what deposit do you need?`, {
            userMove: true,
          });
        case "request-photo":
          return await customMessage(
            vendorId,
            `Could you send a photo of the actual ${vehicle} please?`,
            { userMove: true }
          );
        case "counter-at":
          return await customMessage(
            vendorId,
            `Could you do ${Number(args.pricePerDay)} per day? I can book right away 🙏`,
            { userMove: true }
          );
        case "mass-bargain":
          await runMassBargain();
          return { ok: true };
        // REGISTRY DRIFT, CLOSED. `recheck-prices` has been in the shared
        // action registry - and therefore in Will's prompt, offered to any
        // plan with trips-history - with no case here at all. So Will could
        // propose it, the traveller could say yes, and the switch fell through
        // to `unknown-action`: a capability advertised and then silently
        // refused, which is worse than never offering it. The endpoint has
        // existed the whole time; only the wiring was missing.
        case "recheck-prices": {
          const ts = String(args.startedAt ?? "");
          if (!ts) return { ok: false as const, reason: "missing-session" as const };
          const r = await fetch("/api/deals/recheck", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ts }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            setActionNote({ tone: "info", text: d.error ?? t("Could not re-ask those shops.") });
            return { ok: false as const, reason: "failed" as const };
          }
          setActionNote(
            outcomeFor(
              "recheck-prices",
              { ok: true },
              t("Asked {n} shops whether their price still stands.").replace(
                "{n}",
                String(d.asked ?? d.count ?? 0)
              )
            )
          );
          return { ok: true };
        }
        case "compare": {
          const ids = (args.vendorIds as string[]) ?? [];
          const blocked = compareOutcome(ids.length);
          if (blocked) {
            setActionNote(blocked);
            return { ok: false as const, reason: "too-few" as const };
          }
          setCompareIds(ids);
          setActionNote(outcomeFor("compare", { ok: true }, `Comparing ${ids.length} shops.`));
          return { ok: true };
        }
        case "filter-rents-cars":
          setFilters((f) => ({ ...f, tag: "rents-cars" }));
          return { ok: true };
        default:
          // `vendor` is read above so an unknown id cannot silently no-op with
          // a stale reference; every real branch returns before here.
          return { ok: false as const, reason: "unknown-action" as const, vendor: vendor?.id };
      }
      } finally {
        if (outbound) actionsInFlight.current.delete(flightKey);
      }
    }
  );

  // Mass bargain: named + stable so the button AND (later) Will's command
  // bridge share the exact same path. Entitlement-gated through can().
  // STEP ONE: SHOW THE TRAVELLER WHO. This used to fire straight at the wire -
  // one tap, ten shops, no list and no way back - and the ten were whatever the
  // vendor list happened to be sorted by at that moment. Nothing is composed or
  // queued until they confirm the sheet.
  const runMassBargain = useCallbackRef(async () => {
    if (!rfq) return;
    if (!can(session?.plan, "mass-bargain")) {
      setUpgradeOpen(true);
      return;
    }
    const { targets, eligible, cap } = massBargainTargets(filtered, session?.plan);
    if (!targets.length) {
      setMassNote(t("Every shop in this list already has a conversation open."));
      return;
    }
    setMassPreview({ targets, eligibleCount: eligible.length, cap });
  });

  /** STEP TWO: the traveller confirmed, possibly after dropping some shops. */
  const dispatchMassBargain = useCallbackRef(async (vendorIds: string[]) => {
    if (!rfq || !vendorIds.length) return;
    setMassPreview(null);
    setMassState("running");
    setMassNote(null);
    // The wash covers the whole compose-and-queue round trip; the finally
    // below is its guaranteed lower.
    raiseAmbient();
    try {
      const chosen = new Set(vendorIds);
      const targets = filtered
        .filter((v) => chosen.has(v.id))
        .map((v) => ({
          id: v.id,
          name: v.name,
          whatsapp: v.whatsapp,
          placeId: v.placeId,
          // Google "open now" - so an open shop is never queued as closed.
          openNow: v.openNow,
        }));
      const res = await fetch("/api/outreach/mass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendors: targets,
          message: rfq.vendorMessage,
          rfq,
          region: origin?.label ?? "",
          localLang: localLangActive,
        }),
      });
      const d = await res.json();
      if (d.capReached) {
        // THE SERVER'S NUMBER, not a hardcoded ten. Plan-tiered capacity has
        // allowed 30 (Pro) and 40 (Ultra) since it shipped, and this sentence
        // told a paying traveller they had hit a 10-shop beta limit - a claim
        // that is false for two of the three plans and reads as the product
        // failing rather than the client under-asking.
        setMassNote(
          t("This hunt already reached its {cap}-shop limit - replies from the contacted shops keep flowing in.")
            .replace("{cap}", String(d.cap ?? massBargainCap(session?.plan)))
        );
        return;
      }
      if (d.results) {
        let alreadyAsked = 0;
        // EVERY refusal is accounted for. The old loop handled only
        // sent/queued/rfq-dedup/no-phone; any other reason left the card
        // untouched, and the shop's only later "explanation" was the poll's
        // tombstone list - i.e. the system's own refusal rendered as
        // "removed by you".
        let notSent = 0;
        let notSentReason: string | undefined;
        for (const r of d.results) {
          if (r.sent) {
            patchVendor(r.id, {
              stage: "awaiting-response",
              sentText: r.text,
              sentGloss: r.gloss,
              lastEventAt: Date.now(),
              queuedUntil: undefined,
            });
          } else if (r.queued) {
            // Held by the guard (shop closed / pacing / limit) - show the
            // REAL reason on the card and in the user-facing queue.
            patchVendor(r.id, {
              queuedUntil: r.queuedUntil ?? new Date().toISOString(),
              queuedReason: r.queuedReason || undefined,
              lastEventAt: Date.now(),
            });
          } else if (String(r.reason ?? "").startsWith("rfq-dedup")) {
            // This shop already has an open conversation from the last
            // 24h - the agent continues THAT thread instead of
            // re-sending the same question (never look like a bot).
            alreadyAsked += 1;
            patchVendor(r.id, {
              stage: "awaiting-response",
              lastEventAt: Date.now(),
            });
          } else if (r.reason === "no-phone") {
            // Honest terminal state - this shop cannot be messaged at all,
            // so it must never look contacted anywhere.
            patchVendor(r.id, { stage: "no-contact", lastEventAt: Date.now() });
          } else if (String(r.reason ?? "").startsWith("still-removed")) {
            // The tombstone clear could not be confirmed - the shop stays
            // honestly in "Removed by you" (the user's own earlier action)
            // instead of being queued into a row the guard would kill.
            notSent += 1;
            if (!notSentReason) notSentReason = "still marked removed - tap the shop to try again";
            patchVendor(r.id, {
              cancelled: true,
              cancelReason: "user-removed",
              lastEventAt: Date.now(),
            });
          } else {
            // Anything else (queue-unavailable, rate-limit, a guard refusal)
            // is counted and said out loud, never dropped on the floor.
            notSent += 1;
            if (!notSentReason && r.reason) notSentReason = String(r.reason);
          }
        }
        refreshQueue();
        const startingNow = (d.sent ?? 0) + Math.max(0, (d.queued ?? 0) - (d.deferredTomorrow ?? 0));
        // Rolling-window capacity: deferred shops begin automatically as slots
        // free (at most windowHours away), never "tomorrow". Show the honest
        // next-refresh countdown from nextFreeAt.
        const nextFreeMs = d.introBudget?.nextFreeAt ? Date.parse(d.introBudget.nextFreeAt) : 0;
        const refreshMin = nextFreeMs ? Math.max(1, Math.round((nextFreeMs - Date.now()) / 60_000)) : 0;
        const refreshText =
          refreshMin >= 90 ? `~${Math.round(refreshMin / 60)} h` : `~${refreshMin} min`;
        // Refusals are part of the story, not a silent gap in it.
        const notSentSuffix =
          notSent > 0
            ? ` · ${notSent} ${t("not sent")}${notSentReason ? ` (${t(notSentReason)})` : ""}`
            : "";
        setMassNote(
          d.deferredTomorrow > 0
            ? `${t("Starting now:")} ${startingNow} ${t("shops, one at a time.")} ${d.deferredTomorrow} ${t(
                "more begin automatically as capacity refreshes"
              )}${refreshMin ? ` (${t("next slot in")} ${refreshText})` : ""}.${notSentSuffix}`
            : d.sent > 0 || d.queued > 0 || alreadyAsked > 0
              ? `${t("Agents are on it - shops asked:")} ${d.sent}${
                  d.queued > 0 ? ` · ${d.queued} ${t("in line, sending one at a time")}` : ""
                }${
                  alreadyAsked > 0 ? ` · ${alreadyAsked} ${t("already in conversation")}` : ""
                }${notSentSuffix}`
              : d.connect
                ? t("Connect your WhatsApp in Profile first.")
                : `${t("No shops could be messaged right now.")}${notSentSuffix}`
        );
      } else {
        setMassNote(d.error ?? t("Could not start the mass bargain."));
        if (d.upgrade) setUpgradeOpen(true);
      }
    } catch {
      // M5: this had try/finally and NO catch - a dropped connection or a
      // non-JSON 500 escaped as an unhandled rejection while the button sat
      // on "contacting every shop". The traveller gets a sentence and a
      // retry, not a console error they will never see.
      setMassNote(t("Could not reach the server - nothing was sent. Check your connection and try again."));
    } finally {
      lowerAmbient();
      setMassState("done");
    }
  });

  const availableClasses = useMemo(() => {
    const set = new Set<Vendor["vehicleClasses"][number]>();
    vendors.forEach((v) => v.vehicleClasses.forEach((c) => set.add(c)));
    return [...set];
  }, [vendors]);

  const filtered = useMemo(
    () => applyFilters(vendors, filters, rfq?.durationDays ?? 1),
    [vendors, filters, rfq]
  );

  const offersIn = vendors.filter((v) => v.offer).length;
  // How many shops have CONFIRMED each verified term. Drives the disabled state
  // of the "✓ Verified" chips: a term nobody has stated is not something the
  // traveller can filter on, and offering it anyway made the list look randomly
  // reshuffled (the tag predicate is OR'd with "is this shop live?", so it
  // could never remove an active shop and the tap appeared to do nothing).
  const tagCounts = useMemo(() => {
    const out: Partial<Record<FilterState["tag"], number>> = {};
    for (const v of vendors) {
      for (const tag of v.verifiedTags ?? []) {
        const key = tag as FilterState["tag"];
        out[key] = (out[key] ?? 0) + 1;
      }
    }
    return out;
  }, [vendors]);
  // CURRENCY SAFETY: offers can legitimately arrive in different currencies
  // (one shop quotes USD, another THB). Raw numbers must never be compared or
  // summed across currencies - all aggregates work within the DOMINANT one.
  const dominantCurrency = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of vendors) {
      if (v.offer) counts.set(v.offer.currency, (counts.get(v.offer.currency) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [vendors]);
  const totalSavings = useMemo(() => {
    if (!rfq) return 0;
    return vendors.reduce((sum, v) => {
      if (!v.offer || v.offer.currency !== dominantCurrency) return sum;
      return (
        sum + Math.max(0, (v.offer.listPricePerDay - v.offer.pricePerDay) * rfq.durationDays)
      );
    }, 0);
  }, [vendors, rfq, dominantCurrency]);

  // Inbound-risk alerts per shop (from the activity feed) - the red banner on
  // the card that says "Will flagged this reply".
  const riskByVendor = useMemo(() => {
    const out: Record<string, string> = {};
    for (const it of activityItems) {
      if (it.kind === "alert" && it.vendorId && !out[it.vendorId]) {
        out[it.vendorId] = it.detail ?? it.title;
      }
    }
    return out;
  }, [activityItems]);

  // A price the shop quoted for a DIFFERENT vehicle (matchesSpec === false) is
  // never the traveller's "cheapest" - it would surface an e-bike as the best
  // 125cc-scooter deal. The card still shows it, flagged as off-spec. The rule
  // lives in one place so it can never drift from the compare sheet.
  const cheapest = useMemo(
    () => cheapestPresentable(vendors, dominantCurrency),
    [vendors, dominantCurrency]
  );

  // The savings ticker's symbol matches the DOMINANT currency the aggregates
  // above are computed in - never whichever offer happens to be first.
  const savingsSymbol = useMemo(() => {
    return dominantCurrency
      ? currencySymbol(dominantCurrency)
      : "$";
  }, [dominantCurrency]);

  // Will's proactive companion context: what he says, when he celebrates
  // (offerCount rises -> a new offer landed) and when he shows the attention
  // dot - all derived from live state, never invented.
  const offerCount = useMemo(
    () => activityItems.filter((it) => it.kind === "offer").length,
    [activityItems]
  );
  const riskCount = Object.keys(riskByVendor).length;
  // First-time visitors get a personal hello from Will before anything else.
  const [firstVisit, setFirstVisit] = useState(false);
  useEffect(() => {
    try {
      setFirstVisit(!localStorage.getItem("wd_onboarded"));
    } catch {}
  }, []);
  const willNote = useMemo(() => {
    if (firstVisit && phase === "idle")
      return t("Hi, I'm Will 👋 Tell me what you want to ride - I find the shops and do the haggling. Tap me any time.");
    if (paused) return t("Paused - I'm holding every message. Tap me to resume.");
    if (riskCount > 0) return t("I flagged a reply for you - worth a look.");
    if (lastWillSay) return lastWillSay;
    if (phase === "running") return t("On it - working the shops now. Tap me to steer.");
    if (phase === "done" && cheapest?.offer)
      return `${t("Best so far")}: ${moneyLocal(cheapest.offer.pricePerDay, cheapest.offer.currency)}/${t("day")} · ${t("want me to push harder?")}`;
    if (phase === "done") return t("Openers are out - I'll ping you when replies land.");
    return t("Tell me what you want to ride - I'll do the haggling.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, riskCount, lastWillSay, phase, cheapest, firstVisit]);

  // Live status for the session strip (bug #1). Three HONEST buckets that never
  // contradict each other:
  //   messaged = the shop was actually contacted (delivered, now awaiting reply)
  //   queued   = the message is held for the shop's opening hours (auto-sends)
  //   offers   = a price is in
  const statusGroups = useMemo(() => {
    const messaged: Vendor[] = [];
    // Shops that HAVE answered but not with a price yet ("which bike would you
    // like?", "we have Click 125 available"). They used to sit under "Awaiting
    // reply" next to shops that had said nothing at all - the panel's single
    // biggest lie, and the one the owner caught on 26 Jul with the shop's reply
    // visible in the feed directly underneath.
    const replied: Vendor[] = [];
    const queued: Vendor[] = [];
    const deals: Vendor[] = [];
    // REMOVAL IS A STATE. The traveller pulled these out of the queue before
    // anything was delivered, and the partition had no branch for them - so
    // they fell through to the catch-all and reappeared under "Awaiting reply",
    // with the messaged counter reading 7 for 3 real sends. A shop we never
    // spoke to is not a shop we are waiting on.
    const removed: Vendor[] = [];
    for (const v of vendors) {
      // AN OFFER FROM A SHOP THAT RAN OUT (or walked away) IS NOT A DEAL
      // (D3). The old test was `v.offer` alone, so a stale price kept a shop
      // under "Active offers" after it had said it had nothing to rent - the
      // replied bucket below carries the honest per-stage line for both.
      if (v.offer && v.stage !== "out-of-stock" && v.stage !== "declined") deals.push(v);
      // "replied" IS THE REPLIED BUCKET. It was missing from this predicate,
      // so a card the ledger had correctly advanced to `replied` fell through
      // to the catch-all and rendered under "Awaiting reply" - the app
      // contradicting itself, because the counter above keys on lastInboundAt
      // and DID move. The stage is the strongest evidence there is here: it is
      // written by advanceThreadStage on a real stored inbound.
      else if (
        v.lastInboundAt ||
        v.stage === "replied" ||
        v.stage === "negotiating" ||
        v.stage === "counter-offer"
      )
        replied.push(v);
      // Cancelled BY THE USER with nothing ever sent: terminal, and counted
      // nowhere else. `sentText` is the test rather than the stage, because
      // it is the only field that records that words actually reached a shop.
      //
      // A REMOVAL OUTRANKS A SCHEDULE. This used to also require
      // `!v.queuedUntil`, so a shop the traveller had just removed - which for
      // a moment still carried the stale schedule of the message being deleted
      // - failed this test and fell through to the CONTACTING branch below.
      // The decision is newer than the schedule, and ordering is what says so.
      //
      // THE ACTOR DECIDES THE BUCKET. A tombstone written by the system
      // (session-close, deal-close) is NOT a user removal - rendering it as
      // one is how six never-removed shops appeared under "REMOVED BY YOU".
      // A system-cancelled, never-messaged shop is honestly just a search
      // result again and is intentionally not counted anywhere.
      else if (v.cancelled && v.cancelReason === "user-removed" && !v.sentText) removed.push(v);
      else if (v.cancelled && !v.sentText) continue;
      // A shop the agents already REACHED (a reply is pending / negotiation
      // is live) stays "messaged" even while a follow-up sits in the outbox -
      // otherwise the counters flicker right after a send. A shop whose FIRST
      // message is still held (stage rfq-sent + queuedUntil) is honestly
      // "queued": nothing has been delivered yet.
      else if (["awaiting-response", "negotiating"].includes(v.stage ?? "")) messaged.push(v);
      // In flight RIGHT NOW: an honest "queued" until it lands (its row still
      // exists, leased by the drainer - see wa/outbox-lifecycle).
      else if (v.stage === "sending" || v.queuedUntil) queued.push(v);
      else if (v.stage === "rfq-sent") messaged.push(v);
      // THE PARTITION IS TOTAL. A shop that reaches a state no branch above
      // names used to fall out of the panel entirely and simply disappear -
      // which is exactly what a mid-send shop did. A shop we have contacted
      // belongs somewhere; anything else is genuinely still just a search
      // result and is intentionally not counted.
      else if (v.sentText || v.lastEventAt) messaged.push(v);
    }
    return { messaged, replied, queued, deals, removed };
  }, [vendors]);
  // The notice only carries removals the traveller has NOT already acknowledged.
  // Dismissing hides exactly the shops on screen at that moment; a later removal
  // is a new fact and brings the notice back with only that shop in it.
  const visibleRemoved = useMemo(
    () => statusGroups.removed.filter((v) => !dismissedRemovals.has(dismissalKey(v.id, v.cancelledAt))),
    [statusGroups.removed, dismissedRemovals]
  );
  const dismissRemoved = useCallbackRef(() => {
    setDismissedRemovals((prev) => {
      const next = new Set(prev);
      for (const v of statusGroups.removed) next.add(dismissalKey(v.id, v.cancelledAt));
      // Survives the TabBar's full document navigation - the vendors it
      // acknowledges are restored from sessionStorage, so the acknowledgement
      // must be too.
      saveDismissals(typeof window !== "undefined" ? window.sessionStorage : null, next);
      return next;
    });
  });
  // W4.6 - THE LANGUAGE DECISION, WHERE THE TRAVELLER CAN SEE IT.
  //
  // Their agent writes to shops in the shop's own language. When a shop tells us
  // they do not speak it, the agent switches that ONE thread to English - and
  // until now nothing said so anywhere: the localize trace stage is filtered out
  // of the activity feed, the localize-fallback event kind is not in its
  // allow-list, and the only "override" signal that was computed is thrown away
  // by its caller. Silence about a language change reads as the agent being
  // sloppy; the shop's own request explains it in one line.
  const languageSwitched = useMemo(
    () => vendors.filter((v) => v.languageSwitch === "english"),
    [vendors]
  );
  const stageCounts = {
    messaged: statusGroups.messaged.length,
    replied: statusGroups.replied.length,
    queued: statusGroups.queued.length,
    offers: statusGroups.deals.length,
  };

  // HAS ANYTHING ACTUALLY BEEN SENT?
  //
  // Two spinners claimed "contacting shops" purely because `phase === "running"`
  // - and `running` is the FUNNEL ANIMATION: runFunnel walks the local cards
  // from "queued" to "found" over a couple of seconds and touches no shop at
  // all. Outreach in this app is an explicit tap (the consent flow exists
  // precisely so nobody is messaged without one), so for the whole of that
  // phase the app was animating a claim about work it had not done, on the
  // paid tier, next to a request the traveller had just submitted.
  //
  // Evidence, not phase: a shop counts as contacted once it has been messaged,
  // has replied, or has a queued row waiting to go out.
  const contactingShops =
    stageCounts.messaged +
      stageCounts.replied +
      Math.max(stageCounts.queued, queueItems.length) >
    0;
  // ...AND IS ANY DELIVERY STILL IN FLIGHT? (D7). The order-status SPINNER
  // used `contactingShops`, which stays true for the life of the hunt (a shop
  // that replied an hour ago still counts) - so "contacting shops" animated
  // forever over a hunt with nothing left to send. A spinner is a claim of
  // ongoing work; only queued/sending rows are that.
  const deliveringNow =
    Math.max(stageCounts.queued, queueItems.length) > 0 ||
    vendors.some((v) => v.stage === "sending");

  // Honest pacing progress ("3 of 8 sent - next at ~14:32 - done by ~14:41")
  // derived from LIVE queue rows so mid-batch removals shrink the plan.
  const queueProgress = useMemo(
    () =>
      sendProgress(
        queueItems.map((q) => ({ notBefore: q.notBefore })),
        stageCounts.messaged + stageCounts.offers,
        Date.now()
      ),
    [queueItems, stageCounts.messaged, stageCounts.offers]
  );

  // W2: the honest ETA head (earliest not-yet-due row) + the "all done by" from
  // the server-simulated envelope, so the panel shows real ranges, not the raw
  // not_before lower bound.
  const queueEtaHead = useMemo(
    () => queueItems.find((q) => !q.due && (q.etaFrom || q.notBefore)) ?? null,
    [queueItems]
  );
  const queueEtaDoneByStr = useMemo(() => {
    let max = 0;
    for (const q of queueItems) {
      const to = q.etaTo ? Date.parse(q.etaTo) : 0;
      if (to > max) max = to;
    }
    return max ? new Date(max).toISOString() : null;
  }, [queueItems]);

  // Is the search card gated behind WhatsApp pairing right now?
  //
  // ONE definition, used by both the veil and the blur wrapper so they can never
  // disagree. Requires `restored` (hydration finished) so the lock never flashes
  // over a search that is about to be rehydrated from sessionStorage, and only
  // applies to the entry form - a live or completed search is left alone (its
  // per-shop send buttons are separately gated on waConnected).
  //
  // `waReachable` is the third state that had to exist: the lock accuses the
  // traveller of not having linked, so it may only appear when the server
  // actually SAID so. If we could not get an answer we show the form - the
  // send path still refuses on a confirmed unlink, and the server enforces it
  // regardless, so an unreachable probe costs nothing but a wasted tap while a
  // wrongly-drawn lock costs the whole session.
  const waLocked =
    waConnected !== true &&
    waReachable &&
    restored &&
    phase === "idle" &&
    vendors.length === 0;

  // Will-as-concierge: derive the ONE funnel step from live state and publish
  // it to the shared assistant context (idle detection lives there). The old
  // static top banner is gone - guidance now floats anchored to the exact
  // element the user should touch next.
  const willStageNow = useMemo(
    () =>
      deriveWillStep({
        waConnected,
        phase,
        vendorCount: vendors.length,
        offerCount,
        closing: Boolean(bookingVendor),
        // W-6: THE INPUTS WILL COULD NOT SEE. Without these the pre-search
        // advice was one message for four different situations, so most of the
        // time it named a step the traveller had already completed.
        hasRequest: Boolean(rawText.trim()) || Boolean(builderFields?.vehicleClass),
        hasStay: Boolean(origin),
        idpDeclared: idpConsent,
        // FOUND IS NOT CONTACTED (owner report 3, item 9). The panel's own
        // arithmetic, so Will and the status panel cannot disagree: without
        // this, a board full of discovered-but-unmessaged shops read as
        // NEGOTIATING and Will offered "See it live" with nothing live.
        contactedCount:
          stageCounts.messaged + stageCounts.replied + stageCounts.queued + stageCounts.offers,
      }),
    [
      waConnected,
      phase,
      vendors.length,
      offerCount,
      bookingVendor,
      rawText,
      builderFields,
      origin,
      idpConsent,
      stageCounts.messaged,
      stageCounts.replied,
      stageCounts.queued,
      stageCounts.offers,
    ]
  );
  const assistant = useWillAssistant();
  const assistantSetStep = assistant.setStep;
  useEffect(() => {
    assistantSetStep(willStageNow);
  }, [willStageNow, assistantSetStep]);

  // "Boom, linked!" - WaConnect stamps this the moment pairing completes, so
  // when the user lands back here Will celebrates once and hands focus to the
  // request box. Cleared on dismissal or the first search.
  const [justLinked, setJustLinked] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem("wd_wa_just_linked") === "1") setJustLinked(true);
    } catch {}
  }, [waConnected]);
  const clearJustLinked = useCallbackRef(() => {
    setJustLinked(false);
    try {
      sessionStorage.removeItem("wd_wa_just_linked");
    } catch {}
  });

  // A row overdue by >5 min means sending fell behind (typically: the app was
  // closed and no background driver ran) - say so instead of a silent stall.
  const queueStalled = useMemo(
    () => queueItems.some((q) => Date.parse(q.notBefore) < Date.now() - 5 * 60_000),
    [queueItems]
  );

  const paidPlan = session ? session.plan !== "free" : false;

  // Give the listing back the ~100px the brand row costs while the traveller is
  // reading down the results, and return it the moment they scroll up.
  useHeaderCollapse();

  // ONE card renderer for BOTH list axes (owner report 3, item 12). The
  // vertical feed and the horizontal rail render this same closure, so the
  // two modes can never drift apart in what a shop card shows or does.
  const renderVendorCard = (v: Vendor, i: number) => (
    <div
      id={`vendor-${v.id}`}
      className={`rise-in scroll-mt-24 mb-3 rounded-blob transition-shadow ${
        selectedId === v.id ? "ring-2 ring-brandblue ring-offset-2 ring-offset-[color:var(--bg)]" : ""
      }`}
      // The stagger was uncapped, so the twentieth card started animating
      // 1.14s after the first - a flourish for the first few rows; past that
      // it is just work.
      style={{ ["--i" as string]: staggerIndex(i) }}
    >
      <VendorCard
        vendor={v}
        rfq={rfq}
        plan={session?.plan}
        waConnected={waConnected}
        localLang={localLangActive}
        region={origin?.label ?? ""}
        searchEpoch={epochOnServerClock()}
        onBook={onBookVendor}
        onReviews={setReviewsVendor}
        onBargain={onBargainVendor}
        onStage={handleStage}
        onQueued={handleQueued}
        onCustomMessage={customMessage}
        onPickupConsent={pickupConsent}
        onLocationRequest={onLocationRequest}
        whyDecisionId={whyByVendor[v.id]}
        onWhy={openWhy}
        onOpenThread={onOpenThread}
        riskNote={riskByVendor[v.id]}
        agentPending={agentPending[v.id]}
      />
    </div>
  );

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md pb-32 sm:max-w-lg md:max-w-3xl">
      <div className="topbar">
        {/* THE BAR'S HEIGHT IS DECLARED IN CSS (--topbar-row-h), AND THIS ROW
            HAS TO HONOUR IT.
            The tagline could wrap to a second line, so the bar grew whenever
            anything on the row changed width - the plan pill arriving after the
            session loaded, the language button flipping between its wide
            "Translate" hint and a narrow flag, the DOM translator swapping in a
            longer string. `min-w-0` + `truncate` makes the text shrink instead
            of wrapping, and `shrink-0` stops the controls being squeezed into a
            second line, which is what makes the declared height true. Nothing
            measures the bar any more, so a row that broke this contract would
            overflow rather than move the sticky List/Map/Activity row. */}
        <div className="mx-auto flex max-w-md items-center justify-between gap-2 px-4 pb-2.5 sm:max-w-lg md:max-w-3xl">
          <div className="flex min-w-0 items-center gap-2">
            <BrandMark size={34} />
            <div className="min-w-0">
              <h1 className="font-display text-lg font-extrabold leading-none text-strong">
                Wheel<span className="text-brandblue">Deal</span>
              </h1>
              <p className="truncate text-[10px] font-bold text-faint">
                {t("Authentic bargains, negotiated for you")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {session && session.plan !== "free" && (
              <span
                // `badge-ultra` is an infinite background-position animation.
                // Inside a STICKY bar that is a repaint of the whole sticky
                // layer on every frame of every scroll - the same per-frame
                // cost the opaque topbar change was made to remove. The gradient
                // stays; only the endless animation goes.
                className={`rounded-full px-2 py-1 text-[10px] font-extrabold uppercase text-white ${
                  session.plan === "ultra" ? "badge-ultra-static" : "bg-brandblue"
                }`}
              >
                {session.plan}
              </span>
            )}
            <ThemeToggle />
            <LanguageButton />
          </div>
        </div>
      </div>

      <div className="px-4">
        {formCollapsed && (
          <SearchSummaryBar
            requestText={rawText}
            originLabel={origin?.label}
            radiusKm={radiusKm}
            // The DATES the search actually ran with, read from the compiled
            // RFQ rather than from the form's live state - the collapsed bar
            // describes the query that produced the results below it, and the
            // form may already have been edited without re-searching.
            startDate={rfq?.startDate}
            endDate={rfq?.returnDate}
            durationDays={rfq?.durationDays}
            onExpand={() => setFormOpen(true)}
          />
        )}
        {/* Will as a CONCIERGE ON THE UI: a floating speech card anchored to the
            exact element the user should touch next, with 1-tap actions that do
            the thing. Replaced the static top banner. The overlay renders at the
            end of the page (fixed position); this comment marks the old site. */}
        <section className={`surface relative mt-4 rounded-blob p-4 ${formCollapsed ? "hidden" : ""}`}>
          {/* Blur-lock (feature 6.1): the search is gated behind WhatsApp
              pairing. The card stays mounted (so the onboarding tour anchors
              still exist) but is blurred + non-interactive under a premium veil
              until the number is linked. The server already refuses unpaired
              sends - this makes the gate visible and calm. */}
          {/* `restored` is the HYDRATION-DONE flag, not "a search was restored".
              This condition had it inverted since the blur-lock was written
              (d875d3c): setRestored(true) runs unconditionally on mount, so
              `!restored` was false within a tick and the lock never rendered -
              an unpaired user got the full search form and a live "Find my
              deal" button that could not possibly send. We wait FOR hydration
              (so no flash), then lock whenever there is no active search. */}
          {waLocked && <WaLockVeil checking={waConnected === null} />}
          <div className={waLocked ? "pointer-events-none select-none blur-[3px]" : ""}>
          <label className="text-[12px] font-extrabold text-soft">
            {t("What do you want to rent?")}
          </label>
          {/* STRUCTURED MODE disambiguation: while the tap builder holds a
              selection, the free-text box is visibly inactive so there is never
              a question of which input the search will use. */}
          <textarea
            data-tour="request"
            value={structuredMode ? "" : rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={2}
            disabled={structuredMode}
            className={`mt-1 w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none ${
              structuredMode ? "pointer-events-none opacity-50" : ""
            }`}
            placeholder={
              structuredMode
                ? t("Using your tap-built request below 👇")
                : t("e.g. automatic SUV 5 seats for 5 days, or 125cc scooter with phone mount")
            }
          />
          <div data-tour="examples" className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
            {examples.map((ex) => (
              <button
                key={ex}
                onClick={() => setRawText(ex)}
                className="chip whitespace-nowrap rounded-full border-2 border-line bg-card px-2.5 py-1 text-[11px] font-bold text-faint hover:border-brandblue/40 hover:text-soft"
              >
                {ex.length > 36 ? ex.slice(0, 36) + "..." : ex}
              </button>
            ))}
          </div>

          {/* THE RENTAL WINDOW - BOTH MODES, ALWAYS ON SCREEN (W-7).
              This sits between the request and the tap builder because it is
              the standing context both are chosen against, not a step of
              either. It was the builder's private state, and the builder is
              mounted only when the tap mode is open, so every typed request
              reached the shops with no start date at all. */}
          <div className="mt-3">
            <RentalWindowField
              startDate={startDate || planWindow.startDate}
              days={days}
              today={planWindow.startDate}
              maxStartDate={planWindow.maxStartDate}
              onStartDateChange={(d) => {
                setStartDate(d);
                // Only THIS control is now a statement - see the two flags.
                setStartTouched(true);
                setWindowNote(null);
              }}
              onDaysChange={(n) => {
                setDays(n);
                setDaysTouched(true);
                setWindowNote(null);
              }}
              adjustedReason={windowNote}
              t={t}
              tShared={tShared}
            />
          </div>

          {/* Tap-to-build panel (F2 / Step 2): a zero-typing alternative to the
              free text above. Toggle so first-timers see the guided builder and
              typists keep the box. Locking runs the SAME search, structured. */}
          <div className="mt-2">
            <button
              onClick={() =>
                setBuilderOpen((s) => {
                  if (s) setBuilderFields(null); // closing = back to free-text mode
                  return !s;
                })
              }
              className="text-[11px] font-extrabold text-brandblue underline"
            >
              {builderOpen ? t("Prefer typing? Hide the tap builder") : t("⚡ Build your request in taps instead")}
            </button>
            {builderOpen && (
              <div className="mt-2">
                <RequestBuilder
                  // BUG 4: a new search (fresh searchEpoch) remounts the builder
                  // so its step/vehicle/duration reset - no stale carousel header
                  // carried over from the previous request.
                  key={searchEpoch}
                  busy={phase === "profiling" || phase === "running"}
                  // The window is the page's now (see RentalWindowField above);
                  // the builder reports it back inside its RFQ fields so the
                  // structured path carries the same dates the typed path does.
                  startDate={startDate || planWindow.startDate}
                  days={days}
                  onFieldsChange={setBuilderFields}
                />
              </div>
            )}
          </div>

          <div data-tour="stay" className="mt-3">
            <OriginPicker
              origin={origin}
              onChange={(o) => {
                setOrigin(o);
                setOriginHint(null);
              }}
              hint={originHint}
              radiusKm={radiusKm}
            />
          </div>

          {priceHintLoading && !priceHint && (
            <div className="mt-2 rounded-2xl bg-brandblue-soft p-2.5">
              <LoadingDots label={t("Researching local going rates...")} />
            </div>
          )}
          {priceHint && (priceHint.scooter || priceHint.car) && (
            <div className="mt-2 rounded-2xl bg-brandblue-soft p-2.5 text-[11px] font-bold leading-relaxed text-brandblue animate-slide-up">
              💡 {t("Local going rate here:")}{" "}
              {priceHint.scooter && (
                <>
                  {t("scooters from")} ~{moneyLocal(priceHint.scooter.floor, priceHint.scooter.currency)}/{t("day")}{" "}
                  <span className="font-normal opacity-80">({t("110cc")})</span>
                </>
              )}
              {priceHint.scooter && priceHint.car && " · "}
              {priceHint.car && (
                <>
                  {t("economy cars from")} ~{moneyLocal(priceHint.car.floor, priceHint.car.currency)}/{t("day")}{" "}
                  <span className="font-normal opacity-80">({t("small 4-seat")})</span>
                </>
              )}
              . {t("Real local floor from live web research - your agents bargain toward it.")}
            </div>
          )}

          <label data-tour="radius" className="mt-3 block text-[12px] font-extrabold text-soft">
            {t("Search radius")} · {radiusKm} km
            <input
              type="range"
              min={2}
              max={25}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              className="mt-2 w-full accent-[var(--blue)]"
            />
          </label>

          {/* Persistent AI + liability disclaimer across the funnel. */}
          <p className="mt-2 text-center text-[10px] leading-relaxed text-faint">
            {t("Will negotiates on your behalf - final terms always come from the shop. WheelDeal is not a party to any rental.")}{" "}
            <a href="/terms" className="underline">{t("Terms")}</a> ·{" "}
            <a href="/privacy" className="underline">{t("Privacy")}</a>
          </p>

          {/* MANDATORY IDP declaration (owner directive): the search stays
              locked until the traveller declares a valid International Driving
              Permit for the selected vehicle category. */}
          <label className="mt-2 flex items-start gap-2 rounded-2xl border-2 border-line bg-card p-3">
            <input
              type="checkbox"
              checked={idpConsent}
              onChange={(e) => setIdpConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--blue)]"
            />
            <span className="text-[11px] font-bold leading-snug text-soft">
              {t("I declare that I hold a valid International Driving Permit (IDP) for the selected vehicle category.")}
            </span>
          </label>

          {/* THE one unified search CTA - free-text or tap-built, this button
              runs it (there is deliberately no second button in the builder). */}
          <button
            data-tour="find"
            onClick={() =>
              structuredMode && builderFields
                ? startSearch(undefined, builderFields)
                : startSearch()
            }
            disabled={phase === "profiling" || phase === "discovering" || phase === "running" || !idpConsent}
            className="btn btn-primary cta-sheen mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-[15px] disabled:opacity-70"
          >
            {phase === "profiling" || phase === "discovering" ? (
              <LoadingDots
                light
                label={
                  phase === "discovering"
                    ? t("Finding shops near you")
                    : t("Structuring your request")
                }
              />
            ) : phase === "running" ? (
              <LoadingDots
                light
                label={
                  contactingShops ? t("Agents contacting shops") : t("Getting your shops ready")
                }
              />
            ) : (
              <>
                <Icon name="bolt" className="h-5 w-5" /> {t("Find my deal")}
              </>
            )}
          </button>
          {!idpConsent && (
            <p className="mt-1.5 text-center text-[10px] font-bold text-faint">
              ☝️ {t("Tick the license declaration above to start searching.")}
            </p>
          )}
          {session?.plan === "free" && (
            <p className="mt-2 text-center text-[11px] font-bold text-faint">
              {t("Free plan: pickups can be scheduled for today only.")}{" "}
              <button onClick={() => setUpgradeOpen(true)} className="text-brandblue underline">
                {t("Upgrade")}
              </button>
            </p>
          )}
          </div>
        </section>

        {vendors.length > 0 && (
          <button
            onClick={() => setClearConfirm(true)}
            className="btn btn-ghost mt-3 flex w-full items-center justify-center gap-1.5 rounded-2xl py-2 text-[12px] font-extrabold"
          >
            <Icon name="x" className="h-3.5 w-3.5" /> {t("Clear search")}
          </button>
        )}

        {source === "demo" && (
          <div className="mt-3 rounded-2xl bg-brandyellow-soft p-3 text-[12px] font-bold text-warn animate-slide-up">
            {t("Demo shop list - no Google Maps key is set yet (owner: Admin -> Keys). Prices are never invented either way: we first ask each shop.")}
          </div>
        )}
        {source === "google-error" &&
          (session && session.role !== "user" ? (
            // The DIAGNOSTIC belongs to whoever can fix it (D7): a raw Google
            // API error string plus "open Admin -> Keys" is admin homework.
            <div className="mt-3 rounded-2xl border-2 border-brandred bg-brandred-soft p-3 text-[12px] font-bold text-brandred animate-slide-up">
              {t("Your Google Maps key is set but Google rejected the request:")}{" "}
              <span className="font-mono text-[11px]">{sourceError}</span>
              <div className="mt-1 font-semibold">
                {t("Owner: open Admin -> Keys -> Test Google key for a one-tap diagnosis.")}
              </div>
            </div>
          ) : (
            // A traveller can act on exactly one fact: live shop lookup is
            // down and the demo list is standing in. Say that, in words.
            <div className="mt-3 rounded-2xl bg-brandyellow-soft p-3 text-[12px] font-bold text-warn animate-slide-up">
              {t("Live shop lookup hit a snag, so this list may be limited - prices are still real and come only from the shops' own replies.")}
            </div>
          ))}
        {/* A failed DISCOVERY CALL (500/network) sets sourceError without a
            source verdict - it must still be said out loud. Without this the
            error string lived in state and rendered nowhere: the funnel
            silently snapped back to idle, which is the "healthy-looking
            failure" defect class this repo keeps fighting. */}
        {sourceError && source !== "google-error" && (
          <div className="mt-3 rounded-2xl border-2 border-brandred bg-brandred-soft p-3 text-[12px] font-bold text-brandred animate-slide-up">
            {sourceError}
          </div>
        )}
        {source === "google" && (
          <div className="mt-3 flex items-center gap-2 rounded-2xl bg-savings-soft p-3 text-[12px] font-bold text-savings animate-slide-up">
            <GoogleWordmark className="shrink-0 text-[13px]" />
            <span>✓ {t("Real rental shops near your stay, sourced live from Google.")}</span>
          </div>
        )}

        {rfq && (
          <div className="surface mt-3 rounded-blob p-3 text-[12px] animate-slide-up">
            <div className="mb-1 flex items-center gap-1.5 font-extrabold text-brandblue">
              <Icon name="spark" className="h-3.5 w-3.5" /> {t("Structured request")}
              {session && session.plan !== "free" && (deliveringNow || phase === "running") && (
                <span className="ml-auto font-bold text-faint">
                  <LoadingDots
                    label={
                      deliveringNow
                        ? t("Order status: contacting shops")
                        : t("Order status: getting your shops ready")
                    }
                  />
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Tag>{vehicleLabel(rfq.vehicleClass, rfq.transmission)}</Tag>
              {rfq.engineSizeCc && <Tag>{rfq.engineSizeCc}cc</Tag>}
              {rfq.maxMileageKm && <Tag>&lt;{rfq.maxMileageKm.toLocaleString()} km</Tag>}
              <Tag>
                {rfq.durationDays} {t("days")}
              </Tag>
              {rfq.fulfillment !== "any" && <Tag>{rfq.fulfillment}</Tag>}
              {rfq.accessories.map((a) => (
                <Tag key={a}>{a}</Tag>
              ))}
            </div>
          </div>
        )}

        {feedStale && vendors.length > 0 && (
          <p className="mt-3 rounded-xl bg-brandyellow-soft p-2 text-center text-[11px] font-bold text-warn">
            ⏳ {t("Reconnecting - live updates paused for a moment. Your agents keep working.")}
          </p>
        )}
        {/* Premium kill switch: only while the agents actually have live work
            (a shop messaged or queued). One tap pauses/resumes the whole
            session - the hard stop is enforced server-side. */}
        {vendors.length > 0 &&
          stageCounts.messaged + stageCounts.replied + Math.max(stageCounts.queued, queueItems.length) > 0 && (
            <AgentKillSwitch
              className="mt-3"
              serverPaused={paused}
              serverPausedVersion={pausedVersion}
            />
          )}

        {vendors.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Stat label={t("Shops found")} value={vendors.length} />
            <Stat label={t("Offers in")} value={offersIn} accent />
            {/* BEST PRICE, not "Bargained".
                A savings total is a number about US: it reads 0 for the whole
                first stretch of every hunt, and once offers land it answers a
                question nobody asked ("how much did the list price move?").
                What the traveller is actually here for is the cheapest real,
                on-spec, bookable rate - so that is the headline, with the
                saving demoted to the line underneath where it belongs. */}
            <button
              onClick={() => cheapest && scrollToVendor(cheapest.id)}
              disabled={!cheapest}
              className="surface rounded-blob px-2 py-4 text-center disabled:cursor-default"
            >
              <div className="text-[11px] font-extrabold uppercase tracking-wide text-savings">
                {t("Best price")}
              </div>
              <div className="mt-0.5 text-[24px] leading-none font-extrabold text-savings">
                {cheapest?.offer ? (
                  <>
                    {savingsSymbol}
                    <AnimatedNumber value={Math.round(cheapest.offer.pricePerDay)} />
                  </>
                ) : (
                  <span className="text-faint">-</span>
                )}
              </div>
              <div className="mt-1 truncate text-[9.5px] font-bold text-faint">
                {/* TRANSPARENT VERIFICATION: the lowest real offer shows
                    IMMEDIATELY, labeled by confidence - "unverified" until the
                    agent's automatic model check lands, then it seamlessly
                    reads verified. The old behavior hid the price entirely
                    behind "- confirming details" while ฿180 sat on screen. */}
                {cheapest?.offer
                  ? offerConfidence(cheapest.offer) === "unverified"
                    ? `* ${t("unverified - confirming")} · ${cheapest.name}`
                    : Math.round(totalSavings) > 0
                      ? `${t("saved")} ${savingsSymbol}${Math.round(totalSavings)} ${t("so far")}`
                      : `${t("per day")} · ${cheapest.name}`
                  : offersIn > 0
                    ? t("confirming details")
                    : t("agents are asking")}
              </div>
            </button>
          </div>
        )}

        {/* Live session status: what the agents are doing RIGHT NOW. Tappable to
            expand into per-shop detail - which shops were messaged, which held
            for opening hours (removable), which sent a deal, and exactly when. */}
        {vendors.length > 0 && (
          <div data-tour="status" className="mt-2 overflow-hidden rounded-2xl bg-card2">
            {/* THE ONLY WAY TO OPEN THIS PANEL WAS BEING CLIPPED OFF.

                `gap-y-1` is dead on a non-wrapping row - clear evidence
                `flex-wrap` was intended and omitted. With all four counters
                live the row needs ~348px at 11px bold, against 288px available
                inside `max-w-md px-4` at a 320px viewport and 343px at 375px.
                The parent has `overflow-hidden`, so this never produced page
                scroll (the mobile rule held) - it CLIPPED instead, cutting
                "offers" mid-word and taking the chevron with it. Translated
                locales are longer still.

                The counters wrap; the chevron is pulled out of the wrapping
                group so it keeps its own column and can never be the thing
                that falls off the end. */}
            <button
              onClick={() => setStatusOpen((o) => !o)}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-[11px] font-bold text-soft"
            >
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                {stageCounts.messaged > 0 && <span>📤 {stageCounts.messaged} {t("messaged")}</span>}
                {stageCounts.replied > 0 && (
                  <span className="text-brandblue">💬 {stageCounts.replied} {t("replied")}</span>
                )}
                {Math.max(stageCounts.queued, queueItems.length) > 0 && (
                  <span>
                    🕘 {Math.max(stageCounts.queued, queueItems.length)} {t("queued")}
                  </span>
                )}
                {stageCounts.offers > 0 && <span className="text-savings">💰 {stageCounts.offers} {t("offers")}</span>}
                {stageCounts.messaged + stageCounts.replied + stageCounts.queued + stageCounts.offers === 0 && (
                  <span>{t("Tap 'Ask for price' on a shop to start")}</span>
                )}
              </span>
              {stageCounts.messaged + stageCounts.replied + stageCounts.queued + stageCounts.offers > 0 && (
                <span className="shrink-0 text-[10px] text-faint">{statusOpen ? "▲" : "▼"}</span>
              )}
            </button>

            {/* F4: the two-segment bar, at eye level and OUTSIDE the expander -
                the whole point of a progress bar is that it answers "how far
                along am I" without a tap. It renders only once the session has
                actually started; a 0% bar over an untouched search is noise. */}
            {progress && progress.selected > 0 && (
              <div className="px-3 pb-2">
                <BatchProgressBar progress={progress} t={t} formatClock={formatClock} />
              </div>
            )}

            {/* AN EXPANDER THAT OPENS ONTO NOTHING IS BROKEN, NOT EMPTY.
                With all four counters at zero the whole body was suppressed, so
                the chevron toggled and the panel visibly did not open - which
                reads as a bug rather than as "there is nothing here yet". Say
                the honest thing instead. */}
            {statusOpen &&
              stageCounts.messaged + stageCounts.replied + stageCounts.queued + stageCounts.offers === 0 && (
                <div className="border-t border-line px-3 py-3 text-[11px] font-bold text-soft">
                  {t("Nothing is on the wire yet. Tap 'Ask for price' on a shop and this fills in live - who was messaged, who replied, and every offer as it lands.")}
                </div>
              )}

            {statusOpen && (stageCounts.messaged + stageCounts.replied + stageCounts.queued + stageCounts.offers > 0) && (
              <div className="space-y-2 border-t border-line px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => goToSection("[data-tour='views']", "activity")}
                    className="chip flex items-center gap-1 text-[11px] font-extrabold text-brandblue"
                  >
                    <Icon name="sparkles" className="h-3 w-3" /> {t("See the full live activity feed")} →
                  </button>
                  {/* One-tap: isolate the cards the agents are actively working. */}
                  <button
                    onClick={() =>
                      setFilters((f) => ({
                        ...f,
                        agentStatus: f.agentStatus === "active" ? "all" : "active",
                      }))
                    }
                    className={`chip flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-extrabold ${
                      filters.agentStatus === "active"
                        ? "bg-brandblue text-white"
                        : "border-2 border-line text-soft"
                    }`}
                  >
                    🔵 {filters.agentStatus === "active" ? t("Showing active rentals") : t("Show only active rentals")}
                  </button>
                </div>
                {/* W4.6 - WE CHANGED LANGUAGE, AND THE SHOP ASKED US TO. Named
                    shops, not a count: the traveller can check the thread. */}
                {languageSwitched.length > 0 && (
                  <div className="rounded-xl bg-brandblue-soft p-2 text-[11px] font-bold text-brandblue">
                    🌐 {t("Switched to English for these shops - they asked")}:{" "}
                    {languageSwitched.map((v) => v.name).join(", ")}
                  </div>
                )}
                {/* SECTION 1 - Active offers & negotiations: the shops that
                    replied with a price, at full density - quote, deposit when
                    the shop stated one, rating, the latest message + time. */}
                {statusGroups.deals.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-savings">
                      💰 {t("Offers & negotiations")} ({statusGroups.deals.length})
                    </div>
                    {statusGroups.deals.map((v) => (
                      <div key={v.id} className="mb-1.5 rounded-xl bg-card p-2 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            onClick={() => scrollToVendor(v.id)}
                            className="flex min-w-0 items-center gap-1 text-left font-extrabold text-strong hover:text-brandblue"
                            title={t("Jump to this shop")}
                          >
                            <span className="shrink-0 text-brandblue">↧</span>
                            <ShopAvatar name={v.name} phone={v.whatsapp} size="sm" retryKey={v.stage} photoUrl={v.photoUrl} />
                            <span className="truncate">{v.name}</span>
                          </button>
                          {/* A shop with a MENU has no single price - showing
                              one is what hid the cheaper tier. Show the range. */}
                          <span className="shrink-0 font-extrabold text-savings">
                            {v.offer &&
                              (v.offer.options && v.offer.options.length >= 2
                                ? `${moneyLocal(
                                    Math.min(...v.offer.options.map((o) => o.pricePerDay)),
                                    v.offer.currency
                                  )}-${moneyLocal(
                                    Math.max(...v.offer.options.map((o) => o.pricePerDay)),
                                    v.offer.currency
                                  )}`
                                : moneyLocal(v.offer.pricePerDay, v.offer.currency))}
                            /{t("day")}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-bold text-faint">
                          {typeof v.rating === "number" && v.rating > 0 && <span>⭐ {v.rating.toFixed(1)}</span>}
                          {/* EVERY deposit alternative, never only the first.
                              This chip rendered the legacy enum alone -
                              "passport or money4000" showed as "Passport
                              deposit" while the 4000 sat parsed in
                              depositAmount. One shared summary now
                              (lib/deposit.depositSummary), same as the card. */}
                          {(v.offer?.deposit || v.offer?.depositType) && (
                            <span>
                              🔐 {depositSummary(
                                {
                                  deposit: v.offer.deposit,
                                  depositType: v.offer.depositType,
                                  depositAmount: v.offer.depositAmount,
                                  depositCurrency: v.offer.depositCurrency,
                                  currency: v.offer.currency,
                                },
                                moneyLocal
                              ) ?? t("Deposit asked")}
                            </span>
                          )}
                          {/* WHERE a sourced price came from - menu photo,
                              option menu, or the thread - until confirmed. */}
                          {v.offer?.priceSource && (
                            <span className="text-brandblue">
                              {v.offer.priceSource === "menu-photo"
                                ? `📷 ${t("from menu photo")}`
                                : v.offer.priceSource === "menu"
                                  ? `📋 ${t("from price menu")}`
                                  : `💬 ${t("from the chat")}`}
                            </span>
                          )}
                          {v.offer?.includesDelivery && <span>🛵 {t("Delivers")}</span>}
                          {v.offer?.includesInsurance && <span>🛡️ {t("Insurance")}</span>}
                          {v.lastEventAt && <span>🕐 {formatClock(v.lastEventAt)}</span>}
                        </div>
                        {v.offer?.message && (
                          <div className="mt-1 rounded-lg bg-card2 px-2 py-1 text-[10px] text-soft">
                            <div className="truncate">💬 {v.offer.message}</div>
                            {/* The English gloss of a local-language reply -
                                the raw words stay primary, the translation is
                                the quiet second line (W1.5, everywhere). */}
                            {v.offer.messageEnglish &&
                              v.offer.messageEnglish.trim() !== v.offer.message.trim() && (
                                <div className="mt-0.5 truncate italic text-faint">
                                  🌐 {v.offer.messageEnglish}
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* SECTION 2 - REPLIED, no price yet. The shop is talking to
                    us: show their actual last words so the panel and the feed
                    tell the same story. */}
                {statusGroups.replied.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-brandblue">
                      💬 {t("Replied - your agent is on it")} ({statusGroups.replied.length})
                    </div>
                    {statusGroups.replied.map((v) => (
                      <div key={v.id} className="mb-1.5 rounded-xl bg-card p-2 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            onClick={() => scrollToVendor(v.id)}
                            className="flex min-w-0 items-center gap-1 text-left font-extrabold text-strong hover:text-brandblue"
                            title={t("Jump to this shop")}
                          >
                            <span className="shrink-0 text-brandblue">↧</span>
                            <ShopAvatar name={v.name} phone={v.whatsapp} size="sm" retryKey={v.stage} photoUrl={v.photoUrl} />
                            <span className="truncate">{v.name}</span>
                          </button>
                          <span className="shrink-0 text-[10px] font-bold text-brandblue">
                            {v.lastInboundAt ? formatClock(v.lastInboundAt) : t("replied")}
                          </span>
                        </div>
                        {v.lastInboundText && (
                          <div className="mt-1 rounded-lg bg-card2 px-2 py-1 text-[10px] text-soft">
                            <div className="line-clamp-2">💬 {v.lastInboundText}</div>
                            {/* Same doctrine as the offers section: real words
                                first, English gloss as the quiet second line. */}
                            {v.lastInboundEnglish &&
                              v.lastInboundEnglish.trim() !== v.lastInboundText.trim() && (
                                <div className="mt-0.5 line-clamp-2 italic text-faint">
                                  🌐 {v.lastInboundEnglish}
                                </div>
                              )}
                          </div>
                        )}
                        {/* WHAT IS ACTUALLY HAPPENING, not one sentence for
                            everybody. This line read "No price yet - your
                            agent is asking for one" for every shop in the
                            bucket, including shops that had told us they had
                            run out and shops that had said no. Both are in
                            here (the partition keys on `lastInboundAt`), and
                            for both the sentence was simply false. The stage
                            is state we already hold; the fuller derivation -
                            queued, held, which guard - is F10's outbox join. */}
                        <div className="mt-1 text-[10px] font-bold text-faint">
                          {v.stage === "out-of-stock"
                            ? t("They have run out - your agent asked when they are back.")
                            : v.stage === "declined"
                              ? t("They passed on this one.")
                              : v.confirming
                                ? t("Double-checking something with the shop before we trust it.")
                                : v.stage === "counter-offer" || v.stage === "negotiating"
                                  ? t("A price is on the table - your agent is bargaining it down.")
                                  : t("No price yet - your agent is asking for one.")}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* SECTION 2.5 - Removed by you. Shown, not hidden: these
                    shops used to reappear under "Awaiting reply", which is how
                    the panel claimed 7 messaged for 3 real sends. Nothing was
                    sent to them, so they are counted nowhere else.

                    ...but it is a NOTICE, not a ledger. Unconditional, it stayed
                    for the rest of the session and crowded the live shops out of
                    the panel it shares. Dismissal is per shop, so removing
                    another one later brings the notice back with only the new
                    name in it. */}
                {visibleRemoved.length > 0 && (
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-[10px] font-extrabold uppercase text-faint">
                      <span className="min-w-0 flex-1 truncate">
                        🚫 {t("Removed by you")} ({visibleRemoved.length})
                      </span>
                      <button
                        onClick={dismissRemoved}
                        className="btn fluid-press shrink-0 rounded-full bg-card2 px-2 py-0.5 text-[9px] font-extrabold uppercase text-soft"
                        aria-label={t("Dismiss")}
                      >
                        {t("Dismiss")}
                      </button>
                    </div>
                    <p className="text-[11px] text-soft">
                      {visibleRemoved.map((v) => v.name).join(", ")} -{" "}
                      {t("nothing was sent to these shops.")}
                    </p>
                  </div>
                )}

                {/* SECTION 3 - Awaiting reply: contacted, nothing back yet. */}
                {statusGroups.messaged.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-faint">
                      📤 {t("Awaiting reply")} ({statusGroups.messaged.length})
                    </div>
                    {statusGroups.messaged.map((v) => (
                      <div key={v.id} className="py-0.5 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            onClick={() => scrollToVendor(v.id)}
                            className="flex min-w-0 items-center gap-1 text-left font-bold text-strong hover:text-brandblue"
                            title={t("Jump to this shop")}
                          >
                            <span className="shrink-0 text-brandblue">↧</span>
                            <ShopAvatar name={v.name} phone={v.whatsapp} size="sm" retryKey={v.stage} photoUrl={v.photoUrl} />
                            <span className="truncate">{v.name}</span>
                          </button>
                          <span className="shrink-0 text-faint">
                            {v.lastEventAt ? `${t("sent")} ${formatClock(v.lastEventAt)}` : t("awaiting reply")}
                          </span>
                        </div>
                        {(v.sentText || v.sentGloss) && (
                          <div className="mt-0.5 rounded-lg bg-card px-2 py-1 text-[10px] text-soft">
                            {/* What was ACTUALLY sent, then its translation -
                                the gloss alone hid the real wire text (W1.5). */}
                            {v.sentText && <div className="line-clamp-2">📤 {v.sentText}</div>}
                            {v.sentGloss && v.sentGloss.trim() !== v.sentText?.trim() && (
                              <div className="mt-0.5 line-clamp-2 italic text-faint">
                                🌐 {v.sentGloss}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* SECTION 4 - Contacting: intros still queued (auto-sends). A
                    shop here is NEVER simultaneously above - the buckets are
                    mutually exclusive by construction. */}
                {statusGroups.queued.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-faint">
                      🕘 {t("Contacting")} ({statusGroups.queued.length})
                    </div>
                    {statusGroups.queued.map((v) => (
                      <div key={v.id} className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
                        <span className="truncate font-bold text-soft">{v.name}</span>
                        <span className="shrink-0 text-faint">
                          {v.queuedUntil && Date.parse(v.queuedUntil) > Date.now()
                            ? `~${formatClock(v.queuedUntil)}`
                            : t("next safe slot")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* How many shops are still SILENT - a shop that has written
                    back is not "still to respond", it is being worked. */}
                {stageCounts.messaged > 0 && (
                  <div className="rounded-lg bg-card px-2 py-1 text-[11px] font-bold text-soft">
                    ⏳ {stageCounts.messaged} {t("shop(s) still to respond")}
                  </div>
                )}

                {/* Wait-with-us: play the game, or leave and get alerted. Works on
                    every plan (free / pro / ultra). */}
                <div className="rounded-xl bg-brandblue-soft p-2.5 text-[11px] leading-relaxed text-brandblue">
                  {t("Replies can take a few minutes during the shop's business hours. You can wait here and play our game, or leave the app - we'll alert you when a new shop replies (all plans).")}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setShowGame(true)}
                      className="btn btn-sm rounded-xl bg-brandblue px-2.5 py-1 text-[11px] font-extrabold text-white"
                    >
                      🎮 {t("Play while you wait")}
                    </button>
                    <AlertsChip t={t} />
                  </div>
                </div>

                {/* Queued messages have their own always-visible card below the
                    status panel (item #2) - not duplicated here. */}
              </div>
            )}
          </div>
        )}

        {/* YOUR QUEUED MESSAGES (item #2): always-visible, per-user card driven
            by the server queue - every traveller sees and manages exactly what
            is waiting to be sent on their behalf (shop closed, human pacing,
            strategist hold) and can remove any of it. */}
        {queueItems.length > 0 && (
          <div data-tour="queue" className="surface mt-3 rounded-blob p-3 animate-slide-up">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="text-[13px] font-extrabold text-strong">
                🕘 {t("Your queued messages")} ({queueItems.length})
              </div>
              <span className="text-[10px] font-bold text-faint">{t("auto-sends")}</span>
            </div>
            {queueStalled && (
              <p className="mb-1.5 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-warn">
                ⏱ {t("Sending fell behind while the app was away - catching up now, one message at a time.")}
              </p>
            )}
            {/* A paused session must not predict send times. The queue rows
                already say "Paused by you"; a "next at ~23:47" above them read
                as a promise the agents had no intention of keeping. */}
            {paused ? (
              <p className="mb-1.5 text-[11px] font-bold text-soft">
                ⏸ {t("Held while your agents are paused - tap Resume and these go out within minutes.")}
              </p>
            ) : queueProgress ? (
              <p className="mb-1.5 text-[11px] text-soft">
                {queueProgress.sent > 0
                  ? `${queueProgress.sent} ${t("of")} ${queueProgress.total} ${t("sent")} · `
                  : ""}
                {queueProgress.dueNow
                  ? t("next one leaves any moment")
                  : queueEtaHead
                    ? `${t("next at")} ${etaRangeLabel(
                        queueEtaHead.etaFrom,
                        queueEtaHead.etaTo,
                        Date.parse(queueEtaHead.etaFrom ?? queueEtaHead.notBefore) <= Date.now(),
                        queueEtaHead.notBefore,
                        t
                      )}`
                    : queueProgress.nextAt
                      ? `${t("next at")} ~${formatClock(queueProgress.nextAt)}`
                      : ""}
                {queueEtaDoneByStr && queueProgress.waiting > 1
                  ? ` · ${t("all done by")} ~${formatClock(queueEtaDoneByStr)}`
                  : queueProgress.doneBy && queueProgress.waiting > 1
                    ? ` · ${t("all done by")} ~${formatClock(queueProgress.doneBy)}`
                    : ""}
                {" - "}
                {t("your agent messages shops one at a time, the way a person would")}
              </p>
            ) : null}
            {introBudget && (
              <div className="mb-1.5 rounded-xl bg-card2 px-2.5 py-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-extrabold text-strong">
                    💬 {t("Shop conversations")}
                  </span>
                  <span className="whitespace-nowrap text-[10px] font-bold text-soft">
                    {introBudget.cap - introBudget.remaining} {t("of")} {introBudget.cap}{" "}
                    {t("started")} · {introBudget.windowHours}h
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-brandblue transition-all"
                    style={{
                      width: `${Math.round(
                        (Math.max(0, introBudget.cap - introBudget.remaining) /
                          Math.max(1, introBudget.cap)) *
                          100
                      )}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-[10px] text-faint">
                  {introBudget.remaining > 0
                    ? `${introBudget.remaining} ${t("more shops you can start chatting - a chat is one shop, any length or number of messages")}`
                    : introBudget.nextFreeAt
                      ? `${t("All started - your next conversation opens at")} ~${formatClock(introBudget.nextFreeAt)}`
                      : t("All started")}
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              {queueItems.map((q) => (
                <div key={q.id} className="flex items-center justify-between gap-2 rounded-xl bg-card2 p-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-bold text-strong">
                      {q.vendorName || q.toNumber}
                    </span>
                    <span className="block text-[10px] text-faint">
                      {t(q.reason)}
                      {q.due
                        ? ` · ${etaRangeLabel(q.etaFrom, q.etaTo, true, q.notBefore, t)}`
                        : q.etaFrom || q.notBefore
                          ? ` · ${etaRangeLabel(q.etaFrom, q.etaTo, false, q.notBefore, t)}`
                          : ""}
                    </span>
                  </span>
                  <button
                    onClick={() => removeQueued(q.id, q.vendorId, q.toNumber)}
                    disabled={removingIds.has(q.id)}
                    className="btn btn-sm shrink-0 rounded-lg border-2 border-line px-2 py-1 text-[10px] font-extrabold text-brandred hover:bg-brandred-soft disabled:opacity-50"
                  >
                    {removingIds.has(q.id) ? t("Removing...") : t("Remove")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {cheapest?.offer && (
          <div className="mt-3 flex items-center justify-between rounded-blob border-2 border-savings bg-savings-soft p-3 animate-slide-up">
            <div className="text-[12px]">
              <div className="font-bold text-soft">
                {cheapest.offer.verified
                  ? t("Cheapest confirmed price")
                  : t("Best price so far (unconfirmed)")}
              </div>
              <div className="font-extrabold text-strong">{cheapest.name}</div>
            </div>
            <div className="text-right">
              <div className="text-xl font-extrabold text-savings">
                {moneyLocal(cheapest.offer.pricePerDay, cheapest.offer.currency)}
                <span className="text-xs text-soft">/{t("day")}</span>
              </div>
              <button
                onClick={() => setBookingVendor(cheapest)}
                className="text-[11px] font-extrabold text-savings underline"
              >
                {t("Lock it")} →
              </button>
            </div>
          </div>
        )}

        {/* M13 - NO AD HERE, AND THIS IS THE PLACEMENT RULE.
            This slot sat between the best-price "Lock it" button above and the
            Ultra language toggle below: an ad touching the single highest-value
            tap in the product. That invites a misclick on the one action that
            closes a deal, and it interrupts the exact moment the app exists to
            produce.
            It was also a DUPLICATE. It rendered on `vendors.length > 0` while
            the in-feed slot renders on `vendors.length > 3 && view === "list"`,
            so a free user with four shops in list view got two ad units on one
            screen. The in-feed slot is kept - it sits inside the results, away
            from every CTA - and this one is removed rather than relocated,
            because the screen did not need two.
            B10 still holds and is now trivially satisfied: no ad exists on the
            empty first screen either. */}

        {/* Ultra: bargain in the shop's LOCAL language (optional toggle). */}
        {rfq && (
          <button
            disabled={languageLocked}
            aria-disabled={languageLocked}
            title={
              languageLocked
                ? t("The language is set for this hunt - start a new search to change it.")
                : undefined
            }
            onClick={() => {
              if (languageLocked) return;
              if (session?.plan !== "ultra") {
                setUpgradeOpen(true);
                return;
              }
              const next = !localLang;
              setLocalLang(next);
              try {
                localStorage.setItem("wd_local_lang", next ? "1" : "0");
              } catch {}
            }}
            className={`mt-3 flex w-full items-center justify-between rounded-2xl border-2 px-4 py-2.5 text-[13px] font-extrabold transition ${
              languageLocked ? "cursor-not-allowed opacity-60 " : ""
            }${
              localLangActive
                ? "border-transparent bg-gradient-to-r from-brandblue via-[#7c5cff] to-brandred text-white shadow-lg"
                : "border-line bg-card text-soft"
            }`}
          >
            <span>🌐 {t("Bargain in the shop's local language")}</span>
            <span className="flex items-center gap-1">
              {session?.plan !== "ultra" && <span className="text-[10px]">✦ Ultra</span>}
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  localLangActive ? "bg-white/25" : "bg-card2 text-faint"
                }`}
              >
                {localLangActive ? t("ON") : t("OFF")}
              </span>
            </span>
          </button>
        )}
        {languageLocked && rfq && (
          <p className="mt-1 text-[11px] font-bold text-faint">
            🔒 {t("The language is set for this hunt - start a new search to change it.")}
          </p>
        )}
        {localLangActive && (
          <p className="mt-1 text-[11px] font-bold text-brandblue">
            🌐 {t("Agents will haggle like a local - and you'll see the English translation of every message.")}
          </p>
        )}

        {/* Mass bargain: one tap asks several shops at once (Pro/Ultra).
            GATED ON ELIGIBILITY (D6, the owner's item 9): once the hunt is
            live and every shop already has a conversation open, there is
            nobody left for this button to message - `vendors.length > 1`
            kept it on screen promising a blast it could not send. The same
            eligibility rule the confirm sheet uses decides the render. */}
        {vendors.length > 1 &&
          rfq &&
          (massState === "running" ||
            massBargainTargets(vendors, session?.plan).targets.length > 0) && (
          <div className="mt-3">
            <button
              onClick={() => {
                // Premium beta note first (backend enforces the same cap) -
                // non-subscribers go straight to the upgrade path as before.
                if (can(session?.plan, "mass-bargain")) setMassInfoOpen(true);
                else runMassBargain();
              }}
              disabled={massState === "running"}
              className={`btn w-full rounded-2xl py-3 text-[14px] font-extrabold text-white disabled:opacity-70 ${
                !can(session?.plan, "mass-bargain") ? "bg-faint" : "badge-flash"
              }`}
            >
              {massState === "running" ? (
                <LoadingDots light label={t("Agents contacting every shop")} />
              ) : (
                <span className="flex items-center justify-center gap-1.5">
                  {/* WhatsApp glyph brands the channel these messages go out on. */}
                  <Icon name={can(session?.plan, "mass-bargain") ? "whatsapp" : "lock"} className="h-4 w-4" />
                  {t("Mass bargain - ask all shops at once")}
                </span>
              )}
            </button>
          </div>
        )}
        {/* The blast's outcome note outlives the button: once everyone is
            contacted the button honestly disappears, but "Asked N shops"
            must not vanish with it. */}
        {massNote && rfq && (
          <p className="mt-1 text-center text-[11px] font-bold text-soft">{massNote}</p>
        )}

        {vendors.length > 0 && (
          <>
            <div data-tour="views" className="surface-strong substick mt-4 rounded-2xl p-1">
              <div className="flex items-center gap-1">
                <ToggleBtn active={view === "list"} onClick={() => setView("list")}>
                  <Icon name="list" className="h-4 w-4" /> {t("List")}
                </ToggleBtn>
                <ToggleBtn active={view === "map"} onClick={() => setView("map")}>
                  <Icon name="map" className="h-4 w-4" /> {t("Map")}
                </ToggleBtn>
                <ToggleBtn active={view === "activity"} onClick={() => setView("activity")}>
                  <Icon name="sparkles" className="h-4 w-4" /> {t("Activity")}
                </ToggleBtn>
              </div>
              {/* The list's axis pair (owner report 4, item 5). It used to
                  ride the END of the sort row's horizontal scroller - behind
                  five sort chips, invisible at 320px without scrolling. The
                  sticky views bar is the one surface that is ALWAYS on
                  screen, and a second row inside the same sticky plate costs
                  no width (three ToggleBtns + two chips cannot share 272px).
                  List view only - map and activity have no axis to flip. */}
              {view === "list" && (
                <div className="mt-1 flex items-center gap-1 border-t border-line pt-1">
                  <ToggleBtn active={listAxis !== "horizontal"} onClick={() => setListAxis("vertical")}>
                    ↕ {t("Feed")}
                  </ToggleBtn>
                  <ToggleBtn active={listAxis === "horizontal"} onClick={() => setListAxis("horizontal")}>
                    ↔ {t("Swipe")}
                  </ToggleBtn>
                </div>
              )}
            </div>
            <WaSafetyBadge safety={waHealth} />
            <div className="mt-3">
              <Filters
                filters={filters}
                onChange={setFilters}
                availableClasses={availableClasses}
                isUltra={session?.plan === "ultra"}
                onUpgrade={() => setUpgradeOpen(true)}
                tagCounts={tagCounts}
              />
            </div>
          </>
        )}

        {view === "activity" && vendors.length > 0 ? (
          <ActivityFeed
            items={activityItems}
            onWhy={(id) => setWhyDecision(id)}
            onJump={(vendorId) => scrollToVendor(vendorId)}
            phoneOf={(vendorId) => vendors.find((x) => x.id === vendorId)?.whatsapp}
            onTranscript={(id, name) => {
              const v = vendors.find((x) => x.id === id);
              if (v) setDashboardFor(v);
              else setTranscriptFor({ id, name });
            }}
          />
        ) : view === "map" && vendors.length > 0 && origin ? (
          <div className="relative z-0 mt-3">
            <MapView
              origin={origin}
              radiusKm={radiusKm}
              vendors={filtered}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOpenVendor={(v) => {
                setView("list");
                setSelectedId(v.id);
              }}
            />
          </div>
        ) : (
          <div data-tour="vendors" className="mt-3">
            {/* M10 - THE SECOND AXIS.
                The vertical feed holds every shop in the traveller's sort
                order, so finding the second-cheapest quote means scrolling
                past every shop still being contacted and every one that went
                quiet. The rail is the horizontal answer: only the shops that
                actually answered with a price, cheapest first, and a tap
                drives this same feed through the jump the status panel and the
                push deep-links already use. Two axes, one list, one selection
                - it derives nothing of its own. */}
            {listAxis === "vertical" && (
              <QuotesRail
                vendors={filtered}
                dominantCurrency={dominantCurrency}
                selectedId={selectedId}
                onPick={scrollToVendor}
                t={t}
              />
            )}
            {listAxis === "horizontal" ? (
              // THE SIDEWAYS LIST (owner report 3, item 12): the SAME cards,
              // one per snap stop, on the rail's own scroller. QuotesRail is
              // hidden here - a quotes strip above a horizontal list would be
              // two rails stacked, and the cards already carry the prices.
              <HorizontalVendorRail vendors={filtered} renderCard={renderVendorCard} />
            ) : (
              /* WINDOWED. Forty shops is forty heavy cards - photo, avatar,
                 tracker, options, composer, a thread peek with its own poll -
                 all mounted and all re-rendering on every activity tick, on a
                 phone. Only the rows near the viewport exist. */
              <VirtualVendorList
                vendors={filtered}
                scrollRequest={scrollRequest}
                renderCard={renderVendorCard}
              />
            )}
            {/* YOUR FILTERS HID EVERYTHING (M2). With every shop filtered out
                both the list and the map rendered blank - which reads as "no
                shops exist", when 20 sit one tap away. Say it, and hand over
                the tap. */}
            {filtered.length === 0 && vendors.length > 0 && (
              <div className="surface mt-3 rounded-blob p-4 text-center">
                <p className="text-[13px] font-bold text-strong">
                  {t("Your filters hide all")} {vendors.length} {t("shops")}
                </p>
                <button
                  onClick={() =>
                    setFilters({ ...DEFAULT_FILTERS, vehicleClass: filters.vehicleClass })
                  }
                  className="btn mt-2 rounded-2xl border-2 border-line px-4 py-2 text-[12px] font-extrabold text-brandblue"
                >
                  {t("Show them all")}
                </button>
              </div>
            )}
            {/* ...and the "more coming" spinner counts only the genuinely
                pending (funnel stages that have not resolved), never the
                shops a filter is hiding (M2): a filter tap used to spin this
                forever over a finished hunt. */}
            {phase === "running" &&
              vendors.some((v) => v.stage === "queued" || v.stage === "locating-contact") && (
                <div className="surface flex justify-center rounded-blob p-4">
                  <LoadingDots label={t("More agents reporting in")} />
                </div>
              )}
          </div>
        )}

        {/* THE SCREEN THE OWNER WAS LOOKING AT WHEN THEY SAID THE GLOW LOOKS BAD.
            It had no glow at all - four hand-rolled skeleton cards and nothing
            that said the system was working. The heartbeat leads now, and the
            skeletons follow as the shape still to fill in.

            EXACTLY ONE full-glow element: the heartbeat. The cards keep the
            cheap shimmer. A conic gradient under an 18px blur is a real repaint
            cost on a low-end Android, and this list is virtualized precisely
            because that phone is the target. One signal is also better design -
            four glowing cards is a light show, not a status. */}
        {phase === "profiling" && (
          <div className="mt-3">
            <div className="surface flex justify-center rounded-blob px-4 py-7">
              <BrandPulse size={62} label={t("Finding shops near you")} />
            </div>
            <div className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="surface overflow-hidden rounded-blob">
                  <div className="skeleton h-24 w-full" />
                  <div className="space-y-2 p-4">
                    <div className="skeleton h-4 w-2/3 rounded-full" />
                    <div className="skeleton h-3 w-1/2 rounded-full" />
                    <div className="skeleton h-9 w-full rounded-2xl" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {vendors.length > 3 && view === "list" && <AdBanner plan={session?.plan} />}

        {vendors.length === 0 && phase === "idle" && (
          <div className="mt-10 text-center">
            <div className="mx-auto flex w-fit items-end gap-1.5">
              <div className="float-soft">
                <WillAvatar size={72} className="drop-shadow-lg" />
              </div>
              <div className="relative mb-4 max-w-[220px] rounded-2xl rounded-bl-md bg-card2 px-3 py-2 text-left shadow-md rise-in">
                <p className="text-[12px] font-extrabold leading-snug text-strong">
                  {t("Tell me what you want to ride and where you're staying.")}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-soft">
                  {t("I'll find every shop around you and haggle the real local price.")}
                </p>
                <span aria-hidden className="absolute -left-1 bottom-2.5 h-2 w-2 rotate-45 bg-card2" />
              </div>
            </div>
          </div>
        )}

        {/* Zero results after a completed search (was a blank screen) */}
        {vendors.length === 0 && phase === "done" && (
          <div className="mt-8 rounded-blob surface p-5 text-center animate-slide-up">
            <div className="mx-auto mb-2 w-fit">
              <WillAvatar size={56} wave={false} />
            </div>
            <div className="text-[15px] font-extrabold text-strong">
              {t("No rental shops found near your stay")}
            </div>
            <p className="mx-auto mt-1 max-w-[300px] text-[13px] text-soft">
              {t("Nothing in this radius yet - let me widen the net, or double-check the location is right.")}
            </p>
            <button
              onClick={() => {
                setRadiusKm((r) => Math.min(25, r + 5));
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className="btn btn-primary mt-3 rounded-2xl px-5 py-2.5 text-[13px]"
            >
              {t("Widen radius +5 km")}
            </button>
          </div>
        )}

        {/* Popular questions - owner-managed, expandable (#18) */}
        {phase === "idle" && <FaqSection />}
        {phase === "idle" && <SiteFooter />}
      </div>

      {bookingVendor && (
        <BookingSheet
          vendor={bookingVendor}
          rfq={rfq}
          plan={session?.plan}
          onClose={() => setBookingVendor(null)}
        />
      )}
      {reviewsVendor && <ReviewsSheet vendor={reviewsVendor} onClose={() => setReviewsVendor(null)} />}
      {showGame && <WaitGame onClose={() => setShowGame(false)} />}
      {bargainVendor && rfq && (
        <BargainDraftModal
          vendor={bargainVendor}
          rfq={rfq}
          region={origin?.label ?? ""}
          round={bargainVendor.offer ? bargainVendor.offer.round + 1 : 0}
          plan={session?.plan}
          sessionLocalLang={localLangActive}
          currentPricePerDay={bargainVendor.offer?.pricePerDay}
          rivalPricePerDay={
            cheapest && cheapest.id !== bargainVendor.id
              ? cheapest.offer?.pricePerDay
              : undefined
          }
          onClose={() => setBargainVendor(null)}
        />
      )}
      {feedbackOpen && <FeedbackModal email={session?.email} onClose={() => setFeedbackOpen(false)} />}
      {upgradeOpen && <UpgradeSheet onClose={() => setUpgradeOpen(false)} />}
      {whyDecision && <WhyThisSheet decisionId={whyDecision} onClose={() => setWhyDecision(null)} />}
      {locationAskFor && (
        <LocationShareSheet
          shopName={locationAskFor.name}
          askedQuote={locationAskFor.offer?.askedLocationQuote}
          // The area this search is centred on - already chosen, already
          // resolved, and the honest third answer for a traveller with no
          // saved stay (and the fallback when device location is refused).
          searchOrigin={origin?.label || undefined}
          onClose={() => setLocationAskFor(null)}
          onShare={(place) => pickupConsent(locationAskFor, place)}
        />
      )}

      {massPreview && (
        <MassBargainPreview
          targets={massPreview.targets}
          eligibleCount={massPreview.eligibleCount}
          cap={massPreview.cap}
          onCancel={() => setMassPreview(null)}
          onConfirm={(ids) => dispatchMassBargain(ids)}
        />
      )}

      {dashboardFor && (
        <ThreadDashboard
          // LIVE vendor, not the open-time snapshot (OR11 F2.2). `dashboardFor`
          // is frozen at the moment the sheet opened, so a price that landed
          // while it was open never reached it - and the dashboard hands its
          // vendor straight to onBook/onBargain, so booking and close-deal
          // committed a STALE price. Re-derive from the live list by id each
          // render; fall back to the snapshot only if the shop dropped out.
          vendor={vendors.find((v) => v.id === dashboardFor.id) ?? dashboardFor}
          rfq={rfq}
          searchEpoch={epochOnServerClock() || undefined}
          queueItem={(() => {
            const q = queueItems.find((it) => it.vendorId === dashboardFor.id);
            return q ? { etaFrom: q.etaFrom, etaTo: q.etaTo, reason: q.reason, due: q.due } : null;
          })()}
          agentPending={agentPending[dashboardFor.id]}
          whyDecisionId={whyByVendor[dashboardFor.id]}
          onClose={() => setDashboardFor(null)}
          onBook={setBookingVendor}
          onBargain={setBargainVendor}
          onReviews={setReviewsVendor}
          onWhy={openWhy}
        />
      )}
      {transcriptFor && (
        <TranscriptSheet
          vendorId={transcriptFor.id}
          vendorName={transcriptFor.name}
          since={epochOnServerClock() || undefined}
          onClose={() => setTranscriptFor(null)}
        />
      )}
      {onboarding && <Onboarding onClose={() => setOnboarding(false)} />}
      {massInfoOpen && (
        <Modal onClose={() => setMassInfoOpen(false)} center>
          <div className="text-center">
            <div className="mx-auto mb-3 w-fit">
              <WillAvatar size={56} />
            </div>
            {/* THE "10" WAS A LIE, AND IT WAS NOT EVEN A STALE CONSTANT.

                This screen hardcoded the LITERAL STRING "Up to 10 shops per
                hunt" - dead beta copy that no longer matched any code path.
                The next screen computes the truth from `massBargainTargets`,
                which caps at `massBargainCap(plan)` (free 10 / pro 20 / ultra
                24). So an Ultra traveller was told 10 and then offered all 18
                shops the search had found, and reasonably read that as a bug
                in the cap rather than a bug in the sentence.

                One source now. `massBargainCap` is the same function the
                confirm sheet slices with, so the two screens cannot disagree
                again. */}
            <h2 className="text-lg font-extrabold text-strong">
              {t("Up to")} {massBargainCap(session?.plan)} {t("shops per hunt")}
            </h2>
            <p className="mx-auto mt-2 max-w-[300px] text-[13px] leading-relaxed text-soft">
              {t("Each search contacts up to this many rental shops in one run. It keeps every negotiation sharp and your number perfectly paced.")}
            </p>
            <p className="mx-auto mt-1.5 max-w-[300px] text-[12px] font-bold text-faint">
              {t("A higher plan raises this automatically - nothing for you to do.")}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setMassInfoOpen(false)}
                className="btn btn-ghost flex-1 rounded-2xl py-2.5 text-sm"
              >
                {t("Not now")}
              </button>
              <button
                onClick={() => {
                  setMassInfoOpen(false);
                  runMassBargain();
                }}
                className="btn btn-primary flex-1 rounded-2xl py-2.5 text-sm"
              >
                {t("Let's go")}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {clearConfirm && (
        <Modal onClose={() => setClearConfirm(false)} center>
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-brandred-soft text-2xl">
              🧹
            </div>
            <h2 className="text-lg font-extrabold text-strong">{t("Clear this search?")}</h2>
            <p className="mt-1 text-[13px] text-soft">
              {t("Your current shops and any offers will be removed, and every waiting message is permanently cancelled - nothing will be sent later. This can't be undone.")}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setClearConfirm(false)}
                className="btn btn-ghost flex-1 rounded-2xl py-2.5 text-sm"
              >
                {t("Keep it")}
              </button>
              <button
                onClick={clearSearch}
                className="btn btn-danger flex-1 rounded-2xl py-2.5 text-sm"
              >
                {t("Clear search")}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Will's floating concierge callout - anchored to the element the user
          should touch next, driven by the derived funnel step + idle detection.
          The celebration ("Boom, linked!") always shows once; the compose nudge
          only steps in after 8s of hesitation so it guides without nagging. */}
      {session &&
        !willOpen &&
        !bookingVendor &&
        willStageNow &&
        !dismissedStages.has(willStageNow) &&
        (() => {
          const step = willStageNow;
          let guidance: {
            anchor: string;
            text: string;
            actions?: WillAction[];
            tone?: "guide" | "celebrate";
            onDismiss?: () => void;
          } | null = null;
          if (step === "WA_LINK_PENDING") {
            guidance = {
              anchor: "[data-will='wa-link']",
              text: t("Hey! Link your WhatsApp real quick - I bargain as you, a real traveller, so shops answer honestly."),
              actions: [
                {
                  label: t("Link it now"),
                  primary: true,
                  onAction: () => {
                    startNav();
                    router.push("/profile");
                  },
                },
              ],
            };
          } else if (
            (step === "SEARCH_EMPTY" || step === "SEARCH_INPUT") &&
            justLinked
          ) {
            guidance = {
              anchor: "[data-tour='request']",
              tone: "celebrate",
              text: t("Boom, linked! Where are we finding you a ride today?"),
              actions: [
                {
                  label: t("Build it in taps"),
                  primary: true,
                  onAction: () => {
                    clearJustLinked();
                    setBuilderOpen(true);
                  },
                },
              ],
              onDismiss: clearJustLinked,
            };
          } else if (
            (step === "SEARCH_EMPTY" || step === "SEARCH_INPUT") &&
            assistant.idle
          ) {
            guidance = {
              anchor: "[data-tour='request']",
              text: t("Tell me what you want to ride - I'll haggle every shop nearby. Not a typer? Build it in taps."),
              actions: [
                {
                  label: t("Build it in taps"),
                  primary: true,
                  onAction: () => setBuilderOpen(true),
                },
              ],
            };
          } else if (step === "SEARCH_NEEDS_STAY" && assistant.idle) {
            // The one that actually BLOCKS: discovery needs an origin, so no
            // amount of describing the bike gets a single shop contacted.
            guidance = {
              anchor: "[data-tour='stay']",
              text: t("Got it. Now drop your hotel or area - I search outward from there, so this is the one thing I can't guess."),
              actions: [
                {
                  label: t("Use my location"),
                  primary: true,
                  onAction: () => {
                    document
                      .querySelector("[data-tour='stay']")
                      ?.scrollIntoView({ behavior: "smooth", block: "center" });
                  },
                },
              ],
            };
          } else if (step === "SEARCH_NEEDS_REQUEST" && assistant.idle) {
            guidance = {
              anchor: "[data-tour='request']",
              text: t("Stay's set. What are we riding? Even 'cheap automatic scooter' is enough for me to work with."),
              actions: [
                {
                  label: t("Build it in taps"),
                  primary: true,
                  onAction: () => setBuilderOpen(true),
                },
              ],
            };
          } else if (step === "SEARCH_READY" && assistant.idle) {
            // Everything is present. The only honest advice left is either the
            // one blocker that remains, or "press it".
            guidance = !idpConsent
              ? {
                  anchor: "[data-tour='find']",
                  text: t("All set bar one tick - confirm you hold a licence for this category and I'll start messaging shops."),
                }
              : {
                  anchor: "[data-tour='find']",
                  tone: "celebrate",
                  text: t("That's everything I need. Hit Find my deal and I'll start haggling."),
                };
          } else if (step === "AGENTS_DISPATCHED") {
            // Every action here MOVES the traveller somewhere real. These used
            // to flip a view flag with no scroll (so nothing visibly happened)
            // or simply open the chat - the report was "Will's buttons only
            // ever open the chat instead of guiding me around the app".
            guidance = {
              anchor: "[data-tour='status']",
              // HONEST TENSE. The old copy claimed "I'm reaching out to the
              // shops from your WhatsApp now" during a phase that sends
              // nothing - discovery only FINDS shops; messages go out when the
              // traveller picks them.
              text: t("Scanning the area for real rental shops near your stay - a few seconds."),
              actions: [
                {
                  label: t("Watch live"),
                  primary: true,
                  onAction: () => goToSection("[data-tour='views']", "activity"),
                },
              ],
            };
          } else if (step === "SHOPS_FOUND") {
            // THE STATE THE OWNER CAUGHT (report 3, item 9): shops found, zero
            // messages sent - and Will offered "See it live" with nothing live,
            // while the status panel on the same screen truthfully said 0
            // contacted. The honest advice is the actions that MAKE something
            // live: pick a shop, or let the mass bargain contact the best ones.
            guidance = {
              anchor: "[data-tour='vendors']",
              text: t("Found your shops. Tap 'Ask for price' on the ones you like - or I can message the best ones for you at once."),
              actions: [
                {
                  label: t("Message the best shops"),
                  primary: true,
                  dismissOnDone: true,
                  onAction: () => void runAction("mass-bargain"),
                },
                {
                  label: t("Let me pick"),
                  onAction: () => goToSection("[data-tour='vendors']", "list"),
                },
              ],
            };
          } else if (step === "NEGOTIATING") {
            guidance = {
              anchor: "[data-tour='status']",
              text: t("Shops are reading your request - the second a price lands, I check it against the market floor and push lower."),
              actions: [
                {
                  label: t("See it live"),
                  primary: true,
                  onAction: () => goToSection("[data-tour='views']", "activity"),
                },
                {
                  label: t("Show the shops"),
                  onAction: () => goToSection("[data-tour='vendors']", "list"),
                },
              ],
            };
          } else if (step === "RESULTS_READY") {
            const best = vendors.find((v) => v.offer);
            guidance = {
              anchor: "[data-tour='status']",
              text: t("Offers are in - tap a shop to compare. Want me to push harder before you book?"),
              actions: [
                {
                  label: t("Take me to the offers"),
                  primary: true,
                  onAction: () =>
                    best ? scrollToVendor(best.id) : goToSection("[data-tour='vendors']", "list"),
                },
                {
                  // Through the registry, like every other action - so a
                  // comparison that cannot happen SAYS so instead of looking
                  // like a dead button (the sheet needs two shops).
                  label: t("Compare the top 3"),
                  onAction: () =>
                    void runAction("compare", {
                      vendorIds: vendors
                        .filter((v) => v.offer)
                        .slice(0, 3)
                        .map((v) => v.id),
                    }),
                },
                {
                  // A REAL ACTION now, not a panel. It goes through the same
                  // guarded outbound path an agent message does, and it is
                  // confirmed because it reaches a shop (lib/actions/registry).
                  // The chip goes busy for the whole round-trip and the card
                  // dismisses when it settles - a lingering live chip was how
                  // repeated taps stacked near-identical bargains in the field.
                  label: t("Push harder"),
                  dismissOnDone: true,
                  onAction: () => {
                    if (best?.id) return runAction("push-harder", { vendorId: best.id }, true);
                    setWillOpen(true);
                  },
                },
              ],
            };
          }
          if (!guidance) return null;
          return (
            <WillGuideOverlay
              anchor={guidance.anchor}
              text={guidance.text}
              actions={guidance.actions}
              tone={guidance.tone}
              onOpenChat={() => setWillOpen(true)}
              onDismiss={() => {
                guidance?.onDismiss?.();
                dismissWillStage(step);
              }}
            />
          );
        })()}

      {/* W7: summon chip - when the inline guide is dismissed for this stage,
          Will stays one tap away as a small avatar button above the TabBar. No
          drag, no auto-nap; a stage change resurfaces the full banner. */}
      {/* TWO BUTTONS, ONE PIECE OF SCREEN, NO OWNER.

          "Ask Will" and "Live status" each hard-coded their own bottom-right
          position with no knowledge of the other. At 320px the chip occupied
          72-110px above the bottom edge and the status FAB 84-121px: a ~26px
          overlap across most of their shared width. And the chip's raw
          `z-[900]` beat the FAB's `layer-chrome` (50), so the chip painted on
          top and SWALLOWED the FAB's taps - the owner could see "Live status"
          and could not press it.

          The stack has an owner now: this file renders both, so it decides
          where they sit. The chip lifts clear whenever the FAB can be mounted
          (same condition as the FAB below). The FAB additionally hides itself
          when the status panel is already on screen, so the chip sometimes
          floats a slot higher than it strictly needs to - a cosmetic cost, and
          the alternative is a visibility handshake between two independent
          components for no functional gain.

          Both now use the same layering token, so neither can silently eat the
          other's taps again. */}
      {session && !willOpen && willStageNow && dismissedStages.has(willStageNow) && (
        // PORTALLED (owner report 6 G2): this chip was an inline `fixed`
        // child of <main>, contradicting FixedLayer's own doctrine - one
        // transform on any ancestor away from floating mid-card, and blind to
        // the keyboard (it hovered over the panned page while typing). The
        // slot also stands down in swipe mode, where the z-50 band painted
        // straight over the rail cards' Bargain row.
        <FixedLayer
          hostIsFixed
          className="layer-chrome fixed right-3"
          style={{
            // SLOTS from the shared bottom-right stack (globals.css, beside
            // the z ladder): slot 2 clears the status FAB in slot 1; slot 0
            // hugs the tab bar when no FAB can mount.
            bottom:
              vendors.length > 0 && view === "list" && listAxis !== "horizontal"
                ? "var(--stack-bottom-2)"
                : "var(--stack-bottom-0)",
          }}
        >
          <button
            onClick={() => setWillOpen(true)}
            aria-label={t("Ask Will")}
            // The other half of the onboarding "Meet Will" anchor: when the
            // guide banner is dismissed for this stage, the summon chip is what
            // "Will on the edge of your screen" IS. The two mounts are mutually
            // exclusive, so the attribute is never duplicated.
            data-tour="will"
            className="flex items-center gap-1.5 rounded-full border-2 border-brandblue bg-card px-2.5 py-1.5 text-[11px] font-extrabold text-brandblue shadow-lg lift"
          >
            <WillAvatar size={22} wave={false} />
            {t("Ask Will")}
          </button>
        </FixedLayer>
      )}
      {/* Will - the living companion on the edge of the screen. The TabBar is
          the primary bottom element; Will's full chat opens from him. */}
      {willOpen && (
        <WillSheet
          messages={will.messages}
          notes={will.notes}
          busy={will.busy}
          onSend={will.send}
          onClose={() => setWillOpen(false)}
        />
      )}
      {compareIds.length >= 2 && (
        <CompareSheet
          vendors={vendors.filter((v) => compareIds.includes(v.id))}
          durationDays={rfq?.durationDays ?? 1}
          onLock={(v) => {
            setCompareIds([]);
            setBookingVendor(v);
          }}
          onClose={() => setCompareIds([])}
        />
      )}

      {/* WHAT JUST HAPPENED. Every action reports through one renderer, so a
          refusal, a success and a genuinely impossible request all reach the
          traveller - and none of them can look like a dead button. */}
      {actionNote && (
        <FixedLayer className="pointer-events-none fixed inset-x-0 bottom-[104px] z-[60] px-4">
          <div
            role="status"
            className={`surface mx-auto max-w-md rounded-blob px-3.5 py-2.5 text-[12px] font-extrabold shadow-lg ${
              actionNote.tone === "ok"
                ? "text-savings"
                : actionNote.tone === "bad"
                  ? "text-brandred"
                  : "text-strong"
            }`}
          >
            {actionNote.text}
          </div>
        </FixedLayer>
      )}

      {/* BACK TO THE STATUS PANEL. The list no longer paginates, so a busy hunt
          is an unbounded scroll and the panel that says what the agents are
          doing is at the top of it. The button appears only once that panel is
          off screen - a control pointing at something already visible is
          clutter - and it watches the element itself rather than guessing from
          a scroll offset that a collapsing header would invalidate. */}
      {vendors.length > 0 && view === "list" && listAxis !== "horizontal" && (
        <StatusFab
          target="[data-tour='status']"
          label={t("Live status")}
          onOpen={() => setStatusOpen(true)}
        />
      )}

      <TabBar
        active="home"
        onSelect={(t) => {
          if (t === "profile") router.push("/profile");
          else if (t === "deals") router.push("/deals");
          else {
            setView("list");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
        onFeedback={() => setFeedbackOpen(true)}
        onUpgrade={() => setUpgradeOpen(true)}
        // THE THIRD OCCUPANT OF THE BOTTOM BAND. The centered upgrade pill
        // shares its vertical band with the status FAB, and at 320px their
        // widths met in the middle - a free-plan hunt could not press "Live
        // status". One owner (this page) decides occupancy: while the FAB can
        // mount, the pill yields; it returns the moment the hunt leaves the
        // list view. Pricing stays one tap away in the tab bar throughout.
        showUpgrade={
          !upgradeOpen && !paidPlan && !onboarding && !(vendors.length > 0 && view === "list")
        }
      />
    </main>
  );
}

/* ---- small presentational helpers ---- */

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-lg bg-card2 px-2 py-0.5 text-[11px] font-bold capitalize text-soft">
      {children}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="surface rounded-blob px-2 py-4 text-center">
      <div className="text-[11px] font-extrabold uppercase tracking-wide text-faint">{label}</div>
      <div className={`mt-0.5 text-[28px] leading-none font-extrabold ${accent ? "text-brandblue" : "text-strong"}`}>
        <AnimatedNumber value={value} />
      </div>
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      // WHICH VIEW AM I IN? COLOUR WAS THE ONLY ANSWER.
      //
      // The view switcher and the list-axis switcher are the app's two primary
      // mode controls, and "selected" was conveyed purely by a blue fill. A
      // screen reader announced three identical buttons with no state at all,
      // and so did every high-contrast / forced-colours mode that flattens the
      // fill. `aria-pressed` is the standard answer for a toggle button and
      // costs nothing.
      aria-pressed={active}
      className={`btn flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-extrabold ${
        active ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
      }`}
    >
      {children}
    </button>
  );
}

/* ---- filtering / sorting ---- */

// A shop is ACTIVE when the agent is doing real work on it: an offer is in, a
// message is queued, or it is mid-conversation. Mirrors the Live Status strip's
// buckets (statusGroups) so the counts and the filtered view can never disagree.
function isActiveVendor(v: Vendor): boolean {
  return (
    !!v.offer ||
    !!v.queuedUntil ||
    ["sending", "rfq-sent", "awaiting-response", "negotiating"].includes(v.stage ?? "")
  );
}

function applyFilters(vendors: Vendor[], f: FilterState, days: number): Vendor[] {
  let list = [...vendors];

  // Vehicle class is a HARD scope (a car search must not surface a scooter).
  if (f.vehicleClass !== "any")
    list = list.filter((v) => v.vehicleClasses.includes(f.vehicleClass as any));

  // SOFT attribute filters NEVER evaporate a live negotiation - the user's core
  // expectation is "the view filters," not "my active rentals vanish." Each
  // predicate is OR'd with isActiveVendor so a messaged/queued/offer shop always
  // renders regardless of budget, delivery, rating, tag, open-now or fast toggles.
  const soft = (pred: (v: Vendor) => boolean) =>
    (list = list.filter((v) => isActiveVendor(v) || pred(v)));

  if (f.deliveryOnly) soft((v) => v.fulfillment.includes("hotel-delivery"));
  if (f.fulfillment === "in-store") soft((v) => v.fulfillment.includes("in-store"));
  if (f.openNowOnly) soft((v) => v.openNow !== false);
  if (f.fastOnly) soft((v) => v.fastResponder === true);
  // A VERIFIED TERM IS A HARD FILTER. Routed through soft() it was OR'd with
  // "is this shop live?", so tapping "🛵 Delivers" kept every messaged shop on
  // screen and the list just looked randomly reshuffled - the chip did nothing
  // and said nothing. The chip is now only tappable once at least one shop has
  // actually confirmed the term (Filters.tagCounts), which makes filtering on
  // it an informed choice about real data rather than a shot in the dark.
  if (f.tag && f.tag !== "any") list = list.filter((v) => (v.verifiedTags ?? []).includes(f.tag));
  if (f.minRating > 0) soft((v) => v.rating >= f.minRating);
  // Budget is a HARD filter, not a soft one (B9). Routing it through soft()/
  // isActiveVendor made it a TAUTOLOGY - a priced offer is always "active", so
  // the OR was always true and the budget never removed a single shop, for any
  // input. The user setting a budget explicitly WANTS over-budget quotes gone;
  // a not-yet-priced shop can't be over budget so it stays.
  if (f.maxPricePerDay)
    list = list.filter((v) => !v.offer || v.offer.pricePerDay <= (f.maxPricePerDay as number));

  if (f.agentStatus === "active") list = list.filter(isActiveVendor);
  else if (f.agentStatus === "negotiating")
    // "Negotiating now" = every shop the agent is actively working: message
    // sent, awaiting the reply, or mid-bargain.
    list = list.filter((v) =>
      ["sending", "rfq-sent", "awaiting-response", "negotiating"].includes(v.stage ?? "")
    );
  else if (f.agentStatus === "offer") list = list.filter((v) => v.offer);
  else if (f.agentStatus === "dropped")
    // "Dropped price" means the shop's live quote is BELOW its first/list price
    // (B9). The old `offer.round > 0` tested "replied more than once" - a reply
    // COUNTER, not a price movement - so a shop that restated its same price
    // twice was mislabelled as having dropped it.
    list = list.filter((v) => v.offer && v.offer.pricePerDay < v.offer.listPricePerDay);

  const savingsOf = (v: Vendor) =>
    v.offer ? (v.offer.listPricePerDay - v.offer.pricePerDay) * days : -1;

  list.sort((a, b) => {
    // Paid placements always lead, whatever the sort.
    const sp = (b.sponsored ? 1 : 0) - (a.sponsored ? 1 : 0);
    if (sp !== 0) return sp;
    switch (f.sort) {
      case "rating":
        return b.rating - a.rating;
      case "reviews":
        return (b.reviews ?? 0) - (a.reviews ?? 0);
      case "savings":
        return savingsOf(b) - savingsOf(a);
      case "status":
        return (b.offer ? 1 : 0) - (a.offer ? 1 : 0);
      default:
        // Unknown distance sorts LAST under "Closest", not first (B9): the old
        // `?? 0` made a shop with no distanceKm rank as 0 km = nearest.
        return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
    }
  });
  return list;
}
