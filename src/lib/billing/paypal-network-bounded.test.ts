import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT M21: THE MONEY PATH HAD NO TIMEOUT AND NO CATCH.
//
// `paypalToken` (paypal.ts, the OAuth call) and `fetchPaypalSubscription` (the
// subscription GET) each issued a bare `await fetch(...)`: no AbortController,
// no try/catch. `confirmPaypalSubscription` calls the second one WITHOUT a
// `.catch()` - unlike every other call site - and both /api/billing/confirm and
// /api/subscriptions/paypal-success await it bare. So a DNS blip or an
// ECONNRESET against PayPal, right after the traveller was charged, escaped as
// a raw 500: the button flow lost the designed "Nothing was charged twice - try
// again in a moment" and the redirect flow lost its `{ok:true, pending:true}`
// fallback. With no timeout the same call could instead hang to the platform
// kill.
//
// These tests EXECUTE the real functions against a stubbed global fetch. The
// timeout cases use fake timers and resolve to the literal string
// "never-settled" if the call has no ceiling, so a missing timeout is a clean
// assertion rather than a suite hang.

const config = new Map<string, string>();

vi.mock("@/lib/runtime-config", () => ({
  getConfig: async (name: string) => config.get(name) ?? undefined,
  sbInsert: async () => true,
  sbInsertReturning: async () => [],
  sbUpdateReturning: async () => [],
  sbSelect: async () => [],
}));

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  config.clear();
  config.set("PAYPAL_CLIENT_ID", "test-client-id");
  config.set("PAYPAL_CLIENT_SECRET", "test-secret");
  config.set("PAYPAL_ENV", "live");
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

/** A fetch that answers `bodies[i]` for the i-th matching url, else hangs. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => unknown) {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const out = handler(url, init);
    if (out instanceof Promise) return out as Promise<Response>;
    return out as Response;
  }) as unknown as typeof fetch;
}

const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** Never settles unless the caller aborts it. */
const hang = (init: RequestInit | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

const settleWithin = async (work: Promise<unknown>, ms: number) => {
  const raced = Promise.race([
    work.then(() => "settled").catch(() => "threw"),
    new Promise<string>((r) => setTimeout(() => r("never-settled"), ms)),
  ]);
  await vi.advanceTimersByTimeAsync(ms);
  return raced;
};

describe("a network failure on the money path never escapes as a throw", () => {
  it("fetchPaypalSubscription answers null when the TOKEN call rejects", async () => {
    stubFetch((url) => {
      if (url.includes("/v1/oauth2/token")) throw new Error("ECONNRESET");
      return jsonRes({});
    });
    const { fetchPaypalSubscription } = await import("../paypal");
    await expect(fetchPaypalSubscription("I-OLD-1")).resolves.toBeNull();
  });

  it("fetchPaypalSubscription answers null when the SUBSCRIPTION call rejects", async () => {
    stubFetch((url) => {
      if (url.includes("/v1/oauth2/token")) return jsonRes({ access_token: "T", expires_in: 3600 });
      throw new Error("ECONNRESET");
    });
    const { fetchPaypalSubscription } = await import("../paypal");
    await expect(fetchPaypalSubscription("I-OLD-1")).resolves.toBeNull();
  });

  it("and the confirm lands on the honest 502, not a raw crash", async () => {
    stubFetch(() => {
      throw new Error("getaddrinfo EAI_AGAIN api-m.paypal.com");
    });
    const { confirmPaypalSubscription } = await import("./confirm-subscription");
    const out = await confirmPaypalSubscription({
      email: "buyer@example.com",
      subscriptionId: "I-NEW-1",
      intendedPlan: "ultra",
      source: "button",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.status).toBe(502);
    // The copy is what stops a second checkout - it must survive the fix.
    expect(out.error).toContain("Nothing was charged twice");
  });
});

describe("every PayPal call carries a ceiling", () => {
  it("a stalled TOKEN call is abandoned instead of hanging to the platform kill", async () => {
    vi.useFakeTimers();
    stubFetch((_url, init) => hang(init));
    const { fetchPaypalSubscription } = await import("../paypal");
    expect(await settleWithin(fetchPaypalSubscription("I-OLD-1"), 30_000)).toBe("settled");
  });

  it("a stalled SUBSCRIPTION read is abandoned too, and answers null", async () => {
    vi.useFakeTimers();
    stubFetch((url, init) => {
      if (url.includes("/v1/oauth2/token")) return jsonRes({ access_token: "T", expires_in: 3600 });
      return hang(init);
    });
    const { fetchPaypalSubscription } = await import("../paypal");
    const work = fetchPaypalSubscription("I-OLD-1");
    expect(await settleWithin(work, 30_000)).toBe("settled");
    await expect(work).resolves.toBeNull();
  });

  it("a stalled CANCEL is abandoned and reported as not cancelled", async () => {
    vi.useFakeTimers();
    stubFetch((url, init) => {
      if (url.includes("/v1/oauth2/token")) return jsonRes({ access_token: "T", expires_in: 3600 });
      return hang(init);
    });
    const { cancelPaypalSubscription } = await import("../paypal");
    const work = cancelPaypalSubscription("I-OLD-1", "Replaced by a new WheelDeal plan");
    expect(await settleWithin(work, 30_000)).toBe("settled");
    await expect(work).resolves.toBe(false);
  });
});
