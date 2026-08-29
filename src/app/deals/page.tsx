"use client";

// "Trips" (formerly "My deals") - your locked bookings + live search sessions.
// Each session is a living dashboard: who was contacted, who answered, the
// best price on the table, honest savings, what Will plans next and what
// needs the traveller. Think Linear dashboard, not an e-commerce list.

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Icon } from "@/components/icons";
import { WillAvatar } from "@/components/will/WillAvatar";
import { LanguageButton } from "@/components/LanguageButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SiteFooter } from "@/components/SiteFooter";
import { SkeletonCard } from "@/components/Skeleton";
import { useReadiness } from "@/lib/client/readiness";

/** Everything Trips waits on before it stops looking like it is loading. */
const TRIPS_SOURCES = ["session", "trips"] as const;
import { TabBar } from "@/components/TabBar";
import { saveSearch } from "@/lib/client/search-persist";
import { FeedbackModal } from "@/components/FeedbackModal";
import { UpgradeSheet } from "@/components/UpgradeSheet";
import { startNav } from "@/components/NavVeil";
import { LoadingDots } from "@/components/LoadingDots";
import { moneyLocal } from "@/lib/currency";
import { can } from "@/lib/entitlements";
import { partitionHunts } from "@/lib/trips";
import { PLANS } from "@/lib/plans";
import { SEARCH_SESSION_TTL_MS, isSessionFresh } from "@/lib/session-life";
import { useI18n } from "@/lib/i18n";

interface SessionOffer {
  vendorId: string;
  vendorName: string;
  current: number;
  ask: number | null;
  currency: string;
  round: number;
  verified: boolean;
  at: string;
  stale: boolean;
}

interface TimelineEvent {
  at: string;
  kind: "sent" | "reply" | "offer" | "alert" | "booked" | "you";
  vendorName?: string;
  text: string;
  /** English gloss of `text` (local-language sends/replies) - second quiet line. */
  english?: string;
}

interface SessionSummary {
  id: string;
  startedAt: string;
  /** Stable hunt identity from /api/deals - see groupSearchSessions. */
  sid?: number | null;
  isLatest: boolean;
  query: string | null;
  vehicleClass: string | null;
  radiusKm: number | null;
  shopsFound: number;
  status: "booked" | "live" | "waiting" | "wrapped";
  paused: boolean;
  /** The traveller cleared this hunt - restore will refuse, so the list must
   *  not offer a live Re-open that can only 404. */
  closed: boolean;
  contacted: number;
  replied: number;
  waiting: number;
  offers: SessionOffer[];
  best: (SessionOffer & { savedPct: number | null }) | null;
  avgAsk: number | null;
  booking: {
    /** Row id + lifecycle status - what the tap controls PATCH (bookings.ts). */
    id: number | null;
    status: string;
    vendorName: string;
    total: number | null;
    perDay: number | null;
    currency: string;
    scheduledAt: string | null;
    /** Rental length, so an in-progress rental stays in the active section. */
    durationDays: number | null;
    at: string;
  } | null;
  /** THE RENTAL: dates and length. Shipped by /api/deals for every hunt now,
   *  booked or not - it appeared on no card at all before (owner report 5). */
  rental?: {
    durationDays: number | null;
    startDate: string | null;
    returnDate: string | null;
    scheduledAt: string | null;
  } | null;
  attention: string[];
  plannedMoves: { at: string; vendorName: string | null; reason: string }[];
  queuedSends: number;
  timeline: TimelineEvent[];
  progress: number;
  progressLabel: string;
  /** WHERE the hunt ran - so a COLLAPSED card can say so (owner report 5 #17). */
  place?: { lat: number; lng: number; label: string | null } | null;
  /** The deposit the shops asked for, in plain words. */
  depositLabel?: string | null;
  /** How the traveller would get the vehicle. */
  fulfillmentLabel?: string | null;
  answeredNames?: string[];
  silentNames?: string[];
  /** Shops with a FULL deal (price + deposit + pick-up) - the only ones the
   *  re-check may message. Zero is why the button is not offered. */
  recheckable?: number;
  /** What became of this hunt - outcome, cost, saving (lib/trips). */
  trip?: import("@/lib/trips").Trip;
}

/**
 * A session flattened into the shape `partitionHunts` reads. The pick-up and
 * the rental length live under `booking`; lifting them is what lets a rental
 * that is being ridden RIGHT NOW stay at the top even though its hunt finished
 * a week ago - the search ended early precisely because it succeeded.
 */
type HuntRow = SessionSummary & {
  scheduledAt: string | null;
  durationDays: number | null;
};

interface Booking {
  id?: number;
  vendor_name: string;
  price_per_day: number;
  total_price: number;
  currency?: string | null;
  fulfillment: string;
  scheduled_at: string | null;
  status: string;
  created_at: string;
}

function timeAgo(iso: string, t: (s: string) => string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return t("just now");
  if (mins < 60) return `${mins}${t("m ago")}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}${t("h ago")}`;
  const days = Math.round(hrs / 24);
  return `${days}${t("d ago")}`;
}

