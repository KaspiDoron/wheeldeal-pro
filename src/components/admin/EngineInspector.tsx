"use client";

// SESSION BLACKBOARD INSPECTOR - the live ENGINE_V3 (SPTE) transparency view,
// now a multi-tier drill-down dashboard (Module 3). Tier 1: truthful liveness +
// throughput tiles + durable field KPIs. Tier 2: hand-rolled charts (turns/hour,
// move mix, provider mix). Tier 3: the live single-pass turn stream, each row
// expandable to its full decision detail. Tier 4: where to dig deeper. Every
// metric carries a tap-to-open InfoTip explaining what it means and what to do
// if it drifts. The engine snapshot polls every 4s; the slower durable KPIs and
// health poll every 30s.

import { useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";
import { InfoTipProvider, InfoTip } from "../InfoTip";
import { ENGINE_HELP } from "./engine/help";
import { StatTile } from "./engine/Tiles";
import { HourlyBars, MixBars } from "./engine/Charts";
import { TurnRow, type Turn } from "./engine/TurnRow";

interface Charts {
  turnsPerHour: number[];
  moveMix: { key: string; count: number }[];
  providerMix: { key: string; count: number }[];
  latency: { p50: number | null; p95: number | null; samples: number };
  sampled: number;
  sampleCapped: boolean;
}

interface Snapshot {
  engine: string;
  generatedAt: string;
  turns: Turn[];
  stats: {
    turnsLast6h: number;
    turnsCapped?: boolean;
    failoversLast6h: number;
    unconfirmedSendsLast6h: number;
    // The rows behind the counts. A number nobody can act on is decoration.
    failoverDetail?: { shop: string; at: string; detail: string }[];
    dropped?: { shop: string; at: string; detail: string; kind: string }[];
    graphTurns?: { shop: string; at: string; detail: string }[];
  };
  session: { lowestByVehicle: { key: string; shop: string; pricePerDay: number; currency: string }[]; activeOffers: number };
  operations?: {
    avgBargainMarginPct: number | null;
    bargainSamples: number;
    medianShopReplyMins: number | null;
    replySamples: number;
    // Photo-price accuracy + how often a real rival price actually got named.
    visionAccuracyPct?: number | null;
    visionVerifiedPct?: number | null;
    visionPhotoTurns?: number;
    visionConflicts?: number;
    leverageUsePct?: number | null;
    leverageOpportunities?: number;
  };
  queue: {
    depth: number;
    dueNow: number;
    nextAt: string | null;
    /** Rows whose claim lapsed - a drainer died mid-send (F10). */
    lapsed?: number;
    /** WHERE each held message actually is, and why. */
    held?: {
      id: number;
      vendorName: string | null;
      kind: string | null;
      notBefore: string;
      state: "due" | "waiting" | "sending";
      lapsed: boolean;
      reasonKind: string;
      reason: string | null;
      reasonLabel: string;
    }[];
  };
  sockets: { live: number; total: number; stampedAt?: string | null };
  webhook: { lastInboundAt: string | null; lastAcceptedAt?: string | null; last403At?: string | null };
  charts?: Charts;
}

interface FieldKpis {
  discountMarginPct: number | null;
  conversionPct: number | null;
  escalationPct: number | null;
  responseLatencyMs: { p50: number | null; p95: number | null; samples: number };
  /** Inputs that could not be read this run. Non-empty = the dashes below are
   *  "we could not ask", not "nothing happened". */
  degraded?: string[];
}
interface Health {
  webhookSilent?: boolean;
  guardCounters?: Record<string, number | null>;
}

function ago(iso?: string | null): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
const pct = (v: number | null | undefined) => (v == null ? "-" : `${v}%`);
const ms = (v: number | null | undefined) => (v == null ? "-" : `${v}ms`);

function TierLabel({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brandblue text-[10px] font-extrabold text-white">
        {n}
      </span>
      <span className="text-[12px] font-extrabold uppercase tracking-wide text-soft">{title}</span>
    </div>
  );
}

export function EngineInspector() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [field, setField] = useState<FieldKpis | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState(false);
  const [live, setLive] = useState(true);

  // A backgrounded tab must not keep polling: the Engine tab is left open, and
  // an unattended one was ~120 AI completions + ~600 billed Maps calls an hour
  // against the 5 GB Supabase egress ceiling. Skip every tick while hidden.
  const visible = () =>
    typeof document === "undefined" || document.visibilityState === "visible";

  // Fast lane: the engine snapshot. 15s (was 4s), and never while hidden - the
  // heavy reads behind this route are the biggest single egress source here.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!visible()) return;
      try {
        const r = await fetch("/api/admin/engine-inspector", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as Snapshot;
        if (!cancelled) {
          setSnap(d);
          setErr(false);
        }
      } catch {
        if (!cancelled) setErr(true);
      }
    };
    tick();
    if (!live) return () => { cancelled = true; };
    const id = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live]);

  // Slow lane: durable field KPIs + health every 10 MINUTES, cached-probes only,
  // never while hidden. /api/admin/health's full sweep fires a real AI
  // completion, five billed Maps calls, an SMTP AUTH and a PayPal OAuth per hit;
  // ?probes=cached returns the last snapshot + DB-derived vitals, so leaving the
  // tab open no longer spends money. The live sweep is behind an explicit button.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!visible()) return;
      const [a, h] = await Promise.all([
        fetch("/api/admin/analytics", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/admin/health?probes=cached", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (cancelled) return;
      if (a?.field) setField(a.field as FieldKpis);
      if (h) setHealth(h as Health);
    };
    tick();
    if (!live) return () => { cancelled = true; };
    const id = setInterval(tick, 600000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live]);

  if (!snap && !err) return <LoadingDots label="Reading the live blackboard" />;

  return (
    <InfoTipProvider>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-[15px] font-extrabold text-strong">🧠 Session Blackboard Inspector</h3>
            <p className="text-[11px] font-bold text-soft">{snap?.engine ?? "ENGINE_V3"}</p>
          </div>
          <button
            onClick={() => setLive((v) => !v)}
            className={`btn btn-sm rounded-xl px-3 py-1.5 text-[11px] font-extrabold ${
              live ? "bg-savings-soft text-savings" : "bg-card2 text-soft"
            }`}
          >
            {live ? "● Live" : "Paused"}
          </button>
        </div>

        {err && (
          <div className="rounded-2xl bg-brandred-soft p-2.5 text-[12px] font-bold text-brandred">
            Could not reach the inspector endpoint - retrying.
          </div>
        )}

        {/* The one banner that matters: inbound is dead. Actionable, not silent. */}
        {health?.webhookSilent && (
          <div className="rounded-2xl bg-brandred-soft p-3 text-[12px] font-bold text-brandred">
            ⚠️ Shops&apos; replies aren&apos;t reaching us - the webhook looks silent. Open 🩺 WA doctor in the Command
            tab and tap Re-arm.
          </div>
        )}

        {/* WHAT THE GUARD REFUSED, WHERE ANYONE CAN SEE IT.
            These counters were fetched every 30 seconds by this component and
            never rendered - the health payload was consumed for one boolean.
            They are the cross-cutting reasons a thread goes quiet without the
            queue showing anything: a terminal drop leaves no outbox row, so
            "Held right now" structurally cannot show it. */}
        {health?.guardCounters &&
          Object.values(health.guardCounters).some((n) => n === null || (n ?? 0) > 0) && (
            <div className="rounded-2xl border border-line bg-card p-3">
              <div className="mb-2 text-[12px] font-extrabold uppercase text-soft">
                Refused in the last 6h
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(health.guardCounters)
                  .filter(([, n]) => n === null || (n ?? 0) > 0)
                  // An unreadable counter sorts FIRST: "we cannot see this" is
                  // more urgent than any number we can.
                  .sort((a, b) => (b[1] ?? Infinity) - (a[1] ?? Infinity))
                  .map(([kind, n]) => (
                    <span
                      key={kind}
                      className={`rounded-full px-2 py-1 text-[11px] font-bold ${
                        n === null ||
                        kind === "send-dropped" ||
                        kind === "engine-graph-turn"
                          ? "bg-brandred-soft text-brandred"
                          : "bg-card2 text-ink"
                      }`}
                    >
                      {kind.replace(/-/g, " ")}: {n === null ? "unreadable" : n}
                    </span>
                  ))}
              </div>
            </div>
          )}

        {snap && (
          <>
            {/* ---- TIER 1: liveness + throughput -------------------------------- */}
            <TierLabel n={1} title="Live health" />
            <div className="grid grid-cols-3 gap-2">
              <StatTile
                helpId="turns6h"
                value={`${snap.stats.turnsLast6h}${snap.stats.turnsCapped ? "+" : ""}`}
              />
              <StatTile
                helpId="failovers"
                value={snap.stats.failoversLast6h}
                tone={snap.stats.failoversLast6h > 0 ? "text-brandred" : "text-savings"}
              />
              <StatTile helpId="unverified" value={snap.stats.unconfirmedSendsLast6h} />
            </div>

            {/* WHICH SHOP, AND WHY. "5 failovers in 6h" was a bare number while
                the rows behind it already carried the vendor and the exception;
                a terminal drop had no surface at all, because it never touches
                the outbox the queue view reads. */}
            {((snap.stats.failoverDetail?.length ?? 0) > 0 ||
              (snap.stats.dropped?.length ?? 0) > 0 ||
              (snap.stats.graphTurns?.length ?? 0) > 0) && (
              <div className="space-y-1.5 rounded-2xl border border-line bg-card p-3">
                <div className="text-[12px] font-extrabold uppercase text-soft">
                  Threads that need a look
                </div>
                {snap.stats.graphTurns?.map((g, i) => (
                  <div key={`g${i}`} className="text-[11px] font-semibold text-brandred">
                    <b>{g.shop}</b> - answered by the OLD engine ({ago(g.at)}): {g.detail}
                  </div>
                ))}
                {snap.stats.failoverDetail?.map((f, i) => (
                  <div key={`f${i}`} className="text-[11px] font-semibold text-brandred">
                    <b>{f.shop}</b> - engine failover ({ago(f.at)}): {f.detail}
                  </div>
                ))}
                {snap.stats.dropped?.map((d, i) => (
                  <div key={`d${i}`} className="text-[11px] font-semibold text-ink">
                    <b>{d.shop}</b> - {d.kind === "wa-send-stale" ? "draft dropped as stale" : "message refused"} (
                    {ago(d.at)}): {d.detail}
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
            </div>
            <div className="grid grid-cols-3 gap-2">
              <StatTile helpId="queue" value={`${snap.queue.dueNow} / ${snap.queue.depth}`} />
              <StatTile
                helpId="sockets"
                value={`${snap.sockets.live} / ${snap.sockets.total}`}
                tone={snap.sockets.live > 0 ? "text-soft" : "text-brandred"}
              />
              <StatTile helpId="lastInbound" value={ago(snap.webhook.lastInboundAt)} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <StatTile
                helpId="webhookAccepted"
                value={ago(snap.webhook.lastAcceptedAt)}
                tone={snap.webhook.lastAcceptedAt ? "text-savings" : "text-brandred"}
              />
              <StatTile
                helpId="webhook403"
                value={ago(snap.webhook.last403At)}
                tone={snap.webhook.last403At ? "text-brandred" : "text-faint"}
              />
              <StatTile helpId="socketsStamped" value={ago(snap.sockets.stampedAt)} />
            </div>

            {/* WHERE IS THIS MESSAGE HELD? - the owner's question, answered per
                row rather than as a depth count. Everything here is real state:
                `outboxState` is the same definition the queue viewer and the
                status panel read, and the reason is the guard's own words -
                never a guess, so a row with no reason honestly reads as one. */}
            {(snap.queue.held?.length ?? 0) > 0 && (
              <div className="rounded-2xl border border-line bg-card p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[12px] font-extrabold uppercase text-soft">
                    Held right now ({snap.queue.depth})
                  </div>
                  {(snap.queue.lapsed ?? 0) > 0 && (
                    <div className="text-[11px] font-extrabold text-brandred">
                      {snap.queue.lapsed} interrupted mid-send
                    </div>
                  )}
                </div>
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {snap.queue.held!.map((h) => (
                    <div key={h.id} className="rounded-xl bg-card2 p-2 text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-extrabold text-strong">
                          {h.vendorName ?? `#${h.id}`}
                          {h.kind ? <span className="ml-1 font-bold text-faint">{h.kind}</span> : null}
                        </span>
                        <span
                          className={`shrink-0 font-extrabold ${
                            h.lapsed
                              ? "text-brandred"
                              : h.state === "sending"
                                ? "text-savings"
                                : h.state === "due"
                                  ? "text-brandblue"
                                  : "text-faint"
                          }`}
                        >
                          {h.lapsed ? "interrupted mid-send" : h.state}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] font-bold text-soft">
                        {h.reasonLabel} · due {ago(h.notBefore)}
                      </div>
                      {h.reason && (
                        <div className="mt-0.5 truncate text-[10px] text-faint">{h.reason}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Operations (live 6h): the realized-outcome + responsiveness row.
                Derived from real offers + message timing, so it is honest about
                having no sample yet ('-') rather than showing a fake zero. */}
            {snap.operations && (
              <div className="grid grid-cols-2 gap-2">
                <StatTile
                  helpId="opsRealizedMargin"
                  value={
                    snap.operations.avgBargainMarginPct == null
                      ? "-"
                      : `${snap.operations.avgBargainMarginPct}%`
                  }
                  tone={
                    (snap.operations.avgBargainMarginPct ?? 0) > 0 ? "text-savings" : "text-soft"
                  }
                />
                <StatTile
                  helpId="opsShopReply"
                  value={
                    snap.operations.medianShopReplyMins == null
                      ? "-"
                      : `${snap.operations.medianShopReplyMins}m`
                  }
                />
                {/* Photo pricing + leverage: the two things the owner could see
                    going wrong in live threads but could not measure. */}
                <StatTile
                  helpId="opsVisionAccuracy"
                  value={
                    snap.operations.visionAccuracyPct == null
                      ? "-"
                      : `${snap.operations.visionAccuracyPct}%`
                  }
                  sub={
                    snap.operations.visionPhotoTurns
                      ? `${snap.operations.visionPhotoTurns} photo turns${
                          snap.operations.visionConflicts
                            ? ` · ${snap.operations.visionConflicts} conflict`
                            : ""
                        }`
                      : "no photos yet"
                  }
                  tone={
                    snap.operations.visionAccuracyPct == null
                      ? "text-soft"
                      : snap.operations.visionAccuracyPct >= 90
                        ? "text-savings"
                        : "text-brandyellow"
                  }
                />
                <StatTile
                  helpId="opsLeverageUse"
                  value={
                    snap.operations.leverageUsePct == null
                      ? "-"
                      : `${snap.operations.leverageUsePct}%`
                  }
                  sub={
                    snap.operations.leverageOpportunities
                      ? `${snap.operations.leverageOpportunities} chances`
                      : "no rival yet"
                  }
                  tone={
                    snap.operations.leverageUsePct == null
                      ? "text-soft"
                      : snap.operations.leverageUsePct >= 70
                        ? "text-savings"
                        : "text-brandred"
                  }
                />
              </div>
            )}

            {/* Durable field KPIs (30-day) - the outcome metrics the client used
                to silently drop. */}
            {field && (
              <div className="surface rounded-2xl p-3">
                <div className="mb-2 flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-faint">
                  Field KPIs (30-day)
                </div>
                {/* A dash means one of two very different things, and the panel
                    has to say which. Without this line an outage renders
                    identically to a genuinely quiet month. */}
                {(field.degraded ?? []).length > 0 && (
                  <div className="mb-2 rounded-xl bg-brandred-soft px-2.5 py-1.5 text-[11px] font-bold text-brandred">
                    Could not read: {(field.degraded ?? []).join(", ")} - the figures below are
                    incomplete, not low.
                  </div>
                )}
                <div className="grid grid-cols-4 gap-2 text-center">
                  <KpiCell helpId="discountMargin" value={pct(field.discountMarginPct)} />
                  <KpiCell helpId="conversion" value={pct(field.conversionPct)} />
                  <KpiCell helpId="escalation" value={pct(field.escalationPct)} />
                  <KpiCell
                    helpId="latency"
                    value={`${ms(field.responseLatencyMs?.p50)} / ${ms(field.responseLatencyMs?.p95)}`}
                    sub="p50/p95"
                  />
                </div>
              </div>
            )}

            {/* ---- TIER 2: charts ---------------------------------------------- */}
            <TierLabel n={2} title="Trends (6h)" />
            {snap.charts && (
              <>
                <HourlyBars data={snap.charts.turnsPerHour} />
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <MixBars helpId="moveMix" data={snap.charts.moveMix} />
                  <MixBars helpId="providerMix" data={snap.charts.providerMix} tone="green" />
                </div>
              </>
            )}

            {/* Global blackboard: lowest offer per vehicle bucket in the session. */}
            {snap.session.lowestByVehicle.length > 0 && (
              <div className="surface rounded-2xl p-3">
                <div className="mb-1.5 flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-faint">
                  <span>{ENGINE_HELP.blackboard.label} - lowest offer / vehicle</span>
                  <InfoTip
                    id="tip-blackboard"
                    label={ENGINE_HELP.blackboard.label}
                    what={ENGINE_HELP.blackboard.what}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {snap.session.lowestByVehicle.map((l) => (
                    <span key={l.key} className="rounded-full bg-card2 px-2.5 py-1 text-[11px] font-bold text-soft">
                      {l.key.split(":")[0]}: <b className="text-strong">{l.pricePerDay} {l.currency}</b> ({l.shop})
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* ---- TIER 3: live turn stream ------------------------------------ */}
            <TierLabel n={3} title="Decision stream" />
            <div className="flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-faint">
              <span>{ENGINE_HELP.turnStream.label} (newest first)</span>
              <InfoTip id="tip-turnStream" label={ENGINE_HELP.turnStream.label} what={ENGINE_HELP.turnStream.what} />
            </div>
            <div className="space-y-2">
              {snap.turns.length === 0 && (
                <div className="surface rounded-2xl p-3 text-[12px] text-soft">
                  No turns yet in the last 6h - the engine logs one row per shop message it answers.
                </div>
              )}
              {snap.turns.map((t, i) => (
                <TurnRow key={i} t={t} />
              ))}
            </div>

            {/* ---- TIER 4: dig deeper ------------------------------------------ */}
            <TierLabel n={4} title="Dig deeper" />
            <div className="surface rounded-2xl p-3 text-[12px] leading-relaxed text-soft">
              For the full decision ladder per booking, open the <b className="text-strong">Analytics</b> tab
              (tactic scores + owner reviews). For spend per provider, see <b className="text-strong">Costs</b>.
              For inbound incidents, use <b className="text-strong">🩺 WA doctor</b> in the Command tab.
              {snap.charts?.sampleCapped && (
                <div className="mt-1.5 text-[11px] font-bold text-faint">
                  Charts sampled the most recent {snap.charts.sampled} turns (cap reached).
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </InfoTipProvider>
  );
}

function KpiCell({ helpId, value, sub }: { helpId: string; value: string; sub?: string }) {
  const h = ENGINE_HELP[helpId];
  return (
    <div>
      <div className="flex items-center justify-center gap-1 text-[10px] font-extrabold uppercase tracking-wide text-faint">
        <span>{h?.label ?? helpId}</span>
        {h && <InfoTip id={`tip-${helpId}`} label={h.label} what={h.what} drift={h.drift} />}
      </div>
      <div className="mt-0.5 text-[15px] font-extrabold text-strong">{value}</div>
      {sub && <div className="text-[9px] font-bold text-faint">{sub}</div>}
    </div>
  );
}
