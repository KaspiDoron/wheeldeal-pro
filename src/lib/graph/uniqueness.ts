// Global message uniqueness - at hundreds of users, no two shops may ever
// receive the same sentence, even across DIFFERENT users. The per-thread
// dedupe (guardOutbound) and the per-user anti-repetition list already exist;
// this is the cross-user layer: a trigram-overlap check against the app's
// recent outbound messages, with a deterministic re-variation fallback when a
// draft collides.

function trigrams(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const words = norm.split(" ").filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i < words.length - 2; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  // Very short messages: fall back to word bigrams so they still compare.
  if (grams.size === 0) {
    for (let i = 0; i < words.length - 1; i++) grams.add(`${words[i]} ${words[i + 1]}`);
  }
  return grams;
}

export function trigramOverlap(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  if (ga.size === 0 || gb.size === 0) {
    return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  }
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / Math.min(ga.size, gb.size);
}

const EMOJI_POOL = ["🙂", "🙏", "🤙", "😊", "🫶", "👌", "🤝"];
const OPENER_SWAPS: [RegExp, string[]][] = [
  [/^okay\b/i, ["Ok", "Alright", "Sounds good", "Got it"]],
  [/^ok\b/i, ["Okay", "Alright", "Cool", "Got it"]],
  [/^great\b/i, ["Nice", "Perfect", "Awesome", "Sounds good"]],
  [/^thanks\b/i, ["Thank you", "Appreciate it", "Thanks a lot", "Ta"]],
];

/**
 * THE SKELETON PASS (audit F112). Both similarity metrics - trigrams() above
 * and normalizeForSig()/shingles() in copy/hash.ts - lowercase the text and
 * delete everything that is not a letter, a digit or a space. An emoji swap
 * and a punctuation jitter are therefore INVISIBLE to the very scores that
 * triggered the re-variation, so the old mutation could never resolve a
 * collision: it only made the bytes differ.
 *
 * These are meaning-preserving phrase swaps - the same sentence in different
 * WORDS, which is the only thing the metrics count. Each rule lists every form
 * it knows, and the picker chooses one that is not the form already present,
 * so no two rules can undo each other inside one pass. Nothing here touches a
 * numeral, a currency or the vehicle class: the price, the duration and the
 * rival citation are the message, and a re-variation that moved one would be a
 * lie on the wire. The numeral guard below enforces that structurally.
 */
