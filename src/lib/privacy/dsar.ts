import "server-only";

// THE DSAR EXPORT, ASSEMBLED ONCE.
//
// Two paths need this document: the person's own Download button in Profile,
// and the operator fulfilling a written request from somebody who has lost
// access to their account. They have to produce the SAME document. Two
// implementations of "everything we hold about you" would drift, and the
// operator's copy is the one nobody checks - so it would be the one that goes
// stale, and it is the one that ends up in front of a regulator.
//
// This is the body of the original /api/profile/export route, moved verbatim
// and given a parameter. Every property that made it correct is preserved:
//
//   - IT WALKS THE REGISTRY, the same `USER_TABLES` the erase walker deletes
//     from, so "what we hold" and "what we delete" cannot quietly diverge.
//   - STRICT READS. sbSelect answers [] for every failure, so a table Supabase
//     refused to read would be exported as an empty array - a false statement
//     about what we hold, dressed as data. The three answers are kept apart:
//     rows (the read worked, [] means genuinely nothing), "absent" (the table
//     does not exist on this database: vacuously []), and "unreadable" (the
//     truth is unknown - NAMED in `unreadable`, and its partial rows dropped
//     rather than shown, because partial rows under a heading imply the whole).
//   - A "missing" is PROBED AGAIN with select=* and no order before it is
//     believed: a stale column in a custom select list - or in the order key -
//     answers exactly like an absent table, and rows that exist must never be
//     handed over as "none".
//   - NO SILENT CEILING. Every table is read in a TOTAL order, page after page,
//     until the store says there is nothing left. The ceiling that bounds the
//     work is a stated fact: a table that reaches it is flagged
//     `truncated: true` in `manifest` and named in `truncated` at the top of
//     the document, beside `unreadable` - both mean "this is not everything".

import { getUser } from "../access";
import { sbSelectStrict, supabaseConfigured } from "../runtime-config";
import { USER_TABLES, CHILD_TABLES, USER_OBJECT_STORES, filterFor } from "./user-tables";
import { auditExtFor, auditObjectPath } from "../media/audit";

// THE EXPORT STOPPED AT ROW 1000 AND SAID NOTHING.
//
// This read every table with `limit=1000`, no ORDER and no second page. A
// heavy user passes 1000 whatsapp_messages, agent_events or api_usage rows
// within weeks, so their "everything we hold about you" was the first thousand
// rows Postgres happened to return - a different thousand on a different day,
// because an unordered read has no defined order - and nothing in the document
// said so. That is the failure `unreadable` exists to stop, arriving by another
// door: a false statement about what we hold, dressed as data.
//
// Page size matches PostgREST's default `max-rows`, so one page is one full
// response on a stock Supabase project.
export const DSAR_PAGE_ROWS = 1000;
// The ceiling bounds the WORK (reads per table, bytes in one JSON response on
// one Cloud Run request), not the truth: a table that reaches it is flagged,
// never quietly cut. 20,000 rows of one table for one person is far past any
// real traveller; an account that gets there is fulfilled by hand, and the
// document is what tells the operator so.
export const DSAR_MAX_PAGES = 20;
// Parent ids per child read. Paginating the parents means a big account can
// hand the child walk thousands of ids, and a single `in.(...)` list that long
// is a URL the gateway refuses - which reads as "unavailable" and would turn
// exactly the largest accounts' child tables unreadable.
const CHILD_ID_CHUNK = 200;

// THE ORDER KEY. Offset pagination is only correct over a TOTAL order: with a
// non-unique order column two rows can tie, and tied rows may swap sides of a
// page boundary between two reads - one exported twice, the other never. So
// every table is ordered by its primary key. Most have `id`; these do not
// (composite or natural keys), and PostgREST 400s an order column that is not
// there. dsar-pagination.test.ts walks the registry against schema.sql and
// refuses a registered table whose order key is missing or does not cover its
// primary key - the same schema-grep discipline the registry itself is under.
const EXPORT_ORDER_KEYS: Record<string, string[]> = {
  user_cooldowns: ["email", "kind"],
  wa_sessions: ["email"],
  negotiation_threads: ["thread_key"],
  wa_turns: ["wa_message_id"],
  wa_send_claims: ["sender_key", "slot_key"],
  wa_thread_locks: ["thread_key"],
  wa_processed: ["wa_message_id"],
  wa_inbound_seen: ["wa_message_id"],
};

/** The columns one table's export is ordered by - its primary key. */
export function exportOrderFor(table: string): string[] {
  return EXPORT_ORDER_KEYS[table] ?? ["id"];
}

