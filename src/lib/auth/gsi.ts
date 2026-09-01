"use client";

// Bounded, single-flight loader for Google Identity Services.
//
// WHY THIS EXISTS
//
// The login page used to inline this:
//
//     await new Promise((resolve, reject) => {
//       if (window.google?.accounts) return resolve();
//       const s = document.createElement("script");
//       s.src = "https://accounts.google.com/gsi/client";
//       s.onload = () => resolve(); s.onerror = reject;
//       document.head.appendChild(s);
//     });
//
// which has two defects that together produce a permanently blank sign-in area
// with zero feedback:
//
//  1. NOTHING BOUNDS IT. `onload`/`onerror` only fire if the request completes or
//     fails. A connection that is accepted and then stalls - captive portal,
//     corporate proxy black hole, a network where accounts.google.com is simply
//     dropped - fires neither, so the promise never settles. Every line after
//     the await, including the "the button never painted" detector, is then
//     never even scheduled. That is why the failure showed no message at all.
//  2. THE GUARD IS ON THE WRONG THING. `window.google?.accounts` is only true
//     AFTER the script has executed, so two components mounting concurrently -
//     or one component remounting while the first load is still in flight -
//     each append their own <script> tag.
//
// So the capability is: one in-flight load at a time, one <script> tag ever, and
// a hard deadline that turns "the network ate it" into a rejected promise the UI
// can render. A failed load clears the memo so an explicit retry can work; a
// successful one is kept forever because the API is a global singleton anyway.

export type GsiFailureCode = "no-dom" | "script-timeout" | "script-error" | "no-api";

export class GsiLoadError extends Error {
  readonly code: GsiFailureCode;
  constructor(code: GsiFailureCode, message: string) {
    super(message);
    this.name = "GsiLoadError";
    this.code = code;
  }
}

/** The slice of the GSI surface this app actually calls. */
export interface GsiIdApi {
  initialize(options: Record<string, unknown>): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  cancel?(): void;
  disableAutoSelect?(): void;
}

export interface GsiApi {
  accounts: { id: GsiIdApi };
}

export const GSI_SRC = "https://accounts.google.com/gsi/client";
export const GSI_DEFAULT_TIMEOUT_MS = 8000;

/**
 * The language GSI should speak.
 *
 * GSI localises to the BROWSER's locale, and nothing used to tell it otherwise -
 * so the one control on the login page that is not ours was also the only one
 * that ignored the app's language selector. A traveller with a Portuguese phone
 * reading an English app was offered "Continuar com o Google".
 *
 * `hl` on the script URL sets it for the whole page; `locale` on renderButton
 * sets it per button and is what survives a language change after load. We send
 * both, because the script is memoised and only the first load can carry `hl`.
 *
 * Codes are passed through as-is: this app's LANGS codes ("en", "pt", "he",
 * "uk", "zh") are already the BCP-47 primary subtags GSI expects. Anything
 * unrecognisable falls back to English rather than to the browser, because
 * "whatever this device happens to be" is the bug being fixed.
 */
export function gsiLocale(lang: string | null | undefined): string {
  const code = String(lang ?? "").trim().toLowerCase();
  return /^[a-z]{2}(-[a-z0-9]{2,8})?$/i.test(code) ? code : "en";
}

/** The script URL for a locale. Kept separate from GSI_SRC so the tag-reuse
 *  lookup can match on the base regardless of which locale loaded it first. */
export function gsiSrcFor(lang: string | null | undefined): string {
  return `${GSI_SRC}?hl=${encodeURIComponent(gsiLocale(lang))}`;
}

/** User-safe copy for each way the loader can fail. */
export function gsiFailureCopy(code: GsiFailureCode): string {
  switch (code) {
    case "script-timeout":
      return "Google sign-in did not load in time (your network may be blocking it) - use email below.";
    case "no-dom":
      return "Google sign-in is unavailable here - use email below.";
    default:
      return "Google sign-in could not load - use email below.";
  }
}

let inFlight: Promise<GsiApi> | null = null;

function readApi(): GsiApi | null {
  const g = (globalThis as { google?: { accounts?: { id?: GsiIdApi } } }).google;
  return g?.accounts?.id ? (g as GsiApi) : null;
}

function startLoad(timeoutMs: number, lang?: string): Promise<GsiApi> {
  const ready = readApi();
  if (ready) return Promise.resolve(ready);

  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.head) {
    return Promise.reject(new GsiLoadError("no-dom", gsiFailureCopy("no-dom")));
  }

  return new Promise<GsiApi>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      // Deliberately NOT removing the <script> tag: it may still arrive and
      // populate window.google, and a later retry should be able to use it.
      finish(() => reject(new GsiLoadError("script-timeout", gsiFailureCopy("script-timeout"))));
    }, Math.max(1, timeoutMs));
    (timer as unknown as { unref?: () => void }).unref?.();

    const onLoad = () => {
      // A tag that loads but leaves no API behind means a content blocker served
      // an empty body. Treat it as a failure, not as success with a missing API,
      // or the caller will crash on `accounts.id.initialize`.
      const api = readApi();
      finish(() =>
        api
          ? resolve(api)
          : reject(new GsiLoadError("no-api", gsiFailureCopy("no-api")))
      );
    };
    const onError = () =>
      finish(() => reject(new GsiLoadError("script-error", gsiFailureCopy("script-error"))));

    // Reuse a tag another mount (or a previous failed attempt) already added.
    // PREFIX match: the src now carries an `hl` locale, and a second mount in a
    // different language must still reuse the one tag rather than append a
    // second copy of the SDK.
    const existing =
      doc.querySelector<HTMLScriptElement>(`script[src^="${GSI_SRC}"]`) ?? null;
    const script = existing ?? doc.createElement("script");
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    if (!existing) {
      script.src = gsiSrcFor(lang);
      script.async = true;
      script.defer = true;
      doc.head.appendChild(script);
    }
  });
}

/**
 * Resolve the GSI namespace, or reject with a `GsiLoadError` within `timeoutMs`.
 * Concurrent callers share one promise and one <script> tag.
 */
export function loadGsi(
  timeoutMs: number = GSI_DEFAULT_TIMEOUT_MS,
  lang?: string
): Promise<GsiApi> {
  if (inFlight) return inFlight;
  const attempt = startLoad(timeoutMs, lang).catch((err) => {
    // Only a FAILED attempt drops the memo. Poisoning the cache with a rejection
    // would make "tap to retry" permanently useless on the very networks where
    // retrying is the correct move.
    if (inFlight === attempt) inFlight = null;
    throw err;
  });
  inFlight = attempt;
  return attempt;
}

/**
 * Forget the memo. Used by tests, and available for an explicit user-driven
 * retry after a success that later turned out to be unusable.
 */
export function resetGsi(): void {
  inFlight = null;
}

/**
 * GSI's `renderButton` takes a pixel width and rejects anything outside 200-400.
 * The old code passed the literal 320, which at the 320px viewport this app is
 * required to support left a 240px content box and an iframe hanging 40px off
 * each edge. Deriving it from the measured container makes the overflow
 * impossible instead of merely unlikely.
 */
export function gsiButtonWidth(containerPx: number): number | undefined {
  const w = Math.floor(containerPx);
  if (!Number.isFinite(w) || w <= 0) return undefined;
  return Math.min(400, Math.max(200, w));
}
