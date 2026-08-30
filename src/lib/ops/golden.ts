// The golden regression suite - real conversations frozen into deterministic
// replay cases, used as the EVAL GATE for every behavior change: a candidate
// graph spec or policy overlay only activates if every enabled golden case
// still passes under it. Because replay is fully deterministic (stubbed
// extraction + frozen floor + llmAllowed:false + frozen clock), the whole
// suite runs server-side in one request with zero LLM calls.

import "server-only";
import { replayConversation, replaySpteTurns } from "../simulate";
import type { PlayedTurn } from "../simulate";
import type { GraphSpec } from "../graph/types";
import type { PolicyOverlay } from "./overlay";
import { isMoveKind, normalizeMove } from "../spte/moves";
import type { GoldenCase, GoldenExpect, ReplayCaseResult, ReplayReport } from "./types";

// 48 (owner report 4/W2.2): 24 was already tight against the owner's frozen
// conversations PLUS the authored coherence seeds below - a suite that stops
// growing stops gating.
const MAX_CASES = 48;

// The authored coherence guards are name-keyed with this prefix
// (golden-coherence.ts). They are PINNED into the replayed set: the newest-first
// window used to apply to the whole suite, so every real conversation the owner
// froze silently evicted one of the twelve authored guards - the suite got
// bigger and guarded less.
const COHERENCE_PREFIX = "coherence:";

/** Does this turn's expectation exercise the GRAPH engine at all? The move /
 *  moveNot / noMessageContains trio gates the PRIMARY engine (SPTE); these four
 *  gate the dormant graph. Used to keep the graph-side assertions off cases
 *  that only ever target the engine that ships. */
function turnTargetsGraph(expected: GoldenExpect): boolean {
  return Boolean(
    expected.action ||
      expected.edgeId ||
      (expected.pathContains?.length ?? 0) > 0 ||
      typeof expected.targetAtLeast === "number"
  );
}

/** Pure expectation checker - unit-tested. */
export function evaluateTurn(
  expected: GoldenExpect | undefined,
  played: PlayedTurn,
  /** The same turn as run by the PRIMARY engine, when the case asserts a move. */
  spte?: { move: string; ourReply: string | null }
): string[] {
  if (!expected) return [];
  const failures: string[] = [];
  // PRIMARY ENGINE first: `move` is the assertion that gates production. A case
  // that asks for a move but never reached the SPTE replay is a failure, not a
  // silent pass - an eval gate that skips when it cannot check is not a gate.
  if (expected.move) {
    if (!spte) failures.push(`move: expected "${expected.move}", SPTE replay did not run`);
    else if (spte.move !== expected.move) {
      failures.push(`move: expected "${expected.move}", got "${spte.move}"`);
    }
  }
  for (const banned of expected.moveNot ?? []) {
    if (spte?.move === banned) failures.push(`move: "${banned}" is forbidden here`);
  }
  for (const banned of expected.noMessageContains ?? []) {
    if ((spte?.ourReply ?? "").toLowerCase().includes(banned.toLowerCase())) {
      failures.push(`SPTE message contains banned "${banned}"`);
    }
  }
  if (expected.action && played.action !== expected.action) {
    failures.push(`action: expected "${expected.action}", got "${played.action}"`);
  }
  if (expected.edgeId) {
    const chosen = played.ladder?.find((r) => r.chosen)?.edgeId;
    if (chosen !== expected.edgeId) {
      failures.push(`edge: expected "${expected.edgeId}", got "${chosen ?? "(none)"}"`);
    }
  }
  for (const node of expected.pathContains ?? []) {
    if (!played.path.includes(node)) failures.push(`path missing node "${node}"`);
  }
  if (typeof expected.targetAtLeast === "number") {
    const t = played.state.lastTarget;
    if (typeof t !== "number" || t < expected.targetAtLeast) {
      failures.push(`target: expected >= ${expected.targetAtLeast}, got ${t ?? "(none)"}`);
    }
  }
  // GRAPH-side banned-substring check - ONLY when this turn actually targets the
  // graph engine (or when no SPTE replay ran, which is the legacy graph-only
  // shape). It used to run unconditionally, so an SPTE-only case was judged on
  // the reply of an engine that does not ship, and a phrase banned in both got
  // reported twice for one turn.
  if (turnTargetsGraph(expected) || !spte) {
    for (const banned of expected.noMessageContains ?? []) {
      if ((played.ourReply ?? "").toLowerCase().includes(banned.toLowerCase())) {
        failures.push(`graph message contains banned "${banned}"`);
      }
    }
  }
  return failures;
}

