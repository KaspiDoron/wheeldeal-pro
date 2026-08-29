import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelectDark, sbCountDark } from "@/lib/runtime-config";

// Owner Command Center: one call that surfaces everything needing immediate
// attention - real bugs, stuck queues, WhatsApp health, low trust scores,
// billing activity - ranked by urgency.

export interface Alert {
  level: "critical" | "warning" | "info";
  title: string;
  detail: string;
  href?: string; // admin tab to jump to
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const alerts: Alert[] = [];
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

  // THE TILES ARE EXACT COUNTS, THE ALERTS KEEP THEIR SLICES (3.5).
  // Every headline stat used to be `.length` over a LIMITED slice - replies
  // and offers capped at 200, sessions at 100 - so a busy day silently
  // plateaued at the cap and the owner's topline read "200" forever.
  // sbCountDark asks PostgREST for the real count (HEAD + count=exact) and
  // answers null, not zero, when it cannot ask. The bounded row reads stay:
  // the alert logic needs actual rows, and 50 overdue rows is plenty to say
  // "the drain is stuck".
  const [
    feedback,
    outbox,
    reputation,
    billing,
    aiErrors,
    agentEvents,
    waLiveCount,
    replyCount,
    offerCount,
    queuedCount,
    issueCount,
  ] = await Promise.all([
      sbSelectDark<{ id: number; severity: string; summary: string; created_at: string }>(
        "feedback",
        `select=id,severity,summary,created_at&is_real_issue=eq.true&or=(status.is.null,status.eq.open,status.eq.in-progress)&order=created_at.desc&limit=20`
      ),
      sbSelectDark<{ id: number; not_before: string }>(
        "wa_outbox",
        "select=id,not_before&order=not_before.asc&limit=50"
      ),
      sbSelectDark<{ sender_key: string; trust_score: number; paused_until?: string; risk_score?: number }>(
        "whatsapp_number_reputation",
        "select=sender_key,trust_score,paused_until,risk_score&or=(trust_score.lt.15,risk_score.gte.40,paused_until.not.is.null)&limit=30"
      ),
      sbSelectDark<{ id: number; kind: string; created_at: string }>(
        "billing_events",
        `select=id,kind,created_at&created_at=gte.${encodeURIComponent(dayAgo)}&limit=50`
      ),
      // NOTE: the column is `failed` (not `ok`) - the old query silently
      // returned [] and AI-failure alerts never fired.
      sbSelectDark<{ id: number; provider: string; failed: boolean; created_at: string }>(
        "ai_usage",
        `select=id,provider,failed,created_at&failed=eq.true&created_at=gte.${encodeURIComponent(dayAgo)}&limit=100`
      ),
      sbSelectDark<{ id: number; kind: string; vendor_name: string; detail: string }>(
        "agent_events",
        `select=id,kind,vendor_name,detail&handled=eq.false&created_at=gte.${encodeURIComponent(weekAgo)}&order=created_at.desc&limit=30`
      ),
      sbCountDark("wa_sessions", "status=eq.open"),
      sbCountDark("vendor_replies", `created_at=gte.${encodeURIComponent(dayAgo)}`),
      sbCountDark("offers", `created_at=gte.${encodeURIComponent(dayAgo)}`),
      sbCountDark("wa_outbox", ""),
      sbCountDark(
        "feedback",
        "is_real_issue=eq.true&or=(status.is.null,status.eq.open,status.eq.in-progress)"
      ),
    ]);

  // EVERY READ ABOVE USED TO END `.catch(() => [])`, THEN `.catch(() => null)`,
  // AND NEITHER EVER RAN.
  //
  // An empty array is indistinguishable from "nothing wrong", so an unreachable
  // Supabase produced ZERO alerts and a fully green Command Center - the one
  // surface whose entire job is to say "something is broken" reported "nothing
  // is broken" as its failure mode.
  //
  // The first fix changed the catches to `() => null` and built the `readOr`
  // machinery below to name each null. It did nothing, because `sbSelect` has no
  // rejection path: a missing connection, a non-2xx and a thrown exception all
  // `return []`, so the catch was unreachable and the null branch behind it was
  // dead code. The panel stayed green and the repair was recorded as shipped.
  //
  // `sbSelectDark` is the read that can actually answer "unknown": rows on
  // success, `[]` for a table that does not exist yet (vacuously empty - a fresh
  // install must not paint itself dark), and `null` only for a real outage.
  //
  // `degraded` is what the panel renders as a dark strip. The rule from
  // wa/risk-verdict.ts applies: a metric whose source read failed is NOT zero.
  //
  // `degraded` is what the panel renders as a dark strip. The rule from
  // wa/risk-verdict.ts applies: a metric whose source read failed is NOT zero.
  const degraded: string[] = [];
  const readOr = <T,>(rows: readonly T[] | null, label: string): readonly T[] => {
    if (rows === null) {
      degraded.push(label);
      return [];
    }
    return rows;
  };

