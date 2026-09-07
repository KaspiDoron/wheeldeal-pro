// AUDIT M20 - the AI and Whisper call budgets must span the BODY, not stop at
// the response headers.
//
// Both wrappers armed an AbortController and then cleared the timer in a
// `finally` that runs the moment `await fetch(...)` resolves - which is the
// HEADER boundary. Neither path streams, so the caller immediately does `await
// res.json()`, and that body read shares the controller the timer just
// disarmed: a provider that flushes 200 headers and then stalls mid-body held
// the request for undici's ~300s default bodyTimeout, far past the 14s per-call
// budget, the 20s Whisper budget and Cloud Run's own ceiling. runtime-config's
// timedFetch documents exactly this and deliberately does NOT clear its timer.
//
// These tests EXECUTE both wrappers against a provider that answers headers and
// then goes silent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

/** A response whose headers arrived and whose BODY never does. */
function headersThenSilence(init: RequestInit | undefined) {
  const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
  const stalledBody = <T>() =>
    new Promise<T>((_resolve, reject) => {
      signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))
      );
    });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => stalledBody<unknown>(),
    text: () => stalledBody<string>(),
  } as unknown as Response;
}

const fetchCalls: string[] = [];

beforeEach(() => {
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetchCalls.push(String(url));
    return Promise.resolve(headersThenSilence(init));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the LLM call budget covers the body", () => {
  it("gives up on a provider that sends headers and then nothing", async () => {
    vi.doMock("./runtime-config", async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      getConfig: async (k: string) => (k === "GROQ_TOKEN" ? "test-secret" : undefined),
      sbInsert: async () => true,
      sbSelect: async () => [],
      sbSelectStrict: async () => ({ rows: [] as unknown[] }),
      sbUpdate: async () => true,
    }));
    vi.doMock("./rival-cache", () => ({ hotStateClient: async () => null }));
    const { chatDetailed } = await import("./ai");

    // budgetMs is clamped to a 2s floor per call, so the whole race is short.
    let sentinel: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<"hung">((r) => {
      sentinel = setTimeout(() => r("hung"), 20_000);
    });
    const out = await Promise.race([
      chatDetailed([{ role: "user", content: "hello" }], { budgetMs: 1_000 }).then(
        (r) => r as { text: string | null; error?: string }
      ),
      hung,
    ]);
    if (sentinel) clearTimeout(sentinel);
    expect(
      out,
      "a provider that stalls mid-body must hit the same abort the headers were bounded by"
    ).not.toBe("hung");
    const detailed = out as { text: string | null; error?: string };
    expect(detailed.text).toBeNull();
    // fetchNamed's wording is what the provider panels and the rescue gates
    // key on - an abort raised during the body read must not lose it.
    expect(String(detailed.error ?? "")).toMatch(/timed out after \d+ms/);
    expect(fetchCalls.length).toBeGreaterThan(0);
  }, 40_000);
});

describe("the Whisper call budget covers the body", () => {
  it("falls through to the next rung instead of hanging on a silent body", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    // Paths resolve from THIS file: graph/transcribe's "../ai" is our "./ai".
    vi.doMock("./runtime-config", async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      getConfig: async (k: string) => (k === "GROQ_TOKEN" ? "test-secret" : undefined),
    }));
    vi.doMock("./usage", () => ({
      recordApi: async () => {},
      whisperOverSoftCap: async () => false,
    }));
    vi.doMock("./ai", () => ({ chatVision: async () => "four hundred baht a day" }));
    const { transcribeAudio } = await import("./graph/transcribe");
    // Warm the modules the ladder imports lazily: under fake timers a module
    // load still needs real I/O, and the virtual clock would run past it.
    await import("./vision-read");
    await import("./usage");

    const hung = new Promise<"hung">((r) => {
      setTimeout(() => r("hung"), 600_000);
    });
    const race = Promise.race([
      transcribeAudio({ mime: "audio/ogg", base64: "T2dnUwACAA==" }),
      hung,
    ]);
    await vi.advanceTimersByTimeAsync(700_000);
    const out = await race;
    expect(
      out,
      "the 20s Whisper budget was disarmed at the headers, so a silent body ran forever"
    ).not.toBe("hung");
    expect((out as { source?: string } | null)?.source).toBe("gemini");
  }, 40_000);
});
