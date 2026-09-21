// THE BREAKER, THROUGH THE REAL LADDER. ai-breaker.test.ts proves the state
// machine; this proves lib/ai.ts actually consults it - which is the half that
// was missing in production, where a comment in provider-health.ts already
// CLAIMED "the chain skips the provider" for a paywalled rung and nothing did.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const calls: string[] = [];
let breakerConfig: string | undefined;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls.length = 0;
  breakerConfig = undefined;
  vi.resetModules();
  vi.stubGlobal("fetch", (url: string) => {
    const u = String(url);
    calls.push(u.includes("cerebras") ? "cerebras" : u.includes("groq") ? "groq" : u);
    if (u.includes("cerebras")) return Promise.resolve(reply(402, { message: "Payment required to access this resource" }));
    return Promise.resolve(reply(200, { choices: [{ message: { content: "three hundred baht a day" } }], usage: { total_tokens: 12 } }));
  });
  vi.doMock("./runtime-config", async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    getConfig: async (k: string) =>
      k === "GROQ_TOKEN" || k === "CEREBRAS_TOKEN" ? "test-secret" : k === "AI_PROVIDER" ? "cerebras" : k === "AI_BREAKER" ? breakerConfig : undefined,
    sbInsert: async () => true,
    sbSelect: async () => [],
    sbSelectStrict: async () => ({ rows: [] as unknown[] }),
    sbUpdate: async () => true,
  }));
  vi.doMock("./rival-cache", () => ({ hotStateClient: async () => null }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function ladder() {
  const { resetBreaker } = await import("./ai-breaker");
  resetBreaker();
  const { chatDetailed } = await import("./ai");
  return (text: string) => chatDetailed([{ role: "user", content: text }], { preferProvider: "cerebras", budgetMs: 8_000 });
}

describe("a dead rung is paid for once, not on every call", () => {
  it("the first call discovers the 402 and fails over; the second never touches it", async () => {
    const ask = await ladder();

    const first = await ask("how much per day?");
    expect(first.text).toBe("three hundred baht a day");
    expect(first.provider).toBe("groq");
    expect(calls.filter((c) => c === "cerebras").length, "the first call has to find out").toBeGreaterThan(0);

    calls.length = 0;
    const second = await ask("and for a week?");
    expect(second.provider).toBe("groq");
    expect(calls, "cerebras said 402 a moment ago - asking again is pure wasted latency").not.toContain("cerebras");
  });

  it("AI_BREAKER=off restores the old behaviour exactly", async () => {
    breakerConfig = "off";
    const ask = await ladder();
    await ask("one");
    calls.length = 0;
    await ask("two");
    expect(calls).toContain("cerebras");
  });
});
