// AUDIT F180 (round 2) - a token rotation must repair the WHOLE open fleet,
// not just the first instance the sweep happens to reach.
//
// The round-1 repair read the token before the throttle and compared it to a
// single fleet-wide fingerprint row. That row is written by the FIRST verified
// re-arm, and setConfig invalidates the runtime-config cache, so instance 2..N
// in rearmOpenWebhooks' own loop read the NEW fingerprint, concluded "nothing
// rotated" and fell back to their own <1h clock - staying registered with the
// OLD token, answering every inbound shop reply 403 (which is not the 503
// redeliver path) for up to a full hour.
//
// The fingerprint row therefore has to name WHEN the current token came into
// force, so each instance can compare its OWN re-arm clock against it. This
// suite is the fleet-level pin: the rotation is repaired for every open
// instance in one sweep, and the sweep after that does not churn.
//
// EXECUTED against the real rearmOpenWebhooks / reassertWebhook over the
// Map-backed store, with setConfig persisting so the row round-trips.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  return {
    ...h.runtimeConfigMock(),
    setConfig: async (name: string, value: string) => {
      h.store.config.set(name, value);
      return true;
    },
  };
});

import { store } from "../privacy/postgrest-store.test-helper";
import { rearmOpenWebhooks, reassertWebhook } from "../evolution";

const FP_KEY = "WH_REARM_TOKEN_FP";
const FLEET = ["a@example.com", "b@example.com", "c@example.com"];
let calls: string[] = [];

const seedFleet = (rearmedAtMs: number) => {
  for (const email of FLEET) {
    store.seed("wa_sessions", [
      {
        email,
        instance_name: `wd-${email[0]}`,
        status: "open",
        host_url: "https://evo.test",
        updated_at: new Date(rearmedAtMs).toISOString(),
        webhook_rearmed_at: new Date(rearmedAtMs).toISOString(),
      },
    ]);
  }
};

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
      // Evolution answers, but reports no readable URL: the re-arm proceeds to
      // /webhook/set for any instance that is not throttled out.
      return new Response("{}", { status: 200 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const hits = (fragment: string) => calls.filter((c) => c.includes(fragment)).length;

describe("EXECUTED (F180): one rotation repairs every open instance", () => {
  it("all three instances re-register, not just the first one the sweep reaches", async () => {
    seedFleet(Date.now() - 2 * 60_000); // every instance re-armed two minutes ago
    store.config.set(FP_KEY, "0000stale0000fp0"); // ...under the PREVIOUS token

    const res = await rearmOpenWebhooks();

    expect(res.scanned).toBe(3);
    expect(hits("/webhook/set/")).toBe(3);
    expect(res.rearmed).toBe(3);
  });

  it("the sweep after the repair does not churn the fleet", async () => {
    seedFleet(Date.now() - 2 * 60_000);
    store.config.set(FP_KEY, "0000stale0000fp0");
    await rearmOpenWebhooks();

    calls = [];
    const second = await rearmOpenWebhooks();

    expect(hits("/webhook/set/")).toBe(0);
    expect(hits("/webhook/find/")).toBe(0);
    expect(second.rearmed).toBe(0);
  });

  it("an instance whose clock predates the rotation is repaired even alone", async () => {
    // The sweep is capped and rotates; the instance the cap missed must still
    // be repaired on the tick that reaches it, however long after the rotation.
    seedFleet(Date.now() - 2 * 60_000);
    store.config.set(FP_KEY, "0000stale0000fp0");
    const first = await reassertWebhook(FLEET[0]);
    expect(first.changed).toBe(true);

    calls = [];
    const late = await reassertWebhook(FLEET[2]);
    expect(late.skipped).toBeUndefined();
    expect(late.changed).toBe(true);
    expect(hits("/webhook/set/")).toBe(1);
  });
});
