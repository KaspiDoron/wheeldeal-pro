import "server-only";

// THE SUBJECT FILE - everything the operator can honestly say about one person,
// assembled from the registries that already exist.
//
// WHY THIS IS NOT A NEW INVENTORY. The instinct when building a "data subject"
// screen is to list the tables you can think of. That list is wrong the day
// after it is written, and worse, it is wrong in the direction that matters: a
// table it forgets is a table the operator tells a regulator they do not hold.
//
// So this walks `USER_TABLES` - the same registry `eraseUserData` deletes from
// and the DSAR export reads from, the one a schema-grep test refuses to let a
// new user-keyed table escape. If a table holds this person, it is counted
// here, because it is the same list that would delete them.
//
// WHAT IT DELIBERATELY DOES NOT DO: return rows. A count answers "what do you
// hold about me" and every operational question the console has. The CONTENT is
// available through the DSAR export, which is a deliberate, audited act with
// its own button - and through no other path, because a management screen that
// renders a person's WhatsApp transcripts as a side effect of typing their
// address is a surveillance tool with a compliance label on it.
//
// HONESTY, TABLE BY TABLE. `sbCountDark` answers null for "could not read",
// and a null is carried all the way to the screen as a dash. A subject file
// that shows 0 over an unreadable table is how an operator tells someone their
// data is gone when it is merely invisible.

import { sbCountDark } from "../runtime-config";
import { USER_TABLES, filterFor, type UserTableKey } from "../privacy/user-tables";
import { consentLedger, CONSENT_KINDS, type ConsentEvent, type ConsentKind } from "../consent";
import { CATEGORY_CONSENT_KIND } from "../cookies/server";
import { OPTIONAL_CATEGORIES, type CookieCategory } from "../cookies/manifest";

export interface SubjectTableCount {
  table: string;
  /** null = the table could not be read. NEVER rendered as zero. */
  rows: number | null;
}

export interface SubjectConsentState {
  category: CookieCategory;
  kind: ConsentKind;
  /** null = never answered. Distinct from a recorded `false`. */
  granted: boolean | null;
  /** When the newest row for this kind was written. */
  at: number | null;
  /** The policy version they answered against. */
  version: string | null;
}

export interface SubjectFile {
  email: string;
  /** Whether an account row exists at all - an address with data rows but no
   *  account is a partially-completed erasure, and worth seeing. */
  accountExists: boolean | null;
  tables: SubjectTableCount[];
  /** Total across every table that could be READ. Tables that could not be read
   *  are excluded from the sum and named in `degraded`, so the number is never
   *  quietly short. */
  knownRows: number;
  /** Consent state per cookie category, newest answer wins. */
  cookieConsent: SubjectConsentState[];
  /** The full acceptance history, newest first - the proof view. */
  ledger: ConsentEvent[];
  /** True when any ledger entry came from the breadcrumb fallback rather than
   *  the ledger table: the acceptance is real, the durable record was not. */
  ledgerDegraded: boolean;
  degraded: string[];
}

/**
 * Count one registry entry for this person. One indexed count per (table, key)
 * - several registry rows can name the same table with different key columns
 * (`whatsapp_messages` by sender AND receiver), and they are summed.
 */
async function countFor(entry: UserTableKey, email: string): Promise<number | null> {
  // COUNT ON THE COLUMN WE ARE ALREADY FILTERING BY. sbCountDark projects `id`
  // by default, and several registry tables are keyed on a composite or a jsonb
  // path with no `id` at all - PostgREST 400s that select, which reads back as
  // "unreadable" and paints a perfectly healthy table as unknown on the subject
  // file. The key column is the one column the registry KNOWS exists. A jsonb
  // path (`raw->>sender`) is the exception: it is a valid filter but not a
  // portable projection, so those fall back to `id`, which those tables have.
  const column = /^[a-z_][a-z0-9_]*$/i.test(entry.column) ? entry.column : "id";
  return sbCountDark(entry.table, filterFor(entry, email), column).catch(() => null);
}

/**
 * Assemble the file.
 *
 * The counts run in PARALLEL but the registry is ~40 entries, so this is ~40
 * indexed count queries. That is fine for a deliberate, audited, one-person
 * lookup and would not be fine on a list screen - which is exactly why there is
 * no list screen that calls it.
 */
export async function buildSubjectFile(emailRaw: string): Promise<SubjectFile> {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  const degraded: string[] = [];

  const [accountCount, counts, ledger] = await Promise.all([
    sbCountDark("app_users", `email=eq.${encodeURIComponent(email)}`).catch(() => null),
    Promise.all(
      USER_TABLES.map(async (entry) => ({ entry, rows: await countFor(entry, email) }))
    ),
    consentLedger(email, 200).catch(() => [] as ConsentEvent[]),
  ]);

  // Several registry rows can name one table; the screen wants one line per
  // TABLE, so they are merged. A null anywhere in a table's set makes the whole
  // table unknown - a partial count presented as a total is the lie this file
  // exists to avoid.
  const merged = new Map<string, number | null>();
  for (const { entry, rows } of counts) {
    const prior = merged.has(entry.table) ? merged.get(entry.table)! : 0;
    if (rows === null || prior === null) {
      merged.set(entry.table, null);
      if (!degraded.includes(entry.table)) degraded.push(entry.table);
      continue;
    }
    merged.set(entry.table, prior + rows);
  }

  const tables: SubjectTableCount[] = Array.from(merged.entries())
    .map(([table, rows]) => ({ table, rows }))
    .sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1) || a.table.localeCompare(b.table));

  const knownRows = tables.reduce((sum, t) => sum + (t.rows ?? 0), 0);

  // Newest answer per kind, from the ledger we already read - no second query,
  // and no `consentFor`, whose 60-second cache would make a console that an
  // operator just used to change something show them the old answer.
  const newest = new Map<string, ConsentEvent>();
  for (const e of ledger) {
    if (!newest.has(e.kind)) newest.set(e.kind, e);
  }

  const cookieConsent: SubjectConsentState[] = OPTIONAL_CATEGORIES.map((category) => {
    const kind = CATEGORY_CONSENT_KIND[category as keyof typeof CATEGORY_CONSENT_KIND];
    const row = newest.get(kind);
    return {
      category,
      kind,
      granted: row ? row.granted !== false : null,
      at: row?.at ?? null,
      version: row?.version ?? null,
    };
  });

  if (accountCount === null && !degraded.includes("app_users")) degraded.push("app_users");

  return {
    email,
    accountExists: accountCount === null ? null : accountCount > 0,
    tables,
    knownRows,
    cookieConsent,
    ledger,
    ledgerDegraded: ledger.some((e) => e.degraded === true),
    degraded,
  };
}

/**
 * The mandatory acceptances, separated from the opt-in purposes.
 *
 * Two different questions wearing one word. "Did they accept the terms, and
 * which version" is a contract question; "may we run analytics on them" is a
 * processing question with a switch. A console that renders them in one list
 * invites an operator to try to toggle the first kind.
 */
export function splitConsentKinds(): {
  mandatory: ConsentKind[];
  optIn: ConsentKind[];
} {
  const optIn = new Set<string>(Object.values(CATEGORY_CONSENT_KIND));
  optIn.add("commercial_insights");
  return {
    mandatory: CONSENT_KINDS.filter((k) => !optIn.has(k)),
    optIn: CONSENT_KINDS.filter((k) => optIn.has(k)),
  };
}
