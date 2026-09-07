import "server-only";

// THE VERSIONED READ-MODIFY-WRITE FOR `negotiation_threads.fields` (audit M38).
//
// `fields` is ONE JSONB blob, and several writers rebuild it whole from a copy
// they read a moment earlier. The engine's own `saveThreadState`
// (graph/state.ts) writes it under `version=eq.<read>`; the writers that run
// OUTSIDE the per-thread turn claim - the traveller's substitution decision on
// /api/negotiate/alternative, and the per-hunt reset in session-close - used a
// bare `thread_key=eq.<key>` PATCH. Either direction erased the other's write,
// and because the bare PATCH also left `version` untouched, saveThreadState's
// own cas could not even see that it had lost: the lost-race merge that exists
// precisely to protect the SPTE digest never ran.
//
// This helper is that missing guard, and it costs NOTHING on the happy path.
// The caller passes the `version` it already read beside `fields`, so the first
// attempt is a single conditional PATCH. Only a genuine race pays for a
// re-read - and the re-read RE-APPLIES the mutation to the fresher row rather
// than replaying a stale object over it, so the writer that lost the race is
// merged in instead of being either dropped or resurrected.
//
// The answer is the WRITE, never the intention (honest writes): "persisted"
// means PostgREST handed back the updated row.

/** What a caller must have read to patch under a version guard. */
export interface ThreadPatchRow {
  thread_key: string;
  fields: Record<string, unknown> | null;
  version?: number | null;
  phase?: string | null;
  stage?: string | null;
}

/**
 * Mutate a COPY of the row's current fields. Return the object to write, or
 * null to leave the row completely alone. Called again, on the fresher row,
 * when the first attempt loses the version race.
 */
export type ThreadFieldsMutation = (
  fields: Record<string, unknown>,
  row: ThreadPatchRow
) => Record<string, unknown> | null;

export type ThreadPatchOutcome = "persisted" | "unchanged" | "failed";

/** Every column the retry needs to rebuild the patch from a fresher row. */
export const THREAD_PATCH_SELECT = "select=thread_key,fields,version,phase,stage";

async function readRow(threadKey: string): Promise<ThreadPatchRow | null> {
  const { sbSelect } = await import("../runtime-config");
  const rows = await sbSelect<ThreadPatchRow>(
    "negotiation_threads",
    `${THREAD_PATCH_SELECT}&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
  );
  return rows[0] ?? null;
}

export async function patchThreadFields(args: {
  threadKey: string;
  /** The row the caller already read - skipped only when it carries no version. */
  row?: ThreadPatchRow | null;
  mutate: ThreadFieldsMutation;
  /** Non-`fields` columns written in the SAME round trip, per attempt. */
  columns?: (row: ThreadPatchRow) => Record<string, unknown>;
}): Promise<ThreadPatchOutcome> {
  try {
    const { sbUpdateReturning } = await import("../runtime-config");
    let row: ThreadPatchRow | null =
      args.row && typeof args.row.version === "number" ? args.row : await readRow(args.threadKey);
    // One re-read, one retry: a hot thread must not spin on the reply path.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!row) return "failed";
      const version = typeof row.version === "number" ? row.version : null;
      const next = args.mutate({ ...(row.fields ?? {}) }, row);
      if (!next) return "unchanged";
      const values: Record<string, unknown> = {
        ...(args.columns ? args.columns(row) : {}),
        fields: next,
        updated_at: new Date().toISOString(),
      };
      let filter = `thread_key=eq.${encodeURIComponent(row.thread_key)}`;
      if (version !== null) {
        values.version = version + 1;
        filter += `&version=eq.${version}`;
      }
      const updated = await sbUpdateReturning<{ thread_key: string }>(
        "negotiation_threads",
        filter,
        values
      );
      if (updated.length > 0) return "persisted";
      // Unversioned rows cannot be guarded, so an empty return is a real
      // failure rather than a race - say so instead of retrying blind.
      if (version === null) return "failed";
      row = await readRow(args.threadKey);
    }
    return "failed";
  } catch {
    return "failed";
  }
}