  // The sessions/replies/offers ROW reads that used to sit here were
  // superseded by the sbCountDark tiles below and referenced by nothing -
  // three round trips of pure egress on every load and every refresh.
  const feedbackRows = readOr(feedback, "feedback");
  const outboxRows = readOr(outbox, "queued messages");
  const reputationRows = readOr(reputation, "number reputation");
  const billingRows = readOr(billing, "billing events");
  const aiErrorRows = readOr(aiErrors, "AI usage");
  const agentEventRows = readOr(agentEvents, "agent events");

  // A read that failed is itself the most urgent thing on the page: every
  // figure below it is now computed over a subset we cannot describe.
  if (degraded.length) {
    alerts.push({
      level: "critical",
      title: `${degraded.length} data source${degraded.length > 1 ? "s" : ""} unreadable`,
      detail:
        `Could not read: ${degraded.join(", ")}. Figures below are incomplete - ` +
        `they are not zero, they are unknown. Check the Supabase connection.`,
      href: "keys",
    });
  }

  // Bugs first - real triaged issues are the owner's top priority.
  const highBugs = feedbackRows.filter((f) => f.severity === "high");
  if (highBugs.length) {
    alerts.push({
      level: "critical",
      title: `${highBugs.length} high-severity bug${highBugs.length > 1 ? "s" : ""} reported`,
      detail: highBugs
        .slice(0, 3)
        .map((b) => b.summary)
        .join(" · "),
      href: "feedback",
    });
  } else if (feedbackRows.length) {
    alerts.push({
      level: "warning",
      title: `${feedbackRows.length} open feedback issue${feedbackRows.length > 1 ? "s" : ""}`,
      detail: feedbackRows.slice(0, 3).map((b) => b.summary).join(" · "),
      href: "feedback",
    });
  }

  // Stuck outbox: messages queued far in the past mean the drain is not firing.
  const overdue = outboxRows.filter(
    (o) => Date.parse(o.not_before) < Date.now() - 30 * 60_000
  );
  // Both queue alerts point at THIS tab: the Queue panel below the alert list
  // is the screen that can actually answer them (rows, reasons, flush, drop).
  // They used to point at Keys, which has no queue view at all - the same
  // points-at-a-screen-that-cannot-answer class as the paused-number alert.
  if (overdue.length) {
    alerts.push({
      level: "critical",
      title: `${overdue.length} queued WhatsApp message${overdue.length > 1 ? "s" : ""} overdue`,
      detail:
        "The outbox drain has not run for 30+ minutes - see the Queue panel below (flush the due rows, then check the Evolution hosts).",
      href: "command",
    });
  } else if (outboxRows.length) {
    alerts.push({
      level: "info",
      title: `${outboxRows.length} message${outboxRows.length > 1 ? "s" : ""} queued for shop opening hours`,
      detail: "The anti-ban engine is pacing sends - all normal. Details in the Queue panel below.",
      href: "command",
    });
  }

  // Funnel gaps: shops that dodged the price question with a vague answer -
  // each one is a candidate for a new branch in the negotiation funnel.
  const vagueReplies = agentEventRows.filter((e) => e.kind === "vague-reply");
  if (vagueReplies.length) {
    alerts.push({
      level: "warning",
      title: `${vagueReplies.length} shop${vagueReplies.length > 1 ? "s" : ""} gave a vague answer (funnel gap)`,
      detail:
        vagueReplies
          .slice(0, 3)
          .map((e) => `${e.vendor_name || "shop"}: "${(e.detail || "").slice(0, 60)}"`)
          .join(" · ") + " - consider a new funnel branch for these.",
      // The graph-era "agents" tab is deleted; the Engine tab is where the
      // live composition behaviour is inspected now.
      href: "engine",
    });
  }

