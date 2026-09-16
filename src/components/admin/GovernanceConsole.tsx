"use client";

// THE DATA & PRIVACY CONSOLE.
//
// One screen that answers the four questions an operator is actually asked,
// each from the system that already knows the answer rather than from a number
// somebody maintains by hand:
//
//   POSTURE   what are we asking people to agree to, and what did they say
//   SUBJECT   what do we hold about THIS person, and what did they consent to
//   REGISTER  the consent ledger as a file an auditor can open
//   TRAIL     who in this organisation has been in the data
//
// THE RULE THIS WHOLE SURFACE IS BUILT ON: a figure that could not be read
// renders as a dash, never a zero. It matters more here than anywhere else in
// the product, because "nobody opted into analytics" and "we cannot see who
// opted into analytics" lead to opposite decisions and only one of them is ever
// true. `Num` and `DegradedBanner` are the shared primitives for exactly that,
// and every number below goes through them.
//
// WHAT IS DELIBERATELY ABSENT: row content. The subject view shows COUNTS. The
// content is reachable only through the export button, which is owner-only and
// writes its own audit line - because a console that renders somebody's
// WhatsApp history as a side effect of typing their address is a surveillance
// tool with a compliance label on it.

import { useCallback, useEffect, useState } from "react";
import { DegradedBanner, Num } from "./primitives";
import type { CookieEntry } from "@/lib/cookies/manifest";

type Section = "posture" | "subject" | "trail";

interface CategoryRollup {
  category: string;
  granted: number;
  denied: number;
  rate: number | null;
}

interface AuditEntry {
  id?: number;
  actorEmail: string;
  actorRole: string;
  action: string;
  subjectEmail?: string | null;
  detail?: Record<string, unknown> | null;
  outcome?: string;
  at?: number;
}

interface Register {
  policy: {
    cookieVersion: string;
    termsVersion: string;
    categories: string[];
    declaredKeys: number;
    thirdParty: { name: string; party: string; category: string }[];
  };
  manifest: CookieEntry[];
  rollup: { categories: CategoryRollup[]; answered: number; windowDays: number } | null;
  erasure: { registeredTables: number; keyedColumns: number };
  audit: AuditEntry[];
  degraded: string[];
  windowDays: number;
}

interface SubjectFile {
  email: string;
  accountExists: boolean | null;
  tables: { table: string; rows: number | null }[];
  knownRows: number;
  cookieConsent: {
    category: string;
    kind: string;
    granted: boolean | null;
    at: number | null;
    version: string | null;
  }[];
  ledger: {
    kind: string;
    version: string;
    at: number;
    granted?: boolean;
    degraded?: boolean;
  }[];
  ledgerDegraded: boolean;
  degraded: string[];
}

const when = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "-";

