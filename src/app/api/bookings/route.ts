import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbInsert, sbSelect, sbDelete, supabaseConfigured } from "@/lib/runtime-config";

// Persist confirmed bookings and list the caller's booking history.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const b = await req.json().catch(() => null);
  if (!b?.vendorName) {
    return NextResponse.json({ error: "booking payload required" }, { status: 400 });
  }

  // COMMITMENT LOCK: refuse a second confirmed booking with a DIFFERENT shop
  // inside 10 minutes - the double-booking window where two shops both hear
  // "yes". Re-booking the same shop (retry, edit) stays allowed.
  const thisVendorId = String(b.vendorId ?? "");
  const recent = await sbSelect<{ vendor_id: string | null; vendor_name: string }>(
    "bookings",
    `select=vendor_id,vendor_name&user_email=eq.${encodeURIComponent(
      session.email
    )}&status=eq.confirmed&created_at=gte.${encodeURIComponent(
      new Date(Date.now() - 10 * 60_000).toISOString()
    )}&order=created_at.desc&limit=1`
  ).catch(() => []);
  if (
    recent[0] &&
    thisVendorId &&
    recent[0].vendor_id &&
    recent[0].vendor_id !== thisVendorId
  ) {
    return NextResponse.json(
      {
        error: `You just locked a deal with ${recent[0].vendor_name}. To book a different shop, remove that booking first (My deals).`,
        alreadyCommitted: true,
        vendorName: recent[0].vendor_name,
      },
      { status: 409 }
    );
  }

  // TRUST NOTHING NUMERIC FROM THE CLIENT. The daily price and duration define
  // the total; recompute it server-side so a tampered/garbage client total can
  // never be persisted as the money record.
  const pricePerDay = Math.max(0, Number(b.pricePerDay) || 0);
  const durationDays = Math.min(Math.max(Math.floor(Number(b.durationDays) || 1), 1), 90);
  const totalPrice = Math.round(pricePerDay * durationDays);

  // Validate the pickup date/time: a real format, and never in the past
  // (compared in the shop's local wall-clock, which is how it is stored).
  const scheduledAt = typeof b.scheduledAt === "string" ? b.scheduledAt : "";
  if (scheduledAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(scheduledAt)) {
    return NextResponse.json({ error: "Invalid pickup date/time." }, { status: 400 });
  }
  // THE RENTAL WINDOW IS DECIDED HERE, BY PLAN.
  //
  // This route had no plan check at all: "free is same-day only" was enforced
  // in the outreach composer and nowhere else, so a client posting a future
  // pickup date simply got one. A rule enforced at one surface out of four is
  // not a rule. lib/rental-window is the single authority every surface calls,
  // including the client - which now only DISPLAYS what the server decided.
  if (scheduledAt) {
    const { resolveWindow } = await import("@/lib/rental-window");
    const decision = resolveWindow({
      plan: session.plan,
      requested: scheduledAt.slice(0, 10),
      nowMs: Date.now(),
      timeZone: typeof b.timeZone === "string" ? b.timeZone : undefined,
    });
    if (decision.adjusted) {
      // ...and it also COUNTS. A free plan posting a future pickup date
      // straight at this endpoint is the least ambiguous bypass evidence the
      // system can observe, and it used to reach the ladder not at all: the
      // server refused the booking and forgot it, so the same traveller could
      // try every hour and never climb a rung. One signal, weighted like any
      // other, decaying like any other - never a verdict on its own.
      const { recordSignal } = await import("@/lib/integrity/store");
      await recordSignal({
        email: session.email,
        plan: session.plan,
        kind: "future-pickup",
        evidence: `booking posted for ${scheduledAt.slice(0, 10)}; plan allows from ${decision.startDate}`,
      }).catch(() => {});
      return NextResponse.json(
        {
          error: decision.reason,
          window: { startDate: decision.startDate, maxStartDate: decision.maxStartDate },
          upgrade: decision.daysAhead === 0,
        },
        { status: 400 }
      );
    }
  }
  // Return date, if given, must be after the pickup date.
  const returnDate = typeof b.returnDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.returnDate) ? b.returnDate : null;
  if (returnDate && scheduledAt && returnDate < scheduledAt.slice(0, 10)) {
    return NextResponse.json({ error: "Return date must be after pickup." }, { status: 400 });
  }

  const fulfillment = ["in-store", "hotel-delivery"].includes(String(b.fulfillment))
    ? String(b.fulfillment)
    : "in-store";

  const bookingBase = {
    user_email: session.email,
    vendor_id: String(b.vendorId ?? ""),
    vendor_name: String(b.vendorName),
    price_per_day: pricePerDay,
    total_price: totalPrice,
    fulfillment,
    scheduled_at: scheduledAt || null,
    status: "confirmed",
  };
  // Extra rental fields - added incrementally, so try the richest insert first
  // and fall back through pending-migration column sets (sbInsert fails
  // silently on an unknown column). A booking must NEVER be lost to a migration.
  const extra = {
    currency: String(b.currency ?? "USD").slice(0, 6),
    duration_days: durationDays,
    return_date: returnDate,
    start_date: scheduledAt ? scheduledAt.slice(0, 10) : null,
    delivery_address: fulfillment === "hotel-delivery" ? String(b.deliveryAddress ?? "").slice(0, 200) || null : null,
    one_way_dropoff: b.oneWayDropOff ? String(b.oneWayDropOff).slice(0, 120) : null,
    driver_age: Number.isFinite(Number(b.driverAge)) ? Math.floor(Number(b.driverAge)) : null,
    scheduled_tz: "shop-local", // scheduled_at is the shop's wall-clock, no offset
    // The negotiation this money record came from (bookings.ts) - without it a
    // booking could never be traced to its conversation.
    thread_key: (await import("@/lib/bookings")).bookingThreadKey(
      session.email,
      typeof b.whatsapp === "string" ? b.whatsapp : null
    ),
    // THE TRIP MUST OUTLIVE THE SEARCH THAT FOUND IT.
    //
    // The shop's number, where it is, and what the traveller saved all lived in
    // the live search session - which expires. A traveller standing outside the
    // shop with a question could find the app had forgotten how to reach it.
    // Snapshotted at close time, so the trip is self-contained from then on.
    meta: {
      whatsapp: typeof b.whatsapp === "string" ? b.whatsapp.slice(0, 32) : null,
      placeId: typeof b.placeId === "string" ? b.placeId.slice(0, 120) : null,
      lat: Number.isFinite(Number(b.lat)) ? Number(b.lat) : null,
      lng: Number.isFinite(Number(b.lng)) ? Number(b.lng) : null,
      address: typeof b.address === "string" ? b.address.slice(0, 200) : null,
      // What the hunt was worth, frozen. Recomputing it later would need the
      // other shops' quotes, which is exactly the data that expires.
      savedPerDay: Number.isFinite(Number(b.savedPerDay)) ? Number(b.savedPerDay) : null,
      benchmarkPerDay: Number.isFinite(Number(b.benchmarkPerDay)) ? Number(b.benchmarkPerDay) : null,
      shopsCompared: Number.isFinite(Number(b.shopsCompared)) ? Math.floor(Number(b.shopsCompared)) : null,
    },
  };
  let stored = await sbInsert("bookings", [{ ...bookingBase, ...extra }]);
  if (!stored) {
    stored = await sbInsert("bookings", [{ ...bookingBase, currency: extra.currency }]);
    // The third tier's result was DISCARDED, and `{ok:true}` was returned
    // unconditionally. So with Supabase configured and unreachable, all three
    // writes failed, the money record vanished, and the traveller was told the
    // booking was confirmed. Nothing was logged, and the commitment lock above
    // reads the same table - so the double-booking guard opened at the same
    // moment. Same shape as the setPlan defect documented in access.ts:341;
    // this path never got the same treatment.
    if (!stored) stored = await sbInsert("bookings", [bookingBase]);
  }

  // FUNNEL LEDGER: a stored booking is the funnel reaching `booked`. The
  // traveller committing to this shop is explicit availability evidence, so it
  // may pull the thread out of out_of_stock. No-op when the sheet carried no
  // shop number (the ledger needs the thread key).
  if (stored) {
    const { advanceThreadStage } = await import("@/lib/funnel/stages");
    await advanceThreadStage(
      {
        userEmail: session.email,
        toNumber: typeof b.whatsapp === "string" ? b.whatsapp : "",
        vendorId: String(b.vendorId ?? "") || undefined,
        vendorName: String(b.vendorName),
      },
      "booked",
      "booking stored",
      { overridesOutOfStock: true }
    ).catch(() => {});
  }

  if (!stored && supabaseConfigured()) {
    // Demo mode (no Supabase) is a supported configuration and must still
    // answer ok - hence the `supabaseConfigured()` guard. A CONFIGURED database
    // that refused all three writes is a different thing entirely, and the one
    // answer that is never acceptable is "confirmed".
    void sbInsert("agent_events", [
      {
        kind: "booking-write-failed",
        user_email: session.email,
        vendor_name: String(b.vendorName).slice(0, 120),
        detail: `all 3 insert tiers failed; total=${totalPrice} ${extra.currency}`,
      },
    ]).catch(() => false);
    return NextResponse.json(
      {
        error:
          "We could not save this booking just now, so we have not locked it in. Nothing was charged. Please try again in a moment - the shop has not been told anything yet.",
        stored: false,
      },
      { status: 503 }
    );
  }

  return NextResponse.json({ ok: true, totalPrice, currency: extra.currency });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const filter = `user_email=eq.${encodeURIComponent(session.email)}&order=created_at.desc&limit=25`;
  let rows = await sbSelect(
    "bookings",
    `select=id,vendor_id,vendor_name,price_per_day,total_price,currency,fulfillment,scheduled_at,return_date,delivery_address,driver_age,status,created_at,meta&${filter}`
  );
  if (rows.length === 0) {
    // Pre-migration fallbacks (a select naming an unknown column fails as []).
    rows = await sbSelect(
      "bookings",
      `select=id,vendor_name,price_per_day,total_price,currency,fulfillment,scheduled_at,status,created_at&${filter}`
    );
  }
  if (rows.length === 0) {
    rows = await sbSelect(
      "bookings",
      `select=id,vendor_name,price_per_day,total_price,fulfillment,scheduled_at,status,created_at&${filter}`
    );
  }
  return NextResponse.json({ bookings: rows });
}

