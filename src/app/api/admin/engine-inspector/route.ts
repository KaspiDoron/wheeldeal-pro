import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect, sbCountDark } from "@/lib/runtime-config";
import { visionAccuracy } from "@/lib/vision-reconcile";
import {
  bucketTurnsPerHour,
  moveMix,
  providerMix,
  latencyStats,
  avgBargainMarginPct,
  leverageUsePct,
  medianShopReplyMins,
  type ReplyEvent,
} from "@/lib/admin/engine-stats";

// SESSION BLACKBOARD INSPECTOR (owner-only). A single live snapshot of the
// ENGINE_V3 (SPTE) runtime: recent single-pass turns with their move + model
// route + scratchpad, any graph-engine failovers, the outbound queue health, WA
// socket liveness, and the most recent inbound webhook confirmations. Everything
// degrades gracefully - a missing table yields an empty section, never a 500.

export const dynamic = "force-dynamic";

type EventRow = { kind: string; vendor_name?: string | null; detail?: string | null; created_at?: string };

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sinceIso = new Date(Date.now() - 6 * 3600_000).toISOString();

  // ---- ENGINE_V3 turns + failovers (the ReAct execution telemetry) ----------
  const events = await sbSelect<EventRow>(
    "agent_events",
    `select=kind,vendor_name,detail,created_at&kind=in.(engine-v3-turn,engine-v3-fallback,engine-graph-turn,wa-send-unconfirmed,send-dropped,wa-send-stale)&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&order=created_at.desc&limit=60`
  ).catch(() => [] as EventRow[]);

  const turns = events
    .filter((e) => e.kind === "engine-v3-turn")
    .map((e) => {
      let d: Record<string, unknown> = {};
      try {
        d = JSON.parse(e.detail ?? "{}");
      } catch {
        /* keep empty */
      }
      return { shop: e.vendor_name ?? "shop", at: e.created_at, ...d };
    })
    .slice(0, 30);

  const fallbacks = events.filter((e) => e.kind === "engine-v3-fallback").length;
  const unconfirmed = events.filter((e) => e.kind === "wa-send-unconfirmed").length;

  // WHAT THE COUNTS WERE HIDING.
  //
  // "5 failovers in 6h" was rendered as a bare number while the rows behind it
  // carried the vendor AND the exception message - already fetched, already in
  // memory, thrown away. So the one question worth asking ("which shop, and
  // why?") could not be answered from the panel that raised the alarm.
  //
  // Same for the terminal drops: a message refused for good (duplicate,
  // rfq-dedup, engagement-halt) never touches wa_outbox, so the queue view
  // structurally cannot show it. Without these rows a thread that got no reply
  // looked identical to a thread with nothing to say.
  const detailOf = (e: EventRow) => ({
    shop: e.vendor_name ?? "shop",
    at: e.created_at,
    detail: (e.detail ?? "").slice(0, 300),
  });
  const failoverDetail = events
    .filter((e) => e.kind === "engine-v3-fallback")
    .map(detailOf)
    .slice(0, 10);
  const dropped = events
    .filter((e) => e.kind === "send-dropped" || e.kind === "wa-send-stale")
    .map((e) => ({ ...detailOf(e), kind: e.kind }))
    .slice(0, 15);
  // Turns the OLD engine answered. Should be ~0: it is the exception path now.
  const graphTurns = events.filter((e) => e.kind === "engine-graph-turn").map(detailOf).slice(0, 10);

  // ---- Global session state: lowest offer + rivals per active search --------
  const offers = await sbSelect<{
    vendor_name: string;
    price_per_day: number;
    list_price_per_day: number | null;
    currency: string;
    vehicle_key: string | null;
    created_at: string;
  }>(
    "offers",
    `select=vendor_name,price_per_day,list_price_per_day,currency,vehicle_key,created_at&simulated=eq.false&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&order=price_per_day.asc&limit=40`
  ).catch(() => []);

  const lowestByVehicle = new Map<string, { shop: string; pricePerDay: number; currency: string }>();
  for (const o of offers) {
    const key = `${o.vehicle_key ?? "?"}:${o.currency}`;
    if (!lowestByVehicle.has(key)) {
      lowestByVehicle.set(key, { shop: o.vendor_name, pricePerDay: o.price_per_day, currency: o.currency });
    }
  }

  // ---- Queue health: outbox depth + how far ahead the next send is ----------
  //
  // WHERE IS THIS MESSAGE HELD? The owner's question, and this route already
  // had the whole answer in hand and threw it away for a count. `meta.reason`
  // is the guard's own words for why a row is parked; `outboxState` is the
  // definition every other surface reads; `claimedAt` says whether a drainer
  // is mid-send or died holding it. All of it, per row, for the price of the
  // query that was already running.
  const queue = await sbSelect<{
    id: number;
    to_number: string;
    not_before: string;
    meta: { kind?: string; reason?: string; vendorName?: string; claimedAt?: number } | null;
  }>(
    "wa_outbox",
    `select=id,to_number,not_before,meta&order=not_before.asc&limit=200`
  ).catch(() => []);
  const now = Date.now();
  const dueNow = queue.filter((q) => Date.parse(q.not_before) <= now).length;
  const nextAt = queue[0]?.not_before ?? null;
  const { outboxState, isLapsedClaim } = await import("@/lib/wa/outbox-lifecycle");
  const { classifyQueueReason, queueReasonLabel } = await import("@/lib/queue-reason");
  const held = queue.slice(0, 40).map((r) => {
    // A LAPSED CLAIM is a drainer that died mid-send. The lease is its own fix -
    // the row is due again by definition - but nothing SHOWED it, so an
    // interrupted send was folklore. This arithmetic used to live here AND in
    // outbox-lifecycle's `lapsedClaims`, two copies of the rule that decides
    // whether this panel says "interrupted". One definition now.
    const lapsed = isLapsedClaim(r.meta, now);
    return {
      id: r.id,
      vendorName: r.meta?.vendorName ?? null,
      kind: r.meta?.kind ?? null,
      notBefore: r.not_before,
      state: outboxState(r.not_before, r.meta ?? null, now),
      lapsed,
      // The guard's real words, and the traveller-readable version of them.
      // Never a guess: an empty reason renders as unknown, which is honest.
      reasonKind: classifyQueueReason(r.meta?.reason),
      reason: r.meta?.reason ?? null,
      reasonLabel: queueReasonLabel(r.meta?.reason),
    };
  });
  const lapsedCount = held.filter((h) => h.lapsed).length;

  // ---- WA socket liveness (sessions marked open) ----------------------------
  const sessions = await sbSelect<{ email: string; status?: string | null; updated_at?: string }>(
    "wa_sessions",
    `select=email,status,updated_at&order=updated_at.desc&limit=50`
  ).catch(() => []);
  const liveSockets = sessions.filter((s) => String(s.status ?? "").toLowerCase() === "open").length;
  // Newest stamp so the client can be HONEST that "open" is a durable mirror
  // (it never downgrades on a real socket loss), not a live-liveness claim.
  const socketsStampedAt = sessions[0]?.updated_at ?? null;

  // ---- Webhook liveness: recent inbound + accept/403 breadcrumbs -------------
  // BUG FIX: whatsapp_messages has NO `created_at` column - the timestamp is
  // `received_at`. The old query filtered/ordered on created_at, PostgREST
  // 400'd, sbSelect swallowed it, and LAST INBOUND was permanently "-".
  const inbound = await sbSelect<{ from_number: string; received_at: string }>(
    "whatsapp_messages",
    `select=from_number,received_at&direction=eq.inbound&received_at=gte.${encodeURIComponent(
      new Date(now - 6 * 3600_000).toISOString()
    )}&order=received_at.desc&limit=1`
  ).catch(() => []);
  const webhookEvents = await sbSelect<{ kind: string; created_at: string }>(
    "agent_events",
    `select=kind,created_at&kind=in.(webhook-ok,webhook-403)&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&order=created_at.desc&limit=20`
  ).catch(() => []);
  const lastAcceptedAt = webhookEvents.find((e) => e.kind === "webhook-ok")?.created_at ?? null;
  const last403At = webhookEvents.find((e) => e.kind === "webhook-403")?.created_at ?? null;

  // ---- REAL 6h turn count (the tile used turns.length, capped at 30) ---------
  // An EXACT HEAD count now, not 1000 id rows shipped over the wire to be
  // .length'd (that read was the poll's single largest egress line). null =
  // unreadable, which the tile renders as a dash rather than a made-up zero.
  const turnsLast6h = await sbCountDark(
    "agent_events",
    `kind=eq.engine-v3-turn&created_at=gte.${encodeURIComponent(sinceIso)}`
  );

  // ---- Chart aggregations (Tier-2): move mix, provider mix, per-hour bars and
  // latency percentiles over a WIDER 6h turn sample than the 30-row live stream.
  // Detail-only slim query so the charts reflect the real fleet, not the head.
  const CHART_SAMPLE_CAP = 600;
  const chartRows = await sbSelect<{ detail: string | null; created_at: string }>(
    "agent_events",
    `select=detail,created_at&kind=eq.engine-v3-turn&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&order=created_at.desc&limit=${CHART_SAMPLE_CAP}`
  ).catch(() => []);
  const statTurns = chartRows.map((r) => {
    let d: { move?: string; provider?: string | null; latencyMs?: number | null } = {};
    try {
      d = JSON.parse(r.detail ?? "{}");
    } catch {
      /* keep empty */
    }
    return { at: r.created_at, move: d.move, provider: d.provider, latencyMs: d.latencyMs };
  });
  const charts = {
    turnsPerHour: bucketTurnsPerHour(statTurns, now, 6),
    moveMix: moveMix(statTurns).slice(0, 8),
    providerMix: providerMix(statTurns).slice(0, 8),
    latency: latencyStats(statTurns),
    sampled: statTurns.length,
    sampleCapped: statTurns.length >= CHART_SAMPLE_CAP,
  };

  // ---- Operations tiles (Tier-1): realized outcome + shop responsiveness -----
  // avgBargainMarginPct reads the offers we already fetched (list vs final);
  // shop reply time pairs recent inbound/outbound rows. Both are pure + bounded.
  const bargainMargin = avgBargainMarginPct(
    offers.map((o) => ({ pricePerDay: o.price_per_day, listPricePerDay: o.list_price_per_day }))
  );
  const replyRows = await sbSelect<{
    direction: string;
    from_number: string | null;
    to_number: string | null;
    received_at: string;
  }>(
    "whatsapp_messages",
    `select=direction,from_number,to_number,received_at&direction=in.(inbound,outbound)&received_at=gte.${encodeURIComponent(
      sinceIso
    )}&order=received_at.asc&limit=600`
  ).catch(() => []);
  const replyEvents: ReplyEvent[] = replyRows
    .map((r) => {
      const number = (r.direction === "inbound" ? r.from_number : r.to_number) ?? "";
      // "session"/"takeover" markers carry no real shop number - skip them.
      return number && /\d/.test(number)
        ? {
            number,
            direction: r.direction === "inbound" ? ("inbound" as const) : ("outbound" as const),
            atMs: Date.parse(r.received_at),
          }
        : null;
    })
    .filter((x): x is ReplyEvent => x !== null);
  const shopReply = medianShopReplyMins(replyEvents);

  // ---- Did the agents READ the photos right, and did they USE their leverage?
  // Both are answers to live complaints ("the app is not reading photos well",
  // "the 300 shop was never told about the 250") that were previously
  // unmeasurable. vision-check rows are written by agent-loop when a typed price
  // lands on a thread whose price originally came off a photo.
  const visionRows = await sbSelect<{ detail: string | null }>(
    "agent_events",
    `select=detail&kind=eq.vision-check&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&order=created_at.desc&limit=200`
  ).catch(() => []);
  const vision = visionAccuracy(
    visionRows.map((r) => {
      try {
        const d = JSON.parse(r.detail ?? "{}") as { agreement?: string };
        return { hadImage: true, agreement: (d.agreement ?? null) as never };
      } catch {
        return { hadImage: true, agreement: null };
      }
    })
  );
  const leverage = leverageUsePct(statTurns as Array<{ move?: string; rivals?: number; citedRival?: boolean }>);

  return NextResponse.json({
    engine: "ENGINE_V3 (SPTE - Shared Session Blackboard + Single-Pass)",
    generatedAt: new Date(now).toISOString(),
    turns,
    stats: {
      turnsLast6h, // exact HEAD count; null = unreadable (a dash, never zero)
      failoversLast6h: fallbacks,
      unconfirmedSendsLast6h: unconfirmed,
      // A count nobody can act on is decoration. These carry the shop and the
      // reason, so the number is a starting point instead of an ending one.
      failoverDetail,
      dropped,
      graphTurns,
    },
    session: {
      lowestByVehicle: [...lowestByVehicle.entries()].map(([k, v]) => ({ key: k, ...v })).slice(0, 12),
      activeOffers: offers.length,
    },
    operations: {
      avgBargainMarginPct: bargainMargin.pct,
      bargainSamples: bargainMargin.samples,
      medianShopReplyMins: shopReply.mins,
      replySamples: shopReply.samples,
      visionAccuracyPct: vision.accuracyPct,
      visionVerifiedPct: vision.verifiedPct,
      visionPhotoTurns: vision.photoTurns,
      visionConflicts: vision.conflict,
      leverageUsePct: leverage.pct,
      leverageOpportunities: leverage.opportunities,
    },
    queue: { depth: queue.length, dueNow, nextAt, lapsed: lapsedCount, held },
    sockets: { live: liveSockets, total: sessions.length, stampedAt: socketsStampedAt },
    webhook: { lastInboundAt: inbound[0]?.received_at ?? null, lastAcceptedAt, last403At },
    charts,
  });
}
