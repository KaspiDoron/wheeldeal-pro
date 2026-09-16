"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { loadPublicConfig } from "@/lib/client/public-config";
import { COOKIE_CONSENT_EVENT, clientAllows } from "@/lib/cookies/client";

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

// Google AdSense slot. Renders ONLY for free-plan users - paid plans are 100%
// ad-free. The slot is ALWAYS visible on the free tier so the layout shows
// where ads live: before Google's review approves the site (or when no client
// id is set yet) it renders as a labelled placeholder, and real ads take over
// automatically once AdSense starts serving.
export function AdBanner({
  plan,
  slot,
}: {
  plan: string | undefined;
  /** Override the configured ad unit. Normally omitted - the unit id comes
   *  from the Key Vault so it can change without a redeploy. */
  slot?: string;
}) {
  const { t } = useI18n();
  const [client, setClient] = useState<string | null>(null);
  const [unit, setUnit] = useState<string | null>(null);
  const pushed = useRef(false);

  // ADVERTISING CONSENT - THE SECOND OF TWO GATES, NOT THE ONLY ONE.
  //
  // The gate that matters is in the root layout: without consent Google's SDK
  // is never fetched, so `window.adsbygoogle` does not exist and nothing here
  // could fill a slot even if it tried. This one exists because a slot that
  // renders its frame and its "Sponsored" strip over an SDK that will never
  // arrive is the permanently-empty ad frame W-4 removed - and because the
  // choice can change mid-session, without a reload, from the footer panel.
  //
  // Starts as `null` (unknown) rather than `false`: rendering "no ads" for one
  // frame and then popping a 100px slot in is a layout shift on the funnel.
  const [adsAllowed, setAdsAllowed] = useState<boolean | null>(null);

  const free = !plan || plan === "free";

  useEffect(() => {
    const read = () => setAdsAllowed(clientAllows("marketing"));
    read();
    // The panel dispatches this when a choice is saved, so turning advertising
    // off makes the slot disappear immediately instead of on the next reload.
    window.addEventListener(COOKIE_CONSENT_EVENT, read);
    return () => window.removeEventListener(COOKIE_CONSENT_EVENT, read);
  }, []);

  useEffect(() => {
    if (!free) return;
    let alive = true;
    // Shared single-flight: three components used to fetch this force-dynamic
    // endpoint independently on every cold load (see lib/client/public-config).
    void loadPublicConfig().then((d) => {
      if (!alive) return;
      setClient(d.adsenseClient);
      setUnit(d.adsenseSlot);
    });
    return () => {
      alive = false;
    };
  }, [free]);

  // AN AD UNIT WITH NO UNIT ID CANNOT BE FILLED.
  //
  // `data-ad-slot` was rendered only when a caller passed one, and none of the
  // three call sites ever did - so every banner reserved its space, showed its
  // placeholder, and Google had no unit to serve into. The surface looked
  // finished and earned nothing. The id is a Key Vault value, so the owner
  // creates one display unit in the AdSense console, pastes it in
  // Admin -> Keys, and the banners start filling with no redeploy.
  const adSlot = slot ?? unit;

  // The SDK is loaded ONCE, site-wide, by the root layout - and only when the
  // traveller has allowed advertising cookies (see adConsentScript there). This
  // component used to inject a second copy of the same script; loading the
  // AdSense SDK twice is a policy violation and makes slots fail to fill. All
  // that is left here is claiming the slot.
  useEffect(() => {
    if (adsAllowed !== true) return;
    if (!client || !adSlot || pushed.current) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      pushed.current = true;
    } catch {
      /* ad blocked - fine */
    }
  }, [client, adSlot, adsAllowed]);

  if (!free) return null;

  // No advertising consent, or not known yet: no frame, no reserved space, no
  // request. The layout simply does not contain an ad.
  if (adsAllowed !== true) return null;

  // AN EMPTY AD FRAME IS ITSELF A REJECTION SIGNAL (W-4).
  //
  // This reserved 100px, drew a "Sponsored" strip and an "Ad space" panel
  // whether or not there was anything to serve - so a reviewer loading the app
  // saw a labelled, permanently unfilled slot, which reads as either a broken
  // integration or a page built around ads rather than content. Both are things
  // the policy review looks for.
  //
  // Nothing renders until there is a real client AND a real unit to fill. When
  // there is, the slot appears; when there is not, the layout simply does not
  // contain it.
  if (!client || !adSlot) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-blob border-2 border-line">
      <div className="bg-card2 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-faint">
        {t("Sponsored")}
      </div>
      <div className="relative" style={{ minHeight: 100 }}>
        {client && adSlot && (
          <ins
            className="adsbygoogle relative block"
            style={{ display: "block", minHeight: 100 }}
            data-ad-client={client}
            data-ad-slot={adSlot}
            data-ad-format="auto"
            data-full-width-responsive="true"
          />
        )}
      </div>
    </div>
  );
}
