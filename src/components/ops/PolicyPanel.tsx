"use client";

// Policy & versions - where behavior changes become safe: the clamped
// threshold overlay, the golden regression suite (freeze real conversations,
// every activation must keep them green), full version history with one-click
// rollback, and the learning kill switch.

import { useCallback, useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";
import type { PolicyOverlay } from "@/lib/ops/overlay";
import type { PolicyVersion, ReplayCaseResult, ReplayReport } from "@/lib/ops/types";

interface GoldenRow {
  id: number;
  name: string;
  region: string | null;
  turnCount: number;
  enabled: boolean;
  createdAt: string;
}

const FIELDS: { key: keyof Omit<PolicyOverlay, "bannedPhrases">; label: string; hint: string }[] = [
  { key: "floorTolerance", label: "Floor tolerance", hint: "quote <= floor x this = great price (1.00-1.15)" },
  { key: "priceFarAboveFloor", label: "Far-above-floor", hint: "quote > floor x this = keep pushing past one firm (1.1-1.6)" },
  { key: "sheetAnchor", label: "Price-sheet anchor", hint: "asks bottom out at posted price x this (0.70-0.95)" },
  { key: "lowballGuard", label: "Lowball guard", hint: "never ask below quote x this without a floor (0.50-0.80)" },
  { key: "defaultCut", label: "Default opening cut", hint: "opening ask without a floor: quote x this (0.70-0.95)" },
];

export function PolicyPanel() {
  const [overlay, setOverlay] = useState<PolicyOverlay | null>(null);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [learning, setLearning] = useState(true);
  const [activeRev, setActiveRev] = useState<number | null>(null);
  const [golden, setGolden] = useState<GoldenRow[] | null>(null);
  const [note, setNote] = useState("");
  const [banned, setBanned] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [report, setReport] = useState<ReplayReport | null>(null);
  const [stepping, setStepping] = useState<number | null>(null);

  const [loadErr, setLoadErr] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(false);
    const [p, g] = await Promise.all([
      fetch("/api/admin/ops/policy").then((r) => r.json()).catch(() => null),
      fetch("/api/admin/ops/golden").then((r) => r.json()).catch(() => null),
    ]);
    if (p?.overlay) {
      setOverlay(p.overlay);
      setBanned((p.overlay.bannedPhrases ?? []).join(", "));
      setVersions(p.versions ?? []);
      setLearning(Boolean(p.learningEnabled));
      setActiveRev(p.activeRev ?? null);
    } else {
      // A 403, a 5xx, a non-JSON error page and an unreachable server all
      // used to land in the same silent hole: a permanent spinner with no
      // error and no retry - exactly the defect the Command tab's comment
      // records fixing. An error is a card, never a forever-skeleton.
      setLoadErr(true);
    }
    setGolden(Array.isArray(g?.cases) ? g.cases : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadErr && !overlay) {
    return (
      <div className="rounded-blob border-2 border-brandred/40 bg-brandred-soft p-4 text-center">
        <p className="text-[13px] font-extrabold text-brandred">
          The policy state could not be read - nothing here is known right now.
        </p>
        <button
          onClick={() => {
            setGolden(null);
            void load();
          }}
          className="btn btn-sm mt-2 rounded-xl border-2 border-brandred/40 px-3 text-[11px] font-extrabold text-brandred"
        >
          ↻ Retry
        </button>
      </div>
    );
  }
  if (!overlay || golden === null) return <LoadingDots label="Loading policy state" />;

  const post = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/ops/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d?.report) setReport(d.report);
      if (res.ok) {
        setMsg({ tone: "ok", text: label === "save" ? "Overlay activated - golden suite green." : "Done." });
        await load();
      } else {
        setMsg({ tone: "bad", text: d?.error ?? "Failed." });
      }
    } catch {
      setMsg({ tone: "bad", text: "Could not reach the server." });
    } finally {
      setBusy(null);
    }
  };

  const runSuite = async () => {
    setBusy("suite");
    setMsg(null);
    try {
      const res = await fetch("/api/admin/ops/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: { kind: "policy_overlay", spec: { ...overlay, bannedPhrases: bannedList() } } }),
      });
      const d = await res.json();
      setReport(d?.candidate ?? d?.baseline ?? null);
      const r = d?.candidate ?? d?.baseline;
      if (r) {
        setMsg({
          tone: r.passed === r.total ? "ok" : "bad",
          text: `Golden suite under these values: ${r.passed}/${r.total} passed.`,
        });
      }
    } catch {
      setMsg({ tone: "bad", text: "Replay failed." });
    } finally {
      setBusy(null);
    }
  };

  const bannedList = () =>
    banned
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

  const goldenAction = async (action: "toggle" | "delete", id: number) => {
    await fetch("/api/admin/ops/golden", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id }),
    }).catch(() => {});
    await load();
  };

  return (
    <div className="space-y-3">
      {/* Learning kill switch */}
      <div className="surface flex items-center gap-3 rounded-blob p-3.5">
        <div className="min-w-0 flex-1">
          <h4 className="text-[13px] font-extrabold text-strong">Compiled learning</h4>
          <p className="text-[11px] text-soft">
            Edge priors, exemplars and judge calibration flowing into live prompts.
            {activeRev != null && ` Active behavior revision: ${activeRev}.`}
          </p>
        </div>
        <button
          onClick={() => post("learning", { action: "learning", on: !learning })}
          className={`chip shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-extrabold ${
            learning ? "border-savings bg-savings-soft text-savings" : "border-brandred bg-brandred-soft text-brandred"
          }`}
        >
          {learning ? "ON" : "OFF"}
        </button>
      </div>

      {/* Overlay editor */}
      <div className="surface rounded-blob p-3.5">
        <h4 className="text-[13px] font-extrabold text-strong">🎚️ Negotiation thresholds</h4>
        <p className="mt-0.5 text-[11px] text-soft">
          Hard-clamped - defaults equal the shipped behavior. Activation runs the golden suite
          first; a red suite blocks the change.
        </p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="text-[11px] font-extrabold text-strong">{f.label}</span>
              <input
                type="number"
                step="0.01"
                value={overlay[f.key]}
                onChange={(e) => setOverlay({ ...overlay, [f.key]: Number(e.target.value) })}
                className="mt-0.5 h-10 w-full rounded-xl border-2 border-line bg-card px-2.5 text-[13px] text-strong focus:border-brandblue focus:outline-none"
              />
              <span className="text-[9px] text-faint">{f.hint}</span>
            </label>
          ))}
          <label className="block sm:col-span-2">
            <span className="text-[11px] font-extrabold text-strong">Banned phrases</span>
            <input
              value={banned}
              onChange={(e) => setBanned(e.target.value)}
              placeholder="final offer, last chance, take it or leave it"
              className="mt-0.5 h-10 w-full rounded-xl border-2 border-line bg-card px-2.5 text-[13px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
            <span className="text-[9px] text-faint">
              Deterministically scrubbed from every outbound message.
            </span>
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why this change? (audit note)"
            className="h-10 min-w-0 flex-1 rounded-xl border-2 border-line bg-card px-2.5 text-[12px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
          />
          <button onClick={runSuite} disabled={busy !== null} className="btn btn-ghost btn-sm rounded-xl px-3">
            {busy === "suite" ? "Replaying..." : "🧪 Test against suite"}
          </button>
          <button
            onClick={() =>
              post("save", {
                action: "save",
                kind: "policy_overlay",
                spec: { ...overlay, bannedPhrases: bannedList() },
                note: note || "Overlay update from the Ops Center",
              })
            }
            disabled={busy !== null}
            className="btn btn-primary btn-sm rounded-xl px-4"
          >
            {busy === "save" ? "Gating..." : "Run gate & activate"}
          </button>
        </div>
        {msg && (
          <p className={`mt-2 text-[11px] font-bold ${msg.tone === "ok" ? "text-savings" : "text-brandred"}`}>
            {msg.text}
          </p>
        )}
        {report && report.cases.some((c) => !c.pass) && (
          <div className="mt-2 space-y-1">
            {report.cases
              .filter((c) => !c.pass)
              .map((c) => (
                <div key={c.caseId} className="rounded-xl bg-brandred-soft p-2 text-[11px] text-brandred">
                  <b>{c.name}</b>
                  {c.turns
                    .filter((t) => t.failures.length)
                    .map((t) => (
                      <p key={t.turn}>
                        turn {t.turn + 1}: {t.failures.join("; ")}
                      </p>
                    ))}
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Golden suite */}
      <div className="surface rounded-blob p-3.5">
        <h4 className="text-[13px] font-extrabold text-strong">
          🏅 Golden suite ({golden.filter((g) => g.enabled).length} enabled)
        </h4>
        <p className="mt-0.5 text-[11px] text-soft">
          Real conversations frozen as regression tests. Add more from any conversation's
          header - the gate tightens automatically.
        </p>
        {golden.length === 0 && (
          <p className="mt-2 rounded-xl bg-card2 p-2.5 text-[11px] text-soft">
            No cases yet - open a good (or bad!) negotiation in All conversations and tap
            "Add to golden set". Until then, changes activate ungated.
          </p>
        )}
        <div className="mt-2 space-y-1.5">
          {golden.map((g) => (
            <div key={g.id}>
              <div className="flex items-center gap-2 rounded-xl bg-card2 px-2.5 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-extrabold text-strong">{g.name}</p>
                  <p className="text-[9px] text-faint">
                    {g.turnCount} turn{g.turnCount === 1 ? "" : "s"}
                    {g.region ? ` · ${g.region}` : ""} · {new Date(g.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => setStepping(stepping === g.id ? null : g.id)}
                  className="chip rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-brandblue"
                >
                  ▶ Step
                </button>
                <button
                  onClick={() => goldenAction("toggle", g.id)}
                  className={`chip rounded-full border px-2 py-0.5 text-[10px] font-extrabold ${
                    g.enabled ? "border-savings bg-savings-soft text-savings" : "border-line text-faint"
                  }`}
                >
                  {g.enabled ? "on" : "off"}
                </button>
                <button
                  onClick={() => goldenAction("delete", g.id)}
                  className="chip rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-brandred"
                >
                  ✕
                </button>
              </div>
              {stepping === g.id && <ReplayStepper caseId={g.id} />}
            </div>
          ))}
        </div>
      </div>

      {/* Version history - full ReplayStepper component defined below */}
      <div className="surface rounded-blob p-3.5">
        <h4 className="text-[13px] font-extrabold text-strong">🗂️ Version history</h4>
        <p className="mt-0.5 text-[11px] text-soft">
          Every behavior change, snapshotted. Rollback re-activates an old version (it must
          still pass the current golden suite).
        </p>
        {versions.length === 0 && (
          <p className="mt-2 text-[11px] text-faint">No versions recorded yet.</p>
        )}
        <div className="mt-2 space-y-1.5">
          {versions.map((v) => (
            <div key={v.id} className="flex items-center gap-2 rounded-xl bg-card2 px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-bold text-strong">
                  <span className="font-extrabold">
                    {v.kind === "graph_spec"
                      ? "Graph"
                      : v.kind === "ops_learning"
                        ? "Learning"
                        : "Overlay"}{" "}
                    v{v.version}
                  </span>
                  {v.note ? ` - ${v.note}` : ""}
                </p>
                <p className="text-[9px] text-faint">
                  {v.author} · {new Date(v.created_at).toLocaleString()}
                  {v.replay_score ? ` · gate ${v.replay_score.passed}/${v.replay_score.total}` : ""}
                </p>
              </div>
              {v.active ? (
                <span className="shrink-0 rounded-full bg-savings-soft px-2 py-0.5 text-[9px] font-extrabold text-savings">
                  ACTIVE
                </span>
              ) : (
                <button
                  onClick={() => post("rollback", { action: "rollback", versionId: v.id })}
                  disabled={busy !== null}
                  className="chip shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-soft"
                >
                  Roll back
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Step through one golden case decision-by-decision: shop message in, engine
// decision out (action, chosen edge, target, composed message) with the
// expectation check per turn - a movie of the negotiation under the LIVE spec.
function ReplayStepper({ caseId }: { caseId: number }) {
  const [result, setResult] = useState<ReplayCaseResult | null>(null);
  const [step, setStep] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/admin/ops/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseIds: [caseId] }),
    })
      .then((r) => r.json())
      .then((d) => {
        const c = d?.baseline?.cases?.[0];
        if (c) setResult(c);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [caseId]);

  if (failed) {
    return <p className="mt-1 px-2 text-[10px] text-brandred">Replay failed to run.</p>;
  }
  if (!result) return <div className="mt-1 px-2"><LoadingDots label="Replaying" /></div>;
  const t = result.turns[step];
  if (!t) return null;

  return (
    <div className="ml-2 mt-1 rounded-2xl border border-line bg-card p-2.5">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setStep(Math.max(0, step - 1))}
          disabled={step === 0}
          className="chip rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-soft disabled:opacity-40"
        >
          ‹ Prev
        </button>
        <span className="text-[10px] font-extrabold text-strong">
          Turn {step + 1}/{result.turns.length}
        </span>
        <button
          onClick={() => setStep(Math.min(result.turns.length - 1, step + 1))}
          disabled={step >= result.turns.length - 1}
          className="chip rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-soft disabled:opacity-40"
        >
          Next ›
        </button>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
            t.failures.length === 0 ? "bg-savings-soft text-savings" : "bg-brandred-soft text-brandred"
          }`}
        >
          {t.failures.length === 0 ? "PASS" : "FAIL"}
        </span>
      </div>
      {t.shopSays && (
        <p className="mt-1.5 rounded-xl bg-card2 px-2 py-1.5 text-[11px] text-strong">
          🏪 {t.shopSays}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded-full bg-brandblue-soft px-2 py-0.5 font-extrabold text-brandblue">
          {t.got.action}
        </span>
        {t.got.edgeId && <span className="text-soft">via {t.got.edgeId}</span>}
        {typeof t.got.target === "number" && <span className="text-soft">target {t.got.target}</span>}
      </div>
      {t.got.path.length > 0 && (
        <p className="mt-1 truncate text-[9px] text-faint">{t.got.path.join(" → ")}</p>
      )}
      {t.got.message && (
        <p className="mt-1.5 rounded-xl bg-brandblue-soft px-2 py-1.5 text-[11px] text-strong">
          🤖 {t.got.message}
        </p>
      )}
      {t.failures.length > 0 && (
        <p className="mt-1.5 text-[10px] font-bold text-brandred">{t.failures.join("; ")}</p>
      )}
    </div>
  );
}
