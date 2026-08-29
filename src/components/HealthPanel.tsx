"use client";

// Live service health (item #12): one bar per measurable service, refreshed
// automatically every 10 minutes while the Keys tab is open, with the last
// check time and a countdown to the next one.

import { useEffect, useRef, useState } from "react";
import { LoadingDots } from "./LoadingDots";

interface Vitals {
  heartbeat: { state: "beating" | "stale" | "never"; ageMs: number | null; action: string | null };
  queue: { waiting: number; overdue: number; oldestOverdueMs: number | null };
  turnLatencyMs: { p50: number | null; p95: number | null; samples: number };
  providerErrors: { degraded: number; total: number; reasons: { reason: string; count: number }[] };
  push24h: { sent: number; failed: number; skipped: number; failureRate: number | null };
}

const agoMins = (ms: number | null | undefined) =>
  typeof ms === "number" ? `${Math.round(ms / 60_000)}m` : "-";

interface ServiceHealth {
  id: string;
  label: string;
  status: "ok" | "degraded" | "down" | "off";
  latencyMs: number | null;
  detail: string;
}

const REFRESH_MS = 10 * 60_000;

const STATUS_META: Record<ServiceHealth["status"], { bar: string; width: string; label: string; text: string }> = {
  ok: { bar: "bg-savings", width: "w-full", label: "HEALTHY", text: "text-savings" },
  degraded: { bar: "bg-brandyellow", width: "w-2/3", label: "DEGRADED", text: "text-warn" },
  down: { bar: "bg-brandred", width: "w-1/4", label: "DOWN", text: "text-brandred" },
  off: { bar: "bg-line", width: "w-1/12", label: "NOT SET", text: "text-faint" },
};