export function GovernanceConsole() {
  const [section, setSection] = useState<Section>("posture");
  const [days, setDays] = useState(90);
  const [reg, setReg] = useState<Register | null>(null);
  const [regBusy, setRegBusy] = useState(true);
  const [regError, setRegError] = useState<string | null>(null);

  const loadRegister = useCallback((windowDays: number) => {
    setRegBusy(true);
    setRegError(null);
    fetch(`/api/admin/governance/register?days=${windowDays}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Register) => setReg(d))
      .catch(() => setRegError("The governance overview could not be loaded."))
      .finally(() => setRegBusy(false));
  }, []);

  useEffect(() => {
    loadRegister(days);
  }, [days, loadRegister]);

  return (
    <div className="mt-3 space-y-3">
      <div className="surface rounded-blob p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="text-[14px] font-extrabold text-strong">🛡 Data &amp; Privacy</div>
            <p className="mt-0.5 text-[11px] leading-snug text-soft">
              Consent posture, subject files, the consent register and the audit trail. Every
              figure that could not be read shows as &mdash;, never as zero.
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            {(["posture", "subject", "trail"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSection(s)}
                className={`btn btn-sm rounded-xl px-3 py-1.5 text-[11px] font-extrabold capitalize ${
                  section === s ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
                }`}
              >
                {s === "posture" ? "📊 posture" : s === "subject" ? "🔎 subject" : "📜 trail"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <DegradedBanner degraded={regError ? [...(reg?.degraded ?? []), regError] : reg?.degraded} />

      {section === "posture" && (
        <PostureSection reg={reg} busy={regBusy} days={days} onDays={setDays} />
      )}
      {section === "subject" && <SubjectSection />}
      {section === "trail" && <TrailSection entries={reg?.audit ?? []} busy={regBusy} />}
    </div>
  );
}

// ---- POSTURE ----------------------------------------------------------------

function PostureSection({
  reg,
  busy,
  days,
  onDays,
}: {
  reg: Register | null;
  busy: boolean;
  days: number;
  onDays: (d: number) => void;
}) {
  const byCategory = new Map<string, CookieEntry[]>();
  for (const e of reg?.manifest ?? []) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }

  return (
    <div className="space-y-3">
      <section className="surface rounded-blob p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[13px] font-extrabold text-strong">Consent posture</div>
          <div className="flex gap-1">
            {[30, 90, 365].map((d) => (
              <button
                key={d}
                onClick={() => onDays(d)}
                className={`btn btn-sm rounded-lg px-2 py-1 text-[10px] font-extrabold ${
                  days === d ? "bg-brandblue text-white" : "text-faint hover:bg-card2"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-soft">
          One answer per person per category - the newest, not every save. The rate is over people
          who answered; nobody who has not seen the banner is counted as a refusal.
        </p>

        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile
            label="answered"
            value={busy || !reg?.rollup ? null : reg.rollup.answered}
            hint="People with at least one recorded cookie answer in this window."
          />
          {(reg?.rollup?.categories ?? [
            { category: "preferences", granted: 0, denied: 0, rate: null },
            { category: "analytics", granted: 0, denied: 0, rate: null },
            { category: "marketing", granted: 0, denied: 0, rate: null },
          ]).map((c) => (
            <div key={c.category} className="rounded-2xl bg-card2 p-3 text-center">
              <div className="text-xl font-extrabold text-strong">
                {busy || !reg?.rollup || c.rate === null ? (
                  <span
                    className="text-faint"
                    title="Nobody has answered, or the ledger could not be read"
                  >
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
                <Num v={busy || !reg?.rollup ? null : c.granted} /> on ·{" "}
                <Num v={busy || !reg?.rollup ? null : c.denied} /> off
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="surface rounded-blob p-4">
        <div className="text-[13px] font-extrabold text-strong">Policy in force</div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile
            label="cookie policy"
            value={reg?.policy.cookieVersion ?? null}
            hint="Bumping this re-asks every person on their next load."
          />
          <Tile
            label="terms version"
            value={reg?.policy.termsVersion ?? null}
            hint="Bumping this puts every existing user through re-acceptance at sign-in."
          />
          <Tile
            label="declared keys"
            value={reg?.policy.declaredKeys ?? null}
            hint="Cookies and storage keys in COOKIE_MANIFEST. The test suite fails the build if the app writes one that is not here."
          />
          <Tile
            label="erasable tables"
            value={reg?.erasure.registeredTables ?? null}
            hint="Tables the erase walker and the DSAR export both drive off. A new user-keyed table fails the build until it is registered."
          />
        </div>
        {reg?.policy.thirdParty.length ? (
          <p className="mt-2 rounded-2xl bg-warn-soft p-2.5 text-[11px] font-bold leading-snug text-warn">
            Third parties that set cookies here:{" "}
            {reg.policy.thirdParty.map((t) => `${t.party} (${t.category})`).join(", ")}. Their
            script is not loaded at all without that category&apos;s consent.
          </p>
        ) : null}
      </section>

      <section className="surface rounded-blob p-4">
        <div className="text-[13px] font-extrabold text-strong">
          What we tell people we store
        </div>
        <p className="mt-1 text-[11px] leading-snug text-soft">
          Generated from COOKIE_MANIFEST - the same list the banner and the public /cookies page
          render. Hover a key for its purpose and how long it is kept.
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
                  <div className="text-[10px] font-bold text-faint">
                    {entries.length} declared
                    {cat === "necessary" ? " · required to use the app" : " · off by default"}
                  </div>
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

      <section className="surface rounded-blob p-4">
        <div className="text-[13px] font-extrabold text-strong">Consent register</div>
        <p className="mt-1 text-[11px] leading-snug text-soft">
          Every recorded acceptance and withdrawal as a CSV, from the ledger itself. Owner only,
          and the download is written to the audit trail.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {[90, 365].map((d) => (
            <a
              key={d}
              href={`/api/admin/governance/export?days=${d}`}
              className="btn btn-ghost rounded-2xl px-3 py-2 text-[12px] font-extrabold"
            >
              ⬇ Last {d} days (CSV)
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string | null;
  hint: string;
}) {
  return (
    <div className="rounded-2xl bg-card2 p-3 text-center" title={hint}>
      <div className="text-lg font-extrabold text-strong">
        {typeof value === "string" ? value : <Num v={value} />}
      </div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{label}</div>
    </div>
  );
}

// ---- SUBJECT ----------------------------------------------------------------

function SubjectSection() {
  const [email, setEmail] = useState("");
  const [file, setFile] = useState<SubjectFile | null>(null);
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [canErase, setCanErase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audited, setAudited] = useState<boolean | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [eraseConfirm, setEraseConfirm] = useState("");
  const [eraseBusy, setEraseBusy] = useState(false);
  const [eraseMsg, setEraseMsg] = useState<string | null>(null);

  const lookup = useCallback(async () => {
    const who = email.trim().toLowerCase();
    if (!who.includes("@")) {
      setError("Give a full email address.");
      return;
    }
    setBusy(true);
    setError(null);
    setEraseOpen(false);
    setEraseMsg(null);
    try {
      const res = await fetch(`/api/admin/governance/subject?email=${encodeURIComponent(who)}`, {
        cache: "no-store",
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setError(String(d?.error ?? "The lookup failed."));
        setFile(null);
        return;
      }
      setFile(d.file);
      setHistory(d.history ?? []);
      setCanErase(Boolean(d.canErase));
      setAudited(d.audited === true);
    } catch {
      setError("The lookup could not reach the server.");
    } finally {
      setBusy(false);
    }
  }, [email]);

  const erase = useCallback(async () => {
    if (!file) return;
    setEraseBusy(true);
    setEraseMsg(null);
    try {
      const res = await fetch("/api/admin/governance/subject", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: file.email, confirm: eraseConfirm }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setEraseMsg(String(d?.error ?? "The erasure failed."));
        return;
      }
      setEraseMsg("Erased. Re-run the lookup to confirm nothing is left.");
      setEraseOpen(false);
      setEraseConfirm("");
    } catch {
      setEraseMsg("The erasure could not reach the server.");
    } finally {
      setEraseBusy(false);
    }
  }, [file, eraseConfirm]);

  return (
    <div className="space-y-3">
      <section className="surface rounded-blob p-4">
        <div className="text-[13px] font-extrabold text-strong">Subject file</div>
        <p className="mt-1 text-[11px] leading-snug text-soft">
          What the app holds about one person, counted from the SAME registry the erase walker
          deletes from - so &quot;what we hold&quot; and &quot;what we delete&quot; cannot
          diverge. Counts only: row content is reachable only through the export below, which is
          owner-only and separately audited.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void lookup();
            }}
            placeholder="person@example.com"
            className="min-w-0 flex-1 rounded-2xl border-2 border-line bg-card px-3 py-2 text-[16px] font-bold text-strong"
          />
          <button
            onClick={() => void lookup()}
            disabled={busy}
            className="btn btn-primary shrink-0 rounded-2xl px-4 py-2 text-[13px] font-extrabold disabled:opacity-60"
          >
            {busy ? "..." : "Look up"}
          </button>
        </div>
        {error && (
          <p className="mt-2 rounded-2xl bg-brandred-soft p-2.5 text-[12px] font-bold text-brandred">
            {error}
          </p>
        )}
        {audited === false && (
          <p className="mt-2 rounded-2xl bg-warn-soft p-2.5 text-[11px] font-bold leading-snug text-warn">
            This lookup could not be written to the audit trail. The lookup still happened - the
            record of it did not.
          </p>
        )}
      </section>

      {file && (
        <>
          <DegradedBanner degraded={file.degraded} />

          <section className="surface rounded-blob p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0 truncate font-accent text-[13px] font-extrabold text-strong">
                {file.email}
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-extrabold ${
                  file.accountExists === null
                    ? "bg-card2 text-faint"
                    : file.accountExists
                      ? "bg-savings-soft text-savings"
                      : "bg-warn-soft text-warn"
                }`}
              >
                {file.accountExists === null
                  ? "account unknown"
                  : file.accountExists
                    ? "account exists"
                    : "no account row"}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Tile
                label="rows held"
                value={file.knownRows}
                hint="Summed across tables that could be READ. Unreadable tables are excluded and named above, so this is never quietly short."
              />
              <Tile
                label="tables with data"
                value={file.tables.filter((t) => (t.rows ?? 0) > 0).length}
                hint="Registered tables holding at least one row for this person."
              />
              <Tile
                label="consent records"
                value={file.ledger.length}
                hint="Every acceptance and withdrawal on file for this person."
              />
            </div>
            {file.accountExists === false && file.knownRows > 0 && (
              <p className="mt-2 rounded-2xl bg-warn-soft p-2.5 text-[11px] font-bold leading-snug text-warn">
                Data rows exist with no account row - that is the shape of a partially completed
                erasure. Re-running the erase is safe and will finish it.
              </p>
            )}
          </section>

          <section className="surface rounded-blob p-4">
            <div className="text-[13px] font-extrabold text-strong">Consent state</div>
            <div className="mt-2 space-y-1.5">
              {file.cookieConsent.map((c) => (
                <div
                  key={c.kind}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-2xl bg-card2 px-3 py-2"
                >
                  <div className="text-[12px] font-extrabold capitalize text-strong">
                    {c.category}
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[10px] font-bold text-faint">
                      {c.at ? `${when(c.at)} · v${c.version || "?"}` : "never answered"}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-extrabold ${
                        c.granted === null
                          ? "bg-card text-faint"
                          : c.granted
                            ? "bg-savings-soft text-savings"
                            : "bg-card text-faint"
                      }`}
                    >
                      {c.granted === null ? (
                        <>&mdash;</>
                      ) : c.granted ? (
                        "granted"
                      ) : (
                        "withdrawn"
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {file.ledgerDegraded && (
              <p className="mt-2 rounded-2xl bg-warn-soft p-2.5 text-[11px] font-bold leading-snug text-warn">
                Some entries below came from the breadcrumb fallback rather than the ledger table:
                the acceptance is real, the durable record was not written.
              </p>
            )}
            <details className="mt-2 rounded-2xl border-2 border-line p-2.5">
              <summary className="cursor-pointer text-[11px] font-extrabold text-soft">
                Full acceptance history ({file.ledger.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {file.ledger.map((e, i) => (
                  <li
                    key={`${e.kind}-${e.at}-${i}`}
                    className="flex flex-wrap items-baseline justify-between gap-2 text-[11px]"
                  >
                    <span className="font-accent font-bold text-strong">
                      {e.kind}
                      {e.degraded ? " ⚠" : ""}
                    </span>
                    <span className="text-faint">
                      {e.granted === false ? "withdrawn" : "granted"} · {when(e.at)} · v
                      {e.version || "?"}
                    </span>
                  </li>
                ))}
                {file.ledger.length === 0 && (
                  <li className="text-[11px] font-bold text-faint">
                    Nothing on file. For an account that has used the app, that is a finding, not
                    a blank.
                  </li>
                )}
              </ul>
            </details>
          </section>

          <section className="surface rounded-blob p-4">
            <div className="text-[13px] font-extrabold text-strong">Data footprint</div>
            <ul className="mt-2 space-y-1">
              {file.tables
                .filter((t) => t.rows === null || t.rows > 0)
                .map((t) => (
                  <li
                    key={t.table}
                    className="flex items-baseline justify-between gap-2 rounded-xl bg-card2 px-3 py-1.5 text-[11px]"
                  >
                    <span className="min-w-0 truncate font-accent font-bold text-soft">
                      {t.table}
                    </span>
                    <span className="shrink-0 font-extrabold text-strong">
                      <Num v={t.rows} />
                    </span>
                  </li>
                ))}
              {file.tables.every((t) => t.rows === 0) && (
                <li className="rounded-xl bg-card2 px-3 py-2 text-[11px] font-bold text-faint">
                  No rows in any registered table.
                </li>
              )}
            </ul>
          </section>

          <section className="surface rounded-blob p-4">
            <div className="text-[13px] font-extrabold text-strong">Subject rights</div>
            <p className="mt-1 text-[11px] leading-snug text-soft">
              For people who cannot reach their own account. Both actions are owner-only and both
              write to the audit trail.
            </p>
            {canErase ? (
              <>
                <a
                  href={`/api/admin/governance/subject-export?email=${encodeURIComponent(file.email)}`}
                  className="btn btn-ghost mt-2 block w-full rounded-2xl py-2.5 text-center text-[12px] font-extrabold"
                >
                  ⬇ Export their full file (JSON)
                </a>
                {!eraseOpen ? (
                  <button
                    onClick={() => setEraseOpen(true)}
                    className="btn mt-2 w-full rounded-2xl py-2.5 text-[12px] font-extrabold text-brandred underline"
                  >
                    Erase this account and all its data...
                  </button>
                ) : (
                  <div className="mt-2 rounded-2xl border-2 border-brandred bg-brandred-soft p-3">
                    <p className="text-[11.5px] font-bold leading-snug text-brandred">
                      This permanently deletes the account, its WhatsApp link and every row above.
                      It cannot be undone. Type <b>{file.email}</b> to confirm.
                    </p>
                    <input
                      value={eraseConfirm}
                      onChange={(e) => setEraseConfirm(e.target.value)}
                      placeholder={file.email}
                      autoComplete="off"
                      className="mt-2 w-full rounded-xl border-2 border-brandred bg-card px-3 py-2 text-[16px] font-bold text-strong"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => {
                          setEraseOpen(false);
                          setEraseConfirm("");
                        }}
                        className="btn flex-1 rounded-xl border-2 border-line bg-card py-2 text-[12px] font-extrabold text-strong"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => void erase()}
                        disabled={eraseBusy || eraseConfirm.trim().toLowerCase() !== file.email}
                        className="btn flex-1 rounded-xl bg-brandred py-2 text-[12px] font-extrabold text-white disabled:opacity-50"
                      >
                        {eraseBusy ? "Erasing..." : "Erase"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-2 rounded-2xl bg-card2 p-2.5 text-[11px] font-bold leading-snug text-faint">
                Export and erasure are owner-only. An admin is trusted to manage accounts, which
                is not the same as being trusted to read or destroy one.
              </p>
            )}
            {eraseMsg && (
              <p className="mt-2 rounded-2xl bg-warn-soft p-2.5 text-[11.5px] font-bold leading-snug text-warn">
                {eraseMsg}
              </p>
            )}
          </section>

          <section className="surface rounded-blob p-4">
            <div className="text-[13px] font-extrabold text-strong">
              Who has been in this file
            </div>
            <p className="mt-1 text-[11px] leading-snug text-soft">
              The answer to a question a data subject is entitled to ask, without leaving this
              screen.
            </p>
            <AuditList entries={history} empty="No recorded access." />
          </section>
        </>
      )}
    </div>
  );
}

// ---- TRAIL ------------------------------------------------------------------

function TrailSection({ entries, busy }: { entries: AuditEntry[]; busy: boolean }) {
  return (
    <section className="surface rounded-blob p-4">
      <div className="text-[13px] font-extrabold text-strong">Admin audit trail</div>
      <p className="mt-1 text-[11px] leading-snug text-soft">
        Every privileged action on personal data - lookups, exports, erasures, register downloads
        - including the ones that were REFUSED. A denied attempt is the most interesting row here,
        and a trail that logged only successes would miss every probe that did not work.
      </p>
      {busy ? (
        <p className="mt-2 text-[11px] font-bold text-faint">Loading...</p>
      ) : (
        <AuditList
          entries={entries}
          empty="Nothing recorded yet. If the table is unreadable it is named in the banner above - an empty log and an invisible one are different things."
        />
      )}
    </section>
  );
}

function AuditList({ entries, empty }: { entries: AuditEntry[]; empty: string }) {
  if (entries.length === 0) {
    return (
      <p className="mt-2 rounded-2xl bg-card2 p-2.5 text-[11px] font-bold leading-snug text-faint">
        {empty}
      </p>
    );
  }
  return (
    <ul className="mt-2 space-y-1.5">
      {entries.map((e, i) => (
        <li key={e.id ?? i} className="rounded-2xl bg-card2 p-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-1.5">
            <span className="font-accent text-[11px] font-extrabold text-strong">{e.action}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[9.5px] font-extrabold ${
                e.outcome === "ok"
                  ? "bg-card text-faint"
                  : e.outcome === "refused"
                    ? "bg-warn-soft text-warn"
                    : "bg-brandred-soft text-brandred"
              }`}
            >
              {e.outcome ?? "ok"}
            </span>
          </div>
          <div className="mt-0.5 text-[10.5px] font-bold leading-snug text-soft">
            {e.actorEmail} <span className="text-faint">({e.actorRole})</span>
            {e.subjectEmail ? ` → ${e.subjectEmail}` : ""}
          </div>
          <div className="text-[10px] font-bold text-faint">{when(e.at)}</div>
          {e.detail && Object.keys(e.detail).length > 0 && (
            <div className="mt-0.5 truncate font-accent text-[10px] text-faint">
              {Object.entries(e.detail)
                .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`)
                .join("  ")}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
