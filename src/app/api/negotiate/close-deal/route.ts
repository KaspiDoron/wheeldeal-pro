import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { placeDetails } from "@/lib/google";
import { runUserAction } from "@/lib/graph/engine";
import { sendFromUser, disconnectInstance } from "@/lib/evolution";
import { sbSelect, sbInsert, sbDelete, sbDeleteReturning } from "@/lib/runtime-config";
import { cancelSends, clearCancellation } from "@/lib/wa/cancellations";
import { digitsOnly } from "@/lib/phone";
import { finishBeforeResponse } from "@/lib/after";

// Close-deal handoff: the traveller confirmed a deal on a card. We (1) send the
// shop a final closing message via the engine's closing-message node, then (2)
// DISCONNECT the traveller's WhatsApp so they continue the conversation in
// their own WhatsApp app - they can reconnect anytime from Profile.
//
// Body: { to?, placeId?, pricePerDay?, currency?, fulfillment?, when?, address?,
//         dealTermsAccepted? }
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  let to = String(body.to ?? "").trim();
  if (!to && body.placeId) {
    const details = await placeDetails(String(body.placeId)).catch(() => null);
    to = details?.phone ?? "";
  }
  if (!to) return NextResponse.json({ sent: false, reason: "no-phone" });
  let digits = digitsOnly(to);

  // KNOWN-THREAD GUARD (same pattern as the pickup-consent route): a closing
  // message may only go to a number THIS user's agent actually negotiated
  // with. Without this, a spoofed `to` would message a stranger AND the
  // session-close side effects below would nuke the user's real negotiations.
  // Resolving (rather than checking) also means the close reaches the number we
  // hold, so a shop stored under another spelling can still be closed.
  {
    const { resolveKnownThreadNumber } = await import("@/lib/wa/known-thread");
    const stored = await resolveKnownThreadNumber(session.email, digits);
    if (!stored) {
      return NextResponse.json(
        { sent: false, reason: "unknown-destination" },
        { status: 400 }
      );
    }
    digits = stored;
  }

  // THE DEAL-TERMS ACKNOWLEDGEMENT, RECORDED WHERE IT IS MADE.
  //
  // The booking sheet's "I understand WheelDeal takes no responsibility for the
  // vehicle, deposits, accidents or disputes" checkbox gated its own submit
  // button on the CLIENT and was never sent anywhere - so at the single moment
  // the traveller commits real money to a stranger with a motorbike, the only
  // record of the acknowledgement was a React state variable that stopped
  // existing when the sheet closed.
  //
  // The commitment is this route, so the record belongs to this route: it lands
  // whether the closing message sends, queues or fails, because what is being
  // recorded is the traveller's acceptance, not the shop's reachability.
  if (body.dealTermsAccepted === true) {
    const { recordConsent } = await import("@/lib/consent");
    await finishBeforeResponse("deal-terms-consent", () =>
      recordConsent({
        email: session.email,
        kind: "deal_terms",
        context: {
          vendorId: body.vendorId ?? null,
          placeId: body.placeId ?? null,
          pricePerDay: body.pricePerDay ?? null,
          currency: body.currency ?? null,
          fulfillment: body.fulfillment ?? null,
        },
      })
    );
  }

  // COMMITMENT LOCK: one confirmed deal at a time. If a DIFFERENT shop was
  // booked in the last 10 minutes, refuse - this is the guard against two
  // shops both being told "yes" in the same excited minute (double booking).
  try {
    const recent = await sbSelect<{ vendor_name: string; vendor_id: string | null }>(
      "bookings",
      `select=vendor_name,vendor_id&user_email=eq.${encodeURIComponent(
        session.email
      )}&status=eq.confirmed&created_at=gte.${encodeURIComponent(
        new Date(Date.now() - 10 * 60_000).toISOString()
      )}&order=created_at.desc&limit=1`
    );
    const other = recent[0];
    const thisVendorId = body.vendorId ? String(body.vendorId) : null;
    if (other && thisVendorId && other.vendor_id && other.vendor_id !== thisVendorId) {
      return NextResponse.json(
        {
          sent: false,
          reason: "already-committed",
          vendorName: other.vendor_name,
        },
        { status: 409 }
      );
    }
  } catch {
    /* lock is best-effort - the confirm dialog is still the human gate */
  }

  // 1) Tell the shop, via the closing-message node (varied, warm, no auto-delay
  //    - the traveller is watching). ORDER MATTERS: clear any tombstone on
  //    THIS shop first (confirming the deal is an explicit user action - the
  //    closing message must be allowed to leave), send, and only THEN
  //    tombstone the whole session below.
  await clearCancellation(session.email, digits).catch(() => {});
  let sent = false;
  // The closing message may be PARKED rather than sent (anti-ban gate, shop
  // closed overnight). That is a success state, not a failure: the row drains
  // at the next safe slot. Track it so (a) the outbox purge below never
  // deletes it, and (b) the traveller is told "queued", not nothing.
  let queued = false;
  let queuedUntil: string | null = null;
  let closingRowId: number | null = null;
  try {
    const result = await runUserAction({
      userEmail: session.email,
      toDigits: digits,
      kind: "user-close-deal",
      // Google "open now" from the card - the SAME truth the user sees, so a
      // deal-close on a live conversation is never queued as "shop closed".
      shopOpenNow: typeof body.openNow === "boolean" ? body.openNow : undefined,
      payload: {
        pricePerDay: Number(body.pricePerDay) || undefined,
        currency: body.currency ? String(body.currency) : undefined,
        fulfillment: body.fulfillment ? String(body.fulfillment) : undefined,
        when: body.when ? String(body.when) : undefined,
        address: body.address ? String(body.address) : undefined,
      },
      send: (senderKey, dest, text) => sendFromUser(senderKey, dest, text),
    });
    sent = result?.delivered?.delivered === "sent";
    queued = result?.delivered?.delivered === "queued";
    queuedUntil = result?.delivered?.queuedUntil ?? null;
    closingRowId = result?.delivered?.outboxRowId ?? null;
  } catch {
    /* the disconnect + wa.me link below still let the traveller finish */
  }

  // 1.5) Wind the REST of the session down through the existing, engine-
  //      respected mechanism: stamp session-closed, purge queued sends +
  //      strategic wakeups (AWAITED - a race here could fire a tick against
  //      the closing session), and tombstone every recipient including this
  //      shop (the deal is done - nothing automated chases it afterwards).
  // NEVER PURGE THE CLOSING MESSAGE ITSELF. When the guard parked it, the row
  // sits in this very outbox - an unfiltered purge deleted the booking handoff
  // the traveller just watched the app promise to send.
  const purged = await sbDeleteReturning<{ to_number: string }>(
    "wa_outbox",
    `sender_key=eq.${encodeURIComponent(session.email)}${
      closingRowId ? `&id=neq.${closingRowId}` : ""
    }`
  ).catch(() => [] as { to_number: string }[]);
  // EXACT owner match on the stamped column only. The old
  // `thread_key=like.<email>:*` sweep was a cross-user hazard (an underscore in
  // the email is a single-char SQL wildcard that could delete another user's
  // wakeups); the deal-closed marker below is the backstop for any pre-column row.
  // Delete EVERY wakeup kind (tick, judge, session-judge) for this owner - not
  // just kind=eq.tick. A surviving judge/session-judge wakeup was the "agents
  // replied overnight after I closed the deal" hole: those drain branches would
  // still fire a follow-up against a dead session.
  await sbDelete(
    "graph_wakeups",
    `user_email=eq.${encodeURIComponent(session.email)}`
  ).catch(() => {});
  // Tombstone every recently-messaged shop (not just outbox-pending ones): a
  // mid-negotiation sibling awaiting a reply has no outbox row, but the
  // deal-closed session must silence it too. The tombstone is the hard,
  // guard-enforced veto (session-closed alone is only a soft, LLM-overridable
  // director fact).
  // DISTINCT shops via wa_recipient_state (one row per contacted shop), recency-
  // bounded - a row-limited whatsapp_messages scan could miss an early quiet
  // sibling in a heavy session.
  const activeShops = await sbSelect<{ to_number: string }>(
    "wa_recipient_state",
    `select=to_number&sender_key=eq.${encodeURIComponent(
      session.email
    )}&last_sent_at=gte.${encodeURIComponent(
      new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
    )}&limit=500`
  ).catch(() => [] as { to_number: string }[]);
  const closeDigits = [
    ...new Set(
      [digits, ...purged.map((r) => r.to_number), ...activeShops.map((r) => r.to_number)].filter(
        Boolean
      )
    ),
  ];
  for (const d of closeDigits) {
    await cancelSends(session.email, d, "deal-closed").catch(() => {});
  }
  await sbInsert("whatsapp_messages", [
    {
      to_number: "session",
      body: "(deal locked - session closed)",
      type: "system",
      direction: "outbound",
      raw: { sender: session.email, kind: "session-closed", reason: "deal-closed" },
    },
  ]).catch(() => {});

  // FUNNEL LEDGER: the winning thread reached `booked` (the traveller just
  // locked this deal - explicit evidence, so it may leave out_of_stock too).
  // The /api/bookings insert stamps the same thing; whichever lands first
  // wins and the other short-circuits.
  {
    const { advanceThreadStage } = await import("@/lib/funnel/stages");
    await advanceThreadStage(
      {
        userEmail: session.email,
        toNumber: digits,
        vendorId: body.vendorId ? String(body.vendorId) : undefined,
        transport: "evolution",
      },
      "booked",
      "traveller locked the deal",
      { overridesOutOfStock: true }
    ).catch(() => {});
  }

  // SELF-IMPROVEMENT LOOP (V2-4): bank the price actually achieved so future
  // sessions in this market start from a real prior. Best-effort, never blocks
  // the close. Resolves the region + vehicle from the user's most recent search.
  try {
    const price = Number(body.pricePerDay);
    if (price > 0) {
      const [{ rememberDeal }, { sbSelect: sel }] = await Promise.all([
        import("@/lib/spte/memory"),
        import("@/lib/runtime-config"),
      ]);
      const rows = await sel<{ query_text: string | null; vehicle_class: string | null }>(
        "searches",
        `select=query_text,vehicle_class&user_email=eq.${encodeURIComponent(session.email)}&order=created_at.desc&limit=1`
      ).catch(() => []);
      const region = typeof body.region === "string" ? body.region : "";
      if (region && rows[0]?.vehicle_class) {
        await rememberDeal({
          regionKey: region.toLowerCase(),
          rfq: {
            vehicleClass: rows[0].vehicle_class as "car" | "motorbike" | "scooter",
            transmission: "any",
            durationDays: Number(body.durationDays) || 1,
            accessories: [],
            fulfillment: "any",
            vendorMessage: "",
          },
          currency: body.currency ? String(body.currency) : "USD",
          pricePerDay: price,
          listPrice: Number(body.listPricePerDay) || undefined,
          tactic: "closed-deal",
        });
      }
    }
  } catch {
    /* learning is best-effort */
  }

  // 2) The traveller's WhatsApp STAYS LINKED. Closing a deal used to
  //    logout + DELETE the instance (a full QR re-link every single time) -
  //    that hard teardown was the "my WhatsApp disconnected by itself" bug,
  //    and nothing needs it: the session-closed marker + tombstones above
  //    already silence the agents, and the wa.me link works regardless.
  //    Explicit disconnect remains available in Profile. Rollback switch:
  //    KEEP_WA_ON_CLOSE=off restores the old teardown for one release.
  let disconnected = false;
  try {
    const { getConfig } = await import("@/lib/runtime-config");
    const keep = ((await getConfig("KEEP_WA_ON_CLOSE")) ?? "").toLowerCase() !== "off";
    if (!keep) {
      await disconnectInstance(session.email);
      disconnected = true;
    }
  } catch {
    /* best-effort - the traveller can also disconnect from Profile */
  }

  // The wa.me deep link opens the exact shop chat in the traveller's own app.
  // `queued` is a SUCCESS state (the guard parked the closing message for the
  // next safe slot; the deal-close exemption in wa-guard lets it drain through
  // the tombstones) - the client must not render it as a failure.
  return NextResponse.json({
    sent,
    queued,
    queuedUntil,
    disconnected,
    stillLinked: !disconnected,
    waLink: `https://wa.me/${digits}`,
  });
}

export const maxDuration = 60;