const REWRITES: [RegExp, readonly string[]][] = [
  [/\b(any chance|is there any way|any way)\b/i, ["any chance", "is there any way", "any way"]],
  [
    /\b(could you|can you|would you be able to)\b/i,
    ["could you", "can you", "would you be able to"],
  ],
  [/\b(a day|per day|each day)\b/i, ["a day", "per day", "each day"]],
  [/\b(best price|best rate|lowest price)\b/i, ["best price", "best rate", "lowest price"]],
  [
    /\b(the best you can do|the lowest you can go|the lowest you can do)\b/i,
    ["the best you can do", "the lowest you can go", "the lowest you can do"],
  ],
  [/\b(right now|today|straight away)\b/i, ["right now", "today", "straight away"]],
  [/\b(i am|i'm)\b/i, ["I am", "I'm"]],
  [/\b(i would|i'd)\b/i, ["I would", "I'd"]],
  [/\b(what is|what's)\b/i, ["what is", "what's"]],
  [/\b(it is|it's)\b/i, ["it is", "it's"]],
  [/\b(quoted|offered|is asking)\b/i, ["quoted", "offered", "is asking"]],
  [
    /\b(another shop|a nearby shop|another place)\b/i,
    ["another shop", "a nearby shop", "another place"],
  ],
  [/\b(the same|an identical|the very same)\b/i, ["the same", "an identical", "the very same"]],
  [/\b(comparing|checking|looking at)\b/i, ["comparing", "checking", "looking at"]],
  [/\b(a few|a couple of|a handful of)\b/i, ["a few", "a couple of", "a handful of"]],
  [/\b(deliver|bring it over)\b/i, ["deliver", "bring it over"]],
  [/\b(to the hotel|to my hotel)\b/i, ["to the hotel", "to my hotel"]],
  [/\b(that cost|that come to|that run to)\b/i, ["that cost", "that come to", "that run to"]],
  [
    /\b(book with you|take it with you|go ahead with you)\b/i,
    ["book with you", "take it with you", "go ahead with you"],
  ],
  [
    /\b(match that|do the same|come down to that)\b/i,
    ["match that", "do the same", "come down to that"],
  ],
  [/\b(hi|hello|hey)\b/i, ["Hi", "Hello", "Hey"]],
  [/\b(please|if possible|if you can)\b/i, ["please", "if possible", "if you can"]],
  [/\b(thanks|thank you|much appreciated)\b/i, ["thanks", "thank you", "much appreciated"]],
  [/\b(any room|any flexibility|any movement)\b/i, ["any room", "any flexibility", "any movement"]],
  [/\b(what deposit|how much deposit)\b/i, ["what deposit", "how much deposit"]],
  [/\b(do you need|do you take|do you want)\b/i, ["do you need", "do you take", "do you want"]],
];

/** How many skeleton swaps one re-variation attempt makes. Three is what it
 * takes to push a 15-20 word draft under the 0.75 trigram threshold (each swap
 * kills the three trigrams that contain it), and few enough that the sentence
 * still reads like one person wrote it. */
const MAX_REWRITES = 3;

/** Every numeral in the text, in order - the re-variation's own rail. */
function numeralsOf(s: string): string {
  return (s.match(/\d+(?:[.,]\d+)?/g) ?? []).join("|");
}

/** Capitalization of the form we are replacing, carried onto the new one.
 * "I"/"I'm" is the pronoun and is always capital, wherever it sits. */
function matchCase(src: string, alt: string): string {
  if (/^I\b|^I'/.test(alt)) return alt;
  const head = src.charAt(0);
  const upper = /[A-Z]/.test(head);
  return upper ? alt.charAt(0).toUpperCase() + alt.slice(1) : alt.charAt(0).toLowerCase() + alt.slice(1);
}

/** A form from the pool that is not the one already in the text. */
function pickAlt(match: string, pool: readonly string[], rng: () => number): string | null {
  const cands = pool.filter((p) => p.toLowerCase() !== match.toLowerCase());
  if (!cands.length) return null;
  return cands[Math.floor(rng() * cands.length) % cands.length];
}

/** Seeded visiting order over the rule table (Fisher-Yates on the rng). */
function seededOrder(n: number, rng: () => number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    const t = idx[i];
    idx[i] = idx[j];
    idx[j] = t;
  }
  return idx;
}

/** Seeded variant of revary (Module 4): deterministic given an rng, so the
 * compiler's collision re-variation is replayable and unit-testable. */
export function revarySeeded(text: string, rng: () => number): string {
  let out = text;
  // The opener is claimed first, and the skeleton pass below never reaches back
  // into it - rewriting "Thanks a lot" a second time produced "Much appreciated
  // a lot".
  let openerEnd = 0;
  for (const [rx, pool] of OPENER_SWAPS) {
    if (rx.test(out)) {
      const swap = pool[Math.floor(rng() * pool.length)];
      out = out.replace(rx, swap);
      openerEnd = swap.length;
      break;
    }
  }
  // The pass the metrics can actually see.
  let applied = 0;
  for (const i of seededOrder(REWRITES.length, rng)) {
    if (applied >= MAX_REWRITES) break;
    const [rx, pool] = REWRITES[i];
    const m = rx.exec(out.slice(openerEnd));
    if (!m) continue;
    const at = openerEnd + m.index;
    const alt = pickAlt(m[0], pool, rng);
    if (!alt) continue;
    const next = out.slice(0, at) + matchCase(m[0], alt) + out.slice(at + m[0].length);
    // THE RAIL: a re-variation may never move a price, a duration or any other
    // numeral. If it did, drop the swap and keep looking.
    if (numeralsOf(next) !== numeralsOf(out)) continue;
    out = next;
    applied++;
  }
  // Cosmetic tail: the emoji jitter. Kept because the wire likes it, but it is
  // no longer mistaken for a re-variation - both metrics strip it.
  const emojiRx = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const fresh = EMOJI_POOL[Math.floor(rng() * EMOJI_POOL.length)];
  out = emojiRx.test(out) ? out.replace(emojiRx, fresh) : `${out} ${fresh}`;
  if (rng() < 0.4) out = out.replace(/!$/, ".");
  return out;
}

/** Deterministic mutation used when a draft collides globally. Seeded by the
 * text itself - never Math.random - so a re-parked send recomposes the same
 * bytes it was guarded on. */
export function revary(text: string): string {
  return revarySeeded(text, mulberry32(fnv1a32(text)));
}

export interface FreshnessVerdict {
  text: string;
  /** The draft was re-varied AND the collision it collided on is gone. This is
   * what the Ops trace calls "re-varied", so it may never be asserted for a
   * mutation that did not move the score (audit F112). */
  changed: boolean;
  /** The text was mutated at all - true even when the collision survived, so
   * the trace can say "collision unresolved" instead of claiming a fix. */
  mutated: boolean;
  maxOverlap: number;
}

/**
 * Ensure the draft is globally fresh: compare against the app's recent
 * outbound bodies (ALL users); above the threshold, mutate deterministically
 * up to 3 times until it clears (or ship the best attempt - a near-miss after
 * mutation still hashes differently thanks to humanizeVariant downstream).
 */
export function ensureGloballyFresh(
  draft: string,
  recentGlobal: string[],
  threshold = 0.75
): FreshnessVerdict {
  let text = draft;
  let mutated = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let max = 0;
    for (const prior of recentGlobal) {
      const o = trigramOverlap(text, prior);
      if (o > max) max = o;
      if (max >= 1) break;
    }
    // Below the threshold: whatever mutation got us here really did re-vary.
    if (max < threshold) return { text, changed: mutated, mutated, maxOverlap: max };
    text = revary(text);
    mutated = true;
  }
  let final = 0;
  for (const prior of recentGlobal) final = Math.max(final, trigramOverlap(text, prior));
  // Out of attempts and still colliding: ship the best attempt as before, but
  // report it honestly - `changed` is a claim about the SCORE, not the bytes.
  return { text, changed: mutated && final < threshold, mutated, maxOverlap: final };
}

// ---------------------------------------------------------------------------
// Redis signature window (Module 4, owner P1) - the memory-optimized global
// recent-send memory. ONE ZSET `copy:sigs` holding compact 24-char members
// (simhash64 hex + fnv1a32 hex - see copy/hash.ts), score = timestamp,
// trimmed to SIG_CAP by rank + 48h EXPIRE: ~200KB worst case, never raw text.
// REDIS_URL-gated via the shared hot-state client - a strict no-op when REDIS_URL is unset,
// where the DB-based ensureGloballyFresh above remains the only layer.
// ---------------------------------------------------------------------------

import { copySignature, parseSignature, hamming64, simhash64, mulberry32, fnv1a32 } from "../copy/hash";
import { hotStateClient } from "../rival-cache";

const SIG_KEY = "copy:sigs";
const SIG_CAP = 2000; // ~2000 * ~100B (member+overhead) ≈ 200KB - far under budget
const SIG_TTL_S = 48 * 3600;
const SIG_WINDOW = 300; // compare vs the most recent N signatures (one ZRANGE)
const HAMMING_MAX = 10; // ≤10/64 differing bits = same structural skeleton

/** Record an ACCEPTED outbound's signature in the sliding window. No-op on
 * when REDIS_URL is unset; never throws. */
export async function recordCopySignature(text: string): Promise<void> {
  try {
    const r = await hotStateClient();
    if (!r) return;
    await r.zadd(SIG_KEY, String(Date.now()), copySignature(text));
    await r.zremrangebyrank(SIG_KEY, 0, -(SIG_CAP + 1)); // keep newest SIG_CAP
    await r.expire(SIG_KEY, SIG_TTL_S);
  } catch {
    /* the guard is an enhancement - a Redis blip never blocks a send */
  }
}

/** True when the candidate's skeleton collides with a recent global send. */
async function collidesGlobally(text: string): Promise<boolean> {
  try {
    const r = await hotStateClient();
    if (!r) return false; // no REDIS_URL / Redis down -> the DB layer already ran
    const sim = simhash64(text);
    const exact = copySignature(text).slice(16);
    const recent = await r.zrange(SIG_KEY, -SIG_WINDOW, -1);
    for (const member of recent) {
      const parsed = parseSignature(member);
      if (!parsed) continue;
      if (parsed.exact === exact) return true; // exact duplicate
      if (hamming64(parsed.sim, sim) <= HAMMING_MAX) return true; // same skeleton
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The full global-uniqueness gate (Module 4): the in-process trigram check vs
 * the caller's recent list (works everywhere) PLUS the Redis signature window
 * (worker runtime). Collisions re-vary DETERMINISTICALLY (seeded by the text
 * itself) up to 3 times; the accepted text's signature is recorded so the next
 * send anywhere in the fleet sees it.
 */
export async function ensureGloballyUnique(
  draft: string,
  recentFallback: string[],
  opts: { threshold?: number; record?: boolean } = {}
): Promise<FreshnessVerdict> {
  // Layer 1: the existing in-process compare (raw strings, DB-fed).
  const threshold = opts.threshold ?? 0.75;
  const first = ensureGloballyFresh(draft, recentFallback, threshold);
  let text = first.text;
  let mutated = first.mutated;
  // Layer 2: the cross-fleet signature window. Same attempt budget as before
  // (at most three ZRANGE round trips), but the verdict now records whether
  // the skeleton actually cleared instead of asserting it.
  const rng = mulberry32(fnv1a32(draft));
  let cleared = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await collidesGlobally(text))) {
      cleared = true;
      break;
    }
    cleared = false;
    const next = revarySeeded(text, rng);
    if (next === text) break; // nothing honest left to change
    text = next;
    mutated = true;
  }
  // A layer-2 mutation invalidates layer 1's score, so re-measure the text we
  // are actually about to send (pure CPU over the same short list).
  let maxOverlap = first.maxOverlap;
  if (text !== first.text) {
    maxOverlap = 0;
    for (const prior of recentFallback) maxOverlap = Math.max(maxOverlap, trigramOverlap(text, prior));
  }
  if (opts.record !== false) await recordCopySignature(text);
  return { text, mutated, changed: mutated && cleared && maxOverlap < threshold, maxOverlap };
}

const EMOJI_ANY = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/u;

/** Does this message carry an emoji? Exported so the inbound side can be read
 *  with the same test the outbound side is shaped by. */
export function hasEmoji(text: string): boolean {
  return EMOJI_ANY.test(text || "");
}

export interface EmojiTone {
  /** The traveller's persona appetite (lib/voice). "never" means never. */
  appetite?: "never" | "rare" | "sometimes";
  /** Has THIS shop used an emoji with us? Mirroring is what people do. */
  shopUsesEmoji?: boolean;
  /** Deterministic seed - a re-park must compose the same bytes. */
  seed?: string;
}

/**
 * Seeded 0..1 from a string.
 *
 * `fnv1a32` + `mulberry32` from copy/hash, which is the seeded-RNG pair the
 * whole copy layer already draws from - not a third hand-rolled hash. A first
 * draft used a bare djb2 modulo, and driving it over 80 near-identical seeds
 * showed the clustering that gives: two different probabilities produced the
 * identical count, so the mirroring rule would have looked implemented and been
 * inert. Reusing the primitive that is already well distributed is both less
 * code and the only version that actually varies.
 */
function seededUnit(seed: string): number {
  return mulberry32(fnv1a32(seed))();
}

/**
 * Emoji tone: AT MOST one warm emoji, and not on every message.
 *
 * IT USED TO BE EVERY MESSAGE, WHICH IS ITSELF THE PATTERN.
 *
 * This appended an emoji unconditionally whenever the setting was on - and the
 * setting defaults on - so 100% of outbound carried exactly one. Three costs,
 * all of them the opposite of what the function is for:
 *
 *  1. Perfect regularity is a fleet signature. `wa/persona.personaHumanize`
 *     adds an emoji only ~45% of the time and says why in its own comment
 *     ("not every message - that is itself a pattern"); this ran BEFORE it, so
 *     `hasEmoji` was already true and that deliberate variation never once
 *     fired. The careful rule was dead code behind the blunt one.
 *  2. It contradicted the traveller's own persona. `voiceProfileFor` can draw
 *     `emoji: "never"`, and a third of travellers do - then this appended one
 *     anyway, to every message they ever sent.
 *  3. `Math.random()` was the ONLY non-seeded randomness in the send chain.
 *     Everything else is seeded on purpose so a re-park is byte-identical and
 *     the idempotency hash is stable; this broke that contract silently.
 *
 * Now: never for a "never" persona; otherwise at most one, appended only when
 * the seeded draw says so - and a shop that uses emoji with us raises the odds,
 * because mirroring is what people actually do. Trimming extras is unchanged.
 */
export function enforceEmojiTone(text: string, enabled: boolean, tone?: EmojiTone): string {
  if (!enabled) return text;
  const strip = (t: string) =>
    t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu, "").replace(/\s{2,}/g, " ").trim();
  // A persona that never uses emoji never uses emoji, including one the model
  // put there itself. Anything else makes the persona a decoration.
  if (tone?.appetite === "never") return strip(text);
  if (!EMOJI_ANY.test(text)) {
    // No seed means no variation is possible, so keep the historical behaviour
    // rather than silently going quiet on callers that have not been updated.
    const roll = tone?.seed ? seededUnit(tone.seed) : 0;
    const odds = tone?.shopUsesEmoji ? 0.75 : tone?.appetite === "rare" ? 0.3 : 0.5;
    if (tone?.seed && roll >= odds) return text;
    const idx = tone?.seed
      ? Math.floor(seededUnit(`e:${tone.seed}`) * EMOJI_POOL.length)
      : Math.floor(Math.random() * EMOJI_POOL.length);
    const fresh = EMOJI_POOL[Math.min(EMOJI_POOL.length - 1, idx)];
    return `${text.replace(/\s+$/, "")} ${fresh}`;
  }
  // Keep only the FIRST emoji - models sometimes stack two or three.
  const all = [...text.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu)];
  if (all.length > 1) {
    let seen = 0;
    return text
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu, (m) => (++seen <= 1 ? m : ""))
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return text;
}
