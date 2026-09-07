import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect, sbSelectStrict } from "@/lib/runtime-config";
import { can } from "@/lib/entitlements";
import type { PlanId } from "@/lib/access";
import {
  isSessionFresh,
  groupSearchSessions,
  sessionIdOf,
  huntWindow,
  reopenEpoch,
  closedByOf,
} from "@/lib/session-life";
import { searchSessionTtlMs } from "@/lib/session-life-config";

export const dynamic = "force-dynamic";

// Trips restore (issue 8): rebuild the `wd_search`-shaped payload for a PAST
// search session so the traveller can re-open its full Find-Deals workspace
// (shops + RFQ + origin) instead of starting from scratch. The client writes
// the payload to sessionStorage and navigates home, where the existing
// rehydrate path renders it and the live polls re-apply the latest offers.
//
// Sources, in priority order:
//   1. searches.snapshot / searches.rfq  - the exact shops + RFQ this hunt ran
//      (stamped at search time). The complete restore.
//   2. Fallback for pre-snapshot sessions: the shops we actually MESSAGED
//      (outbound raws) plus any offers, and the RFQ from the newest outbound
//      raw. Honest partial - only contacted shops, surfaced in the UI copy.
//
// PRIVACY: everything is strictly scoped to the signed-in user's own rows.

// (The 30-minute grouping constant that used to sit here was dead in all three
//  deals routes - `groupSearchSessions` owns the gap now, which is the whole
//  point of there being one grouping.)

interface SnapshotVendor {
  id: string;
  name: string;
  whatsapp?: string;
  placeId?: string | null;
  rating?: number | null;
  reviews?: number | null;
  distanceKm?: number | null;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  vehicleClasses?: string[];
  fulfillment?: string[];
  partner?: boolean;
  demo?: boolean;
  basePricePerDay?: number;
  photoUrl?: string | null;
}

interface SearchRow {
  id: number;
  query_text: string | null;
  lat: number | null;
  lng: number | null;
  radius_km: number | null;
  vehicle_class: string | null;
  source: string | null;
  rfq: Record<string, unknown> | null;
  snapshot: SnapshotVendor[] | null;
  /** The place the traveller NAMED. It is the app's `region`, so losing it
   *  makes every later bargain compose in USD and drops the market floor. */
  origin_label?: string | null;
  created_at: string;
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // PRO GATE: restoring an OLDER hunt is a paid feature. The latest session is
  // always restorable (that is the live workspace); only earlier ones gate.
  const plan = (session.plan ?? "free") as PlanId;
  const hasHistory = can(plan, "trips-history");

  // `ts=latest` - "whatever hunt I was on". The iOS PWA can be killed at any
  // moment and sessionStorage goes with it, so the Find-deals screen needs to
  // ask for the newest session by name rather than by a timestamp it no longer
  // has. It is always index 0, which is always ungated (see the gate below), so
  // this opens no door the explicit path did not already open.
  const ts = new URL(req.url).searchParams.get("ts") ?? "";
  const wantLatest = ts === "latest";
  const startMs = Date.parse(ts);
  if (!wantLatest && !Number.isFinite(startMs)) {
    return NextResponse.json({ error: "ts (session start) required" }, { status: 400 });
  }
  const enc = encodeURIComponent(session.email);

