import { NextResponse } from "next/server";
import { requireManagement, getSession } from "@/lib/session";
import { monthlyUsage, QUOTAS, limitDefaults, killSwitchOn } from "@/lib/usage";
import { getConfig, setConfig, sbSelect, sbCountDark } from "@/lib/runtime-config";

// Cost tracker + abuse limits + owner kill switch.
// GET: this month's usage per API vs free quota, AI token totals, current limits.
// POST: { limits?: {NAME: number}, killSwitch?: boolean } - kill switch owner-only.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const since = `created_at=gte.${encodeURIComponent(start.toISOString())}`;
  // KPIs ARE EXACT COUNTS THAT CAN SAY "UNKNOWN" (3.5). These four numbers
  // were `.length` over bare sbSelect slices capped at 10k - so an outage
  // rendered a confident zero (the fail-green shape this repo keeps digging
  // out) and a month past the cap silently plateaued. sbCountDark is exact
  // and answers null when it cannot ask; nulls are named in `degraded` so the
  // panel can say which figures are unknown rather than low. The ai_usage ROW
  // read stays for the per-provider token breakdown (a grouping, not a KPI).
  const [usage, aiRows, searchCount, offerCount, outboundCount, userCount, aiCallCount, kill] =
    await Promise.all([
      monthlyUsage(),
      sbSelect<{ provider: string; tokens: number }>(
        "ai_usage",
        `select=provider,tokens&${since}&limit=10000`
      ),
      sbCountDark("searches", since),
      sbCountDark("offers", since),
      sbCountDark(
        "whatsapp_messages",
        `direction=eq.outbound&to_number=not.in.(session,takeover,cancel)&received_at=gte.${encodeURIComponent(start.toISOString())}`
      ),
      sbCountDark("app_users", ""),
      sbCountDark("ai_usage", since),
      killSwitchOn(),
    ]);

  const aiTokens: Record<string, number> = {};
  for (const r of aiRows) {
    aiTokens[r.provider] = (aiTokens[r.provider] ?? 0) + (r.tokens ?? 0);
  }

  const degraded: string[] = [];
  const dark = (n: number | null, label: string): number | null => {
    if (n === null) degraded.push(label);
    return n;
  };
  const stats = {
    searchesThisMonth: dark(searchCount, "searches"),
    offersThisMonth: dark(offerCount, "offers"),
    messagesSent: dark(outboundCount, "messages sent"),
    aiCalls: dark(aiCallCount, "AI calls"),
    totalUsers: dark(userCount, "users"),
  };

  const defaults = limitDefaults();
  const limits: Record<string, number> = {};
  for (const name of Object.keys(defaults)) {
    const v = Number(await getConfig(name));
    limits[name] = Number.isFinite(v) && v > 0 ? v : defaults[name];
  }

  const apis = Object.entries(QUOTAS).map(([kind, q]) => {
    const used = usage[kind] ?? 0;
    const over = Math.max(0, used - q.free);
    return {
      kind,
      label: q.label,
      used,
      free: q.free,
      estCostUsd: Number((over * q.unitCost).toFixed(2)),
    };
  });

  return NextResponse.json({ apis, aiTokens, stats, degraded, limits, defaults, killSwitch: kill });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const defaults = limitDefaults();

  if (body.limits && typeof body.limits === "object") {
    for (const [name, value] of Object.entries(body.limits)) {
      if (!(name in defaults)) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0 && n <= 100000) {
        await setConfig(name, String(Math.round(n)));
      }
    }
  }

  if (typeof body.killSwitch === "boolean") {
    const me = await getSession();
    if (me?.role !== "owner") {
      return NextResponse.json({ error: "Only the owner can use the kill switch." }, { status: 403 });
    }
    // DO NOT DISCARD THE WRITE RESULT (OR11 D2.4). This is an EMERGENCY STOP.
    // setConfig can fail (vault write error) or persist only to THIS instance's
    // memory (Supabase unreachable) - and the route used to answer { ok: true }
    // either way, so the owner saw "done" while the switch had not actually
    // taken, or had taken on one of up to 20 instances. Report the truth.
    const res = await setConfig("KILL_SWITCH", body.killSwitch ? "1" : "");
    if (!res.ok) {
      return NextResponse.json(
        {
          error:
            res.error ??
            "Could not save the kill switch - it is UNCHANGED. Try again before relying on it.",
        },
        { status: 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      killSwitch: body.killSwitch,
      persistent: res.persistent,
      ...(res.persistent
        ? {}
        : {
            warning:
              "Saved to THIS instance only - Supabase was unreachable, so the other running instances are NOT affected yet. Retry until it persists fleet-wide.",
          }),
    });
  }

  return NextResponse.json({ ok: true });
}
