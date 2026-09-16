"use client";

// THE REQUIRED DECISION, on the one screen that also explains it.
//
// The middleware sends a signed-in person here when they have no current
// answer. This is the card they land on: the decision, the two one-tap
// answers, and the full generated inventory already on the page beneath it.
// That pairing is the point - a gate that demands an answer while the
// explanation lives behind another link is a gate people answer at random.
//
// "Essential only" is FIRST, and identical in weight to "Accept all". What is
// mandatory here is answering, never the answer: essential-only is a complete,
// one-tap route back into the whole product, and lib/cookies/required explains
// why requiring the acknowledgement is a condition of service rather than a
// cookie wall. A test pins the two buttons against each other, as it does on
// the banner.
//
// On success it returns the person to where the middleware took them from -
// through `safeNext`, so the `next` parameter (which arrives from a URL and is
// therefore attacker-controlled) can only ever name a path this app serves.

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  ALLOW_ALL,
  DENY_ALL,
  encodeCookieConsent,
  makeConsent,
  type CookieGrants,
} from "@/lib/cookies/consent";
import { safeNext } from "@/lib/cookies/required";
import {
  announceConsent,
  dropAnalyticsId,
  openCookiePanel,
  purgeDenied,
  writeConsentCookie,
} from "@/lib/cookies/client";

export function CookieGate() {
  const { t } = useI18n();
  const [required, setRequired] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    // Read AFTER mount: this page is statically rendered so the server has no
    // query string, and reading it during render would hydrate-mismatch.
    try {
      const params = new URLSearchParams(window.location.search);
      setRequired(params.get("required") === "1");
      setNext(safeNext(params.get("next")));
    } catch {
      /* no query, no gate - the page is still the policy */
    }
  }, []);

  const choose = useCallback(
    async (choice: "reject-all" | "accept-all", grants: CookieGrants) => {
      setSaving(choice);
      setFailed(null);

      // APPLIED LOCALLY FIRST, exactly as the banner does it: the cookie is
      // what the middleware reads, so writing it here means the redirect below
      // succeeds even if the durable ledger write is still in flight or the
      // connection is dead. A person held at a gate by a spinner on hotel wifi
      // will not wait patiently, they will leave.
      const consent = makeConsent(grants, choice);
      writeConsentCookie(encodeCookieConsent(consent));
      purgeDenied(consent);
      if (!consent.grants.analytics) dropAnalyticsId();
      announceConsent(consent);

      try {
        await fetch("/api/cookies/consent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ choice, grants }),
        });
      } catch {
        /* the cookie stands; the ledger row is re-attempted on the next save */
      }

      // Only now leave. If the cookie somehow did not stick (a browser with
      // site data blocked entirely) the middleware bounces them straight back
      // here, and the message below says what happened rather than letting
      // them ping-pong silently.
      if (typeof window !== "undefined") {
        const target = next ?? "/";
        if (document.cookie.includes("wd_cookie_prefs=")) {
          window.location.assign(target);
          return;
        }
        setSaving(null);
        setFailed(
          t("Your browser is blocking site data, so we cannot record your choice - and without that record we cannot sign you in. Allow cookies for this site and try again.")
        );
      }
    },
    [next, t]
  );

  if (!required) return null;

  return (
    <section className="surface mt-4 rounded-blob border-2 border-brandblue p-4">
      <h2 className="text-[15px] font-extrabold leading-tight text-strong">
        🔐 {t("One decision before you carry on")}
      </h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-soft">
        {t("WheelDeal needs two essential cookies to work at all: one that keeps you signed in, and one that remembers the answer you give right here. There is no version of the app without them, so accepting them is part of using it.")}
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-soft">
        <b className="text-strong">{t("Everything else is genuinely optional.")}</b>{" "}
        {t("Preferences, analytics and advertising stay off unless you turn them on, and 'Essential only' is one tap and gets you the entire product. The full list of every cookie is right below.")}
      </p>

      {/* Same weight, same row, essential-only first - see the header note. */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          onClick={() => choose("reject-all", DENY_ALL)}
          disabled={Boolean(saving)}
          className="btn rounded-2xl border-2 border-line bg-card py-3 text-[13px] font-extrabold text-strong disabled:opacity-60"
        >
          {saving === "reject-all" ? t("Saving...") : t("Essential only")}
        </button>
        <button
          onClick={() => choose("accept-all", ALLOW_ALL)}
          disabled={Boolean(saving)}
          className="btn rounded-2xl border-2 border-line bg-card py-3 text-[13px] font-extrabold text-strong disabled:opacity-60"
        >
          {saving === "accept-all" ? t("Saving...") : t("Accept all")}
        </button>
      </div>
      <button
        onClick={openCookiePanel}
        className="mt-2 w-full rounded-2xl py-2 text-[12px] font-extrabold text-brandblue underline"
      >
        {t("Choose category by category")}
      </button>

      {failed && (
        <p className="mt-2 rounded-2xl bg-warn-soft p-2.5 text-[11.5px] font-bold leading-snug text-warn">
          {failed}
        </p>
      )}
    </section>
  );
}
