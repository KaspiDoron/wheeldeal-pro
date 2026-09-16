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
//   - A "missing" on a table with a custom column list is PROBED AGAIN with
//     select=* before it is believed: a stale column in that list answers
//     exactly like an absent table, and rows that exist must never be handed
//     over as "none".

import { getUser } from "../access";
import { sbSelectStrict, supabaseConfigured } from "../runtime-config";
import { USER_TABLES, CHILD_TABLES, USER_OBJECT_STORES, filterFor } from "./user-tables";
import { auditExtFor, auditObjectPath } from "../media/audit";

const ROWS_PER_TABLE = 1000;

type Read = { rows: Record<string, unknown>[] } | "unreadable" | "absent";

export interface DsarExport {
  exportedAt: string;
  email: string;
  account: Record<string, unknown> | null;
  /** False in demo mode: there is no queryable history, which is not the same
   *  as an empty one, and the document says which. */
  durableStore: boolean;
  /** Tables whose truth is unknown. Never silently empty. */
  unreadable: string[];
  rowLimitPerTable: number;
  data: Record<string, unknown[]>;
}

async function readTable(
  table: string,
  select: string,
  filter: string,
  customSelect: boolean
): Promise<Read> {
  const read = await sbSelectStrict<Record<string, unknown>>(
    table,
    `select=${select}&${filter}&limit=${ROWS_PER_TABLE}`
  );
  if ("rows" in read) return { rows: read.rows };
  if (read.error === "unavailable") return "unreadable";
  if (!customSelect) return "absent";
  // Absent table, or a stale column in the export list? Only the table can say.
  const probe = await sbSelectStrict<Record<string, unknown>>(
    table,
    `select=*&${filter}&limit=1`
  );
  if ("rows" in probe) return probe.rows.length ? "unreadable" : { rows: [] };
  return probe.error === "missing" ? "absent" : "unreadable";
}

/** Everything the registry attributes to one person, as one document. */
export async function buildDsarExport(emailRaw: string): Promise<DsarExport> {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  const data: Record<string, unknown[]> = {};
  const unreadable: string[] = [];
  const nameUnreadable = (key: string) => {
    if (!unreadable.includes(key)) unreadable.push(key);
    // Partial rows under a name we could not fully read would imply
    // completeness; the person can retry and get the whole table.
    delete data[key];
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
        const read = await readTable(
          entry.table,
          select,
          filterFor(entry, email),
          Boolean(entry.exportSelect)
        );
        if (read === "unreadable") nameUnreadable(entry.table);
        else if (read === "absent") data[entry.table] = data[entry.table] ?? [];
        else data[entry.table] = [...(data[entry.table] ?? []), ...read.rows];
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
      try {
        const parents = await readTable(
          child.parentTable,
          child.parentIdColumn,
          filterFor(parentEntry, email),
          false
        );
        if (parents === "unreadable") {
          nameUnreadable(child.table);
          continue;
        }
        if (parents === "absent") {
          data[child.table] = data[child.table] ?? [];
          continue;
        }
        const ids = parents.rows
          .map((r) => r[child.parentIdColumn])
          .filter((v) => v !== null && v !== undefined);
        if (!ids.length) {
          data[child.table] = data[child.table] ?? [];
          continue;
        }
        const rows = await readTable(
          child.table,
          child.exportSelect ?? "*",
          `${child.childColumn}=in.(${ids.map((v) => encodeURIComponent(String(v))).join(",")})`,
          Boolean(child.exportSelect)
        );
        if (rows === "unreadable") nameUnreadable(child.table);
        else if (rows === "absent") data[child.table] = data[child.table] ?? [];
        else data[child.table] = [...(data[child.table] ?? []), ...rows.rows];
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
      data[store.purgedKey] = objects;
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
    rowLimitPerTable: ROWS_PER_TABLE,
    data,
  };
}
