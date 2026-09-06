import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F243: THE FLEET AND GAP SLOTS WERE NAMESPACED BY THE POLICY-CACHED GAP
// VALUE, SO TWO INSTANCES WITH DIFFERENT CACHED POLICIES BOTH WON AND BOTH SENT.
//
// The slot keys were `rfleet:<fleetGap>:<bucket>` and `gap:<gap>[:<shop>]:<bucket>`
// with the bucket ALSO computed at that gap. getPolicies caches per instance
// for 60s and a fresh instance whose first policy read blips serves the
// cautious preset (min_gap 30 -> fleet gap 15), so a warm instance at fleet gap
// 6 and a cold one at 15 computed DIFFERENT primary keys for the same instant:
// sbInsertClaim only says "lost" on an identical (sender_key, slot_key), so
// both claims won, and two messages left the traveller's personal number 50ms
// apart. The fleet slot is the ONLY cross-instance velocity cap replies have.
//
// The fix keys every pacing slot on a FIXED quantum (FLEET_SLOT_QUANTUM_SEC,
// the floor of max(5, min_gap/2), so no anti-ban number moves) and keeps the
// policy-derived gap where it belongs: in the straddle comparison, which reads
// the previous ceil(gap / quantum) quantum slots in ONE round trip and refuses
// anything inside `gap`. The refuter's concern - retryAtMs must be computed in
// the units the bucket index is in - is pinned here too.
//
// Every test RUNS claimSendSlots against a Map-backed claim store.

const state: { claims: Map<string, number>; nowMs: number } = {
  claims: new Map(),
  nowMs: 1_700_000_000_000,
};

const parseList = (s: string) =>
  s
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .split(",")
    .map((v) => decodeURIComponent(v.replace(/^"|"$/g, "")))
    .filter(Boolean);

vi.mock("../runtime-config", () => ({
  sbInsertClaim: async (_t: string, row: { sender_key: string; slot_key: string }) => {
    const key = `${row.sender_key}|${row.slot_key}`;
    if (state.claims.has(key)) return "lost" as const;
    state.claims.set(key, state.nowMs);
    return "won" as const;
  },
  sbDelete: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    state.claims.delete(`${sender}|${slot}`);
  },
  sbInsert: async () => true,
  // Understands both the single-slot read (`slot_key=eq.`) and the straddle
  // read over several slots (`slot_key=in.(...)&order=created_at.desc&limit=1`).
  sbSelectStrict: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const eq = /slot_key=eq\.([^&]+)/.exec(query)?.[1];
    const inList = /slot_key=in\.(\([^&]*\))/.exec(query)?.[1];
    const slots = eq ? [decodeURIComponent(eq)] : inList ? parseList(inList) : [];
    const hits = slots
      .map((s) => state.claims.get(`${sender}|${s}`))
      .filter((at): at is number => typeof at === "number")
      .sort((a, b) => b - a);
    const limit = Number(/limit=(\d+)/.exec(query)?.[1] ?? hits.length);
    return { rows: hits.slice(0, limit).map((at) => ({ created_at: new Date(at).toISOString() })) };
  },
}));

import { claimSendSlots, FLEET_SLOT_QUANTUM_SEC } from "./pacing";

const SENDER = "traveller@example.com";

/** A reply claim exactly as the reply lane makes one, at the instance's cached fleet gap. */
const replyClaim = (shop: string, text: string, fleetGap: number, gap = 5) =>
  claimSendSlots({
    senderKey: SENDER,
    toDigits: shop,
    text,
    auto: true,
    gapSeconds: gap,
    perRecipient: true,
    fleetGapSeconds: fleetGap,
    nowMs: state.nowMs,
  });

/** A cold introduction, at the instance's cached min-gap. */
const coldClaim = (shop: string, text: string, gap: number) =>
  claimSendSlots({
    senderKey: SENDER,
    toDigits: shop,
    text,
    auto: true,
    gapSeconds: gap,
    nowMs: state.nowMs,
  });

beforeEach(() => {
  state.claims = new Map();
  // 2s into a 5s quantum, 2s into a 15s window: nothing aligned by luck.
  state.nowMs = 1_700_000_000_000 - (1_700_000_000_000 % 15_000) + 2_000;
});

describe("the quantum is the floor of the fleet-gap formula - no anti-ban number moves", () => {
  it("FLEET_SLOT_QUANTUM_SEC is 5, the floor of max(5, min_gap/2)", () => {
    expect(FLEET_SLOT_QUANTUM_SEC).toBe(5);
  });
});

