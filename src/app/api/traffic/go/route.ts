// THE EXIT TO A LINK PARTNER. A visitor tapped a labelled sponsored link; this
// logs that and sends them on.
//
// EVERY PART OF THE DESTINATION IS CHOSEN BY THE OWNER OR BY A VOCABULARY.
//   - the host and path come from the partner's template in the Key Vault;
//   - the search term is picked by INDEX from the terms this app generated for
//     that market and category - the URL carries `i=1`, never the words, so
//     there is no free text for anybody to inject into a partner URL;
//   - the sub-id is rebuilt here from enum codes and the session hash.
// That is what keeps this from being an open redirect: there is no parameter a
// caller can set that changes where the visitor ends up.
//
// No consent, no exit. The link is only rendered under advertising consent, so
// a request without it did not come from the page - it goes to the cookie
// policy rather than to a partner.

import { NextResponse } from "next/server";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { marketingAllowed } from "@/lib/cookies/server";
import { getTrafficConfig } from "@/lib/traffic/config";
import { buildDestination, partnerFor } from "@/lib/traffic/partners";
import { shapeTrafficEvent, writeTrafficEvent } from "@/lib/traffic/log";
import { linkTermsFor } from "@/lib/traffic/targeting";
import { categoryOf, marketOf } from "@/lib/traffic/subid";

export const dynamic = "force-dynamic";

const NOINDEX = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };

function home(req: Request, path: string) {
  return NextResponse.redirect(new URL(path, req.url), { status: 303, headers: NOINDEX });
}

export async function GET(req: Request) {
  const limit = await rateLimit("traffic-go", clientIp(req), 30, 60).catch(() => ({ ok: true, retryAfter: 0 }));
  if (!limit.ok) return home(req, "/guides");
  if (!marketingAllowed()) return home(req, "/cookies");

  const config = await getTrafficConfig();
  if (config.mode === "off") return home(req, "/guides");

  const url = new URL(req.url);
  const market = marketOf(url.searchParams.get("m") ?? "");
  const category = categoryOf(url.searchParams.get("c") ?? "");
  const partner = partnerFor(config.partners, market, "link");
  const terms = linkTermsFor(market, category);
  const index = Number(url.searchParams.get("i") ?? "0");
  const term = Number.isInteger(index) && index >= 0 && index < terms.length ? terms[index] : null;
  if (!partner || !term) return home(req, "/guides");

  const shaped = shapeTrafficEvent(
    {
      kind: "link_click",
      placement: url.searchParams.get("p"),
      market,
      category,
      session: url.searchParams.get("s"),
      partner: partner.id,
    },
    [partner.id]
  );
  if ("refused" in shaped) return home(req, "/guides");

  const destination = buildDestination(partner, { q: term, subId: shaped.row.sub_id });
  if (!destination) return home(req, "/guides");

  // Logged before the redirect and not awaited past a short bound: the visitor
  // asked to go somewhere, and a slow database must not hold them here.
  if (config.mode === "live") {
    await Promise.race([writeTrafficEvent(shaped.row), new Promise((r) => setTimeout(r, 800))]);
  }
  return NextResponse.redirect(destination, { status: 302, headers: NOINDEX });
}
