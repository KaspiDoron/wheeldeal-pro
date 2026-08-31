import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { sbSelectDark } from "@/lib/runtime-config";
import { getActiveRev } from "@/lib/ops/rev";
import { compileAskVariantReport, type VariantTurn } from "@/lib/ops/ask-variant-stats";

// Negotiation-quality analytics: branch heatmap (usage x owner verdicts x
// outcomes), quality-over-time split by behavior revision (= regression
// detection after every change), owner-vs-judge calibration, and the
// failure-tag histogram. All JS-side aggregation over capped selects.

interface TraceRow {
  edge_id: string | null;
  spec_rev: number | null;
  created_at: string;
}
interface ScoreRow {
  scorer: string;
  scores: Record<string, number> | null;
  spec_rev: number | null;
  decision_id: string | null;
  created_at: string;
}
interface TurnRow {
  user_email: string | null;
  vendor_id: string | null;
  detail: string | null;
  created_at: string;
}
interface ReviewRow {
  decision_id: string | null;
  edge_id: string | null;
  rating: number | null;
  verdict: string | null;
  branch_correct: boolean | null;
  outcome_impact: string | null;
  tags: string[] | null;
  created_at: string;
}

export async function GET(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });
  const days = Math.min(90, Math.max(7, Number(new URL(req.url).searchParams.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // M21 - FAIL DARK, NOT GREEN.
  //
  // These three reads ended in `.catch(() => [])`, so an unreachable Supabase
  // produced a full analytics page: zero branch uses, zero owner reviews, zero
  // judge scores, no regression, no failure tags. Indistinguishable from a
  // quiet week, and the tile that says "no regression detected" is exactly the
  // one the owner would act on.
  //
  // This repo has shipped that shape three times - the Command Center's nine
  // catches, the banner reading "Messaging: All good" over a dead webhook, and
  // `classifySafety`'s positive-evidence-only design. `null` means UNREAD, the
  // page says so, and every derived figure below reads the empty array so the
  // aggregation code stays unchanged.
  //
  // AND THEN IT SHIPPED A FOURTH TIME, HERE, AS THE FIX ITSELF.
  //
  // The M21 repair changed `.catch(() => [])` to `.catch(() => null)` and built
  // the `degraded` list below to name each null. None of it ran. `sbSelect` has
  // no rejection path - a missing connection, a non-2xx and a thrown exception
  // all `return []` - so the catch was unreachable, `null` was unreachable,
  // `degraded` was permanently empty, and the panel went on rendering a
  // confident zero over a dead database while the repair was recorded as done.
  //
  // A fix for a fail-green defect that is itself fail-green is the sharpest
  // version of this mistake available, and it is why the reader below is
  // `sbSelectDark`: it returns rows, `[]` for a table that does not exist yet,
  // and `null` ONLY for a real outage. There is nothing left to catch.
  const [tracesRead, scoresRead, reviewsRead, activeRev, turnsRead] = await Promise.all([
    sbSelectDark<TraceRow>(
      "agent_traces",
      `select=edge_id,spec_rev,created_at&edge_id=not.is.null&created_at=gte.${encodeURIComponent(
        since
      )}&order=created_at.desc&limit=1000`
    ),
    sbSelectDark<ScoreRow>(
      "agent_scores",
      `select=scorer,scores,spec_rev,decision_id,created_at&created_at=gte.${encodeURIComponent(
        since
      )}&order=created_at.desc&limit=400`
    ),
    sbSelectDark<ReviewRow>(
      "agent_reviews",
      // Same window as every other read on this page: an all-time review set
      // fed the "last 30 days" heatmap/timeline/calibration, so old reviews
      // silently skewed every time-scoped aggregate.
      `select=decision_id,edge_id,rating,verdict,branch_correct,outcome_impact,tags,created_at&created_at=gte.${encodeURIComponent(
        since
      )}&order=created_at.desc&limit=400`
    ),
    getActiveRev(),
    // THE OWNER'S PHRASING A/B (owner report 5 #2, second half). Every fact it
    // needs is already on the turn telemetry - the arm, whether we named a
    // counter, and the quote on the table - so this is one more capped read
    // over rows the engine already writes, not a new table.
    sbSelectDark<TurnRow>(
      "agent_events",
      `select=user_email,vendor_id,detail,created_at&kind=eq.engine-v3-turn&created_at=gte.${encodeURIComponent(
        since
      )}&order=created_at.desc&limit=4000`
    ),
  ]);

  const traces = tracesRead ?? [];
  const scores = scoresRead ?? [];
  const reviews = reviewsRead ?? [];
  /** Which inputs could not be read. Rendered as a dark strip, never hidden. */
  const degraded = [
    tracesRead === null ? "decision traces" : null,
    scoresRead === null ? "judge scores" : null,
    reviewsRead === null ? "owner reviews" : null,
    turnsRead === null ? "engine turns" : null,
  ].filter((x): x is string => x !== null);

  // ---- The phrasing A/B ------------------------------------------------------
  const askVariants = compileAskVariantReport(
    (turnsRead ?? []).map((row) => {
      let d: Partial<VariantTurn> & { move?: string } = {};
      try {
        d = JSON.parse(row.detail ?? "{}");
      } catch {
        // A truncated blob (the detail is hard-capped at 1600 chars) is simply
        // not a scorable turn. The two long free-text fields sit LAST in that
        // JSON precisely so truncation eats a scratchpad, never a metric - but
        // a row that does not parse is skipped rather than guessed at.
      }
      return {
        userEmail: row.user_email,
        vendorId: row.vendor_id,
        createdAt: row.created_at,
        move: d.move ?? null,
        askVariant: d.askVariant ?? null,
        counterPricePerDay: d.counterPricePerDay ?? null,
        variantOk: d.variantOk ?? null,
        quote: d.quote ?? null,
        standingQuote: d.standingQuote ?? null,
      };
    })
  );

  // ---- Branch heatmap: every director edge that actually fired -----------------
  const heat = new Map<
    string,
    { uses: number; correct: number; verdicts: number; improved: number; worsened: number; ratings: number[] }
  >();
  for (const t of traces) {
    if (!t.edge_id) continue;
    const h =
      heat.get(t.edge_id) ??
      { uses: 0, correct: 0, verdicts: 0, improved: 0, worsened: 0, ratings: [] as number[] };
    h.uses++;
    heat.set(t.edge_id, h);
  }
  for (const r of reviews) {
    if (!r.edge_id) continue;
    const h =
      heat.get(r.edge_id) ??
      { uses: 0, correct: 0, verdicts: 0, improved: 0, worsened: 0, ratings: [] as number[] };
    if (r.branch_correct !== null) {
      h.verdicts++;
      if (r.branch_correct) h.correct++;
    }
    if (r.outcome_impact === "improved") h.improved++;
    if (r.outcome_impact === "worsened") h.worsened++;
    if (typeof r.rating === "number") h.ratings.push(r.rating);
    heat.set(r.edge_id, h);
  }
  const heatmap = Array.from(heat.entries())
    .map(([edge, h]) => ({
      edge,
      uses: h.uses,
      ownerCorrectPct: h.verdicts > 0 ? Math.round((h.correct / h.verdicts) * 100) : null,
      verdicts: h.verdicts,
      improved: h.improved,
      worsened: h.worsened,
      avgRating: h.ratings.length
        ? Number((h.ratings.reduce((a, b) => a + b, 0) / h.ratings.length).toFixed(1))
        : null,
    }))
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 20);

  // ---- Quality per behavior revision (regression detection) --------------------
  const byRev = new Map<number, { outcome: number[]; tone: number[]; fit: number[] }>();
  for (const s of scores) {
    const rev = s.spec_rev ?? 0;
    const b = byRev.get(rev) ?? { outcome: [], tone: [], fit: [] };
    if (s.scorer === "chief-judge" && typeof s.scores?.outcomeDelta === "number")
      b.outcome.push(s.scores.outcomeDelta);
    if (s.scorer !== "chief-judge") {
      if (typeof s.scores?.tone === "number") b.tone.push(s.scores.tone);
      if (typeof s.scores?.tacticFit === "number") b.fit.push(s.scores.tacticFit);
    }
    byRev.set(rev, b);
  }
  const avg = (xs: number[]) =>
    xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null;
  const revisions = Array.from(byRev.entries())
    .map(([rev, b]) => ({
      rev,
      decisions: b.tone.length + b.outcome.length,
      avgOutcome: avg(b.outcome),
      avgTone: avg(b.tone),
      avgTacticFit: avg(b.fit),
    }))
    .sort((a, b) => b.rev - a.rev)
    .slice(0, 8);

  // Regression banner: the active rev underperforms its predecessor by >20%.
  let regression: string | null = null;
  if (revisions.length >= 2) {
    const cur = revisions.find((r) => r.rev === (activeRev ?? 0)) ?? revisions[0];
    const prev = revisions.find((r) => r.rev !== cur.rev && (r.avgOutcome ?? null) !== null);
    if (
      cur &&
      prev &&
      cur.decisions >= 5 &&
      cur.avgOutcome !== null &&
      prev.avgOutcome !== null &&
      cur.avgOutcome < prev.avgOutcome * 0.8
    ) {
      regression = `Behavior revision ${cur.rev} averages outcome ${cur.avgOutcome} vs ${prev.avgOutcome} on revision ${prev.rev} - a possible regression. Consider rolling back in Policy & versions.`;
    }
  }

  // ---- Weekly quality timeline ---------------------------------------------------
  const weekOf = (iso: string) => {
    const d = new Date(iso);
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - day + 1);
    return d.toISOString().slice(0, 10);
  };
  const weeks = new Map<string, { tone: number[]; fit: number[]; outcome: number[]; ratings: number[] }>();
  for (const s of scores) {
    const w = weekOf(s.created_at);
    const b = weeks.get(w) ?? { tone: [], fit: [], outcome: [], ratings: [] };
    if (s.scorer === "chief-judge" && typeof s.scores?.outcomeDelta === "number")
      b.outcome.push(s.scores.outcomeDelta);
    if (s.scorer !== "chief-judge") {
      if (typeof s.scores?.tone === "number") b.tone.push(s.scores.tone);
      if (typeof s.scores?.tacticFit === "number") b.fit.push(s.scores.tacticFit);
    }
    weeks.set(w, b);
  }
  for (const r of reviews) {
    if (typeof r.rating !== "number") continue;
    const w = weekOf(r.created_at);
    const b = weeks.get(w) ?? { tone: [], fit: [], outcome: [], ratings: [] };
    b.ratings.push(r.rating);
    weeks.set(w, b);
  }
  const timeline = Array.from(weeks.entries())
    .map(([week, b]) => ({
      week,
      avgTone: avg(b.tone),
      avgTacticFit: avg(b.fit),
      avgOutcome: avg(b.outcome),
      avgOwnerRating: avg(b.ratings),
      samples: b.tone.length + b.outcome.length + b.ratings.length,
    }))
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-10);

  // ---- Owner vs judge calibration -------------------------------------------------
  const judgeByDecision = new Map<string, number>();
  for (const s of scores) {
    if (s.scorer !== "chief-judge" && s.decision_id && typeof s.scores?.tacticFit === "number") {
      judgeByDecision.set(s.decision_id, s.scores.tacticFit);
    }
  }
  const calibration: { owner: number; judge: number }[] = [];
  for (const r of reviews) {
    if (typeof r.rating !== "number" || !r.decision_id) continue;
    const judge = judgeByDecision.get(r.decision_id);
    if (typeof judge === "number") calibration.push({ owner: r.rating, judge });
  }

  // ---- Failure-tag histogram --------------------------------------------------------
  const tagCounts = new Map<string, number>();
  for (const r of reviews)
    for (const tag of r.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const tags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return NextResponse.json({
    days,
    activeRev,
    heatmap,
    revisions,
    regression,
    timeline,
    calibration,
    tags,
    askVariants,
    // UNREAD IS NULL, NOT ZERO. The panel renders a dash for null and a real
    // count for 0 - "nothing happened" and "we could not look" are different
    // answers and only one of them means the engine is idle.
    totals: {
      decisionsTraced: tracesRead === null ? null : traces.length,
      judgeScores: scoresRead === null ? null : scores.length,
      ownerReviews: reviewsRead === null ? null : reviews.length,
    },
    degraded,
  });
}

export const maxDuration = 60;
