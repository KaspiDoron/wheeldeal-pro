// AUDIT F180 - the webhook re-arm reads the TOKEN before the throttle.
//
// reassertWebhook returned skipped:"throttled" on the shared ~1h clock alone,
// and only read the token afterwards. The clock is stamped by the healthy-skip
// path on every cycle, so immediately after the documented SESSION_SECRET /
// WEBHOOK_TOKEN_SALT rotation every open instance was throttled OUT of the one
// automatic repair for up to 60 minutes - while Evolution still held the old
// token, every inbound shop reply was answered 403, and a 403 is not the 503
// redeliver path: the price was dropped, permanently.
//
// EXECUTED against the real reassertWebhook over the Map-backed store, with
// setConfig persisting so the fleet-wide token mark round-trips.
//
// This file pins the SINGLE-instance behaviour. The fleet case - one rotation
// must repair every open instance, not just the first the sweep reaches - is
// pinned next door in rearm-fleet-rotation.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  return {
    ...h.runtimeConfigMock(),
    // The real vault persists; the default helper stub does not, and the
    // fingerprint this finding turns on is only meaningful if it round-trips.
    setConfig: async (name: string, value: string) => {
      h.store.config.set(name, value);
      return true;
    },
  };
});

import { store } from "../privacy/postgrest-store.test-helper";
import { reassertWebhook } from "../evolution";

const FP_KEY = "WH_REARM_TOKEN_FP";
let calls: string[] = [];

const seedOpen = (email: string, rearmedAt: string) =>
  store.seed("wa_sessions", [
    {
      email,
      instance_name: `wd-${email.split("@")[0]}`,
      status: "open",
      host_url: "https://evo.test",
      webhook_rearmed_at: rearmedAt,
    },
  ]);

beforeEach(() => {
  store.reset();
  calls = [];
  store.config.set("EVOLUTION_API_URL", "https://evo.test");
  store.config.set("EVOLUTION_API_KEY", "test-key");
  store.config.set("APP_DOMAIN", "https://app.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url.replace("https://evo.test", ""));
      // Evolution holds SOME registration, but not one we can read a URL from:
      // the re-arm proceeds to /webhook/set.
      return new Response("{}", { status: 200 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const hits = (fragment: string) => calls.filter((c) => c.includes(fragment)).length;

describe("EXECUTED (F180): a rotated token defeats the hourly throttle", () => {
  it("an instance re-armed minutes ago is repaired anyway once the token moved", async () => {
    const email = "rotated@example.com";
    seedOpen(email, new Date().toISOString()); // stamped two minutes ago
    // What the last VERIFIED re-arm registered - derived from the old secret.
    store.config.set(FP_KEY, "0000stale0000fp0");

    const res = await reassertWebhook(email);

    expect(res.skipped).toBeUndefined();
    expect(res.changed).toBe(true);
    expect(hits("/webhook/set/")).toBe(1);
    // ...and the mark now names the token actually registered, plus the
    // moment it came into force (what makes the repair reach the rest).
    expect(store.config.get(FP_KEY)).not.toBe("0000stale0000fp0");
    expect(store.config.get(FP_KEY)).toMatch(/^[0-9a-f]{16}:[0-9]{10,}$/);
  });

  it("nothing rotated: the ~1h throttle still holds, so a healthy fleet does not churn", async () => {
    // Record the token in force by forcing one repair. Nothing was on file
    // before it, so no rotation moment is marked (trailing 0) - the absence of
    // a mark must never force the fleet to re-register.
    const primed = "primer@example.com";
    seedOpen(primed, new Date(Date.now() - 3 * 3600_000).toISOString());
    await reassertWebhook(primed, { force: true });
    const currentFp = store.config.get(FP_KEY);
    expect(currentFp).toMatch(/^[0-9a-f]{16}:0$/);

    // ...then a DIFFERENT instance, re-armed minutes ago under that same token.
    calls = [];
    const email = "healthy@example.com";
    seedOpen(email, new Date().toISOString());
    const res = await reassertWebhook(email);

    expect(res.skipped).toBe("throttled");
    expect(hits("/webhook/set/")).toBe(0);
    expect(hits("/webhook/find/")).toBe(0);
  });

  it("a first-ever run with no fingerprint on file keeps the throttle it always had", async () => {
    // Nothing has stamped the fleet-wide row yet (a deploy that predates it):
    // the absence of a fingerprint is not evidence of a rotation.
    const email = "unstamped@example.com";
    seedOpen(email, new Date().toISOString());
    const res = await reassertWebhook(email);
    expect(res.skipped).toBe("throttled");
    expect(hits("/webhook/set/")).toBe(0);
  });
});
