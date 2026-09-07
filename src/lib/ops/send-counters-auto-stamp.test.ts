import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

// AUDIT F085: THE LAUNCH CARD'S SEND COUNTERS FILTER ON raw.auto, WHICH THREE
// OF THE FOUR OUTBOUND WRITERS NEVER STAMPED.
//
// launch-kpis.ts counts intros and replies over the last 24h with
// `raw->>auto=eq.true`, and only the outbox drain wrote that key. The inline
// reply lane (graph/engine.ts guardAndSend - where SPTE's replies actually go;
// parking is the exception) spread a meta with no `auto`, and neither
// immediate outreach path stamped it either. One hunt with 30 agent replies
// showed "replies 24h = 2" under a help string telling the owner to compare
// it against the per-number daily ceiling. The vocabulary is uniform now:
// every agent-authored outbound row carries auto:true, a hand-typed one
// auto:false, and the counters read the real volume.

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/wa-guard", () => ({
  guardOutbound: async (args: { text: string }) => ({ allow: true, text: args.text }),
  afterSend: async () => {},
  claimForSend: async () => ({ ok: true }),
  releaseSendClaim: async () => {},
}));
vi.mock("@/lib/wa/freshness-live", () => ({
  threadMovedOn: async () => ({ stale: false }),
  scheduleRecompose: async () => {},
}));
vi.mock("@/lib/wa/proxy", () => ({
  transportSummary: async () => ({ sessions: 1, note: "one host" }),
}));
vi.mock("@/lib/ai-rpm", () => ({ spentProviders: () => [] }));

import { store } from "@/lib/privacy/postgrest-store.test-helper";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  store.reset();
});

describe("EXECUTED (F085): the inline reply lane stamps auto:true on the row it writes", () => {
  it("guardAndSend with SPTE-shaped meta (no auto key) records an automated send", async () => {
    const { liveGraphIO } = await import("@/lib/graph/engine");
    const io = liveGraphIO(async () => ({ ok: true, messageId: "wamid.1" }));
    const out = await io.guardAndSend({
      senderKey: "traveller@example.com",
      toNumber: "66812345678",
      text: "Hi! Another shop quoted 250/day - can you do 240?",
      // The primary engine's meta (spte/live.ts): kind, vendor, engine, move,
      // tactic - and no `auto` key. That is the shape that went uncounted.
      meta: {
        kind: "bargain",
        vendorId: "v1",
        vendorName: "Sunrise Rentals",
        engine: "v3",
        move: "bargain",
        tacticId: "bargain",
      },
    });
    expect(out.delivered).toBe("sent");
    const row = store.rows("whatsapp_messages").find((r) => r.direction === "outbound");
    expect(row).toBeTruthy();
    // THE ASSERTION THAT FAILED BEFORE: raw.auto was undefined.
    expect((row?.raw as { auto?: boolean }).auto).toBe(true);
    expect((row?.raw as { kind?: string }).kind).toBe("bargain");
  });
});

describe("EXECUTED (F085): the launch card counts every agent-authored lane", () => {
  it("drain, inline reply, batch intro and single intro all count; a hand-typed line does not", async () => {
    const outbound = (raw: Record<string, unknown>, minutes: number) => ({
      to_number: "66812345678",
      body: "x",
      type: "text",
      direction: "outbound",
      received_at: minutesAgo(minutes),
      raw,
    });
    store.seed("whatsapp_messages", [
      // The outbox drain (wa-guard drainOutbox) - the one writer that always stamped it.
      outbound({ sender: "a@x.com", kind: "rfq", auto: true, queued: true, transport: "evolution" }, 10),
      outbound({ sender: "a@x.com", kind: "bargain", auto: true, queued: true, transport: "evolution" }, 11),
      // The inline reply lane (graph/engine.ts guardAndSend) after the fix.
      outbound({ sender: "a@x.com", kind: "bargain", engine: "v3", move: "bargain", auto: true }, 12),
      outbound({ sender: "a@x.com", kind: "clarify", engine: "v3", move: "clarify", auto: true }, 13),
      // The batch's immediate first send (outreach/mass) after the fix.
      outbound({ sender: "a@x.com", kind: "rfq", auto: true, batchId: "b1", transport: "evolution" }, 14),
      // The single-shop intro (outreach) after the fix.
      outbound({ sender: "a@x.com", kind: "rfq", auto: true, transport: "evolution", ok: true }, 15),
      // A hand-typed line through the same route is NOT an agent send.
      outbound({ sender: "a@x.com", kind: "custom", auto: false, transport: "evolution", ok: true }, 16),
      // Marker rows never count (no auto key, sentinel recipient).
      { ...outbound({ sender: "a@x.com", kind: "session-closed" }, 17), to_number: "session" },
      // Older than 24h: out of the window.
      outbound({ sender: "a@x.com", kind: "rfq", auto: true }, 25 * 60),
    ]);
    const { launchKpis } = await import("./launch-kpis");
    const k = await launchKpis();
    expect(k.degraded).not.toContain("send-counts");
    expect(k.sends.introDay).toBe(3);
    expect(k.sends.replyDay).toBe(3);
  });
});

describe("the immediate outreach writers carry the stamp (source pins beside the executed lane)", () => {
  // These two handlers need a signed-in session, a vendor directory and a
  // live transport to execute end to end; the pin asserts the guarantee AND
  // the absence of the unguarded shape on the exact row literal each writes.
  const rowLiteral = (src: string): string => {
    const at = src.indexOf('sbInsert("whatsapp_messages"');
    expect(at).toBeGreaterThan(0);
    const raw = src.indexOf("raw: {", at);
    expect(raw).toBeGreaterThan(at);
    return src.slice(raw, src.indexOf("\n        },", raw) + 1);
  };

  it("outreach/route.ts: auto follows the kind (rfq/bargain/clarify true, a typed custom false)", () => {
    const src = readFileSync("src/app/api/outreach/route.ts", "utf8");
    expect(src).toMatch(/const isAuto = kind !== "custom";/);
    expect(rowLiteral(src)).toMatch(/\bauto: isAuto,/);
  });

  it("outreach/mass/route.ts: the batch meta stamps auto:true on the immediate send and the parked rows", () => {
    const src = readFileSync("src/app/api/outreach/mass/route.ts", "utf8");
    const meta = src.slice(src.indexOf("const meta = {"), src.indexOf("batchDeadline:"));
    expect(meta).toMatch(/\bauto: true,/);
  });

  it("deals/recheck/route.ts: the re-check meta stamps auto:true", () => {
    const src = readFileSync("src/app/api/deals/recheck/route.ts", "utf8");
    const at = src.indexOf('const meta = {\n      kind: "recheck",');
    expect(at).toBeGreaterThan(0);
    const meta = src.slice(at, src.indexOf("};", at));
    expect(meta).toMatch(/\bauto: true,/);
  });
});
