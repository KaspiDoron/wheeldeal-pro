// Admin -> Traffic, the read side. Management may look; nothing here changes
// anything. Configuration lives in Admin -> Keys (TRAFFIC_MODE, TRAFFIC_PARTNERS,
// TRAFFIC_TCF_CMP) like every other integration - this screen REPORTS on it,
// including every line of the partner registry that failed validation, because
// a partner that silently earns nothing looks exactly like a slow week.

import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getTrafficConfig } from "@/lib/traffic/config";
import { buildTrafficReport } from "@/lib/traffic/report";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Not allowed." }, { status: 403 });

  const days = Math.max(1, Math.min(90, Number(new URL(req.url).searchParams.get("days")) || 7));
  const config = await getTrafficConfig();
  const report = await buildTrafficReport(days, config.partners);

  return NextResponse.json({
    config: {
      mode: config.mode,
      cmp: config.cmp,
      errors: config.errors,
      // Out-of-range or unreadable TRAFFIC_SETTINGS values. They were clamped
      // or defaulted, and the owner must be able to SEE that - a setting that
      // was silently ignored looks exactly like a setting that works.
      settingsErrors: config.settingsErrors,
      settings: config.settings,
      creatives: config.creatives.length,
      partners: config.partners.map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        enabled: p.enabled,
        markets: p.markets,
        revenueShare: p.revenueShare,
        // Enough to recognise the account at a glance, not the whole target.
        target: p.kind === "afs" ? `${p.pubId} / style ${p.styleId}${p.channel ? ` / channel ${p.channel}` : ""}` : new URL(p.template.replace("{q}", "q").replace("{subid}", "s")).host,
      })),
    },
    report,
    canImport: session.role === "owner",
  });
}
