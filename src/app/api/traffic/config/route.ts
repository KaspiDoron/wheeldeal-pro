// WHAT THE BROWSER NEEDS TO RENDER A PLACEMENT - and nothing else.
//
// Its own small endpoint rather than another field on /api/config/public: that
// one awaits ten unrelated Key Vault reads, and this is fetched from static
// content pages where the visitor came to read an article. It is also only ever
// requested AFTER advertising consent exists (the unit does not mount without
// it), so a visitor who said no never causes this read at all.
//
// A link partner's URL template is deliberately absent. The browser learns that
// a link partner exists and reaches it through /api/traffic/go; the template
// stays server-side with the rest of the owner's commercial terms.

import { NextResponse } from "next/server";
import { sponsoredSearchAllowed } from "@/lib/cookies/server";
import { PUBLIC_TRAFFIC_OFF, getTrafficConfig, toPublicTraffic } from "@/lib/traffic/config";
import { marketOf } from "@/lib/traffic/subid";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const headers = { "Cache-Control": "private, max-age=60" };
  // No consent on this request, no configuration: the publisher and style ids
  // are not secrets, but there is no reason to hand them to a page that is not
  // allowed to use them.
  if (!sponsoredSearchAllowed()) return NextResponse.json(PUBLIC_TRAFFIC_OFF, { headers });
  const params = new URL(req.url).searchParams;
  const market = marketOf(params.get("m") ?? "");
  const config = await getTrafficConfig().catch(() => null);
  // The landing URL's `rac` is CHECKED here, not trusted there: the answer is
  // the owner's own declared creative or null, never the text the caller sent.
  return NextResponse.json(config ? toPublicTraffic(config, market, params.get("rac")) : PUBLIC_TRAFFIC_OFF, { headers });
}
