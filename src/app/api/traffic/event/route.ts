// THE TRAFFIC BEACON. Open to signed-out visitors, because they are who it is
// about - and gated on ADVERTISING consent, on the server, on this request.
//
// It is not an extension of /api/analytics/collect, on purpose. That beacon is
// the first-party product record: it needs a session, it is governed by the
// ANALYTICS purpose, and a test pins that it refuses a row without an email.
// This one records that a monetised unit was shown or followed, it is governed
// by the ADVERTISING purpose, and it must never hold an email. Different
// purpose, different consent, different table - folding them together would
// mean one of the two consents silently covering the other's data.
//
// A refusal is a 200 with `recorded: false`, never an error. The caller is a
// fire-and-forget beacon on a content page; nothing a visitor sees depends on
// it, and an error status would only teach somebody to retry.

import { NextResponse } from "next/server";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { marketingAllowed } from "@/lib/cookies/server";
import { getTrafficConfig } from "@/lib/traffic/config";
import { shapeTrafficEvent, writeTrafficEvent } from "@/lib/traffic/log";

export const dynamic = "force-dynamic";

const skipped = (reason: string) => NextResponse.json({ ok: true, recorded: false, reason });

export async function POST(req: Request) {
  const limit = await rateLimit("traffic-event", clientIp(req), 60, 60).catch(() => ({ ok: true, retryAfter: 0 }));
  if (!limit.ok) return skipped("rate-limited");

  // THE SERVER ASKS AGAIN. The unit only renders with consent, so an honest
  // browser never gets here without it - but this is a public route, and the
  // cookie plus the Sec-GPC header on THIS request are the authority, not the
  // fact that somebody called it.
  if (!marketingAllowed()) return skipped("no-consent");

  const config = await getTrafficConfig();
  // `test` serves Google's no-revenue test ads to an owner checking a layout.
  // Logging those would put clicks in the table that no partner report will
  // ever match, and the reconciliation would flag a gap that is not real.
  if (config.mode !== "live") return skipped("not-live");

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return skipped("malformed");

  const shaped = shapeTrafficEvent(
    {
      kind: body.kind,
      placement: body.placement,
      market: body.market,
      category: body.category,
      session: body.session,
      partner: body.partner,
      term: body.term,
      termFromUnit: body.termFromUnit === true,
    },
    config.partners.filter((p) => p.enabled).map((p) => p.id)
  );
  if ("refused" in shaped) return skipped(shaped.refused);

  const recorded = await writeTrafficEvent(shaped.row);
  return NextResponse.json({ ok: true, recorded });
}
