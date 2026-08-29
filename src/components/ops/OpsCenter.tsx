"use client";

// The AI Operations Center - the owner's cockpit for continuously improving
// the negotiation agents from REAL production conversations. Owner-only
// (never a customer surface): review queue, full cross-user conversation
// review with per-decision reasoning, and (later phases) policy versioning,
// golden replay gates and effectiveness analytics.

import { useCallback, useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";
import { ConversationPanel } from "./ConversationPanel";
import { PolicyPanel } from "./PolicyPanel";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { IntegrityPanel } from "./IntegrityPanel";
import { LaunchKpiCard } from "./LaunchKpiCard";

interface ThreadCard {
  threadKey: string;
  userEmail: string;
  vendorName: string;
  drill?: boolean;
  phase: string;
  updatedAt: string;
  rounds: number;
  pricePerDay: number | null;
  currency: string | null;
  declined: boolean;
  avgRating: number | null;
  reviewCount: number;
  openFlags: number;
  bookmark: boolean;
  autoReasons: string[];
  judge: { outcomeDelta: number | null; verdict: string | null } | null;
  lastMsg: { dir: string; text: string; at: string } | null;
}

interface InboxRow {
  id: number;
  thread_key: string;
  decision_id: string | null;
  vendor_name: string | null;
  user_email: string | null;
  status: string;
  source: string;
  auto_reason: string | null;
  rating: number | null;
  tags: string[] | null;
  created_at: string;
}

export function OpsCenter() {
  const [tab, setTab] = useState<"inbox" | "threads" | "analytics" | "policy" | "integrity">(
    "inbox"
  );
  const [open, setOpen] = useState<{ threadKey: string; vendorName: string } | null>(null);
  const [detected, setDetected] = useState<number | null>(null);

  // Opportunistic detection sweep (same piggyback pattern as outbox draining):
  // the system pre-fills the inbox with its own weakest conversations.
  // DEBOUNCED across mounts: the panel remounts on every return to the Ops
  // tab, and each sweep is seven selects (up to ~1,600 rows) plus inserts -
  // tab-hopping must not multiply that. sessionStorage survives the remount;
  // 10 minutes matches how often new weak conversations can plausibly appear.
  useEffect(() => {
    try {
      const last = Number(sessionStorage.getItem("wd_ops_detect_at") ?? 0);
      if (Date.now() - last < 10 * 60_000) return;
      sessionStorage.setItem("wd_ops_detect_at", String(Date.now()));
    } catch {
      /* storage unavailable - sweep anyway */
    }
    fetch("/api/admin/ops/detect", { method: "POST" })
      .then((r) => r.json())
      .then((d) => setDetected(typeof d?.flagged === "number" ? d.flagged : null))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-3">
      <div className="surface rounded-blob p-3.5">
        <h2 className="text-[15px] font-extrabold text-strong">🧠 AI Operations Center</h2>
        <p className="mt-0.5 text-[11px] text-soft">
          Every real negotiation, every decision, every reason - review them and the agents
          learn: bookmarks become live exemplars, corrections become training, branch verdicts
          become director priors. Owner-only.
        </p>
        {detected !== null && detected > 0 && (
          <p className="mt-1.5 text-[11px] font-extrabold text-warn">
            🤖 The detector just flagged {detected} conversation{detected === 1 ? "" : "s"} for
            review - they are in the inbox.
          </p>
        )}
      </div>

      {open ? (
        <ConversationPanel
          threadKey={open.threadKey}
          vendorName={open.vendorName}
          onBack={() => setOpen(null)}
        />
      ) : (
        <>
          {/* THE GO/NO-GO NUMBERS, ABOVE THE SUB-TABS. Launch readiness is not
              one more thing to go looking for - it is the question the owner
              opens this panel holding. Scoped to the dashboard view: reading
              one conversation is a different job, and stapling fleet KPIs over
              it would just be noise. */}
          <LaunchKpiCard />

          <div className="surface-strong no-scrollbar flex gap-1 overflow-x-auto rounded-2xl p-1">
            {(
              [
                ["inbox", "📥 Review inbox"],
                ["threads", "💬 All conversations"],
                ["analytics", "📊 Analytics"],
                ["policy", "🗂️ Policy & versions"],
                ["integrity", "🛡️ Block approvals"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`btn btn-sm shrink-0 rounded-xl px-3 py-2 text-[11px] font-extrabold ${
                  tab === t ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "inbox" && <InboxPanel onOpen={(tk, vn) => setOpen({ threadKey: tk, vendorName: vn })} />}
          {tab === "threads" && (
            <ThreadsPanel onOpen={(tk, vn) => setOpen({ threadKey: tk, vendorName: vn })} />
          )}
          {tab === "analytics" && <AnalyticsPanel />}
          {tab === "policy" && <PolicyPanel />}
          {tab === "integrity" && <IntegrityPanel />}
        </>
      )}
    </div>
  );
}

function InboxPanel({ onOpen }: { onOpen: (threadKey: string, vendorName: string) => void }) {
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [err, setErr] = useState(false);

  // TRI-STATE, not fail-green: a failed fetch used to land in `[]`, and an
  // empty inbox renders the celebration card - so an outage read as "🎉
  // Nothing needs review". Unknown is an error card with a retry, never a
  // party emoji (the same conversion the Command tab already went through).
  const load = useCallback(() => {
    setErr(false);
    setRows(null);
    fetch("/api/admin/ops/review?queue=inbox")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => {
        if (!Array.isArray(d?.reviews)) throw new Error("bad payload");
        if (Array.isArray(d?.degraded) && d.degraded.length > 0) {
          setErr(true);
          setRows([]);
          return;
        }
        setRows(d.reviews);
      })
      .catch(() => {
        setErr(true);
        setRows([]);
      });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (err) {
    return (
      <div className="rounded-blob border-2 border-brandred/40 bg-brandred-soft p-4 text-center">
        <p className="text-[13px] font-extrabold text-brandred">
          The review queue could not be read - that is unknown, not empty.
        </p>
        <button
          onClick={load}
          className="btn btn-sm mt-2 rounded-xl border-2 border-brandred/40 px-3 text-[11px] font-extrabold text-brandred"
        >
          ↻ Retry
        </button>
      </div>
    );
  }
  if (rows === null) return <LoadingDots label="Loading the review queue" />;
  if (rows.length === 0) {
    return (
      <div className="surface rounded-blob p-5 text-center">
        <p className="text-[20px]">🎉</p>
        <p className="text-[13px] font-extrabold text-strong">Nothing needs review</p>
        <p className="mx-auto mt-1 max-w-[300px] text-[11px] text-soft">
          Flagged and auto-detected conversations land here. Browse all conversations to review
          proactively - every rating makes the agents sharper.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <button
          key={r.id}
          onClick={() => onOpen(r.thread_key, r.vendor_name ?? r.thread_key)}
          className="surface lift block w-full rounded-blob p-3 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-extrabold text-strong">
              {r.vendor_name ?? r.thread_key.split(":").pop()}
            </span>
            <span
              className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                r.status === "auto_flagged"
                  ? "bg-brandyellow-soft text-warn"
                  : r.status === "flagged"
                    ? "bg-brandred-soft text-brandred"
                    : "bg-brandblue-soft text-brandblue"
              }`}
            >
              {r.status.replace("_", " ")}
            </span>
          </div>
          <p className="truncate text-[10px] text-faint">{r.user_email}</p>
          {r.auto_reason && <p className="mt-1 text-[11px] text-soft">🤖 {r.auto_reason}</p>}
          {(r.tags?.length ?? 0) > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {r.tags!.map((t) => (
                <span key={t} className="rounded-full bg-card2 px-1.5 py-0.5 text-[9px] font-bold text-soft">
                  {t}
                </span>
              ))}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

function ThreadsPanel({ onOpen }: { onOpen: (threadKey: string, vendorName: string) => void }) {
  const [threads, setThreads] = useState<ThreadCard[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "flagged" | "bookmarked">("all");
  const [err, setErr] = useState(false);
  const [degraded, setDegraded] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const query = useCallback(
    (offset: number) => {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (filter === "flagged") params.set("flagged", "1");
      if (filter === "bookmarked") params.set("bookmarked", "1");
      if (offset > 0) params.set("offset", String(offset));
      return fetch(`/api/admin/ops/conversations?${params}`).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      });
    },
    [q, filter]
  );

  // TRI-STATE: an outage renders a red retry card, never "No conversations
  // yet" - and the search/filters run in the database now, so a match beyond
  // the first page is one Load-more away instead of unreachable.
  const load = useCallback(() => {
    setErr(false);
    setThreads(null);
    query(0)
      .then((d) => {
        if (!Array.isArray(d?.threads)) throw new Error("bad payload");
        setThreads(d.threads);
        setDegraded(Array.isArray(d?.degraded) ? d.degraded : []);
        setHasMore(Boolean(d?.hasMore));
        setNextOffset(Number(d?.nextOffset) || 0);
      })
      .catch(() => {
        setErr(true);
        setThreads([]);
      });
  }, [query]);

  useEffect(() => {
    const t = setTimeout(load, q ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search shop, user, phase..."
          className="h-10 min-w-0 flex-1 rounded-xl border-2 border-line bg-card px-3 text-[13px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
        />
        {(["all", "flagged", "bookmarked"] as const).map((fk) => (
          <button
            key={fk}
            onClick={() => setFilter(fk)}
            className={`chip shrink-0 rounded-xl border px-2 text-[10px] font-extrabold ${
              filter === fk ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
            }`}
          >
            {fk === "all" ? "All" : fk === "flagged" ? "🚩" : "🔖"}
          </button>
        ))}
      </div>

      {err && (
        <div className="rounded-blob border-2 border-brandred/40 bg-brandred-soft p-4 text-center">
          <p className="text-[13px] font-extrabold text-brandred">
            Conversations could not be read - that is unknown, not empty.
          </p>
          <button
            onClick={load}
            className="btn btn-sm mt-2 rounded-xl border-2 border-brandred/40 px-3 text-[11px] font-extrabold text-brandred"
          >
            ↻ Retry
          </button>
        </div>
      )}
      {!err && degraded.length > 0 && (
        <div className="rounded-blob border-2 border-brandred/40 bg-brandred-soft p-3 text-[12px] font-extrabold text-brandred">
          Could not read: {degraded.join(", ")}. Missing pieces are unknown, not zero.
        </div>
      )}
      {threads === null && !err && <LoadingDots label="Loading conversations" />}
      {!err && threads?.length === 0 && (
        <div className="surface rounded-blob p-5 text-center">
          <p className="text-[13px] font-extrabold text-strong">No conversations yet</p>
          <p className="mt-1 text-[11px] text-soft">
            Real negotiations appear here the moment agents start messaging shops.
          </p>
        </div>
      )}
      {threads?.map((t) => (
        <button
          key={t.threadKey}
          onClick={() => onOpen(t.threadKey, t.vendorName)}
          className="surface lift block w-full rounded-blob p-3 text-left"
        >
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-extrabold text-strong">
              {t.bookmark ? "🔖 " : ""}
              {t.vendorName}
            </span>
            {t.drill && (
              <span className="shrink-0 rounded-full bg-brandyellow-soft px-1.5 py-0.5 text-[9px] font-extrabold text-warn">
                🧪 drill
              </span>
            )}
            {t.openFlags > 0 && (
              <span className="shrink-0 rounded-full bg-brandred-soft px-1.5 py-0.5 text-[9px] font-extrabold text-brandred">
                {t.openFlags} open
              </span>
            )}
            <span className="ml-auto shrink-0 rounded-full bg-card2 px-2 py-0.5 text-[9px] font-extrabold capitalize text-soft">
              {t.declined ? "declined" : t.phase}
            </span>
          </div>
          <p className="truncate text-[10px] text-faint">{t.userEmail}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-soft">
            {t.pricePerDay != null && (
              <span className="font-extrabold text-savings">
                {t.currency ?? ""} {t.pricePerDay}/day
              </span>
            )}
            <span>{t.rounds} round{t.rounds === 1 ? "" : "s"}</span>
            {t.avgRating != null && <span>⭐ {t.avgRating}</span>}
            {t.judge?.outcomeDelta != null && <span>judge {t.judge.outcomeDelta}/5</span>}
            <span className="ml-auto text-faint">{new Date(t.updatedAt).toLocaleDateString()}</span>
          </div>
          {t.autoReasons.length > 0 && (
            <p className="mt-1 truncate text-[10px] text-warn">
              🤖 {t.autoReasons[0]}
            </p>
          )}
          {t.lastMsg && (
            <p className="mt-1 truncate text-[11px] text-soft">
              {t.lastMsg.dir === "in" ? "Shop: " : "Agent: "}
              {t.lastMsg.text}
            </p>
          )}
        </button>
      ))}
      {/* THE REST OF THEM - a conversation beyond the first page used to be
          unreachable through any UI (the route capped at the newest 120). */}
      {hasMore && !err && (
        <button
          onClick={async () => {
            setLoadingMore(true);
            try {
              const d = await query(nextOffset);
              if (Array.isArray(d?.threads)) {
                setThreads((cur) => [...(cur ?? []), ...d.threads]);
                setHasMore(Boolean(d?.hasMore));
                setNextOffset(Number(d?.nextOffset) || 0);
              }
            } catch {
              /* leave the button so it can simply be pressed again */
            } finally {
              setLoadingMore(false);
            }
          }}
          disabled={loadingMore}
          className="btn btn-sm w-full rounded-xl border-2 border-line py-2 text-[11px] font-extrabold text-soft disabled:opacity-60"
        >
          {loadingMore ? <LoadingDots label="Loading" /> : "Load more conversations"}
        </button>
      )}
    </div>
  );
}
