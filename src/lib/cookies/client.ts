// THE BROWSER SIDE OF THE CHOICE - and the gate that makes "off" mean off.
//
// NO "use client" DIRECTIVE, deliberately. These are plain browser utilities
// with no React in them, and every one of them guards `typeof document`. The
// modules that have to call them - lib/currency.ts, lib/client/theme.ts,
// lib/i18n.tsx - are imported from BOTH server and client trees in places, and
// marking this file a client boundary would turn each of those imports into a
// "cannot call a client function from the server" error at build time. A
// directive here would buy documentation and cost the build.
//
// A banner that records a preference and changes nothing is worse than no
// banner: it is a written record that the person was asked, attached to an app
// that ignored the answer. So every write to browser storage in this app goes
// through `rememberLocal` / `rememberSession`, which ask the manifest which
// category the key belongs to and refuse the write when that category is not
// granted. Turning a category OFF also purges what is already there
// (`purgeDenied`), because stopping new writes leaves the old values sitting on
// the device saying the opposite.
//
// FAIL CLOSED, TWICE OVER.
//   - No consent record at all -> nothing optional is written. A traveller who
//     has not answered yet is not a traveller who said yes.
//   - A key the manifest does not declare -> refused, and loudly in dev. An
//     undeclared key is by construction one nobody was told about, so no
//     consent covers it. cookies.test.ts greps for these so it should never
//     happen in a shipped build; this is the belt to that test's braces.
//
// Storage itself may throw (private mode, blocked site data, a full quota).
// Every call here is wrapped: a blocked device degrades to "nothing persists",
// which is exactly what a refusal looks like, so the two paths behave alike.

import {
  categoryForKey,
  type CookieCategory,
  COOKIE_MANIFEST,
} from "./manifest";
import {
  ANALYTICS_COOKIE,
  CONSENT_COOKIE,
  CONSENT_MAX_AGE,
  allows,
  cookieValueFrom,
  decodeCookieConsent,
  deniedCategories,
  newReceiptId,
  type CookieConsent,
} from "./consent";

/** Fired on `window` whenever the choice changes, so live surfaces (the ad
 *  slot, the profile row, the footer link) re-read without a reload. */
export const COOKIE_CONSENT_EVENT = "wd:cookie-consent";
/** Fired to ASK for the preferences panel - the footer and profile links
 *  dispatch it so they do not have to own the panel's state. */
export const COOKIE_PANEL_EVENT = "wd:cookie-panel";

/** The current choice as the browser holds it, or null if there is none. */
function readCookieConsent(): CookieConsent | null {
  if (typeof document === "undefined") return null;
  return decodeCookieConsent(cookieValueFrom(document.cookie, CONSENT_COOKIE));
}

/**
 * Is this browser sending a Global Privacy Control signal?
 *
 * GPC is a legally recognised opt-out of the sale and sharing of personal data
 * in a growing list of US states, and Google treats it as a restricted-
 * processing signal. It is read fresh every time rather than stored: it is a
 * property of the browser in front of us, not a choice made in this app.
 */
export function gpcSignal(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
    );
  } catch {
    return false;
  }
}

/** Is this category granted, right now, on this device? */
export function clientAllows(category: CookieCategory): boolean {
  // A GPC signal beats a stored yes for ADVERTISING - the same rule the
  // pre-paint gate and the server read apply, so all three always agree. It
  // says nothing about first-party preferences or analytics.
  if (category === "marketing" && gpcSignal()) return false;
  return allows(readCookieConsent(), category);
}

/**
 * The receipt id to stamp on a choice being saved now: the one this browser
 * already carries, or a new one on its first save. Kept across saves so every
 * choice made here forms one chain in the visitor ledger.
 */
export function receiptIdForSave(): string {
  return readCookieConsent()?.id ?? newReceiptId();
}

/** What the consent route needs to file an honest proof row: where the
 *  visitor is (as a time zone - never an address) and the language shown. */
export function consentProofContext(): { timeZone: string | null; lang: string | null } {
  let timeZone: string | null = null;
  let lang: string | null = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {}
  try {
    lang = typeof document !== "undefined" ? document.documentElement.getAttribute("lang") : null;
  } catch {}
  return { timeZone, lang };
}

/** Tell every mounted surface the choice changed. */
export function announceConsent(consent: CookieConsent | null): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(COOKIE_CONSENT_EVENT, { detail: consent }));
  } catch {
    /* CustomEvent is universal, but a dead window must never break a save */
  }
}

/** Open the cookie preferences panel from anywhere. */
export function openCookiePanel(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(COOKIE_PANEL_EVENT));
  } catch {}
}

// ---- the gate ---------------------------------------------------------------

function permitted(key: string): boolean {
  const category = categoryForKey(key);
  if (!category) {
    // Undeclared. Refuse, and say so where a developer will see it - silently
    // dropping the write would look like a storage bug for as long as it took
    // somebody to find this file.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        `[cookies] "${key}" is not in COOKIE_MANIFEST - the write was refused. ` +
          `Declare it in src/lib/cookies/manifest.ts with a category and a purpose.`
      );
    }
    return false;
  }
  return clientAllows(category);
}

/** Persist to localStorage IF the traveller allowed that category. Returns
 *  whether the value actually landed, so a caller that must know can ask. */
