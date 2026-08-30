import "server-only";

// PROOF, NOT PRESENCE.
//
// The legal text was complete and the checkboxes were mandatory, and yet the
// only thing the system could actually PROVE was that a user had ticked
// something, once, at signup:
//
//   - `app_users.terms_version` exists in the schema and nothing ever wrote it,
//     so bumping TERMS_VERSION changed the document under everyone's feet with
//     no re-acceptance and no record of which version anyone agreed to.
//   - the WhatsApp linking release (WaTermsModal) was a modal you closed. Every
//     link, relink and number change went unrecorded.
//   - the booking sheet's "I understand the deal terms" checkbox gated its own
//     submit button on the CLIENT and was never sent anywhere.
//
// A consent nobody recorded is a consent you cannot rely on when it matters,
// which is the only moment consent is for. This module is the one place a
// consent is written, so a new acceptance surface cannot ship without a record
// again.
//
// ALMOST EVERY WRITE IS BEST-EFFORT AND NEVER BLOCKS THE USER'S ACTION. A
// database hiccup must not stop someone closing a deal; the ledger is an audit
// trail, not a gate. The gate is `needsReacceptance`, which is a pure function
// of data we already have.
//
// THE EXCEPTION IS `wa_link`, and it is the one that matters most. Its subject
// matter is the permanent loss of the user's phone number, so a wobble there
// means the link happens with no provable record that anyone accepted that
// risk - which is exactly the moment a record exists for. That kind retries,
// and the linking path calls `recordConsentBlocking` and refuses to hand out a
// QR or pairing code when it still cannot be recorded.

import { sbInsert, sbSelect, sbUpdate } from "./runtime-config";
import { TERMS_VERSION } from "./legal";

/**
 * Everything a user can accept, in one vocabulary.
 *
 * The first three are the signup consents and additionally stamp their own
 * durable column on `app_users` (they predate this ledger). The last two are
 * per-EVENT: a person links WhatsApp more than once and books more than once,
 * and each of those is its own acceptance at its own moment.
 */
export const CONSENT_KINDS = [
  "terms",
  "wa_risk",
  "ai_responsibility",
  // Sharing the traveller's own phone number with a rental agency so the agency
  // can message THEM. New personal-data disclosure, so it gets its own
  // recorded acceptance rather than riding inside the general terms.
  "number_sharing",
  "wa_link",
  "deal_terms",
  // W9: the two OPT-IN processing purposes (owner problem #10). Unlike the six
  // above - mandatory acceptances required to use the product - these default
  // to NO and are toggled from Profile. A withdrawal is a ROW (granted=false),
  // never a deletion, so the history stays provable in both directions.
  //
  // analytics: structured product_events collection (the funnel projection).
  // commercial_insights: whether this person's DE-IDENTIFIED deal outcomes may
  // feed commercial aggregate datasets (deal_memory rows get stamped
  // insights_ok at write time; the sellable rollup reads only stamped rows).
  "analytics",
  "commercial_insights",
] as const;

export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** The kinds that are opt-IN purposes rather than mandatory acceptances. */
export const OPT_IN_KINDS: readonly ConsentKind[] = ["analytics", "commercial_insights"];

/** The breadcrumb kind a lost ledger row falls back to. On `agent_events`,
 *  which exists on every database this app has ever had. */
export const UNRECORDED_KIND = "consent-unrecorded";

export interface ConsentEvent {
  kind: ConsentKind;
  version: string;
  at: number;
  context?: Record<string, unknown>;
  /** False = a recorded WITHDRAWAL. Absent (legacy rows) = an acceptance. */
  granted?: boolean;
  /** True when this came from the fallback breadcrumb rather than the ledger -
   *  the acceptance is real, the durable record was not written. */
  degraded?: boolean;
}

/**
 * Does this user have to accept again?
 *
 * TRUE when they have never accepted, and true when the version they accepted
 * is not the version we are now serving. A missing `termsVersion` on a user who
 * HAS accepted is the pre-ledger population: they agreed to something, we just
 * cannot say what, so they are asked once and then recorded properly.
 *
 * Pure, because this decides whether an app entry is blocked and that decision
 * must be testable without a database.
 */
export function needsReacceptance(
  user: { termsAcceptedAt?: number; termsVersion?: string } | null | undefined,
  current: string = TERMS_VERSION
): boolean {
  if (!user?.termsAcceptedAt) return true;
  return user.termsVersion !== current;
}

/**
 * A human explanation of WHY the modal is showing, so the first-touch screen
 * does not tell a returning user they are new.
 */
export function reacceptanceReason(
  user: { termsAcceptedAt?: number; termsVersion?: string } | null | undefined,
  current: string = TERMS_VERSION
): "first-time" | "version-bump" | "none" {
  if (!user?.termsAcceptedAt) return "first-time";
  if (user.termsVersion !== current) return "version-bump";
  return "none";
}

