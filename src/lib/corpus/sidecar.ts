import "server-only";
import { sbInsertClaim, sbSelectDark, sbUpdate } from "../runtime-config";
import { corpusReady } from "./gate";
import {
  EMBED_DIM,
  LEXICAL_MODEL,
  NEURAL_MODEL,
  contentHash,
  embedText,
  normalizeSnippet,
} from "./embed";

// THE TWO WRITE STAGES. NO EMBEDDING CALL HAPPENS WHILE A SHOP IS WAITING.
//
// docs/VECTOR-SPEC.md section 5.
//
//   Stage A - hot enqueue, AFTER the reply is on the wire. One insert of a row
//             with embedding = null. No AI call, no vector arithmetic, no Redis.
//   Stage B - cold backfill on the /api/wa/ping cron, where the embedding calls
//             live. Bounded batch, bounded per-call, charged to nobody.
//
// An un-embedded row IS the queue entry - one mechanism, two invariants. That
// is also why `embedding` is nullable: a row with no vector is treated exactly
// as today rather than refused, so a lagging backfill can never disable
// anything downstream.

/** Below this much remaining turn we do not even try - the reply comes first. */
const MIN_TURN_REMAINING_MS = 2_000;

/** The hot hook's own ceiling. Every sb* helper's timedFetch is 8s, which is
 *  far too long to spend after a send, so the hook bounds itself. */
const ENQUEUE_CEILING_MS = 1_500;

/** How many rows one cold batch embeds. Keeps the spend per run bounded. */
export const BACKFILL_BATCH = 20;

/**
 * Race a promise against a deadline, resolving to `fallback` if it loses.
 *
 * The same shape `comprehension.ts` uses. The loser is NOT cancelled - it is
 * abandoned - which is correct here: a slow insert that lands after we stop
 * waiting still enqueues the row, and nothing downstream is watching.
 */
function withCeiling<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export type EnqueueOutcome =
  /** A new queue row now exists. */
  | "queued"
  /** This exact (model, table, id) was already enqueued. Nothing to do. */
  | "already"
  /** The gate is not ready, the text was empty, or the turn had no time. */
  | "skipped"
  /** The insert did not confirm. Never breadcrumbed - see below. */
  | "error";

export interface EnqueueArgs {
  sourceTable: string;
  sourceId: string;
  text: string;
  userEmail?: string | null;
  /** Milliseconds of turn left. Below MIN_TURN_REMAINING_MS we do not start. */
  remainingMs?: number;
}

/**
 * STAGE A. Enqueue one snippet for later embedding. Never throws.
 *
 * `sbInsertClaim`, NOT `sbInsert(..., onConflict)`: the onConflict path sends
 * `resolution=merge-duplicates`, which is an UPSERT, so a re-enqueue would
 * overwrite an already-computed vector with null. A claim is a plain insert
 * whose 409 is reported as "lost" - which here means precisely "already
 * enqueued, nothing to do". The unique index on
 * (embed_model, source_table, source_id) is what produces that 409, so it is
 * load-bearing rather than hygiene.
 *
 * The queue row is stamped with the NEURAL model id, because that is what the
 * backfill will try first; if it has to fall back, the backfill rewrites the
 * model on the row it fills.
 *
 * It never breadcrumbs on "error". `sbInsertClaim` folds a missing table into
 * "error" along with every network failure, so an error here cannot be read as
 * a migration signal - that is the gate's job, and the gate has already run.
 */
export async function enqueueCorpus(args: EnqueueArgs): Promise<EnqueueOutcome> {
  const snippet = normalizeSnippet(args.text);
  if (!snippet || !args.sourceId) return "skipped";
  if (args.remainingMs !== undefined && args.remainingMs < MIN_TURN_REMAINING_MS) return "skipped";

  return withCeiling(
    (async (): Promise<EnqueueOutcome> => {
      // The gate probe is a network read too, so it lives INSIDE the ceiling.
      if ((await corpusReady()) !== "ready") return "skipped";
      const res = await sbInsertClaim("corpus_embeddings", {
        source_table: args.sourceTable,
        source_id: args.sourceId,
        embed_model: NEURAL_MODEL,
        content_hash: contentHash(snippet),
        snippet,
        dim: EMBED_DIM,
        embedding: null,
        user_email: args.userEmail ?? null,
      }).catch(() => "error" as const);
      return res === "won" ? "queued" : res === "lost" ? "already" : "error";
    })(),
    ENQUEUE_CEILING_MS,
    "skipped"
  ).catch(() => "error" as const);
}

export interface BackfillResult {
  /** Rows this batch turned into vectors. */
  embedded: number;
  /** Rows read but not written back (embedder returned nothing, or the write
   *  lost the race to a concurrent sweep). */
  skipped: number;
  /** Why nothing happened, when nothing happened. */
  reason?: "not-ready" | "unreadable" | "empty";
}

/**
 * STAGE B. Embed one bounded batch of queued rows. Never throws.
 *
 * Reads with `sbSelectDark`, which returns [] for a missing table and null for
 * an unreadable one - so an outage is not mistaken for an empty queue and the
 * sweep does not report a cheerful "nothing to do" while the database is down.
 *
 * Writes back filtered on `embedding=is.null` so two concurrent sweeps cannot
 * double-write the same row: whoever arrives second matches nothing.
 *
 * Runs from the cron, which has no user scope, so `reserveAiCall` returns
 * "ungoverned" and the batch is charged to nobody. Charging a traveller for a
 * batch job would degrade their live negotiation to pay for someone else's
 * corpus.
 */
export async function runCorpusBackfill(batch = BACKFILL_BATCH): Promise<BackfillResult> {
  if ((await corpusReady()) !== "ready") return { embedded: 0, skipped: 0, reason: "not-ready" };

  const rows = await sbSelectDark<{ id: number; snippet: string | null }>(
    "corpus_embeddings",
    `select=id,snippet&embedding=is.null&order=created_at.asc&limit=${batch}`
  ).catch(() => null);
  if (rows === null) return { embedded: 0, skipped: 0, reason: "unreadable" };
  if (rows.length === 0) return { embedded: 0, skipped: 0, reason: "empty" };

  let embedded = 0;
  let skipped = 0;
  for (const row of rows) {
    const text = (row.snippet ?? "").trim();
    if (!text) {
      skipped++;
      continue;
    }
    const vec = await embedText(text).catch(() => null);
    if (!vec) {
      skipped++;
      continue;
    }
    // The filter is the concurrency control: a row another sweep already filled
    // no longer matches `embedding=is.null`, so this patch touches nothing.
    const ok = await sbUpdate("corpus_embeddings", `id=eq.${row.id}&embedding=is.null`, {
      embedding: vec.vector,
      embed_model: vec.model,
      dim: vec.dim,
    }).catch(() => false);
    if (ok) embedded++;
    else skipped++;
  }

  if (embedded > 0) {
    const { noteAgentEvent } = await import("../events");
    await noteAgentEvent({
      kind: "corpus-backfill",
      userEmail: "",
      toNumber: "",
      detail: JSON.stringify({ embedded, skipped, read: rows.length }),
    }).catch(() => false);
  }
  return { embedded, skipped };
}

/** Re-exported so callers need one import for the model ids they filter on. */
export { LEXICAL_MODEL, NEURAL_MODEL };
