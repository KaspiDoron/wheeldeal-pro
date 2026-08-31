import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { sender_key: string; slot_key: string; created_at: string };
const table: Row[] = [];
const NOW = { v: 0 };

vi.mock("../src/lib/runtime-config", () => ({
  sbInsertClaim: async (_t: string, r: { sender_key: string; slot_key: string }) => {
    if (table.some((x) => x.sender_key === r.sender_key && x.slot_key === r.slot_key)) return "lost";
    table.push({ ...r, created_at: new Date(NOW.v).toISOString() });
    return "ok";
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

describe("7 shops reply at once - the INLINE guardAndSend path (spte/live -> graph/engine:1993)", () => {
  beforeEach(() => { table.length = 0; });
  it("counts how many of 7 inline replies reach the wire vs park 20-40s", async () => {
    const { claimSendSlots } = await import("../src/lib/wa/pacing");
    // Seven inbound webhooks land within ~2s of each other; four run at once
    // (inbound-gate MAX_INFLIGHT=4), the rest a beat later. Each finishes its
    // LLM turn and hits guardAndSend at slightly different instants.
    const base = 6_000 * 1_000_000 + 1_700;   // arbitrary phase inside the 6s fleet bucket
    const arrivals = [0, 400, 900, 1500, 2100, 2600, 3300]; // ms apart at the claim
    let sent = 0; const parked: number[] = [];
    for (const off of arrivals) {
      let now = base + off;
      NOW.v = now;
      const args = { senderKey: "u", toDigits: `669000000${arrivals.indexOf(off)}`,
        text: `reply ${off}`, auto: true, gapSeconds: 5, perRecipient: true, fleetGapSeconds: 6 } as const;
      let c = await claimSendSlots({ ...args, nowMs: now }) as { ok: boolean; kind?: string; retryAtMs?: number };
      if (!c.ok && c.kind === "pacing" && typeof c.retryAtMs === "number") {
        const w = c.retryAtMs - now;
        if (w > 0 && w <= 8_000) { now += w + 300; NOW.v = now;
          c = await claimSendSlots({ ...args, nowMs: now }) as typeof c; }
      }
      if (c.ok) { sent++; NOW.v = now + 2_500; }
      else parked.push(off);
    }
    console.log(`inline sends: ${sent}/7 ; parked 20-40s: ${parked.length} (offsets ${parked.join(",")})`);
    expect(sent + parked.length).toBe(7);
  });
});
