import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { setConfig, sbSelect } from "@/lib/runtime-config";
import { getPolicyOverlay, clampOverlay } from "@/lib/ops/overlay";
import { saveVersionedSpec, activateVersion, listVersions } from "@/lib/policy";
import { runGoldenSuite, goldenGateBlocks } from "@/lib/ops/golden";
import { opsLearningEnabled, bustOpsLearningCache } from "@/lib/ops/learning";
import { sanitizeGraphSpec } from "@/lib/graph/default-graph";
import { getActiveRev } from "@/lib/ops/rev";
import type { GraphSpec } from "@/lib/graph/types";

// The Policy tab's backend: the active overlay, the version history, the
// learning kill switch - and the EVAL GATE: a behavior change (overlay save
// or rollback) only activates after every enabled golden case passes under
// the candidate. The passing report is stored on the version row (audit).

export async function GET() {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });
  const [overlay, versions, learning, activeRev, golden] = await Promise.all([
    getPolicyOverlay(),
    listVersions(undefined, 40),
    opsLearningEnabled(),
    getActiveRev(),
    sbSelect<{ id: number }>("agent_golden_cases", "select=id&enabled=eq.true&limit=24").catch(
      () => []
    ),
  ]);
  return NextResponse.json({
    overlay,
    versions,
    learningEnabled: learning,
    activeRev,
    goldenCount: golden.length,
  });
}

export async function POST(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  // Kill switch for the whole compiled-learning channel. HONEST WRITE: the
  // response echoes the STORED value (a fresh re-read), never the requested
  // one - the panel repaints its toggle from this field, and echoing the
  // request painted a flip the vault may have refused.
  if (body.action === "learning") {
    const wrote = await setConfig("OPS_LEARNING", body.on ? "on" : "off").catch(
      () => ({ ok: false, persistent: false }) as { ok: boolean; persistent: boolean }
    );
    bustOpsLearningCache();
    const stored = await opsLearningEnabled();
    if (!wrote.ok) {
      return NextResponse.json(
        { ok: false, learningEnabled: stored, error: "The switch did NOT change - the write failed." },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: stored === Boolean(body.on), learningEnabled: stored });
  }

  if (body.action === "save" && body.kind === "policy_overlay") {
    const candidate = clampOverlay(body.spec);
    // EVAL GATE: the candidate must keep every golden case green. Fails CLOSED
    // on an unreadable golden store (goldenGateBlocks).
    const report = await runGoldenSuite({ overlay: candidate });
    const blocked = goldenGateBlocks(report);
    if (blocked) {
      return NextResponse.json(
        { error: `${blocked} The overlay was not activated.`, report },
        { status: 409 }
      );
    }
    const res = await saveVersionedSpec({
      kind: "policy_overlay",
      spec: candidate,
      note: String(body.note ?? "Overlay update").slice(0, 300),
      author: session.email,
      replayReport: report,
    });
    return NextResponse.json({ ok: res.ok, versionId: res.versionId, report });
  }

  if (body.action === "rollback" && Number.isFinite(Number(body.versionId))) {
    const id = Number(body.versionId);
    const rows = await sbSelect<{ kind: string; spec: unknown }>(
      "policy_versions",
      `select=kind,spec&id=eq.${id}&limit=1`
    ).catch(() => []);
    if (!rows[0]) return NextResponse.json({ error: "Version not found." }, { status: 404 });
    // Even a rollback passes the gate - an OLD spec can still break NEW cases.
    // ops_learning is prompt-side only, so the deterministic suite runs as the
    // baseline check; the gate still fails closed on an unreadable store.
    const report =
      rows[0].kind === "graph_spec"
        ? await runGoldenSuite({ spec: sanitizeGraphSpec(rows[0].spec as GraphSpec) })
        : rows[0].kind === "policy_overlay"
          ? await runGoldenSuite({ overlay: clampOverlay(rows[0].spec) })
          : await runGoldenSuite();
    const blocked = goldenGateBlocks(report);
    if (blocked) {
      return NextResponse.json(
        { error: `${blocked} Rollback blocked.`, report },
        { status: 409 }
      );
    }
    const res = await activateVersion(id, report);
    if (!res.ok) return NextResponse.json({ error: res.problems.join("; ") }, { status: 400 });
    return NextResponse.json({ ok: true, report });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

export const maxDuration = 60;
