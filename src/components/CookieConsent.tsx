"use client";

// THE COOKIE BANNER, AND THE PANEL BEHIND IT.
//
// Design rules this component is built to, none of them decoration:
//
// 1. REJECT IS AS EASY AS ACCEPT. Both are one tap, the same size, the same
//    row, neither greyed out and neither styled as the obvious answer. The
//    "Accept all" in brand colour beside a "Reject" rendered as small grey
//    underlined text is the single most common dark pattern in this whole
//    category and it is what makes a banner unlawful in the EU. A test pins
//    the two buttons' classes against each other so a later restyle cannot
//    quietly reintroduce it.
//
// 2. NO DISMISSAL WITHOUT A DECISION. There is no ✕, no backdrop tap and no
//    Escape - not because the app is held hostage (it is not: the banner is a
//    bottom sheet, the page behind it stays usable and scrollable) but because
//    a close button is a fourth answer with no recorded meaning. "Reject all"
//    is right there and takes the same single tap.
//
// 3. IT DOES NOT BLOCK THE APP. No scroll lock, no full-screen veil for the
//    banner itself. A traveller mid-negotiation who scrolls past it is not
//    consenting to anything - the deny default is already in force and stays in
//    force until they answer.
//
// 4. THE PANEL SHOWS THE REAL LIST. Every category expands to the actual
//    cookies and storage keys in that category, straight from the server's
//    manifest, with purpose and duration. Not a summary somebody wrote once.
//
// 5. IT IS REACHABLE FOREVER. The footer link and the Profile row both
//    dispatch COOKIE_PANEL_EVENT, which opens this. Withdrawal has to be as
//    easy as consent, and a banner you can never get back is not that.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";
import { lockBodyScroll } from "@/lib/scroll-lock";
import {
  ALLOW_ALL,
  DENY_ALL,
  encodeCookieConsent,
  makeConsent,
  type CookieGrants,
} from "@/lib/cookies/consent";
import type { CookieCategory, CookieEntry } from "@/lib/cookies/manifest";
import {
  COOKIE_PANEL_EVENT,
  announceConsent,
  clientAllows,
  consentProofContext,
  dropAnalyticsId,
  purgeDenied,
  receiptIdForSave,
  writeConsentCookie,
} from "@/lib/cookies/client";
import { syncAdConsent } from "@/lib/cookies/ad-sdk";

interface ConsentPayload {
  needsChoice: boolean;
  grants: CookieGrants;
  optional: CookieCategory[];
  copy: Record<CookieCategory, { title: string; blurb: string; consequence: string }>;
  manifest: CookieEntry[];
}

type Choice = "accept-all" | "reject-all" | "custom";