/**
 * Write one acceptance to the durable ledger.
 *
 * Returns whether the row landed. Callers do not act on `false` - see the
 * best-effort note at the top - but the boolean lets the admin surface tell a
 * missing table from a missing consent.
 */
export async function recordConsent(input: {
  email: string;
  kind: ConsentKind;
  version?: string;
  context?: Record<string, unknown>;
  /** W9: false records a WITHDRAWAL. Defaults to true (an acceptance). */
  granted?: boolean;
}): Promise<boolean> {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!email) return false;
  const version = input.version ?? TERMS_VERSION;
  const granted = input.granted !== false;

  // ONE KIND IS NOT BEST-EFFORT, AND IT IS THE ONE THAT MATTERS MOST.
  //
  // Best-effort is right for five of the six: a database hiccup must not stop
  // someone closing a deal, and the acceptance is reconstructable from the
  // breadcrumb below. It is indefensible for `wa_link`, whose subject matter is
  // the permanent loss of the user's phone number. A wobble there means the
  // link happens with no provable record that anyone accepted that risk - which
  // is exactly the moment a record exists for.
  //
  // So `wa_link` retries a few times before falling back. The retry is short and
  // bounded because a linking flow is interactive: somebody is watching a
  // spinner, and this is meant to survive a blip, not an outage. The refusal
  // itself lives in the caller, via `recordConsentBlocking`.
  const attempts = input.kind === "wa_link" ? 3 : 1;
  let landed = false;
  for (let i = 0; i < attempts && !landed; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 150 * i));
    landed = await sbInsert("consent_events", [
      {
        email,
        kind: input.kind,
        version,
        context: input.context ?? null,
        granted,
        accepted_at: new Date().toISOString(),
      },
    ]).catch(() => false);
    // Pre-migration tolerance: on a database without the `granted` column the
    // insert 400s whole. An ACCEPTANCE may fall back to the legacy row shape
    // (absent granted has always meant accepted). A WITHDRAWAL may NOT - a
    // legacy row would read back as the exact opposite of what the person
    // said - so it falls through to the breadcrumb, which carries `granted`.
    if (!landed && granted) {
      landed = await sbInsert("consent_events", [
        {
          email,
          kind: input.kind,
          version,
          context: input.context ?? null,
          accepted_at: new Date().toISOString(),
        },
      ]).catch(() => false);
    }
  }
  if (landed) return true;

  // THE LEDGER FAILED. THE CONSENT STILL HAPPENED.
  //
  // `consent_events` is a new table, and the code that writes it can reach a
  // database where `supabase/schema.sql` has not been re-run - the insert 400s
  // and this returns false, which every caller discards. The result is the exact
  // failure this module was built to end: a person accepted something, and the
  // system cannot prove it.
  //
  // `agent_events` predates all of this and is always there, so it is where a
  // lost acceptance goes. A breadcrumb is a worse record than a ledger row - it
  // has no schema and no index - but it is a RECORD, and `consentLedger` reads
  // it back so the fallback is not write-only.
  await sbInsert("agent_events", [
    {
      kind: UNRECORDED_KIND,
      detail: JSON.stringify({
        email,
        consentKind: input.kind,
        version,
        context: input.context ?? null,
        granted,
        at: new Date().toISOString(),
      }).slice(0, 2000),
    },
  ]).catch(() => false);
  return false;
}

/**
 * Record a consent and REPORT whether it is provable.
 *
 * The WhatsApp linking path calls this rather than `recordConsent`, and treats
 * `false` as a refusal: a number must not be linked against an acceptance
 * nobody can produce. Everything else stays best-effort - the difference is not
 * the write, it is what the caller is obliged to do with the answer.
 */
export async function recordConsentBlocking(input: {
  email: string;
  kind: ConsentKind;
  version?: string;
  context?: Record<string, unknown>;
}): Promise<boolean> {
  return recordConsent(input);
}

// ---- The read gate for the opt-in purposes ----------------------------------

const consentCache = new Map<string, { value: boolean; exp: number }>();
const CONSENT_CACHE_MS = 60_000;

/** Test hook: drop the consentFor cache. */
export function resetConsentCache(): void {
  consentCache.clear();
}

/**
 * Is this purpose currently GRANTED for this person? The gate every consented
 * write goes through (product_events projection, deal_memory insights stamp).
 *
 * Semantics are strict opt-in: the answer is true only when the NEWEST ledger
 * row for (email, kind) exists and is not a withdrawal. No row, an unreadable
 * ledger, or a granted=false row all answer false - data you cannot prove
 * consent for is data you do not collect. Cached 60s per (email, kind) so a
 * funnel transition does not cost a ledger read every time; a Profile toggle
 * busts the cache on this instance via recordConsent's callers calling
 * resetConsentCache (other instances converge within the minute).
 */
