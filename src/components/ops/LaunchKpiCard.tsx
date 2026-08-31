"use client";

// THE LAUNCH GO/NO-GO CARD (owner report 4, scale #10).
//
// "Are we ready for hundreds?" was five different dashboards and a lot of
// squinting: reply speed lived in the WA doctor, send volume in the usage
// tables, AI spillover nowhere at all, host occupancy in the transport tile
// and row growth only in the DB console. This is the one card that answers it.
//
// Every figure obeys the fail-dark contract (components/admin/primitives): a
// source that could not be read renders as a dash and is named in the banner
// above the numbers. On a launch decision a confident zero is the single most
// dangerous thing this card could show - "no sends today" and "the send table
// was unreadable" must never look the same.

import { useCallback, useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";
import { InfoTipProvider } from "@/components/InfoTip";
import { DegradedBanner, StatTile, Num, type StatHelp } from "@/components/admin/primitives";

interface LaunchKpiResponse {
  reply: { p50Sec: number | null; p95Sec: number | null; samples: number };
  sends: { introDay: number | null; replyDay: number | null };
  aiSpillover: { spent: string[]; count: number };
  aiExhausted: { users24h: number | null };
  hosts: { sessions: number | null; clusterWarning?: { host: string; count: number }; note: string };
  dbGrowth: { whatsappMessages: number | null; agentEvents: number | null };
  degraded: string[];
  inbound?: { inflight: number; queued: number };
}

// Every tile explains itself - the generic on StatTile makes a missing entry a
// compile error, so a KPI can never ship without saying what it means.
const LAUNCH_HELP = {
  replyP50: {
    label: "reply p50",
    what: "Median time from a shop's message arriving to our answer leaving the wire, measured at the send itself (not the delay we intended).",
    drift:
      "Rises when holds, re-parks or lost pacing claims accumulate. The intended number lives in the WA doctor - a gap between the two IS the queue.",
  },
  replyP95: {
    label: "reply p95",
    what: "The slow tail of the same measurement. This is the number a shop actually complains about.",
    drift: "A p95 far above p50 means a minority of replies are being held somewhere.",
  },
  introDay: {
    label: "intros 24h",
    what: "Cold introductions sent in the last 24h across the whole fleet. Compare against the per-number daily ceiling before opening signups.",
  },
  replyDay: {
    label: "replies 24h",
    what: "Automated replies to engaged shops in the last 24h. Reply traffic is the safe side of the ban axis - high is good.",
  },
  spillover: {
    label: "AI rungs spent",
    what: "How many AI providers have exhausted their per-minute budget right now ON THIS INSTANCE (in-process counters - other containers keep their own). The chain skips them before the 429.",
    drift: "Persistently above zero means the paid backbone needs raising, not the free tiers.",
  },
  aiExhausted: {
    label: "AI budget out",
    what: "Testers who used up their DAILY model budget in the last 24h. Past it their turns fall back to the deterministic composer - the negotiation keeps working, it stops being smart.",
    drift:
      "Above zero means somebody's agent went quiet-clever mid-hunt while every service tile stayed green. One 20-shop hunt at three rounds can reach the ceiling on its own.",
  },
  sessions: {
    label: "linked numbers",
    what: "WhatsApp sessions currently linked. Against the ~40-per-host ceiling this is the pool capacity signal.",
  },
  dbMsgs: {
    label: "messages 24h",
    what: "Rows added to whatsapp_messages in 24h - the fastest-growing table. Multiply by 90 for the steady-state size once retention runs.",
  },
  dbEvents: {
    label: "events 24h",
    what: "Rows added to agent_events in 24h (holds, drops, receipts, latency samples).",
  },
} satisfies Record<string, StatHelp>;

export function LaunchKpiCard() {
  const [d, setD] = useState<LaunchKpiResponse | null>(null);
  const [busy, setBusy] = useState<"load" | null>("load");

  const load = useCallback(async () => {
    setBusy("load");
    try {
      const res = await fetch("/api/admin/ops/launch-kpis", { cache: "no-store" });
      const json = (await res.json()) as LaunchKpiResponse & { error?: string };
      setD(res.ok && !json.error ? json : null);
    } catch {
      setD(null);
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <InfoTipProvider>
      <div className="surface rounded-blob p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-extrabold text-strong">🚦 Launch readiness</h3>
          <button
            onClick={() => void load()}
            className="btn btn-ghost btn-sm rounded-full px-2.5 py-1 text-[11px]"
            aria-label="Refresh launch readiness"
          >
            ↻
          </button>
        </div>

        {d === null && busy === "load" ? (
          <LoadingDots label="Reading the launch numbers" />
        ) : d === null ? (
          <p className="text-[12px] font-bold text-brandred">
            The launch numbers could not be read. That is not a green light - it is an unknown
            one; try again, and check Supabase if it persists.
          </p>
        ) : (
          <div className="space-y-2">
            <DegradedBanner degraded={d.degraded} />

            {/* The one state on this card that is genuinely an alarm: many
                unproxied numbers on one datacenter IP is the classic
                cluster-ban trigger, and it takes a whole host's fleet at once. */}
            {d.hosts.clusterWarning && (
              <div className="rounded-blob border-2 border-brandred/40 bg-brandred-soft p-3 text-[12px] font-extrabold text-brandred">
                ⚠️ {d.hosts.clusterWarning.count} unproxied numbers share{" "}
                {d.hosts.clusterWarning.host} - a datacenter-IP cluster-ban risk. Spread them
                across hosts or turn the proxy template on before launch.
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <StatTile
                help={LAUNCH_HELP}
                helpId="replyP50"
                emoji="⚡"
                value={d.reply.p50Sec}
                sub={d.reply.samples ? `${d.reply.samples} samples` : "no samples yet"}
                tone={
                  d.reply.p50Sec !== null && d.reply.p50Sec > 120 ? "text-warn" : "text-strong"
                }
              />
              <StatTile
                help={LAUNCH_HELP}
                helpId="replyP95"
                emoji="🐢"
                value={d.reply.p95Sec}
                tone={
                  d.reply.p95Sec !== null && d.reply.p95Sec > 300 ? "text-warn" : "text-strong"
                }
              />
              <StatTile help={LAUNCH_HELP} helpId="introDay" emoji="📤" value={d.sends.introDay} />
              <StatTile help={LAUNCH_HELP} helpId="replyDay" emoji="💬" value={d.sends.replyDay} />
              <StatTile
                help={LAUNCH_HELP}
                helpId="spillover"
                emoji="🧠"
                value={d.aiSpillover.count}
                sub={d.aiSpillover.spent.join(", ") || undefined}
                tone={d.aiSpillover.count > 0 ? "text-warn" : "text-strong"}
              />
              <StatTile
                help={LAUNCH_HELP}
                helpId="aiExhausted"
                emoji="🪫"
                value={d.aiExhausted.users24h}
                tone={
                  d.aiExhausted.users24h !== null && d.aiExhausted.users24h > 0
                    ? "text-warn"
                    : "text-strong"
                }
              />
              <StatTile
                help={LAUNCH_HELP}
                helpId="sessions"
                emoji="📱"
                value={d.hosts.sessions}
              />
              <StatTile
                help={LAUNCH_HELP}
                helpId="dbMsgs"
                emoji="🗄️"
                value={d.dbGrowth.whatsappMessages}
              />
              <StatTile
                help={LAUNCH_HELP}
                helpId="dbEvents"
                emoji="📊"
                value={d.dbGrowth.agentEvents}
              />
            </div>

            <p className="text-[11px] text-soft">{d.hosts.note}</p>

            {d.inbound && (
              <p className="text-[11px] text-faint">
                Inbound AI turns in flight on this instance: <Num v={d.inbound.inflight} />
                {d.inbound.queued > 0 && (
                  <>
                    {" "}
                    (<Num v={d.inbound.queued} /> waiting for a slot)
                  </>
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </InfoTipProvider>
  );
}
