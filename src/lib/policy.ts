// Policy versioning - the single chokepoint for every behavior-affecting
// write (graph spec edits, coach patches, ops rules, threshold overlays).
//
// Every save lands as a full snapshot in policy_versions (audit trail), the
// newest activated row's id becomes the "active behavior revision" stamped on
// all traces/scores (see ops/rev.ts), and rollback is just re-activating an
// older row. From Phase 4 on, activation of behavior changes is gated on a
// passing golden-replay report.
//
// Demo mode (no Supabase): the underlying setConfig/sb* helpers no-op softly,
// so saves still apply in-process and versioning silently degrades.

import "server-only";
import { sbSelect, sbInsertReturning, sbUpdate, setConfig } from "./runtime-config";
import { saveGraphSpec } from "./graph/engine";
import { sanitizeGraphSpec } from "./graph/default-graph";
import type { GraphSpec } from "./graph/types";
import { bustActiveRevCache } from "./ops/rev";
import { clampOverlay, bustOverlayCache } from "./ops/overlay";
import type { PolicyKind, PolicyVersion, ReplayReport } from "./ops/types";

// The overlay itself lives in ops/overlay.ts (a leaf the engine can import
// without cycles); re-export so callers keep one policy entry point.
export {
  clampOverlay,
  getPolicyOverlay,
  bustOverlayCache,
  DEFAULT_OVERLAY,
  type PolicyOverlay,
} from "./ops/overlay";

// ---------------------------------------------------------------------------
// Versioned saves
// ---------------------------------------------------------------------------

export interface VersionedSaveResult {
  ok: boolean;
  problems: string[];
  versionId: number | null;
}

/**
 * Persist a behavior change AND record it as a policy_versions row in one
 * step. graph_spec goes through the engine's sanitize+validate (a bad spec
 * never lands); policy_overlay is hard-clamped; ops_learning (the compiled
 * learning blob the live prompts read) is written to its config key. The new
 * row becomes active.
 */
export async function saveVersionedSpec(args: {
  kind: PolicyKind;
  spec: unknown;
  note: string;
  author: string;
  replayReport?: ReplayReport | null;
}): Promise<VersionedSaveResult> {
  if (args.kind === "graph_spec") {
    const clean = sanitizeGraphSpec(args.spec as GraphSpec);
    const res = await saveGraphSpec(clean);
    if (!res.ok) return { ...res, versionId: null };
    const versionId = await recordVersion(args.kind, clean, args.note, args.author, args.replayReport);
    return { ok: true, problems: [], versionId };
  }
  if (args.kind === "ops_learning") {
    // The compiled learning blob is behavior-affecting config (it reaches every
    // director/judge prompt), so it goes through THIS chokepoint like the other
    // two kinds - the learning loop used to setConfig it directly, with no
    // version row, no gate and no rollback, contradicting the contract at the
    // top of this file. Dynamic import: learning.ts calls back into this module.
    //
    // HONEST WRITE: setConfig's ok IS whether the behavior changed. Demo mode
    // stays ok:true (memory persist reports ok with a persistence warning); a
    // real write failure must not come back as "activated".
    const wrote = await setConfig("ops_learning", JSON.stringify(args.spec ?? null)).catch(
      () => ({ ok: false, persistent: false, error: "vault write threw" })
    );
    if (wrote && !wrote.ok) {
      return {
        ok: false,
        problems: [wrote.error ?? "The learning blob was NOT stored - behavior is unchanged."],
        versionId: null,
      };
    }
    const { bustOpsLearningCache } = await import("./ops/learning");
    bustOpsLearningCache();
    const versionId = await recordVersion(args.kind, args.spec, args.note, args.author, args.replayReport);
    return { ok: true, problems: versionId == null ? ["Saved, but the version row was not recorded - rollback for this change is unavailable."] : [], versionId };
  }
  // policy_overlay
  const clean = clampOverlay(args.spec);
  const wrote = await setConfig("policy_overlay", JSON.stringify(clean)).catch(
    () => ({ ok: false, persistent: false, error: "vault write threw" })
  );
  if (wrote && !wrote.ok) {
    return {
      ok: false,
      problems: [wrote.error ?? "The overlay was NOT stored - behavior is unchanged."],
      versionId: null,
    };
  }
  bustOverlayCache();
  const versionId = await recordVersion(args.kind, clean, args.note, args.author, args.replayReport);
  return { ok: true, problems: versionId == null ? ["Saved, but the version row was not recorded - rollback for this change is unavailable."] : [], versionId };
}