export function HealthPanel() {
  const [services, setServices] = useState<ServiceHealth[] | null>(null);
  // `null` for a single counter means UNKNOWN, not zero - sbCountDark can say
  // so now, and a drop counter that reads zero during an outage is the most
  // reassuring lie this page can tell.
  const [guardCounters, setGuardCounters] = useState<Record<string, number | null> | null>(null);
  const [webhookSilent, setWebhookSilent] = useState(false);
  const [webhookLastAt, setWebhookLastAt] = useState<string | null>(null);
  // THE VITALS, not just the roll call. A services list can be all-green while
  // nothing is draining the queue and no provider is answering - both of which
  // took the product down in the field and were invisible on every screen.
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastCheckFailed, setLastCheckFailed] = useState(false);
  const [nextInS, setNextInS] = useState(REFRESH_MS / 1000);
  const timer = useRef<ReturnType<typeof setInterval>>();

  async function check() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/health");
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      setLastCheckFailed(false);
      if (Array.isArray(d.services)) {
        setServices(d.services);
        setCheckedAt(new Date());
        setNextInS(REFRESH_MS / 1000);
      }
      if (d.guardCounters) setGuardCounters(d.guardCounters);
      setWebhookSilent(Boolean(d.webhookSilent));
      setWebhookLastAt(typeof d.webhookLastAcceptedAt === "string" ? d.webhookLastAcceptedAt : null);
      setVitals(
        d.heartbeat
          ? {
              heartbeat: d.heartbeat,
              queue: d.queue,
              turnLatencyMs: d.turnLatencyMs,
              providerErrors: d.providerErrors,
              push24h: d.push24h,
            }
          : null
      );
    } catch {
      // Keep the last snapshot - but SAY the check failed. The countdown kept
      // animating over stale bars, so a dead health endpoint rendered as a
      // panel of confident statuses from an hour ago.
      setLastCheckFailed(true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    check();
    const refresh = setInterval(check, REFRESH_MS);
    timer.current = setInterval(() => setNextInS((s) => Math.max(0, s - 1)), 1000);
    return () => {
      clearInterval(refresh);
      clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = services?.filter((s) => s.status !== "off") ?? [];
  const okCount = live.filter((s) => s.status === "ok").length;
  const overall =
    live.length === 0
      ? "off"
      : live.some((s) => s.status === "down")
      ? "down"
      : live.some((s) => s.status === "degraded")
      ? "degraded"
      : "ok";
  const overallMeta = STATUS_META[overall as ServiceHealth["status"]];
  const mins = Math.floor(nextInS / 60);

  return (
    <div className="surface rounded-blob p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[13px] font-extrabold text-strong">🩺 Service health</div>
        <button
          onClick={check}
          disabled={busy}
          className="btn btn-sm chip rounded-xl border-2 border-line px-3 text-[11px] font-extrabold text-brandblue disabled:opacity-60"
        >
          {busy ? <LoadingDots /> : "↻ Check now"}
        </button>
      </div>
      <p className="mb-2 text-[10px] text-faint">
        {checkedAt
          ? `Last checked ${checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · next auto-check in ${mins}m ${Math.floor(nextInS % 60)}s`
          : "Running the first check..."}
      </p>
      {lastCheckFailed && (
        <p className="mb-2 rounded-xl border-2 border-brandyellow/50 bg-brandyellow-soft p-2 text-[11px] font-extrabold text-warn">
          The last check FAILED - the bars below are from{" "}
          {checkedAt ? checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "an earlier run"}{" "}
          and may be stale.
        </p>
      )}

      {/* WEBHOOK SILENCE ALERT: shops' replies aren't reaching us (Evolution is
          403ing our webhook - a stale token / lost registration). This is the
          launch-blocker signature; shout, and point to the one-tap fix. */}
      {webhookSilent && (
        <div className="mb-3 rounded-2xl border-2 border-brandred bg-brandred-soft p-3">
          <div className="text-[12px] font-extrabold text-brandred">
            ⚠ Shops' replies aren't reaching us
          </div>
          <p className="mt-1 text-[11px] font-medium text-soft">
            We've sent messages recently and a WhatsApp session is open, but no inbound event has
            arrived in 30 min - Evolution is likely rejecting our webhook. Open{" "}
            <span className="font-extrabold">WA doctor</span> below and tap{" "}
            <span className="font-extrabold">Re-arm webhook</span>.
          </p>
          {webhookLastAt && (
            <p className="mt-1 text-[10px] text-faint">
              Last accepted webhook: {new Date(webhookLastAt).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {/* Overall bar */}
      {services && (
        <div className="mb-3 rounded-2xl bg-card2 p-2.5">
          <div className="flex items-center justify-between text-[11px] font-extrabold">
            <span className="text-strong">Overall</span>
            <span className={overallMeta.text}>
              {okCount}/{live.length || 0} healthy
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line/50">
            <div
              className={`h-full rounded-full ${overallMeta.bar} transition-all`}
              style={{ width: live.length ? `${Math.max(8, (okCount / live.length) * 100)}%` : "8%" }}
            />
          </div>
        </div>
      )}

      {!services ? (
        <LoadingDots label="Probing every service" />
      ) : (
        <div className="space-y-2">
          {services.map((s) => {
            const m = STATUS_META[s.status];
            return (
              <div key={s.id} className="rounded-2xl bg-card2 p-2.5">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-extrabold text-strong">{s.label}</span>
                  <span className={`shrink-0 font-extrabold ${m.text}`}>
                    {m.label}
                    {s.latencyMs != null && s.status !== "off" ? ` · ${s.latencyMs}ms` : ""}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line/50">
                  <div className={`h-full rounded-full ${m.bar} ${m.width} transition-all`} />
                </div>
                <p className="mt-1 text-[10px] text-faint">{s.detail}</p>
              </div>
            );
          })}
        </div>
      )}

      {guardCounters &&
        Object.values(guardCounters).some((n) => n === null || (n ?? 0) > 0) && (
          <div className="mt-2 rounded-2xl bg-card2 p-2.5">
            <div className="text-[11px] font-extrabold text-strong">
              Send-pipeline guardrails (24h)
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {Object.entries(guardCounters)
                .filter(([, n]) => n === null || (n ?? 0) > 0)
                .map(([k, n]) => (
                  <span
                    key={k}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      n === null ? "bg-brandred-soft text-brandred" : "bg-card text-soft"
                    }`}
                  >
                    {k}: {n === null ? "unreadable" : n}
                  </span>
                ))}
            </div>
          </div>
        )}
      {vitals && (
        <div className="mt-2 space-y-2">
          {/* THE WATCHDOG. Nothing drains the outbox or fires a scheduled
              follow-up unless something pings, and for a long time nothing did -
              silently, because every surface only showed what HAD happened.
              "never" and "stale" are different failures with different fixes,
              so the tile says which and what to do about it. */}
          <div
            className={`rounded-2xl border-2 p-2.5 text-[11px] font-bold ${
              vitals.heartbeat.state === "beating"
                ? "border-savings bg-savings-soft text-savings"
                : "border-brandred bg-brandred-soft text-brandred"
            }`}
          >
            <div className="font-extrabold">
              Heartbeat:{" "}
              {vitals.heartbeat.state === "beating"
                ? `beating (last ping ${agoMins(vitals.heartbeat.ageMs)} ago)`
                : vitals.heartbeat.state === "never"
                  ? "NEVER - nothing has ever pinged the drain"
                  : `STALE - last ping ${agoMins(vitals.heartbeat.ageMs)} ago`}
            </div>
            {vitals.heartbeat.action && (
              <p className="mt-1 leading-snug">{vitals.heartbeat.action}</p>
            )}
          </div>

          <div className="rounded-2xl bg-card2 p-2.5">
            <div className="text-[11px] font-extrabold text-strong">Live vitals</div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] font-bold">
              {/* A deep queue is not a problem - the pacing spreads a batch on
                  purpose. A queue of rows whose time has PASSED is. */}
              <span className="rounded-full bg-card px-2 py-0.5 text-soft">
                queue {vitals.queue.waiting}
              </span>
              {vitals.queue.overdue > 0 && (
                <span className="rounded-full bg-brandred-soft px-2 py-0.5 text-brandred">
                  {vitals.queue.overdue} overdue (oldest {agoMins(vitals.queue.oldestOverdueMs)})
                </span>
              )}
              {vitals.turnLatencyMs.samples > 0 && (
                <span className="rounded-full bg-card px-2 py-0.5 text-soft">
                  reply p50 {Math.round((vitals.turnLatencyMs.p50 ?? 0) / 1000)}s · p95{" "}
                  {Math.round((vitals.turnLatencyMs.p95 ?? 0) / 1000)}s
                </span>
              )}
              {vitals.providerErrors.degraded > 0 && (
                <span className="rounded-full bg-brandyellow-soft px-2 py-0.5 text-warn">
                  {vitals.providerErrors.degraded}/{vitals.providerErrors.total} turns with no
                  provider
                </span>
              )}
              {vitals.push24h.failureRate !== null && vitals.push24h.failureRate > 0 && (
                <span className="rounded-full bg-brandyellow-soft px-2 py-0.5 text-warn">
                  push {vitals.push24h.failureRate}% failing ({vitals.push24h.failed}/24h)
                </span>
              )}
            </div>
            {/* "No key configured" and "every key is failing" used to look
                identical. The reasons are the difference. */}
            {vitals.providerErrors.reasons.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-[10px] leading-snug text-soft">
                {vitals.providerErrors.reasons.map((r) => (
                  <li key={r.reason}>
                    <span className="font-extrabold">{r.count}x</span> {r.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      <CronUrlCard />
    </div>
  );
}

// Ready-made cron ping URL (with the derived security token) to paste straight
// into cron-job.org - so the owner never has to compute the token by hand.
// When the server can only see its container bind address (0.0.0.0 on Cloud
// Run behind a stripped proxy) the card flips into an APP_DOMAIN quick-set so
// the owner can fix the public domain in one paste - no Keys spelunking, no
// Secret Manager, no redeploy.
function CronUrlCard() {
  const [data, setData] = useState<
    {
      tokenReady: boolean;
      origin?: string;
      needsDomain?: boolean;
      pingUrl?: string;
      webhookUrl?: string;
      reason?: string;
    } | null
  >(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [domainDraft, setDomainDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  const load = () =>
    fetch("/api/admin/ping-url")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  async function saveDomain() {
    const v = domainDraft.trim();
    if (!v) return;
    setSaving(true);
    setSaveNote(null);
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "APP_DOMAIN", value: v.startsWith("http") ? v : `https://${v}` }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) {
        setSaveNote(String(d.error ?? "Could not save - try again."));
      } else {
        setSaveNote("✓ Saved. Links below now use your public domain.");
        await load();
      }
    } catch {
      setSaveNote("Could not save - check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copy(text: string, which: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked - the field is selectable anyway */
    }
  }

  if (!data) return null;

  return (
    <div className="mt-3 rounded-2xl border-2 border-line p-3">
      <div className="text-[12px] font-extrabold text-strong">⏰ Cron keep-alive URL</div>
      {data.needsDomain && (
        <div className="mt-2 rounded-xl border-2 border-brandred bg-brandred-soft p-2.5">
          <div className="text-[11px] font-extrabold text-brandred">
            Your public domain isn&apos;t set - the links below fall back to the container address
            and shops&apos; replies can&apos;t reach the app.
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              value={domainDraft}
              onChange={(e) => setDomainDraft(e.target.value)}
              placeholder="https://your-app.run.app"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              className="min-w-0 flex-1 rounded-lg border-2 border-line bg-card p-2 font-mono text-[12px] text-strong"
            />
            <button
              onClick={saveDomain}
              disabled={saving || !domainDraft.trim()}
              className="btn btn-sm shrink-0 rounded-lg bg-brandblue px-3 py-2 text-[11px] font-extrabold text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="mt-1 text-[10px] text-faint">
            Paste your app&apos;s public URL (the address in your browser). Saves to the Key Vault
            and applies within ~30 seconds - no redeploy.
          </p>
        </div>
      )}
      {saveNote && <p className="mt-1.5 text-[11px] font-bold text-savings">{saveNote}</p>}
      {!data.tokenReady ? (
        <p className="mt-1 text-[11px] font-bold text-brandred">{data.reason}</p>
      ) : (
        <>
          <p className="mt-1 text-[10px] text-faint">
            Point cron-job.org (or any free pinger) at this every 5-10 minutes. It keeps the
            WhatsApp hosts awake and sends any queued messages. The token is built in - do NOT
            change it.
          </p>
          {(
            [
              ["Ping URL", data.pingUrl!, "ping"],
              ["Evolution webhook URL", data.webhookUrl!, "hook"],
            ] as [string, string, string][]
          ).map(([label, url, key]) => (
            <div key={key} className="mt-2">
              <div className="text-[10px] font-bold text-faint">{label}</div>
              <div className="mt-1 flex items-center gap-1.5">
                <input
                  readOnly
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border-2 border-line bg-card p-2 font-mono text-[11px] text-strong"
                />
                <button
                  onClick={() => copy(url, key)}
                  className="btn btn-sm shrink-0 rounded-lg bg-brandblue px-3 py-2 text-[11px] font-extrabold text-white"
                >
                  {copied === key ? "Copied ✓" : "Copy"}
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
