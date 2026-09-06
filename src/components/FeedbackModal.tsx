"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Modal } from "./Modal";
import { Icon } from "./icons";
import { LoadingDots } from "./LoadingDots";
import { normalizeImageFile } from "@/lib/client/normalize-image";

const CATEGORIES = [
  { id: "bug", label: "Bug" },
  { id: "ui", label: "UI / layout" },
  { id: "performance", label: "Slow / performance" },
  { id: "crash", label: "Crash / blank" },
  { id: "suggestion", label: "Suggestion" },
  { id: "question", label: "Question" },
  { id: "other", label: "Other" },
];

const MAX_IMAGES = 5;

const STATUS_META: Record<string, { label: string; cls: string }> = {
  open: { label: "Open", cls: "bg-brandblue-soft text-brandblue" },
  "in-progress": { label: "In progress", cls: "bg-brandyellow-soft text-warn" },
  resolved: { label: "Resolved", cls: "bg-savings-soft text-savings" },
  dismissed: { label: "Closed", cls: "bg-card2 text-faint" },
};

interface Reply {
  id: number;
  feedback_id: number;
  author_role: string;
  body: string;
  created_at: string;
}
interface Report {
  id: number;
  category: string;
  body: string;
  status: string | null;
  severity: string | null;
  summary: string | null;
  created_at: string;
  replies: Reply[];
  /** Team replies the reporter has not seen - computed SERVER-side from
   *  `feedback.user_seen_at`, so it survives a change of device (W6.2). */
  unread?: number;
}

// A bug report's screenshot is usually a photo of the phone's own screen, taken
// with another phone - which is exactly the EXIF-tagged case. The local
// new Image() + drawImage + toDataURL helper that used to live here destroyed
// that tag irreversibly (canvas writes no metadata) while trusting the engine to
// have applied it during decode; where it had not, the triage team received a
// sideways screenshot and no way to recover. normalizeImageFile is the shared,
// spec-guaranteed version - same budget as before, upright by construction.
const SHOT = { maxDim: 1100, quality: 0.7, maxBytes: 900_000 } as const;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function FeedbackModal({ email, onClose }: { email?: string; onClose: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"new" | "yours">("new");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [hasUnread, setHasUnread] = useState(false);

  const loadReports = useCallback(async () => {
    setReportsError(null);
    try {
      const res = await fetch("/api/feedback", { method: "GET" });
      if (res.status === 401) {
        setReports([]);
        setReportsError(t("Sign in to see and manage your reports."));
        return;
      }
      const data = await res.json();
      const list: Report[] = Array.isArray(data.reports) ? data.reports : [];
      setReports(list);
      // UNREAD COMES FROM THE SERVER NOW (W6.2). It used to be a device-local
      // timestamp, so a reply read on a phone was unread again on a laptop -
      // and the `feedback.user_seen_at` column built for exactly this was dead
      // code that nothing ever wrote to.
      setHasUnread(Number(data.unread ?? 0) > 0);
    } catch {
      setReports([]);
      setReportsError(t("Could not load your reports - check your connection."));
    }
  }, [t]);

  // Peek once on open so the tab can show an unread dot without switching.
  useEffect(() => {
    loadReports();
  }, [loadReports]);

  // THE CLICK THAT REVEALS THE BADGE MUST NOT BE THE CLICK THAT ERASES IT.
  //
  // This used to PATCH /api/feedback with the body "{}", which the route reads
  // as "no id" (`Number(undefined)` is not finite) and therefore stamps
  // `user_seen_at` on EVERY one of the caller's reports - then reloaded. So the
  // per-row "new reply" badge appeared for the length of one round trip and
  // every row came back `unread: 0`. The route's per-report `id` branch existed
  // and no client had ever exercised it.
  //
  // Opening the TAB now only dismisses the tab's own dot (a local fact: you are
  // looking at the list). A report is marked read when the reporter actually
  // OPENS it - see ReportRow - which is the only moment we know they read
  // anything.
  const openYours = () => {
    setTab("yours");
    setHasUnread(false);
    loadReports();
  };

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brandblue-soft">
            <Icon name="chat" className="h-4 w-4 text-brandblue" />
          </div>
          <h2 className="text-lg font-extrabold text-strong">{t("Feedback")}</h2>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label={t("Close")}>
          ✕
        </button>
      </div>

      {/* Segmented control - compose a new report or manage your own thread. */}
      <div className="mb-3 flex gap-1 rounded-2xl bg-card2 p-1">
        <button
          onClick={() => setTab("new")}
          className={`flex-1 rounded-xl py-2 text-[13px] font-extrabold transition-colors ${
            tab === "new" ? "bg-card text-strong shadow-sm" : "text-soft"
          }`}
        >
          {t("Send new")}
        </button>
        <button
          onClick={openYours}
          className={`relative flex-1 rounded-xl py-2 text-[13px] font-extrabold transition-colors ${
            tab === "yours" ? "bg-card text-strong shadow-sm" : "text-soft"
          }`}
        >
          {t("Your reports")}
          {hasUnread && tab !== "yours" && (
            <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-brandred" aria-label={t("new reply")} />
          )}
        </button>
      </div>

      {tab === "new" ? (
        <ComposeTab email={email} onSubmitted={loadReports} onSeeYours={openYours} />
      ) : (
        <ReportsTab
          reports={reports}
          error={reportsError}
          onChanged={loadReports}
        />
      )}
    </Modal>
  );
}

