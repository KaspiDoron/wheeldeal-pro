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

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const headers = { "Cache-Control": "private, max-age=60" };
  const params = new URL(req.url).searchParams;
  const config = await getTrafficConfig().catch(() => null);
  if (!config) return NextResponse.json(PUBLIC_TRAFFIC_OFF, { headers });
  // Consent decides what MONETISES (publisher ids, partners, the ad creative).
  // The owner's placement switches and the funnel guide are returned either
  // way - see toPublicTraffic. The landing URL's `rac` is CHECKED here, not
  // trusted there: the answer is the owner's declared creative or null.
  return NextResponse.json(
    toPublicTraffic(config, { market: params.get("m") ?? "", category: params.get("c") ?? "", rac: params.get("rac"), consented: sponsoredSearchAllowed() }),
    { headers }
  );
}
