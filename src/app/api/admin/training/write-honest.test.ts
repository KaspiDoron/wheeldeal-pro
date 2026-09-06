import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT M45 (agent memory): POST / PATCH / DELETE on /api/admin/training ignored
// the boolean sbInsert, sbUpdate and sbDelete return, mutated the in-memory
// list regardless, and returned THAT list as proof - which reverts on the next
// cold start. So a durable write that hit a 5xx read exactly like one that
// landed, and the owner's edit, deletion or new memory was gone after the next
// deploy. With Supabase configured, the durable store is the truth: a failed
// write is a 502 and the in-memory mirror is left alone. Without Supabase
// (demo mode) the in-memory list is the only store there is, and the response
// says so with persisted:false rather than pretending.
//
// Executed against the real route over a Map-backed store.

const session: { role: "admin" | "owner" } = { role: "owner" };

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({ email: "owner@example.com", role: session.role }),
}));
vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/ai", () => ({ chatVision: async () => "" }));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { listTraining } from "@/lib/memory";
import { GET, POST, DELETE, PATCH } from "./route";

const TEXT = "Shop: 300 per day. Me: could you do 250 for the week? Shop: 270 final, helmet included.";

const post = (text: string) =>
  POST(
    new Request("http://local/api/admin/training", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, note: "manual" }),
    })
  );
const del = (id: number) =>
  DELETE(new Request(`http://local/api/admin/training?id=${id}`, { method: "DELETE" }));
const patch = (id: number, text: string) =>
  PATCH(
    new Request("http://local/api/admin/training", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text }),
    })
  );

beforeEach(() => {
  store.reset();
  session.role = "owner";
  // The in-memory mirror is a module global; empty it between cases.
  (globalThis as { __wheeldeal_training__?: unknown[] }).__wheeldeal_training__ = [];
  store.seed("agent_training", [
    { id: 41, text: TEXT, note: "manual", source: "text", added_by: "owner@example.com", created_at: "2026-09-01T00:00:00.000Z" },
  ]);
});

describe("EXECUTED (M45): memory writes report whether they persisted", () => {
  it("a new memory whose insert failed is a 502, and it is NOT mirrored into memory as proof", async () => {
    store.failWrites.add("agent_training");
    const res = await post("Shop: 400 per day, Me: 350 for three days? Shop: ok 360.");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok?: boolean; error?: string; examples?: unknown[] };
    expect(body.ok).not.toBe(true);
    expect(body.error).toBeTruthy();
    expect(listTraining()).toHaveLength(0);
    expect(store.rows("agent_training")).toHaveLength(1);
  });

  it("a new memory that landed answers ok:true, persisted:true and lists it", async () => {
    const res = await post("Shop: 400 per day, Me: 350 for three days? Shop: ok 360.");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; persisted: boolean; examples: { text: string | null }[] };
    expect(body.ok).toBe(true);
    expect(body.persisted).toBe(true);
    expect(store.rows("agent_training")).toHaveLength(2);
  });

  it("a delete that did not land is a 502 and the row is still listed", async () => {
    store.failWrites.add("agent_training");
    const res = await del(41);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { ok?: boolean }).ok).not.toBe(true);
    expect(store.rows("agent_training")).toHaveLength(1);
    const listed = (await (await GET()).json()) as { examples: { id: number }[] };
    expect(listed.examples.map((e) => e.id)).toContain(41);
  });

  it("an edit that did not land is a 502 and the text is unchanged", async () => {
    store.failWrites.add("agent_training");
    const res = await patch(41, "Shop: 300 per day. Me: 200? Shop: no.");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { ok?: boolean }).ok).not.toBe(true);
    expect(store.rows("agent_training")[0].text).toBe(TEXT);
  });

  it("an edit and a delete that landed answer ok:true", async () => {
    const edited = await patch(41, "Shop: 300 per day. Me: 200? Shop: no.");
    expect(edited.status).toBe(200);
    expect(store.rows("agent_training")[0].text).toBe("Shop: 300 per day. Me: 200? Shop: no.");
    const removed = await del(41);
    expect(removed.status).toBe(200);
    expect(store.rows("agent_training")).toHaveLength(0);
  });

  it("demo mode (no Supabase) keeps working in memory and says persisted:false", async () => {
    store.configured = false;
    const res = await post("Shop: 400 per day, Me: 350 for three days? Shop: ok 360.");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; persisted: boolean; examples: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.persisted).toBe(false);
    expect(listTraining()).toHaveLength(1);
  });
});
