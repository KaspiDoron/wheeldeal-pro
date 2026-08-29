// SPTE public surface (V2-4). The Single-Pass Turn Engine: Blackboard +
// single-pass agent that replaces the graph director/edge branching. See
// docs/V2-BLUEPRINT.md section 4. Gated behind ENGINE_V3 during the dual-run; the
// graph engine remains the live path + rollback until golden parity is proven.

export * from "./types";
export { legalMovesFor, reflexTurn, coerceToLegal } from "./policy";
export { runSinglePass, pickRoute, fallbackArtifact } from "./pass";
export { runPostRails } from "./rails";
export { mergeDigest, emptyDigest } from "./digest";
export { runTurn, type TurnOutcome } from "./orchestrator";

/**
 * SPTE is the PRIMARY engine app-wide: ON by default, disabled ONLY by an
 * explicit ENGINE_V3=off / 0 / false (the owner kill switch for an emergency
 * rollback to the graph engine). The graph engine still stands behind it as the
 * runtime fallback safety net, so "off" is a hard rollback, not the default.
 */
export async function engineV3Enabled(): Promise<boolean> {
  try {
    const { getConfig } = await import("../runtime-config");
    // THE ONE OWNER SWITCH, tri-state: unset/"spte" -> SPTE primary (the
    // default); "graph" -> the graph engine takes every turn (a deliberate,
    // reversible rollback with a name, instead of remembering which legacy
    // boolean spelled it). ENGINE_V3=off stays honoured as the historical
    // spelling of the same rollback.
    const mode = ((await getConfig("NEGOTIATION_ENGINE")) ?? "").trim().toLowerCase();
    if (mode === "graph") return false;
    const v = ((await getConfig("ENGINE_V3")) ?? "").trim().toLowerCase();
    return v !== "off" && v !== "0" && v !== "false";
  } catch {
    // Config unreadable -> default ON (the graph-engine fallback still protects
    // the turn), so a transient config blip never silently reverts the engine.
    return true;
  }
}
