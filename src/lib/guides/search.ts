// SEARCH OVER THE GUIDES - the organic results on /search.
//
// This exists because a results page has to BE one. Google's policy for search
// ads is explicit that they may only appear beside real results for a query
// the visitor actually made, and that the ads must never outnumber the
// results. So /search is a genuine search of this site's own articles, and the
// number it returns is what caps how many ads may be requested - zero results,
// zero ads.
//
// Deliberately small: twenty in-memory documents do not need an index. Scoring
// is per-field term frequency with a title weight, which is enough to put "the
// Thailand price guide" first for "thailand scooter price" and to return
// NOTHING for a query the site has nothing to say about - which matters more
// here than recall does, because an irrelevant result is a fake result.

import { GUIDES, guideText, type Guide } from "./index";

export interface GuideHit {
  slug: string;
  title: string;
  summary: string;
  excerpt: string;
  score: number;
}

export const SEARCH_QUERY_MAX = 120;

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "in", "is", "it",
  "me", "my", "of", "on", "or", "the", "to", "what", "when", "where", "which", "who", "why", "with", "you", "your",
]);

/** Lowercase word stems: strips a plural `s` so "scooters" finds "scooter". */
export function tokens(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Trim and bound a raw `q` parameter. Returns "" for anything unusable. */
export function cleanQuery(raw: unknown): string {
  const q = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return q.length > SEARCH_QUERY_MAX ? q.slice(0, SEARCH_QUERY_MAX).trim() : q;
}

interface Indexed {
  guide: Guide;
  title: string[];
  summary: string[];
  headings: string[];
  body: string[];
  /** Real prose sentences an excerpt may quote - see `proseOf`. */
  sentences: string[];
}

let index: Indexed[] | null = null;

/**
 * The sentences an excerpt may quote: paragraphs, callouts and FAQ ANSWERS.
 *
 * Not `guideText()`. That is every visible word joined with spaces, which is
 * right for counting and wrong for quoting: a title has no full stop, so
 * "title summary first-sentence" split as ONE sentence, and every result's
 * excerpt opened with its own title said twice. (Found by looking at a
 * screenshot - no assertion about length or overflow could have seen it.)
 * Headings, table cells, list fragments and FAQ questions are left out for the
 * same reason: they are labels, not sentences that explain a match.
 */
function proseOf(guide: Guide): string[] {
  const blocks: string[] = [];
  for (const section of guide.sections) {
    for (const b of section.blocks) if (b.kind === "p" || b.kind === "callout") blocks.push(b.text);
  }
  for (const f of guide.faq ?? []) blocks.push(f.a);
  return blocks.flatMap((text) => text.split(/(?<=[.!?])\s+/)).filter((x) => x.length >= 40 && x.length <= 320);
}

function build(): Indexed[] {
  return GUIDES.map((guide) => ({
    guide,
    title: tokens(guide.title),
    summary: tokens(guide.summary),
    headings: tokens(guide.sections.map((s) => s.heading).join(" ")),
    body: tokens(guideText(guide)),
    sentences: proseOf(guide),
  }));
}

function count(haystack: string[], needle: string): number {
  let n = 0;
  for (const w of haystack) if (w === needle) n++;
  return n;
}

/** The sentence that best shows WHY this guide matched; the summary if none does. */
function excerptFor(doc: Indexed, terms: string[]): string {
  let best = doc.guide.summary;
  let bestHits = 0;
  for (const s of doc.sentences) {
    const words = new Set(tokens(s));
    const hits = terms.filter((t) => words.has(t)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = s;
    }
  }
  return best.length > 220 ? `${best.slice(0, 217).trimEnd()}...` : best;
}

export function searchGuides(rawQuery: string, limit = 8): GuideHit[] {
  const terms = [...new Set(tokens(cleanQuery(rawQuery)))];
  if (terms.length === 0) return [];
  index ??= build();

  const hits: GuideHit[] = [];
  for (const doc of index) {
    let score = 0;
    let matched = 0;
    let strong = 0;
    for (const t of terms) {
      const inStrong = count(doc.title, t) * 8 + count(doc.summary, t) * 4 + count(doc.headings, t) * 3;
      const inBody = count(doc.body, t);
      // A WORD IN PASSING IS NOT A MATCH. Two thousand words about scooters
      // contain "new" and "cheap" somewhere, and counting those made "cheap
      // flights to new york" return four guides. A term counts when the guide
      // says it in a title, a summary or a heading - or keeps saying it.
      if (inStrong > 0 || inBody >= 3) matched++;
      if (inStrong > 0) strong++;
      score += inStrong + Math.min(inBody, 12) * 0.5;
    }
    // MOST OF THE QUERY HAS TO BE ABOUT THE GUIDE, and at least one word of it
    // has to be what the guide is headlined as. A results page padded with
    // coincidences exists to justify ads, which is the exact thing the policy
    // forbids - so the honest answer to an off-topic query is an empty list.
    if (strong === 0 || matched / terms.length < 0.5) continue;
    hits.push({
      slug: doc.guide.slug,
      title: doc.guide.title,
      summary: doc.guide.summary,
      excerpt: excerptFor(doc, terms),
      score: score * (matched / terms.length),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