  // 1. Recent search rows -> the same 30-min session grouping the Trips list uses.
  // Try the snapshot-bearing select first; fall back for a pre-migration DB.
  // THE PRE-MIGRATION FALLBACK BELOW WAS UNREACHABLE.
  //
  // It was written as `sbSelect(...).catch(() => null)` and gated on
  // `rows === null`. `sbSelect` has no rejection path - a 400 carrying
  // "column snapshot does not exist" returns `[]` like everything else - so the
  // catch never ran, `null` never happened, and a database without the
  // `rfq`/`snapshot` columns answered "No searches found." instead of degrading
  // to the columns it does have. The degrade was recorded in the code and has
  // never executed.
  //
  // `sbSelectStrict` is the reader that can tell those apart: `missing` is
  // exactly "that column is not there yet", which is the one case this fallback
  // exists for. `unavailable` is an outage and must NOT trigger the fallback -
  // retrying the same unreachable database with fewer columns just fails twice.
  // THREE TIERS, because `origin_label` is newer than `rfq`/`snapshot`, which
  // are newer than the table. Collapsing them into two would mean a database
  // missing only the newest column ALSO loses the RFQ and the vendor snapshot -
  // trading one degradation for a much worse one.
  const widest = await sbSelectStrict<SearchRow>(
    "searches",
    `select=id,query_text,lat,lng,radius_km,vehicle_class,source,rfq,snapshot,origin_label,created_at&user_email=eq.${enc}&order=created_at.desc&limit=40`
  );
  const wide =
    "rows" in widest || widest.error !== "missing"
      ? widest
      : await sbSelectStrict<SearchRow>(
          "searches",
          `select=id,query_text,lat,lng,radius_km,vehicle_class,source,rfq,snapshot,created_at&user_email=eq.${enc}&order=created_at.desc&limit=40`
        );
  let rows: SearchRow[];
  if ("rows" in wide) {
    rows = wide.rows;
  } else if (wide.error === "missing") {
    const narrow = await sbSelectStrict<Omit<SearchRow, "rfq" | "snapshot">>(
      "searches",
      `select=id,query_text,lat,lng,radius_km,vehicle_class,source,created_at&user_email=eq.${enc}&order=created_at.desc&limit=40`
    );
    rows = "rows" in narrow ? narrow.rows.map((r) => ({ ...r, rfq: null, snapshot: null })) : [];
  } else {
    // Unreadable. Say so rather than answering "you have never searched" - the
    // client treats a 404 as "no live hunt" and lands on a clean search screen,
    // which would quietly discard a hunt that is still running.
    return NextResponse.json(
      { error: "unavailable", hint: "Could not reach your hunts just now." },
      { status: 503 }
    );
  }
  if (!rows.length) return NextResponse.json({ error: "No searches found." }, { status: 404 });

  // BUILDING A REQUEST IS NOT RUNNING A HUNT.
  //
  // /api/profile writes a `searches` row on every RFQ build - both the LLM
  // profiler and the zero-token tap-to-build panel - stamped `results: 0` with
  // no snapshot and no rfq. Those rows are useful analytics and useless as
  // sessions, but they carry the newest `created_at`, so `ts=latest` picked one,
  // found no snapshot, and fell straight through to the contacted-shops
  // fallback. That is how a hunt the traveller had finished with came back
  // wearing a request they had merely started typing.
  //
  // Filtered in JS rather than in the query on purpose: PostgREST's `not.in`
  // resolves to NULL for a NULL `source`, which would silently exclude legacy
  // rows that predate the column being written.
  // ONE grouping, shared with /api/deals and /api/deals/recheck. Three private
  // copies of this loop used to be fed by three different queries, which is how
  // the boundaries drifted apart - see groupSearchSessions for the full story.
  const groups = groupSearchSessions(rows);
  if (!groups.length) return NextResponse.json({ error: "No searches found." }, { status: 404 });

  // ADDRESS A HUNT BY ITS ROW ID, NOT BY A RECONSTRUCTED TIMESTAMP.
  //
  // The old match was `Math.abs(g[0].created_at - startMs) < 1000` - a
  // one-second tolerance against a boundary this route computed from ITS row
  // window (unbounded x 40) while the Trips list computed the tap's timestamp
  // from a DIFFERENT one (14 days x 30). Past ~30 hunt rows the two windows
  // truncate the oldest hunt at different rows, the boundaries differ by
  // minutes, and the traveller is told a hunt they can see in the list is "no
  // longer available".
  //
  // `sid` is the searches.id of the hunt's first row, which does not move when
  // a query window does. The timestamp path stays for older clients that have
  // not been reloaded yet - same failure mode as before for those, but no worse.
  const sidParam = new URL(req.url).searchParams.get("sid");
  const sid = sidParam ? Number(sidParam) : NaN;
  const gi = wantLatest
    ? 0
    : Number.isFinite(sid)
      ? groups.findIndex((g) => sessionIdOf(g) === sid)
      : groups.findIndex((g) => Math.abs(Date.parse(g[0].created_at) - startMs) < 1000);
  if (gi < 0) return NextResponse.json({ error: "That hunt is no longer available." }, { status: 404 });

