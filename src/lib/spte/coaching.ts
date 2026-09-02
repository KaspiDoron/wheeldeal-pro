// Coaching block for the PRIMARY (SPTE) engine.
//
// The graph engine already learns: it injects `agent_training` few-shot via
// composeBargain (agents.ts) and the compiled `ops_learning` exemplars via the
// director. SPTE - the LIVE primary engine - historically injected NEITHER, so
// the path that actually runs in production was the weaker learner. This closes
// that gap by assembling ONE compact coaching string from the SAME durable
// stores, so every SPTE turn benefits from owner teaching, Ops-Center review
// learning, AND the auto-distilled exemplars mined from winning traces
// (source:"distilled", written by src/lib/distill.ts).
//
// TONE-ONLY: the wording enforces "imitate tone/tactics, never copy a number";
// SPTE's post-rails checkOutboundNumbers still rejects any fabricated figure.
// Best-effort: returns "" on any failure so a turn never breaks on coaching.
//
// SEMANTIC SELECTION (docs/VECTOR-SPEC.md phase 2). The ordering used to be
// pure RECENCY inside a coarse pre-filter, so the most relevant lesson this
// repo had ever been taught lost its place to whatever was written last. The
// corpus can now rank the SAME candidates by similarity to the turn in hand.
//
// Three things make that safe rather than clever:
//
//   1. It only ever REORDERS AND TRIMS the candidates the pre-filter already
//      chose. Retrieval cannot introduce an exemplar - `rankBySimilarity`
//      returns a subsequence of its input by object identity.
//   2. The candidates (four PostgREST reads) stay cached; only the ORDERING is
//      per-turn, and that is pure CPU on <=10 short strings. A per-turn vector
//      scan would be ~12 KB a row against a 5 GB monthly egress ceiling.
//   3. Retrieved exemplars are NUMBER-STRIPPED. Recency shows the model an
//      arbitrary recent example; similarity shows it the one most like this
//      turn - which for a Krabi scooter is the one most likely to carry a
//      confident, wrong, Krabi-shaped price. On the one axis where retrieval
//      makes hallucination MORE likely, this path ships strictly safer than
//      the status quo it replaces.
//
// With the corpus off (no pgvector) there is no query vector, nothing is
// scored, and the order is exactly today's recency order.

import "server-only";
import { sbSelect } from "../runtime-config";
import { getOpsLearning } from "../ops/learning";
import { freeQueryVector, rankBySimilarity, stripNumbers } from "../corpus/retrieve";

/** The CANDIDATES are cached (the expensive part: four PostgREST reads). The
 *  ranking is not - it is per-turn by construction. */
const cache = new Map<string, { lessons: string[]; examples: string[]; exp: number }>();
const TTL_MS = 30_000;

/** How many exemplars survive into the prompt. Unchanged from the recency era. */
const MAX_EXAMPLES = 5;

/** Below this cosine an exemplar is not "similar", it is just present. */
const MIN_RELEVANCE = 0.15;

/**
 * @param situation What is actually on screen this turn (menu open? photo
 * arrived? shop asked our location?). Owner LESSONS filed under the matching
 * label are retrieved for this turn only - a correction about price boards is
 * useless noise on a turn with no photo in it, and the prompt budget is small.
 * Omit it and only the global tone block is loaded, as before.
 * @param relevantTo The shop text this turn is answering. When given AND the
 * corpus is on, the exemplars are ordered by similarity to it and stripped of
 * numbers. When absent, or with no vector available, the order is exactly the
 * recency order this function has always produced.
 */
export async function loadCoaching(
  situation?: import("../ops/misread").MisreadKind[],
  relevantTo?: string
): Promise<string> {
  const { lessons, examples } = await loadCandidates(situation);
  return assemble(lessons, examples, relevantTo);
}

