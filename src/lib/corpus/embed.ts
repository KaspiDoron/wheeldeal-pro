import { createHash } from "crypto";
import { fnv1a32 } from "../copy/hash";

// THE EMBEDDER - two rungs, two model ids, and the id is the safety property.
//
// docs/VECTOR-SPEC.md section 6. Cosine between a hashed-lexical vector and a
// neural one is not merely inaccurate, it is MEANINGLESS - the two live in
// unrelated coordinate systems - and it does not fail loudly. Two independent
// random 768-dimensional unit vectors have cosine near 0 with a standard
// deviation of about 0.036, so a mixed pool returns plausible near-zero scores
// with occasional spurious highs. That is a silent wrong answer, which is the
// exact class this repo keeps hunting.
//
// So the two rungs carry DISTINCT model ids, every read filters
// `embed_model = <current>`, and the unique index includes embed_model. A
// cross-model comparison is not expressible through the interface rather than
// merely discouraged, and one source row can hold a lexical and a neural vector
// at once - the backfill upgrades lexical to neural by inserting a SECOND row,
// never by mutating the first, which makes a model rollback a filter change
// rather than a re-embed.

/** Every vector in the store is this wide; the SQL column is vector(768). */
export const EMBED_DIM = 768;

/** Gemini text-embedding-004 - 768 dims, which is why the column is 768. */
export const NEURAL_MODEL = "gemini:text-embedding-004";

/** The rate-limit counter name. Its config override key is AI_RPM_GEMINI_EMBED. */
export const EMBED_PROVIDER = "gemini_embed";

/** The keyless fallback. No key, no network, no failure mode. */
export const LEXICAL_MODEL = "lexical:v1";

/** Snippets are capped before hashing and before storage (spec section 2). */
export const SNIPPET_MAX = 1200;

export interface Embedding {
  model: string;
  vector: number[];
  dim: number;
}

/**
 * The text we actually embed and hash: trimmed, whitespace-collapsed, capped.
 *
 * Deliberately NOT `normalizeForSig` (copy/hash.ts), whose `[^a-z0-9 ]` class
 * deletes non-Latin script entirely - the same ASCII-only trap documented for
 * `wa/similarity.ts`. A Thai price line must survive into the corpus as Thai,
 * because a corpus that silently drops half the fleet's languages is worse than
 * no corpus at all.
 */
export function normalizeSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

/** The staleness key AND the skip key - never the identity (spec section 2). */
export function contentHash(text: string): string {
  return createHash("sha256").update(normalizeSnippet(text), "utf8").digest("hex");
}

/**
 * Character n-grams, script-agnostic.
 *
 * Character grams rather than word tokens on purpose: Thai and Lao are written
 * without spaces, so a word tokenizer returns one enormous token for a whole
 * sentence and every Thai reply collapses to the same vector.
 */
function grams(text: string, n = 3): string[] {
  const s = normalizeSnippet(text).toLowerCase();
  if (!s) return [];
  if (s.length <= n) return [s];
  const out: string[] = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
}

/**
 * The keyless rung: the hashing trick over character trigrams, L2-normalized.
 *
 * Deterministic by construction - the same string always produces byte-
 * identical output, on any runtime, with no state - which is what lets a golden
 * replay stay stable and what makes the "over-cap degrades to lexical" promise
 * free of a network call.
 *
 * fnv1a32 rather than a hand-rolled hash: the last hand-rolled djb2 in this
 * repo clustered so hard that a seeded 50/50 rule fired 100/0, which LOOKED
 * implemented and was inert. The sign uses a second, salted hash so the bucket
 * and the sign cannot correlate.
 *
 * Returns null for text with nothing to embed - an all-zero vector has no
 * direction, so cosine against it is 0/0, and storing one would be a row that
 * silently matches nothing while counting as embedded.
 */
export function lexicalEmbed(text: string): Embedding | null {
  const g = grams(text);
  if (g.length === 0) return null;
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (const gram of g) {
    const h = fnv1a32(gram);
    // The salt is written as an ESCAPE, never as the literal byte: a raw
    // control character makes the whole file binary to git diff, grep and
    // ripgrep (source-bytes.test.ts). \u0001 cannot occur in a trigram of
    // real message text, so the sign hash and the bucket hash never collide.
    const sign = fnv1a32(`${gram}\u0001sign`) & 1 ? 1 : -1;
    v[h % EMBED_DIM] += sign;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return null;
  for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
  return { model: LEXICAL_MODEL, vector: v, dim: EMBED_DIM };
}

/** Cosine over two vectors from the SAME model. Callers filter by model in SQL. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Own deadline, not the caller's: an embedding must never outlive its budget. */
const NEURAL_TIMEOUT_MS = 6_000;

/**
 * The neural rung. Returns null on ANY failure - no key, a non-2xx, a wrong
 * dimension, a hang - and every failure is a fall-through to lexical rather
 * than an error, because a corpus row that never arrives already means
 * "behave exactly as today".
 */
export async function neuralEmbed(text: string): Promise<Embedding | null> {
  const snippet = normalizeSnippet(text);
  if (!snippet) return null;
  const { getConfig } = await import("../runtime-config");
  const key = await getConfig("GEMINI_TOKEN");
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NEURAL_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${encodeURIComponent(
        key
      )}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "models/text-embedding-004",
          content: { parts: [{ text: snippet }] },
        }),
        signal: controller.signal,
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { embedding?: { values?: unknown } };
    const values = data.embedding?.values;
    if (!Array.isArray(values) || values.length !== EMBED_DIM) return null;
    const vector = values.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : 0));
    // A vector of the right LENGTH can still be all zeros or NaN-poisoned; a
    // direction-less vector matches nothing and would count as embedded.
    let norm = 0;
    for (const x of vector) norm += x * x;
    if (!(norm > 0)) return null;
    return { model: NEURAL_MODEL, vector, dim: EMBED_DIM };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The rung ladder, with the budget honored.
 *
 * `reserveAiCall` counts CALLS, not tokens, and has no per-kind carve-out, so
 * there is nothing to hide behind: an embedding costs a traveller exactly what
 * a composition call costs them. The mitigation is exact rather than argued -
 * on "over-cap" we take the lexical rung, which makes zero network calls and
 * needs no reservation. Over-cap degrades to lexical; lexical never degrades.
 *
 * The backfill runs from the cron, which has no scope, so `reserveAiCall`
 * returns "ungoverned" and the batch is charged to nobody. That is correct:
 * charging a traveller for a batch job would degrade their live negotiation to
 * pay for someone else's corpus.
 */
export async function embedText(text: string): Promise<Embedding | null> {
  if (!normalizeSnippet(text)) return null;
  const { reserveAiCall } = await import("../ai-budget");
  const reservation = await reserveAiCall().catch(() => "over-cap" as const);
  if (reservation === "over-cap") return lexicalEmbed(text);

  const { tryConsume, tryConsumeDay } = await import("../ai-rpm");
  // A counter DISTINCT from the chat `gemini` one on purpose: sharing would let
  // a backfill starve the negotiation chain, which is the wrong trade in every
  // case. And an entry in DEFAULT_RPM/DEFAULT_RPD is mandatory - ai-rpm returns
  // true for an unknown ceiling ("never our place to refuse"), so a counter
  // with no entry is ungoverned by construction.
  if (!tryConsume(EMBED_PROVIDER) || !tryConsumeDay(EMBED_PROVIDER)) return lexicalEmbed(text);

  return (await neuralEmbed(text)) ?? lexicalEmbed(text);
}

