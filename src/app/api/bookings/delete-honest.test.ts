import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT M45 (bookings delete): DELETE /api/bookings answered {ok:true} whatever
// sbDelete returned. sbDelete returns res.ok - false for a 5xx, a rejected key
// or no connection - and PostgREST answers a zero-row DELETE with 204, so a
// false return is a transport/permission failure, never "not found". The
// profile page filtered the booking out of view on that ok:true, and it was
// back on the next load. Executed against the real route over a Map-backed
// store whose writes can be made to fail.

vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "t@example.com", plan: "ultra", role: "user" }),
}));
vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { DELETE } from "./route";

const del = (id: number) =>
  DELETE(
    new Request("http://local/api/bookings", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
  );

beforeEach(() => {
  store.reset();
  store.seed("bookings", [
    { id: 7, user_email: "t@example.com", vendor_name: "Sunrise Rentals", status: "completed" },
  ]);
});

describe("EXECUTED (M45): a booking that was not deleted is not reported deleted", () => {
  it("a failed durable delete answers 502 with the row still there", async () => {
    store.failWrites.add("bookings");
    const res = await del(7);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).not.toBe(true);
    expect(body.error).toMatch(/not removed|did not|could not/i);
    expect(store.rows("bookings")).toHaveLength(1);
  });

  it("a delete that landed answers ok:true and the row is gone", async () => {
    const res = await del(7);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(store.rows("bookings")).toHaveLength(0);
  });

  it("the delete stays scoped to the caller's own row", async () => {
    store.seed("bookings", [{ id: 8, user_email: "other@example.com", vendor_name: "X", status: "completed" }]);
    await del(8);
    expect(store.rows("bookings").find((r) => r.id === 8)).toBeTruthy();
  });
});