  // Numbers auto-paused by the ban-risk engine (most urgent).
  const paused = reputationRows.filter(
    (r) => (r as { paused_until?: string }).paused_until &&
      Date.parse((r as { paused_until?: string }).paused_until as string) > Date.now()
  );
  if (paused.length) {
    alerts.push({
      level: "critical",
      title: `${paused.length} WhatsApp number${paused.length > 1 ? "s" : ""} AUTO-PAUSED (ban risk)`,
      detail:
        "The anti-ban engine paused these numbers to prevent a restriction: " +
        paused.slice(0, 3).map((r) => r.sender_key).join(", ") +
        ". The per-number detail is on this screen, below.",
      // THE MOST URGENT ALERT IN THE APP POINTED AT THE WRONG SCREEN. Number
      // reputationRows - trust score, pause state, block and read rates - is
      // rendered on the Command tab; the Agents tab is the orchestrator and has
      // nothing about WhatsApp numbers at all. So the one tap the owner makes
      // when a number is auto-paused took them somewhere that could not answer.
      href: "command",
    });
  }
  // Numbers trending toward risk (low trust) but not yet paused.
  const lowTrust = reputationRows.filter((r) => r.trust_score < 15 && !paused.includes(r));
  if (lowTrust.length) {
    alerts.push({
      level: "warning",
      title: `${lowTrust.length} WhatsApp number${lowTrust.length > 1 ? "s" : ""} at ban risk`,
      detail:
        "Low trust (lots of outbound, few replies): " +
        lowTrust.slice(0, 3).map((r) => `${r.sender_key} (${r.trust_score})`).join(", "),
      href: "command",
    });
  }
  // Explicit ban-risk events raised by the engine.
  const banEvents = agentEventRows.filter((e) => e.kind === "wa-ban-risk");
  if (banEvents.length) {
    alerts.push({
      level: "critical",
      title: `${banEvents.length} ban-risk event${banEvents.length > 1 ? "s" : ""}`,
      detail: banEvents.slice(0, 2).map((e) => e.detail).join(" · "),
      href: "command",
    });
  }

  // AI provider failures.
  if (aiErrorRows.length >= 5) {
    const byProvider = new Map<string, number>();
    aiErrorRows.forEach((e) => byProvider.set(e.provider, (byProvider.get(e.provider) ?? 0) + 1));
    alerts.push({
      level: "warning",
      title: `${aiErrorRows.length} AI calls failed in the last 24h`,
      detail: [...byProvider.entries()].map(([p, n]) => `${p}: ${n}`).join(", "),
      href: "keys",
    });
  }

  // Money.
  if (billingRows.length) {
    alerts.push({
      level: "info",
      title: `${billingRows.length} billing event${billingRows.length > 1 ? "s" : ""} in the last 24h`,
      detail: billingRows.slice(0, 4).map((b) => b.kind).join(" · "),
      href: "users",
    });
  }

  // A STAT FROM A DARK SOURCE IS NULL, NOT 0.
  //
  // This is the same rule as the alerts, applied to the numbers the panel puts
  // in large type. "0 replies today" and "we could not read replies today" look
  // identical as a zero and mean opposite things - the first is a quiet day,
  // the second is an outage. `null` forces the UI to render a dash. The counts
  // themselves are sbCountDark (exact, never a capped slice); a null count
  // joins `degraded` so a dashed tile is always explained by the strip above.
  const countStat = (n: number | null, label: string): number | null => {
    if (n === null && !degraded.includes(label)) degraded.push(label);
    return n;
  };

  return NextResponse.json({
    alerts,
    degraded,
    stats: {
      waSessions: countStat(waLiveCount, "WhatsApp sessions"),
      repliesToday: countStat(replyCount, "shop replies"),
      offersToday: countStat(offerCount, "offers"),
      queuedMessages: countStat(queuedCount, "queued messages"),
      openIssues: countStat(issueCount, "feedback"),
    },
  });
}