  // A HUNT HAS AN END. `ts=latest` is the AUTO-restore the Find-deals screen
  // fires on every cold mount, and it used to mean "the newest row in this
  // table" with no upper bound on age - so a traveller who searched once, a week
  // ago, opened the app and was handed that week-old hunt as their live
  // workspace, complete with "the agents never stopped". They had stopped.
  //
  // The freshness gate is deliberately ONLY on the automatic path. An explicit
  // `ts=<timestamp>` comes from a tap in Trips - the traveller asking for a
  // specific past hunt by name - and that must keep working at any age. This is
  // the whole difference between history and the live board.
  if (wantLatest) {
    const ttlMs = await searchSessionTtlMs();
    if (!isSessionFresh(Date.parse(groups[0][0].created_at), Date.now(), ttlMs)) {
      return NextResponse.json(
        { error: "no-live-hunt", hint: "Your last hunt has ended - it is saved in Trips." },
        { status: 404 }
      );
    }
  }

  // Gate: everything except the newest session needs trips-history.
  if (gi > 0 && !hasHistory) {
    return NextResponse.json(
      { error: "upgrade-required", feature: "trips-history" },
      { status: 402 }
    );
  }

  const group = groups[gi];
  const start = Date.parse(group[0].created_at);
  // ONE window object, shared with /api/deals and /api/deals/recheck - see
  // huntWindow. The three routes each carried their own copy of this arithmetic
  // and one of them (recheck) then queried without it entirely.
  const win = huntWindow(groups, gi);
  const inWindow = (iso: string) => win.contains(iso);

  // CLEARED MEANS CLEARED, AT ANY AGE.
  //
  // "Clear search" writes a `session-closed` marker row (see
  // /api/session/close), purges the outbox and tombstones every recipient - and
  // then the very next cold load restored the exact same hunt, because this
  // route never looked at the marker. Dismissing a hunt and having it come back
  // is worse than the staleness itself: it reads as the app ignoring you.
  //
  // The marker is a `whatsapp_messages` row with `to_number = 'session'`, which
  // the vendor rollup below skips (no vendorId), so it was invisible here.
  //
  // BOUNDS MATTER MORE THAN THEY LOOK. The marker must fall AFTER this group's
  // newest search and BEFORE the next group begins. Comparing against the
  // group's FIRST row instead would break the commonest real sequence there is -
  // search, clear, search again within the 30-minute grouping window - because
  // those two searches land in ONE group and the clear between them sits after
  // its start. The traveller's brand-new hunt would refuse to restore.
  const groupEndIso = group[group.length - 1].created_at;
  const nextGroupIso = gi > 0 ? groups[gi - 1][0].created_at : null;
  //
  // STRICT, because this is a gate rather than a display. Read permissively it
  // would answer `[]` during an outage - "not closed" - and a hunt the traveller
  // had explicitly cleared would come back. Unknown must refuse, not restore.
  //
  // ...AND CLEARED IS NOT THE ONLY WAY A HUNT CLOSES (audit F146). Three
  // writers stamp this one marker: the traveller's clear, the TTL stand-down
  // agent-loop fires when a shop answers past the window, and a locked
  // booking. Reading `kind` alone refused Re-open for all three and told the
  // traveller they had cleared a hunt they never touched. `reason` rides along
  // as a jsonb scalar; a hunt that merely went QUIET is exactly what Re-open
  // exists for, so only the clear and the booking are refused - and an
  // unlabelled legacy marker reads as a clear, so the strict refusal is still
  // the default.
  const closedRead = await sbSelectStrict<{ received_at: string; reason: string | null }>(
    "whatsapp_messages",
    `select=received_at,reason:raw->>reason&to_number=eq.session&raw->>sender=eq.${enc}&raw->>kind=eq.session-closed` +
      `&received_at=gt.${encodeURIComponent(groupEndIso)}` +
      (nextGroupIso ? `&received_at=lt.${encodeURIComponent(nextGroupIso)}` : "") +
      `&order=received_at.desc&limit=1`
  );
  if ("error" in closedRead && closedRead.error === "unavailable") {
    return NextResponse.json(
      { error: "unavailable", hint: "Could not reach your hunts just now." },
      { status: 503 }
    );
  }
  if ("rows" in closedRead && closedRead.rows.length) {
    const by = closedByOf(closedRead.rows[0]?.reason);
    if (by === "user") {
      return NextResponse.json(
        { error: "session-closed", closedBy: "user", hint: "You cleared this hunt." },
        { status: 404 }
      );
    }
    if (by === "deal") {
      return NextResponse.json(
        { error: "session-closed", closedBy: "deal", hint: "You booked from this hunt." },
        { status: 404 }
      );
    }
    // "expired": the agents stood down, nothing was thrown away. Fall through
    // and rebuild the workspace - reopenEpoch below stamps it fresh.
  }