type Read = { rows: Record<string, unknown>[]; truncated: boolean } | "unreadable" | "absent";

/** One table's line in the export manifest. */
export interface DsarTableManifest {
  /** Rows of this table present in `data`. */
  rows: number;
  /** True when the read stopped at the ceiling with rows still in the store:
   *  `data` holds the FIRST `rows` by primary key, and it is NOT everything. */
  truncated: boolean;
}

export interface DsarExport {
  exportedAt: string;
  email: string;
  account: Record<string, unknown> | null;
  /** False in demo mode: there is no queryable history, which is not the same
   *  as an empty one, and the document says which. */
  durableStore: boolean;
  /** Tables whose truth is unknown. Never silently empty. */
  unreadable: string[];
  /** Tables cut at the ceiling. Named up here, beside `unreadable`, because a
   *  flag buried under 20,000 rows is a flag nobody reads. */
  truncated: string[];
  /** The ceiling itself: the most rows ONE registry read will hand over. */
  rowLimitPerTable: number;
  /** One line per key of `data`: how many rows, and whether that is all. */
  manifest: Record<string, DsarTableManifest>;
  data: Record<string, unknown[]>;
}

async function readTable(table: string, select: string, filter: string): Promise<Read> {
  const order = exportOrderFor(table)
    .map((c) => `${c}.asc`)
    .join(",");
  const page = (limit: number, offset: number) =>
    sbSelectStrict<Record<string, unknown>>(
      table,
      `select=${select}&${filter}&order=${order}&limit=${limit}&offset=${offset}`
    );

  const rows: Record<string, unknown>[] = [];
  for (let n = 0; n < DSAR_MAX_PAGES; n++) {
    const read = await page(DSAR_PAGE_ROWS, rows.length);
    if ("error" in read) {
      // Part-way through, ANY failure is "unknown": the pages already held are
      // not the table, and handing them over under its name would imply they
      // were. The person can retry and get the whole of it.
      if (read.error === "unavailable" || n > 0) return "unreadable";
      // Absent table - or a stale column in the export list or the order key?
      // Only the table can say, so ask it with neither.
      const probe = await sbSelectStrict<Record<string, unknown>>(
        table,
        `select=*&${filter}&limit=1`
      );
      if ("rows" in probe) return probe.rows.length ? "unreadable" : { rows: [], truncated: false };
      return probe.error === "missing" ? "absent" : "unreadable";
    }
    // THE ONLY PROOF OF THE END IS AN EMPTY PAGE. Stopping on the first SHORT
    // page looks equivalent and is not: PostgREST `max-rows` trims a response
    // below the limit that was asked for, without saying so, and a project
    // that lowers it would bring the silent truncation straight back one level
    // down. So the offset advances by what ACTUALLY arrived, and the read ends
    // when nothing does. The price is one tiny extra read per non-empty table,
    // on a route a person may call five times an hour.
    if (!read.rows.length) return { rows, truncated: false };
    rows.push(...read.rows);
  }
  // The ceiling. Whether anything lies past it is a fact, so it is asked for
  // rather than assumed - exactly-at-the-ceiling is a COMPLETE table and must
  // not be reported as a cut one.
  const beyond = await page(1, rows.length);
  if ("error" in beyond) return "unreadable";
  return { rows, truncated: beyond.rows.length > 0 };
}

