import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT M45 (wa-queue cancel): the sharpest optimistic success in the app. The
// owner presses "drop" on a queued WhatsApp message, POST {action:"delete"}
// answered {ok:true} without reading sbDelete's boolean, the wa_outbox row was
// still there, and the next drain put that message on a shop's phone. The
// refuter's concern is honoured: sbDelete's false is transport/permission
// failure (PostgREST answers a zero-row DELETE with 204), so the route never
// renders "already deleted" from it and does not add a representation round
// trip on a path the owner taps during a live drain.

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({ email: "owner@example.com", role: "owner" }),
}));
vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/wa-guard", () => ({ drainOutbox: async () => 0 }));
vi.mock("@/lib/evolution", () => ({ sendFromUser: async () => ({ ok: false }) }));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { POST } from "./route";

const cancel = (id: number) =>
  POST(
    new Request("http://local/api/admin/wa-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    })
  );

beforeEach(() => {
  store.reset();
  store.seed("wa_outbox", [
    {
      id: 11,
      sender_key: "traveller@example.com",
      to_number: "66812345678",
      body: "Could you do 240 for 5 days?",
      not_before: "2026-09-05T08:00:00.000Z",
      meta: {},
    },
  ]);
});

describe("EXECUTED (M45): a cancel that did not land is not reported as landed", () => {
  it("a failed durable delete answers 502 and says the row is still queued", async () => {
    store.failWrites.add("wa_outbox");
    const res = await cancel(11);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).not.toBe(true);
    expect(body.error).toMatch(/still queued/i);
    expect(store.rows("wa_outbox")).toHaveLength(1);
  });

  it("a delete that landed answers ok:true and the row is gone", async () => {
    const res = await cancel(11);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(store.rows("wa_outbox")).toHaveLength(0);
  });
});
