import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect, sbSelectStrict, pgTimestamp } from "@/lib/runtime-config";
import { toTrip } from "@/lib/trips";
import { groupSearchSessions, huntWindow } from "@/lib/session-life";
import {
  termsComplete,
  depositPhrase,
  fulfillmentLabel,
  type DealTerms,
} from "@/lib/deal-terms";
import { moneyLocal } from "@/lib/currency";
import { effectivePriceFor } from "@/lib/effective-price";
import { can } from "@/lib/entitlements";
import type { PlanId } from "@/lib/access";

export const dynamic = "force-dynamic";

// The "My deals" hub, rebuilt around SEARCH SESSIONS instead of a flat offer
// list. A session is a living object: who was contacted, who answered, who is
// still quiet, the best price on the table, how far the negotiation got, what
// Will plans next and what needs the traveller's attention. Everything is
// derived from data the pipeline already persists - this endpoint only reads,
// strictly scoped to the signed-in user.
//
// Session boundaries: `searches` rows are grouped into one session while they
// land within 30 minutes of the previous row (the profiler row + the vendor
// discovery row + radius tweaks all merge). Each session owns the activity
// window from its first row until the next session starts.

interface SearchRow {
  id: number;
  query_text: string | null;
  radius_km: number | null;
  vehicle_class: string | null;
  source: string | null;
  results: number | null;
  /** WHEN the rental is for, and for how long. Never selected before, so no
   *  card - collapsed or open - could state a date or a duration for a hunt
   *  that had not been booked. /api/deals/recheck has always read it. */
  rfq?: { durationDays?: number; startDate?: string; returnDate?: string } | null;
  /** WHERE the hunt happened. Never selected before, so no card could say. */
  lat?: number | null;
  lng?: number | null;
  created_at: string;
}

interface OfferRow {
  id: number;
  vendor_id: string | null;
  vendor_name: string | null;
  price_per_day: number | null;
  list_price_per_day?: number | null;
  currency: string | null;
  round: number | null;
  verified: boolean | null;
  created_at: string;
}

/** A vendor reply, as this route reads it (see the three column tiers). */
interface DealsReplyRow {
  id: number;
  vendor_id: string | null;
  vendor_name: string | null;
  reply_text: string | null;
  english_gloss?: string | null;
  image_count: number | null;
  deposit?: string | null;
  deposit_type?: string | null;
  deposit_amount?: number | null;
  deposit_currency?: string | null;
  delivers?: boolean | null;
  created_at: string;
}

interface BookingRow {
  id: number;
  vendor_name: string | null;
  price_per_day: number | null;
  total_price: number | null;
  currency: string | null;
  fulfillment: string | null;
  scheduled_at: string | null;
  status: string | null;
  created_at: string;
}

export interface SessionOffer {
  vendorId: string;
  vendorName: string;
  current: number;
  ask: number | null; // list/first quote - the honest "before" number
  currency: string;
  round: number;
  verified: boolean;
  at: string;
  stale: boolean;
}

export interface TimelineEvent {
  at: string;
  kind: "sent" | "reply" | "offer" | "alert" | "booked" | "you";
  vendorName?: string;
  text: string;
  /** English gloss of `text` for local-language sends/replies (W1.5): the real
   *  wire text stays primary, the translation is the second quiet line. */
  english?: string;
}