describe("EXECUTED (F243): two instances with divergent cached policies cannot both send", () => {
  it("the reply fleet lane: fleet gap 6 (warm) and 15 (cautious fallback) at the same instant", async () => {
    // Instance A (policy read succeeded, min_gap 12 -> fleet gap 6).
    const a = await replyClaim("66900000001", "reply to shop 1", 6);
    expect(a.ok).toBe(true);
    // Instance B, 50ms later, serving the cautious preset (fleet gap 15).
    state.nowMs += 50;
    const b = await replyClaim("66900000002", "reply to shop 2", 15);
    // THE ASSERTION THAT FAILED BEFORE: both claims won, because the keys
    // embedded 6 and 15 and were different primary keys.
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error("expected a refusal");
    expect(b.kind).toBe("pacing");
  });

  it("...and in the other order (the cautious instance sent first)", async () => {
    const a = await replyClaim("66900000001", "reply to shop 1", 15);
    expect(a.ok).toBe(true);
    state.nowMs += 50;
    const b = await replyClaim("66900000002", "reply to shop 2", 6);
    expect(b.ok).toBe(false);
  });

  it("the cold lane: min-gap 12 (warm) and 30 (cautious fallback) at the same instant", async () => {
    const a = await coldClaim("66900000001", "hello shop 1", 12);
    expect(a.ok).toBe(true);
    state.nowMs += 50;
    const b = await coldClaim("66900000002", "hello shop 2", 30);
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error("expected a refusal");
    expect(b.kind).toBe("pacing");
  });

  it("a cautious instance is still refused 12s after a warm instance's cold intro", async () => {
    // The straddle carries the refusing instance's OWN gap (30s), so a
    // quantized key does not loosen the spacing the cautious policy asks for.
    const a = await coldClaim("66900000001", "hello shop 1", 12);
    expect(a.ok).toBe(true);
    state.nowMs += 12_000;
    const b = await coldClaim("66900000002", "hello shop 2", 30);
    expect(b.ok).toBe(false);
  });
});

describe("retryAtMs is computed in the units the slot index is in (the refuter's concern)", () => {
  it("a lost fleet claim at gap 15 names EXACTLY winner + gap, and sleeping to it succeeds", async () => {
    const winnerAt = state.nowMs;
    expect((await replyClaim("66900000001", "reply to shop 1", 15)).ok).toBe(true);
    state.nowMs += 50;
    const refused = await replyClaim("66900000002", "reply to shop 2", 15);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    // Not the quantum edge (too early - still refused by the straddle) and not
    // a gap-sized bucket edge computed from a quantum index (up to 3x late).
    expect(refused.retryAtMs).toBe(winnerAt + 15_000);
    state.nowMs = refused.retryAtMs ?? state.nowMs;
    expect((await replyClaim("66900000002", "reply to shop 2", 15)).ok).toBe(true);
  });

  it("a lost cold claim at gap 30 names EXACTLY winner + gap, and sleeping to it succeeds", async () => {
    const winnerAt = state.nowMs;
    expect((await coldClaim("66900000001", "hello shop 1", 30)).ok).toBe(true);
    state.nowMs += 50;
    const refused = await coldClaim("66900000002", "hello shop 2", 30);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.retryAtMs).toBe(winnerAt + 30_000);
    state.nowMs = refused.retryAtMs ?? state.nowMs;
    expect((await coldClaim("66900000002", "hello shop 2", 30)).ok).toBe(true);
  });

  it("a straddle refusal one quantum later still names winner + gap", async () => {
    const winnerAt = state.nowMs;
    expect((await replyClaim("66900000001", "reply to shop 1", 15)).ok).toBe(true);
    // Next quantum slot: the INSERT wins, the straddle must refuse.
    state.nowMs += FLEET_SLOT_QUANTUM_SEC * 1000 + 100;
    const refused = await replyClaim("66900000002", "reply to shop 2", 15);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.retryAtMs).toBe(winnerAt + 15_000);
    // ...and the refused attempt left no claim row behind.
    const residue = [...state.claims.keys()].filter((k) => k.includes("66900000002"));
    expect(residue).toEqual([]);
  });
});

describe("the spacing that is enforced is still exactly the configured gap", () => {
  it("seven engaged shops at fleet gap 6 land 6s apart, never closer", async () => {
    const shops = Array.from({ length: 7 }, (_, i) => `6690000000${i + 1}`);
    const landed: number[] = [];
    for (const shop of shops) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await replyClaim(shop, `reply to ${shop}`, 6);
        if (r.ok) {
          landed.push(state.nowMs);
          break;
        }
        if (r.kind !== "pacing" || typeof r.retryAtMs !== "number") break;
        state.nowMs = Math.max(state.nowMs + 1, r.retryAtMs);
      }
    }
    expect(landed).toHaveLength(7);
    for (let i = 1; i < landed.length; i++) {
      expect(landed[i] - landed[i - 1]).toBeGreaterThanOrEqual(6_000);
    }
    expect(landed[6] - landed[0]).toBeLessThanOrEqual(6 * 6_000 + 1_000);
  });

  it("cold intros at min-gap 12 land 12s apart, never closer", async () => {
    const shops = Array.from({ length: 4 }, (_, i) => `6680000000${i + 1}`);
    const landed: number[] = [];
    for (const shop of shops) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await coldClaim(shop, `hello ${shop}`, 12);
        if (r.ok) {
          landed.push(state.nowMs);
          break;
        }
        if (r.kind !== "pacing" || typeof r.retryAtMs !== "number") break;
        state.nowMs = Math.max(state.nowMs + 1, r.retryAtMs);
      }
    }
    expect(landed).toHaveLength(4);
    for (let i = 1; i < landed.length; i++) {
      expect(landed[i] - landed[i - 1]).toBeGreaterThanOrEqual(12_000);
    }
  });
});
