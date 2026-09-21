"use client";

// THE WAY IN. A traveller at a dead end - no shops near their stay, a hunt that
// went quiet - is offered something genuinely useful: the guide that says what
// locals actually pay where they are, and a search of all the guides.
//
// THIS IS THE FUNNEL, AND IT IS DELIBERATELY NOT A REDIRECT. "Route the search
// traffic to the broker" sounds like sending the visitor's query onward. Google
// forbids exactly that: search ads may answer only a query the visitor typed
// into a search box, or a term Google itself generated from real content. So
// the route is  dead end -> ARTICLE -> Google's unit on that article -> /search
// -> ads, and every step is a tap the visitor chose. The article is the part
// that makes the rest legitimate, which is why this card leads with it.
//
// WHO SEES WHAT.
//   everyone           the guide link and the guides search box. They are this
//                      site's own content: no consent is needed to link to it.
//   consenting + free  also a link partner's labelled "Sponsored" rows.
//   paid plans         never any sponsored row - paid is ad-free, full stop.
// Google's own unit is never rendered here (`linkOnly`): an app screen is not a
// content page. The owner can switch each placement off in TRAFFIC_SETTINGS.

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { loadTrafficConfig } from "@/lib/traffic/client";
import { PUBLIC_TRAFFIC_OFF, type PublicTrafficConfig } from "@/lib/traffic/public";
import { marketFromText } from "@/lib/traffic/targeting";
import { TrafficPlacement } from "./TrafficPlacement";

export function FunnelCard({
  placement,
  region,
  plan,
}: {
  placement: "no-coverage" | "hunt-ended";
  /** The place label the traveller searched from, e.g. "Chiang Mai, Thailand". */
  region: string;
  plan: string | undefined;
}) {
  const { t } = useI18n();
  const [config, setConfig] = useState<PublicTrafficConfig | null>(null);
  const market = marketFromText(region);
  const free = !plan || plan === "free";

  useEffect(() => {
    let alive = true;
    void loadTrafficConfig(market, { category: "scooter", evenWithoutConsent: true }).then((c) => alive && setConfig(c));
    return () => {
      alive = false;
    };
  }, [market]);

  // Unknown yet, or the owner switched this placement off: nothing at all. It
  // must not flash in and out of a screen where somebody is reading a result.
  if (!config || (config ?? PUBLIC_TRAFFIC_OFF).settings.placements[placement] !== true) return null;

  return (
    <section className="mt-4 rounded-blob surface p-4 text-left" data-funnel-card={placement}>
      <h3 className="text-[14px] font-extrabold text-strong">{t("Know the real price before you rent")}</h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-soft">
        {t("Our guides show what locals actually pay, so you can spot a tourist price.")}
      </p>
      {/* A plain anchor: the guide makes its own search-ads request, and Google
          allows one per document - so the way in is a real page load. */}
      <a
        href={`/guides/${config.funnelGuide.slug}`}
        className="mt-3 block rounded-2xl border-2 border-line bg-card p-3 text-[13px] font-extrabold text-brandblue transition hover:border-brandblue/50"
      >
        {config.funnelGuide.title} →
      </a>
      {/* The box starts empty and submits what the traveller TYPES - the only
          kind of query a results page may show ads beside. */}
      <form action="/search" method="get" role="search" className="mt-2 flex gap-2">
        <input type="hidden" name="m" value={market} />
        <input type="hidden" name="c" value="scooter" />
        <input
          type="search"
          name="q"
          required
          maxLength={120}
          autoComplete="off"
          aria-label={t("Search the guides")}
          placeholder={t("Search the guides")}
          className="min-w-0 flex-1 rounded-2xl border-2 border-line bg-card px-3 py-2.5 text-[16px] text-strong"
        />
        <button type="submit" className="btn btn-primary rounded-2xl px-4 py-2.5 text-[13px]">
          {t("Search")}
        </button>
      </form>
      {free && <TrafficPlacement placement={placement} market={market} category="scooter" linkOnly />}
    </section>
  );
}
