// THE BEACON. Consent first, then validation, then the write.
//
// This is the only endpoint in the app whose entire job is to record what a
// person did, so it is the one where the gate has to be unmissable. Three
// refusals sit in front of the write, in this order, and each returns a
// DIFFERENT, honest shape - `{ ok: true, stored: false, reason }` rather than a
// 403 - because the browser cannot act on any of them and a beacon that 4xxs on
// the normal, expected case (no consent) fills a console with red for a
// situation that is working exactly as designed.
//
//   1. no session         -> nothing is written. See collectEvents on why an
//                            anonymous behavioural row is not a thing this
//                            product stores.
//   2. no analytics consent -> nothing is written. Both gates: the durable
//                            ledger row AND the cookie on this device.
//   3. unknown event name -> that row is dropped, the rest are kept, and the
//                            count of dropped rows comes back.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { analyticsAllowed, readAnalyticsId } from "@/lib/cookies/server";
import {
  MAX_EVENTS_PER_BATCH,
  collectEvents,
  type AnalyticsEventInput,
} from "@/lib/analytics/events";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // A beacon fires on navigation, so the honest ceiling is generous - but it is
  // a WRITE endpoint reachable by anyone with a session, so it is not absent.
  const limit = await rateLimit("analytics-collect", clientIp(req), 120, 60).catch(() => ({
    ok: true,
    retryAfter: 0,
  }));
  if (!limit.ok) {
    return NextResponse.json(
      { ok: true, stored: false, reason: "rate-limited" },
      { status: 200, headers: { "Retry-After": String(limit.retryAfter || 60) } }
    );
  }

  const session = await getSession().catch(() => null);
  if (!session?.email) {
    return NextResponse.json({ ok: true, stored: false, reason: "no-session" });
  }

  // BOTH GATES. See analyticsAllowed - the ledger is the account's word, the
  // cookie is this device's, and a disagreement resolves to no.
  if (!(await analyticsAllowed(session.email))) {
    return NextResponse.json({ ok: true, stored: false, reason: "no-consent" });
  }

  const body = (await req.json().catch(() => null)) as { events?: unknown } | null;
  const raw = Array.isArray(body?.events) ? (body!.events as AnalyticsEventInput[]) : [];
  if (raw.length === 0) {
    return NextResponse.json({ ok: true, stored: false, reason: "empty" });
  }

  const result = await collectEvents({
    email: session.email,
    analyticsId: readAnalyticsId(),
    events: raw.slice(0, MAX_EVENTS_PER_BATCH),
  });

  // `stored` is the store's own answer, not an assumption. A pre-migration
  // database with no product_events table answers false here, and the owner's
  // analytics surface can then tell an empty table from a broken one.
  return NextResponse.json({
    ok: true,
    stored: result.stored === true,
    accepted: result.accepted,
    rejected: result.rejected,
  });
}
