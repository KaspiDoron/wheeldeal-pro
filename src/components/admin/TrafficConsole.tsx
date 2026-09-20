"use client";

// Admin -> Traffic. What the sponsored-search placements did, what the
// partners say they paid for, and whether those two stories agree.
//
// THREE RULES THIS SCREEN KEEPS.
//   1. It reports the configuration, it does not edit it. TRAFFIC_MODE and
//      TRAFFIC_PARTNERS live in Admin -> Keys with every other integration;
//      two places to change one value is how they end up disagreeing.
//   2. Unknown is a dash, never a zero (the shared fail-dark primitives). A
//      revenue screen reading 0 because the database is down tells its owner a
//      bad week happened when nothing of the kind is known.
//   3. Every line of the partner registry that FAILED validation is shown, in
//      red, at the top. A partner that silently earns nothing looks exactly
//      like a slow week until somebody reads the config.

import { useCallback, useEffect, useState } from "react";
import { DegradedBanner, Num } from "./primitives";

interface Line {
  placement: string;
  market: string;
  ourClicks: number;
  partnerClicks: number;
  clickGap: number;
  gross: number;
  net: number;
  netPerThousandClicks: number;
  flag: "under-counted" | "over-counted" | null;
}

interface Payload {
  config: {
    mode: "off" | "test" | "live";
    cmp: "none" | "google";
    errors: string[];
    partners: { id: string; label: string; kind: "afs" | "link"; enabled: boolean; markets: string[]; revenueShare: number; target: string }[];
  };
  report: {
    days: number;
    since: string;
    truncated: boolean;
    degraded: string[];
    totals: { unitLoaded: number; unitEmpty: number; serpViews: number; linkClicks: number; fillRate: number | null };
    byPlacement: { placement: string; market: string; unitLoaded: number; unitEmpty: number; followed: number }[];
    partners: {
      id: string;
      label: string;
      kind: "afs" | "link";
      enabled: boolean;
      reconciliation: { lines: Line[]; unattributed: { clicks: number; gross: number }; totals: { ourClicks: number; partnerClicks: number; gross: number; net: number } } | null;
    }[];
  };
  canImport: boolean;
}

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Tile({ label, value, hint }: { label: string; value: number | string | null; hint: string }) {
  return (
    <div className="rounded-2xl bg-card2 p-3 text-center" title={hint}>
      <div className="text-lg font-extrabold text-strong">{typeof value === "string" ? value : <Num v={value} />}</div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{label}</div>
    </div>
  );
}

