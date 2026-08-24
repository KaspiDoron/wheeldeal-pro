import "server-only";

// THE LAUNCH GO/NO-GO NUMBERS, IN ONE PLACE (owner report 4, scale #10).
//
// Before a public launch the owner needs five numbers on one card, not five
// dashboards: is the reply lane actually fast, are we near the send caps, is
// the AI chain spilling over, how full are the Evolution hosts, and how fast is
// the database growing. Each already exists somewhere; this assembles them into
// one read so "are we ready for hundreds?" has a single honest answer.
//
// Every field degrades to null on an unreadable source and SAYS so - a
// confident zero on a launch dashboard is the fail-green shape this whole
// review exists to undo.

import { sbSelectStrict, sbCountDark } from "../runtime-config";
import { replyLatencyStats } from "../wa/turn-latency";
import { transportSummary } from "../wa/proxy";
import { spentProviders } from "../ai-rpm";

export interface LaunchKpis {
  /** True inbound->wire reply latency (from the drain's reply-latency events). */
  reply: { p50Sec: number | null; p95Sec: number | null; samples: number };
  /** Sends in the last 24h, both lanes, so the owner sees headroom vs the caps. */
  sends: { introDay: number | null; replyDay: number | null };
  /** AI providers whose per-minute budget is spent right now (spillover depth). */
  aiSpillover: { spent: string[]; count: number };
  /**
   * Testers who exhausted their DAILY model budget in the last 24h.
   *
   * Different question from spillover, and the one that shows up as a product
   * complaint: past `LIMIT_AI_PER_DAY` a tester's turns fall to the
   * deterministic composer for the rest of the day, so their agent stops being
   * smart mid-hunt while every service stays green. Null = unreadable.
   */
  aiExhausted: { users24h: number | null };
  /** Evolution host occupancy + the datacenter-cluster warning, if any. */
  hosts: {
    sessions: number | null;
    clusterWarning?: { host: string; count: number };
    note: string;
  };
  /** Rough DB growth: rows added in the last 24h on the unbounded tables. */
  dbGrowth: { whatsappMessages: number | null; agentEvents: number | null };
  /** Any source that could not be read - the card shows a caveat, not a zero. */
  degraded: string[];
}

// COUNT, DO NOT FETCH. This selected up to 100k rows and took `.length` -
// correct, and absurd on a table that grows by design: five of those queries
// per card load, moving megabytes to produce five integers. `sbCountDark` asks
// PostgREST for the count header with `Range: 0-0`, so ONE row crosses the
// wire, and it keeps the fail-dark contract this card is built on: `null`
// means "could not be read", never a confident zero.
async function count24h(table: string, tsColumn: string, extra = ""): Promise<number | null> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  return sbCountDark(table, `${tsColumn}=gte.${encodeURIComponent(since)}${extra}`);
}

export async function launchKpis(): Promise<LaunchKpis> {
  const degraded: string[] = [];

  const [latencyRead, introDay, replyDay, transport, waMsgs, events, aiExhausted] =
    await Promise.all([
    sbSelectStrict<{ detail: string | null }>(
      "agent_events",
      `select=detail&kind=eq.reply-latency&created_at=gte.${encodeURIComponent(
        new Date(Date.now() - 24 * 3600_000).toISOString()
      )}&order=created_at.desc&limit=500`
    ),
    count24h("whatsapp_messages", "received_at", "&direction=eq.outbound&raw->>auto=eq.true&raw->>kind=eq.rfq"),
    count24h("whatsapp_messages", "received_at", "&direction=eq.outbound&raw->>auto=eq.true&raw->>kind=neq.rfq"),
    transportSummary().catch(() => null),
    count24h("whatsapp_messages", "received_at"),
    count24h("agent_events", "created_at"),
    count24h("agent_events", "created_at", "&kind=eq.ai-budget-exhausted"),
  ]);

  if ("error" in latencyRead) degraded.push("reply-latency");
  if (introDay === null || replyDay === null) degraded.push("send-counts");
  if (!transport) degraded.push("transport");
  if (waMsgs === null || events === null) degraded.push("db-growth");
  if (aiExhausted === null) degraded.push("ai-budget");

  const latencyRows = "error" in latencyRead ? [] : latencyRead.rows;
  const reply = replyLatencyStats(latencyRows.map((r) => r.detail));
  const spent = spentProviders();

  return {
    reply: { p50Sec: reply.p50Sec, p95Sec: reply.p95Sec, samples: reply.samples },
    sends: { introDay, replyDay },
    aiSpillover: { spent, count: spent.length },
    aiExhausted: { users24h: aiExhausted },
    hosts: {
      sessions: transport?.sessions ?? null,
      ...(transport?.clusterWarning ? { clusterWarning: transport.clusterWarning } : {}),
      note: transport?.note ?? "Transport summary unavailable.",
    },
    dbGrowth: { whatsappMessages: waMsgs, agentEvents: events },
    degraded,
  };
}
