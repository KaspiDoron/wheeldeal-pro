import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// OWNER REPORT 11, D2.4 - AN EMERGENCY STOP THAT LIED ABOUT WORKING.
//
// The kill switch write discarded setConfig's result and answered { ok: true }
// unconditionally. setConfig can FAIL (vault write error) or persist only to
// THIS instance's memory (Supabase unreachable) - so the owner hit "stop", saw
// success, and the switch had not taken (or had taken on 1 of up to 20
// instances). These EXECUTE the route and assert it tells the truth.

async function loadRoute(setConfigResult: { ok: boolean; persistent: boolean; error?: string }) {
  vi.resetModules();
  const writes: Array<{ name: string; value: string }> = [];
  vi.doMock("@/lib/session", () => ({
    requireManagement: async () => ({ email: "owner@x.co", role: "owner" }),
    getSession: async () => ({ email: "owner@x.co", role: "owner" }),
  }));
  vi.doMock("@/lib/usage", () => ({
    monthlyUsage: async () => ({}),
    QUOTAS: {},
    limitDefaults: () => ({}),
    killSwitchOn: async () => false,
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    getConfig: async () => undefined,
    sbSelect: async () => [],
    sbCountDark: async () => 0,
    setConfig: async (name: string, value: string) => {
      writes.push({ name, value });
      return setConfigResult;
    },
  }));
  const mod = await import("./route");
  return { POST: mod.POST, writes };
}

const post = (POST: (r: Request) => Promise<Response>, body: unknown) =>
  POST(
    new Request("http://localhost/api/admin/costs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

afterEach(() => vi.restoreAllMocks());

describe("the kill switch reports the truth about its own write", () => {
  it("EXECUTED: a FAILED vault write returns an error, NOT ok:true", async () => {
    const { POST, writes } = await loadRoute({ ok: false, persistent: false, error: "vault down" });
    const res = await post(POST, { killSwitch: true });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBeUndefined();
    // The real store error is surfaced (falling back to an explicit UNCHANGED
    // message when setConfig gives none) - never a silent ok.
    expect(String(body.error).length).toBeGreaterThan(0);
    expect(body.error).toBe("vault down");
    // It really did attempt the write - so the failure is the store's, not ours.
    expect(writes).toContainEqual({ name: "KILL_SWITCH", value: "1" });
  });

  it("EXECUTED: a MEMORY-ONLY persist warns it is not fleet-wide", async () => {
    const { POST } = await loadRoute({ ok: true, persistent: false });
    const res = await post(POST, { killSwitch: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.persistent).toBe(false);
    expect(String(body.warning)).toMatch(/instance only|not affected/i);
  });

  it("EXECUTED: a failed write with no error text still refuses with the UNCHANGED message", async () => {
    const { POST } = await loadRoute({ ok: false, persistent: false });
    const res = await post(POST, { killSwitch: true });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(String(body.error)).toMatch(/UNCHANGED|Could not save/i);
  });

  it("EXECUTED: a durable write is a clean success", async () => {
    const { POST } = await loadRoute({ ok: true, persistent: true });
    const res = await post(POST, { killSwitch: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.persistent).toBe(true);
    expect(body.warning).toBeUndefined();
  });
});
