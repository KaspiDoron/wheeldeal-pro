import { NextResponse } from "next/server";
import { seedVendors } from "@/lib/vendors";
import { haversineKm } from "@/lib/geo";
import { findRealVendors } from "@/lib/google";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";
import type { Vendor, VehicleClass, Fulfillment } from "@/lib/types";
import { can } from "@/lib/entitlements";

interface Body {
  /** `label` is the place the traveller NAMED, and it is the app's `region` -
   *  the input that decides the negotiation currency and whether the market
   *  floor applies. Storing only the coordinates is what made a restored hunt
   *  bargain in USD (see the origin_label note in supabase/schema.sql). */
  origin: { lat: number; lng: number; label?: string };
  radiusKm: number;
  vehicleClass?: VehicleClass | "any";
  fulfillment?: Fulfillment;
  minRating?: number;
  // Full RFQ, echoed by the client so the search row can snapshot it for Trips
  // restore. Optional - discovery works without it.
  rfq?: Record<string, unknown>;
  /** Panel-built fields, sent when discovery starts BEFORE the RFQ exists. */
  fields?: Record<string, unknown>;
  /** The traveller's app language - Google localises addresses and opening
   *  hours to it (owner report 3, item 10). Validated in findRealVendors. */
  lang?: string;
}

// Vendor discovery. With a Google Maps key this returns REAL rental businesses
// from Google Places. Demo seeds appear ONLY when no key is configured; if a
// key IS configured but Google rejects it, we return the exact error instead
// of silently showing dummy shops.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { killSwitchOn, checkDailyLimit } = await import("@/lib/usage");
  if (await killSwitchOn()) {
    return NextResponse.json(
      { error: "WheelDeal is temporarily paused by the owner." },
      { status: 503 }
    );
  }
  // Plan-aware (W-beta30): Ultra rides 4x, pro 2x - the flat 5/day wall told
  // a tester sold "Unlimited daily searches" that the cap "keeps the service
  // free for everyone", on day one, five minutes in.
  const gate = await checkDailyLimit("search", session.email, "LIMIT_SEARCHES_PER_DAY", {
    plan: session.plan,
  });
  if (!gate.allowed) {
    const paid = session.plan === "pro" || session.plan === "ultra";
    return NextResponse.json(
      {
        error: paid
          ? `Daily search limit reached (${gate.limit}/day fair use). It resets tomorrow - your live hunts keep negotiating meanwhile.`
          : `Daily search limit reached (${gate.limit}/day) - this keeps the service free for everyone. Try again tomorrow.`,
      },
      { status: 429 }
    );
  }
  // THE DEBIT THIS GATE READS, WHICH NOTHING WAS WRITING.
  //
  // `checkDailyLimit("search", ...)` counts `api_usage` rows of kind `search`
  // scoped to this user. The only searches ever recorded were
  // `recordApi("places_search")` inside lib/google - a DIFFERENT kind, and with
  // no user_email at all (it is the COST tracker: whose spend, not whose
  // quota). So the durable, cross-instance half of this cap summed to zero
  // forever, and all that remained was a per-instance in-memory counter that a
  // cold start resets - i.e. on Cloud Run, effectively no cap.
  //
  // Same shape as /api/translate's debit, which is the one that got it right.
  // Fire-and-forget: a search must never fail because its meter did.
  const { recordApi } = await import("@/lib/usage");
  void recordApi("search", 1, session.email).catch(() => {});

  const body = (await req.json().catch(() => null)) as Body | null;
  // Validate BOTH coordinates and their ranges - a valid lat with a string/NaN
  // lng silently produced NaN haversine distances (every vendor filtered out) and
  // a corrupt searches row.
  const lat = body?.origin?.lat;
  const lng = body?.origin?.lng;
  if (
    !body?.origin ||
    typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180
  ) {
    return NextResponse.json({ error: "valid origin (lat/lng) required" }, { status: 400 });
  }
  const radius = Math.min(50, Math.max(1, body.radiusKm || 8));
  const vClass: VehicleClass =
    body.vehicleClass && body.vehicleClass !== "any" ? body.vehicleClass : "car";

  // THE FAST PATH'S SNAPSHOT. Discovery now starts in the same tick as the
  // profiler (see startSearch), so on the panel path it arrives before the RFQ
  // exists. The fields are handed over instead and the snapshot is derived here
  // with the SAME pure function the profiler uses - no second opinion, no LLM.
  if (!body.rfq && body.fields && typeof body.fields === "object") {
    const { deterministicRFQ } = await import("@/lib/agents");
    try {
      body.rfq = { ...deterministicRFQ(body.fields) } as Record<string, unknown>;
    } catch {
      /* a malformed panel payload must not cost the traveller their search */
    }
  }

  const real = await findRealVendors(body.origin, radius, vClass, body.lang);
  let vendors: Vendor[];
  let source: "google" | "demo" | "google-error";
  let sourceError: string | undefined;

  if (real.vendors) {
    source = "google";
    vendors = real.vendors.filter((v) => (v.distanceKm ?? 999) <= radius);
  } else if (real.error) {
    // A key is configured but Google refused it - never mask this with demo data.
    source = "google-error";
    sourceError = real.error;
    vendors = [];
  } else {
    source = "demo";
    vendors = seedVendors(body.origin)
      .map((v) => ({ ...v, distanceKm: haversineKm(body.origin, v) }))
      .filter((v) => (v.distanceKm ?? 999) <= radius)
      .filter(
        (v) =>
          !body.vehicleClass ||
          body.vehicleClass === "any" ||
          v.vehicleClasses.includes(body.vehicleClass)
      );
  }

  if (body.fulfillment && body.fulfillment !== "any") {
    vendors = vendors.filter((v) => v.fulfillment.includes(body.fulfillment as Fulfillment));
  }
  if (body.minRating) {
    vendors = vendors.filter((v) => v.rating >= (body.minRating as number));
  }
  vendors.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));

  // Social proof: how many WheelDeal bookings each shop already has.
  try {
    // SCOPED TO THE SHOPS ON THIS SCREEN, NOT THE WHOLE TABLE.
    //
    // This read the entire `bookings` table - no filter, no order - on EVERY
    // discovery request, capped at 2000 rows. The cross-user scope is
    // deliberate (that is what makes it social proof) but the cap is not: past
    // 2000 rows the counts come from an arbitrary, PostgREST-order-dependent
    // slice, so the "orders" number a traveller sees becomes wrong and unstable
    // with no signal anywhere. Before that, every search paid a full-table read.
    //
    // A search returns tens of shops, so filtering to those ids is both bounded
    // and exact - and the row count now scales with the RESULT, not with the
    // lifetime size of the table.
    const { sbSelect } = await import("@/lib/runtime-config");
    const ids = vendors.map((v) => v.id).filter(Boolean).slice(0, 60);
    const counts: Record<string, number> = {};
    if (ids.length) {
      const list = ids.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
      const rows = await sbSelect<{ vendor_id: string }>(
        "bookings",
        `select=vendor_id&vendor_id=in.(${encodeURIComponent(list)})&limit=5000`
      );
      for (const r of rows) counts[r.vendor_id] = (counts[r.vendor_id] ?? 0) + 1;
    }
    vendors = vendors.map((v) => ({ ...v, orders: counts[v.id] ?? 0 }));
  } catch {}

  // Save the search to agent memory (no-op without Supabase). Snapshot-forward
  // (issue 8): stamp the RFQ + a COMPACT shop snapshot so this hunt can be
  // re-opened later from Trips with its full Find-Deals state, not just the
  // shops that ended up messaged. Kept small (the fields the card needs) so the
  // jsonb stays light. Retries WITHOUT the new columns for a pre-migration DB.
  const snapshot = vendors.slice(0, 60).map((v) => ({
    id: v.id,
    name: v.name,
    whatsapp: v.whatsapp ?? "",
    placeId: v.placeId ?? null,
    rating: v.rating ?? null,
    reviews: v.reviews ?? null,
    distanceKm: v.distanceKm ?? null,
    lat: v.lat ?? null,
    lng: v.lng ?? null,
    address: v.address ?? null,
    vehicleClasses: v.vehicleClasses,
    fulfillment: v.fulfillment,
    partner: v.partner,
    demo: v.demo,
    basePricePerDay: v.basePricePerDay,
    photoUrl: v.photoUrl ?? null,
  }));
  // SEATBELT: `origin_label` arrives by `alter table ... add column if not
  // exists`, so a database that has not re-run schema.sql does not have it, and
  // PostgREST rejects a whole record for one unknown column. A missing column
  // must cost the label, never the search row.
  const { tableReady } = await import("@/lib/schema-probe");
  const label = String(body.origin.label ?? "").trim().slice(0, 200);
  const hasLabel = label ? (await tableReady("searches", "origin_label")) === "ready" : false;
  const searchRow = {
    user_email: session?.email ?? null,
    lat: body.origin.lat,
    lng: body.origin.lng,
    ...(hasLabel ? { origin_label: label } : {}),
    radius_km: radius,
    vehicle_class: vClass,
    source,
    results: vendors.length,
  };
  const rfqSnap =
    body.rfq && typeof body.rfq === "object" ? (body.rfq as Record<string, unknown>) : null;
  const ok = await sbInsert("searches", [{ ...searchRow, rfq: rfqSnap, snapshot }]).catch(
    () => false
  );
  if (ok === false) await sbInsert("searches", [searchRow]).catch(() => {});

  // AN ULTRA INSIGHT THAT SHIPS TO EVERYONE IS NOT AN ULTRA INSIGHT.
  //
  // `fastResponder` marks the fastest-replying quartile of shops - the signal
  // behind the Ultra-only "reply speed" filter (entitlements:
  // fast-responder-filter). Discovery stamped it on every vendor and the route
  // returned it to every plan, so the whole value of the feature was sitting in
  // a free user's network tab. Stripped on the way out for anyone without the
  // entitlement, which is where the plan is actually known.
  const canSeeSpeed = can(session.plan, "fast-responder-filter");
  const payload = canSeeSpeed
    ? vendors
    : vendors.map((v) => (v.fastResponder ? { ...v, fastResponder: undefined } : v));

  return NextResponse.json({ vendors: payload, source, sourceError });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
