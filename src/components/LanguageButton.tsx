"use client";

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { LoadingDots } from "./LoadingDots";
import { LANGS, useI18n } from "@/lib/i18n";
import { rememberLocal } from "@/lib/cookies/client";

// Global translate control - lives in the top-right of every screen,
// including the login page. Flashy on first sight so travellers immediately
// know the whole app can speak their language (AI translation).
export function LanguageButton({ flashy = false }: { flashy?: boolean }) {
  const { lang, setLang, t, busy, error, unavailable } = useI18n();
  const [open, setOpen] = useState(false);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (!flashy) return;
    try {
      if (!localStorage.getItem("wd_translate_seen")) setShowHint(true);
    } catch {}
  }, [flashy]);

  const current = LANGS.find((l) => l.code === lang) ?? LANGS[0];

  return (
    <>
      <div className="relative">
        <button
          onClick={() => {
            setOpen(true);
            setShowHint(false);
            try {
              rememberLocal("wd_translate_seen", "1");
            } catch {}
          }}
          aria-label="Change language"
          className={`btn btn-sm chip flex items-center gap-1 rounded-full border-2 px-2.5 py-1 text-[13px] font-extrabold ${
            showHint
              ? "badge-flash border-transparent"
              : "border-line bg-card text-strong"
          }`}
        >
          <span aria-hidden>🌐</span>
          <span className={showHint ? "" : "text-[11px]"}>
            {showHint ? t("Translate") : current.flag}
          </span>
        </button>
        {showHint && (
          <span className="pointer-events-none absolute inset-0 -z-10 animate-ping rounded-full bg-brandblue/40" />
        )}
        {/* TRANSLATION HAS STOPPED AND THE PICKER IS CLOSED. The button still
            shows a flag, so without this the app claims a language it is no
            longer serving - which is exactly how the feature looked dead in the
            field. A dot, and the sentence inside. */}
        {unavailable && !open && (
          <span
            aria-hidden
            title={unavailable}
            className="pointer-events-none absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-warn ring-2 ring-[color:var(--bg)]"
          />
        )}
      </div>

      {open && (
        // Bottom sheet (not centered): always anchored to the bottom of the
        // screen, so the close button can never be pushed off-screen.
        <Modal onClose={() => setOpen(false)}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-extrabold text-strong">
                🌐 {t("Choose your language")}
              </h2>
              <p className="text-[11px] text-faint">
                {t("AI-translated - the whole app follows your choice.")}
              </p>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="btn btn-sm btn-ghost rounded-xl px-3"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {busy && (
            <div className="mb-2 flex justify-center rounded-2xl bg-brandblue-soft p-2.5">
              <LoadingDots label={t("Translating the app...")} />
            </div>
          )}
          {(unavailable || error) && (
            <p className="mb-2 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-warn">
              {unavailable ?? error}
            </p>
          )}

          {/* Internal scroll keeps the whole popup (and its close button) on
              screen even on short phones. */}
          <div className="grid max-h-[38dvh] grid-cols-2 gap-1.5 overflow-y-auto pr-0.5">
            {LANGS.map((l) => (
              <button
                key={l.code}
                onClick={() => {
                  setLang(l.code);
                  if (l.code === "en") setOpen(false);
                }}
                className={`btn btn-sm chip flex items-center gap-2 rounded-xl border-2 px-2.5 py-2 text-left text-[13px] font-bold ${
                  lang === l.code
                    ? "border-brandblue bg-brandblue-soft text-brandblue"
                    : "border-line text-soft hover:border-brandblue/40"
                }`}
              >
                <span>{l.flag}</span>
                <span className="truncate">{l.name}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-center text-[10px] text-faint">
            {t("Messages to rental shops are written separately by the agents.")}
          </p>
        </Modal>
      )}
    </>
  );
}