  const withSnap = group.find((r) => Array.isArray(r.snapshot) && r.snapshot.length);
  const rfqRow = [...group].reverse().find((r) => r.rfq && typeof r.rfq === "object");
  const originRow = [...group].reverse().find((r) => r.lat != null && r.lng != null);
  const vehicleClass = [...group].reverse().find((r) => r.vehicle_class)?.vehicle_class ?? null;
  const radiusKm = [...group].reverse().find((r) => r.radius_km != null)?.radius_km ?? null;
  const source = group.find((r) => r.source)?.source ?? "demo";
  const query = group.find((r) => r.query_text)?.query_text ?? "";

  // 2. RFQ: the stamped snapshot wins; else the newest outbound raw.rfq in the
  // window; else a minimal RFQ from the recorded vehicle class.
  let rfq: Record<string, unknown> | null = rfqRow?.rfq ?? null;
  if (!rfq) {
    const outRows = await sbSelect<{ raw: { rfq?: Record<string, unknown> } | null; received_at: string }>(
      "whatsapp_messages",
      `select=raw,received_at&direction=eq.outbound&raw->>sender=eq.${enc}&order=received_at.desc&limit=40`
    ).catch(() => []);
    rfq = outRows.find((r) => inWindow(r.received_at) && r.raw?.rfq)?.raw?.rfq ?? null;
  }
  if (!rfq) {
    rfq = {
      vehicleClass: vehicleClass ?? "scooter",
      durationDays: 3,
      fulfillment: "any",
      accessories: [],
    };
  }

  // 3. Vendors: the snapshot rehydrated into full Vendor shapes. Fallback path
  // reconstructs the CONTACTED shops from outbound raws + offers (partial).
  let vendors: unknown[] = [];
  let partial = false;
  if (withSnap?.snapshot) {
    vendors = withSnap.snapshot.map((v) => ({
      id: v.id,
      name: v.name,
      lat: v.lat ?? originRow?.lat ?? 0,
      lng: v.lng ?? originRow?.lng ?? 0,
      rating: v.rating ?? 0,
      reviews: v.reviews ?? 0,
      vehicleClasses: v.vehicleClasses ?? (vehicleClass ? [vehicleClass] : []),
      fulfillment: v.fulfillment ?? ["pickup"],
      whatsapp: v.whatsapp ?? "",
      basePricePerDay: v.basePricePerDay ?? 0,
      partner: v.partner ?? false,
      demo: v.demo ?? false,
      placeId: v.placeId ?? undefined,
      address: v.address ?? undefined,
      distanceKm: v.distanceKm ?? undefined,
      photoUrl: v.photoUrl ?? undefined,
      stage: "queued",
    }));
  } else {
    partial = true;
    const [outRows, offerRows] = await Promise.all([
      sbSelect<{
        to_number: string;
        received_at: string;
        raw: { vendorId?: string; vendorName?: string } | null;
      }>(
        "whatsapp_messages",
        `select=to_number,received_at,raw&direction=eq.outbound&raw->>sender=eq.${enc}&received_at=gte.${encodeURIComponent(
          group[0].created_at
        )}&order=received_at.desc&limit=120`
      ).catch(() => []),
      sbSelect<{ vendor_id: string | null; vendor_name: string | null; created_at: string }>(
        "offers",
        `select=vendor_id,vendor_name,created_at&user_email=eq.${enc}&simulated=eq.false&order=created_at.desc&limit=120`
      ).catch(() => []),
    ]);
    // THE FALLBACK NEEDED THE SAME FENCE AS THE PRIMARY PATH.
    //
    // `offerRows` below was already window-filtered; `outRows` was not, so this
    // branch reached back over the last 120 outbound messages of ALL TIME and
    // pinned them onto whichever hunt was being restored. That is a second,
    // independent route to the stale-session bug, and it fires precisely when
    // the snapshot is missing - which happens on every `searches` row written by
    // /api/profile (a bare RFQ build records a row with no snapshot at all).
    const seen = new Map<string, { id: string; name: string }>();
    for (const m of outRows) {
      if (!inWindow(m.received_at)) continue;
      const id = m.raw?.vendorId || m.to_number;
      if (id && !seen.has(id)) seen.set(id, { id, name: m.raw?.vendorName || id });
    }
    for (const o of offerRows) {
      if (!inWindow(o.created_at)) continue;
      const id = o.vendor_id || o.vendor_name || "";
      if (id && !seen.has(id)) seen.set(id, { id, name: o.vendor_name || id });
    }
    vendors = [...seen.values()].map((v) => ({
      id: v.id,
      name: v.name,
      lat: originRow?.lat ?? 0,
      lng: originRow?.lng ?? 0,
      rating: 0,
      reviews: 0,
      vehicleClasses: vehicleClass ? [vehicleClass] : [],
      fulfillment: ["pickup"],
      whatsapp: /^\d{6,}$/.test(v.id) ? v.id : "",
      basePricePerDay: 0,
      partner: false,
      demo: false,
      stage: "queued",
    }));
  }