function ComposeTab({
  email,
  onSubmitted,
  onSeeYours,
}: {
  email?: string;
  onSubmitted: () => void;
  onSeeYours: () => void;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState("bug");
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ filename: string; dataUrl: string }[]>([]);
  const [assisting, setAssisting] = useState(false);
  const [status, setStatus] = useState<
    | { s: "idle" }
    | { s: "sending" }
    | { s: "accepted"; emailed: boolean; summary: string; stored: boolean; anonymous: boolean }
    | { s: "filtered"; reason: string; stored: boolean }
    // THE SAFE-WORDS REFUSAL IS NOT AN ERROR (W6.2). It is a specific, polite
    // answer the reporter can act on, and it must not look like a crash.
    | { s: "blocked"; msg: string }
    | { s: "error"; msg: string }
  >({ s: "idle" });

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const room = MAX_IMAGES - images.length;
    const chosen = Array.from(files).slice(0, room);
    const next: { filename: string; dataUrl: string }[] = [];
    for (const f of chosen) {
      const shot = await normalizeImageFile(f, SHOT);
      // An unreadable file yields an empty data URL rather than a throw.
      if (shot.dataUrl) next.push({ filename: f.name, dataUrl: shot.dataUrl });
    }
    setImages((prev) => [...prev, ...next].slice(0, MAX_IMAGES));
  }

  async function assist() {
    if (!text.trim()) return;
    setAssisting(true);
    try {
      const res = await fetch("/api/feedback/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, notes: text }),
      });
      const data = await res.json();
      if (data.text) setText(data.text);
    } finally {
      setAssisting(false);
    }
  }

  async function submit() {
    if (text.trim().length < 3) return;
    setStatus({ s: "sending" });
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, text, email, images }),
      });
      const data = await res.json();
      if (data?.rejected === "language") {
        setStatus({ s: "blocked", msg: data.error ?? t("Please rephrase this and send it again.") });
      } else if (!res.ok) {
        setStatus({ s: "error", msg: data.error ?? t("Something went wrong.") });
      } else if (data.accepted) {
        // `stored` IS THE HONEST FLAG AND IT WAS BEING THROWN AWAY. The server
        // says whether a row landed; both success copies promise a thread under
        // "Your reports" that only exists if it did, so a lost report used to
        // read exactly like a received one.
        setStatus({
          s: "accepted",
          emailed: data.emailed,
          summary: data.summary,
          stored: data.stored !== false,
          anonymous: Boolean(data.anonymous),
        });
        onSubmitted();
      } else {
        setStatus({ s: "filtered", reason: data.reason, stored: data.stored !== false });
        onSubmitted();
      }
    } catch {
      setStatus({ s: "error", msg: t("Network error. Please try again.") });
    }
  }

  // A REFUSED MESSAGE IS NOT A FINISHED ONE. The text stays in the box so the
  // reporter can edit the one word that tripped it, not retype the paragraph.
  if (status.s === "blocked") {
    return (
      <div className="py-6 text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-brandyellow-soft">
          <Icon name="shield" className="h-8 w-8 text-brandyellow" />
        </div>
        <p className="text-sm font-extrabold text-strong">{t("Let's keep it clean")}</p>
        <p className="mx-auto mt-1 max-w-[300px] text-[13px] text-soft">{status.msg}</p>
        <button
          onClick={() => setStatus({ s: "idle" })}
          className="btn btn-primary mt-4 w-full rounded-2xl py-2.5 text-sm"
        >
          {t("Edit my report")}
        </button>
      </div>
    );
  }

  const done = status.s === "accepted" || status.s === "filtered";
  if (done) {
    const stored = status.stored;
    return (
      <div className="py-6 text-center">
        <div
          className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full ${
            status.s === "accepted" ? "bg-savings-soft" : "bg-brandyellow-soft"
          }`}
        >
          <Icon
            name={status.s === "accepted" ? "check" : "shield"}
            className={`h-8 w-8 ${status.s === "accepted" ? "text-savings" : "text-brandyellow"}`}
          />
        </div>
        {status.s === "accepted" ? (
          <>
            <p className="text-sm font-extrabold text-strong">{t("Thanks - this one is on us.")}</p>
            <p className="mt-1 text-[13px] text-soft">
              {status.emailed
                ? t("Verified as a real issue and emailed to the team.")
                : t("Verified as a real issue and logged for the team.")}
            </p>
          </>
        ) : (
          <p className="text-[13px] text-soft">{status.reason}</p>
        )}
        {/* THE HONEST FOLLOW-UP PROMISE. The server tells us whether a row
            landed and whether the report has an owner; the copy has to match
            which promise we actually kept, or a lost report reads exactly like
            a received one. */}
        <p className="mx-auto mt-2 max-w-[300px] text-[12px] font-bold text-soft">
          {!stored
            ? t("We could not save your copy just now, so it will not appear under Your reports.")
            : status.s === "accepted" && status.anonymous
              ? t("You sent this while signed out, so we have no way to reply to you. Sign in and send it again if you want to follow it.")
              : t("You can follow it under Your reports.")}
        </p>
        <button
          onClick={onSeeYours}
          className="btn btn-primary mt-4 w-full rounded-2xl py-2.5 text-sm"
        >
          {t("See your reports")}
        </button>
      </div>
    );
  }

  return (
    <>
      <p className="mb-3 text-[12px] text-soft">
        {t("Bug, idea, question or complaint - tell us anything. You will see it under Your reports and the team can reply right there.")}
      </p>

      {/* AN ANONYMOUS REPORT IS A DEAD END, AND WE SAY SO BEFORE IT IS SENT.
          Ownership comes from the session only (never the body), so a signed-out
          submission is stored unowned: invisible to its author forever, with no
          reply channel. That was discovered afterwards, if ever. */}
      {!email && (
        <p className="mb-3 rounded-2xl bg-brandyellow-soft px-3 py-2 text-[11.5px] font-bold text-warn">
          {t("You are signed out. We will still read this, but we will not be able to reply to you or show it under Your reports.")}
        </p>
      )}

      {/* The rule, said once, before anyone types. */}
      <p className="mb-2 text-[11px] text-faint">
        {t("Please keep it civil - reports with abusive language are not accepted.")}
      </p>

      <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            // Selected-by-colour-alone: the category chips carried no state
            // for a screen reader or for forced-colours mode.
            aria-pressed={category === c.id}
            className={`chip whitespace-nowrap rounded-full border-2 px-3 py-1.5 text-[12px] font-bold ${
              category === c.id
                ? "border-brandblue bg-brandblue text-white"
                : "border-line bg-card text-soft"
            }`}
          >
            {t(c.label)}
          </button>
        ))}
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        maxLength={4000}
        placeholder={t("What happened? Steps to reproduce, what you expected...")}
        className="w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint transition-colors focus:border-brandblue focus:outline-none"
      />

      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={assist}
          disabled={assisting || !text.trim()}
          className="btn btn-sm chip inline-flex items-center gap-1.5 rounded-xl border-2 border-brandred/30 bg-brandred-soft px-2.5 py-1.5 text-[12px] font-bold text-brandred disabled:opacity-50"
        >
          <Icon name="spark" className="h-3.5 w-3.5" />
          {assisting ? <LoadingDots label={t("Writing")} /> : t("Write it for me")}
        </button>
        <span className="text-[11px] text-faint">{text.length}/4000</span>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 text-[12px] font-bold text-soft">
          {t("Screenshots")} ({images.length}/{MAX_IMAGES})
        </div>
        <div className="flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div key={i} className="relative h-16 w-16 overflow-hidden rounded-xl border-2 border-line">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.dataUrl} alt="" className="h-full w-full object-cover" />
              <button
                onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
                className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center bg-black/60 text-[11px] text-white"
                aria-label={t("Remove image")}
              >
                ✕
              </button>
            </div>
          ))}
          {images.length < MAX_IMAGES && (
            <label
              className="btn flex h-16 w-16 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-line text-faint hover:border-brandblue hover:text-brandblue"
              aria-label={t("Add screenshot")}
            >
              <input
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <Icon name="plus" className="h-5 w-5" />
            </label>
          )}
        </div>
      </div>

      {status.s === "error" && (
        <p className="mt-2 text-[12px] font-semibold text-brandred">{status.msg}</p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={status.s === "sending" || text.trim().length < 3}
        className="btn btn-primary mt-4 w-full rounded-2xl py-3 text-sm disabled:opacity-60"
      >
        {status.s === "sending" ? (
          <LoadingDots light label={t("Sending your feedback")} />
        ) : (
          t("Submit feedback")
        )}
      </button>
    </>
  );
}

function ReportsTab({
  reports,
  error,
  onChanged,
}: {
  reports: Report[] | null;
  error: string | null;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  // CATEGORIES THAT DO SOMETHING (W6.2). They were collected, stored and
  // displayed, and drove nothing at all - here or in the owner's inbox.
  const [pick, setPick] = useState<string>("all");
  if (reports === null) {
    return (
      <div className="py-8 text-center">
        <LoadingDots label={t("Loading your reports")} />
      </div>
    );
  }
  if (error) {
    return <p className="py-8 text-center text-[13px] text-soft">{error}</p>;
  }
  if (reports.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-[13px] font-extrabold text-strong">{t("No reports yet")}</p>
        <p className="mx-auto mt-1 max-w-[260px] text-[12px] text-soft">
          {t("Anything you send appears here as a conversation you can follow and reply to.")}
        </p>
      </div>
    );
  }
  const counts: Record<string, number> = {};
  for (const r of reports) counts[r.category || "other"] = (counts[r.category || "other"] ?? 0) + 1;
  const chips = [
    { id: "all", label: "All", n: reports.length },
    ...CATEGORIES.filter((c) => counts[c.id]).map((c) => ({
      id: c.id,
      label: c.label,
      n: counts[c.id],
    })),
  ];
  const shown = pick === "all" ? reports : reports.filter((r) => (r.category || "other") === pick);
  return (
    <>
      {chips.length > 2 && (
        <div className="no-scrollbar mb-2 flex gap-1.5 overflow-x-auto">
          {chips.map((c) => (
            <button
              key={c.id}
              onClick={() => setPick(c.id)}
              aria-pressed={pick === c.id}
              className={`chip whitespace-nowrap rounded-full border-2 px-2.5 py-1 text-[11px] font-bold ${
                pick === c.id
                  ? "border-brandblue bg-brandblue text-white"
                  : "border-line bg-card text-soft"
              }`}
            >
              {t(c.label)} ({c.n})
            </button>
          ))}
        </div>
      )}
      <div className="no-scrollbar max-h-[55vh] space-y-2.5 overflow-y-auto">
        {shown.map((r) => (
          <ReportRow key={r.id} report={r} onChanged={onChanged} />
        ))}
      </div>
    </>
  );
}

function ReportRow({ report, onChanged }: { report: Report; onChanged: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  /** A reply the server refused or could not store, said out loud. */
  const [replyErr, setReplyErr] = useState<string | null>(null);
  const status = report.status ?? "open";
  const meta = STATUS_META[status] ?? STATUS_META.open;

  /**
   * Expand - and, the first time, mark THIS report read.
   *
   * The per-report `id` branch of PATCH /api/feedback had no caller: the modal
   * stamped every report the moment the tab opened, so the badge died before it
   * could be seen. Reading a thread is the honest moment to clear its badge,
   * and it is scoped to the one report that was actually read.
   */
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && (report.unread ?? 0) > 0) {
      fetch("/api/feedback", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: report.id }),
      })
        .catch(() => {})
        // A failed stamp shows the badge again next time, which is the safe
        // direction: an unread answer is better than a lost one.
        .finally(() => onChanged());
    }
  }

  async function sendReply() {
    if (!reply.trim() || busy) return;
    setBusy(true);
    setReplyErr(null);
    try {
      const res = await fetch("/api/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackId: report.id, body: reply.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      // A REPLY THAT DID NOT LAND MUST NOT LOOK SENT. The route used to answer
      // `{ok:true}` whatever the insert did, and this cleared the box and
      // re-rendered on `res.ok` alone - so a reply into a database that never
      // stored it read exactly like one that did. The text stays in the box now
      // so it can be sent again rather than retyped.
      if (!res.ok || data?.ok === false) {
        setReplyErr(
          data?.rejected === "language"
            ? String(data.error ?? t("Please rephrase this and send it again."))
            : String(data?.error ?? t("Could not send that reply. Please try again."))
        );
        return;
      }
      setReply("");
      onChanged();
    } catch {
      setReplyErr(t("Could not send that reply. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setReplyErr(null);
    try {
      const res = await fetch(`/api/feedback?id=${report.id}`, { method: "DELETE" });
      // The route answers 502 when the durable delete was refused (audit
      // M45); the report is still there and the reporter must hear it.
      if (res.ok) onChanged();
      else setReplyErr(t("Could not delete this report - it is still here. Please try again."));
    } catch {
      setReplyErr(t("Could not delete this report - it is still here. Please try again."));
    } finally {
      setBusy(false);
      setConfirmDel(false);
    }
  }

  const teamReplies = report.replies.filter((rp) => rp.author_role !== "user").length;

  return (
    <div className="surface rounded-2xl p-3">
      <button onClick={toggle} className="flex w-full items-start justify-between gap-2 text-left">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${meta.cls}`}>
              {t(meta.label)}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wide text-faint">
              {report.category}
            </span>
            {teamReplies > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-brandblue">
                <Icon name="chat" className="h-3 w-3" /> {teamReplies}
              </span>
            )}
            {/* THE UNREAD DOT, ON THE ROW ITSELF. It only ever existed on the
                tab header - i.e. visible once the modal was already open, and
                only until you switched tabs - so a team reply was easy to miss
                entirely. The count is server-side (feedback.user_seen_at). */}
            {(report.unread ?? 0) > 0 && (
              <span className="rounded-full bg-brandred px-1.5 py-0.5 text-[9px] font-extrabold text-white">
                {t("new reply")}
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[13px] font-semibold text-strong">
            {report.summary || report.body}
          </p>
        </div>
        <span className="shrink-0 text-[10px] text-faint">{fmtDate(report.created_at)}</span>
      </button>

      {open && (
        <div className="mt-2.5 border-t border-line pt-2.5">
          <p className="whitespace-pre-wrap text-[12px] text-soft">{report.body}</p>

          {report.replies.length > 0 && (
            <div className="mt-2.5 space-y-1.5">
              {report.replies.map((rp) => {
                const mine = rp.author_role === "user";
                return (
                  <div key={rp.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-[12px] ${
                        mine
                          ? "rounded-br-md bg-brandblue text-white"
                          : "rounded-bl-md bg-card2 text-strong"
                      }`}
                    >
                      {!mine && (
                        <div className="text-[9px] font-extrabold uppercase tracking-wide text-brandblue">
                          {rp.author_role === "owner" ? t("WheelDeal team") : t("Support")}
                        </div>
                      )}
                      <p className="whitespace-pre-wrap">{rp.body}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {status !== "dismissed" && (
            <div className="mt-2.5 flex items-center gap-1.5">
              <input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendReply();
                }}
                disabled={busy}
                placeholder={t("Reply to the team...")}
                className="h-10 min-w-0 flex-1 rounded-xl border-2 border-line bg-card px-3 text-sm text-strong placeholder:text-faint transition-colors focus:border-brandblue focus:outline-none disabled:opacity-60"
                style={{ fontSize: "16px" }}
              />
              <button
                onClick={sendReply}
                disabled={busy || !reply.trim()}
                className="btn btn-primary h-10 shrink-0 rounded-xl px-3 disabled:opacity-50"
                aria-label={t("Send reply")}
              >
                <Icon name="send" className="h-4 w-4" />
              </button>
            </div>
          )}

          {replyErr && (
            <p className="mt-1.5 text-[11.5px] font-bold text-brandred">{replyErr}</p>
          )}

          <div className="mt-2 flex justify-end">
            {confirmDel ? (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-soft">{t("Delete this report?")}</span>
                <button onClick={remove} disabled={busy} className="font-extrabold text-brandred">
                  {t("Delete")}
                </button>
                <button onClick={() => setConfirmDel(false)} className="font-bold text-faint">
                  {t("Cancel")}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDel(true)}
                className="text-[11px] font-bold text-faint hover:text-brandred"
              >
                {t("Delete report")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
