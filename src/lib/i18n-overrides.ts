// OWNER-EDITABLE TRANSLATION OVERRIDES - plan Wave C / M23.
//
// THE PROBLEM THIS CLOSES. A machine translation that is wrong - a mistranslated
// button, a register that reads as rude in the target language, a brand word the
// model localised anyway - was previously unfixable at runtime. The owner's only
// options were to change the English source (which changes it for everyone) or
// to ship a deploy. Neither is a fix; both are a workaround.
//
// THE OVERRIDES LIVE IN THEIR OWN ROW, and that is the whole design decision.
// The obvious implementation is to patch the entry inside `I18N_<lang>` - and it
// would be silently destroyed on the next sweep, because /api/translate re-reads
// that row and writes back `{...latest, ...cached}` for every string it just
// translated. A correction sitting in the machine's own cache is a correction
// waiting to be overwritten by the machine. So:
//
//   I18N_<lang>           the machine cache - written by the translator, freely
//                         overwritten, never authoritative
//   I18N_OVERRIDE_<lang>  the human's corrections - written only by the owner,
//                         never touched by the translator, always wins
//
// Both are read with `getConfigExact`, because the vault's whole-table read
// filters `key=not.like.I18N_*` to keep the large dictionaries out of every cold
// start - the same filter that made the machine cache unreadable until that
// reader existed.

import { getConfigExact, getConfigExactStrict, setConfig } from "./runtime-config";

/** The config key holding one language's human corrections. */
export function overrideKey(lang: string): string {
  return `I18N_OVERRIDE_${lang}`;
}

/**
 * How many corrections one language may hold.
 *
 * Bounded because this row is read on the translate path: an unbounded blob
 * would reintroduce, in the override row, exactly the cold-start cost the
 * `not.like` filter exists to prevent. Corrections are a handful of strings
 * somebody noticed were wrong, not a second dictionary - if it ever approaches
 * this ceiling the right answer is a better prompt, not a bigger row.
 */
export const MAX_OVERRIDES_PER_LANG = 200;

/** Longest a single correction may be. Matches the translate route's own cap. */
export const MAX_OVERRIDE_CHARS = 300;

/** The row's JSON as a clean dictionary; null when it is not a dictionary. */
function parseDictionary(raw: string): Record<string, string> | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/**
 * Read one language's corrections. Never throws; an unreadable row is an empty
 * one, which degrades to "the machine translation is used", not to an error.
 *
 * This is the TRANSLATE path's reader. It must stay total: a vault blip that
 * failed closed here would show every user raw English. Writers must not use
 * it - see readOverridesStrict.
 */
export async function readOverrides(lang: string): Promise<Record<string, string>> {
  try {
    const raw = await getConfigExact(overrideKey(lang));
    if (!raw) return {};
    return parseDictionary(raw) ?? {};
  } catch {
    return {};
  }
}

export type OverridesReadError = "unavailable" | "undecryptable";

/**
 * THE WRITER'S READER (audit F196).
 *
 * setOverride is a read-modify-write, and a read-modify-write over a reader
 * that answers {} for "could not read" rebuilds the row from nothing: one
 * PostgREST 500, one 8s abort, or a rotated SESSION_SECRET (the raw "v1:..."
 * ciphertext fails JSON.parse) turned the owner's 40 hand-written corrections
 * into a one-entry dictionary - encrypted under the new secret, so
 * SESSION_SECRET_PREVIOUS could no longer recover them - while the panel showed
 * a successful save. This reader keeps "empty" and "unknown" apart so the
 * writer can refuse. A row that decrypts but is not a dictionary is treated as
 * empty, exactly as the total reader does: the recoverable case (ciphertext)
 * is already separated out above it.
 */
export async function readOverridesStrict(
  lang: string
): Promise<{ rows: Record<string, string> } | { error: OverridesReadError }> {
  let read: Awaited<ReturnType<typeof getConfigExactStrict>>;
  try {
    read = await getConfigExactStrict(overrideKey(lang));
  } catch {
    return { error: "unavailable" };
  }
  if ("error" in read) return { error: read.error };
  if (!read.value) return { rows: {} };
  try {
    return { rows: parseDictionary(read.value) ?? {} };
  } catch {
    return { rows: {} };
  }
}

/**
 * Apply corrections on top of the machine cache. Pure, so precedence is
 * testable without a database.
 *
 * A correction for a string the machine has NOT translated still applies - the
 * owner may be fixing a string that failed validation and is currently showing
 * English, which is precisely the case where a correction is most wanted.
 */
export function applyOverrides(
  machine: Record<string, string>,
  overrides: Record<string, string>
): Record<string, string> {
  return { ...machine, ...overrides };
}

export type OverrideWriteResult =
  | { ok: true; count: number }
  /** `kind: "store"` marks a refusal the caller should retry (the vault did
   *  not answer, or the write did not land) rather than a bad request. */
  | { ok: false; error: string; kind?: "input" | "store" };

/**
 * Set or clear one correction.
 *
 * READ-MODIFY-WRITE, and the window is one Supabase round trip rather than the
 * length of an LLM call - the same reasoning that fixed the translator's
 * last-write-wins bug. Two owners editing different strings in the same second
 * is not a scenario worth more machinery than that.
 *
 * An empty `text` DELETES the correction, which is how the owner reverts to the
 * machine translation without needing a separate verb.
 */
export async function setOverride(
  lang: string,
  source: string,
  text: string
): Promise<OverrideWriteResult> {
  const key = String(source ?? "").trim();
  if (!key) return { ok: false, error: "The English source string is required." };
  const value = String(text ?? "").trim();
  if (value.length > MAX_OVERRIDE_CHARS) {
    return { ok: false, error: `A correction may not exceed ${MAX_OVERRIDE_CHARS} characters.` };
  }

  // A READ THAT DID NOT HAPPEN IS NOT AN EMPTY ROW (audit F196). Refuse rather
  // than rebuild the dictionary from nothing - a delete is a rewrite too.
  const read = await readOverridesStrict(lang);
  if ("error" in read) {
    return {
      ok: false,
      kind: "store",
      error:
        read.error === "undecryptable"
          ? "The stored corrections could not be decrypted - nothing changed. Set SESSION_SECRET_PREVIOUS to the previous secret, then try again."
          : "The current corrections could not be read - nothing changed. Try again in a moment.",
    };
  }
  const current = read.rows;
  if (!value) {
    delete current[key];
  } else {
    if (!current[key] && Object.keys(current).length >= MAX_OVERRIDES_PER_LANG) {
      return {
        ok: false,
        kind: "input",
        error: `This language already holds ${MAX_OVERRIDES_PER_LANG} corrections. Remove one first - if this many strings are wrong, the prompt is the problem, not the strings.`,
      };
    }
    current[key] = value;
  }

  const res = await setConfig(overrideKey(lang), JSON.stringify(current));
  if (!res.ok) {
    return { ok: false, kind: "store", error: res.error ?? "Could not save the correction." };
  }
  return { ok: true, count: Object.keys(current).length };
}
