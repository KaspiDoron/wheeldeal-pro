"use client";

// ONE MONETISED PLACEMENT ON A CONTENT PAGE.
//
// Renders NOTHING unless every one of these is true, checked in this order:
//   1. the visitor granted advertising cookies (and sends no Global Privacy
//      Control signal) - before that, not even the configuration is fetched;
//   2. the owner switched the module on (TRAFFIC_MODE test | live);
//   3. a partner is configured for this market;
//   4. for Google's unit: the visitor is somewhere Google will serve - outside
//      the EEA, the UK and Switzerland, or a certified CMP is installed.
// "Nothing" means no frame, no label, no reserved space and no request. An
// empty sponsored frame is itself a rejection signal in an ads review (W-4).
//
// WHAT THIS DOES NOT DO, BECAUSE THE ACCOUNT IS NOT ALLOWED TO.
// Since August 2025 Google treats these as Restricted Access Features: more
// than one related-search unit on a page, supplying our own `terms`, custom
// sizing of the unit, and tracking clicks inside it. So there is exactly one
// unit, Google writes the terms from the article, the unit is left as Google
// styles it, and the only things logged are first-party facts - that the unit
// loaded here, and later that a visitor arrived on our own /search.

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { COOKIE_CONSENT_EVENT, clientAllowsSponsoredSearch } from "@/lib/cookies/client";
import { loadTrafficConfig, requestSearchAds, trackTraffic, trafficSession } from "@/lib/traffic/client";
import { PUBLIC_TRAFFIC_OFF, type PublicTrafficConfig } from "@/lib/traffic/public";
import { browserTimeZone, consentRegion, searchAdsPermitted } from "@/lib/traffic/region";
import { linkTermsFor } from "@/lib/traffic/targeting";
import type { Placement, SubIdCategory, SubIdMarket } from "@/lib/traffic/subid";

/** Tracking parameters that may ride on a content URL. Google is told to
 *  ignore them so the same article is one page to its crawler, not many. */
const IGNORED_PARAMS = "utm_source,utm_medium,utm_campaign,utm_content,utm_term,gclid,fbclid,msclkid,ref,rac";

export function TrafficPlacement({
  placement,
  market,
  category,
}: {
  placement: Placement;
  market: SubIdMarket;
  category: SubIdCategory;
}) {
  const { t } = useI18n();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [config, setConfig] = useState<PublicTrafficConfig>(PUBLIC_TRAFFIC_OFF);
  const [filled, setFilled] = useState(false);
  const [session, setSession] = useState<string | null>(null);
  const requested = useRef(false);
  // A stable, selector-safe id: Google finds the container by id.
  const containerId = `wd-rs-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  useEffect(() => {
    const read = () => setAllowed(clientAllowsSponsoredSearch());
    read();
    window.addEventListener(COOKIE_CONSENT_EVENT, read);
    return () => window.removeEventListener(COOKIE_CONSENT_EVENT, read);
  }, []);

  useEffect(() => {
    if (allowed !== true) return;
    let alive = true;
    // The URL's `rac` goes to the SERVER to be matched against the creatives the
    // owner declared; what comes back in `config.rac` is what Google is told.
    const claimed = new URLSearchParams(window.location.search).get("rac");
    void loadTrafficConfig(market, claimed).then((c) => {
      if (!alive) return;
      setConfig(c);
      setSession(trafficSession());
    });
    return () => {
      alive = false;
    };
  }, [allowed, market]);

  const region = consentRegion({ timeZone: browserTimeZone() });
  const useAfs = allowed === true && config.mode !== "off" && config.afs !== null && searchAdsPermitted(region, config.cmp);
  const useLink = allowed === true && config.mode !== "off" && !useAfs && config.link !== null;

  useEffect(() => {
    if (!useAfs || !config.afs || requested.current) return;
    requested.current = true;
    const afs = config.afs;
    const lang = (document.documentElement.getAttribute("lang") || "en").slice(0, 2);
    // A PAID ARRIVAL'S AD TEXT, IF - AND ONLY IF - THE OWNER DECLARED IT. Google
    // requires the creative verbatim for traffic the owner buys (mandatory since
    // 2025-11-01) and punishes an inaccurate one. `config.rac` is the server's
    // answer after matching the URL's claim against TRAFFIC_AD_CREATIVES: the
    // owner's own string, or null. Reading `?rac=` here directly would let any
    // stranger's link put words in this site's mouth.
    const rac = config.rac ?? undefined;

    const made = requestSearchAds(
      "relatedsearch",
      {
        pubId: afs.pubId,
        styleId: afs.styleId,
        relatedSearchTargeting: "content",
        resultsPageBaseUrl: `${window.location.origin}/search?m=${market}&c=${category}`,
        resultsPageQueryParam: "q",
        hl: lang,
        channel: afs.channel ?? undefined,
        ignoredPageParams: IGNORED_PARAMS,
        referrerAdCreative: rac,
        adtest: config.mode === "test" ? "on" : undefined,
      },
      {
        container: containerId,
        // Five is the most a non-RAF account is served; fewer than three and
        // Google shows none at all.
        relatedSearches: 5,
        adLoadedCallback: (_name: string, loaded: boolean) => {
          setFilled(loaded === true);
          trackTraffic({ kind: loaded ? "unit_loaded" : "unit_empty", placement, market, category, partner: afs.id });
        },
      }
    );
    // Another unit already made this document's one request (a soft
    // navigation). Standing down is the compliant answer.
    if (!made) requested.current = false;
  }, [useAfs, config, containerId, market, category, placement]);

  if (useAfs) {
    return (
      <aside className="mt-8" aria-label={t("Related searches")} data-traffic-placement={placement}>
        {filled && (
          <h2 className="text-[15px] font-extrabold text-strong">
            {t("Related searches")}
            {config.mode === "test" && (
              <span className="ml-2 rounded bg-warn-soft px-1.5 py-0.5 text-[9px] font-bold uppercase text-warn">
                {t("Test ads - no revenue")}
              </span>
            )}
          </h2>
        )}
        {/* Always in the DOM so Google has somewhere to render; empty it has no
            height, so an unfilled unit leaves no frame behind. */}
        <div id={containerId} className={filled ? "mt-2" : undefined} />
        {filled && (
          <p className="mt-2 text-[10.5px] leading-relaxed text-faint">
            {t("Search suggestions by Google. The results page shows ads, and WheelDeal may earn money from them.")}
          </p>
        )}
      </aside>
    );
  }

  if (useLink && session) {
    const terms = linkTermsFor(market, category);
    return (
      <aside className="mt-8 overflow-hidden rounded-blob border-2 border-line" data-traffic-placement={placement}>
        <div className="bg-card2 px-3 py-1 text-[9px] font-bold uppercase tracking-wide text-faint">{t("Sponsored")}</div>
        <ul className="divide-y divide-line">
          {terms.map((term, i) => (
            <li key={term}>
              {/* A plain anchor the visitor chose to tap: no auto-redirect, no
                  new-window trick. `sponsored nofollow` tells search engines
                  the truth about the link. */}
              <a
                href={`/api/traffic/go?p=${placement}&m=${market}&c=${category}&i=${i}&s=${session}`}
                rel="sponsored nofollow noopener"
                className="block px-3 py-2.5 text-[13.5px] font-bold text-brandblue"
              >
                {term}
              </a>
            </li>
          ))}
        </ul>
        <p className="px-3 pb-2 pt-1 text-[10.5px] leading-relaxed text-faint">
          {t("These links open a search partner's page. WheelDeal may earn a commission.")}
        </p>
      </aside>
    );
  }

  return null;
}
