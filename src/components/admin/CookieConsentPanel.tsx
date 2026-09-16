"use client";

// THE OWNER'S READ ON THE COOKIE LAYER.
//
// Two questions, one screen:
//
//   1. WHAT IS THE FLEET ALLOWING? Newest-answer-per-person per category, with
//      an acceptance rate that is honestly denominated (people who ANSWERED -
//      the never-asked are counted separately, not folded in as refusals).
//
//   2. WHAT ARE THEY BEING ASKED? The inventory the banner and the policy page
//      render from, so "is the disclosure still true" is answerable here rather
//      than by reading a source file.
//
// It renders through the shared fail-dark primitives: an unreadable
// consent_events shows a dash and a red strip, never a confident 0%. On a
// consent surface specifically, a zero the system cannot stand behind is worse
// than no number - "nobody opted in" and "we could not look" lead to opposite
// decisions, and only one of them is ever true.

import { useEffect, useState } from "react";
import { DegradedBanner, Num } from "./primitives";
import type { CookieEntry } from "@/lib/cookies/manifest";

interface CategoryRollup {
  category: string;
  granted: number;
  denied: number;
  rate: number | null;
}

interface Payload {
  version: string;
  rollup: {
    categories: CategoryRollup[];
    answered: number;
    windowDays: number;
  } | null;
  degraded: string[];
  manifest: CookieEntry[];
}

export function CookieConsentPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/cookie-consent", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Payload) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setError("Could not load consent figures.");
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const byCategory = new Map<string, CookieEntry[]>();
  for (const e of data?.manifest ?? []) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }

  return (
    <div className="mt-3 space-y-3">
      <DegradedBanner degraded={error ? [...(data?.degraded ?? []), error] : data?.degraded} />

      <section className="surface rounded-blob p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[13px] font-extrabold text-strong">🍪 Cookie consent</div>
          <div className="text-[11px] font-bold text-faint">
            policy {data?.version ?? "-"} · last {data?.rollup?.windowDays ?? 90} days
          </div>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-soft">
          One answer per person per category - the newest, not every save. The rate is over people
          who answered; nobody who has not seen the banner is counted as a refusal.
        </p>

        <div className="mt-2 text-[12px] font-bold text-soft">
          Answered at least once: <Num v={busy ? null : (data?.rollup?.answered ?? null)} />
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(data?.rollup?.categories ?? [
            { category: "preferences", granted: 0, denied: 0, rate: null },
            { category: "analytics", granted: 0, denied: 0, rate: null },
            { category: "marketing", granted: 0, denied: 0, rate: null },
          ]).map((c) => (
            <div key={c.category} className="rounded-2xl bg-card2 p-3 text-center">
              <div className="text-xl font-extrabold text-strong">
                {busy || !data?.rollup || c.rate === null ? (
                  <span className="text-faint" title="Nobody has answered, or the ledger could not be read">
                    &mdash;
                  </span>
                ) : (
                  `${Math.round(c.rate * 100)}%`
                )}
              </div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-faint">
                {c.category}
              </div>
              <div className="mt-1 text-[10px] font-bold text-faint">
                <Num v={busy || !data?.rollup ? null : c.granted} /> on ·{" "}
                <Num v={busy || !data?.rollup ? null : c.denied} /> off
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* THE DISCLOSURE ITSELF. Not decoration: this is the list the banner
          shows and the /cookies page publishes, so an owner can check that
          what the product stores and what it says it stores are the same
          thing - which is the only question this whole layer exists to keep
          answerable. */}
      <section className="surface rounded-blob p-4">
        <div className="text-[13px] font-extrabold text-strong">What we tell people we store</div>
        <p className="mt-1 text-[11px] leading-snug text-soft">
          Generated from COOKIE_MANIFEST. The test suite fails the build if the app writes a
          browser key that is not on this list, so it cannot quietly fall behind the code.
        </p>
        <div className="mt-2 space-y-2">
          {["necessary", "preferences", "analytics", "marketing"].map((cat) => {
            const entries = byCategory.get(cat) ?? [];
            return (
              <div key={cat} className="rounded-2xl bg-card2 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-[12px] font-extrabold uppercase tracking-wide text-strong">
                    {cat}
                  </div>
                  <div className="text-[10px] font-bold text-faint">{entries.length} declared</div>
                </div>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {entries.map((e) => (
                    <li
                      key={`${e.medium}:${e.name}`}
                      title={`${e.purpose} (kept: ${e.duration})`}
                      className={`rounded-full px-2 py-0.5 font-accent text-[10px] font-bold ${
                        e.party === "first" ? "bg-card text-soft" : "bg-warn-soft text-warn"
                      }`}
                    >
                      {e.name}
                    </li>
                  ))}
                  {entries.length === 0 && (
                    <li className="text-[11px] font-bold text-faint">&mdash;</li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
