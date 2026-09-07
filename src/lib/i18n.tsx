"use client";

// Global AI translation.
//
// How it works: UI strings are wrapped in t("..."). English is the source of
// truth. When the user picks another language (globe button, available from
// the login screen onwards), the catalogue is translated by our AI providers
// (via /api/translate - real LLM translation, tuned for app UI, cached in
// Supabase + localStorage). Any string t() sees that is not yet translated is
// queued and swept automatically, so coverage is complete even for lazily
// mounted screens. Messages the agents send to VENDORS are not affected -
// those are composed server-side (English, or the shop's local language for
// Ultra members).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface Lang {
  code: string;
  name: string;
  flag: string;
  rtl?: boolean;
}

export const LANGS: Lang[] = [
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "es", name: "Español", flag: "🇪🇸" },
  { code: "fr", name: "Français", flag: "🇫🇷" },
  { code: "de", name: "Deutsch", flag: "🇩🇪" },
  { code: "it", name: "Italiano", flag: "🇮🇹" },
  { code: "pt", name: "Português", flag: "🇵🇹" },
  { code: "nl", name: "Nederlands", flag: "🇳🇱" },
  { code: "ru", name: "Русский", flag: "🇷🇺" },
  { code: "uk", name: "Українська", flag: "🇺🇦" },
  { code: "pl", name: "Polski", flag: "🇵🇱" },
  { code: "tr", name: "Türkçe", flag: "🇹🇷" },
  { code: "he", name: "עברית", flag: "🇮🇱", rtl: true },
  { code: "ar", name: "العربية", flag: "🇸🇦", rtl: true },
  { code: "hi", name: "हिन्दी", flag: "🇮🇳" },
  { code: "th", name: "ไทย", flag: "🇹🇭" },
  { code: "id", name: "Bahasa Indonesia", flag: "🇮🇩" },
  { code: "vi", name: "Tiếng Việt", flag: "🇻🇳" },
  { code: "zh", name: "中文", flag: "🇨🇳" },
  { code: "ja", name: "日本語", flag: "🇯🇵" },
  { code: "ko", name: "한국어", flag: "🇰🇷" },
];

type Dict = Record<string, string>;

interface I18nValue {
  lang: string;
  setLang: (code: string) => void;
  t: (s: string) => string;
  /**
   * THE ONE ESCAPE HATCH FROM THE CATALOGUE GATE - AND THE RULE FOR USING IT.
   *
   * `t()` refuses anything outside the catalogue because a translated string is
   * uploaded to `app_config.I18N_<lang>`, a row every user of that language
   * reads. `tShared()` skips that check, so it is correct ONLY for text that is
   * already global: the same for every traveller, authored by the operator, and
   * carrying nothing about the person on the screen.
   *
   * Today that is exactly one thing - the owner-written FAQ from /api/faq.
   *
   * NEVER hand it a shop name, a WhatsApp message, a price, a search query, a
   * queue reason with numbers in it, or anything else derived from one user's
   * session. That is the leak this gate exists to close.
   */
  tShared: (s: string) => string;
  busy: boolean;
  error: string | null;
  /**
   * TRANSLATION HAS STOPPED, AND HERE IS WHY.
   *
   * Silently showing English while the language picker still says Thai is how
   * the whole feature looked dead in the field. When the server gives a
   * terminal answer - no AI provider, the daily budget spent - the sweep stops
   * asking AND the traveller is told, in one sentence, in plain language.
   */
  unavailable: string | null;
}

const I18nContext = createContext<I18nValue>({
  lang: "en",
  setLang: () => {},
  t: (s) => s,
  tShared: (s) => s,
  busy: false,
  error: null,
  unavailable: null,
});

import { translateOutcome, unavailableNote, retriable, retirementsFrom } from "./i18n-retry";
// The egress gate: which strings may be sent to the translator at all. It lives
// in its own module because this one is "use client" and the rule it enforces -
// no user text in the globally shared I18N_<lang> row - has to be executable in
// a plain test, not merely read.
import {
  pending,
  failed,
  inFlight,
  markInFlight,
  clearInFlight,
  requeueForTranslation,
  catalogue,
  queueForTranslation,
  queueSharedText,
  translatable,
} from "./i18n-gate";