export function evaluateCase(
  gc: GoldenCase,
  playedTurns: PlayedTurn[],
  spteTurns: Array<{ move: string; ourReply: string | null }> = []
): ReplayCaseResult {
  const turns = playedTurns.map((played, i) => {
    const expected = gc.expects[i] ?? {};
    const failures = evaluateTurn(expected, played, spteTurns[i]);
    return {
      turn: i,
      shopSays: played.shopSays?.slice(0, 300),
      expected,
      got: {
        action: played.action,
        edgeId: played.ladder?.find((r) => r.chosen)?.edgeId,
        path: played.path,
        target: played.state.lastTarget,
        message: (played.ourReply ?? "").slice(0, 300) || undefined,
        // What the PRIMARY engine did - so a failure report names the thing
        // that actually shipped, not just the dormant graph's action.
        move: spteTurns[i]?.move,
        spteMessage: (spteTurns[i]?.ourReply ?? "").slice(0, 300) || undefined,
      },
      failures,
    };
  });
  return {
    caseId: gc.id,
    name: gc.name,
    pass: turns.every((t) => t.failures.length === 0),
    turns,
  };
}

/**
 * Default expectation for a turn frozen from a real conversation: what the
 * agent ACTUALLY did. `raw` is the next outbound whatsapp_messages row's meta.
 * Pure - unit-tested; the create-from-thread route feeds it.
 *
 * The `action` half gates the dormant graph engine. The `move` half is new
 * (Wave 3): when the source turn ran SPTE (meta.engine === "v3", stamped by
 * runSpteLiveTurn), the frozen case also asserts the PRIMARY engine's move.
 * (Since the W10 inversion the SPTE replay runs for every case regardless -
 * the move expectation decides what can FAIL, no longer what runs.)
 */
export function expectationFromOutbound(
  raw: { kind?: string; engine?: string; move?: string } | null | undefined
): GoldenExpect {
  const out: GoldenExpect = {};
  const action = (raw?.kind ?? "").replace(/^auto-/, "");
  if (action) out.action = action;
  if (raw?.engine === "v3") {
    // Old vocabulary ("close") normalizes to the current one; a string the
    // engine does not know is dropped rather than frozen into a case that can
    // never pass.
    const m = normalizeMove(raw.move);
    if (isMoveKind(m)) out.move = m;
  }
  return out;
}

export interface GoldenList {
  cases: GoldenCase[];
  /** The store answered nothing readable - the TRUTH about the suite is unknown. */
  storeError?: "unavailable";
}

/**
 * STRICT lister for the eval gate - "empty" and "unreadable" mean opposite
 * things here (sbSelectStrict, the same pattern the wa-guard budgets use).
 *
 * Selection is PINNED + WINDOWED: every coherence-seeded case (the twelve
 * authored guards, name-keyed "coherence: ") is ALWAYS in the replayed set
 * regardless of age; the newest-first MAX_CASES window applies to the
 * remainder. One window over everything let owner-frozen conversations evict
 * the authored guards silently - and the seeder is additive-only, so nothing
 * ever put them back.
 */
export async function listGoldenCasesStrict(onlyEnabled = true): Promise<GoldenList> {
  const { sbSelectStrict } = await import("../runtime-config");
  const filter = onlyEnabled ? "enabled=eq.true&" : "";
  const [pinnedRead, restRead] = await Promise.all([
    sbSelectStrict<GoldenCase>(
      "agent_golden_cases",
      `select=*&${filter}name=like.${COHERENCE_PREFIX}*&order=created_at.desc&limit=${MAX_CASES}`
    ),
    sbSelectStrict<GoldenCase>(
      "agent_golden_cases",
      `select=*&${filter}name=not.like.${COHERENCE_PREFIX}*&order=created_at.desc&limit=${MAX_CASES}`
    ),
  ]);
  // "missing" = the table has never been migrated: vacuously empty, a fresh
  // install must gate on nothing. "unavailable" = the truth is unknown, and a
  // gate that cannot know must refuse - the caller checks storeError.
  if (
    ("error" in pinnedRead && pinnedRead.error === "unavailable") ||
    ("error" in restRead && restRead.error === "unavailable")
  ) {
    return { cases: [], storeError: "unavailable" };
  }
  const pinned = "rows" in pinnedRead ? pinnedRead.rows : [];
  const rest = "rows" in restRead ? restRead.rows : [];
  return { cases: [...pinned, ...rest.slice(0, Math.max(0, MAX_CASES - pinned.length))] };
}

/** Soft lister for display surfaces (Admin list). NOT for gating - it collapses
 *  an unreadable store to [], which is exactly what a gate must not do. */
