// THE TRANSLATE LOOP THAT COULD NOT STOP.
//
// `t()` records every string it cannot translate in a `pending` set, and a
// 1.5-second sweep drains that set to /api/translate. Nothing ever removed a
// string that came back UNTRANSLATED - so the next render put it straight back
// into `pending`, the next sweep asked again, and the loop ran for as long as
// the page was open.
//
// Two ways that ended badly, both silent:
//
//   - No AI provider configured. The route answers with an `error` and an empty
//     map. The client broke out of its BATCH loop and the interval simply
//     re-ran 1.5s later, forever, on a feature that could not work at all.
//   - The daily cap reached. The route answers 429 with `{map:{}}` and NO error
//     field, so even that break never fired - just a request every 1.5 seconds,
//     indefinitely, for nothing.
//
// A retry needs a reason to expect a different answer. This decides, in one
// place, which failures are worth retrying and which are terminal for this
// session - and the terminal ones become a thing the traveller is TOLD, because
// silently showing English while claiming to support their language is how the
// whole feature looked dead in the field.

export type TranslateOutcome = "ok" | "retry" | "stop";

export interface TranslateResponseShape {
  map?: Record<string, string> | null;
  error?: string | null;
}

/**
 * What to do after one /api/translate call.
 *
 * `stop` means: nothing about this session will change the answer. Do not ask
 * again, and say so.
 */
export function translateOutcome(
  status: number,
  data: TranslateResponseShape | null
): TranslateOutcome {
  // The daily cap. It resets tomorrow, not in 1.5 seconds.
  if (status === 429) return "stop";
  // Signed out, or a language the server refuses - asking again cannot help.
  if (status === 401 || status === 400) return "stop";
  // An explicit error from the route is the "no provider configured" case.
  if (data?.error) return "stop";
  if (status >= 500) return "retry";
  if (!data || typeof data.map !== "object" || data.map === null) return "retry";
  return "ok";
}

/** The user-facing note for a terminal stop. Never a stack trace, never blank. */
export function unavailableNote(status: number, data: TranslateResponseShape | null): string {
  if (data?.error) return data.error;
  if (status === 429) {
    return "Today's translation budget is used up - the app stays in English until tomorrow. Everything else works normally.";
  }
  if (status === 401) return "Sign in again to keep the app in your language.";
  return "Translation is unavailable right now - showing English.";
}

/**
 * The strings still worth asking about.
 *
 * A string the server has already declined to translate is REMOVED from the
 * work, not left in the pending set to be asked about on every sweep for the
 * rest of the session. That single omission is what turned a miss into a loop.
 *
 * ...AND NEITHER IS A STRING SOMEBODY IS ALREADY FETCHING (audit F253). The
 * catalogue sweep that follows a language switch runs for tens of seconds; the
 * empty dict it starts from makes every rendered t() re-queue its own string,
 * so the 1.5s interval asked for the SAME strings again every 1.5 seconds -
 * each re-ask a request charged against the daily translate cap.
 */
export function retriable(
  pending: Iterable<string>,
  failed: ReadonlySet<string>,
  inFlight?: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  for (const s of pending) {
    if (failed.has(s)) continue;
    if (inFlight?.has(s)) continue;
    out.push(s);
  }
  return out;
}

/**
 * The strings a response did NOT translate, so they can be retired.
 *
 * The route answers with only the entries it has, so anything asked for and
 * absent from the map is a miss - not an error, just an answer of "no".
 */
export function missedFrom(asked: string[], map: Record<string, string> | null | undefined): string[] {
  if (!map) return [...asked];
  return asked.filter((s) => !map[s]);
}

/**
 * Which of the asked strings should be RETIRED after this response.
 *
 * THE FAQ WENT PERMANENTLY ENGLISH THROUGH THIS DECISION. The server used to
 * filter owner-authored FAQ strings out of the batch and answer a clean 200
 * with an empty map - and an empty map was read as "declined everything", so
 * every FAQ string was retired for the session on the very first sweep. A
 * server-side filter, a transient LLM flop and a genuine "no" were all the
 * same shape on the wire.
 *
 * The rule now: a response that translated SOMETHING (or names its rejects)
 * has demonstrated the pipeline works, so its misses are real answers and are
 * retired as before. An ENTIRELY empty answer earns a strike instead - only
 * `emptyStrikeLimit` consecutive empty answers retire the string, which keeps
 * the no-loop guarantee (bounded at ~3 sweeps) without making one filtered
 * batch a life sentence.
 */
export function retirementsFrom(
  asked: string[],
  data: TranslateResponseShape & { rejected?: { text: string }[] } | null | undefined,
  strikes: Map<string, number>,
  emptyStrikeLimit = 3
): string[] {
  const map = data?.map ?? null;
  const translated = map ? asked.filter((s) => map[s]) : [];
  if (translated.length > 0 || (data?.rejected?.length ?? 0) > 0) {
    for (const s of asked) strikes.delete(s);
    return missedFrom(asked, map);
  }
  const out: string[] = [];
  for (const s of asked) {
    const n = (strikes.get(s) ?? 0) + 1;
    strikes.set(s, n);
    if (n >= emptyStrikeLimit) out.push(s);
  }
  return out;
}
