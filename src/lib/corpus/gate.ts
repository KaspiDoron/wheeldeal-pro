import "server-only";
import { tableReady, type SchemaState } from "../schema-probe";
import { sbCountDark, sbSelectDark } from "../runtime-config";
import { LEXICAL_MODEL, NEURAL_MODEL } from "./embed";

// THE RUNTIME GATE, AND THE HONEST DEPTH READ.
//
// docs/VECTOR-SPEC.md section 4. Three states, and the third is the whole
// point: "unknown" is not "no". A database that did not answer must not be
// mistaken for one that has not been migrated, or an outage becomes a
// permanent-looking migration signal in the owner's face.
//
//   ready       - pgvector is installed and schema.sql has been re-run.
//   missing     - the table (or a column of it) is not there. The feature is
//                 off, everything behaves exactly as it does today, and we
//                 breadcrumb ONCE so the health tile can name the remedy.
//   unavailable - Supabase did not answer. Feature off, and NO breadcrumb: an
//                 outage is not a migration signal.
//
// tableReady caches a positive FOR EVER and a negative for NEGATIVE_TTL_MS
// (60s), which is what lets the owner paste the SQL and have the feature switch
// itself on WITHOUT A REDEPLOY.

/**
 * A COLUMN-level probe, not just a table-level one.
 *
 * `tableReady` documents "the table or column does not exist" for `missing`, so
 * naming the columns is what makes a half-applied paste read `missing` rather
 * than a confident `ready` that then 400s on every write.
 */
const PROBE_COLUMNS = "id,embed_model,embedding";

/** The one breadcrumb kind. It gates its own re-attempt (see below). */
export const CORPUS_GATE_KIND = "corpus-gate-missing";

/**
 * Breadcrumb ONCE, not on every turn.
 *
 * The trap is named in `retention.ts`: a database missing the thing would
 * otherwise re-attempt and re-breadcrumb on every single ping, because the
 * thing that would have gated it is the row the missing thing never wrote. So
 * the gate row gates itself - we look for a prior breadcrumb before writing
 * one, and an unreadable event store means we simply do not write (an outage
 * must not manufacture breadcrumbs either).
 */
async function breadcrumbOnce(): Promise<void> {
  const seen = await sbSelectDark<{ id: number }>(
    "agent_events",
    `select=id&kind=eq.${CORPUS_GATE_KIND}&limit=1`
  ).catch(() => null);
  if (seen === null || seen.length > 0) return;
  const { noteAgentEvent } = await import("../events");
  await noteAgentEvent({
    // THE LITERAL IS DELIBERATE, not sloppiness. events-reconcile.test.ts
    // proves every registered kind has a real writer by scanning for a
    // value-position string literal; `kind: CORPUS_GATE_KIND` is invisible to
    // that scan, so a constant here would let the registry row read as a claim
    // nothing fulfils. The constant stays for the READ filter above, and
    // gate.test.ts pins the two together so they cannot drift.
    kind: "corpus-gate-missing",
    userEmail: "",
    toNumber: "",
    detail: JSON.stringify({
      reason:
        "corpus_embeddings not found - semantic retrieval is OFF. Enable the pgvector extension (Supabase -> Database -> Extensions -> vector) and re-run supabase/schema.sql.",
    }),
  }).catch(() => false);
}

/**
 * Is the corpus sidecar usable right now?
 *
 * Never throws. Callers treat anything but "ready" as "behave exactly as
 * today" - which is the same behaviour the whole feature degrades to, so a
 * missing table is a no-op rather than an error path.
 */
export async function corpusReady(): Promise<SchemaState> {
  let state: SchemaState;
  try {
    state = await tableReady("corpus_embeddings", PROBE_COLUMNS);
  } catch {
    return "unavailable";
  }
  if (state === "missing") await breadcrumbOnce();
  return state;
}

export interface CorpusDepth {
  /** The gate's own answer, so the tile can say WHY it is empty. */
  state: SchemaState;
  /** Rows enqueued but not yet embedded. Null = the store could not be read. */
  queued: number | null;
  /** Rows carrying a neural vector. Null = unreadable. */
  neural: number | null;
  /** Rows carrying the keyless lexical vector. Null = unreadable. */
  lexical: number | null;
}

/**
 * What the owner reads before saying phase 2 may start.
 *
 * Every count is `sbCountDark`, so an unreadable store reports null rather than
 * a confident zero. A corpus tile that says "0 embedded" during an outage would
 * be indistinguishable from one that says it because nothing has run - and the
 * whole point of this surface is to answer exactly that question.
 */
export async function corpusDepth(): Promise<CorpusDepth> {
  const state = await corpusReady();
  if (state !== "ready") return { state, queued: null, neural: null, lexical: null };
  const [queued, neural, lexical] = await Promise.all([
    sbCountDark("corpus_embeddings", "embedding=is.null"),
    sbCountDark("corpus_embeddings", `embed_model=eq.${encodeURIComponent(NEURAL_MODEL)}&embedding=not.is.null`),
    sbCountDark("corpus_embeddings", `embed_model=eq.${encodeURIComponent(LEXICAL_MODEL)}&embedding=not.is.null`),
  ]);
  return { state, queued, neural, lexical };
}
