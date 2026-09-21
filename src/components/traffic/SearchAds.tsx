"use client";

// THE AD SLOTS ON /search. Same four gates as TrafficPlacement, plus the one
// that belongs to a results page: NO RESULTS, NO ADS.
//
// Google's search-ads policy allows ads only beside real results for a query
// the visitor made, and never more ads than results. `resultCount` comes from
// the server's genuine search of the guides; it caps `number`, and at zero the
// request is not made at all. One ad block and one related-search unit - a
// non-RAF account is served one related-search unit per page, and the mobile
// ceiling is two ad units.

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { COOKIE_CONSENT_EVENT, clientAllowsSponsoredSearch } from "@/lib/cookies/client";
import { loadTrafficConfig, requestSearchAds, trackTraffic } from "@/lib/traffic/client";
import { PUBLIC_TRAFFIC_OFF, type PublicTrafficConfig } from "@/lib/traffic/public";
import { browserTimeZone, consentRegion, searchAdsPermitted } from "@/lib/traffic/region";
import type { SubIdCategory, SubIdMarket } from "@/lib/traffic/subid";

const ADS_CONTAINER = "wd-afs-results";
const RS_CONTAINER = "wd-rs-results";

export function SearchAds({
  query,
  resultCount,
  market,
  category,
  fromUnit,
}: {
  query: string;
  resultCount: number;
  market: SubIdMarket;
  category: SubIdCategory;
  /** The visitor arrived by tapping a Google related-search term. */
  fromUnit: boolean;
}) {
  const { t } = useI18n();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [config, setConfig] = useState<PublicTrafficConfig>(PUBLIC_TRAFFIC_OFF);
  const [adsFilled, setAdsFilled] = useState(false);
  const requested = useRef(false);
  const viewed = useRef(false);

  useEffect(() => {
    const read = () => setAllowed(clientAllowsSponsoredSearch());
    read();
    window.addEventListener(COOKIE_CONSENT_EVENT, read);
    return () => window.removeEventListener(COOKIE_CONSENT_EVENT, read);
  }, []);

  useEffect(() => {
    if (allowed !== true) return;
    let alive = true;
    void loadTrafficConfig(market, { category }).then((c) => alive && setConfig(c));
    return () => {
      alive = false;
    };
  }, [allowed, market, category]);

  const region = consentRegion({ timeZone: browserTimeZone() });
  const afs =
    allowed === true && config.mode !== "off" && config.settings.placements["search-results"] === true && searchAdsPermitted(region, config.cmp)
      ? config.afs
      : null;

  // The first-party record that a search happened here. The TERM is sent only
  // when Google issued it; the server drops a typed query regardless.
  useEffect(() => {
    if (!afs || viewed.current || !query) return;
    viewed.current = true;
    trackTraffic({
      kind: "serp_view",
      placement: "search-results",
      market,
      category,
      partner: afs.id,
      term: fromUnit ? query : undefined,
      termFromUnit: fromUnit,
    });
  }, [afs, query, market, category, fromUnit]);

  useEffect(() => {
    if (!afs || requested.current || !query || resultCount < 1) return;
    requested.current = true;
    const lang = (document.documentElement.getAttribute("lang") || "en").slice(0, 2);
    // Never more ads than results (Google's rule), and never more than the
    // owner's `maxAds`, which the server already clamped to 1-3.
    const ads = Math.min(config.settings.maxAds, resultCount);
    const made = requestSearchAds(
      "ads",
      {
        pubId: afs.pubId,
        styleId: afs.styleId,
        // Google: "the value of the query parameter should be unencoded" - and
        // it must be exactly the term the visitor clicked or typed.
        query,
        relatedSearchTargeting: "query",
        resultsPageBaseUrl: `${window.location.origin}/search?m=${market}&c=${category}`,
        resultsPageQueryParam: "q",
        hl: lang,
        channel: afs.channel ?? undefined,
        adtest: config.mode === "test" ? "on" : undefined,
      },
      {
        container: ADS_CONTAINER,
        number: ads,
        // Required by Google when the block sits above the results.
        maxTop: ads,
        adLoadedCallback: (_name: string, loaded: boolean) => setAdsFilled(loaded === true),
      },
      { container: RS_CONTAINER, relatedSearches: config.settings.relatedSearches }
    );
    if (!made) requested.current = false;
  }, [afs, query, resultCount, market, category, config.mode, config.settings]);

  if (!afs || resultCount < 1) return null;

  return (
    <section className="mt-4" aria-label={t("Sponsored")}>
      {adsFilled && (
        <p className="text-[9px] font-bold uppercase tracking-wide text-faint">
          {t("Sponsored")}
          {config.mode === "test" && <span className="ml-2 text-warn">{t("Test ads - no revenue")}</span>}
        </p>
      )}
      <div id={ADS_CONTAINER} />
    </section>
  );
}

/** Where the results page's one related-search unit renders - placed by the
 *  page BELOW the organic results, requested by <SearchAds> above them. */
export function SearchRelatedSlot() {
  return <div id={RS_CONTAINER} className="mt-6" />;
}
