// AUDIT F045 + F052 - ensureConnected keeps the budget it advertises, and
// reads the session row BEFORE it registers a device.
//
// F045: `budgetMs` used to start counting AFTER four unbounded 12s evoFetch
// calls (two probes, /instance/create, /instance/connect), so a hung host made
// ensureConnected(email, 6000) cost about 73s. sendFromUser begins with it on
// every drained row, so one such sender blew the drain's 50s budget and the
// ping's 55s self-kill, and the eight post-drain sweeps never ran. A status-0
// probe was also read as "the instance is missing" and authorised a fresh
// device registration against a number we had no live information about.
//
// F052: the `prior === null` refusal - whose own comment says "a background
// drain must NEVER mint a connecting session for them" - sat AFTER
// /instance/create + /instance/connect, so one surviving wa_outbox row for an
// erased or unlinked account re-registered that account's instance on the host
// and re-armed a webhook for it.
//
// EXECUTED against the real ensureConnected on a fake clock.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../runtime-config", async () => {
  const h = await import("../privacy/postgrest-store.test-helper");
  return h.runtimeConfigMock();
});

import { store } from "../privacy/postgrest-store.test-helper";
import { ensureConnected } from "../evolution";
import "./phone-key";
import "../wa-guard";

let calls: string[] = [];
let answer: ((path: string) => Response | null) | null = null;

/** A host that ANSWERS: not open, but definitively so. */
const definitiveNotOpen = (path: string): Response | null => {
  if (path.includes("/instance/connectionState/"))
    return new Response(JSON.stringify({ instance: { state: "connecting" } }), { status: 200 });
  if (path.includes("/instance/fetchInstances")) return new Response("[]", { status: 200 });
  if (path.includes("/instance/")) return new Response("{}", { status: 200 });
  return null;
};

beforeEach(() => {
  store.reset();
  calls = [];
  answer = null;
  store.config.set("EVOLUTION_API_URL", "https://evo.test");
  store.config.set("EVOLUTION_API_KEY", "test-key");
  store.config.set("APP_DOMAIN", "https://app.test");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const path = url.replace("https://evo.test", "");
      calls.push(path);
      const canned = answer?.(path);
      if (canned) return Promise.resolve(canned);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    })
  );
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const hits = (fragment: string) => calls.filter((c) => c.includes(fragment)).length;

async function timed<T>(work: Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = Date.now();
  let finishedAt = startedAt;
  const pending = work.then((v) => {
    finishedAt = Date.now();
    return v;
  });
  await vi.advanceTimersByTimeAsync(240_000);
  return { value: await pending, elapsedMs: finishedAt - startedAt };
}

const linked = (email: string) =>
  store.seed("wa_sessions", [
    { email, instance_name: "wd-x", status: "open", host_url: "https://evo.test" },
  ]);

describe("EXECUTED (F045): the budget is a wall clock, not a stopwatch started late", () => {
  it("a hung host costs the budget, not 73s - and buys no device registration", async () => {
    const email = "hung@example.com";
    linked(email);
    const { value, elapsedMs } = await timed(ensureConnected(email, 6_000));
    expect(value.ok).toBe(false);
    expect(elapsedMs).toBeLessThanOrEqual(6_000);
    // A probe that never reached the host says nothing about the instance, so
    // the failover recreate is NOT authorised.
    expect(hits("/instance/create")).toBe(0);
    expect(hits("/instance/connect/")).toBe(0);
    // ...and the second probe is not issued once the budget is spent.
    expect(hits("/instance/fetchInstances")).toBe(0);
  });

  it("a host that ANSWERS still gets the failover recreate", async () => {
    const email = "linked@example.com";
    linked(email);
    answer = definitiveNotOpen;
    const { value } = await timed(ensureConnected(email, 4_000));
    expect(value.ok).toBe(false);
    expect(hits("/instance/create")).toBe(1);
    expect(hits("/instance/connect/")).toBe(1);
  });
});

describe("EXECUTED (F052): no session row means no instance is registered", () => {
  it("a rowless sender never reaches /instance/create", async () => {
    const email = "erased@example.com";
    // No wa_sessions row at all - erased, or unlinked while an outbox row
    // survived disconnectInstance's best-effort purge.
    answer = definitiveNotOpen;
    const { value } = await timed(ensureConnected(email, 6_000));
    expect(value.ok).toBe(false);
    expect(hits("/instance/create")).toBe(0);
    expect(hits("/instance/connect/")).toBe(0);
    // ...and no "connecting" session was minted for them either.
    expect(store.rows("wa_sessions")).toHaveLength(0);
  });

  it("an UNREADABLE session row still fails open - a Supabase blip blocks nothing", async () => {
    const email = "blip@example.com";
    linked(email);
    store.unavailable.add("wa_sessions");
    answer = definitiveNotOpen;
    const { value } = await timed(ensureConnected(email, 4_000));
    expect(value.ok).toBe(false);
    expect(hits("/instance/create")).toBe(1);
  });
});
