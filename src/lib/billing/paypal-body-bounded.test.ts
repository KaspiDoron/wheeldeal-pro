import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT M21b - THE CEILING STOPPED AT THE HEADER BOUNDARY.
//
// M21 gave every PayPal call an AbortController, but `paypalFetch` cleared the
// timer in its `finally`, i.e. the moment the response HEADERS arrived. fetch()
// resolves there; the callers then `await res.json()`, and with the timer
// already cleared that body read shares an AbortController nobody will ever
// fire. undici's default bodyTimeout is ~300s, far past the platform request
// limit, so PayPal streaming headers and then stalling mid-body still hung the
// pre-grant `fetchPaypalSubscription` inside `confirmPaypalSubscription` -
// which sits OUTSIDE the 8s supersede race and had no ceiling of its own.
//
// The repo already writes this rule down at runtime-config.ts (`timedFetch`
// deliberately does NOT clear at the header boundary) and follows it in
// whatsapp.ts and waba/send.ts (which clears only after the body is read).
//
// These tests EXECUTE the real functions against a stubbed global fetch whose
// headers resolve and whose BODY never settles unless the signal aborts. A
// missing body ceiling shows up as the literal string "never-settled" rather
// than as a hung suite.

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

function stubFetch(handler: (url: string, init: RequestInit | undefined) => unknown) {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const out = handler(url, init);
    if (out instanceof Promise) return out as Promise<Response>;
    return out as Response;
  }) as unknown as typeof fetch;
}

const jsonRes = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

/** A promise that settles only when the request's signal aborts. */
const untilAborted = (init: RequestInit | undefined) =>
  new Promise<never>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

/**
 * Headers arrive normally; the BODY never settles. This is the shape a proxy
 * or a load-shedding origin produces, and the one the header-boundary clear
 * left unbounded.
 */
const headersThenStalledBody = (init: RequestInit | undefined) =>
  ({
    ok: true,
    status: 200,
    json: () => untilAborted(init),
    text: () => untilAborted(init),
  }) as unknown as Response;

const settleWithin = async (work: Promise<unknown>, ms: number) => {
  const raced = Promise.race([
    work.then(() => "settled").catch(() => "threw"),
    new Promise<string>((r) => setTimeout(() => r("never-settled"), ms)),
  ]);
  await vi.advanceTimersByTimeAsync(ms);
  return raced;
};

const tokenThen = (rest: (init: RequestInit | undefined) => Response) =>
  stubFetch((url, init) => {
    if (url.includes("/v1/oauth2/token")) {
      return jsonRes({ access_token: "T", expires_in: 3600 });
    }
    return rest(init);
  });

describe("the PayPal ceiling covers the BODY, not just the headers", () => {
  it("a stalled subscription BODY answers null inside the ceiling", async () => {
    vi.useFakeTimers();
    tokenThen((init) => headersThenStalledBody(init));
    const { fetchPaypalSubscription } = await import("../paypal");
    const work = fetchPaypalSubscription("I-OLD-1");
    expect(await settleWithin(work, 60_000)).toBe("settled");
    // NULL IS THE HONEST ANSWER: PayPal did not reply. A 200 with no body is
    // not a subscription, and confirm turns null into its 502 with the copy
    // that stops a second checkout.
    await expect(work).resolves.toBeNull();
  });

  it("a stalled TOKEN body does not hang the call either", async () => {
    vi.useFakeTimers();
    stubFetch((_url, init) => headersThenStalledBody(init));
    const { fetchPaypalSubscription } = await import("../paypal");
    const work = fetchPaypalSubscription("I-OLD-1");
    expect(await settleWithin(work, 60_000)).toBe("settled");
    await expect(work).resolves.toBeNull();
  });

  it("the pre-grant read inside confirmPaypalSubscription is bounded too", async () => {
    const { confirmPaypalSubscription } = await import("./confirm-subscription");
    const call = () =>
      confirmPaypalSubscription({
        email: "buyer@example.com",
        subscriptionId: "I-NEW-1",
        intendedPlan: "ultra",
        source: "button",
      });
    // confirm resolves `../paypal` with a call-time dynamic import. Warm it on
    // REAL timers first, so the race below measures the request ceiling rather
    // than the module loader.
    stubFetch(() => {
      throw new Error("warm-up: no network");
    });
    expect((await call()).ok).toBe(false);

    vi.useFakeTimers();
    tokenThen((init) => headersThenStalledBody(init));
    const work = call();
    expect(await settleWithin(work, 60_000)).toBe("settled");
    const out = await work;
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.status).toBe(502);
    expect(out.error).toContain("Nothing was charged twice");
  });

  it("a stalled CANCEL body is reported as not cancelled, not as success", async () => {
    vi.useFakeTimers();
    tokenThen((init) => headersThenStalledBody(init));
    const { cancelPaypalSubscription } = await import("../paypal");
    const work = cancelPaypalSubscription("I-OLD-1", "Replaced by a new WheelDeal plan");
    expect(await settleWithin(work, 60_000)).toBe("settled");
    // The 200-with-a-stalled-body case must not read as a confirmed cancel:
    // only a real 204/422 from PayPal means the subscription is gone.
    await expect(work).resolves.toBe(false);
  });

  it("REGRESSION: a normal body still parses, so the ceiling change is invisible in the happy path", async () => {
    tokenThen(() =>
      jsonRes({
        id: "I-OLD-1",
        status: "ACTIVE",
        plan_id: "P-ULTRA",
        subscriber: { email_address: "buyer@example.com" },
        billing_info: { next_billing_time: "2026-10-01T00:00:00Z" },
      })
    );
    const { fetchPaypalSubscription } = await import("../paypal");
    await expect(fetchPaypalSubscription("I-OLD-1")).resolves.toEqual({
      id: "I-OLD-1",
      status: "ACTIVE",
      planId: "P-ULTRA",
      subscriberEmail: "buyer@example.com",
      nextBillingAt: "2026-10-01T00:00:00Z",
    });
  });
});
