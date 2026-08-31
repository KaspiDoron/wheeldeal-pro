import { NextResponse } from "next/server";
import { chat, aiEnabled } from "@/lib/ai";
import { getConfigExact, setConfig } from "@/lib/runtime-config";
import { getSession } from "@/lib/session";
import { I18N_CATALOG } from "@/lib/i18n-catalog";

// AI translation for the app UI. Uses the configured AI providers (with
// automatic failover) - real context-aware translation, not word-by-word.
// Results are cached per language in Supabase (app_config) so each string is
// translated exactly once, ever.

const LANG_RX = /^[a-z]{2}(-[A-Z]{2})?$/;
const MAX_TEXTS = 500;
// Small chunks = higher translation quality (the model sees each string with
// full attention) and safer JSON output.
const CHUNK = 14;

interface ChunkOutcome {
  /** Per input string: the validated translation, or null. */
  out: (string | null)[];
  /** WHY each null happened - surfaced to the caller and the response so a
   *  rejection is never a silent English string. */
  rejected: { text: string; reason: string }[];
}

async function translateChunk(
  langName: string,
  texts: string[],
  /** Second attempt: repeat the placeholder rule as its own reminder. */
  strict = false
): Promise<ChunkOutcome | null> {
  // BRAND WORDS TRAVEL AS {brandN} TOKENS. The model cannot translate a
  // token, and the placeholder-drift validator enforces its survival - so a
  // Hebrew transliteration of "WheelDeal" can no longer get a string
  // permanently rejected (owner report 3, item 10). Tokens are substituted
  // back after validation.
  const { translationBrief, protectBrands, restoreBrands } = await import("@/lib/i18n-validate");
  const protectedTexts = texts.map(protectBrands);
  const system =
    `You are a senior product localiser translating UI strings for "WheelDeal", a mobile app where AI agents bargain for vehicle rentals, from English to ${langName}. ` +
    "Rules: (1) translate MEANING, not word-by-word - use the natural phrasing a native mobile app in that language would use; " +
    "(2) match register: buttons/labels stay short and imperative, sentences stay friendly and simple; " +
    "(3) {brandN} tokens are protected brand names - keep every one exactly as written; " +
    "(4) keep emoji, numbers, currency symbols, punctuation and every {placeholder} token exactly as written, same spelling, same count; " +
    "(5) no explanations, no quotes added; " +
    // M23: the model used to receive a BARE ARRAY of unrelated strings and had
    // to guess part of speech, register and length budget for each. "Bargain"
    // is a verb on a button and a noun in a sentence, and a context-free
    // localiser picks whichever is more common in its own language.
    '(6) each item carries a role: "label" is a button or control caption - keep it short, imperative, and within maxChars; "sentence" is prose - natural and complete. ' +
    'Input is a JSON array of { text, role, maxChars }. ' +
    'Reply ONLY as JSON: { "t": ["..."] } with translations in the exact same order and count.' +
    (strict
      ? " REMINDER, second attempt: your previous output dropped or altered {tokens}. Copy every {token} character-for-character into the translation."
      : "");
  const out = await chat([
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(protectedTexts.map(translationBrief)) },
  ]);
  if (!out) return null;
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(out.slice(start, end + 1)) as { t?: unknown };
    if (Array.isArray(parsed.t) && parsed.t.length === texts.length) {
      const { validateTranslation } = await import("@/lib/i18n-validate");
      // Per-element validation, NOT String() coercion. A rejected element
      // becomes null so the caller keeps the English source for that one string
      // - a wrong translation is worse than an untranslated one, because the
      // wrong one is invisible until a user complains and unfixable while it
      // sits in the shared cache. null (JSON or coerced) is the first thing
      // this rejects, so the "null" button-label bug cannot recur.
      const rejected: { text: string; reason: string }[] = [];
      const mapped = parsed.t.map((cand, i) => {
        // Validated against the PROTECTED source: the {brandN} tokens ride
        // the placeholder multiset check, which is exactly the enforcement
        // brand-lost used to attempt behaviourally.
        const v = validateTranslation(protectedTexts[i], cand);
        if (!v.ok) {
          rejected.push({ text: texts[i], reason: v.reason ?? "invalid" });
          return null;
        }
        return restoreBrands((cand as string).trim());
      });
      return { out: mapped, rejected };
    }
  } catch {}
  return null;
}

