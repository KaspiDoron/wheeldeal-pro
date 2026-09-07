"use client";

import { useEffect, useState } from "react";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { Modal } from "./Modal";
import { LoadingDots } from "./LoadingDots";
import { useI18n } from "@/lib/i18n";
import { can } from "@/lib/entitlements";
import { fetchJson } from "@/lib/client/fetch-json";
import { draftOutcome } from "@/lib/client/draft-outcome";

// Adaptive Bargaining Agent UI: composes the next message and sends it to the
// shop from INSIDE the app. The traveller can also WRITE or EDIT the message
// themselves - every send is safety-screened by the server before it leaves.
// Entitled members can flip the agent into the shop's local language - but
// ONLY on a hunt that is running in the local language at all.
export function BargainDraftModal({
  vendor,
  rfq,
  region,
  round,
  plan,
  sessionLocalLang = false,
  currentPricePerDay,
  rivalPricePerDay,
  onClose,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ;
  region?: string;
  round: number;
  plan?: string;
  /** Is THIS HUNT running in the shop's local language? (owner report 5 #14:
   *  an English-only session must not offer - or default to - a local draft.
   *  The modal used to invent its own default from the plan tier with no
   *  session context, so an Ultra owner's English hunt opened on a Thai
   *  draft.) */
  sessionLocalLang?: boolean;
  currentPricePerDay?: number;
  rivalPricePerDay?: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // The shared FEATURE predicate, not a hand-rolled tier literal - the exact
  // anti-pattern entitlements.ts names for this very feature.
  const localEntitled = can(plan, "local-language");
  // The draft follows the HUNT's language. The server re-resolves against the
  // thread's established mode either way, so this default can only ever be
  // corrected toward reality, never away from it.
  const [language, setLanguage] = useState<"english" | "local">(
    sessionLocalLang && localEntitled ? "local" : "english"
  );
  const [text, setText] = useState("");
  // English gloss of a LOCAL-LANGUAGE draft (composeBargain returns it as
  // `english`). The traveller used to approve a Thai message with no idea what
  // it said - the route sent the translation and the modal threw it away.
  const [gloss, setGloss] = useState("");
  const [tacticLabel, setTacticLabel] = useState("");
  const [wasFallback, setWasFallback] = useState(false);
  const [busy, setBusy] = useState(true);
  const [edited, setEdited] = useState(false);
  const [sendState, setSendState] = useState<
    "idle" | "sending" | "sent" | "queued" | "held" | "reconnecting" | "blocked" | "manual" | "ratelimited"
  >("idle");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [upgradeNote, setUpgradeNote] = useState(false);
  /** WHY there is no draft. Without this a refused compose was a blank box:
   *  the route's 401/400 and its two 500 rails set no state at all, so the
   *  modal showed an empty textarea and a disabled Send button (audit F053). */
  const [draftError, setDraftError] = useState<string | null>(null);

  async function compose(langChoice = language) {
    setBusy(true);
    setSendState("idle");
    setStatusMsg(null);
    setDraftError(null);
    try {
      // fetchJson never throws and always settles: `await res.json()` on a
      // non-JSON 500 used to reject straight out of a try that had only a
      // finally. The 50s deadline matches the send path's - a compose runs a
      // real LLM plus a safety screen, so the helper's 10s default would abort
      // perfectly healthy drafts.
      const res = await fetchJson<Record<string, unknown>>("/api/bargain-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 50_000,
        body: JSON.stringify({
          vendor,
          rfq,
          region,
          round,
          currentPricePerDay,
          rivalPricePerDay,
          language: langChoice,
        }),
      });
      const outcome = draftOutcome(res.ok, res.data);
      if (outcome.kind === "draft") {
        const data = (res.data ?? {}) as Record<string, unknown>;
        setText(outcome.message);
        // The draft's English gloss (local-language drafts only; a reused
        // draft comes back without one). Never shown when it just repeats
        // the message.
        setGloss(
          typeof data.english === "string" && data.english.trim() !== outcome.message.trim()
            ? data.english
            : ""
        );
        setTacticLabel(typeof data.tacticLabel === "string" ? data.tacticLabel : "");
        setWasFallback(Boolean(data.fallback));
        setEdited(false);
        // The server resolves the thread's ESTABLISHED language and may
        // override the request (thread already in English, hunt not local).
        // Reflect what was actually composed, never a stale chip.
        if (data.languageUsed === "english" || data.languageUsed === "local") {
          setLanguage(data.languageUsed);
        }
      } else if (outcome.kind === "upgrade") {
        setUpgradeNote(true);
      } else {
        // The route already writes user-safe prose for its own refusals; the
        // fallback covers a timeout, a dead connection or a non-JSON answer.
        setDraftError(
          outcome.error ||
            res.error ||
            t("Could not write a draft just now - tap Rewrite, or type your own message.")
        );
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    compose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendInApp() {
    const message = text.trim();
    if (!message) return;
    setSendState("sending");
    setStatusMsg(null);
    try {
      const res = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: vendor.whatsapp || undefined,
          placeId: vendor.placeId,
          vendorId: vendor.id,
          vendorName: vendor.name,
          message,
          // A hand-edited message is a custom send (safety-screened, and it skips
          // the agent engagement-halt); an untouched AI draft is a bargain.
          kind: edited ? "custom" : "bargain",
          // Either way this is ONE user move on this shop: the server's
          // per-window debounce refuses a second near-identical bargain fired
          // moments after the first (the field's action-spam failure).
          userMove: true,
          rfq,
          round,
          region,
          openNow: vendor.openNow,
        }),
      });
      const d = await res.json();
      if (d.sent) {
        setSendState("sent");
      } else if (d.allowed === false && d.reason) {
        // Safety filter blocked the wording.
        setSendState("blocked");
        setStatusMsg(
          `${d.reason}${d.suggestion ? ` - ${t("Try:")} "${d.suggestion}"` : ""}`
        );
      } else if (d.queued) {
        setSendState("queued");
        setStatusMsg(
          d.queuedUntil
            ? `${t("The shop looks closed now - your message is queued and sends automatically when they open")} (${new Date(
                d.queuedUntil
              ).toLocaleString()}).`
            : t("Your message is queued and will send shortly.")
        );
      } else if (d.held) {
        // One move per window: nothing was sent, and the reason is honest.
        setSendState("held");
        setStatusMsg(
          d.error ??
            t("Your agent just made a move in this chat - give the shop a couple of minutes to answer.")
        );
      } else if (d.reconnecting) {
        setSendState("reconnecting");
        setStatusMsg(d.error ?? t("Your WhatsApp is reconnecting - wait a few seconds and tap send again."));
      } else if (d.rateLimited) {
        setSendState("ratelimited");
        setStatusMsg(d.error ?? t("Done for today - sending resumes automatically a bit later."));
      } else {
        setSendState("manual");
        setStatusMsg(d.error ?? null);
      }
    } catch {
      setSendState("manual");
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-extrabold text-strong">{t("Bargain draft")} 🥊</h2>
          <p className="text-[12px] text-faint">{vendor.name}</p>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      {/* Language chips render ONLY on a local-language hunt. An English-only
          session gets no toggle at all - there is nothing to toggle to, and the
          owner named the stray "Local language" chip on an English hunt as a
          bug. On a local hunt the traveller may still flip ONE message to
          English (e.g. quoting exact terms). */}
      {sessionLocalLang && (
        <div className="mb-3 flex gap-1.5">
          <button
            onClick={() => {
              setLanguage("english");
              setUpgradeNote(false);
              compose("english");
            }}
            className={`btn btn-sm chip flex-1 rounded-xl border-2 py-2 text-[12px] font-extrabold ${
              language === "english"
                ? "border-brandblue bg-brandblue-soft text-brandblue"
                : "border-line text-soft"
            }`}
          >
            🇬🇧 {t("English")}
          </button>
          <button
            onClick={() => {
              if (!localEntitled) {
                setUpgradeNote(true);
                return;
              }
              setLanguage("local");
              compose("local");
            }}
            className={`btn btn-sm chip flex-1 rounded-xl border-2 py-2 text-[12px] font-extrabold ${
              language === "local" && localEntitled
                ? "badge-ultra border-transparent"
                : "border-line text-soft"
            }`}
          >
            🌍 {t("Local language")}
            {!localEntitled && " 🔒"}
          </button>
        </div>
      )}
      {sessionLocalLang && language === "local" && localEntitled && (
        <div className="badge-ultra mb-2 rounded-full px-3 py-1 text-center text-[11px] font-extrabold">
          ⚡ ULTRA · {t("Street-smart haggling in the shop's own language")}
        </div>
      )}
      {upgradeNote && (
        <p className="mb-2 rounded-xl bg-brandyellow-soft p-2 text-[12px] font-bold text-warn">
          {t("Bargaining in the local language is an Ultra perk - locals get local prices. Upgrade to unlock it.")}
        </p>
      )}

      {busy ? (
        <div className="flex justify-center py-8">
          <LoadingDots label={t("Agent writing the perfect message")} />
        </div>
      ) : (
        <>
          {draftError && (
            <p className="mb-2 rounded-xl bg-brandred-soft p-2 text-[12px] font-bold text-brandred" role="alert">
              {draftError}
            </p>
          )}
          {tacticLabel && !edited && (
            <div className="mb-2 inline-flex rounded-full bg-brandred-soft px-2.5 py-1 text-[11px] font-extrabold text-brandred">
              {t("Tactic:")} {tacticLabel}
            </div>
          )}
          {wasFallback && !edited && (
            <p className="mb-2 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-warn">
              {t("The AI was unreachable, so this is a simple template - tap Rewrite to try the full agent again, or edit it yourself.")}
            </p>
          )}
          {/* Editable draft: the traveller can tweak or fully rewrite it.
              Every send is safety-checked on the server before it leaves. */}
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setEdited(true);
              if (sendState !== "idle") {
                setSendState("idle");
                setStatusMsg(null);
              }
            }}
            rows={5}
            placeholder={t("Write your message to the shop...")}
            className="w-full rounded-2xl border-2 border-line bg-card2 p-3 text-[14px] leading-relaxed text-strong focus:border-brandblue focus:outline-none"
          />
          <div className="mt-1 flex items-center justify-between text-[10px] text-faint">
            <span>{edited ? t("Edited by you - screened before sending") : t("AI draft - edit it if you like")}</span>
            <span>{text.trim().length} {t("chars")}</span>
          </div>
          {/* WHAT THE LOCAL-LANGUAGE DRAFT SAYS, in English - the traveller
              approves a message they can actually read. Hidden once they edit
              (the gloss no longer describes their text). */}
          {gloss && !edited && (
            <p className="mt-1.5 rounded-xl bg-brandblue-soft p-2 text-[11px] italic leading-relaxed text-brandblue">
              🌐 {t("In English")}: {gloss}
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <button
              onClick={sendInApp}
              disabled={sendState === "sending" || sendState === "sent" || !text.trim()}
              className="btn flex-1 rounded-2xl bg-savings py-2.5 text-center text-[13px] font-extrabold text-white disabled:opacity-70"
            >
              {sendState === "sending" ? (
                <LoadingDots light label={t("Sending")} />
              ) : sendState === "sent" ? (
                `✓ ${t("Sent from the app")}`
              ) : (
                t("Send from the app")
              )}
            </button>
            <button
              onClick={() => compose()}
              className="btn btn-ghost rounded-2xl px-4 py-2.5 text-[13px]"
              title={t("Ask the AI to rewrite it")}
            >
              🤖 {t("Rewrite")}
            </button>
          </div>

          {/* Accurate, honest send status */}
          {sendState === "sent" && (
            <p className="mt-2 text-center text-[11px] font-bold text-savings">
              {t("The shop's answer will appear on the card automatically.")}
            </p>
          )}
          {sendState === "queued" && statusMsg && (
            <p className="mt-2 rounded-xl bg-brandblue-soft p-2 text-center text-[11px] font-bold text-brandblue">
              🕒 {statusMsg}
            </p>
          )}
          {sendState === "held" && statusMsg && (
            <p className="mt-2 rounded-xl bg-brandblue-soft p-2 text-center text-[11px] font-bold text-brandblue">
              ⏳ {statusMsg}
            </p>
          )}
          {(sendState === "reconnecting" || sendState === "ratelimited") && statusMsg && (
            <p className="mt-2 rounded-xl bg-brandyellow-soft p-2 text-center text-[11px] font-bold text-warn">
              {statusMsg}
            </p>
          )}
          {sendState === "blocked" && statusMsg && (
            <p className="mt-2 rounded-xl bg-brandred-soft p-2 text-center text-[11px] font-bold text-brandred">
              🛡️ {statusMsg}
            </p>
          )}
          {sendState === "manual" && (
            <a
              href="/profile"
              className="mt-2 block rounded-xl bg-brandyellow-soft p-2 text-center text-[11px] font-bold text-warn"
            >
              {statusMsg ?? t("Not sent - connect your WhatsApp in Profile first.")} →
            </a>
          )}
        </>
      )}
    </Modal>
  );
}
