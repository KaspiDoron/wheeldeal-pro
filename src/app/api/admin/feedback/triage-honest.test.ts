import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT M45 (admin feedback): PATCH (status / owner note) and DELETE on
// /api/admin/feedback answered {ok:true} without reading the boolean sbUpdate
// and sbDelete return. The panel already paints only on res.ok - so the route
// telling the truth is what makes that guard mean anything. Executed against
// the real route over a Map-backed store.

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({ email: "owner@example.com", role: "owner" }),
}));
vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { PATCH, DELETE } from "./route";

const patch = (body: Record<string, unknown>) =>
  PATCH(
    new Request("http://local/api/admin/feedback", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
const del = (id: number) =>
  DELETE(new Request(`http://local/api/admin/feedback?id=${id}`, { method: "DELETE" }));

beforeEach(() => {
  store.reset();
  store.seed("feedback", [{ id: 3, reporter_email: "t@example.com", body: "x", status: "open" }]);
});

describe("EXECUTED (M45): triage writes report whether they persisted", () => {
  it("a status change that did not land answers 502 and the row is unchanged", async () => {
    store.failWrites.add("feedback");
    const res = await patch({ id: 3, status: "resolved" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { ok?: boolean }).ok).not.toBe(true);
    expect(store.rows("feedback")[0].status).toBe("open");
  });

  it("a status change that landed answers ok:true", async () => {
    const res = await patch({ id: 3, status: "resolved" });
    expect(res.status).toBe(200);
    expect(store.rows("feedback")[0].status).toBe("resolved");
  });

  it("a delete that did not land answers 502 with the report still there", async () => {
    store.failWrites.add("feedback");
    const res = await del(3);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { ok?: boolean }).ok).not.toBe(true);
    expect(store.rows("feedback")).toHaveLength(1);
  });

  it("a delete that landed answers ok:true and the row is gone", async () => {
    const res = await del(3);
    expect(res.status).toBe(200);
    expect(store.rows("feedback")).toHaveLength(0);
  });
});
