import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F046: POST /api/wa/disconnect MUST NOT REPORT A STATUS-0 LOGOUT AS A
// COMPLETED UNLINK.
//
// The route used to `await disconnectInstance(session.email)` and drop the
// boolean, answering `{ok:true}` while the local wa_sessions row was deleted -
// so a traveller who tapped "Disconnect WhatsApp" while the Evolution host was
// restarting was told they were unlinked while the Baileys socket stayed live,
// still mirroring their personal chats into the Evolution store, with nothing
// left to retry from. Audit F057 (base commit) made disconnectInstance return
// an outcome and the route answer 502 when no host confirmed the teardown;
// this file EXECUTES that contract through the real route and the real
// disconnectInstance, with the host stubbed at fetch, so it cannot regress
// back to a discarded boolean.

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});
vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "linked@example.com", plan: "free" }),
}));

import { store } from "../privacy/postgrest-store.test-helper";
import { POST } from "@/app/api/wa/disconnect/route";

const EMAIL = "linked@example.com";
type Host = "up" | "down" | "absent";
const evo: { host: Host; calls: string[] } = { host: "up", calls: [] };

beforeEach(() => {
  store.reset();
  evo.calls = [];
  evo.host = "up";
  store.config.set("EVOLUTION_API_URL", "https://evo.test");
  store.config.set("EVOLUTION_API_KEY", "test-key");
  store.seed("wa_sessions", [{ email: EMAIL, instance_name: "wd-x", status: "open" }]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://evo.test/")) {
        evo.calls.push(`${init?.method ?? "GET"} ${url.slice("https://evo.test".length)}`);
        if (evo.host === "down") throw new Error("ECONNRESET"); // evoFetch -> {ok:false,status:0}
        if (evo.host === "absent") return new Response('{"status":404}', { status: 404 });
        return new Response('{"status":"SUCCESS"}', { status: 200 });
      }
      return new Response("{}", { status: 200 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EXECUTED (F046): the disconnect route reports the real outcome", () => {
  it("a status-0 host (both DELETEs abort) is a 502, NOT a completed unlink, and the link record survives", async () => {
    evo.host = "down";
    const res = await POST();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.severed).toBe(false);
    expect(body.hostsTried).toBe(1);
    expect(typeof body.error).toBe("string");
    expect(evo.calls.some((c) => c.startsWith("DELETE /instance/delete/"))).toBe(true);
    // The row that names the instance is the only way a retry finds it.
    expect(store.rows("wa_sessions")).toHaveLength(1);
  });

  it("a confirmed delete is a 200 with severed:true, and the local record is gone", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, severed: true, hostsTried: 1 });
    expect(store.rows("wa_sessions")).toHaveLength(0);
  });

  it("an instance the host no longer has (404) counts as severed - a second tap is not a failure", async () => {
    evo.host = "absent";
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).severed).toBe(true);
    expect(store.rows("wa_sessions")).toHaveLength(0);
  });
});