export function rememberLocal(key: string, value: string): boolean {
  if (!permitted(key)) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The same gate for sessionStorage. */
export function rememberSession(key: string, value: string): boolean {
  if (!permitted(key)) return false;
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// READS ARE NOT GATED, AND THAT IS ON PURPOSE.
//
// A value already on the device was written under a consent that was valid
// then; refusing to read it would not un-store it, it would only make the app
// behave as if it had forgotten while the data sat there. The honest handling
// of a withdrawn category is to DELETE the values (`purgeDenied`, called the
// moment a choice is saved) and then let the ordinary read find nothing - so
// every existing `localStorage.getItem` in the app stays exactly as it was.

// ---- the purge --------------------------------------------------------------

/**
 * Delete everything belonging to a category, including prefix families
 * (`wd_i18n_*`), which need a scan of the whole keyspace rather than a list.
 */
function purgeCategory(category: CookieCategory): void {
  if (typeof window === "undefined") return;
  const exact: { key: string; medium: string }[] = [];
  const prefixes: { prefix: string; medium: string }[] = [];
  for (const entry of COOKIE_MANIFEST) {
    if (entry.category !== category) continue;
    if (entry.medium === "cookie") {
      if (entry.party === "first") {
        dropCookie(entry.name);
      } else {
        // WHO SET IT IS NOT WHERE IT LIVES. This used to skip every third-party
        // entry as being "on another domain", and for most of Google's cookies
        // that is simply false: its script writes __gads, __gpi and friends
        // onto THIS site's domain. Those are deleted here, which is what makes
        // "off means off" true for advertising too. A cookie genuinely held on
        // somebody else's domain (IDE, on doubleclick.net) is not listed in
        // `siteCookies`, and not loading the script is the only remedy for it.
        for (const name of entry.siteCookies ?? []) dropSiteCookie(name);
      }
      continue;
    }
    if (entry.name.endsWith("*")) prefixes.push({ prefix: entry.name.slice(0, -1), medium: entry.medium });
    else exact.push({ key: entry.name, medium: entry.medium });
  }

  for (const { key, medium } of exact) {
    try {
      (medium === "sessionStorage" ? sessionStorage : localStorage).removeItem(key);
    } catch {}
  }
  for (const { prefix, medium } of prefixes) {
    try {
      const store = medium === "sessionStorage" ? sessionStorage : localStorage;
      const doomed: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith(prefix)) doomed.push(k);
      }
      // Collected first: removing during the walk shifts the indices under it.
      for (const k of doomed) store.removeItem(k);
    } catch {}
  }
}

/** Purge every category this choice does not grant. Called on every save, so
 *  it is idempotent and also cleans up values stored before this shipped. */
export function purgeDenied(consent: CookieConsent | null): void {
  for (const category of deniedCategories(consent)) purgeCategory(category);
}

// ---- cookie writes ----------------------------------------------------------

function cookieSuffix(): string {
  const https = typeof location !== "undefined" && location.protocol === "https:";
  return `path=/; SameSite=Lax${https ? "; Secure" : ""}`;
}

/** Expire a first-party cookie on this device. */
function dropCookie(name: string): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = `${name}=; Max-Age=0; ${cookieSuffix()}`;
  } catch {}
}

/**
 * Every `Domain=` a cookie readable on this host could have been set with.
 *
 * A cookie can only be expired by naming the SAME domain it was created for,
 * and a script does not say which one it chose - Google's uses the registrable
 * domain, so that one cookie covers every subdomain. So each candidate is
 * tried: host-only, then the host and each parent, dotted and undotted (older
 * browsers keep the two apart). It stops above the last two labels: a bare TLD
 * is never a legal cookie domain. An IP or `localhost` has no parents at all.
 */
export function cookieDomainsFor(hostname: string): string[] {
  const host = String(hostname ?? "").toLowerCase();
  const out = [""];
  if (!host || !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) return out;
  const labels = host.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const domain = labels.slice(i).join(".");
    out.push(domain, `.${domain}`);
  }
  return out;
}

/** Expire a cookie a third party's script wrote onto this site's own domain. */
function dropSiteCookie(name: string): void {
  if (typeof document === "undefined") return;
  const host = typeof location !== "undefined" ? location.hostname : "";
  for (const domain of cookieDomainsFor(host)) {
    try {
      document.cookie = `${name}=; Max-Age=0; ${cookieSuffix()}${domain ? `; Domain=${domain}` : ""}`;
    } catch {}
  }
}

/**
 * Write the choice to `document.cookie` immediately.
 *
 * The API route is the durable path - it sets the same cookie server-side and
 * writes the ledger row. This runs FIRST and does not wait for it, because the
 * banner must stop being true the instant it is answered even on a dead
 * connection: a traveller on hotel wifi who taps "Reject all" and watches the
 * banner sit there will tap something else. The route then overwrites this with
 * an identical value, and `saveCookieConsent` reports honestly whether the
 * durable half landed.
 */
export function writeConsentCookie(encoded: string): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = `${CONSENT_COOKIE}=${encoded}; Max-Age=${CONSENT_MAX_AGE}; ${cookieSuffix()}`;
  } catch {}
}

/** Drop the analytics id. Called when analytics is denied - the id is the one
 *  cookie whose whole purpose is counting, so it must not outlive the yes. */
export function dropAnalyticsId(): void {
  dropCookie(ANALYTICS_COOKIE);
}
