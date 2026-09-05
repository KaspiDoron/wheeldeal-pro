// The erase walker: one function that removes a person, driven by the
// registry in user-tables.ts. Used by the admin Users action and the
// self-serve /api/profile/erase - neither route carries its own table list any
// more, so the registry is the single place erasure can silently rot.
//
// Honesty contract: the result names every table that could NOT be purged.
// A 200 "erased" over rows that are still there is worse than a failure the
// owner can retry - that is the exact defect the old four-table map had.
//
// Two audit findings sharpened the contract:
//   F167 - the child walk read parent ids with sbSelect, which answers [] for
//          a transient 500 and for "no rows" alike. An UNREADABLE parent read
//          stamped the child purged, the parents were deleted, and the
//          children (base64 screenshots) survived with no key left to find
//          them. The parent read is now STRICT, an inconclusive walk DEFERS
//          the parent delete (so a retry can still collect the ids), the ids
//          are PAGED rather than truncated, and the account row is deleted
//          only when everything else is gone.
//   F168 - the audit copies of inbound media live in Supabase Storage, which
//          the registry (tables) and retention.sql (SQL) cannot reach. The
//          walker now purges every declared object store BEFORE deleting the
//          index rows, and reports it under `purged["storage:<bucket>"]`.

import "server-only";
import { sbDelete, sbSelectStrict } from "../runtime-config";
import { deleteMediaAudit } from "../media/audit";
import {
  USER_TABLES,
  CHILD_TABLES,
  USER_OBJECT_STORES,
  filterFor,
  type UserObjectStore,
} from "./user-tables";

export interface EraseResult {
  /**
   * Every table (and object store, keyed `storage:<bucket>`) the walker
   * touched, true = the purge succeeded.
   */
  purged: Record<string, boolean>;
  /** Tables whose purge failed (subset of purged, for the caller's message). */
  failed: string[];
  /** Whether the app_users row itself was deleted (done last). */
  userDeleted: boolean;
  /** Whether the pre-purge session revocation persisted. */
  sessionsRevoked: boolean;
  /**
   * Whether the WhatsApp link is actually GONE (Evolution instance deleted,
   * or there was never one). Also reported as `purged["whatsapp:link"]`, so a
   * live socket over an "erased" account is named like any failed table.
   */
  linkSevered: boolean;
}

/** Parent ids per page of the child walk (also the id in-list size per DELETE). */
const PARENT_PAGE = 1000;
/** Past this many pages one pass is inconclusive: named, deferred, retried. */
const MAX_PARENT_PAGES = 20;
/** Object ids per page of the store walk. */
const OBJECT_ID_PAGE = 500;
const MAX_OBJECT_ID_PAGES = 40;

type Walk = "done" | "inconclusive";

/**
 * Delete the children of every parent row the registry attributes to the
 * person. Paged, so a person with more parent rows than one page does not
 * leave an orphaned tail. "inconclusive" means the parent set could not be
 * fully read (or a child delete failed): the caller must NOT delete the
 * parents in this pass, or the children lose their only key.
 */
async function walkChild(
  child: (typeof CHILD_TABLES)[number],
  parentFilter: string
): Promise<{ walk: Walk; deleted: boolean }> {
  let deleted = true;
  for (let page = 0; page < MAX_PARENT_PAGES; page++) {
    const read = await sbSelectStrict<Record<string, unknown>>(
      child.parentTable,
      `select=${child.parentIdColumn}&${parentFilter}&order=${child.parentIdColumn}.asc` +
        `&limit=${PARENT_PAGE}&offset=${page * PARENT_PAGE}`
    );
    if ("error" in read) {
      // "missing" = the parent table does not exist on this database: no
      // parent rows can exist, so no children can either. Vacuously done.
      if (read.error === "missing") return { walk: "done", deleted };
      return { walk: "inconclusive", deleted };
    }
    const ids = read.rows
      .map((r) => r[child.parentIdColumn])
      .filter((v) => v !== null && v !== undefined);
    if (ids.length) {
      const ok = await sbDelete(
        child.table,
        `${child.childColumn}=in.(${ids.map((v) => encodeURIComponent(String(v))).join(",")})`
      ).catch(() => false);
      deleted = deleted && ok;
    }
    if (read.rows.length < PARENT_PAGE) return { walk: deleted ? "done" : "inconclusive", deleted };
  }
  // More parent rows than one pass walks: the tail is unread, so say so.
  return { walk: "inconclusive", deleted };
}

/**
 * Purge one object store: page the person's object ids out of the index
 * table, delete the objects, and say whether EVERY id was reached.
 * "inconclusive" when the index could not be fully read or a delete failed -
 * the caller must then keep the index rows for the retry.
 */
