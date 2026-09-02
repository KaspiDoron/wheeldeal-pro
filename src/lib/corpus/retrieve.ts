import { EMBED_DIM, cosine, embedText, lexicalEmbed, type Embedding } from "./embed";

// THE READ HALF. docs/VECTOR-SPEC.md sections 1 and 7.
//
// THE INVARIANT, and it is enforced by the SHAPE of these functions rather than
// by care:
//
//   Retrieval may NARROW the candidate set and REORDER it. It may never ADMIT
//   a candidate the caller did not already have, nor ASSERT a fact this thread
//   has not established.
//
// `rankBySimilarity` takes an array and returns a SUBSEQUENCE of it by object
// identity - a filter and a sort over the input, with no lookup by id and no
// second read. There is no path by which an object that was not already in the
// array can appear in the output, so "it admitted a rival" is not a bug that
// can be introduced here; it would have to be a different function.
//
// The assertion half is NOT enforced here and pretending otherwise would be the
// dishonest move. It is enforced downstream by the number-integrity rails - and
// by `stripNumbers`, because retrieval makes that axis actively HARDER: recency
// surfaces an arbitrary recent exemplar, while semantic retrieval surfaces the
// one MOST SIMILAR to this turn, which is precisely the one most likely to
// carry a plausible-looking wrong price for this vehicle in this region.

export interface Scored<T> {
  item: T;
  /** Cosine in [-1, 1]. Null when the item had no vector in this model space. */
  score: number | null;
}

/**
 * Rank items by cosine against a query vector, keeping the invariant.
 *
 * - The output is a SUBSEQUENCE of the input by object identity.
 * - An item with no vector scores `null` and is KEPT, in its original relative
 *   position among the other unscored items, after the scored ones. Refusing an
 *   unscored item would silently disable the whole feature the moment a
 *   backfill lagged, which is the failure mode this design exists to avoid.
 * - `minScore` drops weakly-related items. It can only ever REMOVE.
 * - A NaN or zero-length query vector ranks nothing and returns the input
 *   unchanged, because a direction-less query has no opinion.
 */
export function rankBySimilarity<T>(
  items: T[],
  query: number[] | null,
  vectorOf: (item: T) => number[] | null | undefined,
  opts: { minScore?: number; limit?: number } = {}
): Scored<T>[] {
  const usable =
    Array.isArray(query) && query.length === EMBED_DIM && query.every((x) => Number.isFinite(x));
  const scored: Scored<T>[] = items.map((item) => {
    if (!usable) return { item, score: null };
    const v = vectorOf(item);
    if (!Array.isArray(v) || v.length !== query!.length) return { item, score: null };
    const s = cosine(query!, v);
    return { item, score: Number.isFinite(s) ? s : null };
  });

  const min = opts.minScore;
  // A scored item below the floor is dropped. An UNSCORED one never is - it was
  // not measured, and "not measured" must not read as "not relevant".
  const kept = typeof min === "number" ? scored.filter((s) => s.score === null || s.score >= min) : scored;

  // Stable: scored items first by descending score, then the unscored ones in
  // their original order. Array.prototype.sort is stable in every runtime this
  // ships on, so equal scores keep the caller's ordering.
  const ordered = [...kept].sort((a, b) => {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });

  return typeof opts.limit === "number" ? ordered.slice(0, opts.limit) : ordered;
}

/**
 * The query vector for one turn.
 *
 * Uses the full rung ladder: neural when the budget and the key allow, the
 * keyless lexical vector otherwise. Whichever answered, its MODEL ID comes back
 * with it - and every comparison downstream filters on that id, so a lexical
 * query can never be scored against a neural corpus row. That is the safety
 * property, and it costs one field.
 *
 * Returns null when there is nothing to embed. Never throws.
 */
export async function queryVector(text: string): Promise<Embedding | null> {
  return embedText(text).catch(() => null);
}

/**
 * The FREE query vector: no network, no budget, no reservation, deterministic.
 *
 * For readers that must not add a single round trip or consume a traveller's
 * daily AI allowance. It can only ever be compared with `lexical:v1` rows.
 */
export function freeQueryVector(text: string): Embedding | null {
  return lexicalEmbed(text);
}

/** Every digit run becomes this, so a retrieved exemplar cannot carry a price. */
export const NUMBER_PLACEHOLDER = "#";

/**
 * Strip every number from a retrieved exemplar before it enters a prompt.
 *
 * THE ONE AXIS WHERE RETRIEVAL IS WORSE THAN RECENCY, paid for rather than
 * argued away (spec 9.2). Today's recency path shows the model an arbitrary
 * recent example; semantic retrieval shows it the most similar one - which for
 * a turn about a scooter in Krabi is the one most likely to contain a
 * confident, wrong, Krabi-shaped price. The prompt already asks the model not
 * to copy numbers, and a request to a language model is not a guarantee.
 *
 * So the numbers are not there to copy. Digits in every script are covered -
 * an Arabic-Indic or Thai numeral is still a price - and a run of digits with
 * separators inside it collapses to ONE placeholder rather than three, so
 * "1,500" does not read as three different numbers.
 */
export function stripNumbers(text: string): string {
  return text
    .replace(/[\d٠-٩۰-۹๐-๙][\d٠-٩۰-۹๐-๙.,' \s]*[\d٠-٩۰-۹๐-๙]|[\d٠-٩۰-۹๐-๙]/g, NUMBER_PLACEHOLDER)
    .replace(/\s+/g, " ")
    .trim();
}
