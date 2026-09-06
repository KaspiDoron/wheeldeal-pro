import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT M45 (feedback delete): DELETE /api/feedback answered {ok:true} over an
// sbDelete whose boolean was thrown away, so a reporter whose delete hit a
// 5xx watched the report disappear from the modal and found it back on the
// next open. Executed against the real route over a Map-backed store.

vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "t@example.com", plan: "ultra", role: "user" }),
  adminEmails: async () => ["owner@example.com"],
}));
vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/agents", () => ({ triageFeedback: async () => null }));
vi.mock("@/lib/email", () => ({ sendEmail: async () => false }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true }),
  clientIp: () => "127.0.0.1",
}));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { DELETE } from "./route";

const del = (id: number) =>
  DELETE(new Request(`http://local/api/feedback?id=${id}`, { method: "DELETE" }));

beforeEach(() => {
  store.reset();
  store.seed("feedback", [{ id: 5, reporter_email: "t@example.com", body: "the map is blank" }]);
  store.seed("feedback_replies", [{ id: 1, feedback_id: 5, body: "looking" }]);
});

describe("EXECUTED (M45): a report that was not deleted is not reported deleted", () => {
  it("a failed durable delete answers 502 with the report still there", async () => {
    store.failWrites.add("feedback");
    const res = await del(5);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).not.toBe(true);
    expect(body.error).toBeTruthy();
    expect(store.rows("feedback")).toHaveLength(1);
  });

  it("a delete that landed answers ok:true and the report is gone", async () => {
    const res = await del(5);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(store.rows("feedback")).toHaveLength(0);
    expect(store.rows("feedback_replies")).toHaveLength(0);
  });
});