async function walkObjectStore(store: UserObjectStore, email: string): Promise<Walk> {
  const entry = USER_TABLES.find(
    (t) => t.table === store.indexTable && t.column === store.indexEntryColumn
  );
  if (!entry) return "inconclusive";
  const filter =
    `${store.indexExtraFilter ? `${store.indexExtraFilter}&` : ""}` +
    `${filterFor(entry, email)}&${store.indexIdColumn}=not.is.null`;
  for (let page = 0; page < MAX_OBJECT_ID_PAGES; page++) {
    const read = await sbSelectStrict<Record<string, unknown>>(
      store.indexTable,
      `select=${store.indexIdColumn}&${filter}&order=${store.indexIdColumn}.asc` +
        `&limit=${OBJECT_ID_PAGE}&offset=${page * OBJECT_ID_PAGE}`
    );
    if ("error" in read) return read.error === "missing" ? "done" : "inconclusive";
    const ids = read.rows
      .map((r) => r[store.indexIdColumn])
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (ids.length) {
      const res = await deleteMediaAudit(ids);
      if (!res.ok) return "inconclusive";
    }
    if (read.rows.length < OBJECT_ID_PAGE) return "done";
  }
  return "inconclusive";
}

/**
 * Erase every row the registry attributes to `email`, then the account row.
 *
 * Order matters three times: object stores before their index rows (the rows
 * are the only way to find the objects), children before their parents (the
 * child filters need the parent ids), and app_users LAST and ONLY when
 * everything else is gone - a partial failure leaves an account that can
 * retry its own erasure instead of an orphaned session over missing data.
 * WhatsApp is severed first so no new rows appear mid-walk.
 */
export async function eraseUserData(emailRaw: string): Promise<EraseResult> {
  const email = emailRaw.trim().toLowerCase();
  const purged: Record<string, boolean> = {};
  // Tables whose DELETE is skipped in THIS pass because something that still
  // needs their rows as a key (a child walk, an object store) was
  // inconclusive. They are reported as failed so the caller retries.
  const deferred = new Set<string>();

  // 1. Sever the WhatsApp link (logout + delete the Evolution instance) so
  //    webhooks stop writing new rows for this person while we delete.
  //
  //    The result COUNTS (audit F057). It used to be dropped, so a host past
  //    its abort or an unreadable EVOLUTION_HOSTS left the Baileys socket live
  //    while both routes answered "erased". A link that is not confirmed gone
  //    is reported under `whatsapp:link` exactly like a table that could not
  //    be purged - and wa_sessions (the only record that lets a retry find the
  //    instance) is deferred with it. The table walk still runs: everything
  //    the app holds is deleted regardless, and only the account row waits.
  const { disconnectInstance } = await import("../evolution");
  const sever = await disconnectInstance(email).catch(() => null);
  const linkSevered = sever?.severed === true;
  purged["whatsapp:link"] = linkSevered;
  if (!linkSevered) deferred.add("wa_sessions");

  // 2. Kill every session cookie NOW, while the app_users row still exists to
  //    carry the horizon. After the row is gone the horizon goes with it, so
  //    getSession's erased-account check (a strict "row is gone" read) is what
  //    holds from then on.
  const { revokeSessions } = await import("../access");
  const sessionsRevoked = await revokeSessions(email).catch(() => false);

  // 3. Children first: collect parent ids while the parents still exist.
  for (const child of CHILD_TABLES) {
    const parentEntry = USER_TABLES.find(
      (t) => t.table === child.parentTable && t.column === child.parentColumn
    );
    if (!parentEntry) {
      purged[child.table] = false;
      deferred.add(child.parentTable);
      continue;
    }
    try {
      const { walk, deleted } = await walkChild(child, filterFor(parentEntry, email));
      const ok = walk === "done" && deleted;
      purged[child.table] = (purged[child.table] ?? true) && ok;
      if (!ok) deferred.add(child.parentTable);
    } catch {
      purged[child.table] = false;
      deferred.add(child.parentTable);
    }
  }

  // 3b. Object stores, BEFORE the index rows they are found through.
  for (const store of USER_OBJECT_STORES) {
    const walk = await walkObjectStore(store, email).catch((): Walk => "inconclusive");
    purged[store.purgedKey] = walk === "done";
    if (walk !== "done") deferred.add(store.indexTable);
  }

  // 4. The registry proper. Two entries on one table (whatsapp_messages
  //    sender/receiver, the reset rows) AND both together must succeed for the
  //    table to count as purged. A deferred table is skipped - and NAMED - so
  //    the retry can still find what hangs off it.
  for (const entry of USER_TABLES) {
    if (deferred.has(entry.table)) {
      purged[entry.table] = false;
      continue;
    }
    const ok = await sbDelete(entry.table, filterFor(entry, email)).catch(() => false);
    purged[entry.table] = (purged[entry.table] ?? true) && ok;
  }

  const failed = Object.entries(purged)
    .filter(([, ok]) => !ok)
    .map(([t]) => t)
    .sort();

  // 5. The account row, last - and only over a clean walk. The routes tell the
  //    person "your account remains until everything is gone"; deleting it
  //    over a named failure would make that false and strand the retry.
  let userDeleted = false;
  if (failed.length === 0) {
    const { deleteUser } = await import("../access");
    userDeleted = await deleteUser(email).catch(() => false);
  }

  return { purged, failed, userDeleted, sessionsRevoked, linkSevered };
}
