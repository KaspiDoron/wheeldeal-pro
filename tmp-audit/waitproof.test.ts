import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { sender_key: string; slot_key: string; created_at: string };
const table: Row[] = [];

vi.mock("../src/lib/runtime-config", () => ({
  sbInsertClaim: async (_t: string, r: { sender_key: string; slot_key: string }) => {
    if (table.some((x) => x.sender_key === r.sender_key && x.slot_key === r.slot_key)) return "lost";
    table.push({ ...r, created_at: new Date(NOW.v).toISOString() });
    return "ok";
  },
  sbSelectStrict: async (_t: string, q: string) => {
    const m = /slot_key=eq\.([^&]+)/.exec(q);
    const s = m ? decodeURIComponent(m[1]) : "";
    const sm = /sender_key=eq\.([^&]+)/.exec(q);
    const sk = sm ? decodeURIComponent(sm[1]) : "";
    const rows = table.filter((x) => x.slot_key === s && x.sender_key === sk);
    return { rows };
  },
  sbDelete: async (_t: string, q: string) => {
    const m = /slot_key=eq\.([^&]+)/.exec(q);
    const s = m ? decodeURIComponent(m[1]) : "";
    for (let i = table.length - 1; i >= 0; i--) if (table[i].slot_key === s) table.splice(i, 1);
    return true;
  },
  sbInsert: async () => true,
}));

const NOW = { v: 0 };

describe("wait-to-bucket-edge vs the straddle check", () => {
  beforeEach(() => { table.length = 0; });

  it("second reply that waits to the fleet bucket edge is STILL refused", async () => {
    const { claimSendSlots } = await import("../src/lib/wa/pacing");
    // t0 lands 2.0s into a 6s fleet bucket (the common case).
    const base = 6_000 * 1_000_000;
    NOW.v = base + 2_000;
    const a = await claimSendSlots({
      senderKey: "u@x", toDigits: "66111111111", text: "reply A",
      auto: true, gapSeconds: 5, perRecipient: true, fleetGapSeconds: 6, nowMs: NOW.v,
    });
    expect(a.ok).toBe(true);

    // Reply B to a DIFFERENT shop, 3s later -> same fleet bucket -> refused.
    NOW.v = base + 5_000;
    const b1 = await claimSendSlots({
      senderKey: "u@x", toDigits: "66222222222", text: "reply B",
      auto: true, gapSeconds: 5, perRecipient: true, fleetGapSeconds: 6, nowMs: NOW.v,
    }) as { ok: false; kind: string; retryAtMs?: number };
    expect(b1.ok).toBe(false);
    expect(b1.kind).toBe("pacing");
    const waitMs = (b1.retryAtMs ?? 0) - NOW.v;
    // The drain sleeps waitMs + 120..500ms and re-claims ONCE.
    NOW.v = (b1.retryAtMs ?? 0) + 300;
    const b2 = await claimSendSlots({
      senderKey: "u@x", toDigits: "66222222222", text: "reply B",
      auto: true, gapSeconds: 5, perRecipient: true, fleetGapSeconds: 6, nowMs: NOW.v,
    }) as { ok: boolean; kind?: string; retryAtMs?: number };
    console.log("waitMs=", waitMs, "second claim =", JSON.stringify(b2));
    expect(b2.ok).toBe(false); // <-- the wait was spent for nothing
  });
});
