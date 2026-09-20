// IMPORT A PARTNER'S REVENUE REPORT. Owner only, and on the audit trail.
//
// A RE-IMPORT REPLACES, IT DOES NOT ADD. Search partners publish an estimate
// within hours and the final figure a week or more later, so the same
// (partner, day, sub-id) legitimately arrives several times with different
// numbers. The unique index plus merge-on-conflict makes the newest report the
// truth for that day - importing last week's file twice changes nothing, and
// importing the finalised file corrects the estimate instead of doubling it.
//
// The refusal is audited as well as the success: "somebody who was not the
// owner tried to change the revenue figures" is exactly the row an audit trail
// exists to hold.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";
import { recordAdminAction } from "@/lib/admin/audit";
import { getTrafficConfig } from "@/lib/traffic/config";
import { parseRevenueCsv } from "@/lib/traffic/revenue";

export const dynamic = "force-dynamic";

/** 50,000 rows of a narrow CSV is a little over 3 MB. */
const MAX_BYTES = 4_000_000;
const BATCH = 500;

export async function POST(req: Request) {
  const session = await getSession().catch(() => null);
  if (!session || session.role !== "owner") {
    if (session?.email) {
      await recordAdminAction({
        actorEmail: session.email,
        actorRole: session.role,
        action: "traffic.revenue-import",
        outcome: "refused",
        detail: { reason: "owner-only" },
      });
    }
    return NextResponse.json({ error: "Only the owner can import revenue." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { partner?: unknown; csv?: unknown; currency?: unknown } | null;
  const partnerId = String(body?.partner ?? "");
  const csv = typeof body?.csv === "string" ? body.csv : "";
  if (!csv) return NextResponse.json({ error: "No report was attached." }, { status: 400 });
  if (csv.length > MAX_BYTES) return NextResponse.json({ error: "That file is too large - split the report by month." }, { status: 413 });

  const config = await getTrafficConfig();
  // The partner must be one the owner configured. A typo here would file real
  // money under a name no report screen will ever show.
  if (!config.partners.some((p) => p.id === partnerId)) {
    return NextResponse.json({ error: "That partner is not in TRAFFIC_PARTNERS." }, { status: 400 });
  }
  const currency = /^[A-Z]{3}$/.test(String(body?.currency ?? "")) ? String(body?.currency) : "USD";

  const parsed = parseRevenueCsv(csv);
  if (parsed.rows.length === 0) {
    return NextResponse.json({ error: "No usable rows were found.", problems: parsed.errors.slice(0, 20) }, { status: 400 });
  }

  let saved = 0;
  let failedBatches = 0;
  for (let i = 0; i < parsed.rows.length; i += BATCH) {
    const rows = parsed.rows.slice(i, i + BATCH).map((r) => ({
      partner: partnerId,
      day: r.day,
      sub_id: r.subId.slice(0, 120),
      clicks: r.clicks,
      revenue: r.revenue,
      currency,
      imported_by: session.email,
    }));
    const ok = await sbInsert("traffic_revenue", rows, "partner,day,sub_id").catch(() => false);
    if (ok) saved += rows.length;
    else failedBatches++;
  }

  await recordAdminAction({
    actorEmail: session.email,
    actorRole: session.role,
    action: "traffic.revenue-import",
    outcome: failedBatches === 0 ? "ok" : "failed",
    detail: { partner: partnerId, rows: parsed.rows.length, saved, skipped: parsed.errors.length, failedBatches },
  });

  // HONEST WRITES: a partial import is reported as partial, with a 502, never
  // as a success with a footnote.
  return NextResponse.json(
    {
      ok: failedBatches === 0,
      saved,
      total: parsed.rows.length,
      skipped: parsed.errors.length,
      problems: parsed.errors.slice(0, 20),
    },
    { status: failedBatches === 0 ? 200 : 502 }
  );
}
