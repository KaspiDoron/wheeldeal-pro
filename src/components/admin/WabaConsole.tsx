"use client";

import { useEffect, useState } from "react";

// THE BUSINESS PLATFORM CONSOLE.
//
// The operational counterpart to the risk dashboard: same fail-dark vocabulary,
// same empty-state rules, so the two read as one system rather than two
// dialects. Unknown is a dash, never a zero - on this screen a false green means
// "the official number is fine" while it is being restricted.
//
// Two honesty constraints are rendered rather than assumed:
//
//   - The DRY RUN banner. While it is on, nothing has left the process, and the
//     ledger below is a rehearsal. A console that showed the same green tiles
//     for a rehearsal and for live traffic would be the most expensive kind of
//     wrong.
//   - The footer. Nothing here reduces the chance of Meta restricting the
//     number; it shortens the gap between Meta pushing back and you knowing.

interface Lead {
  id: number;
  state: string;
  lane: string | null;
  agency_name: string | null;
  agency_tail: string;
  user_email: string;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  link_tapped_at: string | null;
  handed_off_at: string | null;
  terminal_reason: string | null;
  error_code: number | null;
  preview: string | null;
}

interface Agency {
  agency_tail: string;
  agency_name: string | null;
  window_expires_at: string | null;
  template_capped_until: string | null;
  last_template_at: string | null;
}

interface Data {
  generatedAt: number;
  connection: {
    enabled: boolean;
    dryRun: boolean;
    provider: string;
    hasKey: boolean;
    senderConfigured: boolean;
    template: string | null;
    linkBase: string | null;
    blocked: string | null;
    blockedLabel: string | null;
  };
  /** Every code path that can put a message on WhatsApp, and whether it can
   *  right now. See the api route for why this exists. */
  senders?: { id: string; label: string; live: boolean; detail: string }[];
  /** The architecture toggles with their STORED values (what the vault holds,
   *  not what anyone last requested). */
  architecture?: { key: string; value: string; hint: string; unreadable?: boolean }[];
  /** The two URLs the owner must paste into Meta, resolved from APP_DOMAIN. */
  setup?: { callbackUrl: string; expectedLinkBase: string; linkBaseMatches: boolean };
  governor: {
    allowed: boolean;
    binding: string | null;
    reason: string;
    unreadable: boolean;
    headroom: {
      tierRemaining: number | null;
      spendRemainingUsd: number | null;
      quality: string;
    };
  };
  funnel: Record<string, number | null> | null;
  leads: Lead[] | null;
  agencies: Agency[] | null;
  degraded: string[];
}