  if (!vendors.length) {
    return NextResponse.json({ error: "Nothing to restore from that hunt." }, { status: 404 });
  }

  // WHERE THEY LEFT OFF, not a blank board.
  //
  // Every restored shop used to come back stamped `stage: "queued"`, so
  // re-opening a hunt showed a list that looked like it had never run - the
  // conversations, the prices and the whole point of coming back were gone
  // until several polls had caught up, and for a hunt whose window has closed
  // they never came back at all. The state is right here in the same rows the
  // window is defined by, so it is restored WITH the shops.
  {
    const [msgRows, offerRows] = await Promise.all([
      sbSelect<{
        to_number: string;
        direction: string;
        received_at: string;
        raw: { vendorId?: string; sender?: string } | null;
      }>(
        "whatsapp_messages",
        `select=to_number,direction,received_at,raw&or=(raw->>sender.eq.${enc},raw->>receiver.eq.${enc})&order=received_at.desc&limit=250`
      ).catch(() => []),
      sbSelect<{
        vendor_id: string | null;
        price_per_day: number | null;
        list_price_per_day: number | null;
        currency: string | null;
        round: number | null;
        verified: boolean | null;
        created_at: string;
      }>(
        "offers",
        `select=vendor_id,price_per_day,list_price_per_day,currency,round,verified,created_at&user_email=eq.${enc}&simulated=eq.false&order=created_at.desc&limit=200`
      ).catch(() => []),
    ]);

    const messaged = new Set<string>();
    const replied = new Set<string>();
    for (const m of msgRows) {
      if (!inWindow(m.received_at)) continue;
      const id = m.raw?.vendorId;
      if (!id) continue;
      if (m.direction === "outbound") messaged.add(id);
      else replied.add(id);
    }
    const bestByVendor = new Map<string, (typeof offerRows)[number]>();
    for (const o of offerRows) {
      if (!o.vendor_id || !inWindow(o.created_at) || bestByVendor.has(o.vendor_id)) continue;
      if (o.price_per_day && o.price_per_day > 0) bestByVendor.set(o.vendor_id, o);
    }

    const durationDays =
      typeof (rfq as { durationDays?: unknown }).durationDays === "number"
        ? ((rfq as { durationDays: number }).durationDays as number)
        : 1;

    vendors = (vendors as Record<string, unknown>[]).map((v) => {
      const id = String(v.id ?? "");
      const priced = bestByVendor.get(id);
      if (priced) {
        const perDay = priced.price_per_day as number;
        return {
          ...v,
          stage: "offer-received",
          offer: {
            pricePerDay: perDay,
            listPricePerDay: priced.list_price_per_day ?? perDay,
            currency: priced.currency ?? "USD",
            totalPrice: Math.round(perDay * durationDays),
            includesInsurance: false,
            includesDelivery: false,
            message: "",
            round: priced.round ?? 0,
            verified: Boolean(priced.verified),
            simulated: false,
            // NOT `false` - UNKNOWN.
            //
            // `presentable` is a three-state field: true (the deal is complete),
            // false (we have checked and it is not), undefined (we have not
            // checked). Restore has read a price row and nothing else - no
            // deposit, no fulfillment, no thread state - so it knows only the
            // third thing. Stamping `false` was a positive claim, and it was
            // PERMANENT: the replies poll answers `st ? isComplete(...) :
            // undefined`, and a restored hunt whose thread state has aged out
            // returns undefined, which the client merges as
            // `r.presentable ?? v.offer?.presentable` - i.e. it can only ever
            // fall back to the false already sitting there. So every restored
            // offer carried "Your agent is still confirming the deposit and how
            // you get the vehicle" for the life of the session, about a
            // conversation that had finished days earlier.
            //
            // Undefined renders no banner (VendorCard tests `=== false`) and is
            // still polled (`presentable !== true`), so a live thread can raise
            // it to a real answer - which is exactly what "we have not checked"
            // should do.
            presentable: undefined,
          },
        };
      }
      if (replied.has(id)) return { ...v, stage: "negotiating" };
      if (messaged.has(id)) return { ...v, stage: "awaiting-response" };
      return v;
    });
  }