/** The cached half: the four reads, keyed by situation. Never throws. */
async function loadCandidates(
  situation?: import("../ops/misread").MisreadKind[]
): Promise<{ lessons: string[]; examples: string[] }> {
  // Keyed by situation: two different turns must not share one cached block.
  const kinds = [...new Set(situation ?? [])].sort();
  const key = kinds.join(",");
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return { lessons: hit.lessons, examples: hit.examples };
  let lessonTexts: string[] = [];
  let examples: string[] = [];
  try {
    // SITUATIONAL LESSONS first - they are the most specific thing we know
    // about this exact turn, and they are what the owner filed to fix it.
    const lessons = kinds.length
      ? await sbSelect<{ text: string }>(
          "agent_training",
          `select=text&source=eq.ops-lesson&note=in.(${kinds
            .map((k) => `"lesson:${k}"`)
            .join(",")})&order=created_at.desc&limit=3`
        ).catch(() => [])
      : [];
    // Priority: DISTILLED (auto-mined from winning DeepSeek/free traces) ->
    // owner Ops exemplars/corrections -> hand-taught transcripts.
    const [distilled, ops, classic] = await Promise.all([
      sbSelect<{ text: string }>(
        "agent_training",
        "select=text&source=eq.distilled&order=created_at.desc&limit=3"
      ).catch(() => []),
      sbSelect<{ text: string }>(
        "agent_training",
        "select=text&source=in.(ops-exemplar,ops-correction)&order=created_at.desc&limit=2"
      ).catch(() => []),
      sbSelect<{ text: string }>(
        "agent_training",
        "select=text&source=not.in.(ops-exemplar,ops-correction,distilled)&order=created_at.desc&limit=2"
      ).catch(() => []),
    ]);
    const learning = await getOpsLearning().catch(() => null);
    const exemplars = learning?.directorExemplars ?? [];

    const seen = new Set<string>();
    for (const t of [
      ...distilled.map((r) => r.text),
      ...ops.map((r) => r.text),
      ...exemplars,
      ...classic.map((r) => r.text),
    ]) {
      const clean = (t ?? "").replace(/\s+/g, " ").trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        examples.push(clean.slice(0, 280));
      }
      // A SMALL POOL, not the final five. The cut to MAX_EXAMPLES now happens
      // after ranking, so relevance decides which five survive rather than
      // recency deciding it before relevance is ever consulted. The pool stays
      // tight because the ranking is per-turn CPU and the reads are capped.
      if (examples.length >= 10) break;
    }
    lessonTexts = lessons
      .map((l) => (l.text ?? "").replace(/\s+/g, " ").trim().slice(0, 320))
      .filter((l) => l.length > 3);
  } catch {
    lessonTexts = [];
    examples = [];
  }
  cache.set(key, { lessons: lessonTexts, examples, exp: Date.now() + TTL_MS });
  return { lessons: lessonTexts, examples };
}

/**
 * The per-turn half: rank, strip, format. Pure CPU, no IO, never throws.
 *
 * The ranking is the ONLY thing `relevantTo` changes. It cannot add an
 * exemplar, cannot reach the database, and cannot run at all when there is no
 * query vector - which is the state of every deployment with pgvector off.
 */
function assemble(lessonTexts: string[], examplePool: string[], relevantTo?: string): string {
  let examples = examplePool;
  let ranked = false;
  const query = (relevantTo ?? "").trim();
  // `> 0`, NOT `> 1`. Gating on a pool of two coupled the number-STRIPPING to
  // whether there was anything to reorder - so a single-exemplar pool went to
  // the model with its prices intact, on exactly the retrieval path that
  // raises the odds of a tempting wrong price being copied. One exemplar
  // selected for this turn is still a selection.
  if (query && examplePool.length > 0) {
    try {
      // The FREE lexical vector: no network, no key, no budget, no reservation,
      // and no round trip on the reply path. Both sides are embedded here and
      // now, so they are in one space by construction and the corpus is not
      // even consulted - a neural query against a lexical exemplar is not
      // expressible through this code path.
      const q = freeQueryVector(query);
      if (q) {
        const withVectors = examplePool.map((text) => ({ text, v: freeQueryVector(text)?.vector ?? null }));
        const out = rankBySimilarity(withVectors, q.vector, (x) => x.v, {
          minScore: MIN_RELEVANCE,
          limit: MAX_EXAMPLES,
        });
        // Ranking must never EMPTY the block: an over-tight floor would be a
        // silent regression from "five recent exemplars" to none at all.
        if (out.length > 0) {
          examples = out.map((s) => s.item.text);
          ranked = true;
        }
      }
    } catch {
      /* ranking is an optimisation - the recency order is always valid */
    }
  }
  examples = examples.slice(0, MAX_EXAMPLES);

  const blocks: string[] = [];
  if (lessonTexts.length) {
    // Stated as RULES, not style: these are corrections about how to READ a
    // shop, and they must survive the "imitate the tone only" framing below.
    // NOT number-stripped: a lesson like "a 7-day quote is not a daily rate"
    // is ABOUT the number, and the owner wrote it deliberately.
    blocks.push(
      "WHAT THE OWNER TAUGHT US ABOUT SITUATIONS LIKE THIS ONE - follow it:\n" +
        lessonTexts.map((l) => `- ${l}`).join("\n")
    );
  }
  if (examples.length) {
    // NUMBER-STRIPPED WHEN RANKED, and only then. Retrieval is what raises the
    // odds that a tempting wrong price is in the window, so the path that
    // introduces the risk is the path that pays for it. The unranked recency
    // order keeps its historical bytes exactly, so nothing about today's
    // behaviour changes on a deployment with the corpus off.
    const shown = ranked ? examples.map(stripNumbers).filter(Boolean) : examples;
    if (shown.length) {
      blocks.push(
        "LEARNED STYLE (imitate the TONE + tactics only - NEVER copy any number or place name):\n" +
          shown.map((e) => `- ${e}`).join("\n")
      );
    }
  }
  return blocks.join("\n\n").slice(0, 1400);
}

/** Test/hook: drop the cache so a fresh distillation shows up immediately. */
export function bustCoachingCache(): void {
  cache.clear();
}
