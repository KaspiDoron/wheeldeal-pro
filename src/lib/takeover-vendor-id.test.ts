import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F089: THE ESCALATION KPI COLLAPSED EVERY HUMAN TAKEOVER INTO ONE
// BUCKET BECAUSE THE WRITER NEVER SET vendor_id.
//
// kpis.distinctThreads keys a conversation on (user_email, vendor_id) and
// folds any row missing either half into a single "unattributed" bucket. The
// only writer of kind `human-takeover` - setThreadTakeover's telemetry twin -
// wrote to_number and vendor_name and no vendor_id, so `escalated` was 1 for
// ANY non-empty set of takeovers: nine hand-takeovers across forty
// conversations reported 2.5% instead of 22.5%, on the number that decides
// whether the agents are trusted to run unattended. The writer now stamps
// the vendor id the caller holds (the in-app switch) or resolves it from the
// thread's own outbound row (the WhatsApp-typed detector), so both sides of
// the ratio share one key. Executed against the real writer, route and KPI.

vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "a@x.com", role: "user", plan: "ultra", issuedAt: 0 }),
}));

import { store } from "@/lib/privacy/postgrest-store.test-helper";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function outboundTo(digits: string, vendorId: string) {
  return {
    to_number: digits,
    body: "hi",
    type: "text",
    direction: "outbound",
    received_at: minutesAgo(30),
    raw: { sender: "a@x.com", vendorId, vendorName: `Shop ${vendorId}`, kind: "rfq", auto: true },
  };
}

/** agent_events.created_at is a DB default (now()); the fake store keeps what was written. */
function stampCreatedAt() {
  for (const r of store.rows("agent_events")) if (!r.created_at) r.created_at = minutesAgo(1);
}

beforeEach(() => {
  store.reset();
});

describe("EXECUTED (F089): the takeover twin carries the thread's vendor id", () => {
  it("the caller's vendor id lands on the human-takeover row", async () => {
    const { setThreadTakeover } = await import("./session-flags");
    await setThreadTakeover("a@x.com", "66900000001", true, { vendorId: "v1" });
    const ev = store.rows("agent_events").find((r) => r.kind === "human-takeover");
    expect(ev).toBeTruthy();
    // THE ASSERTION THAT FAILED BEFORE: no vendor_id column at all.
    expect(ev?.vendor_id).toBe("v1");
    expect(ev?.user_email).toBe("a@x.com");
    expect(ev?.to_number).toBe("66900000001");
  });

  it("the WhatsApp-typed detector (no vendor in hand) resolves it from the thread's own outbound row", async () => {
    store.seed("whatsapp_messages", [outboundTo("66900000002", "v2")]);
    const { setThreadTakeover } = await import("./session-flags");
    await setThreadTakeover("a@x.com", "66900000002", true);
    const ev = store.rows("agent_events").find((r) => r.kind === "human-takeover");
    expect(ev?.vendor_id).toBe("v2");
  });

  it("the in-app switch passes the vendor it was asked about", async () => {
    store.seed("whatsapp_messages", [outboundTo("66900000003", "v3")]);
    const { POST } = await import("@/app/api/thread/takeover/route");
    const res = await POST(
      new Request("http://localhost/api/thread/takeover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vendorId: "v3", mode: "takeover" }),
      })
    );
    expect(res.status).toBe(200);
    const ev = store.rows("agent_events").find((r) => r.kind === "human-takeover");
    expect(ev?.vendor_id).toBe("v3");
  });
});

describe("EXECUTED (F089): escalation is per conversation again", () => {
  it("two takeovers over four conversations read 50%, not 25%", async () => {
    const { setThreadTakeover } = await import("./session-flags");
    await setThreadTakeover("a@x.com", "66900000001", true, { vendorId: "v1" });
    await setThreadTakeover("a@x.com", "66900000002", true, { vendorId: "v2" });
    // The denominator: one delivered turn on each of four threads, written the
    // way io.recordEvent writes them (vendor_id as a column).
    store.seed(
      "agent_events",
      ["v1", "v2", "v3", "v4"].map((v, i) => ({
        kind: "engine-v3-turn",
        user_email: "a@x.com",
        vendor_id: v,
        to_number: `6690000000${i + 1}`,
        detail: JSON.stringify({ move: "bargain", latencyMs: 500 }),
        created_at: minutesAgo(5),
      }))
    );
    stampCreatedAt();
    const { fieldKpis } = await import("./kpis");
    const k = await fieldKpis();
    expect(k.degraded).toEqual([]);
    // THE ASSERTION THAT FAILED BEFORE: both takeovers folded into one bucket -> 25.
    expect(k.escalationPct).toBe(50);
  });
});