  // THE EPOCH A DELIBERATE RE-OPEN CARRIES (see `reopenEpoch`).
  //
  // This used to be `searchEpoch: start` unconditionally - the ORIGINAL hunt's
  // start - and the Find-deals screen refuses any stored blob whose epoch is
  // past the TTL. So the server served the hunt correctly and the CLIENT
  // deleted it on arrival, landing on a blank search screen. Every hunt in the
  // "Earlier hunts" drawer is past that cliff by construction, which is to say
  // the feature worked only for the hunts that did not need it.
  //
  // The TTL is not protecting us from an old hunt; it is protecting us from an
  // ancient epoch becoming the `since=` of every live poll. A re-open the
  // traveller asked for therefore starts its polling clock NOW, and the hunt's
  // own history rides in this payload (shops, stages, offers) instead of being
  // re-hydrated out of a week of activity rows. `huntStartedAt` keeps the real
  // start for anything that wants to SAY how old the hunt is.
  const ttlForReopen = await searchSessionTtlMs();
  const nowMs = Date.now();
  const searchEpoch = reopenEpoch(start, nowMs, ttlForReopen);
  const reopened = searchEpoch !== start;

  const payload = {
    vendors,
    rfq,
    source,
    sourceError: null,
    rawText: query,
    // THE LABEL IS THE REGION, AND IT WAS BEING THROWN AWAY.
    //
    // This returned `label: ""` unconditionally, and the client applies the
    // whole origin object. So a restored hunt had no region, and every surface
    // that passes `origin?.label` as `region` - the bargain draft, the mass
    // push, the market hint - passed nothing: /api/bargain-draft then resolves
    // currency to USD and drops the market floor (a floor is only adopted when
    // its currency matches). Re-opening a hunt silently disarmed the two levers
    // the negotiation runs on.
    origin:
      originRow?.lat != null && originRow?.lng != null
        ? {
            lat: originRow.lat,
            lng: originRow.lng,
            // Any row in the session may carry it (only the first search
            // stamped a label if the traveller edited nothing afterwards).
            label:
              group.find((r) => (r.origin_label ?? "").trim())?.origin_label?.trim() ?? "",
          }
        : null,
    radiusKm: typeof radiusKm === "number" ? radiusKm : 8,
    searchEpoch,
    /** When the hunt REALLY ran - never used as a polling floor. */
    huntStartedAt: group[0].created_at,
    /** The hunt's stable identity, so the client can tell Trips which card. */
    sid: sessionIdOf(group),
    /** True when the epoch was moved forward because the hunt is history. */
    reopened,
  };

  return NextResponse.json({ ok: true, partial, reopened, payload });
}