export async function consentFor(emailRaw: string, kind: ConsentKind): Promise<boolean> {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  if (!email) return false;
  const cacheKey = `${email}|${kind}`;
  const hit = consentCache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.value;

  let value = false;
  try {
    const rows = await sbSelect<{ granted: boolean | null }>(
      "consent_events",
      `select=granted&email=eq.${encodeURIComponent(email)}&kind=eq.${encodeURIComponent(
        kind
      )}&order=accepted_at.desc&limit=1`
    );
    value = rows.length > 0 && rows[0].granted !== false;
  } catch {
    value = false;
  }
  if (consentCache.size > 5000) consentCache.clear();
  consentCache.set(cacheKey, { value, exp: Date.now() + CONSENT_CACHE_MS });
  return value;
}

/**
 * Stamp the version alongside the signup consents.
 *
 * `terms_accepted_at` was written from the day the column existed;
 * `terms_version` never was, which is what made a version bump silent. Written
 * separately from `mirror()` in access.ts so an older database missing the
 * column fails only this write instead of the whole user upsert.
 */
export async function stampTermsVersion(
  email: string,
  version: string = TERMS_VERSION
): Promise<boolean> {
  const who = String(email ?? "").trim().toLowerCase();
  if (!who) return false;
  return sbUpdate(
    "app_users",
    `email=eq.${encodeURIComponent(who)}`,
    { terms_version: version, terms_accepted_at: new Date().toISOString() }
  ).catch(() => false);
}

/**
 * One user's acceptance history, newest first - the admin proof view.
 *
 * Reads BOTH sources. An empty ledger and a ledger the writes never reached
 * look identical from a table read, and the difference is the whole question
 * this view is asked. The breadcrumbs are merged in flagged `degraded` so the
 * fallback in `recordConsent` is not write-only.
 */
export async function consentLedger(email: string, limit = 50): Promise<ConsentEvent[]> {
  const who = String(email ?? "").trim().toLowerCase();
  if (!who) return [];
  const cap = Math.max(1, Math.min(200, limit));

  type LedgerRow = {
    kind: string;
    version: string | null;
    context: Record<string, unknown> | null;
    accepted_at: string;
    granted?: boolean | null;
  };
  const [rows, crumbs] = await Promise.all([
    // Two-tier read: a pre-migration database 400s a select naming `granted`,
    // and sbSelect collapses that to [] - which would blank the whole proof
    // view. The legacy retry costs one extra read only when the first is empty.
    (async (): Promise<LedgerRow[]> => {
      const withGranted = await sbSelect<LedgerRow>(
        "consent_events",
        `select=kind,version,context,accepted_at,granted&email=eq.${encodeURIComponent(
          who
        )}&order=accepted_at.desc&limit=${cap}`
      ).catch(() => [] as LedgerRow[]);
      if (withGranted.length) return withGranted;
      return sbSelect<LedgerRow>(
        "consent_events",
        `select=kind,version,context,accepted_at&email=eq.${encodeURIComponent(
          who
        )}&order=accepted_at.desc&limit=${cap}`
      ).catch(() => [] as LedgerRow[]);
    })(),
    sbSelect<{ detail: string; created_at: string }>(
      "agent_events",
      `select=detail,created_at&kind=eq.${UNRECORDED_KIND}&order=created_at.desc&limit=200`
    ).catch(() => []),
  ]);

  const fromLedger: ConsentEvent[] = rows
    .filter((r) => (CONSENT_KINDS as readonly string[]).includes(r.kind))
    .map((r) => ({
      kind: r.kind as ConsentKind,
      version: r.version ?? "",
      at: Date.parse(r.accepted_at) || 0,
      context: r.context ?? undefined,
      ...(r.granted === false ? { granted: false } : {}),
    }));

  const fromCrumbs: ConsentEvent[] = [];
  for (const c of crumbs) {
    try {
      const d = JSON.parse(c.detail) as {
        email?: string;
        consentKind?: string;
        version?: string;
        context?: Record<string, unknown> | null;
        granted?: boolean;
        at?: string;
      };
      if (String(d.email ?? "").toLowerCase() !== who) continue;
      if (!(CONSENT_KINDS as readonly string[]).includes(String(d.consentKind))) continue;
      fromCrumbs.push({
        kind: d.consentKind as ConsentKind,
        version: d.version ?? "",
        at: Date.parse(d.at ?? c.created_at) || 0,
        context: d.context ?? undefined,
        ...(d.granted === false ? { granted: false } : {}),
        degraded: true,
      });
    } catch {
      /* a breadcrumb we cannot parse is not an acceptance we can claim */
    }
  }

  return [...fromLedger, ...fromCrumbs].sort((a, b) => b.at - a.at).slice(0, cap);
}
