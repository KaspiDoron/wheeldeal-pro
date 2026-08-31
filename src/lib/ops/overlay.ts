// Policy overlay - owner-tunable negotiation thresholds, hard-clamped.
//
// A deliberate LEAF module (only runtime-config imports) so the hot path
// (graph engine, composers) can read it without import cycles; policy.ts
// re-exports it for the versioned-save layer. Every field defaults to the
// engine's historical literal, so "no overlay saved" means byte-identical
// behavior; clamp ranges are narrow enough that the owner tunes, never breaks.

import { getConfig } from "../runtime-config";

export interface PolicyOverlay {
  /** A quote within floor*X counts as "great price" (default 1.05). */
  floorTolerance: number;
  /** Price counts as far above floor when > floor*X (default 1.08 - see
   *  DEFAULT_OVERLAY's rationale for the aggressive stance). */
  priceFarAboveFloor: number;
  /** Effective floor vs a posted price sheet: sheet*X (default 0.8). */
  sheetAnchor: number;
  /** Never ask below quoted*X when no floor is known (default 0.6). */
  lowballGuard: number;
  /** Default opening ask without an engine target: quoted*X (default 0.85). */
  defaultCut: number;
  /** Phrases the style validator must strip/avoid in outbound messages. */
  bannedPhrases: string[];
}

export const DEFAULT_OVERLAY: PolicyOverlay = {
  floorTolerance: 1.05,
  // AGGRESSIVE market-floor stance: any quote more than ~8% above the absolute
  // known market floor still has room, so the agent keeps pushing across rounds
  // instead of drifting to logistics. (Was 1.25 = only pushed past 25% above
  // floor - far too soft.) The firm-count + tone-degraded + max-rounds guards
  // still stop it nagging a shop that has genuinely bottomed out.
  priceFarAboveFloor: 1.08,
  sheetAnchor: 0.8,
  lowballGuard: 0.6,
  defaultCut: 0.85,
  bannedPhrases: [],
};

const CLAMPS: Record<keyof Omit<PolicyOverlay, "bannedPhrases">, [number, number]> = {
  floorTolerance: [1.0, 1.15],
  priceFarAboveFloor: [1.03, 1.6],
  sheetAnchor: [0.7, 0.95],
  lowballGuard: [0.5, 0.8],
  defaultCut: [0.7, 0.95],
};

export function clampOverlay(raw: unknown): PolicyOverlay {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: PolicyOverlay = { ...DEFAULT_OVERLAY, bannedPhrases: [] };
  for (const key of Object.keys(CLAMPS) as (keyof typeof CLAMPS)[]) {
    const v = Number(src[key]);
    const [lo, hi] = CLAMPS[key];
    out[key] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_OVERLAY[key];
  }
  if (Array.isArray(src.bannedPhrases)) {
    out.bannedPhrases = src.bannedPhrases
      .map((p) => String(p).trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 20);
  }
  return out;
}

declare global {
  // eslint-disable-next-line no-var
  var __wd_policy_overlay__: { at: number; value: PolicyOverlay } | undefined;
}

/** The active overlay (defaults when none saved). Cached 30s - hot-path safe. */
export async function getPolicyOverlay(): Promise<PolicyOverlay> {
  const cached = globalThis.__wd_policy_overlay__;
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  let value = DEFAULT_OVERLAY;
  try {
    const raw = await getConfig("policy_overlay");
    if (raw) value = clampOverlay(JSON.parse(raw));
  } catch {
    /* defaults */
  }
  globalThis.__wd_policy_overlay__ = { at: Date.now(), value };
  return value;
}

export function bustOverlayCache(): void {
  globalThis.__wd_policy_overlay__ = undefined;
}
