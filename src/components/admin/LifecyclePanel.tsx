"use client";

import { useEffect, useState } from "react";
import { Num, DegradedBanner } from "./primitives";

// THE MONETIZATION SCREEN.
//
// Every number here can be UNREADABLE, and unreadable is rendered as a dash on
// a dark tile - never as zero. That rule is not stylistic: this repo has twice
// shipped a panel that reported "all good" because its reads failed to `[]`,
// and a funnel that silently renders zeros during a Supabase wobble looks
// exactly like every user churning at once.
//
// Mobile first: two columns at 320px, stacked cards rather than a table, no
// horizontal overflow anywhere.

interface Stage {
  id: string;
  label: string;
  count: number | null;
  ofSignups: number | null;
}
interface Stall {
  id: string;
  label: string;
  stuck: number;
}
interface Report {
  generatedAt: number;
  stages: Stage[];
  warm: {
    total: number | null;
    last7d: number | null;
    medianHours: number | null;
    p90Hours: number | null;
  };
  stalls: Stall[] | null;
  holdout: {
    size: number | null;
    converted: number | null;
    gatedSize: number | null;
    gatedConverted: number | null;
  };
  degraded: string[];
  gate: {
    on: boolean;
    searches: number;
    engaged: number;
    replies: number;
    holdoutPct: number;
    holdoutNamed: number;
  };
}

// `Num` and the degraded strip were born here and are now SHARED
// (admin/primitives) so every management surface carries the same fail-dark
// contract instead of re-inventing (or forgetting) it per tab.
function Pct({ v }: { v: number | null }) {
  if (v === null) return <span className="text-faint">&mdash;</span>;
  return <span className="tabular-nums">{Math.round(v * 100)}%</span>;
}

function hours(v: number | null) {
  if (v === null) return null;
  return v < 48 ? `${v}h` : `${Math.round(v / 24)}d`;
}

