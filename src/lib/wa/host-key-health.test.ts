import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// OWNER REPORT 11, H2.1 - A WRONG API KEY BANNED THE NUMBERS PLACED ON THE HOST.
//
// Two defects compounded into "a single mistyped host key bans real testers":
//
//  1. `hostHealthDetail` rated a host that answered 401/403 as `ok: true`
//     ("401 still = alive"), so `resolveHost` PLACED live users on a box we
//     cannot actually send through.
//  2. Every send then 401'd, and `sendFromUser` classified an Evolution apikey
//     rejection as an ACCOUNT-level "hard" strike - so three sends in a row
//     tripped ban-recovery (`noteSendOutcome`) on the TRAVELLER'S number, for a
//     config mistake the number never made.
//
// The fix rates 401/403 as unhealthy for placement, and classifies the send
// failure as "soft". This tests BOTH halves as executed behaviour:
//  - the health half runs the real `hostHealthDetail` through `testOneHost` /
//    `hostsStatus` against a stubbed transport;
//  - the send-classification half runs the pure `isHardSendFailure` it now uses,
//    including the 403-body-says-"Forbidden" case that a naive fix would miss.

const ENV = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-stub",
};

/** Import evolution fresh with a clean vault cache and a routed fetch stub. */
async function withHostProbe(probeStatus: number, instances: unknown[] = []) {
  vi.resetModules();
  (globalThis as Record<string, unknown>).__wheeldeal_cfg__ = undefined;
  (globalThis as Record<string, unknown>).__wd_wa_health__ = undefined;
  (globalThis as Record<string, unknown>).__wd_wa_counts__ = undefined;
  Object.assign(process.env, ENV);
  // The host list lives in env; the vault read returns empty and falls through.
  process.env.EVOLUTION_HOSTS = "https://host-a|the-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/instance/fetchInstances")) {
        return new Response(JSON.stringify(instances), {
          status: probeStatus,
          headers: { "content-type": "application/json" },
        });
      }
      // Any Supabase read (vault, counts) is empty - env supplies the host.
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return await import("../evolution");
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EVOLUTION_HOSTS;
  (globalThis as Record<string, unknown>).__wd_wa_health__ = undefined;
});

describe("a host that rejects our API key is NOT healthy for placement", () => {
  it("EXECUTED: testOneHost reports a 401 host as unhealthy, with an owner-actionable reason", async () => {
    const evo = await withHostProbe(401);
    const r = await evo.testOneHost("https://host-a");
    // The regression was `healthy: true` here - which is what put users on it.
    expect(r.healthy).toBe(false);
    expect(r.detail).toMatch(/API key/i);
    expect(r.detail).toMatch(/EVOLUTION_HOSTS/);
  });

  it("EXECUTED: a 403 host is unhealthy too (same auth-gateway rejection)", async () => {
    const evo = await withHostProbe(403);
    const r = await evo.testOneHost("https://host-a");
    expect(r.healthy).toBe(false);
  });

  it("EXECUTED: hostsStatus - the list resolveHost's gate reads - marks it down", async () => {
    const evo = await withHostProbe(401);
    const status = await evo.hostsStatus();
    const row = status.find((h) => h.url === "https://host-a");
    expect(row?.healthy).toBe(false);
  });

  it("EXECUTED: a genuinely healthy host still reads healthy (fix is not 'reject everything')", async () => {
    const evo = await withHostProbe(200, [{ instance: "one" }, { instance: "two" }]);
    const r = await evo.testOneHost("https://host-a");
    expect(r.healthy).toBe(true);
    expect(r.instances).toBe(2);
  });
});

describe("an Evolution apikey rejection is a config fault, not a number strike", () => {
  it("EXECUTED: 401/403 classify SOFT so they never trip ban-recovery", async () => {
    const { isHardSendFailure } = await import("./send-classify");
    expect(isHardSendFailure(401, "Unauthorized")).toBe(false);
    // The hole a naive fix leaves: a 403 body literally says "Forbidden", which
    // the restriction-text branch would re-escalate to hard. The status
    // short-circuit closes it.
    expect(isHardSendFailure(403, "Forbidden")).toBe(false);
    expect(isHardSendFailure(403, "")).toBe(false);
  });

  it("EXECUTED: 429 and real WhatsApp-restriction text are STILL hard", async () => {
    const { isHardSendFailure } = await import("./send-classify");
    expect(isHardSendFailure(429, "")).toBe(true); // rate limit = volume = number
    expect(isHardSendFailure(400, "this number is banned for spam")).toBe(true);
    expect(isHardSendFailure(200, "account restricted, too many messages")).toBe(true);
  });

  it("EXECUTED: infra failures (timeout status 0, 5xx) stay soft", async () => {
    const { isHardSendFailure } = await import("./send-classify");
    expect(isHardSendFailure(0, "")).toBe(false);
    expect(isHardSendFailure(500, "Evolution API 500")).toBe(false);
  });
});
