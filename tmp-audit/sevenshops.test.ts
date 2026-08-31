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

describe("no send ever happened, yet the lane refuses", () => {
  beforeEach(() => { table.length = 0; });
  it("a failed attempt POISONS the previous-bucket probe with its own timestamp", async () => {
    const { claimSendSlots } = await import("../src/lib/wa/pacing");
    const base = 8_000 * 1_000_000; // aligned to a recipient bucket edge
    // Attempt 1 for shop A: wins everything EXCEPT the fleet lane (occupied).
    NOW.v = base + 1_000;
    await claimSendSlots({ senderKey: "u", toDigits: "66900000001", text: "occupier",
      auto: true, gapSeconds: 5, perRecipient: true, fleetGapSeconds: 6, nowMs: NOW.v });
    NOW.v = base + 3_000;
    const r1 = await claimSendSlots({ senderKey: "u", toDigits: "66900000002", text: "B",
      auto: true, gapSeconds: 5, perRecipient: true, fleetGapSeconds: 6, nowMs: NOW.v });
    expect(r1.ok).toBe(false); // lost the fleet slot; releases its own claims
    // 30 seconds later - FIVE fleet gaps later, nothing was ever sent to shop B.
    NOW.v = base + 33_000;
    const r2 = await claimSendSlots({ senderKey: "u", toDigits: "66900000002", text: "B",
      auto: true, gapSeconds: 5, perRecipient: true, fleetGapSeconds: 6, nowMs: NOW.v });
    console.log("30s later, shop B:", JSON.stringify(r2));
    expect(r2.ok).toBe(true);
  });
});

describe("7 shops reply at once - faithful drain replay", () => {
  beforeEach(() => { table.length = 0; });
  it("time to clear", async () => {
    const { claimSendSlots } = await import("../src/lib/wa/pacing");
    const RECIPIENT_LOCK_SEC = 8, REPLY_GAP = 5, FLEET = 6;
    const REPLY_PER_SENDER = 3, WAIT_CEIL = 8_000;
    const SEND_MS = 3_000;          // presence(~1.2s)+poisson(~1.3s)+http
    const GUARD_MS = 400;           // per-row guard pipeline
    const DRAIN_INTERVAL = 0;       // reply-tick chains in-call, so ~immediate
    let now = 8_000 * 1_000_000;
    NOW.v = now;
    const shops = Array.from({ length: 7 }, (_, i) => `6690000000${i}`);
    const pending = new Map(shops.map((s) => [s, now]));  // not_before
    const sentAt = new Map<string, number>();
    const t0 = now;
    let invocations = 0;
    while (pending.size && invocations < 40) {
      invocations++;
      // next invocation starts when the earliest row is due
      now = Math.max(now, Math.min(...pending.values()));
      NOW.v = now;
      let waitAllowance = 15_000, perSender = 0;
      const deadline = now + 45_000;
      for (const shop of [...pending.keys()]) {
        if (now > deadline) break;
        if ((pending.get(shop) ?? 0) > now) continue;
        if (perSender >= REPLY_PER_SENDER) { pending.set(shop, now + (RECIPIENT_LOCK_SEC + 2 + 3) * 1000); continue; }
        now += GUARD_MS; NOW.v = now;
        const args = { senderKey: "u", toDigits: shop, text: `reply ${shop}`,
          auto: true, gapSeconds: REPLY_GAP, perRecipient: true, fleetGapSeconds: FLEET } as const;
        let c = await claimSendSlots({ ...args, nowMs: now }) as { ok: boolean; kind?: string; retryAtMs?: number };
        if (!c.ok && c.kind === "pacing" && typeof c.retryAtMs === "number") {
          const w = c.retryAtMs - now;
          if (w > 0 && w <= WAIT_CEIL && w <= waitAllowance) {
            waitAllowance -= w; now += w + 300; NOW.v = now;
            c = await claimSendSlots({ ...args, nowMs: now }) as typeof c;
          }
        }
        if (!c.ok) { pending.set(shop, now + 12_000); continue; }
        now += SEND_MS; NOW.v = now;
        sentAt.set(shop, now); pending.delete(shop); perSender++;
      }
      now += DRAIN_INTERVAL;
    }
    const rel = [...sentAt.entries()].map(([s, t]) => [s, Math.round((t - t0) / 1000)]);
    console.log("invocations:", invocations, "sends (s after burst):", JSON.stringify(rel));
    console.log("last reply at +", Math.round((Math.max(...sentAt.values()) - t0) / 1000), "s");
    expect(sentAt.size).toBe(7);
  });
});