// The traveller's own lifecycle taps (bookings.ts doctrine: the funnel never
// asserts what nobody witnessed - so picked_up/completed are recorded HERE,
// from the person who witnessed them). Body: { id, action } with action one of
// picked_up | completed | cancelled (+ optional reason). Ownership and the
// forward-only rules live in advanceBooking's atomic PATCH filter.
export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const action = String(body.action ?? "");
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const { advanceBooking } = await import("@/lib/bookings");
  const nowIso = new Date().toISOString();
  let res;
  if (action === "picked_up") {
    res = await advanceBooking(id, session.email, "picked_up", "traveller tapped 'I picked it up'", {
      picked_up_at: nowIso,
    });
  } else if (action === "completed") {
    res = await advanceBooking(id, session.email, "completed", "traveller tapped 'Trip completed'", {
      completed_at: nowIso,
    });
  } else if (action === "cancelled") {
    res = await advanceBooking(id, session.email, "cancelled", "traveller cancelled", {
      cancelled_at: nowIso,
      cancel_reason: String(body.reason ?? "").slice(0, 200) || null,
    });
  } else {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  // advanced:false is an honest state, not an error: the booking is already
  // at/past this status (a double tap, or another device won the race).
  return NextResponse.json({ ok: res.advanced, status: res.row?.status ?? null });
}

// Remove a past booking from the caller's own history (item #10). Strictly
// scoped to the signed-in user - nobody can delete another user's row.
export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  await sbDelete(
    "bookings",
    `id=eq.${id}&user_email=eq.${encodeURIComponent(session.email)}`
  );
  return NextResponse.json({ ok: true });
}
