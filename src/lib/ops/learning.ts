// The learning compiler - turns owner feedback into the compact ops_learning
// blob the LIVE engine reads: edge priors + owner-approved exemplars for the
// director, and calibration examples for the move judge.
//
// Design rule: feedback COMPILES INTO CONFIG at review time; the hot path
// (every shop message) costs one cached getConfig read and zero queries. All
// of it is plain text the LLM sees - the deterministic fallback and the
// legal-edge computation never change, and OPS_LEARNING=off kills the whole
// channel instantly.

import "server-only";
import { getConfig, sbSelect } from "../runtime-config";
import type { OpsLearning } from "./types";

const KEY = "ops_learning";
const MAX_PRIOR_LINES = 6;
const MIN_SAMPLES_PER_EDGE = 3;
const MAX_EXEMPLARS = 2;
const MAX_CALIBRATION = 3;

export async function opsLearningEnabled(): Promise<boolean> {
  try {
    const v = ((await getConfig("OPS_LEARNING")) ?? "").trim().toLowerCase();
    return v !== "off" && v !== "0" && v !== "false";
  } catch {
    // Unreadable = OFF, the same direction as every kill switch here
    // (usage.killSwitchOn: "unreadable means KILLED"). It used to fail OPEN -
    // the one switch in the system that did - which made the panel's "kill
    // switch" label a lie during exactly the outages a kill switch is for.
    // The behavior cost is nil: getOpsLearning's own blob read fails to null
    // on the same outage, so learning was already effectively off.
    return false;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __wd_ops_learning__: { at: number; value: OpsLearning | null } | undefined;
}

/** The compiled blob (null = nothing learned yet or kill switch off). 30s cache. */
export async function getOpsLearning(): Promise<OpsLearning | null> {
  if (!(await opsLearningEnabled())) return null;
  const cached = globalThis.__wd_ops_learning__;
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  let value: OpsLearning | null = null;
  try {
    const raw = await getConfig(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as OpsLearning;
      if (parsed && Array.isArray(parsed.edgePriorLines)) value = parsed;
    }
  } catch {
    /* no learning yet */
  }
  globalThis.__wd_ops_learning__ = { at: Date.now(), value };
  return value;
}

export function bustOpsLearningCache(): void {
  globalThis.__wd_ops_learning__ = undefined;
}

// ---------------------------------------------------------------------------
// Compilation (pure core + IO wrapper)
// ---------------------------------------------------------------------------

export interface ReviewSample {
  edge_id: string | null;
  branch_correct: boolean | null;
  outcome_impact: string | null;
  rating: number | null;
  verdict: string | null;
  feedback: string | null;
  tags: string[] | null;
}

export interface TrainingSample {
  text: string;
  source: string | null;
}

/** Pure compiler - unit-tested; recompileOpsLearning wraps it with IO. */
export function compileOpsLearning(
  reviews: ReviewSample[],
  training: TrainingSample[],
  now: string
): OpsLearning {
  // Edge priors: owner branch verdicts + outcome impacts aggregated per edge.
  const byEdge = new Map<
    string,
    { total: number; correct: number; improved: number; worsened: number }
  >();
  for (const r of reviews) {
    if (!r.edge_id) continue;
    if (r.branch_correct === null && !r.outcome_impact) continue;
    const agg =
      byEdge.get(r.edge_id) ?? { total: 0, correct: 0, improved: 0, worsened: 0 };
    agg.total++;
    if (r.branch_correct === true) agg.correct++;
    if (r.outcome_impact === "improved") agg.improved++;
    if (r.outcome_impact === "worsened") agg.worsened++;
    byEdge.set(r.edge_id, agg);
  }
  const edgePriorLines = Array.from(byEdge.entries())
    .filter(([, a]) => a.total >= MIN_SAMPLES_PER_EDGE)
    .sort((x, y) => y[1].total - x[1].total)
    .slice(0, MAX_PRIOR_LINES)
    .map(([edge, a]) => {
      const parts = [`owner-correct ${a.correct}/${a.total}`];
      if (a.improved) parts.push(`outcome improved ${a.improved}x`);
      if (a.worsened) parts.push(`worsened ${a.worsened}x`);
      // "spte:<move>" is the PRIMARY engine's stable decision identity (stamped
      // by runSpteLiveTurn on every trace). Without accepting that form, every
      // review of a production turn was dropped here - SPTE writes no graph
      // edge_id, so edgePriorLines was structurally dead on live traffic.
      const label = edge.startsWith("spte:")
        ? `move ${edge.slice("spte:".length)} (primary engine)`
        : `edge ${edge}`;
      return `${label}: ${parts.join(", ")}`;
    });

  // Director exemplars: the freshest owner-curated snippets.
  const directorExemplars = training
    .filter((t) => t.source === "ops-exemplar" || t.source === "ops-correction")
    .slice(0, MAX_EXEMPLARS)
    .map((t) => t.text.slice(0, 450));

  // Judge calibration: the owner's own graded judgments, strongest signal
  // first (explicit calibration-gap tags, then extreme ratings with a reason).
  const rated = reviews.filter((r) => r.rating != null && (r.feedback ?? "").trim());
  const gaps = rated.filter((r) => (r.tags ?? []).includes("calibration-gap"));
  const extremes = rated
    .filter((r) => !gaps.includes(r) && (r.rating! <= 2 || r.rating! >= 5))
    .sort((a, b) => Math.abs(3 - b.rating!) - Math.abs(3 - a.rating!));
  const judgeCalibration = [...gaps, ...extremes].slice(0, MAX_CALIBRATION).map(
    (r) =>
      `The owner rated a move ${r.rating}/5${r.verdict ? ` (${r.verdict})` : ""}: "${(
        r.feedback ?? ""
      ).slice(0, 200)}"`
  );

  return { compiledAt: now, edgePriorLines, directorExemplars, judgeCalibration };
}

/** Re-aggregate all owner feedback into the config blob. Called on review save. */
export async function recompileOpsLearning(): Promise<void> {
  try {
    const [reviews, training] = await Promise.all([
      sbSelect<ReviewSample>(
        "agent_reviews",
        "select=edge_id,branch_correct,outcome_impact,rating,verdict,feedback,tags&order=created_at.desc&limit=400"
      ).catch(() => []),
      sbSelect<TrainingSample>(
        "agent_training",
        "select=text,source&source=in.(ops-exemplar,ops-correction)&order=created_at.desc&limit=6"
      ).catch(() => []),
    ]);
    const blob = compileOpsLearning(reviews, training, new Date().toISOString());
    // BEHAVIOR-AFFECTING CONFIG GOES THROUGH THE CHOKEPOINT (Wave 3). This used
    // to setConfig the blob directly - no policy_versions row, no golden gate,
    // no rollback - while policy.ts documents itself as "the single chokepoint
    // for every behavior-affecting write". Now: the deterministic suite must be
    // readable and green (fail closed on an unreadable store, like every other
    // activation), and the blob lands as a versioned, rollbackable ops_learning
    // row. Dynamic imports because policy.ts imports this module.
    const { runGoldenSuite, goldenGateBlocks } = await import("./golden");
    const report = await runGoldenSuite();
    if (goldenGateBlocks(report)) return; // keep the previous compiled blob
    const { saveVersionedSpec } = await import("../policy");
    await saveVersionedSpec({
      kind: "ops_learning",
      spec: blob,
      note: "Learning recompile (owner review saved)",
      author: "ops-learning-loop",
      replayReport: report,
    });
    bustOpsLearningCache();
  } catch {
    /* recompiling must never block a review save */
  }
}

// ---------------------------------------------------------------------------
// Prompt blocks (pure - the ONLY way learning reaches the LLMs)
// ---------------------------------------------------------------------------

/**
 * The director's learning block. Empty string when nothing is learned - the
 * prompt is then byte-identical to the pre-Ops-Center prompt (pinned by test).
 */
export function formatDirectorLearning(learning: OpsLearning | null): string {
  if (!learning) return "";
  const parts: string[] = [];
  if (learning.edgePriorLines.length) {
    parts.push(
      "HISTORICAL EDGE PERFORMANCE (owner-audited results of past moves):\n" +
        learning.edgePriorLines.map((l) => `- ${l}`).join("\n")
    );
  }
  if (learning.directorExemplars.length) {
    parts.push(
      "EXEMPLARS (owner-approved negotiations - imitate the judgment, not the words):\n" +
        learning.directorExemplars.map((e) => `- ${e}`).join("\n")
    );
  }
  if (!parts.length) return "";
  return (
    "\n\n" +
    parts.join("\n\n") +
    "\nUse this as guidance only - never pick a move outside LEGAL MOVES."
  );
}

/** The move judge's calibration block (empty when nothing is learned). */
export function formatJudgeCalibration(learning: OpsLearning | null): string {
  if (!learning?.judgeCalibration.length) return "";
  return (
    "\n\nCALIBRATION - align your standards with how the owner judges similar messages:\n" +
    learning.judgeCalibration.map((l) => `- ${l}`).join("\n")
  );
}
