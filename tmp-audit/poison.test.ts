import { describe, it, expect, vi, beforeEach } from "vitest";
type Row = { sender_key: string; slot_key: string; created_at: string };
const table: Row[] = []; const NOW = { v: 0 };
vi.mock("../src/lib/runtime-config", () => ({
  sbInsertClaim: async (_t: string, r: any) => {
    if (table.some((x) => x.sender_key === r.sender_key && x.slot_key === r.slot_key)) return "lost";
    table.push({ ...r, created_at: new Date(NOW.v).toISOString() }); return "ok";
  },
  sbSelectStrict: async (_t: string, q: string) => {
    const s = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(q)?.[1] ?? "");
    const sk = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(q)?.[1] ?? "");
    return { rows: table.filter((x) => x.slot_key === s && x.sender_key === sk) };
  },
  sbDelete: async (_t: string, q: string) => {
    const s = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(q)?.[1] ?? "");
    for (let i = table.length - 1; i >= 0; i--) if (table[i].slot_key === s) table.splice(i, 1);
    return true;
  },
  sbInsert: async () => true,
}));
describe("straddle probes are never released on a refusal", () => {
  beforeEach(() => { table.length = 0; });
  it("a REFUSED attempt leaves to:<digits>:<b-1> stamped NOW, poisoning the recipient mutex", async () => {
    const { claimSendSlots } = await import("../src/lib/wa/pacing");
    const base = 8_000 * 1_000_000 + 4_000; // mid recipient bucket
    // Occupier takes the fleet slot for shop A.
    NOW.v = base;
    await claimSendSlots({ senderKey: "u", toDigits: "66900000001", text: "A",
      auto: true, gapSeconds: 5, perRecipient: true, fleetGapSeconds: 6, nowMs: NOW.v });
    // Shop B's first attempt loses ONLY the fleet lane. Nothing is sent to B.
    NOW.v = base + 1_000;
    const r1 = await claimSendSlots({ senderKey: "u", toDigits: "66900000002", text: "B",
      auto: true, gapSeconds: 5, perRecipient: true, fleetGapSeconds: 6, nowMs: NOW.v });
    expect(r1.ok).toBe(false);
    const leaked = table.filter((r) => r.slot_key.startsWith("to:66900000002"));
    console.log("rows left behind for shop B after a REFUSED attempt:",
      JSON.stringify(leaked.map((r) => [r.slot_key, r.created_at])));
    // Bucket b-1 probe survives, stamped with the FAILED attempt's clock.
    expect(leaked.length).toBeGreaterThan(0);
  });
});
