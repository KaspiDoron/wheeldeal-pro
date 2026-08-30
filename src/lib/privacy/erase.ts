// The erase walker: one function that removes a person, driven by the
// registry in user-tables.ts. Used by the admin Users action and the
// self-serve /api/profile/erase - neither route carries its own table list any
// more, so the registry is the single place erasure can silently rot.
//
// Honesty contract: the result names every table that could NOT be purged.
// A 200 "erased" over rows that are still there is worse than a failure the
// owner can retry - that is the exact defect the old four-table map had.

import "server-only";
import { sbDelete, sbSelect } from "../runtime-config";
import { USER_TABLES, CHILD_TABLES, filterFor } from "./user-tables";

export interface EraseResult {
  /** Every table the walker touched, true = the DELETE succeeded. */
  purged: Record<string, boolean>;
  /** Tables whose purge failed (subset of purged, for the caller's message). */
  failed: string[];
  /** Whether the app_users row itself was deleted (done last). */
  userDeleted: boolean;
  /** Whether the pre-purge session revocation persisted. */
  sessionsRevoked: boolean;
}

/**
 * Erase every row the registry attributes to `email`, then the account row.
 *
 * Order matters twice: children before their parents (the child filters need
 * the parent ids), and app_users LAST - a partial failure leaves an account
 * that can retry its own erasure instead of an orphaned session over missing
 * data. WhatsApp is severed first so no new rows appear mid-walk.
 */
export async function eraseUserData(emailRaw: string): Promise<EraseResult> {
  const email = emailRaw.trim().toLowerCase();
  const purged: Record<string, boolean> = {};

  // 1. Sever the WhatsApp link (logout + delete the Evolution instance) so
  //    webhooks stop writing new rows for this person while we delete.
  const { disconnectInstance } = await import("../evolution");
  await disconnectInstance(email).catch(() => false);

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
      continue;
    }
    try {
      const parents = await sbSelect<Record<string, unknown>>(
        child.parentTable,
        `select=${child.parentIdColumn}&${filterFor(parentEntry, email)}&limit=1000`
      );
      const ids = parents
        .map((r) => r[child.parentIdColumn])
        .filter((v) => v !== null && v !== undefined);
      if (!ids.length) {
        purged[child.table] = true; // nothing to delete IS a successful purge
        continue;
      }
      purged[child.table] = await sbDelete(
        child.table,
        `${child.childColumn}=in.(${ids.map((v) => encodeURIComponent(String(v))).join(",")})`
      );
    } catch {
      purged[child.table] = false;
    }
  }

  // 4. The registry proper. Two entries on one table (whatsapp_messages
  //    sender/receiver, the reset rows) AND both together must succeed for the
  //    table to count as purged.
  for (const entry of USER_TABLES) {
    const ok = await sbDelete(entry.table, filterFor(entry, email)).catch(() => false);
    purged[entry.table] = (purged[entry.table] ?? true) && ok;
  }

  // 5. The account row, last.
  const { deleteUser } = await import("../access");
  const userDeleted = await deleteUser(email).catch(() => false);

  const failed = Object.entries(purged)
    .filter(([, ok]) => !ok)
    .map(([t]) => t)
    .sort();
  return { purged, failed, userDeleted, sessionsRevoked };
}
