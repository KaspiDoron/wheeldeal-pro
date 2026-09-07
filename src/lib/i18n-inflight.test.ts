// AUDIT F253 - one language switch must not pay for the same strings twice.
//
// Two multipliers stacked on the same path.
//
//   1. NO IN-FLIGHT GUARD. `fetchTranslations` never recorded what it was
//      asking for, and `retriable` filtered only against `failed`. A cold
//      switch to Hebrew POSTs the whole catalogue in parallel batches, each
//      running tens of seconds; meanwhile the same render pass commits an empty
//      dict, so every t() on screen re-queues its string into `pending`, and
//      the 1.5s sweep re-POSTs strings the first fetch is still holding - every
//      1.5 seconds, for the whole in-flight window.
//
//   2. TWO DEBITS PER REQUEST. /api/translate called checkDailyLimit WITHOUT
//      `reserve:false`, so every POST consumed a unit of
//      LIMIT_TRANSLATE_PER_DAY (60 for a free tester) before it had done any
//      work at all - and then recordApi added a second one whenever the LLM
//      swept, contradicting the route's own comment that "a cache hit costs
//      nothing". The 429 that follows latches the terminal `stop`, so a single
//      language switch leaves the app in English until tomorrow.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { retriable } from "./i18n-retry";
import {
  pending,
  failed,
  inFlight,
  markInFlight,
  clearInFlight,
  requeueForTranslation,
  queueForTranslation,
} from "./i18n-gate";
import { I18N_CATALOG } from "./i18n-catalog";

const A = I18N_CATALOG[0];
const B = I18N_CATALOG[1];
const C = I18N_CATALOG[2];

beforeEach(() => {
  pending.clear();
  failed.clear();
  inFlight.clear();
});

describe("F253 - a string being fetched is not asked for again", () => {
  it("THE BUG: a string in flight is dropped from the next sweep's batch", () => {
    markInFlight([A, B]);
    // The render pass that follows the switch re-queues everything on screen.
    queueForTranslation(A);
    queueForTranslation(B);
    queueForTranslation(C);
    expect(retriable(pending, failed, inFlight)).toEqual([C]);
  });

  it("...and is asked for again once that fetch settles", () => {
    markInFlight([A]);
    queueForTranslation(A);
    expect(retriable(pending, failed, inFlight)).toEqual([]);
    clearInFlight([A]);
    expect(retriable(pending, failed, inFlight)).toEqual([A]);
  });

  it("a declined string stays declined, in flight or not", () => {
    failed.add(A);
    queueForTranslation(A); // refused at the gate
    pending.add(A); // ...and even if it got in some other way
    expect(retriable(pending, failed, inFlight)).toEqual([]);
    markInFlight([A]);
    expect(retriable(pending, failed, inFlight)).toEqual([]);
  });

  it("the old two-argument call still works - nothing pinned by it changes", () => {
    pending.add(A);
    pending.add(B);
    failed.add(B);
    expect(retriable(pending, failed)).toEqual([A]);
  });

  it("clearing in-flight only clears what was marked", () => {
    markInFlight([A, B]);
    clearInFlight([A]);
    expect(inFlight.has(A)).toBe(false);
    expect(inFlight.has(B)).toBe(true);
  });
});

describe("F253 - a transient miss is returned to the queue, not lost", () => {
  it("a retriable batch goes back into pending", () => {
    // The sweep clears `pending` when it takes a batch, so a 5xx used to lose
    // those strings until some render happened to re-queue them.
    requeueForTranslation([A, B]);
    expect(retriable(pending, failed, inFlight)).toEqual([A, B]);
  });

  it("a string the server declined is NOT resurrected by a requeue", () => {
    failed.add(A);
    requeueForTranslation([A, B]);
    expect(retriable(pending, failed, inFlight)).toEqual([B]);
  });
});

// ---------------------------------------------------------------------------
// The route: one debit per request, and only when it did the work.
// ---------------------------------------------------------------------------

const gateCalls: { limitName: string; opts?: { reserve?: boolean } }[] = [];
const debits: { kind: string; n: number }[] = [];

async function loadTranslatePOST(dict: Record<string, string>) {
  vi.resetModules();
  gateCalls.length = 0;
  debits.length = 0;
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: "t@example.com", plan: "free" }),
  }));
  vi.doMock("@/lib/usage", () => ({
    checkDailyLimit: async (
      _kind: string,
      _who: string,
      limitName: string,
      opts?: { reserve?: boolean }
    ) => {
      gateCalls.push({ limitName, opts });
      return { allowed: true, used: 0, limit: 60 };
    },
    recordApi: async (kind: string, n: number) => {
      debits.push({ kind, n });
    },
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    getConfigExact: async () => JSON.stringify(dict),
    setConfig: async () => true,
  }));
  vi.doMock("@/lib/ai", () => ({
    aiEnabled: () => false,
    chat: async () => "",
  }));
  const mod = await import("@/app/api/translate/route");
  return mod.POST;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/session");
  vi.doUnmock("@/lib/usage");
  vi.doUnmock("@/lib/runtime-config");
  vi.doUnmock("@/lib/ai");
});

function post(body: unknown): Request {
  return new Request("http://x/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("F253 - the gate PEEKS, so a served-from-cache request costs nothing", () => {
  it("THE BUG: the daily gate no longer reserves a unit of its own", async () => {
    const POST = await loadTranslatePOST({ [A]: "א" });
    const res = await POST(post({ lang: "he", langName: "Hebrew", texts: [A] }));
    expect(res.status).toBe(200);
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0].limitName).toBe("LIMIT_TRANSLATE_PER_DAY");
    // Without this the 29 batches of one cold catalogue switch spend 58 of a
    // free tester's 60 units before a single string is translated.
    expect(gateCalls[0].opts?.reserve).toBe(false);
  });

  it("a fully cached answer debits nothing at all", async () => {
    const POST = await loadTranslatePOST({ [A]: "א" });
    const body = await (await POST(post({ lang: "he", langName: "Hebrew", texts: [A] }))).json();
    expect(body.map[A]).toBe("א");
    expect(debits).toEqual([]);
  });
});

describe("F253 - the client sweep carries the guard", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/i18n.tsx"), "utf8");

  it("fetchTranslations marks its batch in flight and releases it", () => {
    expect(src).toContain("markInFlight");
    expect(src).toContain("clearInFlight");
  });

  it("the 1.5s sweep asks retriable about the in-flight set", () => {
    expect(src).toContain("retriable(pending, failed, inFlight)");
    // ...and the unguarded two-argument call is gone from the sweep.
    expect(src).not.toContain("retriable(pending, failed)");
  });

  it("a transient failure returns the batch instead of dropping it", () => {
    expect(src).toContain("requeueForTranslation");
  });

  it("a sweep cannot start while one is running", () => {
    expect(src).toContain("sweepInFlight");
  });
});