function Num({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <span className="text-faint">&mdash;</span>;
  return <span className="tabular-nums">{v.toLocaleString()}</span>;
}

const FUNNEL_ROWS: { k: string; label: string; note?: string }[] = [
  { k: "sent", label: "Asked" },
  { k: "delivered", label: "Delivered" },
  { k: "read", label: "Read" },
  // The one that says the message WORKED. Delivered and read only say it
  // arrived, and no other surface in this product has this signal.
  { k: "tapped", label: "Tapped the link", note: "the real engagement signal" },
  { k: "travellerContacted", label: "Messaged the traveller" },
  { k: "handedOff", label: "Handed to the agents" },
];

/** Valid values per architecture toggle - mirrors the POST's validation. */
const ARCH_OPTIONS: Record<string, string[]> = {
  TRANSPORT_MODE: ["evolution", "waba-first", "waba-fallback"],
  WABA_ENABLED: ["on", "off"],
  WABA_DRY_RUN: ["on", "off"],
  WABA_KILL: ["on", "off"],
  CLOUD_API_ENABLED: ["on", "off"],
};

const ARCH_LABELS: Record<string, string> = {
  TRANSPORT_MODE: "First-contact wire",
  WABA_ENABLED: "Business-number handoff",
  WABA_DRY_RUN: "Dry run",
  WABA_KILL: "EMERGENCY STOP",
  CLOUD_API_ENABLED: "Legacy Cloud sender",
};

export function WabaConsole() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [archMsg, setArchMsg] = useState<string | null>(null);
  const [flipping, setFlipping] = useState<string | null>(null);
  const [optIn, setOptIn] = useState("");
  const [optMsg, setOptMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/waba", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => (j.error ? setErr(j.error) : setD(j)))
      .catch(() => setErr("Could not reach the server."));
  }, []);

  // HONEST WRITES: the card re-renders from the response's read-back, never
  // from the value that was requested - a toggle that did not persist must not
  // look flipped.
  const flip = async (key: string, value: string) => {
    setFlipping(key);
    setArchMsg(null);
    try {
      const r = await fetch("/api/admin/waba", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const j = (await r.json()) as {
        ok?: boolean;
        error?: string;
        warning?: string;
        architecture?: Data["architecture"];
      };
      if (j.error) {
        setArchMsg(j.error);
      } else {
        if (j.architecture) setD((cur) => (cur ? { ...cur, architecture: j.architecture } : cur));
        if (!j.ok) setArchMsg(j.warning ?? `${key} did not persist - the vault still holds the old value.`);
        else if (j.warning) setArchMsg(j.warning);
      }
    } catch {
      setArchMsg("Could not reach the server - nothing was changed.");
    } finally {
      setFlipping(null);
    }
  };

  // A shop may only receive a COLD template once it has opted in, and until
  // this existed the only way to record that was a hand-written database row -
  // so on funding day every dispatch would have answered "not-opted-in" and
  // silently stayed on Evolution with nothing on screen to explain it.
  const optInShop = async () => {
    setOptMsg(null);
    try {
      const r = await fetch("/api/admin/waba", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "opt-in", number: optIn }),
      });
      const j = (await r.json()) as {
        ok?: boolean;
        error?: string;
        warning?: string;
        tail?: string;
      };
      setOptMsg(j.error ?? j.warning ?? (j.ok ? `Opted in (${j.tail}).` : "Did not persist."));
      if (j.ok) setOptIn("");
    } catch {
      setOptMsg("Could not reach the server - nothing was changed.");
    }
  };

  if (err) return <div className="surface rounded-blob p-4 text-[13px] font-bold text-brandred">{err}</div>;
  if (!d) return <div className="surface rounded-blob p-4 text-[13px] font-bold text-soft">Loading…</div>;

  const c = d.connection;
  const g = d.governor;

  return (
    <div className="space-y-3">
      {d.degraded.length > 0 && (
        <div className="rounded-blob border-2 border-brandred/40 bg-brandred-soft p-3 text-[12px] font-extrabold text-brandred">
          Could not read: {d.degraded.join(", ")}. Anything shown as &mdash; is unknown, not zero.
        </div>
      )}

      {/* WHICH ENGINES CAN SEND, ANSWERED IN ONE PLACE. Before this the answer
          lived in three files and two of them were governed by nothing but
          whether a Key Vault field happened to be blank. */}
      {(d.senders ?? []).length > 0 && (
        <div className="rounded-blob border-2 border-line bg-card p-3">
          <div className="text-[13px] font-extrabold text-strong">Who can send right now</div>
          <div className="mt-2 space-y-2">
            {(d.senders ?? []).map((s) => (
              <div key={s.id} className="flex items-start gap-2">
                <span
                  className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                    s.live ? "bg-savings-soft text-savings" : "bg-card2 text-soft"
                  }`}
                >
                  {s.live ? "LIVE" : "OFF"}
                </span>
                <div className="min-w-0">
                  <div className="text-[12px] font-extrabold text-strong">{s.label}</div>
                  <div className="text-[11px] font-bold text-soft">{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* THE ARCHITECTURE CARD - the no-redeploy switchboard. One canonical
          engine, interchangeable wires: which wire makes first contact is an
          owner decision made HERE, and every value shown is the vault's own
          read-back (the POST refuses to render a toggle that did not stick). */}
      {(d.architecture ?? []).length > 0 && (
        <div className="rounded-blob border-2 border-line bg-card p-3">
          <div className="text-[13px] font-extrabold text-strong">Architecture</div>
          <p className="mt-0.5 text-[11px] font-bold text-faint">
            One negotiation engine; these choose the wire. Changes apply within ~30s, no redeploy.
            Red taps start or stop a LIVE sender: the legacy Cloud sender has no dry run and no
            governor, and turning the dry run off means the next lead really sends.
          </p>
          <div className="mt-2 space-y-2">
            {(d.architecture ?? []).map((t) => {
              const kill = t.key === "WABA_KILL";
              // ARMING A LIVE SENDER IS A DANGER TAP TOO. CLOUD_API_ENABLED
              // has no dry run, no governor and no anti-ban lane budget: one
              // neutral-looking tap starts a second live sender across
              // outreach, mass outreach and the Cloud webhook's auto-reply.
              // Turning the dry run OFF is the same class of decision.
              const arms =
                t.key === "CLOUD_API_ENABLED" ? "on" : t.key === "WABA_DRY_RUN" ? "off" : null;
              return (
                <div key={t.key} className="rounded-xl bg-card2 p-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`text-[12px] font-extrabold ${kill ? "text-brandred" : "text-strong"}`}>
                      {ARCH_LABELS[t.key] ?? t.key}
                    </span>
                    <span className="shrink-0 text-[10px] font-bold text-faint">
                      {t.unreadable
                        ? "\u2014 unreadable"
                        : t.value
                          ? `stored: ${t.value}`
                          : "unset (default)"}
                    </span>
                  </div>
                  <div className="mt-1 text-[10px] font-bold text-faint">{t.hint}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {(ARCH_OPTIONS[t.key] ?? []).map((v) => {
                      const active = t.value === v;
                      const danger = (kill && v === "on") || (arms !== null && v === arms);
                      return (
                        <button
                          key={v}
                          type="button"
                          disabled={flipping !== null}
                          onClick={() => flip(t.key, v)}
                          className={`rounded-full px-3 py-1 text-[11px] font-extrabold disabled:opacity-50 ${
                            active
                              ? danger
                                ? "bg-brandred text-white"
                                : "bg-brandgreen text-white"
                              : danger
                                ? "border-2 border-brandred/50 text-brandred"
                                : "border-2 border-line text-soft"
                          }`}
                        >
                          {flipping === t.key ? "…" : v}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {/* THE PARTNER OPT-IN. A cold first-contact template may only reach a
              shop that opted in, and the only other way to record that is the
              shop messaging the business number first - so without this the
              lane could not make a single first contact on day one. */}
          <div className="mt-3 border-t border-line pt-2">
            <div className="text-[12px] font-extrabold text-strong">Opt a partner shop in</div>
            <p className="mt-0.5 text-[11px] font-bold text-faint">
              A cold first-contact template may only go to a shop that opted in. A shop that
              messages the business number opts itself in automatically.
            </p>
            <div className="mt-1.5 flex gap-1.5">
              <input
                value={optIn}
                onChange={(e) => setOptIn(e.target.value)}
                inputMode="tel"
                placeholder="+66 81 234 5678"
                className="min-w-0 flex-1 rounded-xl border-2 border-line bg-card px-2 py-1 text-[16px] font-bold text-strong"
              />
              <button
                type="button"
                onClick={optInShop}
                disabled={!optIn.trim()}
                className="shrink-0 rounded-full bg-brandgreen px-3 py-1 text-[11px] font-extrabold text-white disabled:opacity-50"
              >
                Opt in
              </button>
            </div>
            {optMsg && <p className="mt-1 text-[11px] font-extrabold text-soft">{optMsg}</p>}
          </div>
          {archMsg && (
            <p className="mt-2 rounded-xl bg-brandred-soft p-2 text-[11px] font-extrabold text-brandred">
              {archMsg}
            </p>
          )}
        </div>
      )}

      {/* THE TWO URLS THAT GO INTO META. They appeared on no screen and in no
          document, and a WABA_LINK_BASE that does not equal the approved
          template's button base is rejected on every send with nothing here to
          explain why. */}
      {d.setup && (
        <div className="rounded-blob border-2 border-line bg-card p-3">
          <div className="text-[13px] font-extrabold text-strong">Paste these into Meta</div>
          <div className="mt-1.5 space-y-1 text-[11px] font-bold">
            <div className="break-all text-soft">
              <span className="text-faint">Callback URL:</span> {d.setup.callbackUrl}
            </div>
            <div className="break-all text-soft">
              <span className="text-faint">Template button base (= WABA_LINK_BASE):</span>{" "}
              {d.setup.expectedLinkBase}
            </div>
            {!d.setup.linkBaseMatches && (
              <div className="text-brandred">
                WABA_LINK_BASE does not equal this - every template send would be rejected.
              </div>
            )}
          </div>
        </div>
      )}

      {!c.enabled && (
        <div className="rounded-blob border-2 border-line bg-card2 p-3">
          <div className="text-[13px] font-extrabold text-strong">Business number is OFF</div>
          <p className="mt-1 text-[12px] font-bold text-soft">
            {c.blockedLabel ?? "Not enabled."} The app is running on the existing engine,
            where each traveller&rsquo;s own number makes first contact. Nothing on this
            screen is live.
          </p>
        </div>
      )}

      {c.enabled && c.dryRun && (
        <div className="rounded-blob border-2 border-brandyellow/50 bg-brandyellow-soft p-3">
          <div className="text-[13px] font-extrabold text-warn">
            DRY RUN - nothing is being sent
          </div>
          <p className="mt-1 text-[12px] font-bold text-warn">
            Every message below was rendered and discarded. Turn WABA_DRY_RUN off in Keys
            when you are ready for the first real send.
          </p>
        </div>
      )}

      {/* Connection + governor, side by side on anything above 320px. */}
      <div className="grid grid-cols-2 gap-2">
        {[
          { k: "Provider", v: c.provider },
          { k: "API key", v: c.hasKey ? "set" : "missing" },
          { k: "Sender", v: c.senderConfigured ? "set" : "missing" },
          { k: "Template", v: c.template ?? "none" },
          { k: "Quality", v: g.headroom.quality },
          {
            k: "Tier left",
            v: g.headroom.tierRemaining === null ? "-" : String(g.headroom.tierRemaining),
          },
        ].map((x) => (
          <div key={x.k} className="rounded-xl bg-card2 p-2">
            <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{x.k}</div>
            <div className="truncate text-[13px] font-extrabold text-strong">{x.v}</div>
          </div>
        ))}
      </div>

      <div
        className={`rounded-blob p-3 ${
          g.allowed ? "surface" : "border-2 border-brandred/40 bg-brandred-soft"
        }`}
      >
        <div className="text-[13px] font-extrabold text-strong">
          {g.allowed ? "Sending allowed" : "Sending held"}
          {g.binding && (
            <span className="ms-2 rounded-full bg-brandred px-2 py-0.5 text-[10px] text-white">
              {g.binding}
            </span>
          )}
        </div>
        <p className="mt-1 text-[12px] font-bold text-soft">{g.reason}</p>
      </div>

      {/* THE FUNNEL, on the lead ledger. */}
      <div className="surface rounded-blob p-3">
        <div className="text-[13px] font-extrabold text-strong">First-contact funnel</div>
        {d.funnel === null ? (
          <p className="mt-1 text-[12px] font-bold text-faint">&mdash; could not be read.</p>
        ) : (
          <div className="mt-2 space-y-1">
            {FUNNEL_ROWS.map((r) => (
              <div key={r.k} className="flex items-baseline justify-between gap-2 text-[12px] font-bold">
                <span className="truncate text-soft">
                  {r.label}
                  {r.note && <span className="ms-1 text-[10px] text-faint">({r.note})</span>}
                </span>
                <span className="shrink-0 font-extrabold text-strong">
                  <Num v={d.funnel?.[r.k]} />
                </span>
              </div>
            ))}
            <div className="mt-1.5 flex gap-3 border-t border-line pt-1.5 text-[11px] font-bold">
              <span className="text-soft">
                Held <Num v={d.funnel?.held} />
              </span>
              <span className="text-soft">
                Failed <Num v={d.funnel?.failed} />
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Per-agency: window, cap, last template. */}
      <div className="surface rounded-blob p-3">
        <div className="text-[13px] font-extrabold text-strong">Agencies</div>
        {d.agencies === null ? (
          <p className="mt-1 text-[12px] font-bold text-faint">&mdash; could not be read.</p>
        ) : d.agencies.length === 0 ? (
          <p className="mt-1 text-[12px] font-bold text-soft">No agency has been contacted yet.</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {d.agencies.slice(0, 40).map((a) => {
              const open = a.window_expires_at && Date.parse(a.window_expires_at) > Date.now();
              const capped =
                a.template_capped_until && Date.parse(a.template_capped_until) > Date.now();
              return (
                <div key={a.agency_tail} className="flex items-center gap-2 text-[12px] font-bold">
                  <span className="min-w-0 flex-1 truncate text-soft">
                    {a.agency_name ?? a.agency_tail}
                  </span>
                  {open && (
                    <span className="shrink-0 rounded-full bg-brandgreen px-2 py-0.5 text-[10px] text-white">
                      free lane
                    </span>
                  )}
                  {capped && (
                    <span className="shrink-0 rounded-full bg-brandyellow px-2 py-0.5 text-[10px] text-[#8a6100]">
                      capped
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* THE LEDGER. The first question about any failed handoff is always
          "what did we actually send them", so the wire text is right here. */}
      <div className="surface rounded-blob p-3">
        <div className="text-[13px] font-extrabold text-strong">
          Recent first messages <span className="text-[10px] font-bold text-faint">(last 200)</span>
        </div>
        {d.leads === null ? (
          <p className="mt-1 text-[12px] font-bold text-faint">&mdash; could not be read.</p>
        ) : d.leads.length === 0 ? (
          <p className="mt-1 text-[12px] font-bold text-soft">Nothing sent yet.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {d.leads.slice(0, 30).map((l) => (
              <details key={l.id} className="rounded-xl bg-card2 p-2">
                <summary className="flex cursor-pointer items-center gap-2 text-[12px] font-bold">
                  <span className="min-w-0 flex-1 truncate text-strong">
                    {l.agency_name ?? l.agency_tail}
                  </span>
                  <span className="shrink-0 text-[10px] text-faint">{l.lane ?? "-"}</span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                      l.state === "failed"
                        ? "bg-brandred text-white"
                        : l.state === "handed_off"
                          ? "bg-brandgreen text-white"
                          : "bg-line text-soft"
                    }`}
                  >
                    {l.state}
                  </span>
                </summary>
                <div className="mt-1.5 space-y-0.5 text-[11px] font-bold text-soft">
                  <div className="break-words">
                    <span className="text-faint">wire:</span> {l.preview ?? "-"}
                  </div>
                  {l.terminal_reason && (
                    <div className="text-brandred">
                      {l.terminal_reason}
                      {l.error_code ? ` (${l.error_code})` : ""}
                    </div>
                  )}
                  <div className="text-faint">
                    {l.link_tapped_at ? "tapped" : l.read_at ? "read" : l.delivered_at ? "delivered" : "sent"}
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </div>

      <p className="text-center text-[10px] text-faint">
        Nothing on this screen reduces the chance of WhatsApp restricting the number. It
        shortens the time between them pushing back and you knowing.
      </p>
    </div>
  );
}