export async function listGoldenCases(onlyEnabled = true): Promise<GoldenCase[]> {
  return listGoldenCasesStrict(onlyEnabled)
    .then((r) => r.cases)
    .catch(() => []);
}

export async function runGoldenCase(
  gc: GoldenCase,
  opts: { spec?: GraphSpec; overlay?: PolicyOverlay } = {}
): Promise<ReplayCaseResult> {
  try {
    // Both engines replay the same frozen thread: the graph engine for the
    // action/edge assertions, SPTE - the one that actually answers shops - for
    // the move assertions.
    //
    // THE CANDIDATE GOES TO BOTH. replaySpteTurns used to run with no candidate
    // at all, so in the one column that gates production, baseline and
    // candidate agreed by construction - the gate could not fail there.
    //
    // W10 GATE INVERSION: SPTE replays for EVERY case, not only the ones that
    // assert a move. The old `wantsMove` skip meant a frozen conversation with
    // only action/target expectations never exercised the primary engine at
    // all - an SPTE crash on exactly that conversation sailed through the gate
    // while the dormant graph engine got full coverage. Expectations stay
    // opt-in (a move-less case cannot fail on a move it never asserted), but a
    // replay CRASH now fails the case whichever engine threw, because the
    // whole try/catch below treats it as a failed case. The extra replay per
    // case is the gate doing its one job; MAX_CASES bounds the bill.
    const [{ turns }, spte] = await Promise.all([
      replayConversation({
        turns: gc.turns,
        rfq: gc.rfq,
        region: gc.region ?? undefined,
        floor: gc.floor,
        spec: opts.spec,
        overlay: opts.overlay,
      }),
      replaySpteTurns({
        turns: gc.turns,
        rfq: gc.rfq,
        floor: gc.floor,
        spec: opts.spec,
        overlay: opts.overlay,
      }),
    ]);
    return evaluateCase(gc, turns, spte.turns);
  } catch (e) {
    return {
      caseId: gc.id,
      name: gc.name,
      pass: false,
      turns: [
        {
          turn: 0,
          expected: {},
          got: { action: "error", path: [] },
          failures: [`replay crashed: ${e instanceof Error ? e.message : String(e)}`],
        },
      ],
    };
  }
}

/**
 * Run the whole enabled suite against a candidate (or the live baseline when
 * no candidate is given). This IS the eval gate: activation requires
 * goldenGateBlocks(report) === null. An empty-but-READABLE suite passes
 * vacuously (with a note); an UNREADABLE store marks the report so every gate
 * fails closed - the suite used to answer "0 of 0, all green" to an outage.
 */
export async function runGoldenSuite(
  opts: { spec?: GraphSpec; overlay?: PolicyOverlay } = {}
): Promise<ReplayReport> {
  // The authored coherence seeds join the owner's frozen conversations in the
  // durable suite (idempotent, name-keyed - see golden-coherence.ts). A seed
  // failure never blocks the gate itself.
  try {
    const { ensureCoherenceGoldenCases } = await import("./golden-coherence");
    await ensureCoherenceGoldenCases();
  } catch {
    /* seeding is an enrichment - the gate runs on whatever is stored */
  }
  const list = await listGoldenCasesStrict(true);
  if (list.storeError) {
    return {
      ranAt: new Date().toISOString(),
      total: 0,
      passed: 0,
      cases: [],
      storeError: list.storeError,
      note: "The golden store could not be read - this report is not a verdict.",
    };
  }
  const results: ReplayCaseResult[] = [];
  for (const gc of list.cases) results.push(await runGoldenCase(gc, opts));
  return {
    ranAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    cases: results,
    ...(results.length === 0
      ? { note: "No golden cases exist yet - the gate passes vacuously and tightens as cases are frozen." }
      : {}),
  };
}

/**
 * THE gate verdict, in one place. Returns the human reason activation must be
 * refused, or null when the change may proceed. Every activation path (graph
 * save, ops rule, overlay save, rollback, coach, lesson/learning activation)
 * uses this instead of a local `total > 0 && passed < total` - which is the
 * exact shape that FAILED OPEN: an unreadable store reported total 0 and
 * approved anything.
 */
export function goldenGateBlocks(report: ReplayReport): string | null {
  if (report.storeError) {
    return (
      "The golden suite could not read its cases (store unavailable) - refusing to " +
      "activate a behavior change blind. Retry when the database is reachable."
    );
  }
  if (report.total > 0 && report.passed < report.total) {
    return `Golden suite failed (${report.passed}/${report.total}).`;
  }
  return null;
}