function timeAt(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * A calendar day, short. A bare `YYYY-MM-DD` is parsed at LOCAL midnight on
 * purpose: `new Date("2026-03-03")` is UTC midnight, which renders as the 2nd
 * for every traveller west of UTC - i.e. exactly the audience.
 */
function fmtDay(iso: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * THE DATES AND THE DURATION, IN ONE LINE - the facts the owner listed for a
 * collapsed card and that appeared on no card at all. `booking.durationDays`
 * was shipped and consumed only by `partitionHunts`; `booking.scheduledAt`
 * rendered only in the separate "Booked earlier" section; and a hunt with no
 * booking carried no duration in the response whatsoever.
 */
function rentalLine(
  r: SessionSummary["rental"],
  t: (s: string) => string
): string | null {
  if (!r) return null;
  const parts: string[] = [];
  if (r.startDate) {
    const from = fmtDay(r.startDate);
    const to = r.returnDate ? fmtDay(r.returnDate) : "";
    parts.push(to && to !== from ? `${from} - ${to}` : from);
  } else if (r.scheduledAt) {
    parts.push(`${t("Pick-up")} ${fmtDay(r.scheduledAt)}`);
  }
  const d = r.durationDays;
  if (d != null && d > 0) parts.push(`${d} ${d === 1 ? t("day") : t("days")}`);
  return parts.length ? parts.join(" · ") : null;
}

const TIMELINE_ICON: Record<TimelineEvent["kind"], string> = {
  sent: "send",
  you: "user",
  reply: "chat",
  offer: "money",
  alert: "alert",
  booked: "check",
};

export default function DealsPage() {
  // Client-side navigation: the tab hop keeps the React tree alive, so the
  // destination paints from cache instead of re-parsing the whole bundle.
  const router = useRouter();
  const { t } = useI18n();
  // READY MEANS EVERY SOURCE HAS ANSWERED. `loading` used to belong to the
  // trips fetch alone, so whichever of the two requests finished first took the
  // placeholder down - and the page looked finished and empty while the rest
  // was still in flight. See lib/client/readiness.
  const { ready, settle } = useReadiness(TRIPS_SOURCES);
  const loading = !ready;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** History stays COLLAPSED by default - that is the whole point of the split. */
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [email, setEmail] = useState<string | undefined>();
  const [plan, setPlan] = useState<string>("free");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreErr, setRestoreErr] = useState<string | null>(null);
  /** The trips read did not answer. Distinct from "answered with nothing". */
  const [loadFailed, setLoadFailed] = useState(false);
  /** How many hunts are SAVED, when the server refuses to ship them (free plan).
   *  The upgrade card names a real number instead of a vague promise. */
  const [huntCount, setHuntCount] = useState(0);
  // "Is that price still good?" - one tap re-asks every shop from a past hunt.
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [recheckNote, setRecheckNote] = useState<Record<string, string>>({});
  // Booking lifecycle taps (bookings.ts doctrine: the traveller is the witness
  // for picked_up/completed, so THEY record it). One in flight at a time.
  const [bookingTap, setBookingTap] = useState<number | null>(null);

  async function tapBookingAction(id: number, action: "picked_up" | "completed") {
    if (bookingTap) return;
    setBookingTap(id);
    try {
      const r = await fetch("/api/bookings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const d = await r.json().catch(() => ({}));
      // The server's answer (or the refusal) is the truth - reflect it locally
      // without a full reload. ok:false means already at/past this status,
      // which renders the same way.
      const next = typeof d?.status === "string" && d.status ? d.status : action;
      setSessions((prev) =>
        prev.map((s) =>
          s.booking?.id === id ? { ...s, booking: { ...s.booking, status: next } } : s
        )
      );
      setBookings((prev) => prev.map((b) => (b.id === id ? { ...b, status: next } : b)));
    } catch {
      /* the next poll shows the durable state */
    } finally {
      setBookingTap(null);
    }
  }

  async function recheckPrices(startedAt: string, sid?: number | null) {
    if (rechecking) return;
    setRechecking(startedAt);
    setRecheckNote((n) => ({ ...n, [startedAt]: "" }));
    try {
      const r = await fetch("/api/deals/recheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts: startedAt, sid }),
      });
      const d = await r.json().catch(() => ({}));
      // THE ENTITLEMENT ANSWER IS NOT AN ERROR MESSAGE. Re-engaging a past
      // hunt is `trips-history`, and the route now says so with a 402 - which
      // belongs in the upgrade sheet, not in red text under a button.
      if (r.status === 402 || d?.error === "upgrade-required") {
        setUpgradeOpen(true);
        return;
      }
      if (!r.ok) {
        setRecheckNote((n) => ({
          ...n,
          [startedAt]: d?.error || t("Could not reach your shops just now. Try again."),
        }));
        return;
      }
      const asked = Number(d?.asked ?? 0);
      const skipped = Number(d?.skipped ?? 0);
      const eligible = Number(d?.eligible ?? 0);
      // THE ROUTE'S OWN WORDS WIN WHEN IT DECLINED TO ASK ANYONE.
      //
      // The route answers HTTP 200 with an `error` string for the two "nothing
      // to do" cases, so `!r.ok` never fired and the client invented its own
      // reason from the counters - which could contradict the route outright
      // ("no shops were messaged" vs "none gave a full deal") about the same
      // hunt the card had just offered a re-ask for.
      if (asked === 0 && typeof d?.error === "string" && d.error) {
        setRecheckNote((n) => ({ ...n, [startedAt]: t(d.error) }));
        return;
      }
      setRecheckNote((n) => ({
        ...n,
        [startedAt]:
          asked > 0
            ? `${t("Asking")} ${asked} ${asked === 1 ? t("shop") : t("shops")} - ${t("their answers land in this hunt.")}`
            : skipped > 0
              ? t("Already asked these shops today - give them a chance to answer.")
              : eligible === 0
                ? // The owner's rule, said out loud: no price + deposit +
                  // pick-up means there are no "same conditions" to re-confirm.
                  t("None of these shops gave a full deal (price, deposit and pick-up), so there is nothing to re-confirm.")
                : t("No shops from this hunt can be messaged right now."),
      }));
    } catch {
      setRecheckNote((n) => ({
        ...n,
        [startedAt]: t("Could not reach your shops just now. Try again."),
      }));
    } finally {
      setRechecking(null);
    }
  }

  const canHistory = can(plan, "trips-history");

  // Re-open a past hunt: pull its shops + RFQ from the server, write the same
  // sessionStorage payload a live search uses, then navigate home where the
  // existing rehydrate path renders the full Find-Deals workspace.
  async function restoreSession(startedAt: string, isLatest: boolean, sid?: number | null) {
    if (restoring) return;
    setRestoreErr(null);
    setRestoring(startedAt);
    try {
      // `sid` is the hunt's row id and is what the route matches on now; `ts`
      // stays in the URL so a server that has not been redeployed yet still
      // understands the request.
      const r = await fetch(
        `/api/deals/restore?ts=${encodeURIComponent(startedAt)}` +
          (sid != null ? `&sid=${sid}` : ""),
        {
          cache: "no-store",
        }
      );
      const d = await r.json().catch(() => ({}));
      if (r.status === 402 || d?.error === "upgrade-required") {
        setRestoring(null);
        setUpgradeOpen(true);
        return;
      }
      // A cleared hunt is a DIFFERENT answer from a failed read. Collapsing
      // this 404 into "Try again" told the traveller to retry an action the
      // server will refuse forever - the honest copy names what happened.
      if (d?.error === "session-closed") {
        setRestoring(null);
        setRestoreErr(t("You cleared this hunt - it stays in your history, but the agents are done with it."));
        return;
      }
      if (!r.ok || !d?.payload) {
        setRestoring(null);
        setRestoreErr(t("Could not re-open that hunt. Try again."));
        return;
      }
      // A DELIBERATE RE-OPEN MUST SURVIVE THE FRESHNESS GUARD.
      //
      // The Find-deals screen deletes any `wd_search` blob whose `searchEpoch`
      // is past SEARCH_SESSION_TTL_MS - which is every hunt in the "Earlier
      // hunts" drawer, by construction. The server stamps a fresh epoch for a
      // re-open now (`reopenEpoch`), and this is the belt to that braces: a
      // server that has not been redeployed yet still sends the hunt's original
      // start, and the traveller would land on a blank search screen with no
      // error. Moving the epoch FORWARD is the strict direction - it is what
      // keeps an ancient `since=` off the live polls, which is the one thing
      // the TTL exists to prevent.
      const payload = { ...d.payload } as { vendors: unknown[] } & Record<string, unknown>;
      if (!isSessionFresh(Number(payload.searchEpoch), Date.now(), SEARCH_SESSION_TTL_MS)) {
        payload.huntStartedAt = payload.huntStartedAt ?? startedAt;
        payload.searchEpoch = Date.now();
        payload.reopened = true;
      }
      // THE SAME BUDGET LADDER THE LIVE SEARCH USES. A raw setItem here threw
      // on a big restored hunt and the `catch` swallowed it, so the traveller
      // was navigated home to an EMPTY workspace with no error - the one
      // failure mode this ladder exists to prevent. saveSearch sheds galleries,
      // then message bodies, until the write lands.
      const saved = saveSearch(sessionStorage, "wd_search", payload);
      if (!saved.ok) {
        setRestoring(null);
        setRestoreErr(t("That hunt is too big to hold on this device."));
        return;
      }
      startNav();
      router.push("/");
    } catch {
      setRestoring(null);
      setRestoreErr(t("Could not re-open that hunt. Try again."));
    }
  }

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!d.session) {
          window.location.href = "/login";
          return;
        }
        setEmail(d.session.email);
        setPlan(d.session.plan ?? "free");
      })
      .catch(() => {})
      .finally(() => settle("session"));
    const loadTrips = (first: boolean) =>
      fetch("/api/deals", { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((d) => {
          const s: SessionSummary[] = d.sessions ?? [];
          setSessions(s);
          setBookings(d.bookings ?? []);
          setHuntCount(Number(d.huntCount ?? s.length) || 0);
          setLoadFailed(false);
          // The freshest hunt opens expanded - it's what you came to check.
          // First load only: a refresh must not fight the traveller's own
          // expand/collapse choices.
          if (first && s[0]) setExpanded({ [s[0].id]: true });
        })
        // M1 - A FAILED LOAD IS NOT AN EMPTY ONE.
        //
        // This catch was silent, so a 500 or a dropped connection left
        // `sessions` at [] and the page rendered "No hunts yet - and I'm
        // ready" to a traveller who had run ten searches. That is the same
        // defect as the fail-green admin panels, except it is pointed at the
        // user: the app states as fact something it never checked, and the
        // traveller's reasonable conclusion is that their trips are gone.
        .catch(() => {
          if (first) setLoadFailed(true); // a failed refresh keeps last-good data
        })
        .finally(() => settle("trips"));
    void loadTrips(true);
    // A TRIP PAGE THAT LOADED ONCE IS A SNAPSHOT, NOT A STATUS (D7). Offers
    // land while the phone is in a pocket; coming back to a stale "waiting"
    // is the same lie as the frozen card. Refetch when the tab regains focus
    // or visibility, and every 60s while it stays visible - the sessions
    // themselves say when nothing is live anymore, and the fetch is cheap.
    const refresh = () => {
      if (document.visibilityState === "visible") void loadTrips(false);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const tick = setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(tick);
    };
  }, [settle]);

  const vehicleLabel = (v: string | null) =>
    v === "car"
      ? t("Car")
      : v === "motorbike"
        ? t("Motorbike")
        : v === "scooter"
          ? t("Scooter")
          : t("Vehicle");

  // Only what the traveller can SEE is counted. A free plan showing a lifetime
  // total that includes trips it is hiding would be quietly using locked data to
  // sell the unlock - the honest version says how many trips the figure covers.
  //
  // AND IT SUMS A TRIP TOTAL, NOT A DAILY RATE. This read `tr.saved` when that
  // field was the PER-DAY gap, and captioned the sum "saved across N trips" -
  // so a six-day rental haggled down 50 a day reported 50 instead of 300. The
  // headline number on the Trips screen was simply wrong, and wrong in the
  // direction that undersells the one thing the product does. `saved` is now
  // the whole-rental figure and is null when the duration is unknown, so a trip
  // that cannot be totalled is left out of the count rather than guessed at.
  const heroStats = useMemo(() => {
    const visible = sessions.filter((s) => canHistory || s.isLatest);
    let saved = 0;
    let currency = "";
    let counted = 0;
    let contacted = 0;
    let booked = 0;
    for (const s of visible) {
      contacted += s.contacted || 0;
      if (s.booking) booked += 1;
      const tr = s.trip;
      if (tr?.saved && tr.saved > 0) {
        // Mixed currencies cannot be added. The dominant one wins and the rest
        // are left out rather than silently summed into a wrong number.
        if (!currency) currency = tr.currency;
        if (tr.currency === currency) {
          saved += tr.saved;
          counted += 1;
        }
      }
    }
    return { saved, currency, counted, contacted, booked, visible: visible.length };
  }, [sessions, canHistory]);

  // LIVE WORK ON TOP, HISTORY FOLDED AWAY. The pick-up and the rental length
  // are lifted out of `booking` so a rental being ridden right now counts as
  // active even though its hunt finished days ago. Order within each half is
  // the server's (newest first) - the split re-groups, it never re-sorts.
  const { active, archive } = useMemo(() => {
    const rows: HuntRow[] = sessions.map((s) => ({
      ...s,
      scheduledAt: s.booking?.scheduledAt ?? null,
      durationDays: s.booking?.durationDays ?? null,
    }));
    return partitionHunts(rows, Date.now(), SEARCH_SESSION_TTL_MS);
  }, [sessions]);

  const savingsHeadline = useMemo(() => {
    if (heroStats.saved > 0 && heroStats.currency) {
      return {
        amount: moneyLocal(heroStats.saved, heroStats.currency),
        note:
          heroStats.counted === 1
            ? t("saved on your last trip")
            : `${t("saved across")} ${heroStats.counted} ${t("trips")}`,
      };
    }
    return { amount: "-", note: t("your first saving lands here") };
  }, [heroStats, t]);

  const statusPill = (s: SessionSummary) => {
    if (s.status === "booked")
      return (
        <span className="flex items-center gap-1 rounded-full bg-savings-soft px-2.5 py-1 text-[10px] font-extrabold text-savings">
          <Icon name="check" className="h-3 w-3" /> {t("Booked")}
        </span>
      );
    if (s.paused)
      return (
        <span className="flex items-center gap-1 rounded-full bg-brandyellow-soft px-2.5 py-1 text-[10px] font-extrabold text-warn">
          <Icon name="pause" className="h-3 w-3" /> {t("Paused")}
        </span>
      );
    if (s.status === "live")
      return (
        <span className="flex items-center gap-1 rounded-full bg-brandblue-soft px-2.5 py-1 text-[10px] font-extrabold text-brandblue">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brandblue opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-brandblue" />
          </span>
          {t("Live")}
        </span>
      );
    if (s.status === "waiting")
      return (
        <span className="flex items-center gap-1 rounded-full bg-card2 px-2.5 py-1 text-[10px] font-extrabold text-soft">
          <Icon name="clock" className="h-3 w-3" /> {t("Waiting on shops")}
        </span>
      );
    return (
      <span className="rounded-full bg-card2 px-2.5 py-1 text-[10px] font-extrabold text-faint">
        {t("Wrapped up")}
      </span>
    );
  };

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md pb-32 sm:max-w-lg md:max-w-2xl">
      <div className="topbar">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 pb-2.5 sm:max-w-lg md:max-w-2xl">
          <div className="flex items-center gap-2">
            <BrandMark size={30} />
            <h1 className="font-display text-lg font-extrabold text-strong">
              {t("Searches & hunts")}
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            <ThemeToggle />
            <LanguageButton />
            <a href="/" className="btn btn-sm btn-ghost rounded-xl px-3 py-1.5 text-[12px]">
              ← {t("Search")}
            </a>
          </div>
        </div>
      </div>

      <div className="space-y-4 px-4 pt-4">
        {/* THE HERO - what all of this was FOR.
            A list of hunts is a log; the number at the top is the product. It
            is computed from the trips the traveller can actually see, so a free
            plan's figure is honest about being partial rather than quietly
            counting trips it is hiding behind a lock. */}
        {/* TRIPS IS A PRO/ULTRA SECTION (owner report 5 #17), and a free
            traveller is told so in the UI rather than being handed a redacted
            list. The upgrade path is the EXISTING sheet - no second sheet. */}
        {!loading && !canHistory && (
          <TripsUpgradeGate hunts={huntCount} onUpgrade={() => setUpgradeOpen(true)} />
        )}

        {!loading && canHistory && (sessions.length > 0 || bookings.length > 0) && (
          <section className="glass-solid glass-rim fluid-in relative overflow-hidden rounded-blob p-5">
            <div className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-brandblue-soft opacity-60 blur-2xl" />
            <div className="pointer-events-none absolute -bottom-16 -left-8 h-36 w-36 rounded-full bg-savings-soft opacity-50 blur-2xl" />
            <p className="relative text-[10px] font-extrabold uppercase tracking-[0.14em] text-faint">
              {t("Your travel savings")}
            </p>
            <div className="relative mt-1 flex items-end gap-2">
              <span className="font-display text-[38px] font-extrabold leading-none text-savings">
                {savingsHeadline.amount}
              </span>
              <span className="mb-1.5 text-[12px] font-extrabold text-soft">
                {savingsHeadline.note}
              </span>
            </div>
            <div className="relative mt-3 grid grid-cols-3 gap-2">
              {[
                { k: t("Hunts"), v: String(sessions.length) },
                { k: t("Shops reached"), v: String(heroStats.contacted) },
                { k: t("Booked"), v: String(heroStats.booked) },
              ].map((c) => (
                <div key={c.k} className="rounded-2xl bg-card2/70 px-2.5 py-2 text-center">
                  <div className="text-[16px] font-extrabold text-strong">{c.v}</div>
                  <div className="text-[9px] font-extrabold uppercase tracking-wide text-faint">
                    {c.k}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {loading && (
          <>
            <SkeletonCard lines={4} />
            <SkeletonCard lines={3} />
          </>
        )}

        {/* COULD NOT LOAD - said plainly, with the one action that helps.
            This has to render INSTEAD of the empty state, not beside it: two
            cards, one saying "you have no trips" and one saying "we could not
            check", is worse than either alone. */}
        {!loading && canHistory && loadFailed && (
          <div className="glass-solid glass-rim fluid-in rounded-blob p-6 text-center">
            <div className="text-[15px] font-extrabold text-strong">
              {t("Couldn't load your trips")}
            </div>
            <p className="mx-auto mt-1 max-w-[300px] text-[12px] text-soft">
              {t("Nothing is lost - we just couldn't reach the server. Check your connection and try again.")}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="btn btn-primary mt-4 inline-block rounded-2xl px-6 py-3 text-[14px]"
            >
              {t("Try again")}
            </button>
          </div>
        )}

        {!loading && canHistory && !loadFailed && sessions.length === 0 && bookings.length === 0 && (
          <div className="glass-solid glass-rim rounded-blob p-6 text-center fluid-in">
            <div className="mx-auto mb-3 w-fit float-soft">
              <WillAvatar size={64} />
            </div>
            <div className="text-[15px] font-extrabold text-strong">
              {t("No hunts yet - and I'm ready")}
            </div>
            <p className="mx-auto mt-1 max-w-[300px] text-[12px] text-soft">
              {t("Tell me what you want to ride and where you're staying. I'll find nearby shops and haggle the price down while you do literally anything else.")}
            </p>
            <a
              href="/"
              onClick={() => startNav()}
              className="btn btn-primary cta-sheen mt-4 inline-block rounded-2xl px-6 py-3 text-[14px]"
            >
              {t("Start my first hunt")}
            </a>
          </div>
        )}

        {/* ONE CARD SHAPE FOR EVERYTHING WAS THE PROBLEM (W-2b).

            A hunt with shops answering right now and a hunt that died three
            weeks ago got the same 480-line dashboard, the same expand chevron,
            the same "what happens next" panel. So the screen grew linearly with
            use, and the one thing a traveller opens Trips for - what is
            happening with my rental - sank further down the page every week.

            The split asks one question per hunt: can anything still change
            here? See partitionHunts. The card itself is unchanged and shared,
            because an archived hunt that renders differently is a second
            component to keep true. */}
        {!loading &&
          canHistory &&
          (() => {
            const renderSession = (s: HuntRow) => {
              const open = Boolean(expanded[s.id]);
              // W6.1 - THE GATE MOVED OUT OF THE CARD.
              //
              // This used to render a locked PREVIEW for every non-latest hunt
              // on a free plan (previewTrip redacted the numbers, a frosted
              // pane sat over them). The owner asked for the opposite: Trips is
              // a Pro/Ultra section, and free travellers get real upgrade tier
              // cards that say so. So a card that renders here is a card the
              // traveller is entitled to see in full - see TripsUpgradeGate.
              const trip = s.trip;
              return (
                <section key={s.id} className="glass-solid glass-rim overflow-hidden rounded-blob fluid-in">
                  {/* Header - always visible, tap to expand */}
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [s.id]: !open }))}
                    className="block w-full p-3.5 text-left"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brandblue-soft text-brandblue">
                          <Icon name={s.vehicleClass === "car" ? "car" : "bike"} className="h-5 w-5" />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-[14px] font-extrabold text-strong">
                            {vehicleLabel(s.vehicleClass)} {t("hunt")}
                            {s.radiusKm ? ` · ${s.radiusKm}km` : ""}
                          </div>
                          {/* WHAT BECAME OF THIS TRIP - the line a traveller
                              recognises their own hunt by. A session could only
                              say what was happening right now, so a finished trip
                              looked exactly like an abandoned one. */}
                          {trip && (
                            <div className="truncate text-[11.5px] font-bold text-soft">
                              {trip.headline}
                              {trip.perDay != null
                                ? ` · ${moneyLocal(trip.perDay, trip.currency)}/${t("day")}`
                                : ""}
                              {trip.savedPct != null ? ` · ${t("saved")} ${trip.savedPct}%` : ""}
                            </div>
                          )}
                          {/* WHERE IT HAPPENED. /api/deals never selected lat,
                              lng or any place label, so no card - collapsed or
                              open - could say where a hunt ran. It is the first
                              thing a traveller recognises a trip by. */}
                          {s.place?.label && (
                            <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] font-bold text-soft">
                              <Icon name="pin" className="h-3 w-3 shrink-0 text-faint" />
                              <span className="truncate">
                                <bdi dir="auto">{s.place.label}</bdi>
                              </span>
                            </div>
                          )}
                          {/* WHEN THE RENTAL IS FOR, AND FOR HOW LONG. */}
                          {rentalLine(s.rental, t) && (
                            <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] font-bold text-soft">
                              <Icon name="clock" className="h-3 w-3 shrink-0 text-faint" />
                              <span className="truncate">{rentalLine(s.rental, t)}</span>
                            </div>
                          )}
                          {/* ...and WHEN THE HUNT RAN. "3d ago" is a duration,
                              not a date: a traveller looking back at a trip
                              wants the day it happened on. */}
                          <div className="mt-0.5 truncate text-[11px] text-faint">
                            {s.query ? `"${s.query}"` : `${s.shopsFound} ${t("shops found")}`} ·{" "}
                            {fmtDay(s.startedAt)} · {timeAgo(s.startedAt, t)}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {statusPill(s)}
                        <Icon
                          name="chevron"
                          className={`h-4 w-4 text-faint transition-transform ${open ? "rotate-90" : ""}`}
                        />
                      </div>
                    </div>

                    {/* THE COLLAPSED CARD CARRIES THE HUNT (owner report 5 #17).
                        "Even when a history hunt card is collapsed we still show
                        the location, best price from the hunt, details about the
                        search session, how many answered, who didn't answer,
                        deposit and every other detail we have." All of this was
                        computed and shipped already, and rendered ONLY inside
                        the `open &&` branch - i.e. on the one card the traveller
                        had tapped, and on no other. */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {s.best && (
                        <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[10.5px] font-extrabold text-savings">
                          {t("Best")}: {moneyLocal(s.best.current, s.best.currency)}/{t("day")}
                          {s.best.savedPct != null && s.best.savedPct > 0
                            ? ` (−${s.best.savedPct}%)`
                            : ""}
                        </span>
                      )}
                      <span className="rounded-full bg-card2 px-2 py-0.5 text-[10.5px] font-bold text-soft">
                        {s.replied}/{s.contacted} {t("answered")}
                      </span>
                      {s.waiting > 0 && (
                        <span className="rounded-full bg-card2 px-2 py-0.5 text-[10.5px] font-bold text-faint">
                          {s.waiting} {t("never answered")}
                        </span>
                      )}
                      {s.depositLabel && (
                        <span className="rounded-full bg-card2 px-2 py-0.5 text-[10.5px] font-bold text-soft">
                          {t("Deposit")}: {s.depositLabel}
                        </span>
                      )}
                      {s.fulfillmentLabel && (
                        <span className="rounded-full bg-card2 px-2 py-0.5 text-[10.5px] font-bold text-soft">
                          {s.fulfillmentLabel}
                        </span>
                      )}
                      {s.booking && (
                        <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[10.5px] font-extrabold text-savings">
                          {t("Booked")}: {s.booking.vendorName}
                        </span>
                      )}
                    </div>
                    {(s.answeredNames?.length || s.silentNames?.length) && (
                      <div className="mt-1.5 space-y-0.5">
                        {s.answeredNames && s.answeredNames.length > 0 && (
                          <div className="truncate text-[10.5px] font-bold text-soft">
                            {t("Answered")}: {s.answeredNames.join(", ")}
                          </div>
                        )}
                        {s.silentNames && s.silentNames.length > 0 && (
                          <div className="truncate text-[10.5px] text-faint">
                            {t("No reply")}: {s.silentNames.join(", ")}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Progress - the one line users actually care about */}
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-[10px] font-bold">
                        <span className="text-soft">{t(s.progressLabel)}</span>
                        <span className="tabular-nums text-faint">{s.progress}%</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-card2">
                        <div
                          className={`h-full rounded-full transition-all duration-700 ${
                            s.status === "booked" ? "bg-savings" : "bg-brandblue"
                          }`}
                          style={{ width: `${s.progress}%` }}
                        />
                      </div>
                    </div>
                  </button>

                  {open && (
                    <div className="space-y-3 px-3.5 pb-3.5">
                      {/* Stat trio */}
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { n: s.contacted, label: t("contacted") },
                          { n: s.replied, label: t("replied") },
                          { n: s.waiting, label: t("waiting") },
                        ].map((st) => (
                          <div key={st.label} className="rounded-2xl bg-card2 p-2.5 text-center">
                            <div className="font-accent text-[18px] font-extrabold text-strong">
                              {st.n}
                            </div>
                            <div className="text-[10px] font-bold text-faint">{st.label}</div>
                          </div>
                        ))}
                      </div>

                      {/* Booked - the crown */}
                      {s.booking && (
                        <div className="rounded-2xl bg-savings-soft p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wide text-savings">
                                <Icon name="check" className="h-3.5 w-3.5" /> {t("Locked in")}
                              </div>
                              <div className="mt-0.5 truncate text-[14px] font-extrabold text-strong">
                                {s.booking.vendorName}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              {s.booking.total != null && (
                                <div className="text-[16px] font-extrabold text-strong">
                                  {moneyLocal(s.booking.total, s.booking.currency)}
                                </div>
                              )}
                              {s.booking.perDay != null && (
                                <div className="text-[10px] font-bold text-faint">
                                  {moneyLocal(s.booking.perDay, s.booking.currency)}/{t("day")}
                                </div>
                              )}
                            </div>
                          </div>
                          {/* Lifecycle taps - the traveller is the witness the
                              funnel trusts for picked_up/completed. */}
                          {s.booking.id != null && s.booking.status !== "completed" &&
                            s.booking.status !== "cancelled" && s.booking.status !== "no_show" && (
                            <div className="mt-2">
                              {s.booking.status === "picked_up" ? (
                                <button
                                  onClick={() => tapBookingAction(s.booking!.id!, "completed")}
                                  disabled={bookingTap != null}
                                  className="w-full rounded-xl bg-savings px-3 py-2 text-[12px] font-extrabold text-white disabled:opacity-60"
                                >
                                  {t("Trip completed - I returned it")}
                                </button>
                              ) : (
                                <button
                                  onClick={() => tapBookingAction(s.booking!.id!, "picked_up")}
                                  disabled={bookingTap != null}
                                  className="w-full rounded-xl bg-card2 px-3 py-2 text-[12px] font-extrabold text-strong disabled:opacity-60"
                                >
                                  {t("I picked it up")}
                                </button>
                              )}
                            </div>
                          )}
                          {s.booking.status === "completed" && (
                            <div className="mt-2 rounded-xl bg-card2 px-3 py-2 text-center text-[11px] font-extrabold text-savings">
                              {t("Trip completed")}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Best offer on the table */}
                      {!s.booking && s.best && (
                        <div className="rounded-2xl border border-brandblue/25 bg-brandblue-soft/60 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[10px] font-extrabold uppercase tracking-wide text-brandblue">
                                {t("Best on the table")}
                              </div>
                              <div className="mt-0.5 truncate text-[14px] font-extrabold text-strong">
                                {s.best.vendorName}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                {s.best.verified ? (
                                  <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[10px] font-extrabold text-savings">
                                    {t("Confirmed by the shop")}
                                  </span>
                                ) : (
                                  <span className="rounded-full bg-card2 px-2 py-0.5 text-[10px] font-extrabold text-faint">
                                    {t("Unconfirmed")}
                                  </span>
                                )}
                                {s.best.round > 0 && (
                                  <span className="rounded-full bg-card2 px-2 py-0.5 text-[10px] font-extrabold text-soft">
                                    {t("After")} {s.best.round}{" "}
                                    {s.best.round === 1 ? t("round") : t("rounds")}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-[18px] font-extrabold text-strong">
                                {moneyLocal(s.best.current, s.best.currency)}
                              </div>
                              <div className="text-[10px] font-bold text-faint">/{t("day")}</div>
                              {s.best.savedPct != null && s.best.savedPct > 0 && (
                                <div className="mt-0.5 rounded-full bg-savings-soft px-2 py-0.5 text-[10px] font-extrabold text-savings">
                                  −{s.best.savedPct}% {t("off asking")}
                                </div>
                              )}
                            </div>
                          </div>
                          {s.avgAsk != null && s.avgAsk > s.best.current && (
                            <div className="mt-2 text-[11px] font-bold text-soft">
                              {t("Average asking price nearby")}:{" "}
                              <span className="line-through opacity-70">
                                {moneyLocal(s.avgAsk, s.best.currency)}
                              </span>{" "}
                              → {t("yours")}: {moneyLocal(s.best.current, s.best.currency)}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Needs you */}
                      {s.attention.length > 0 && (
                        <div className="rounded-2xl bg-brandred-soft p-3">
                          <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wide text-brandred">
                            <Icon name="bell" className="h-3.5 w-3.5" /> {t("Needs you")}
                          </div>
                          <ul className="mt-1 space-y-1">
                            {s.attention.map((a, i) => (
                              <li key={i} className="text-[11px] font-bold leading-snug text-strong">
                                · {a}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Will's planned moves */}
                      {(s.plannedMoves.length > 0 || s.queuedSends > 0) && (
                        <div className="rounded-2xl bg-card2 p-3">
                          <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wide text-soft">
                            <Icon name="sparkles" className="h-3.5 w-3.5" /> {t("Will's next moves")}
                          </div>
                          <ul className="mt-1 space-y-1 text-[11px] font-bold leading-snug text-soft">
                            {s.queuedSends > 0 && (
                              <li>
                                · {s.queuedSends}{" "}
                                {s.queuedSends === 1
                                  ? t("message queued - it sends the moment the shop opens")
                                  : t("messages queued - they send the moment shops open")}
                              </li>
                            )}
                            {s.plannedMoves.map((m, i) => (
                              <li key={i}>
                                · {m.vendorName ? `${m.vendorName}: ` : ""}
                                {m.reason} ({timeAt(m.at)})
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* All offers, cheapest first */}
                      {s.offers.length > 1 && (
                        <div>
                          <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-wide text-faint">
                            {t("Every offer in this hunt")}
                          </div>
                          <div className="space-y-1.5">
                            {s.offers.map((o) => (
                              <div
                                key={o.vendorId + o.at}
                                className="flex items-center justify-between gap-2 rounded-xl bg-card2 px-3 py-2"
                              >
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span
                                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                      o.verified ? "bg-savings" : "bg-faint"
                                    }`}
                                  />
                                  <span className="truncate text-[12px] font-bold text-strong">
                                    {o.vendorName}
                                  </span>
                                  {o.stale && (
                                    <Icon name="clock" className="h-3 w-3 shrink-0 text-brandyellow" />
                                  )}
                                </div>
                                <div className="font-accent shrink-0 text-[12px] font-extrabold text-strong">
                                  {moneyLocal(o.current, o.currency)}
                                  <span className="text-[10px] font-bold text-faint">/{t("day")}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Mini timeline */}
                      {s.timeline.length > 0 && (
                        <div>
                          <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-wide text-faint">
                            {t("Latest moves")}
                          </div>
                          <div className="space-y-1.5">
                            {s.timeline.map((e, i) => (
                              <div key={i} className="flex items-start gap-2">
                                <span
                                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                                    e.kind === "alert"
                                      ? "bg-brandred-soft text-brandred"
                                      : e.kind === "offer" || e.kind === "booked"
                                        ? "bg-savings-soft text-savings"
                                        : "bg-card2 text-faint"
                                  }`}
                                >
                                  <Icon name={TIMELINE_ICON[e.kind]} className="h-3 w-3" />
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[11px] font-bold leading-tight text-soft">
                                    {e.vendorName ? `${e.vendorName}: ` : ""}
                                    {e.text}
                                  </div>
                                  {/* English gloss of a local-language line -
                                      real words first, translation second
                                      (W1.5, the same rule everywhere). */}
                                  {e.english && e.english.trim() !== e.text.trim() && (
                                    <div className="truncate text-[10px] italic leading-tight text-faint">
                                      🌐 {e.english}
                                    </div>
                                  )}
                                  <div className="text-[10px] text-faint">{timeAgo(e.at, t)}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Actions - Open re-opens the hunt's full workspace. The
                          latest hunt is always free; earlier ones need trip
                          history (Pro), which surfaces the upgrade sheet. */}
                      <div className="flex flex-col gap-1.5 pt-0.5">
                        {/* A CLEARED HUNT GETS NO LIVE BUTTON. Restore refuses
                            these with a 404, so offering Re-open (or "Open live
                            workspace" - there is no live workspace) is a button
                            that can only fail. Checked FIRST: the newest hunt
                            can be the cleared one. */}
                        {s.closed ? (
                          <p className="rounded-2xl bg-card2 px-3 py-2.5 text-center text-[11.5px] font-bold text-faint">
                            {t("You cleared this hunt - it stays here as history.")}
                          </p>
                        ) : s.isLatest ? (
                          <a
                            href="/"
                            onClick={() => startNav()}
                            className="btn btn-primary flex-1 rounded-2xl py-2.5 text-center text-[13px]"
                          >
                            {t("Open live workspace")}
                          </a>
                        ) : (
                          // No `canHistory` branch here any more: the whole list
                          // renders only for Pro/Ultra, so a card on screen is a
                          // card the traveller may re-open. A free plan meets the
                          // gate once, up front, instead of on every row.
                          <button
                            onClick={() => restoreSession(s.startedAt, false, s.sid)}
                            disabled={restoring === s.startedAt}
                            className="btn btn-primary flex flex-1 items-center justify-center gap-2 rounded-2xl py-2.5 text-center text-[13px] disabled:opacity-70"
                          >
                            {restoring === s.startedAt ? (
                              <>
                                <LoadingDots light />
                                {t("Re-opening…")}
                              </>
                            ) : (
                              t("Re-open this hunt")
                            )}
                          </button>
                        )}
                        {restoreErr && restoring === null && (
                          <p className="text-center text-[10px] font-bold text-brandred">{restoreErr}</p>
                        )}

                        {/* THE QUESTION A PAST TRIP IS ACTUALLY FOR.
                            Re-opening an old hunt showed prices frozen at
                            whatever the shop said last time - useful only if you
                            then message ten shops by hand to find out whether any
                            of it still stands. One tap asks all of them, with
                            each shop's own deal read back to them.

                            OFFERED ONLY WHERE THERE IS A DEAL TO RE-CONFIRM.
                            The condition used to be `contacted > 0`, so the
                            button appeared for a hunt where nobody had ever
                            answered - and the route then messaged every one of
                            those silent shops. The owner's rule is price +
                            deposit + how you get the vehicle, and `recheckable`
                            is that count (server-side, same predicate). */}
                        {(s.recheckable ?? 0) > 0 && !s.closed ? (
                          <button
                            onClick={() => recheckPrices(s.startedAt, s.sid)}
                            disabled={rechecking === s.startedAt}
                            className="btn btn-ghost flex items-center justify-center gap-1.5 rounded-2xl border-2 border-savings/50 py-2.5 text-[12.5px] font-extrabold text-savings disabled:opacity-70"
                          >
                            {rechecking === s.startedAt ? (
                              <>
                                <LoadingDots />
                                {t("Asking your shops…")}
                              </>
                            ) : (
                              <>
                                <Icon name="whatsapp" className="h-3.5 w-3.5" />
                                {t("Ask if these deals still stand")} ({s.recheckable})
                              </>
                            )}
                          </button>
                        ) : (
                          s.contacted > 0 &&
                          !s.closed && (
                            <p className="rounded-2xl bg-card2 px-3 py-2 text-center text-[11px] font-bold text-faint">
                              {t("No shop here gave a full deal (price, deposit and pick-up), so there is nothing to re-confirm.")}
                            </p>
                          )
                        )}
                        {recheckNote[s.startedAt] && (
                          <p className="text-center text-[10.5px] font-bold text-soft">
                            {recheckNote[s.startedAt]}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              );
            };
            return (
              <>
                {active.map(renderSession)}

                {archive.length > 0 && (
                  <section className="fluid-in">
                    <button
                      onClick={() => setArchiveOpen((o) => !o)}
                      className="flex w-full items-center justify-between gap-2 rounded-2xl bg-card2/60 px-3.5 py-2.5 text-left"
                    >
                      <span className="flex items-center gap-1.5 text-[12.5px] font-extrabold text-soft">
                        <Icon name="clock" className="h-3.5 w-3.5 text-faint" />
                        {t("Earlier hunts")}
                        <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] font-extrabold text-faint">
                          {archive.length}
                        </span>
                      </span>
                      <Icon
                        name="chevron"
                        className={`h-4 w-4 shrink-0 text-faint transition-transform ${
                          archiveOpen ? "rotate-90" : ""
                        }`}
                      />
                    </button>
                    {archiveOpen && (
                      <div className="mt-3 space-y-4">{archive.map(renderSession)}</div>
                    )}
                  </section>
                )}
              </>
            );
          })()}


        {/* Older bookings that predate the recent sessions */}
        {!loading &&
          canHistory &&
          (() => {
            const shown = new Set(
              sessions.filter((s) => s.booking).map((s) => s.booking!.at)
            );
            const rest = bookings.filter((b) => !shown.has(b.created_at));
            if (rest.length === 0) return null;
            return (
              <section className="fluid-in">
                <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-strong">
                  <Icon name="check" className="h-4 w-4 text-savings" /> {t("Booked earlier")}
                </div>
                <div className="space-y-2.5">
                  {rest.map((b, i) => (
                    <div key={b.id ?? i} className="glass-solid glass-rim rounded-blob p-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[14px] font-extrabold text-strong">
                            {b.vendor_name}
                          </div>
                          <div className="mt-0.5 text-[11px] text-soft">
                            {b.scheduled_at
                              ? `${t("Pick-up")}: ${b.scheduled_at.replace("T", " · ")}`
                              : t("Pick-up time agreed in chat")}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[15px] font-extrabold text-strong">
                            {moneyLocal(b.total_price, b.currency ?? "USD")}
                          </div>
                          <div className="text-[10px] font-bold text-faint">
                            {moneyLocal(b.price_per_day, b.currency ?? "USD")}/{t("day")}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}

        {!loading && <SiteFooter />}
      </div>

      {/* The floating Will widget was removed (R4) - Will is now an integrated
          inline guide on the Find-deals funnel, not a disruptive edge widget. */}

      {feedbackOpen && <FeedbackModal email={email} onClose={() => setFeedbackOpen(false)} />}
      {upgradeOpen && <UpgradeSheet onClose={() => setUpgradeOpen(false)} />}

      <TabBar
        active="deals"
        onSelect={(tab) => {
          if (tab === "home") router.push("/");
          else if (tab === "profile") router.push("/profile");
        }}
        onFeedback={() => setFeedbackOpen(true)}
        onUpgrade={() => setUpgradeOpen(true)}
        showUpgrade={!upgradeOpen && plan === "free"}
      />
    </main>
  );
}

/**
 * TRIPS, FOR A FREE TRAVELLER (owner report 5 #17).
 *
 * The tab used to show every hunt to everyone and redact the numbers on the
 * older cards - a "locked preview". The owner asked for the opposite and said
 * why: Trips is a Pro/Ultra section, and a free traveller should meet real
 * upgrade TIER CARDS that say the gate out loud, once, instead of a list of
 * blurred rows that reads like a broken feature.
 *
 * The tiers are read from the shared catalogue (lib/plans), and the CTA opens
 * the EXISTING UpgradeSheet - the same sheet the three other upgrade CTAs
 * open. There is no second checkout surface here and there must never be one.
 */
function TripsUpgradeGate({ hunts, onUpgrade }: { hunts: number; onUpgrade: () => void }) {
  const { t } = useI18n();
  const tiers = PLANS.filter((p) => p.id !== "free");
  return (
    <div className="space-y-3">
      <section className="glass-solid glass-rim fluid-in relative overflow-hidden rounded-blob p-5 text-center">
        <div className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-brandblue-soft opacity-60 blur-2xl" />
        <div className="relative mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brandblue-soft">
          <Icon name="lock" className="h-6 w-6 text-brandblue" />
        </div>
        <h2 className="relative text-[16px] font-extrabold text-strong">
          {t("Trips is a Pro & Ultra feature")}
        </h2>
        <p className="relative mx-auto mt-1 max-w-[320px] text-[12.5px] text-soft">
          {t("Your past hunts - every shop, every price, every deposit - stay saved. Pro and Ultra let you open them again and ask those same shops whether the deal still stands.")}
        </p>
        {hunts > 0 && (
          <p className="relative mt-2 text-[11.5px] font-extrabold text-brandblue">
            {hunts} {hunts === 1 ? t("saved hunt is waiting") : t("saved hunts are waiting")}
          </p>
        )}
        <a
          href="/"
          onClick={() => startNav()}
          className="btn btn-ghost relative mt-3 inline-block rounded-2xl px-5 py-2.5 text-[12.5px]"
        >
          {t("Open live workspace")}
        </a>
      </section>

      {tiers.map((p) => (
        <section
          key={p.id}
          className={`glass-solid fluid-in rounded-blob p-4 ${
            p.highlight ? "glass-rim border-2 border-brandblue/40" : "glass-rim"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-[15px] font-extrabold text-strong">{t(p.name)}</div>
            {p.highlight && (
              <span className="rounded-full bg-brandblue px-2 py-0.5 text-[10px] font-extrabold text-white">
                {t("Most popular")}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-soft">{t(p.blurb)}</p>
          <ul className="mt-2 space-y-1">
            {p.features.slice(0, 5).map((f) => (
              <li key={f} className="flex items-start gap-1.5 text-[11.5px] font-bold text-soft">
                <Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-savings" />
                <span>{t(f)}</span>
              </li>
            ))}
          </ul>
          <button
            onClick={onUpgrade}
            className="btn btn-primary cta-sheen fluid-press mt-3 w-full rounded-2xl px-4 py-2.5 text-[13px]"
          >
            {t("See plans & upgrade")}
          </button>
        </section>
      ))}
    </div>
  );
}
