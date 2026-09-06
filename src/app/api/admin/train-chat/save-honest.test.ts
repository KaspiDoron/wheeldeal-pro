import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT M45 (train-chat save): action:"save" asserted {ok:true, saved:true}
// over an sbInsert wrapped in `.catch(() => {})` - the insert's boolean was
// never read, so a training session that Supabase refused was reported saved
// and existed only in this instance's memory until the next cold start.
// Executed against the real route over a Map-backed store.

vi.mock("@/lib/session", () => ({
  requireManagement: async () => ({ email: "owner@example.com", role: "owner" }),
}));
vi.mock("@/lib/runtime-config", async () => {
  const h = await import("@/lib/privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/agents", () => ({
  extractOffer: async () => ({ found: false }),
  composeBargain: async () => ({ message: "" }),
  currencyForRegion: () => "THB",
  money: (n: number, c: string) => `${n} ${c}`,
}));
vi.mock("@/lib/market", () => ({ floorPriceFor: async () => null }));

import { store } from "@/lib/privacy/postgrest-store.test-helper";
import { listTraining } from "@/lib/memory";
import { POST } from "./route";

const TURNS = [
  { role: "shop", text: "300 baht per day for the Click" },
  { role: "agent", text: "Could you do 250 for the whole week?" },
  { role: "shop", text: "270 final, helmet included" },
];

const save = () =>
  POST(
    new Request("http://local/api/admin/train-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", turns: TURNS, region: "Krabi" }),
    })
  );

beforeEach(() => {
  store.reset();
  (globalThis as { __wheeldeal_training__?: unknown[] }).__wheeldeal_training__ = [];
});

describe("EXECUTED (M45): a training session that Supabase refused is not 'saved'", () => {
  it("a failed insert answers 502, saved is not true, and nothing is mirrored into memory", async () => {
    store.failWrites.add("agent_training");
    const res = await save();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok?: boolean; saved?: boolean; error?: string };
    expect(body.saved).not.toBe(true);
    expect(body.ok).not.toBe(true);
    expect(body.error).toBeTruthy();
    expect(store.rows("agent_training")).toHaveLength(0);
    expect(listTraining()).toHaveLength(0);
  });

  it("an insert that landed answers saved:true with persisted:true", async () => {
    const res = await save();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; saved: boolean; persisted: boolean };
    expect(body.saved).toBe(true);
    expect(body.persisted).toBe(true);
    expect(store.rows("agent_training")).toHaveLength(1);
    expect(String(store.rows("agent_training")[0].text)).toMatch(/270 final/);
  });

  it("demo mode (no Supabase) saves in memory and says persisted:false", async () => {
    store.configured = false;
    const res = await save();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved: boolean; persisted: boolean };
    expect(body.saved).toBe(true);
    expect(body.persisted).toBe(false);
    expect(listTraining()).toHaveLength(1);
  });
});