function cacheGet(lang: string): Dict {
  try {
    return JSON.parse(localStorage.getItem(`wd_i18n_${lang}`) ?? "{}");
  } catch {
    return {};
  }
}

function cacheSet(lang: string, dict: Dict) {
  try {
    localStorage.setItem(`wd_i18n_${lang}`, JSON.stringify(dict));
  } catch {}
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState("en");
  const [dict, setDict] = useState<Dict>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  // A terminal answer stops the sweep for this session. Held in a ref as well
  // as state because the interval closure needs the CURRENT value, not the one
  // captured when it was created.
  const stoppedRef = useRef(false);
  const langRef = useRef(lang);
  // Consecutive entirely-empty answers per string - the bounded patience
  // behind retirementsFrom's no-loop guarantee.
  const emptyStrikes = useRef(new Map<string, number>());
  /** A sweep is running - see the 1.5s interval below (audit F253). */
  const sweepInFlight = useRef(false);
  langRef.current = lang;

  const applyDirection = useCallback((code: string) => {
    const meta = LANGS.find((l) => l.code === code);
    document.documentElement.setAttribute("lang", code);
    document.documentElement.setAttribute("dir", meta?.rtl ? "rtl" : "ltr");
  }, []);

  const fetchTranslations = useCallback(
    async (code: string, texts: string[]) => {
      if (code === "en" || texts.length === 0 || stoppedRef.current) return;
      // CLAIM WHAT WE ARE ABOUT TO ASK FOR (audit F253). The 1.5s sweep asks
      // `retriable` about this set, so it can no longer re-POST the strings the
      // catalogue fetch behind a language switch is still holding - which, on a
      // cold cache, is every string on screen, every 1.5 seconds, each re-ask a
      // request charged against the daily translate cap.
      const claimed = markInFlight(texts);
      setBusy(true);
      setError(null);
      try {
        // Batch so each request stays well inside the serverless time budget
        // (the whole-app catalogue can be hundreds of strings).
        //
        // IN PARALLEL, AND COMMITTED ONCE. Sequential batches meant a language
        // switch was N round trips end to end, and each one called setDict -
        // so every consumer of the context re-rendered once per batch, which on
        // the full catalogue is a re-render storm on the slowest moment in the
        // app. One await, one commit.
        const BATCH = 42;
        const batches: string[][] = [];
        for (let i = 0; i < texts.length; i += BATCH) batches.push(texts.slice(i, i + BATCH));

        const results = await Promise.all(
          batches.map(async (batch) => {
            // Two scopes, one request. Catalogue copy rides `texts`;
            // owner-authored global text (the FAQ, queued via queueSharedText -
            // the only way a non-catalogue string enters the sweep) rides
            // `shared`, where the server validates it against the live FAQ and
            // caches it in its own row. Sending it as `texts` got it silently
            // filtered - the FAQ-stays-English bug.
            const res = await fetch("/api/translate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                lang: code,
                langName: LANGS.find((l) => l.code === code)?.name ?? code,
                texts: batch.filter((s) => translatable(s)),
                shared: batch.filter((s) => !translatable(s)),
              }),
            });
            const data = (await res.json().catch(() => null)) as {
              map?: Record<string, string>;
              error?: string;
              rejected?: { text: string }[];
            } | null;
            return { batch, status: res.status, data };
          })
        );

        if (langRef.current !== code) return; // the user switched again

        const merged: Dict = {};
        let terminal: { status: number; data: { error?: string } | null } | null = null;
        for (const r of results) {
          const outcome = translateOutcome(r.status, r.data);
          if (outcome === "stop") {
            terminal = { status: r.status, data: r.data };
            continue;
          }
          if (outcome === "retry") {
            // ...and STAYS retriable in fact, not just in name: the sweep
            // clears `pending` when it takes a batch, so without this the
            // strings were simply lost until some later render re-queued them.
            requeueForTranslation(r.batch);
            continue;
          }
          Object.assign(merged, r.data?.map ?? {});
          // Retire what the server answered "no" to, so the sweep stops asking
          // - but an ENTIRELY empty answer only earns a strike (see
          // retirementsFrom): retiring a whole batch on one empty 200 is how
          // the FAQ stayed English for the rest of the session.
          for (const miss of retirementsFrom(r.batch, r.data, emptyStrikes.current)) {
            failed.add(miss);
          }
        }

        if (Object.keys(merged).length > 0) {
          setDict((prev) => {
            const next = { ...prev, ...merged };
            cacheSet(code, next);
            return next;
          });
        }

        if (terminal) {
          // NOTHING ABOUT THIS SESSION WILL CHANGE THE ANSWER. Stop asking, and
          // say so - a language picker that silently shows English is worse
          // than one that admits it cannot.
          stoppedRef.current = true;
          const note = unavailableNote(terminal.status, terminal.data);
          setUnavailable(note);
          setError(note);
          pending.clear();
        }
      } catch {
        // A network blip IS worth retrying - the next sweep picks it up, and
        // now it has something to pick up.
        requeueForTranslation(texts);
        setError("Could not reach the translation service.");
      } finally {
        clearInFlight(claimed);
        setBusy(false);
      }
    },
    []
  );

  const setLang = useCallback(
    (code: string) => {
      setLangState(code);
      try {
        localStorage.setItem("wd_lang", code);
      } catch {}
      applyDirection(code);
      // A NEW LANGUAGE IS A NEW QUESTION. Whatever the server declined for the
      // previous one says nothing about this one, and a terminal stop must not
      // outlive the language that caused it.
      failed.clear();
      emptyStrikes.current.clear();
      stoppedRef.current = false;
      setUnavailable(null);
      if (code === "en") {
        setDict({});
        return;
      }
      const cached = cacheGet(code);
      setDict(cached);
      const missing = catalogue().filter((s) => !cached[s]);
      fetchTranslations(code, missing);
    },
    [applyDirection, fetchTranslations]
  );

  // Restore the saved language on first load.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("wd_lang");
      if (saved && saved !== "en" && LANGS.some((l) => l.code === saved)) {
        setLangState(saved);
        applyDirection(saved);
        const cached = cacheGet(saved);
        setDict(cached);
        // Complete coverage for THIS page too: anything in the app catalogue
        // that is not yet cached gets translated right away.
        const missing = catalogue().filter((s) => !cached[s]);
        if (missing.length) fetchTranslations(saved, missing);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sweep strings that appeared after the initial fetch (lazy screens/modals).
  useEffect(() => {
    if (lang === "en") return;
    const id = setInterval(() => {
      if (stoppedRef.current) return;
      // ONE SWEEP AT A TIME (audit F253), the same in-flight discipline the
      // activity and replies polls use. Belt to the `inFlight` set's braces:
      // the set already stops a sweep re-asking for strings a fetch holds, and
      // this stops a second sweep starting at all while one is running.
      if (sweepInFlight.current) return;
      // Only the strings still worth asking about - see lib/i18n-retry.
      const batch = retriable(pending, failed, inFlight);
      // Take ONLY what we are about to ask for. Clearing the whole set here
      // threw away strings the guard had just deferred.
      for (const s of batch) pending.delete(s);
      if (batch.length === 0) return;
      sweepInFlight.current = true;
      void Promise.resolve(fetchTranslations(lang, batch)).finally(() => {
        sweepInFlight.current = false;
      });
    }, 1500);
    return () => clearInterval(id);
  }, [lang, fetchTranslations]);

  const t = useCallback(
    (s: string): string => {
      // Outside the catalogue, queueForTranslation refuses: the string renders
      // unchanged and never leaves the device. See src/lib/i18n-gate.ts.
      if (lang === "en") return s;
      const hit = dict[s];
      if (hit) return hit;
      queueForTranslation(s);
      return s;
    },
    [lang, dict]
  );

  const tShared = useCallback(
    (s: string): string => {
      if (lang === "en" || !s) return s;
      const hit = dict[s];
      if (hit) return hit;
      queueSharedText(s);
      return s;
    },
    [lang, dict]
  );

  // Memoize the context value so a `busy`/`error` toggle (or any provider
  // re-render) does not hand every useI18n consumer in the tree a brand-new
  // object and force a full-app re-render on each translate sweep.
  const value = useMemo(
    () => ({ lang, setLang, t, tShared, busy, error, unavailable }),
    [lang, setLang, t, tShared, busy, error, unavailable]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