/** Everything the registry attributes to one person, as one document. */
export async function buildDsarExport(emailRaw: string): Promise<DsarExport> {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  const data: Record<string, unknown[]> = {};
  const manifest: Record<string, DsarTableManifest> = {};
  const unreadable: string[] = [];
  const nameUnreadable = (key: string) => {
    if (!unreadable.includes(key)) unreadable.push(key);
    // Partial rows under a name we could not fully read would imply
    // completeness; the person can retry and get the whole table.
    delete data[key];
    delete manifest[key];
  };
  // The ONE place rows enter the document, so `manifest` cannot disagree with
  // `data`. A table the registry reaches through several keys (sender AND
  // receiver, address AND pseudonym) accumulates; it is truncated if ANY of
  // its reads was.
  const put = (key: string, rows: unknown[], truncated: boolean) => {
    data[key] = [...(data[key] ?? []), ...rows];
    manifest[key] = {
      rows: data[key].length,
      truncated: (manifest[key]?.truncated ?? false) || truncated,
    };
  };

  // The account record itself, minus secret material.
  const rec = await getUser(email, { fresh: true });
  const account = rec
    ? {
        email: rec.email,
        phone: rec.phone,
        name: rec.name,
        provider: rec.provider,
        status: rec.status,
        plan: rec.plan,
        termsAcceptedAt: rec.termsAcceptedAt,
        stayLabel: rec.stayLabel,
        stayLat: rec.stayLat,
        stayLng: rec.stayLng,
        stayShareConsentAt: rec.stayShareConsentAt,
        addedAt: rec.addedAt,
        lastSeen: rec.lastSeen,
        // passwordHash, sessionsValidFrom: security material, not personal data
        // the person needs a copy of.
      }
    : null;

  if (supabaseConfigured()) {
    for (const entry of USER_TABLES) {
      if (entry.exportSkip) continue;
      if (unreadable.includes(entry.table)) continue;
      const select = entry.exportSelect ?? "*";
      try {
        const read = await readTable(entry.table, select, filterFor(entry, email));
        if (read === "unreadable") nameUnreadable(entry.table);
        else if (read === "absent") put(entry.table, [], false);
        else put(entry.table, read.rows, read.truncated);
      } catch {
        nameUnreadable(entry.table);
      }
    }
    for (const child of CHILD_TABLES) {
      if (child.exportSkip) continue;
      const parentEntry = USER_TABLES.find(
        (t) => t.table === child.parentTable && t.column === child.parentColumn
      );
      if (!parentEntry) continue;
      if (unreadable.includes(child.table)) continue;
      try {
        const parents = await readTable(
          child.parentTable,
          child.parentIdColumn,
          filterFor(parentEntry, email)
        );
        if (parents === "unreadable") {
          nameUnreadable(child.table);
          continue;
        }
        if (parents === "absent") {
          put(child.table, [], false);
          continue;
        }
        const ids = parents.rows
          .map((r) => r[child.parentIdColumn])
          .filter((v) => v !== null && v !== undefined);
        // Children of parents we never listed are children we never read: a
        // cut parent walk makes the child table incomplete too, and it says so.
        let truncated = parents.truncated;
        const found: Record<string, unknown>[] = [];
        let outcome: "rows" | "unreadable" | "absent" = "rows";
        for (let at = 0; at < ids.length && outcome === "rows"; at += CHILD_ID_CHUNK) {
          const chunk = ids.slice(at, at + CHILD_ID_CHUNK);
          const rows = await readTable(
            child.table,
            child.exportSelect ?? "*",
            `${child.childColumn}=in.(${chunk.map((v) => encodeURIComponent(String(v))).join(",")})`
          );
          if (rows === "unreadable" || rows === "absent") {
            outcome = rows;
          } else {
            found.push(...rows.rows);
            truncated = truncated || rows.truncated;
          }
        }
        if (outcome === "unreadable") nameUnreadable(child.table);
        else if (outcome === "absent") put(child.table, [], false);
        else put(child.table, found, truncated);
      } catch {
        nameUnreadable(child.table);
      }
    }
    // The object stores (audit F168): the audit copies of inbound media, listed
    // by NAME beside the table rows - never bytes, the same reasoning
    // feedback_images.exportSelect already uses. Derived from the index rows
    // already exported above, so an unreadable index means an unknown list.
    for (const store of USER_OBJECT_STORES) {
      if (unreadable.includes(store.indexTable)) {
        nameUnreadable(store.purgedKey);
        continue;
      }
      const rows = (data[store.indexTable] ?? []) as {
        direction?: string;
        [k: string]: unknown;
        raw?: { media?: { kind?: string | null; mime?: string | null } | null } | null;
      }[];
      const objects: { waMessageId: string; path: string; kind: string }[] = [];
      for (const row of rows) {
        const id = row[store.indexIdColumn];
        const media = row.raw?.media;
        if (row.direction !== "inbound" || !media || typeof id !== "string" || !id) continue;
        const kind = media.kind ?? "image";
        objects.push({
          waMessageId: id,
          path: auditObjectPath(id, auditExtFor(media.mime, kind)),
          kind,
        });
      }
      // Derived from the index rows above, so it is exactly as complete as
      // they are: a cut transcript table is a cut object list.
      put(store.purgedKey, objects, manifest[store.indexTable]?.truncated ?? false);
    }
  }

  return {
    exportedAt: new Date().toISOString(),
    email,
    account,
    // Non-durable mode holds no queryable history; say so instead of implying
    // an empty history.
    durableStore: supabaseConfigured(),
    unreadable,
    truncated: Object.keys(manifest).filter((key) => manifest[key].truncated),
    rowLimitPerTable: DSAR_PAGE_ROWS * DSAR_MAX_PAGES,
    manifest,
    data,
  };
}