/** Roll back / re-activate an existing version row (no new row is created). */
export async function activateVersion(
  id: number,
  replayReport?: ReplayReport | null
): Promise<{ ok: boolean; problems: string[] }> {
  const rows = await sbSelect<PolicyVersion>(
    "policy_versions",
    `select=id,kind,version,spec&id=eq.${Math.round(id)}&limit=1`
  ).catch(() => []);
  const row = rows[0];
  if (!row) return { ok: false, problems: ["Version not found."] };

  // HONEST WRITES, in two tiers: the SPEC write is the rollback itself - if it
  // failed, behavior did not change and the answer is ok:false. The version-row
  // bookkeeping after it is audit truth - a failure there does not undo the
  // behavior change, so it is reported as a problem on an ok:true result
  // rather than silently swallowed (the route already renders `problems`).
  if (row.kind === "graph_spec") {
    const res = await saveGraphSpec(sanitizeGraphSpec(row.spec as GraphSpec));
    if (!res.ok) return res;
  } else if (row.kind === "ops_learning") {
    const wrote = await setConfig("ops_learning", JSON.stringify(row.spec ?? null)).catch(
      () => ({ ok: false, persistent: false, error: "vault write threw" })
    );
    if (wrote && !wrote.ok) {
      return { ok: false, problems: [wrote.error ?? "The rollback was NOT stored - behavior is unchanged."] };
    }
    const { bustOpsLearningCache } = await import("./ops/learning");
    bustOpsLearningCache();
  } else {
    const wrote = await setConfig("policy_overlay", JSON.stringify(clampOverlay(row.spec))).catch(
      () => ({ ok: false, persistent: false, error: "vault write threw" })
    );
    if (wrote && !wrote.ok) {
      return { ok: false, problems: [wrote.error ?? "The rollback was NOT stored - behavior is unchanged."] };
    }
    bustOverlayCache();
  }
  const problems: string[] = [];
  const cleared = await sbUpdate("policy_versions", `kind=eq.${row.kind}&active=is.true`, { active: false }).catch(
    () => false
  );
  const patch: Record<string, unknown> = { active: true };
  if (replayReport) patch.replay_score = replayReport;
  const marked = await sbUpdate("policy_versions", `id=eq.${row.id}`, patch).catch(() => false);
  if (!cleared || !marked) {
    problems.push("Behavior rolled back, but the version history did not update - the Versions list may show the wrong row as active.");
  }
  const revWrote = await setConfig("ops_active_rev", String(row.id)).catch(
    () => ({ ok: false, persistent: false }) as { ok: boolean; persistent: boolean }
  );
  if (revWrote && !revWrote.ok) {
    problems.push("Behavior rolled back, but the active-revision stamp did not update - new traces may carry the old revision id.");
  }
  bustActiveRevCache();
  return { ok: true, problems };
}

/** Version history for the Policy tab (newest first). */
export async function listVersions(kind?: PolicyKind, limit = 30): Promise<PolicyVersion[]> {
  const filter = kind ? `kind=eq.${kind}&` : "";
  return sbSelect<PolicyVersion>(
    "policy_versions",
    `select=id,kind,version,note,author,replay_score,active,created_at&${filter}order=created_at.desc&limit=${Math.min(
      100,
      Math.max(1, limit)
    )}`
  ).catch(() => []);
}

async function recordVersion(
  kind: PolicyKind,
  spec: unknown,
  note: string,
  author: string,
  replay?: ReplayReport | null
): Promise<number | null> {
  try {
    const prev = await sbSelect<{ version: number }>(
      "policy_versions",
      `select=version&kind=eq.${kind}&order=version.desc&limit=1`
    ).catch(() => []);
    const version = (prev[0]?.version ?? 0) + 1;
    await sbUpdate("policy_versions", `kind=eq.${kind}&active=is.true`, { active: false }).catch(
      () => false
    );
    const rows = await sbInsertReturning<{ id: number }>("policy_versions", [
      {
        kind,
        version,
        spec,
        note: note.slice(0, 500),
        author: author.slice(0, 200),
        replay_score: replay ?? null,
        active: true,
      },
    ]).catch(() => []);
    const id = rows[0]?.id ?? null;
    if (id) {
      await setConfig("ops_active_rev", String(id)).catch(() => {});
      bustActiveRevCache();
    }
    return id;
  } catch {
    return null; // versioning must never block the save itself
  }
}
