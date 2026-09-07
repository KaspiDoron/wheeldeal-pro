import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect, sbSelectDark, sbCountDark, pgTimestamp } from "@/lib/runtime-config";
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
  type StatTurn,
} from "@/lib/admin/engine-stats";

// SESSION BLACKBOARD INSPECTOR (management-gated; the words are owner-only).
// A single live snapshot of the ENGINE_V3 (SPTE) runtime: recent single-pass
// turns with their move + model route, any graph-engine failovers, the
// outbound queue health, WA socket liveness, and the most recent inbound
// webhook confirmations. Every metric reaches all of management - a number is
// not a transcript - while the model scratchpad, the wire text and the raw
// event detail are built for the owner only (audit F086), the same line
// admin/data draws for whatsapp_messages. Everything degrades gracefully - a
// missing table yields an empty section and an unreadable store a null (a
// dash on the tile), never a 500 and never a confident zero.

export const dynamic = "force-dynamic";

type EventRow = { kind: string; vendor_name?: string | null; detail?: string | null; created_at?: string };

/** The rare, alarming kinds - read on their own budget, never the stream's. */
const RARE_KINDS = [
  "engine-v3-fallback",
  "engine-graph-turn",
  "wa-send-unconfirmed",
  "send-dropped",
  "wa-send-stale",
];

/**
 * The turn-record fields management may read: the metrics the tiles, charts
 * and TurnRow render. A POSITIVE list, so a free-text field added to the
 * engine-v3-turn detail later (the way `think` and `text` were) is withheld
 * from non-owners by default instead of leaking through a blind spread.
 */
const TURN_METRIC_KEYS = [
  "move",
  "tier",
  "provider",
  "providerError",
  "reason",
  "legalMoves",
  "floor",
  "lowest",
  "rivals",
  "quote",
  "materialDrop",
  "delivered",
  "outboxRowId",
  "imageUnread",
  "latencyMs",
  "vehicleKey",
  "durationDays",
  "startDate",
  "leverage",
  "citedRival",
  "askVariant",
  "counterPricePerDay",
  "variantOk",
  "truncated",
] as const;

/**
 * The shop label a session may see. `vendor_name` is the shop's NAME on a turn
 * but its bare NUMBER on a dropped send (noteSendDropped stamps the digits),
 * and the recipient number is the identifier the suppression ledger and the
 * queue view (F163) treat as the owner's: management gets the national tail.
 */
function shopLabel(name: string | null | undefined, owner: boolean): string {
  const label = name ?? "shop";
  if (owner) return label;
  const digits = label.replace(/\D/g, "");
  if (digits.length >= 5 && digits.length === label.replace(/^\+/, "").length) {
    return `***${digits.slice(-4)}`;
  }
  return label;
}

function parseDetail(raw: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const owner = session.role === "owner";

  const sinceIso = new Date(Date.now() - 6 * 3600_000).toISOString();

  // ---- ENGINE_V3 turns: the live stream AND the chart sample, ONE read ------
  // The newest-first detail sample the charts read is the same rows the 30-row
  // live stream shows, so its head serves both. Before, the stream shared a
  // 60-row budget with the alarming kinds below and starved them (F086).
  const CHART_SAMPLE_CAP = 600;
  const chartRows = await sbSelect<{ vendor_name?: string | null; detail: string | null; created_at: string }>(
    "agent_events",
    `select=vendor_name,detail,created_at&kind=eq.engine-v3-turn&created_at=gte.${pgTimestamp(sinceIso)}&order=created_at.desc&limit=${CHART_SAMPLE_CAP}`
  ).catch(() => []);
  const turns = chartRows.slice(0, 30).map((e) => {
    const d = parseDetail(e.detail);
    const base = { shop: shopLabel(e.vendor_name, owner), at: e.created_at };
    // THE WORDS ARE THE OWNER'S. `think` is the model's private scratchpad and
    // `text` the outbound WhatsApp message, on every user's turns; the same
    // admin is refused whatsapp_messages by admin/data. Management gets the
    // positive metric projection above and nothing this list does not name.
    if (owner) return { ...base, ...d };
    const metrics: Record<string, unknown> = {};
    for (const k of TURN_METRIC_KEYS) if (k in d) metrics[k] = d[k];
    return { ...base, ...metrics };
  });

  // ---- The alarming kinds: failovers, unconfirmed sends, drops, graph turns --
  // ONE BUDGET SHARED WITH THE TURN STREAM WAS A BUDGET THE TURN STREAM ATE.
  // Two hundred turns in six hours pushed every failover and every dropped
  // send out of a 60-row newest-first sample, and the panel rendered
  // "turns 200, failovers 0" on the busiest window of the beta - the same
  // starvation the health route documents for its twelve guard counters. The
  // stream reads its own rows above; this read is scoped to the rare kinds.
  // sbSelectDark, not sbSelect: an unreadable store is a null (a dash on the
  // tile), never a confident zero.
  const RARE_CAP = 60;
  const rareRead = await sbSelectDark<EventRow>(
    "agent_events",
    `select=kind,vendor_name,detail,created_at&kind=in.(${RARE_KINDS.join(",")})&created_at=gte.${pgTimestamp(sinceIso)}&order=created_at.desc&limit=${RARE_CAP}`
  );
  const events = rareRead ?? [];
  // Below the cap the read IS the whole window, so a per-kind count over it is
  // exact. At the cap it is a sample and a count over it is only a floor, so
  // the two counters fall back to exact HEAD counts - the one moment this
  // route spends a request it did not spend before (the Engine tab polls
  // every 15s; folding the turn read into the chart read above pays for it).
  const rareCapped = events.length >= RARE_CAP;
  const countKind = async (kind: string): Promise<number | null> => {
    if (rareRead === null) return null;
    if (!rareCapped) return events.filter((e) => e.kind === kind).length;
    return sbCountDark("agent_events", `kind=eq.${kind}&created_at=gte.${pgTimestamp(sinceIso)}`);
  };
  const [fallbacks, unconfirmed] = await Promise.all([
    countKind("engine-v3-fallback"),
    countKind("wa-send-unconfirmed"),
  ]);

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
    shop: shopLabel(e.vendor_name, owner),
    at: e.created_at,
    // The raw detail names shop numbers, sender emails and, for a stale
    // draft, the words it no longer fit - owner-only, like the turn text.
    detail: owner ? (e.detail ?? "").slice(0, 300) : null,
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
  // latency percentiles over the WIDER 6h turn sample read above (up to 600
  // rows) than the 30-row live stream, so the charts reflect the real fleet.
  // The projection carries EVERY field its consumers read - rivals and
  // citedRival included - and is TYPED as StatTurn rather than cast to it, so
  // the leverage KPI cannot silently go dead again (audit F087: the old
  // projection dropped both keys and the tile said "no rival yet" forever).
  const statTurns: StatTurn[] = chartRows.map((r) => {
    const d = parseDetail(r.detail) as {
      move?: string;
      provider?: string | null;
      latencyMs?: number | null;
      rivals?: number;
      citedRival?: boolean;
    };
    return {
      at: r.created_at,
      move: d.move,
      provider: d.provider,
      latencyMs: d.latencyMs,
      rivals: d.rivals,
      citedRival: d.citedRival,
    };
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
  const leverage = leverageUsePct(statTurns);

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