/** The hunt's terms, as the COLLAPSED card needs them (owner report 5 #17). */
export interface HuntPlace {
  lat: number;
  lng: number;
  /** A human place label, reverse-geocoded (cached) - null when unresolved. */
  label: string | null;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  /** The searches.id of this hunt's first row - its stable identity. See
   *  groupSearchSessions: addressing a hunt by a reconstructed timestamp broke
   *  re-open and re-check whenever two routes' query windows disagreed. */
  sid: number | null;
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
  avgAsk: number | null; // average asking price across shops (dominant currency)
  booking: {
    /** The row id + lifecycle status - what the Trips tap controls PATCH. */
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
  /**
   * THE RENTAL ITSELF - the dates and the length.
   *
   * The owner listed them among the facts a COLLAPSED card must show, and no
   * card showed either: `booking.durationDays` was shipped but consumed only by
   * `partitionHunts` and never rendered, `booking.scheduledAt` rendered only in
   * the separate "Booked earlier" list, and for a hunt with no booking there
   * was no duration in the response at all.
   */
  rental: {
    /** Days, from the booking's own arithmetic or from the hunt's RFQ. */
    durationDays: number | null;
    /** YYYY-MM-DD, as the traveller asked for it. */
    startDate: string | null;
    /** Stated by the RFQ, or derived from startDate + durationDays. */
    returnDate: string | null;
    /** The agreed pick-up moment, when a booking named one. */
    scheduledAt: string | null;
  } | null;
  attention: string[];
  plannedMoves: { at: string; vendorName: string | null; reason: string }[];
  queuedSends: number;
  timeline: TimelineEvent[];
  progress: number; // 0..100
  progressLabel: string;
  /** WHERE this hunt ran - so a collapsed card can say so. */
  place: HuntPlace | null;
  /** The deposit the shops asked for, in plain words (dominant answer). */
  depositLabel: string | null;
  /** How the traveller would get the vehicle ("Pick-up at the shop"). */
  fulfillmentLabel: string | null;
  /** Shops that answered, by name, and shops that never did - collapsed too. */
  answeredNames: string[];
  silentNames: string[];
  /** Shops with a FULL deal (price + deposit + pick-up) - the only ones the
   *  re-check may message. `0` is why the button is not offered. */
  recheckable: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How many past hunts the tab lists.
 *
 * WAS 5, INSIDE A 14-DAY WINDOW - which is how the owner's three-day Thailand
 * hunt vanished from Trips entirely after a fortnight. Re-open still worked;
 * there was simply no row left to tap, and the restore route (limit=40, no date
 * bound) would happily have served it. The list now reads the SAME window the
 * restore and re-check routes read, so the three routes agree about which hunts
 * exist as well as about where their boundaries are.
 */
const MAX_HUNTS = 20;
const SEARCH_ROW_LIMIT = 40;

/**
 * A calendar day from the RFQ, or null. Never a Date - the RFQ stores plain
 * `YYYY-MM-DD` and re-parsing it through a timezone is how a rental starting on
 * the 3rd renders as the 2nd for anyone west of UTC.
 */
function isoDay(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** startDate + durationDays, as a calendar day. Null when either is unknown. */
function addDays(day: string | null, days: number | null): string | null {
  if (!day || days == null || days <= 0) return null;
  // UTC arithmetic on a date-only string cannot drift: no local offset is ever
  // applied on the way in or on the way out.
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

function progressFor(s: {
  booked: boolean;
  bestVerified: boolean;
  anyCounter: boolean;
  anyOffer: boolean;
  replied: number;
  contacted: number;
}): { progress: number; label: string } {
  if (s.booked) return { progress: 100, label: "Deal locked in" };
  if (s.bestVerified) return { progress: 85, label: "Best price confirmed - ready when you are" };
  if (s.anyCounter) return { progress: 70, label: "Counter-offers in play" };
  if (s.anyOffer) return { progress: 55, label: "First quotes are in" };
  if (s.replied > 0) return { progress: 40, label: "Shops are answering" };
  if (s.contacted > 0) return { progress: 20, label: "Openers sent - replies usually take a bit" };
  return { progress: 10, label: "Setting up the hunt" };
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const email = session.email;
  const enc = encodeURIComponent(email);
  const plan = (session.plan ?? "free") as PlanId;

  // 1. Recent search rows -> session groups.
  //
  // NO DATE BOUND. The old read was `gte(now - 14 days) limit 30`, so a hunt
  // dropped out of Trips two weeks after it ran and the traveller lost the only
  // handle on it - the restore route has no date bound at all and would have
  // served it happily, but there was nothing left to tap. Same window as
  // /api/deals/restore and /api/deals/recheck now (40 rows, newest first), so
  // all three routes agree about which hunts exist.
  //
  // THREE COLUMN TIERS, AND AN UNREADABLE DATABASE IS NOT AN EMPTY ONE (M1).
  //
  // `rfq` is newer than `lat`/`lng`, which are newer than the table, so each
  // tier drops only the newest column - collapsing them would mean a database
  // missing only `rfq` ALSO loses the map centre.
  //
  // THE DEFECT THIS SHAPE KILLS. The old read fell from `sbSelectStrict` into a
  // narrow `sbSelect` on ANY error - including `unavailable` - and `sbSelect`
  // returns `[]` on failure too. So a transient Supabase blip answered HTTP 200
  // with `sessions: []`, the client only sets `loadFailed` on `!r.ok`, and a Pro
  // traveller with ten hunts was told "No hunts yet - and I'm ready". The page
  // has an honest "Couldn't load your trips" state that this path could not
  // reach: the same fail-green defect the file's own comment claimed to have
  // fixed. `missing` (schema not migrated) still degrades - that is what the
  // tiers are for - but `unavailable` now says so out loud.
  const readSearches = async (): Promise<{ rows: SearchRow[] } | { error: "unavailable" }> => {
    const widest = await sbSelectStrict<SearchRow>(
      "searches",
      `select=id,query_text,radius_km,vehicle_class,source,results,rfq,lat,lng,created_at&user_email=eq.${enc}&order=created_at.desc&limit=${SEARCH_ROW_LIMIT}`
    );
    if ("rows" in widest) return widest;
    if (widest.error === "unavailable") return { error: "unavailable" };
    const wide = await sbSelectStrict<SearchRow>(
      "searches",
      `select=id,query_text,radius_km,vehicle_class,source,results,lat,lng,created_at&user_email=eq.${enc}&order=created_at.desc&limit=${SEARCH_ROW_LIMIT}`
    );
    if ("rows" in wide) return wide;
    if (wide.error === "unavailable") return { error: "unavailable" };
    const narrow = await sbSelectStrict<SearchRow>(
      "searches",
      `select=id,query_text,radius_km,vehicle_class,source,results,created_at&user_email=eq.${enc}&order=created_at.desc&limit=${SEARCH_ROW_LIMIT}`
    );
    if ("rows" in narrow) return narrow;
    // The narrowest tier missing means the TABLE is not there - a fresh
    // install, vacuously empty. Demo mode lands here too, which is why this
    // must stay a real zero rather than a dark screen.
    return narrow.error === "missing" ? { rows: [] } : { error: "unavailable" };
  };
  const searchRead = await readSearches();
  if ("error" in searchRead) {
    return NextResponse.json(
      { error: "unavailable", hint: "Could not reach your trips just now." },
      { status: 503 }
    );
  }
  const searchRows = searchRead.rows;

  // Same discriminator the restore route uses: /api/profile records a `searches`
  // row for every RFQ BUILD (source `panel` / `profiler`, `results: 0`, no
  // snapshot). Those are analytics, not hunts - listing them here padded Trips
  // with entries that open onto nothing.
  // ONE grouping, shared with /api/deals/restore and /api/deals/recheck. Three
  // private copies of this loop, fed by three different queries, is how the
  // boundaries drifted and re-open started 404ing - see groupSearchSessions.
  // ALREADY newest-first - groupSearchSessions ends with its own reverse and
  // documents it. A second reverse here flipped the list to oldest-first, so
  // Trips rendered the OLDEST five hunts, pinned `isLatest` (and the free-plan
  // unlock) to the oldest one, and disagreed with restore/recheck - which do
  // NOT reverse - about which hunt `gi === 0` means.
  const groups = groupSearchSessions(searchRows);

  // THE GATE, ON THE SERVER (owner report 5 #17).
  //
  // Trips is a Pro/Ultra section now. It used to ship every hunt to every plan
  // and redact the numbers in the BROWSER (`previewTrip`, applied in the page),
  // which is a curtain, not a gate: the prices, the shop names and the whole
  // history were in the JSON either way. A free plan gets the count - enough
  // for the upgrade card to say "3 saved hunts are waiting" honestly - and
  // nothing else, which also makes the free path one cheap query instead of ten.
  if (!can(plan, "trips-history")) {
    return NextResponse.json({
      locked: true,
      feature: "trips-history",
      huntCount: groups.length,
      sessions: [],
      bookings: [],
    });
  }

  const kept = groups.slice(0, MAX_HUNTS);

  // pgTimestamp, NOT raw interpolation. `kept[...].created_at` comes back from
  // PostgREST as `...+00:00`, and a raw `+` in a query string decodes to a
  // space - which 400'd all five reads below and rendered the whole Trips hub
  // empty for anyone who had ever run a hunt. See pgTimestamp's docblock.
  const oldestStart = kept.length
    ? kept[kept.length - 1][0].created_at
    : new Date(Date.now() - DAY_MS).toISOString();

  // 2. Everything the pipeline persisted since the oldest kept session.
  const [outbound, replies, offers, bookings, riskEvents, outbox, wakeups, pauseMarkers, closedMarkers] =
    await Promise.all([
      sbSelect<{
        id: number;
        to_number: string;
        body: string | null;
        // Outbound rows carry the gloss as raw.englishGloss (the outbox meta
        // key every send path stamps); raw.english is the INBOUND key.
        raw: { vendorId?: string; vendorName?: string; englishGloss?: string; kind?: string } | null;
        received_at: string;
      }>(
        "whatsapp_messages",
        `select=id,to_number,body,raw,received_at&direction=eq.outbound&raw->>sender=eq.${enc}&to_number=not.in.(session,takeover,cancel)&received_at=gte.${pgTimestamp(oldestStart)}&order=received_at.desc&limit=250`
      ).catch(() => []),
      (async () => {
        const filter = `user_email=eq.${enc}&created_at=gte.${pgTimestamp(oldestStart)}&order=created_at.desc&limit=250`;
        // english_gloss + the deposit columns in the first tier only - an
        // unknown column silently blanks the select, and the trips timeline
        // must survive a pending migration (same degrade /api/replies uses).
        // The deposit half is what lets a COLLAPSED card state the terms.
        let rows = await sbSelect<DealsReplyRow>(
          "vendor_replies",
          `select=id,vendor_id,vendor_name,reply_text,english_gloss,image_count,deposit,deposit_type,deposit_amount,deposit_currency,delivers,created_at&${filter}`
        );
        if (rows.length === 0) {
          rows = await sbSelect<DealsReplyRow>(
            "vendor_replies",
            `select=id,vendor_id,vendor_name,reply_text,english_gloss,image_count,created_at&${filter}`
          );
        }
        if (rows.length === 0) {
          rows = await sbSelect<DealsReplyRow>(
            "vendor_replies",
            `select=id,vendor_id,vendor_name,reply_text,image_count,created_at&${filter}`
          );
        }
        return rows;
      })().catch(() => [] as DealsReplyRow[]),
      (async () => {
        let rows = await sbSelect<OfferRow>(
          "offers",
          `select=id,vendor_id,vendor_name,price_per_day,list_price_per_day,currency,round,verified,created_at&user_email=eq.${enc}&simulated=eq.false&created_at=gte.${pgTimestamp(oldestStart)}&order=created_at.desc&limit=250`
        );
        if (rows.length === 0) {
          rows = await sbSelect<OfferRow>(
            "offers",
            `select=id,vendor_id,vendor_name,price_per_day,currency,round,verified,created_at&user_email=eq.${enc}&simulated=eq.false&created_at=gte.${pgTimestamp(oldestStart)}&order=created_at.desc&limit=250`
          );
        }
        return rows;
      })().catch(() => [] as OfferRow[]),
      sbSelect<BookingRow>(
        "bookings",
        `select=id,vendor_name,price_per_day,total_price,currency,fulfillment,scheduled_at,status,created_at&user_email=eq.${enc}&order=created_at.desc&limit=25`
      ).catch(() => [] as BookingRow[]),
      sbSelect<{
        id: number;
        vendor_name: string | null;
        detail: string | null;
        created_at: string;
      }>(
        "agent_events",
        // Exact ownership match (the LIKE substring filter leaked alerts
        // across users whose emails were substrings of each other).
        `select=id,vendor_name,detail,created_at&kind=eq.inbound-risk&user_email=eq.${encodeURIComponent(
          email
        )}&created_at=gte.${pgTimestamp(oldestStart)}&order=created_at.desc&limit=20`
      ).catch(() => []),
      sbSelect<{ id: number; not_before: string }>(
        "wa_outbox",
        `select=id,not_before&sender_key=eq.${enc}&order=not_before.asc&limit=50`
      ).catch(() => []),
      sbSelect<{
        id: number;
        not_before: string;
        payload: { reason?: string; vendorName?: string } | null;
      }>(
        "graph_wakeups",
        // EXACT ownership match on the stamped column - the old
        // `thread_key=like.<email>:*` read could surface a DIFFERENT user's
        // wakeup (shop name + reason) when one email was a `_`-wildcard match
        // of another. Unstamped legacy rows are hidden by design (same
        // precedent as the agent_events feed filter).
        `select=id,not_before,payload&user_email=eq.${encodeURIComponent(
          email
        )}&kind=eq.tick&order=not_before.asc&limit=10`
      ).catch(() => []),
      // KIND-FILTERED, matching sessionPauseState's canonical read. Unfiltered,
      // the newest session row of ANY kind answered here - so a pause followed
      // by a clear read as "not paused" while the pause switch itself (which
      // reads the filtered family) still said paused. Two surfaces, one fact.
      sbSelect<{ raw: { kind?: string } | null }>(
        "whatsapp_messages",
        `select=raw&to_number=eq.session&raw->>sender=eq.${enc}&raw->>kind=in.(session-paused,session-resumed)&order=received_at.desc&limit=1`
      ).catch(() => []),
      // Session-closed markers across the whole kept window, ONE read for all
      // five groups. Permissive on purpose: this flags the DISPLAY (hide the
      // live Re-open on a cleared hunt); the restore route keeps its strict
      // gate, so an outage here degrades to a button that 404s honestly, never
      // to a cleared hunt silently coming back.
      sbSelect<{ received_at: string }>(
        "whatsapp_messages",
        `select=received_at&to_number=eq.session&raw->>sender=eq.${enc}&raw->>kind=eq.session-closed&received_at=gte.${pgTimestamp(
          oldestStart
        )}&order=received_at.desc&limit=20`
      ).catch(() => [] as { received_at: string }[]),
    ]);

  // The engine's own extracted per-shop state: the AUTHORITY on how a traveller
  // would get the vehicle, and the second source for the deposit. Never joined
  // before, which is why no card - collapsed or open - could state either.
  // Keyed by shop, not by hunt, so it is only ever read for shops the hunt's
  // own windowed rows already name.
  const threadRows = await sbSelect<{
    vendor_id: string | null;
    fields: {
      fulfillment?: string;
      depositType?: string;
      depositNote?: string;
      pricePerDay?: number;
      currency?: string;
    } | null;
  }>(
    "negotiation_threads",
    `select=vendor_id,fields&user_email=eq.${enc}&order=updated_at.desc&limit=100`
  ).catch(() => [] as { vendor_id: string | null; fields: null }[]);
  const threadByVendor = new Map<
    string,
    {
      fulfillment?: string;
      depositType?: string;
      depositNote?: string;
      pricePerDay?: number;
      currency?: string;
    }
  >();
  for (const th of threadRows) {
    if (th.vendor_id && th.fields && !threadByVendor.has(th.vendor_id)) {
      threadByVendor.set(th.vendor_id, th.fields);
    }
  }

  const now = Date.now();
  const paused = pauseMarkers[0]?.raw?.kind === "session-paused";
  const closedStamps = closedMarkers
    .map((m) => Date.parse(m.received_at))
    .filter((t) => Number.isFinite(t));

  // 3. Build each session's living summary from its activity window.
  const sessions: SessionSummary[] = kept.map((group, gi) => {
    const start = Date.parse(group[0].created_at);
    // ONE window object, shared with /api/deals/restore and /api/deals/recheck
    // (see huntWindow). Three private copies of this arithmetic is how the
    // re-ask count on this card came to disagree with what the re-ask route
    // could actually see.
    const win = huntWindow(kept, gi);
    const end = win.end; // the next-newer session's start closes this window
    const inWindow = (iso: string) => win.contains(iso);
    const isLatest = gi === 0;
    // Same bounds as the restore route's gate: the marker must fall AFTER this
    // group's newest row and BEFORE the next group begins - comparing against
    // the group's FIRST row would mark the search-clear-search-again sequence
    // (one 30-min group with the clear in the middle) as closed.
    const groupEnd = Date.parse(group[group.length - 1].created_at);
    const closed = closedStamps.some((t) => t > groupEnd && t < end);

    // The newest row of the group that carried a real origin - the same rule
    // the restore route uses to rebuild the map's centre.
    const originRow = [...group]
      .reverse()
      .find((r) => r.lat != null && r.lng != null && Number.isFinite(Number(r.lat)));

    const query = group.find((r) => r.query_text)?.query_text ?? null;
    const vehicleClass = [...group].reverse().find((r) => r.vehicle_class)?.vehicle_class ?? null;
    const radiusKm = [...group].reverse().find((r) => r.radius_km != null)?.radius_km ?? null;
    const shopsFound = Math.max(0, ...group.map((r) => r.results ?? 0));

    const sent = outbound.filter((m) => inWindow(m.received_at));
    const humanSent = sent.filter((m) => m.raw?.kind === "human-manual");
    const rep = replies.filter((r) => inWindow(r.created_at));
    const off = offers.filter((o) => inWindow(o.created_at) && (o.price_per_day ?? 0) > 0);
    const risks = riskEvents.filter((e) => inWindow(e.created_at));
    const booking = bookings.find((b) => inWindow(b.created_at)) ?? null;

    // THE RENTAL LENGTH, DERIVED FROM THE TWO NUMBERS WE ALREADY HAVE.
    //
    // `savingOf` totals the per-day gap over the rental and returns null when
    // it does not know the duration - correct, but nothing was ever passing a
    // duration, so every trip reported "cannot total" and the headline saving
    // stayed blank. `bookings.duration_days` exists in the schema, but adding a
    // column to this select would 400 for anyone who has not run the migration
    // and take every booking down with it. The total and the per-day rate are
    // already selected and their ratio IS the duration, by definition.
    const bookedDays =
      booking && booking.total_price != null && Number(booking.price_per_day) > 0
        ? Math.max(1, Math.round(Number(booking.total_price) / Number(booking.price_per_day)))
        : null;

    // THE DATES AND THE LENGTH - which appeared on no card at all.
    //
    // The header showed `timeAgo(startedAt)` and nothing else time-shaped, so a
    // traveller could not tell a three-day Krabi hunt from a week-long Bali one.
    // A hunt with no booking had no duration in the response whatsoever, even
    // though the re-check route has always read `searches.rfq.durationDays` from
    // the very same rows. The newest row in the group wins - a traveller who
    // widened the request mid-hunt meant the newer answer.
    const rfqRow = [...group].reverse().find((r) => r.rfq && typeof r.rfq === "object");
    const rfqDays =
      typeof rfqRow?.rfq?.durationDays === "number" && rfqRow.rfq.durationDays > 0
        ? Math.round(rfqRow.rfq.durationDays)
        : null;
    // The BOOKING's own arithmetic wins when there is one: it is what the
    // traveller actually pays for, not what they asked for.
    const durationDays = bookedDays ?? rfqDays;
    const startDate = isoDay(rfqRow?.rfq?.startDate) ?? null;
    // "Return date; when absent it is derived from startDate + durationDays"
    // (lib/types) - said in the schema and never once derived.
    const returnDate = isoDay(rfqRow?.rfq?.returnDate) ?? addDays(startDate, durationDays);

    // WHO WE REACHED, WHO ANSWERED, AND WHO NEVER DID - BY NAME.
    //
    // The counts were already computed here and shipped on every summary, but
    // they only ever rendered inside the `open &&` branch, so a collapsed card
    // - which is every card the traveller has not tapped - could not say how
    // many shops answered, let alone which ones (owner report 5 #17).
    const contactedIds = new Set<string>();
    const nameById = new Map<string, string>();
    for (const m of sent) {
      const id = m.raw?.vendorId || m.to_number;
      contactedIds.add(id);
      if (m.raw?.vendorName && !nameById.has(id)) nameById.set(id, m.raw.vendorName);
    }
    const repliedIds = new Set<string>();
    for (const r of rep) {
      const id = r.vendor_id || r.vendor_name || String(r.id);
      repliedIds.add(id);
      if (r.vendor_name && !nameById.has(id)) nameById.set(id, r.vendor_name);
    }
    const contacted = contactedIds.size;
    const replied = Math.min(repliedIds.size, contacted || repliedIds.size);
    const shopLabel = (id: string) => nameById.get(id) ?? "Rental shop";
    const answeredNames = [...repliedIds].map(shopLabel).slice(0, 12);
    const silentNames = [...contactedIds]
      .filter((id) => !repliedIds.has(id))
      .map(shopLabel)
      .slice(0, 12);

    // Per-vendor: newest price + the honest "before" number (list price when
    // the shop stated one, otherwise the earliest quote in this session).
    const byVendor = new Map<string, { newest: OfferRow; earliest: OfferRow; ask: number | null }>();
    for (const o of off) {
      const key = o.vendor_id || o.vendor_name || String(o.id);
      const cur = byVendor.get(key);
      if (!cur) {
        byVendor.set(key, { newest: o, earliest: o, ask: o.list_price_per_day ?? null });
      } else {
        // offers arrive desc: first seen is newest, keep updating earliest.
        cur.earliest = o;
        if (o.list_price_per_day && !cur.ask) cur.ask = o.list_price_per_day;
      }
    }

    const sessionOffers: SessionOffer[] = [...byVendor.entries()].map(([key, v]) => {
      const ask = v.ask ?? (v.earliest.id !== v.newest.id ? v.earliest.price_per_day : null);
      return {
        vendorId: v.newest.vendor_id ?? key,
        vendorName: v.newest.vendor_name ?? "Rental shop",
        current: Number(v.newest.price_per_day),
        ask: ask != null && Number(ask) > Number(v.newest.price_per_day) ? Number(ask) : null,
        currency: v.newest.currency ?? "USD",
        round: v.newest.round ?? 0,
        verified: Boolean(v.newest.verified),
        at: v.newest.created_at,
        stale: now - Date.parse(v.newest.created_at) > DAY_MS,
      };
    });

    // Dominant currency keeps comparisons honest across mixed quotes.
    const curCount = new Map<string, number>();
    for (const o of sessionOffers) curCount.set(o.currency, (curCount.get(o.currency) ?? 0) + 1);
    const domCurrency =
      [...curCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const comparable = sessionOffers.filter((o) => o.currency === domCurrency);
    comparable.sort((a, b) => a.current - b.current || Number(b.verified) - Number(a.verified));
    const bestRaw = comparable[0] ?? null;
    const asks = comparable.map((o) => o.ask).filter((a): a is number => a != null && a > 0);
    const avgAsk = asks.length
      ? Math.round((asks.reduce((s, a) => s + a, 0) / asks.length) * 100) / 100
      : null;
    const best = bestRaw
      ? {
          ...bestRaw,
          savedPct:
            bestRaw.ask && bestRaw.ask > bestRaw.current
              ? Math.round(((bestRaw.ask - bestRaw.current) / bestRaw.ask) * 100)
              : null,
        }
      : null;

    // THE TERMS, PER SHOP - price + deposit + how you get the vehicle.
    //
    // One shape (`DealTerms`), one predicate (`termsComplete`), shared with the
    // re-check route so what a card CLAIMS and what the re-ask is ALLOWED to do
    // can never drift. The deposit reaches the screen for the first time here:
    // /api/deals never joined negotiation_threads and never read the reply
    // rows' deposit columns, so no card could show a deposit at all.
    const termsById = new Map<string, DealTerms>();
    for (const id of contactedIds) {
      const offer = byVendor.get(id)?.newest;
      const reply = rep.find((r) => (r.vendor_id || r.vendor_name) === id);
      const th = threadByVendor.get(id);
      // THE SHARED RESOLVER (D2). Trips rebuilt its idea of a shop's price
      // from offers rows alone, so a thread deep in negotiation with a
      // standing price - but no offers row yet - read as priceless here while
      // the live hunt showed the number. Same lib as /api/replies, so the two
      // surfaces cannot disagree.
      const eff = effectivePriceFor({
        found: (offer?.price_per_day ?? 0) > 0,
        rowPrice: offer?.price_per_day ?? null,
        rowCurrency: th?.currency ?? offer?.currency ?? null,
        threadPrice: th?.pricePerDay ?? null,
      });
      termsById.set(id, {
        pricePerDay: offer?.price_per_day ?? eff?.pricePerDay ?? null,
        currency: offer?.currency ?? eff?.currency ?? null,
        depositType: th?.depositType ?? reply?.deposit_type ?? null,
        depositNote: th?.depositNote ?? null,
        depositLabel: reply?.deposit ?? null,
        depositAmount: reply?.deposit_amount ?? null,
        depositCurrency: reply?.deposit_currency ?? null,
        fulfillment: th?.fulfillment ?? null,
        delivers: reply?.delivers ?? null,
      });
    }
    const allTerms = [...termsById.values()];
    const recheckable = allTerms.filter(termsComplete).length;
    // The hunt-level answer is the FIRST shop that stated one - a card says
    // "the shops asked for X", never averages incompatible conditions.
    const depositLabel =
      allTerms.map((t) => depositPhrase(t, moneyLocal)).find((p): p is string => Boolean(p)) ?? null;
    const fulfilLabel =
      allTerms.map(fulfillmentLabel).find((p): p is string => Boolean(p)) ?? null;

    // What needs the traveller (not the agent) right now.
    const attention: string[] = [];
    if (isLatest && paused) attention.push("Search is paused - Will is holding all messages until you resume.");
    for (const e of risks.slice(0, 3)) {
      let reason = "a reply worth a second look";
      try {
        const d = JSON.parse(e.detail ?? "{}");
        if (Array.isArray(d.reasons) && d.reasons[0]) reason = String(d.reasons[0]);
      } catch {}
      attention.push(`${e.vendor_name ?? "A shop"}: ${reason}`);
    }
    if (!booking && best?.stale) {
      attention.push("The best quote is over a day old - worth re-confirming before you rely on it.");
    }

    const plannedMoves = isLatest
      ? wakeups
          .filter((w) => Date.parse(w.not_before) > now)
          .slice(0, 3)
          .map((w) => ({
            at: w.not_before,
            vendorName: w.payload?.vendorName ?? null,
            reason:
              w.payload?.reason ??
              "waiting a moment so the shop takes the offer seriously",
          }))
      : [];
    const queuedSends = isLatest ? outbox.length : 0;

    // Compact timeline: the last few moments that actually matter.
    const timeline: TimelineEvent[] = [];
    for (const m of sent.slice(0, 12)) {
      const human = m.raw?.kind === "human-manual";
      timeline.push({
        at: m.received_at,
        kind: human ? "you" : "sent",
        vendorName: m.raw?.vendorName,
        // The REAL sent text, gloss beside it (W1.5 doctrine). The old
        // gloss-instead read keyed on raw.english - the inbound key - so it
        // never fired anyway; outbound rows carry raw.englishGloss.
        text: human ? "You messaged the shop yourself" : (m.body || "Message sent").slice(0, 90),
        english: human ? undefined : m.raw?.englishGloss?.slice(0, 90),
      });
    }
    for (const r of rep.slice(0, 12)) {
      timeline.push({
        at: r.created_at,
        kind: "reply",
        vendorName: r.vendor_name ?? undefined,
        text: (r.reply_text ?? (r.image_count ? "Sent a photo" : "Replied")).slice(0, 90),
        english: r.english_gloss?.slice(0, 90) ?? undefined,
      });
    }
    for (const o of off.slice(0, 12)) {
      timeline.push({
        at: o.created_at,
        kind: "offer",
        vendorName: o.vendor_name ?? undefined,
        text: `${o.verified ? "Confirmed" : "Quoted"} ${o.price_per_day} ${o.currency ?? ""}/day${
          (o.round ?? 0) > 0 ? ` after round ${o.round}` : ""
        }`,
      });
    }
    for (const e of risks.slice(0, 3)) {
      timeline.push({
        at: e.created_at,
        kind: "alert",
        vendorName: e.vendor_name ?? undefined,
        text: "Will flagged this reply for you",
      });
    }
    if (booking) {
      timeline.push({
        at: booking.created_at,
        kind: "booked",
        vendorName: booking.vendor_name ?? undefined,
        text: "Deal locked in",
      });
    }
    timeline.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    const lastEventAt = timeline[0] ? Date.parse(timeline[0].at) : start;
    const anyCounter = sessionOffers.some((o) => o.round > 0);
    const { progress, label } = progressFor({
      booked: Boolean(booking),
      bestVerified: Boolean(best?.verified),
      anyCounter,
      anyOffer: sessionOffers.length > 0,
      replied,
      contacted,
    });

    const status: SessionSummary["status"] = booking
      ? "booked"
      : (isLatest && (queuedSends > 0 || plannedMoves.length > 0)) || now - lastEventAt < 45 * 60 * 1000
        ? "live"
        : replied < contacted && now - start < 2 * DAY_MS
          ? "waiting"
          : "wrapped";

    return {
      id: String(group[0].id),
      startedAt: group[0].created_at,
      sid: group[0].id ?? null,
      isLatest,
      query,
      vehicleClass,
      radiusKm: radiusKm != null ? Number(radiusKm) : null,
      shopsFound,
      status,
      paused: isLatest ? paused : false,
      closed,
      contacted: Math.max(contacted, humanSent.length ? 1 : 0),
      replied,
      waiting: Math.max(0, contacted - replied),
      offers: sessionOffers.sort((a, b) => a.current - b.current).slice(0, 12),
      best,
      avgAsk,
      booking: booking
        ? {
            // id + lifecycle status: what the Trips controls act on (bookings
            // PATCH) - without them the card could render the rental but the
            // traveller had no way to say "I picked it up" / "trip done".
            id: booking.id ?? null,
            status: booking.status ?? "confirmed",
            vendorName: booking.vendor_name ?? "Rental shop",
            total: booking.total_price != null ? Number(booking.total_price) : null,
            perDay: booking.price_per_day != null ? Number(booking.price_per_day) : null,
            currency: booking.currency ?? "USD",
            scheduledAt: booking.scheduled_at,
            durationDays: bookedDays,
            at: booking.created_at,
          }
        : null,
      // Null only when we know NOTHING about the rental - a card that has a
      // length but no dates still gets to say the length.
      rental:
        durationDays != null || startDate || returnDate || booking?.scheduled_at
          ? {
              durationDays,
              startDate,
              returnDate,
              scheduledAt: booking?.scheduled_at ?? null,
            }
          : null,
      attention,
      plannedMoves,
      queuedSends,
      timeline: timeline.slice(0, 6),
      progress,
      progressLabel: label,
      // WHERE, WHAT THE DEPOSIT WAS, HOW YOU GET IT, AND WHO ANSWERED - the
      // facts a COLLAPSED card has to carry (owner report 5 #17). The label is
      // filled in below, once, per distinct point.
      place: originRow ? { lat: Number(originRow.lat), lng: Number(originRow.lng), label: null } : null,
      depositLabel,
      fulfillmentLabel: fulfilLabel,
      answeredNames,
      silentNames,
      recheckable,
      // THE TRIP: what became of this hunt, what it cost, what it saved.
      // A session could only ever describe what is happening right now, so a
      // finished hunt looked exactly like an abandoned one and a traveller who
      // actually rented something had nothing to look back at (lib/trips).
      trip: toTrip(
        {
          id: String(group[0].id),
          startedAt: group[0].created_at,
          query,
          vehicleClass,
          contacted: Math.max(contacted, humanSent.length ? 1 : 0),
          replied,
          best: best
            ? { pricePerDay: best.current, ask: best.ask, currency: best.currency }
            : null,
          booking: booking
            ? {
                vendorName: booking.vendor_name ?? "Rental shop",
                perDay: booking.price_per_day != null ? Number(booking.price_per_day) : null,
                total: booking.total_price != null ? Number(booking.total_price) : null,
                currency: booking.currency ?? "USD",
                scheduledAt: booking.scheduled_at,
              }
            : null,
          // bookedDays FIRST, then the RFQ's length: a hunt that quoted but
          // never booked could not total its saving at all before, so every
          // un-booked trip reported "cannot total" and the headline stayed
          // blank. The RFQ length is the traveller's own stated rental.
          durationDays: bookedDays ?? rfqDays,
          isLatest,
          lastEventAt,
        },
        now
      ),
    };
  });

  // 4. NAME THE PLACE. "8km hunt" is not a location a traveller recognises
  //    their own trip by; "Ao Nang, Krabi" is. `reverseGeocode` is cached for a
  //    day per rounded point and hunts cluster around the same hotel, so this
  //    is usually zero network calls - but Trips is on the critical path, so it
  //    is deduped, capped, run in parallel and hard-bounded in wall clock. A
  //    slow geocoder costs the label, never the tab.
  await labelPlaces(sessions);

  return NextResponse.json({ sessions, bookings });
}

/** Distinct rounded points only, at most PLACE_LOOKUPS, under PLACE_BUDGET_MS. */
const PLACE_LOOKUPS = 6;
const PLACE_BUDGET_MS = 2_500;

async function labelPlaces(sessions: SessionSummary[]): Promise<void> {
  const points = new Map<string, { lat: number; lng: number }>();
  for (const s of sessions) {
    if (!s.place) continue;
    const key = `${Math.round(s.place.lat * 1000) / 1000},${Math.round(s.place.lng * 1000) / 1000}`;
    if (!points.has(key)) points.set(key, { lat: s.place.lat, lng: s.place.lng });
  }
  if (!points.size) return;
  const wanted = [...points.entries()].slice(0, PLACE_LOOKUPS);
  const labels = new Map<string, string>();
  try {
    const { reverseGeocode } = await import("@/lib/google");
    await Promise.race([
      Promise.all(
        wanted.map(async ([key, p]) => {
          const hit = await reverseGeocode(p.lat, p.lng).catch(() => null);
          if (hit?.label) labels.set(key, hit.label);
        })
      ),
      new Promise((resolve) => setTimeout(resolve, PLACE_BUDGET_MS)),
    ]);
  } catch {
    /* a label is an enhancement to a card, never a condition of it */
  }
  for (const s of sessions) {
    if (!s.place) continue;
    const key = `${Math.round(s.place.lat * 1000) / 1000},${Math.round(s.place.lng * 1000) / 1000}`;
    s.place.label = labels.get(key) ?? null;
  }
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