/**
 * The response map: only the strings THIS request asked for, and only the ones
 * that actually have a translation.
 *
 * Extracted because both return paths (no-AI-provider and normal) built it
 * inline and only one of them was updated the last two times this shape
 * changed - a second copy of a filter is how one code path starts answering
 * differently from the other.
 */
function pickTranslated(
  texts: string[],
  dict: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(texts.filter((t) => dict[t]).map((t) => [t, dict[t]]));
}

export async function POST(req: Request) {
  // Signed-in only + a generous daily cap: the cache means real users almost
  // never hit the LLM (each string is translated once ever), but this stops
  // an anonymous caller from turning the endpoint into an open LLM faucet and
  // poisoning the durable translation cache.
  const session = await getSession();
  if (!session) return NextResponse.json({ map: {} }, { status: 401 });
  const { checkDailyLimit } = await import("@/lib/usage");
  const gate = await checkDailyLimit("translate", session.email, "LIMIT_TRANSLATE_PER_DAY", {
    plan: session.plan,
  });
  if (!gate.allowed) return NextResponse.json({ map: {} }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  const lang = String(body.lang ?? "").trim();
  const langName = String(body.langName ?? lang).slice(0, 40);
  // ONLY STRINGS THE APP ACTUALLY RENDERS.
  //
  // This accepted up to 500 arbitrary caller-supplied strings of 300 chars each
  // and merged them into the SHARED `I18N_<lang>` row via setConfig. Nothing
  // constrained them to real UI copy, and there is no pruning or size cap
  // anywhere - the daily gate permits ~30k new dictionary entries per user per
  // day. The row is read on every cold load for that language through
  // getConfigExact, which is bounded by the same 8s timedFetch deadline that
  // runtime-config.ts:708 already documents as a terminal state for the vault:
  // "once the corpus exceeded what transfers inside timedFetch's 8s deadline,
  // this threw". getConfigExact degrades more gracefully (it falls back to
  // process.env) but the end state is the same - the cache stops loading, every
  // cold load re-translates the whole catalogue, and the LLM cost leak this
  // function exists to close reopens.
  //
  // The catalogue is the honest bound, not an arbitrary number: `t()` refuses
  // anything outside it, so a string that is not in it would never be RENDERED
  // even if we translated it. Filtering here means the row can only ever grow
  // to the size of the app's own copy.
  const allowed = new Set(I18N_CATALOG);
  const texts: string[] = Array.isArray(body.texts)
    ? body.texts
        .slice(0, MAX_TEXTS)
        .map((t: unknown) => String(t).slice(0, 300))
        .filter((t: string) => allowed.has(t))
    : [];

  // OWNER-AUTHORED GLOBAL COPY - today exactly the FAQ. It is not in the
  // catalogue (the owner writes it live in Admin), but it is identical for
  // every traveller, so a shared cache is correct by construction. It gets its
  // OWN allowlist - the live FAQ contents, an owner-bounded set - and its OWN
  // row, so the app-copy row stays exactly the size of the catalogue and the
  // bounded-reads argument above survives untouched. Answers are paragraphs,
  // so the cap is wider than the catalogue's 300.
  //
  // THE BREAK THIS CLOSES: FAQ strings used to arrive in `texts`, get filtered
  // out by the catalogue allowlist above, and come back as a clean 200 with an
  // empty map - which the client read as "the server declined" and permanently
  // retired every FAQ string for the session. Hebrew FAQ showed English
  // forever, with zero errors anywhere.
  const sharedRaw: string[] = Array.isArray(body.shared)
    ? body.shared.slice(0, 80).map((t: unknown) => String(t).slice(0, 600))
    : [];
  let shared: string[] = [];
  if (sharedRaw.length > 0) {
    const { listFaq } = await import("@/lib/faq");
    const sharedAllowed = new Set(
      (await listFaq()).flatMap((it) => [it.q.slice(0, 600), it.a.slice(0, 600)])
    );
    shared = sharedRaw.filter((t) => sharedAllowed.has(t));
  }

  if (!LANG_RX.test(lang)) {
    return NextResponse.json({ error: "Invalid language." }, { status: 400 });
  }
  if (lang === "en" || (texts.length === 0 && shared.length === 0)) {
    return NextResponse.json({ map: {} });
  }

  // M23: THE OWNER'S CORRECTIONS, FROM THEIR OWN ROW.
  //
  // Kept separate from the machine cache on purpose - patching a correction
  // into `I18N_<lang>` would put it in the exact object this handler rewrites
  // after every sweep, so the fix would survive until the next string in that
  // language needed translating and then vanish.
  //
  // A corrected string is also NOT "missing": it must never be re-sent to the
  // model, both because that spends tokens re-deriving an answer a human has
  // already overruled and because the machine's version would then be cached
  // and the correction would look like it stopped working.
  const { readOverrides, applyOverrides } = await import("@/lib/i18n-overrides");
  const overrides = await readOverrides(lang);

  const scopes: { texts: string[]; cacheKey: string }[] = [];
  if (texts.length > 0) scopes.push({ texts, cacheKey: `I18N_${lang}` });
  if (shared.length > 0) scopes.push({ texts: shared, cacheKey: `I18N_SHARED_${lang}` });

  const mapOut: Record<string, string> = {};
  const rejectedAll: { text: string; reason: string }[] = [];
  let sweptLlm = false;

  for (const scope of scopes) {
    const cacheKey = scope.cacheKey;
    let cached: Record<string, string> = {};
    try {
      cached = JSON.parse((await getConfigExact(cacheKey)) ?? "{}");
    } catch {}

    const missing = scope.texts.filter((t) => !cached[t] && !overrides[t]);

    if (missing.length > 0) {
      if (!(await aiEnabled())) {
        return NextResponse.json({
          // Corrections still apply on the no-AI path - they are already stored
          // and need no provider to serve.
          map: { ...mapOut, ...pickTranslated(scope.texts, applyOverrides(cached, overrides)) },
          error:
            "AI translation needs at least one AI provider key (Admin -> Keys). Showing English for now.",
        });
      }
      let learned = false;
      for (let i = 0; i < missing.length; i += CHUNK) {
        const chunk = missing.slice(i, i + CHUNK);
        const res = await translateChunk(langName, chunk);
        if (res) {
          chunk.forEach((src, j) => {
            if (res.out[j]) cached[src] = res.out[j] as string;
          });
          learned = true;
          sweptLlm = true;
          // ONE strict retry for the rejects before the client retires them:
          // most drift is the model paraphrasing a {token}, and a pointed
          // reminder recovers it. A second failure is surfaced, not retried -
          // the daily cap is not a fuzzing budget.
          if (res.rejected.length > 0) {
            const again = res.rejected.map((r) => r.text);
            const retryRes = await translateChunk(langName, again, true);
            if (retryRes) {
              again.forEach((src, j) => {
                if (retryRes.out[j]) cached[src] = retryRes.out[j] as string;
              });
              rejectedAll.push(...retryRes.rejected);
            } else {
              rejectedAll.push(...res.rejected);
            }
          }
        }
      }
      if (learned) {
        // LAST WRITE WINS, AND EVERY OTHER WRITE IS LOST.
        //
        // The client fires its batches in parallel (i18n.tsx: one Promise.all over
        // 42-string chunks), and every one of them lands here. Each read the SAME
        // snapshot of the dictionary at the top of this handler, spent seconds in
        // the LLM, then wrote the whole object back - so N concurrent batches kept
        // only the translations of whichever finished last. The rest were paid for
        // and discarded, and the next user in that language paid for them again,
        // round after round, until the dictionary happened to converge.
        //
        // Re-read and merge immediately before the write. The window shrinks from
        // "the length of an LLM call" to "the length of one Supabase round trip",
        // and OURS wins on conflict for the keys we actually translated - a key
        // another batch wrote in the meantime is kept, not clobbered.
        let latest: Record<string, string> = {};
        try {
          latest = JSON.parse((await getConfigExact(cacheKey)) ?? "{}");
        } catch {
          /* an unreadable cache is an empty one; we still have our own work */
        }
        await setConfig(cacheKey, JSON.stringify({ ...latest, ...cached }));
      }
    }

    // OVERRIDES WIN. The owner's correction is the authoritative answer for a
    // string; the machine cache is the fallback beneath it.
    Object.assign(mapOut, pickTranslated(scope.texts, applyOverrides(cached, overrides)));
  }

  if (sweptLlm) {
    // Count this LLM sweep against the daily cap (a cache hit costs nothing).
    const { recordApi } = await import("@/lib/usage");
    await recordApi("translate", 1, session.email);
  }

  return NextResponse.json({
    map: mapOut,
    // WHY a string stayed English - for the admin translation panel and the
    // client's retry policy. Never silent.
    ...(rejectedAll.length > 0 ? { rejected: rejectedAll } : {}),
  });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
