"use client";

// THE CHOKE-POINT PANEL (Wave 7, the surface for SCALING.md).
//
// The Keys tab already had a roll call - "is each service answering". This
// card answers the other question, the one that decides whether the next
// hundred users land safely: WHICH CEILING ARE WE CLOSEST TO. The readings,
// each with a threshold attached, because every one of these numbers already
// existed somewhere on some panel with nothing to compare it to, and a number
// you have to know the ceiling by heart to read is a number nobody reads.
//
// The order is SCALING.md's order, worst-first-by-consequence:
//   1. WhatsApp host occupancy - the only ceiling whose failure is a BAN.
//   2. Invited testers vs fleet capacity - the invite decision, pre-computed.
//      A tester past the fleet's capacity signs in fine and then cannot link
//      WhatsApp, so this compares INVITES (pessimistic) rather than pairings.
//   3. Supabase egress against the free 5 GB/month. The audit ranked this
//      ceiling FIRST and it was the only one with no instrument at all - the
//      advice was "watch the Supabase graph during a hunt", which needs a human
//      present at the moment traffic happens and leaves nothing behind. The
//      app counts its own bytes now; a restricted project takes the WHOLE app
//      down, not one feature.
//   4. Queue drain heartbeat - nothing sends unless something pings.
//   5. Database round trip - the PostgREST pool queues before it errors.
//   6. The event kinds PRODUCTION-READINESS.md says should page someone.
//
// The digest button is the deliberate NON-answer to error tracking: no Sentry,
// no new dependency, no new bill - the counts that already exist, mailed to
// the owner through the email lib the app already has, on demand.

import { useCallback, useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";

type ChokeState = "ok" | "warn" | "alarm" | "unknown";

interface Reading {
  id: string;
  label: string;
  state: ChokeState;
  value: string;
  detail: string;
}

interface Snapshot {
  readings: Reading[];
  overall: ChokeState;
  hotHosts: { url: string; users: number; pct: number }[];
  watched: { kind: string; count24h: number | null; newestAgeMs: number | null; paging: boolean }[];
  checkedAt: string;
}

const TONE: Record<ChokeState, string> = {
  ok: "border-savings bg-savings-soft text-savings",
  warn: "border-brandyellow bg-brandyellow-soft text-warn",
  alarm: "border-brandred bg-brandred-soft text-brandred",
  unknown: "border-line bg-card2 text-soft",
};

const LABEL: Record<ChokeState, string> = {
  ok: "OK",
  warn: "WATCH",
  alarm: "ACT NOW",
  unknown: "UNKNOWN",
};

const ago = (ms: number | null) =>
  ms === null ? "never" : ms < 90_000 ? "just now" : `${Math.round(ms / 60_000)}m ago`;

export function ChokePointsCard() {
  // null = NOT LOADED, which is different from "nothing to report". The card
  // says which, rather than rendering an empty green.
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<"load" | "digest" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy("load");
    setError(null);
    try {
      const res = await fetch("/api/admin/chokepoints");
      const d = (await res.json()) as Snapshot & { error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `The choke-point probe answered ${res.status}.`);
      } else {
        setSnap(d);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function emailDigest() {
    setBusy("digest");
    setNote(null);
    try {
      const res = await fetch("/api/admin/chokepoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "digest" }),
      });
      const d = (await res.json()) as { ok?: boolean; detail?: string; error?: string };
      setNote(d.detail ?? d.error ?? "No answer from the digest endpoint.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="surface rounded-blob p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-extrabold text-strong">🚦 Choke points (what breaks first)</h3>
        <button
          onClick={() => void load()}
          disabled={busy !== null}
          className="btn btn-sm chip rounded-xl border-2 border-line px-3 text-[11px] font-extrabold text-brandblue disabled:opacity-60"
        >
          {busy === "load" ? <LoadingDots /> : "↻ Check"}
        </button>
      </div>
      <p className="mb-2 text-[10px] text-faint">
        The four ceilings from SCALING.md, in the order they bite. Each number has its threshold
        attached - green means it was measured and is under the line, not that nobody looked.
      </p>

      {error && (
        <p className="mb-2 rounded-xl bg-brandred-soft p-2 text-[11.5px] font-bold text-brandred">
          The choke-point probe could not be reached - that is unknown, not healthy. {error}
        </p>
      )}

      {snap === null ? (
        busy === "load" ? (
          <LoadingDots label="Measuring the ceilings" />
        ) : (
          !error && <p className="text-[11.5px] font-bold text-soft">Nothing measured yet.</p>
        )
      ) : (
        <div className="space-y-2">
          <div className={`rounded-2xl border-2 p-2.5 text-[11.5px] font-extrabold ${TONE[snap.overall]}`}>
            Overall: {LABEL[snap.overall]}
          </div>

          {snap.readings.map((r) => (
            <div key={r.id} className={`rounded-2xl border-2 p-2.5 ${TONE[r.state]}`}>
              <div className="flex items-center justify-between gap-2 text-[11.5px] font-extrabold">
                <span>{r.label}</span>
                <span className="shrink-0 tabular-nums">{r.value}</span>
              </div>
              <p className="mt-1 text-[10.5px] font-bold leading-snug">{r.detail}</p>
            </div>
          ))}

          {/* The individual hosts near the wall. A fleet average of 50% can
              still hide one host at 39/40, and it is the host that bans. */}
          {snap.hotHosts.length > 0 && (
            <div className="rounded-2xl border-2 border-brandred bg-brandred-soft p-2.5">
              <div className="text-[11px] font-extrabold text-brandred">Hosts near the cap</div>
              <ul className="mt-1 space-y-0.5">
                {snap.hotHosts.map((h) => (
                  <li key={h.url} className="break-all font-mono text-[10px] font-bold text-brandred">
                    {h.url.replace(/^https?:\/\//, "")} - {h.users} users ({h.pct}%)
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Count AND age. A count of 3 that all happened last week is a very
              different fact from 3 in the last ten minutes. */}
          <div className="rounded-2xl bg-card2 p-2.5">
            <div className="text-[11px] font-extrabold text-strong">Watched events (24h)</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {snap.watched.map((w) => (
                <span
                  key={w.kind}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    w.count24h === null
                      ? "bg-brandred-soft text-brandred"
                      : w.count24h > 0 && w.paging
                        ? "bg-brandred-soft text-brandred"
                        : w.count24h > 0
                          ? "bg-brandyellow-soft text-warn"
                          : "bg-card text-soft"
                  }`}
                >
                  {w.kind}: {w.count24h === null ? "unreadable" : w.count24h}
                  {w.count24h !== null && w.count24h > 0 ? ` · last ${ago(w.newestAgeMs)}` : ""}
                </span>
              ))}
            </div>
            <button
              onClick={() => void emailDigest()}
              disabled={busy !== null}
              className="btn btn-sm btn-ghost mt-2 w-full rounded-xl border border-line py-2 text-[11px] font-extrabold disabled:opacity-60"
            >
              {busy === "digest" ? <LoadingDots label="Sending" /> : "✉️ Email me this digest"}
            </button>
            {note && <p className="mt-1 text-[10.5px] font-bold text-soft">{note}</p>}
          </div>

          <p className="text-[10px] text-faint">
            Measured {new Date(snap.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
      )}
    </div>
  );
}