export function TrafficConsole() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partner, setPartner] = useState("");
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<{ ok: boolean; text: string; problems: string[] } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/traffic?days=${days}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as Payload;
      setData(d);
      setPartner((p) => p || d.config.partners[0]?.id || "");
    } catch {
      setError("Could not load the traffic report.");
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const onFile = async (file: File | null) => {
    if (!file || !partner) return;
    setImporting(true);
    setImportNote(null);
    try {
      const csv = await file.text();
      const res = await fetch("/api/admin/traffic/revenue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partner, csv }),
      });
      const d = (await res.json().catch(() => null)) as
        | { ok?: boolean; saved?: number; total?: number; skipped?: number; problems?: string[]; error?: string }
        | null;
      // Report what PERSISTED. A 502 here is a partial import and says so.
      setImportNote({
        ok: res.ok && d?.ok === true,
        text:
          d?.error ??
          `${d?.saved ?? 0} of ${d?.total ?? 0} rows saved${d?.skipped ? `, ${d.skipped} unreadable rows skipped` : ""}.`,
        problems: d?.problems ?? [],
      });
      if (res.ok) void load();
    } catch {
      setImportNote({ ok: false, text: "The import did not reach the server. Nothing was saved.", problems: [] });
    } finally {
      setImporting(false);
    }
  };

  if (error) {
    return (
      <div className="rounded-blob border-2 border-brandred/40 bg-brandred-soft p-3 text-[12px] font-extrabold text-brandred">
        {error}{" "}
        <button onClick={() => void load()} className="underline">
          Retry
        </button>
      </div>
    );
  }
  if (!data) return <div className="surface rounded-blob p-4 text-[12px] font-bold text-faint">Loading the traffic report...</div>;

  const { config, report } = data;
  const dark = report.degraded.includes("traffic_events");
  const t = report.totals;

  return (
    <div className="space-y-3">
      <DegradedBanner degraded={report.degraded} />

      {config.errors.length > 0 && (
        <div className="rounded-blob border-2 border-brandred/40 bg-brandred-soft p-3">
          <div className="text-[12px] font-extrabold text-brandred">
            TRAFFIC_PARTNERS has {config.errors.length} line{config.errors.length === 1 ? "" : "s"} that were rejected - those partners are NOT live:
          </div>
          <ul className="mt-1 list-disc pl-5 text-[11.5px] font-bold leading-snug text-brandred">
            {config.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="surface rounded-blob p-3">
        <h3 className="text-[13px] font-extrabold text-strong">Status</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile
            label="mode"
            value={config.mode.toUpperCase()}
            hint="TRAFFIC_MODE in Admin -> Keys. OFF renders nothing anywhere. TEST serves Google's adtest ads, which earn nothing and are never logged. LIVE earns."
          />
          <Tile
            label="partners live"
            value={config.partners.filter((p) => p.enabled).length}
            hint="Partners in TRAFFIC_PARTNERS that parsed cleanly and are switched on."
          />
          <Tile
            label="certified CMP"
            value={config.cmp === "google" ? "GOOGLE" : "NONE"}
            hint="TRAFFIC_TCF_CMP. Google serves no search ads in the EEA, UK or Switzerland without a Google-certified TCF consent platform, so until this reads GOOGLE they are not even requested there."
          />
          <Tile
            label="fill rate"
            value={dark || t.fillRate === null ? null : `${Math.round(t.fillRate * 100)}%`}
            hint="Of the related-search units that asked Google for suggestions, the share that received any. Low fill on a new page is normal for the first hour - Google crawls the article before it writes terms for it."
          />
        </div>
        {config.mode === "off" && (
          <p className="mt-2 rounded-2xl bg-card2 p-2.5 text-[11px] font-bold leading-snug text-soft">
            Sponsored search is switched off, so no visitor sees a placement and nothing is logged. To turn it on: Admin -&gt; Keys -&gt;
            set TRAFFIC_PARTNERS, then set TRAFFIC_MODE to <span className="text-strong">test</span> to check the layout and to{" "}
            <span className="text-strong">live</span> to earn.
          </p>
        )}
        {config.mode !== "off" && config.cmp === "none" && (
          <p className="mt-2 rounded-2xl bg-warn-soft p-2.5 text-[11px] font-bold leading-snug text-warn">
            Visitors in the EEA, the UK and Switzerland are not shown Google&apos;s search unit, because Google will not serve there
            without a certified consent platform. Publish a GDPR message in AdSense -&gt; Privacy &amp; messaging (free), then set
            TRAFFIC_TCF_CMP to google.
          </p>
        )}
      </section>

      <section className="surface rounded-blob p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-extrabold text-strong">Placements, last {report.days} days</h3>
          <div className="flex gap-1">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`rounded-lg px-2 py-1 text-[10px] font-extrabold ${days === d ? "bg-brandblue text-white" : "bg-card2 text-soft"}`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
        {report.truncated && (
          <p className="mt-2 rounded-2xl bg-warn-soft p-2 text-[11px] font-bold text-warn">
            There are more events in this window than this screen reads. The figures below cover the most recent 20,000 only - pick a
            shorter window for exact totals.
          </p>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="units shown" value={dark ? null : t.unitLoaded} hint="A related-search unit loaded with suggestions in it, for a visitor who allowed advertising." />
          <Tile label="units empty" value={dark ? null : t.unitEmpty} hint="Google returned no suggestions. Nothing was shown - an unfilled unit leaves no frame on the page." />
          <Tile label="reached /search" value={dark ? null : t.serpViews} hint="Visitors who arrived on our results page. This site cannot see clicks inside Google's unit, so arrival here is the nearest first-party fact." />
          <Tile label="partner link taps" value={dark ? null : t.linkClicks} hint="Taps on a labelled sponsored link to a link partner, logged as the visitor leaves." />
        </div>
        {report.byPlacement.length > 0 && (
          <div className="mt-3 overflow-x-auto overscroll-x-contain rounded-2xl border-2 border-line">
            <table className="w-full min-w-[420px] text-left text-[12px]">
              <thead>
                <tr className="bg-card2 text-[10px] uppercase tracking-wide text-faint">
                  <th className="px-3 py-2">Placement</th>
                  <th className="px-3 py-2">Market</th>
                  <th className="px-3 py-2 text-right">Shown</th>
                  <th className="px-3 py-2 text-right">Empty</th>
                  <th className="px-3 py-2 text-right">Followed</th>
                </tr>
              </thead>
              <tbody>
                {report.byPlacement.map((p) => (
                  <tr key={`${p.placement}|${p.market}`} className="border-t border-line">
                    <td className="px-3 py-2 font-bold text-strong">{p.placement}</td>
                    <td className="px-3 py-2 uppercase text-soft">{p.market}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-soft">{p.unitLoaded.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-soft">{p.unitEmpty.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold text-strong">{p.followed.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!dark && report.byPlacement.length === 0 && (
          <p className="mt-3 text-[11.5px] font-bold text-faint">Nothing logged in this window yet.</p>
        )}
      </section>

      {report.partners.map((p) => (
        <section key={p.id} className="surface rounded-blob p-3">
          <h3 className="text-[13px] font-extrabold text-strong">
            {p.label}{" "}
            <span className="ml-1 rounded bg-card2 px-1.5 py-0.5 text-[9px] font-bold uppercase text-faint">
              {p.kind === "afs" ? "Google in-page" : "link partner"}
            </span>
            {!p.enabled && <span className="ml-1 rounded bg-warn-soft px-1.5 py-0.5 text-[9px] font-bold uppercase text-warn">paused</span>}
          </h3>
          {p.reconciliation === null ? (
            <p className="mt-2 text-[11.5px] font-bold text-faint">Revenue could not be read.</p>
          ) : p.reconciliation.totals.gross === 0 && p.reconciliation.lines.length === 0 ? (
            <p className="mt-2 text-[11.5px] font-bold text-faint">No revenue imported for this window.</p>
          ) : (
            <>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Tile label="gross" value={money(p.reconciliation.totals.gross)} hint="What the partner's report says these placements earned." />
                <Tile label="net to us" value={money(p.reconciliation.totals.net)} hint="Gross times this partner's revenue share from TRAFFIC_PARTNERS." />
                <Tile
                  label="unattributed"
                  value={money(p.reconciliation.unattributed.gross)}
                  hint="Revenue on rows whose sub-id this app did not build, so it cannot be placed. Google reports by CHANNEL rather than sub-id, so for the in-page unit all of it lands here - that is expected, not a fault."
                />
              </div>
              {p.reconciliation.lines.length > 0 && (
                <div className="mt-3 overflow-x-auto overscroll-x-contain rounded-2xl border-2 border-line">
                  <table className="w-full min-w-[520px] text-left text-[12px]">
                    <thead>
                      <tr className="bg-card2 text-[10px] uppercase tracking-wide text-faint">
                        <th className="px-3 py-2">Placement</th>
                        <th className="px-3 py-2">Market</th>
                        <th className="px-3 py-2 text-right">Ours</th>
                        <th className="px-3 py-2 text-right">Theirs</th>
                        <th className="px-3 py-2 text-right">Net</th>
                        <th className="px-3 py-2 text-right">Net / 1k</th>
                        <th className="px-3 py-2">Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.reconciliation.lines.map((l) => (
                        <tr key={`${l.placement}|${l.market}`} className="border-t border-line">
                          <td className="px-3 py-2 font-bold text-strong">{l.placement}</td>
                          <td className="px-3 py-2 uppercase text-soft">{l.market}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-soft">{l.ourClicks.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-soft">{l.partnerClicks.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold text-strong">{money(l.net)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-soft">{money(l.netPerThousandClicks)}</td>
                          <td className="px-3 py-2">
                            {l.flag === "under-counted" && (
                              <span
                                className="rounded bg-brandred-soft px-1.5 py-0.5 text-[9.5px] font-extrabold text-brandred"
                                title="The partner counted under 60% of the clicks we sent. It is discarding them as invalid or not counting them - the pattern that ends in a clawback. Look at this placement's traffic source."
                              >
                                UNDER-COUNTED {Math.round(l.clickGap * 100)}%
                              </span>
                            )}
                            {l.flag === "over-counted" && (
                              <span
                                className="rounded bg-warn-soft px-1.5 py-0.5 text-[9.5px] font-extrabold text-warn"
                                title="The partner reports far more clicks than we logged. Our own logging is losing clicks on this placement."
                              >
                                WE UNDER-LOGGED
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {p.kind === "afs" && (
                <p className="mt-2 text-[10.5px] font-bold leading-snug text-faint">
                  No gap check for Google&apos;s unit: we count visitors reaching /search, Google counts clicks on an ad there, so
                  theirs over ours is an ad click-through rate, not a counting dispute.
                </p>
              )}
            </>
          )}
        </section>
      ))}

      {data.canImport && config.partners.length > 0 && (
        <section className="surface rounded-blob p-3">
          <h3 className="text-[13px] font-extrabold text-strong">Import a partner&apos;s revenue report</h3>
          <p className="mt-1 text-[11px] font-bold leading-snug text-soft">
            A CSV with a date, a sub-id (or channel), clicks and revenue column, in any order. Importing the same day again REPLACES it,
            so load the partner&apos;s finalised file over its early estimate. Every import is written to the audit trail.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={partner}
              onChange={(e) => setPartner(e.target.value)}
              aria-label="Partner"
              className="rounded-xl border-2 border-line bg-card px-3 py-2 text-[16px] font-bold text-strong"
            >
              {config.partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <label className={`btn btn-sm rounded-xl bg-brandblue px-3 py-2 text-[12px] font-extrabold text-white ${importing ? "opacity-60" : "cursor-pointer"}`}>
              {importing ? "Importing..." : "Choose CSV"}
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                disabled={importing}
                onChange={(e) => {
                  void onFile(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {importNote && (
            <div className={`mt-2 rounded-2xl p-2.5 text-[11.5px] font-bold leading-snug ${importNote.ok ? "bg-card2 text-strong" : "bg-brandred-soft text-brandred"}`}>
              {importNote.text}
              {importNote.problems.length > 0 && (
                <ul className="mt-1 list-disc pl-5 font-normal">
                  {importNote.problems.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {config.partners.length > 0 && (
        <section className="surface rounded-blob p-3">
          <h3 className="text-[13px] font-extrabold text-strong">Configured partners</h3>
          <ul className="mt-2 space-y-1.5">
            {config.partners.map((p) => (
              <li key={p.id} className="rounded-2xl bg-card2 p-2.5 text-[11.5px] leading-snug">
                <span className="font-extrabold text-strong">{p.label}</span>{" "}
                <span className="text-faint">
                  ({p.id}, {p.kind}, {p.enabled ? "on" : "off"}, {p.markets.length ? p.markets.join(" ").toUpperCase() : "all markets"}, share{" "}
                  {Math.round(p.revenueShare * 100)}%)
                </span>
                <div className="break-all font-bold text-soft">{p.target}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