export function LifecyclePanel() {
  const [d, setD] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/lifecycle", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => (j.error ? setErr(j.error) : setD(j)))
      .catch(() => setErr("Could not reach the server."));
  }, []);

  if (err) {
    return <div className="surface rounded-blob p-4 text-[13px] font-bold text-brandred">{err}</div>;
  }
  if (!d) {
    return <div className="surface rounded-blob p-4 text-[13px] font-bold text-soft">Loading…</div>;
  }

  const maxStage = Math.max(1, ...d.stages.map((s) => s.count ?? 0));
  // The holdout arms are compared as rates, but a rate from a handful of users
  // is noise dressed as evidence. Below the floor the panel shows the fraction
  // and says so, rather than printing a percentage nobody should act on.
  const MIN_ARM = 20;
  const rate = (num: number | null, den: number | null) =>
    num === null || den === null || den === 0 ? null : num / den;

  return (
    <div className="space-y-3">
      <DegradedBanner degraded={d.degraded} />

      {/* The gate as it currently stands - every number below is only
          interpretable against the predicate that produced it. */}
      <div className="surface rounded-blob p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-extrabold text-strong">Warm-up gate</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
              d.gate.on ? "bg-brandgreen text-white" : "bg-card2 text-soft"
            }`}
          >
            {d.gate.on ? "ON" : "OFF"}
          </span>
          {d.gate.holdoutPct > 0 && (
            <span className="rounded-full bg-brandblue px-2 py-0.5 text-[10px] font-extrabold text-white">
              holdout {d.gate.holdoutPct}%
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] font-bold text-soft">
          Unlocks at {d.gate.searches} search{d.gate.searches === 1 ? "" : "es"} ·{" "}
          {d.gate.engaged} shops reached · {d.gate.replies} repl
          {d.gate.replies === 1 ? "y" : "ies"} · WhatsApp connected
          {d.gate.holdoutNamed > 0 && ` · ${d.gate.holdoutNamed} named in holdout`}
        </p>
      </div>

      {/* THE FUNNEL. One row per stage with its share of SIGNUPS - the
          stages do not nest (a search needs no WhatsApp link; an invite grants
          a plan with no payment), so a from-the-row-above ratio produced the
          "Ran a search 175% / Paid 600%" nonsense the owner photographed. The
          absolute counts say who is here; one common denominator says where
          they are being lost. */}
      <div className="surface rounded-blob p-3">
        <div className="text-[13px] font-extrabold text-strong">Lifecycle</div>
        <p className="mt-0.5 text-[11px] text-faint">
          Each percentage is a share of signups. &quot;Paid&quot; counts
          verified PayPal activations only - invited testers appear under
          Comped, because a granted plan is not revenue.
        </p>
        <div className="mt-2 space-y-1.5">
          {d.stages.map((s) => (
            <div key={s.id}>
              <div className="flex items-baseline justify-between gap-2 text-[12px] font-bold">
                <span className="truncate text-soft">{s.label}</span>
                <span className="shrink-0 font-extrabold text-strong">
                  <Num v={s.count} />
                  {s.ofSignups !== null && (
                    <span className="ms-1.5 text-[11px] font-bold text-faint">
                      <Pct v={s.ofSignups} />
                    </span>
                  )}
                </span>
              </div>
              <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-card2">
                <div
                  className={`h-full rounded-full ${
                    s.count === null ? "bg-transparent" : "bg-brandblue"
                  }`}
                  style={{ width: `${Math.round(((s.count ?? 0) / maxStage) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* TIME TO WARM - the number that says whether the thresholds are right.
          In hours, because this product's whole lifecycle is often shorter than
          a day and a days axis would round the interesting variation away. */}
      <div className="surface rounded-blob p-3">
        <div className="text-[13px] font-extrabold text-strong">Time to unlock</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {[
            { k: "Warmed up", v: d.warm.total as number | null, s: "" },
            { k: "Last 7 days", v: d.warm.last7d, s: "" },
            { k: "Median", v: d.warm.medianHours, s: "h" },
            { k: "p90", v: d.warm.p90Hours, s: "h" },
          ].map((x) => (
            <div key={x.k} className="rounded-xl bg-card2 p-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{x.k}</div>
              <div className="text-[16px] font-extrabold text-strong">
                {x.s === "h" ? (
                  hours(x.v) ?? <span className="text-faint">&mdash;</span>
                ) : (
                  <Num v={x.v} />
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] font-bold text-soft">
          If p90 is longer than a typical trip, the gate is too tight - loosen a threshold
          in Keys.
        </p>
      </div>

      {/* WHERE THE NON-WARM POPULATION IS STUCK, by FIRST unmet term. This is
          the chart that changes what you work on next: mass failure on
          "connected" is an onboarding problem, mass failure on "reached" means
          the threshold is wrong. */}
      <div className="surface rounded-blob p-3">
        <div className="text-[13px] font-extrabold text-strong">Where people stall</div>
        {d.stalls === null ? (
          <p className="mt-1 text-[12px] font-bold text-faint">
            &mdash; could not be read.
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {d.stalls.map((s) => {
              const total = Math.max(1, d.stalls!.reduce((n, x) => n + x.stuck, 0));
              return (
                <div key={s.id}>
                  <div className="flex items-baseline justify-between gap-2 text-[12px] font-bold">
                    <span className="truncate text-soft">{s.label}</span>
                    <span className="shrink-0 font-extrabold text-strong tabular-nums">
                      {s.stuck}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-card2">
                    <div
                      className="h-full rounded-full bg-brandyellow"
                      style={{ width: `${Math.round((s.stuck / total) * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* THE HOLDOUT. Without this comparison "the gate improves conversion" is
          unfalsifiable forever - every number is equally consistent with the
          gate helping, hurting, or doing nothing. */}
      <div className="surface rounded-blob p-3">
        <div className="text-[13px] font-extrabold text-strong">Gate vs holdout</div>
        {d.gate.holdoutPct === 0 && d.gate.holdoutNamed === 0 ? (
          <p className="mt-1 text-[12px] font-bold text-soft">
            No holdout is running, so the gate&rsquo;s effect on conversion cannot be
            measured. Set WARMUP_HOLDOUT_PCT in Keys to let a slice buy immediately.
          </p>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[
              { k: "Gated", n: d.holdout.gatedConverted, d: d.holdout.gatedSize },
              { k: "Holdout", n: d.holdout.converted, d: d.holdout.size },
            ].map((arm) => {
              const r = rate(arm.n, arm.d);
              const thin = (arm.d ?? 0) < MIN_ARM;
              return (
                <div key={arm.k} className="rounded-xl bg-card2 p-2">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-faint">
                    {arm.k}
                  </div>
                  <div className="text-[16px] font-extrabold text-strong">
                    {r === null || thin ? (
                      <span className="tabular-nums">
                        <Num v={arm.n} />/<Num v={arm.d} />
                      </span>
                    ) : (
                      <Pct v={r} />
                    )}
                  </div>
                  {thin && (
                    <div className="text-[10px] font-bold text-faint">
                      too few to rate
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-center text-[10px] text-faint">
        Read at {new Date(d.generatedAt).toLocaleTimeString()}. Nothing on this screen
        polls - reload to refresh.
      </p>
    </div>
  );
}