export function CookieConsent() {
  const { t } = useI18n();
  const [data, setData] = useState<ConsentPayload | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [draft, setDraft] = useState<CookieGrants>(DENY_ALL);
  const [open, setOpen] = useState<CookieCategory | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const loaded = useRef(false);

  // The inventory and the current state, from the server. One fetch, on idle -
  // this must never be on the critical path of a cold open, and the deny
  // default is already in force while it is in flight.
  const load = useCallback(async () => {
    if (loaded.current) return data;
    try {
      const res = await fetch("/api/cookies/consent", { cache: "no-store" });
      if (!res.ok) return null;
      const d = (await res.json()) as ConsentPayload;
      loaded.current = true;
      setData(d);
      setDraft(d.grants ?? DENY_ALL);
      return d;
    } catch {
      // Offline. The banner stays down rather than rendering a panel with no
      // list in it - an empty cookie table is a worse disclosure than none.
      return null;
    }
  }, [data]);

  useEffect(() => {
    let alive = true;
    // NEVER ON THE CRITICAL PATH OF A COLD OPEN.
    //
    // The deny default is already in force from the first frame (the pre-paint
    // script in the layout has already decided whether any third-party script
    // loads), so nothing is gained by racing this fetch against first paint and
    // a slow connection has a search to run. It waits for idle, or 400ms.
    //
    // `needsChoice` is decided by the SERVER, from the same
    // `needsCookieChoice` the gates use, rather than re-derived here: the
    // policy version lives in one place and a second copy in the client bundle
    // is a second copy that can be stale by one deploy.
    // NOT ON THE POLICY PAGE. /cookies already carries the whole disclosure and
    // its own decision card (CookieGate, when the middleware sent them there),
    // so a bottom sheet asking the same question over the top of it is two
    // identical cards on one screen - and the one a person tapped would be
    // ambiguous in the recording. The page is the better surface; the banner
    // stands down for it.
    const onPolicyPage =
      typeof window !== "undefined" && window.location.pathname === "/cookies";

    const id = setTimeout(() => {
      if (onPolicyPage) return;
      void load().then((d) => {
        if (alive && d?.needsChoice) setShowBanner(true);
      });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [load]);

  // Reachable forever: the footer link and the Profile row dispatch this.
  useEffect(() => {
    const onOpen = () => {
      setFailed(null);
      setNote(null);
      void load().then((d) => {
        if (d) setDraft(d.grants ?? DENY_ALL);
        setShowPanel(true);
      });
    };
    window.addEventListener(COOKIE_PANEL_EVENT, onOpen);
    return () => window.removeEventListener(COOKIE_PANEL_EVENT, onOpen);
  }, [load]);

  // The PANEL is a real dialog and does lock scroll (it is a full sheet with
  // its own scroll area). The BANNER deliberately does not - see rule 3.
  useEffect(() => {
    if (!showPanel) return;
    return lockBodyScroll();
  }, [showPanel]);

  const save = useCallback(
    async (choice: Choice, grants: CookieGrants) => {
      setSaving(true);
      setFailed(null);
      setNote(null);

      // APPLY LOCALLY FIRST, THEN FILE IT.
      //
      // A traveller on hotel wifi who taps "Reject all" and watches the banner
      // sit there spinning will tap something else, and the something else is
      // usually "Accept all". So the cookie is written here, the purge runs
      // here, and the banner closes here - all before the request resolves. The
      // route then writes the identical cookie server-side and adds the ledger
      // row; if that fails, the note below says so, and the choice is still in
      // force because the cookie is what every gate reads.
      // Read BEFORE the new cookie lands: whether advertising was in force up
      // to this tap is what decides if a running SDK has to be got rid of.
      const wasMarketing = clientAllows("marketing");
      const consent = makeConsent(grants, choice, Date.now(), receiptIdForSave());
      writeConsentCookie(encodeCookieConsent(consent));
      purgeDenied(consent);
      if (!consent.grants.analytics) dropAnalyticsId();
      // THE PAGE FOLLOWS THE CHOICE, NOT THE NEXT PAGE LOAD. Granting loads
      // Google's SDK now (the landing pageview is the one that counts);
      // withdrawing asks for a reload, because nothing else removes a running
      // third-party script and its iframes - see lib/cookies/ad-sdk.ts.
      const pageAction = syncAdConsent(consent, wasMarketing);
      announceConsent(consent);
      setShowBanner(false);
      setShowPanel(false);

      try {
        const res = await fetch("/api/cookies/consent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ choice, grants, ...consentProofContext() }),
        });
        const d = (await res.json().catch(() => null)) as
          | { ok?: boolean; error?: string; note?: string; grants?: CookieGrants }
          | null;
        if (!res.ok || !d?.ok) {
          // The local cookie stands - it is what the gates read - so this is a
          // note about PROOF, not about whether the choice applied.
          setFailed(
            d?.error ??
              t("Your choice is active on this device, but we could not save it to your account. It will be saved next time you are online.")
          );
          return;
        }
        if (d.note) setNote(d.note);
        if (d.grants) setDraft(d.grants);
        setData((prev) => (prev ? { ...prev, grants: d.grants ?? grants, needsChoice: false } : prev));
      } catch {
        setFailed(
          t("Your choice is active on this device, but we could not save it to your account. It will be saved next time you are online.")
        );
      } finally {
        setSaving(false);
        // AFTER the request settles, never before: a reload mid-flight aborts
        // the ledger write, and a withdrawal is the one choice that most needs
        // its proof.
        if (pageAction === "reload") window.location.reload();
      }
    },
    [t]
  );

  if (!showBanner && !showPanel) return null;

  const copy = data?.copy;
  const optional = data?.optional ?? (["preferences", "analytics", "marketing"] as CookieCategory[]);
  const manifest = data?.manifest ?? [];

  // ---- the banner -----------------------------------------------------------

  // TWO LAYOUT DECISIONS THAT ARE NOT COSMETIC.
  //
  // z-index: `layer-coach` (900) - above the tab bar and the floating pills,
  // BELOW every dialog. It is not a modal and must never behave like one; in
  // particular the mandatory terms gate (layer-veil, 1400) has to cover it, so
  // a new user answers the thing that actually blocks the app first.
  //
  // bottom: `--stack-bottom-2`, the documented slot that clears the whole
  // bottom-right stack - tab bar, the live-status FAB, the upgrade pill. A
  // sheet pinned to `bottom-0` sat ON the tab bar and made the status panel's
  // expander chevron untappable, which scripts/mobile-check.mjs caught: a
  // consent banner that eats the app's own navigation is a banner people
  // dismiss to get their app back, and a dismissal under pressure is not a
  // choice. Hard-coding a rem here instead of taking the slot is how the three
  // elements below it ate each other's taps in the first place.
  const banner = showBanner && !showPanel && (
    <div
      className="layer-coach fixed inset-x-0 flex justify-center px-3"
      style={{ bottom: "var(--stack-bottom-2)" }}
      role="region"
      aria-label={t("Cookie choices")}
    >
      <div className="surface w-full max-w-[420px] rounded-blob border-2 border-line p-4 shadow-2xl">
        <div className="text-[14px] font-extrabold text-strong">🍪 {t("Your data, your call")}</div>
        <p className="mt-1 text-[12px] font-bold leading-snug text-soft">
          {t("Two essential cookies keep you signed in and remember this answer - the app does not work without them. Everything else - your theme and language, counting how the app is used, and the ads that pay for the free plan - only happens if you say yes.")}
        </p>

        {/* Rule 1: one row, two buttons, same weight. Nothing here may make one
            of them look like the answer we would prefer. */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => save("reject-all", DENY_ALL)}
            disabled={saving}
            className="btn rounded-2xl border-2 border-line bg-card py-3 text-[13px] font-extrabold text-strong disabled:opacity-60"
          >
            {t("Essential only")}
          </button>
          <button
            onClick={() => save("accept-all", ALLOW_ALL)}
            disabled={saving}
            className="btn rounded-2xl border-2 border-line bg-card py-3 text-[13px] font-extrabold text-strong disabled:opacity-60"
          >
            {t("Accept all")}
          </button>
        </div>

        <button
          onClick={() => {
            setDraft(data?.grants ?? DENY_ALL);
            setShowPanel(true);
          }}
          className="mt-2 w-full rounded-2xl py-2 text-[12px] font-extrabold text-brandblue underline"
        >
          {t("Choose what you allow")}
        </button>

        <div className="mt-1 flex justify-center gap-3 text-[11px] font-bold text-faint">
          <a href="/cookies" className="underline hover:text-soft">
            {t("Cookie Policy")}
          </a>
          <a href="/privacy" className="underline hover:text-soft">
            {t("Privacy Policy")}
          </a>
        </div>
      </div>
    </div>
  );

  // ---- the preferences panel ------------------------------------------------

  // The PANEL is a real dialog and takes the dialog layer (1200) - it owns the
  // screen while it is open. Still below the terms gate at 1400, deliberately:
  // nothing may cover the acceptance that blocks the app.
  const panel = showPanel && (
    <div
      className="layer-overlay fixed inset-0 flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t("Cookie preferences")}
    >
      <div className="surface flex max-h-[88dvh] w-full max-w-[460px] flex-col rounded-blob p-4 pb-safe shadow-2xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-[16px] font-extrabold leading-tight text-strong">
              🍪 {t("Cookie preferences")}
            </h2>
            <p className="mt-0.5 text-[11px] font-bold text-soft">
              {t("Switch any of these off at any time. Off means off - what is already stored on this device is deleted when you save.")}
            </p>
          </div>
          {/* The panel MAY be closed without deciding when it was opened from
              the footer or Profile - there is already a recorded choice behind
              it and closing changes nothing. When it was opened from the banner
              there is no recorded choice yet, so closing would be that fourth
              unrecorded answer; the button goes back to the banner instead. */}
          <button
            onClick={() => {
              setShowPanel(false);
              if (data?.needsChoice) setShowBanner(true);
            }}
            aria-label={t("Close")}
            className="btn shrink-0 rounded-full border border-line px-2.5 py-1 text-[13px] font-extrabold text-soft"
          >
            ✕
          </button>
        </div>

        <div className="mt-3 flex-1 space-y-2 overflow-y-auto">
          {/* Necessary, shown and explained but not togglable - see the
              manifest's note on why modelling it as a switch would be a lie. */}
          <CategoryCard
            title={copy?.necessary.title ?? "Strictly necessary"}
            blurb={copy?.necessary.blurb ?? ""}
            consequence={copy?.necessary.consequence ?? ""}
            entries={manifest.filter((c) => c.category === "necessary")}
            expanded={open === "necessary"}
            onToggleExpand={() => setOpen(open === "necessary" ? null : "necessary")}
            locked
            on
            onFlip={() => {}}
            t={t}
          />
          {optional.map((cat) => (
            <CategoryCard
              key={cat}
              title={copy?.[cat]?.title ?? cat}
              blurb={copy?.[cat]?.blurb ?? ""}
              consequence={copy?.[cat]?.consequence ?? ""}
              entries={manifest.filter((c) => c.category === cat)}
              expanded={open === cat}
              onToggleExpand={() => setOpen(open === cat ? null : cat)}
              on={draft[cat as keyof CookieGrants] === true}
              onFlip={() =>
                setDraft((d) => ({ ...d, [cat]: !d[cat as keyof CookieGrants] }))
              }
              t={t}
            />
          ))}

          {failed && (
            <p className="rounded-2xl bg-warn-soft p-2.5 text-[11px] font-bold leading-snug text-warn">
              {failed}
            </p>
          )}
          {note && (
            <p className="rounded-2xl bg-warn-soft p-2.5 text-[11px] font-bold leading-snug text-warn">
              {note}
            </p>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => save("reject-all", DENY_ALL)}
            disabled={saving}
            className="btn rounded-2xl border-2 border-line bg-card py-3 text-[13px] font-extrabold text-strong disabled:opacity-60"
          >
            {t("Essential only")}
          </button>
          <button
            onClick={() => save("accept-all", ALLOW_ALL)}
            disabled={saving}
            className="btn rounded-2xl border-2 border-line bg-card py-3 text-[13px] font-extrabold text-strong disabled:opacity-60"
          >
            {t("Accept all")}
          </button>
        </div>
        <button
          onClick={() => save("custom", draft)}
          disabled={saving}
          className="btn btn-primary mt-2 w-full rounded-2xl py-3 text-[13px] font-extrabold disabled:opacity-60"
        >
          {saving ? t("Saving...") : t("Save my choices")}
        </button>
        <a
          href="/cookies"
          className="mt-2 block text-center text-[11px] font-bold text-faint underline hover:text-soft"
        >
          {t("Read the full Cookie Policy")}
        </a>
      </div>
    </div>
  );

  const tree = (
    <>
      {banner}
      {panel}
    </>
  );
  // Portalled for the reason every overlay here is: an ancestor with a
  // backdrop-filter or transform becomes the containing block for `fixed` and
  // pins the sheet inside a scrolling panel.
  return typeof document === "undefined" ? tree : createPortal(tree, document.body);
}

// ---- one category row -------------------------------------------------------

function CategoryCard({
  title,
  blurb,
  consequence,
  entries,
  expanded,
  onToggleExpand,
  on,
  locked,
  onFlip,
  t,
}: {
  title: string;
  blurb: string;
  consequence: string;
  entries: CookieEntry[];
  expanded: boolean;
  onToggleExpand: () => void;
  on: boolean;
  locked?: boolean;
  onFlip: () => void;
  t: (s: string) => string;
}) {
  return (
    <div className="rounded-2xl bg-card2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-[12.5px] font-extrabold text-strong">{t(title)}</div>
        {locked ? (
          <span className="shrink-0 rounded-full bg-brandgreen-soft px-3 py-1 text-[11px] font-extrabold text-brandgreen">
            {t("Always on")}
          </span>
        ) : (
          <button
            onClick={onFlip}
            role="switch"
            aria-checked={on}
            aria-label={t(title)}
            className={`btn btn-sm shrink-0 rounded-full px-3 py-1 text-[11px] font-extrabold ${
              on ? "bg-savings-soft text-savings" : "bg-card text-faint"
            }`}
          >
            {on ? t("On") : t("Off")}
          </button>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-soft">{t(blurb)}</p>
      {consequence && (
        <p className="mt-1 text-[10.5px] font-bold leading-snug text-faint">{t(consequence)}</p>
      )}

      {entries.length > 0 && (
        <>
          <button
            onClick={onToggleExpand}
            aria-expanded={expanded}
            className="mt-1.5 text-[11px] font-extrabold text-brandblue underline"
          >
            {expanded
              ? t("Hide what is stored")
              : `${t("Show what is stored")} (${entries.length})`}
          </button>
          {expanded && (
            <ul className="mt-1.5 space-y-1.5">
              {entries.map((e) => (
                <li key={`${e.medium}:${e.name}`} className="rounded-xl bg-card p-2">
                  <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    {/* The literal key, never translated - it is what a person
                        would look for in their own browser's storage panel. */}
                    <code className="break-all font-accent text-[10.5px] font-bold text-strong">
                      {e.name}
                    </code>
                    <span className="text-[9.5px] font-bold uppercase tracking-wide text-faint">
                      {e.medium === "cookie"
                        ? t("cookie")
                        : e.medium === "localStorage"
                          ? t("local storage")
                          : t("session storage")}
                    </span>
                    {e.party !== "first" && (
                      <span className="rounded-full bg-warn-soft px-1.5 py-0.5 text-[9.5px] font-extrabold text-warn">
                        {e.party}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10.5px] leading-snug text-soft">{t(e.purpose)}</p>
                  <p className="mt-0.5 text-[10px] font-bold text-faint">
                    {t("Kept")}: {t(e.duration)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
