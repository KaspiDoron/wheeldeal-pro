import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// "Test AI providers" (owner request, post-launch): one tap fires a tiny real
// completion at EVERY configured provider and reports which MODEL answered.
// These tests execute the route for real (admin-workspace.test.ts pattern)
// and pin the panel wiring.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/session");
  vi.doUnmock("@/lib/ai");
});

describe("/api/admin/ai-test", () => {
  it("refuses non-management sessions", async () => {
    vi.doMock("@/lib/session", () => ({ requireManagement: vi.fn(async () => null) }));
    vi.doMock("@/lib/ai", () => ({ testAllProviders: vi.fn(async () => []) }));
    const route = await import("../app/api/admin/ai-test/route");
    const res = await route.POST();
    expect(res.status).toBe(403);
  });

  it("returns the per-provider verdicts verbatim", async () => {
    vi.doMock("@/lib/session", () => ({
      requireManagement: vi.fn(async () => ({ email: "admin@e2e.test", isAdmin: true })),
    }));
    const results = [
      { name: "groq", configured: true, ok: true, model: "llama-3.3-70b-versatile", ms: 400 },
      { name: "cerebras", configured: true, ok: false, detail: "cerebras 404 - model_not_found" },
      { name: "together", configured: false, ok: false, detail: "no key set" },
    ];
    vi.doMock("@/lib/ai", () => ({ testAllProviders: vi.fn(async () => results) }));
    const route = await import("../app/api/admin/ai-test/route");
    const res = await route.POST();
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual(results);
  });

  it("a crashed sweep returns its own words, not an opaque 500", async () => {
    // The production failure mode this exists for: the panel showed only
    // "the test call itself failed" because every server-side crash reached
    // the client as an unreadable non-JSON 500.
    vi.doMock("@/lib/session", () => ({
      requireManagement: vi.fn(async () => ({ email: "admin@e2e.test", isAdmin: true })),
    }));
    vi.doMock("@/lib/ai", () => ({
      testAllProviders: vi.fn(async () => {
        throw new Error("supabase config read exploded");
      }),
    }));
    const route = await import("../app/api/admin/ai-test/route");
    const res = await route.POST();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/supabase config read exploded/);
  });
});

describe("testAllProviders contract (source pins)", () => {
  const ai = read("src/lib/ai.ts");

  it("reports the model that ANSWERED and the configured primary separately", () => {
    // A drifted primary rescued by its fallback must be visible as ok-but-
    // drifted, not a silent pass - the exact failure mode callProvider's
    // rescue telemetry exists for.
    expect(ai).toMatch(/configuredModel\?: string/);
    expect(ai).toMatch(/model: r\.model/);
    expect(ai).toMatch(/configuredModel: p\.model/);
  });

  it("an unconfigured provider is reported, never silently skipped", () => {
    expect(ai).toMatch(/configured: false, ok: false, detail: "no key set"/);
  });

  it("a congested primary (429) tries its fallback model, like a dead id does", () => {
    // The owner's live sweep: SambaNova 429 "high demand" on Llama-3.3-70B
    // and OpenRouter 429 "temporarily rate-limited upstream" on the :free
    // primary. Both providers throttle PER MODEL, so the sibling fallback
    // on the same key is the correct next move - gating the rescue on
    // 400/404 alone left both providers red while their fallbacks idled.
    expect(ai).toMatch(/\\b\(400\|404\|429\)\\b/);
  });

  it("a TIMED-OUT primary earns the same rescue, with the same classifier vision trusts", () => {
    // Third live round: SambaNova queued the probe past its socket budget and
    // the panel showed the bare platform string "This operation was aborted" -
    // no provider, no status, no rescue. A queue-timeout is congestion wearing
    // a different mask, so it routes to the sibling id like a 429 does.
    expect(ai).toMatch(/visionFailureFromThrown\(e\) === "timeout"/);
    // And the abort itself is renamed at the fetch chokepoint so no surface
    // ever shows the anonymous platform message again.
    expect(ai).toMatch(/timed out after \$\{timeoutMs\}ms \(no response\)/);
  });

  it("the provider deadline is SPLIT across primary and fallback, never duplicated", () => {
    // The reply path budgets 9s for the whole chain; a rescue that re-spends
    // the full budget lets one provider consume 2x its share, and a HUNG
    // primary would leave a timeout-rescue nothing to run with.
    expect(ai).toMatch(/Math\.round\(timeoutMs \* 0\.6\)/);
    expect(ai).toMatch(/Math\.max\(2_000, deadline - Date\.now\(\)\)/);
  });

  it("the free chain is ordered cheapest-failure-first, and PAID rungs sit behind it", () => {
    // TWO ORDER TABLES, ONE RULE (rewritten W-beta30; the pin used to require
    // "deepseek before sambanova", which was the old fast-tier reasoning).
    //
    // sambanova keeps its demotion - the owner's live probe answered 429 on
    // BOTH its pools, so reaching it early spends two dead round trips out of
    // SPTE's 9s reply budget - but it moved further back still, behind the
    // free rungs that actually answer.
    //
    // And deepseek left the free block entirely, which is the stronger fix:
    // it spends the owner's pay-as-you-go BALANCE, and sitting second in the
    // chain meant every minute groq's RPM was spent, the whole fleet's
    // spillover silently billed the owner before five free rungs were tried.
    // A paid rung must never be reached by accident.
    const open = ai.indexOf("= [", ai.indexOf("PROVIDER_NAMES"));
    const table = ai.slice(open, ai.indexOf("]", open));
    const at = (name: string) => table.indexOf(`"${name}"`);
    // Fast free rungs lead sambanova...
    expect(at("groq")).toBeLessThan(at("sambanova"));
    expect(at("together")).toBeLessThan(at("sambanova"));
    expect(at("gemini")).toBeLessThan(at("sambanova"));
    // ...and every free rung leads every paid one.
    for (const free of ["groq", "together", "openrouter", "mistral", "huggingface", "gemini"]) {
      for (const paid of ["deepseek", "anthropic", "openai"]) {
        expect(at(free), `${free} must precede paid ${paid}`).toBeLessThan(at(paid));
      }
    }
    // allProviders() (the real chain) agrees with the name table.
    const block = (name: string) => ai.indexOf(`name: "${name}"`);
    expect(block("deepseek")).toBeGreaterThan(0);
    expect(block("gemini"), "allProviders() must list gemini before sambanova").toBeLessThan(
      block("sambanova")
    );
    expect(block("sambanova"), "allProviders() must list free rungs before paid deepseek").toBeLessThan(
      block("deepseek")
    );
    // The paid flag is what makes tier:"premium" able to hoist it deliberately.
    const dsBlock = ai.slice(block("deepseek"), block("deepseek") + 900);
    expect(dsBlock).toMatch(/paid: true/);
  });

  it("EXECUTED: 429 primary -> fallback answers; both-fail names BOTH ids", async () => {
    // Live evidence this encodes: the owner's sweep showed SambaNova red with
    // ONLY the primary's "high demand" error, which was indistinguishable
    // from "the fallback was never tried". Run the real code against a
    // stubbed network both ways.
    process.env.SAMBANOVA_TOKEN = "fake-key";
    try {
      let mode: "rescue" | "both-fail" = "rescue";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown, init?: { body?: string }) => {
          if (!String(url).includes("sambanova")) return new Response("{}", { status: 200 });
          const model = JSON.parse(init?.body ?? "{}").model as string;
          const busy = (m: string) =>
            new Response(JSON.stringify({ error: { message: `${m} is currently experiencing high demand.` } }), { status: 429 });
          if (mode === "both-fail") return busy(model);
          return model === "gpt-oss-120b"
            ? new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { total_tokens: 5 } }), { status: 200 })
            : busy(model);
        })
      );
      const { testAllProviders } = await import("./ai");

      // Primary answers immediately (gpt-oss-120b now leads on SambaNova).
      const rescued = (await testAllProviders()).find((r) => r.name === "sambanova");
      expect(rescued?.ok).toBe(true);
      expect(rescued?.model).toBe("gpt-oss-120b");

      // Both pools drowning: the detail must name BOTH attempts.
      mode = "both-fail";
      const drowned = (await testAllProviders()).find((r) => r.name === "sambanova");
      expect(drowned?.ok).toBe(false);
      expect(drowned?.detail).toMatch(/primary gpt-oss-120b:/);
      expect(drowned?.detail).toMatch(/fallback Meta-Llama-3\.3-70B-Instruct:/);
    } finally {
      delete process.env.SAMBANOVA_TOKEN;
      vi.unstubAllGlobals();
    }
  });

  it("EXECUTED: a 402 'payment required' primary tries the free fallback model", async () => {
    // The owner's live Cerebras probe (2026-08-21): gpt-oss-120b answered
    // 402 and NO fallback was ever attempted - the one status that means
    // "use the free model instead" was the one that never tried it.
    //
    // Re-based off Cerebras deliberately: that row no longer HAS a fallback
    // (its 402 is account-level, so a second id can never rescue it - see the
    // single-call test below). HuggingFace is where a per-model 402 genuinely
    // happens: the router bills credits per model, so the 70B primary can hit
    // the credit wall while the free gpt-oss rung still answers.
    process.env.HUGGINGFACE_TOKEN = "fake-key";
    try {
      let accountLevel = false;
      const paywall = () =>
        new Response(
          JSON.stringify({ error: "You have exceeded your monthly included credits for Inference Providers." }),
          { status: 402 }
        );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown, init?: { body?: string }) => {
          if (!String(url).includes("huggingface")) return new Response("{}", { status: 200 });
          const model = JSON.parse(init?.body ?? "{}").model as string;
          if (accountLevel || model === "meta-llama/Llama-3.3-70B-Instruct") return paywall();
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { total_tokens: 5 } }),
            { status: 200 }
          );
        })
      );
      const { testAllProviders } = await import("./ai");

      const rescued = (await testAllProviders()).find((r) => r.name === "huggingface");
      expect(rescued?.ok).toBe(true);
      expect(rescued?.model).toBe("openai/gpt-oss-120b");

      accountLevel = true;
      const dead = (await testAllProviders()).find((r) => r.name === "huggingface");
      expect(dead?.ok).toBe(false);
      expect(dead?.detail).toMatch(/primary meta-llama\/Llama-3\.3-70B-Instruct:/);
      expect(dead?.detail).toMatch(/fallback openai\/gpt-oss-120b:/);
    } finally {
      delete process.env.HUGGINGFACE_TOKEN;
      vi.unstubAllGlobals();
    }
  });

  it("EXECUTED: Cerebras' account-level 402 costs ONE call, not two", async () => {
    // The owner paid for two dead round trips per sweep: the primary 402'd
    // (account-level - Cerebras retired its open free tier July 2026) and the
    // rescue then 404'd on llama3.1-8b, an id the collapsed roster no longer
    // serves. A rescue that CANNOT succeed is pure latency, so the row now
    // carries no fallback at all and the probe makes exactly one request.
    process.env.CEREBRAS_TOKEN = "fake-key";
    try {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown, init?: { body?: string }) => {
          if (!String(url).includes("cerebras")) return new Response("{}", { status: 200 });
          calls.push(JSON.parse(init?.body ?? "{}").model as string);
          return new Response(
            JSON.stringify({ message: "Payment required to access this resource." }),
            { status: 402 }
          );
        })
      );
      const { testAllProviders } = await import("./ai");
      const dead = (await testAllProviders()).find((r) => r.name === "cerebras");

      expect(dead?.ok).toBe(false);
      expect(calls, "one attempt only - no unwinnable second round trip").toEqual(["gpt-oss-120b"]);
      // ...and it reports as the provider's OWN error, never a both-ids report.
      expect(dead?.detail).toMatch(/cerebras 402/);
      expect(dead?.detail).not.toMatch(/fallback/);
    } finally {
      delete process.env.CEREBRAS_TOKEN;
      vi.unstubAllGlobals();
    }
  });

  it("EXECUTED: an ABORTED primary is rescued; a double abort names both ids honestly", async () => {
    // The exact live failure of round three: the fetch abort surfaced as the
    // bare "This operation was aborted" and no fallback was ever tried.
    process.env.SAMBANOVA_TOKEN = "fake-key";
    try {
      let mode: "rescue" | "both-fail" = "rescue";
      const abortErr = () =>
        Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown, init?: { body?: string }) => {
          if (!String(url).includes("sambanova")) return new Response("{}", { status: 200 });
          const model = JSON.parse(init?.body ?? "{}").model as string;
          if (mode === "both-fail" || model === "gpt-oss-120b") throw abortErr();
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { total_tokens: 5 } }),
            { status: 200 }
          );
        })
      );
      const { testAllProviders } = await import("./ai");

      const rescued = (await testAllProviders()).find((r) => r.name === "sambanova");
      expect(rescued?.ok).toBe(true);
      expect(rescued?.model).toBe("Meta-Llama-3.3-70B-Instruct");

      mode = "both-fail";
      const drowned = (await testAllProviders()).find((r) => r.name === "sambanova");
      expect(drowned?.ok).toBe(false);
      // Both halves carry the provider's name and the honest timeout wording -
      // never the anonymous platform string.
      expect(drowned?.detail).toMatch(/primary gpt-oss-120b: sambanova timed out after \d+ms/);
      expect(drowned?.detail).toMatch(/fallback Meta-Llama-3\.3-70B-Instruct: sambanova timed out/);
      expect(drowned?.detail).not.toMatch(/This operation was aborted/);
    } finally {
      delete process.env.SAMBANOVA_TOKEN;
      vi.unstubAllGlobals();
    }
  });

  it("EXECUTED: an HTML error page never reaches the panel as markup", async () => {
    // THE OWNER'S SCREENSHOT (2026-08-21): the HuggingFace card was 300
    // characters of `<!DOCTYPE html><html>...` - the Hub's EDGE limiter
    // answering before the request ever reached the API. The one fact that
    // mattered (429, i.e. busy, not broken) was buried under markup, and the
    // classifier had nothing readable to key on.
    process.env.HUGGINGFACE_TOKEN = "fake-key";
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) => {
          if (!String(url).includes("huggingface")) return new Response("{}", { status: 200 });
          return new Response(
            "<!DOCTYPE html>\n<html><head><title>Too Many Requests</title></head>" +
              "<body><h1>429</h1><p>You have exceeded the rate limit.</p></body></html>",
            { status: 429, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        })
      );
      const { testAllProviders } = await import("./ai");
      const hf = (await testAllProviders()).find((r) => r.name === "huggingface");

      expect(hf?.ok).toBe(false);
      // No markup, on either half of the both-ids report.
      expect(hf?.detail).not.toMatch(/<!DOCTYPE|<html|<body|<h1/i);
      // The status survives - which is what the classifier reads.
      expect(hf?.detail).toMatch(/huggingface 429/);
      expect(hf?.detail).toMatch(/HTML error page from the provider's edge/);
      const { providerFailureKind } = await import("./provider-health");
      expect(providerFailureKind(hf?.detail), "429 is busy, not a broken key").toBe("busy");
    } finally {
      delete process.env.HUGGINGFACE_TOKEN;
      vi.unstubAllGlobals();
    }
  });

  it("EXECUTED: a rescued sweep carries WHY the primary lost, not just that it did", async () => {
    // Without this the panel had one undifferentiated amber for two opposite
    // situations - a busy pool (nothing to fix) and a retired id (fix it now).
    // callProvider knew the reason and threw it away on success.
    process.env.SAMBANOVA_TOKEN = "fake-key";
    try {
      let dead = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown, init?: { body?: string }) => {
          if (!String(url).includes("sambanova")) return new Response("{}", { status: 200 });
          const model = JSON.parse(init?.body ?? "{}").model as string;
          if (model === "gpt-oss-120b")
            return dead
              ? new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 })
              : new Response(
                  JSON.stringify({ error: { message: "gpt-oss-120b is currently experiencing high demand." } }),
                  { status: 429 }
                );
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { total_tokens: 5 } }),
            { status: 200 }
          );
        })
      );
      const { testAllProviders } = await import("./ai");
      const { providerFailureKind } = await import("./provider-health");

      const busy = (await testAllProviders()).find((r) => r.name === "sambanova");
      expect(busy?.ok).toBe(true);
      expect(busy?.model).toBe("Meta-Llama-3.3-70B-Instruct");
      expect(busy?.primaryDetail).toMatch(/sambanova 429/);
      expect(providerFailureKind(busy?.primaryDetail), "calm: the chain worked").toBe("busy");

      dead = true;
      const drifted = (await testAllProviders()).find((r) => r.name === "sambanova");
      expect(drifted?.ok).toBe(true);
      expect(providerFailureKind(drifted?.primaryDetail), "fix-me: the id is gone").toBe("model");
    } finally {
      delete process.env.SAMBANOVA_TOKEN;
      vi.unstubAllGlobals();
    }
  });

  it("a provider that answers on its primary carries NO primary-failure note", async () => {
    // The calm/fix-me split is only meaningful if a clean pass stays clean.
    process.env.GROQ_TOKEN = "fake-key";
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { total_tokens: 5 } }),
            { status: 200 }
          )
        )
      );
      const { testAllProviders } = await import("./ai");
      const groq = (await testAllProviders()).find((r) => r.name === "groq");
      expect(groq?.ok).toBe(true);
      expect(groq?.primaryDetail).toBeUndefined();
    } finally {
      delete process.env.GROQ_TOKEN;
      vi.unstubAllGlobals();
    }
  });

  it("one hung provider cannot stall the whole sweep past an infra timeout", () => {
    // Real keys mean real calls: without a hard per-provider deadline the
    // response could take primary+fallback (20s+20s), long enough for the
    // transport in front of Cloud Run - or the phone - to give up, which is
    // exactly the "test call itself failed" the owner hit.
    expect(ai).toMatch(/probe timed out after 12s/);
    expect(ai).toMatch(/callProvider\(p, probe, 16, 10_000\)/);
    expect(ai).toMatch(/clearTimeout\(watchdog\)/);
  });
});

describe("the admin panel wiring", () => {
  const page = read("src/app/admin/page.tsx");

  it("the Test AI providers button renders ABOVE the provider boxes", () => {
    const btn = page.indexOf("Test AI providers");
    const list = page.indexOf("aiProviders.map");
    expect(btn).toBeGreaterThan(0);
    expect(list).toBeGreaterThan(0);
    expect(btn, "button must precede the provider list").toBeLessThan(list);
  });

  it("a DEAD primary id rescued by its fallback still renders as a fix-me", () => {
    // The drift this panel exists to catch: a renamed model id doubles every
    // LLM call forever while the sweep reads green.
    expect(page).toMatch(/t\.model !== t\.configuredModel/);
    expect(page).toMatch(/FAILED - the fallback answered/);
    expect(page).toMatch(/_MODEL/);
  });

  it("...but a BUSY primary rescued by its fallback reads calm, and stays green", () => {
    // The owner's live Gemini card: flash-latest was merely rate-limited (per
    // model, per project) while flash-lite answered, and the panel demanded
    // they "fix it or paste a working id" for a rolling alias that is not
    // broken. Nothing to fix is a different sentence from fix this now.
    expect(page).toMatch(/providerFailureKind\(t\.primaryDetail\)/);
    expect(page).toMatch(/driftKind === "busy" \|\| driftKind === "paywalled"/);
    expect(page).toMatch(/Nothing to fix\./);
    // Green card, not amber: the chain did exactly what it is built to do.
    expect(page).toMatch(/t\.ok && \(!drifted \|\| driftBenign\)/);
    // And the primary's own words stay on screen - interpretation NEVER
    // replaces evidence.
    expect(page).toMatch(/\{t\.primaryDetail\}/);
  });

  it("a paid-only provider is muted, never a red fault", () => {
    // Cerebras retired its open free tier: a 402 on a product that runs on
    // free tiers is a design decision the panel should state, not an alarm.
    expect(page).toMatch(/kind === "paywalled"/);
    expect(page).toMatch(/paid now, skipped by design/);
  });

  it("a failed sweep names WHICH layer failed, never one blanket line", () => {
    // HTTP status vs browser-side failure vs timeout are three different
    // diagnoses; collapsing them made the button undebuggable in production.
    expect(page).toMatch(/aiTestError/);
    expect(page).toMatch(/The server answered HTTP \$\{r\.status\}/);
    expect(page).toMatch(/The request failed in the browser/);
    expect(page).toMatch(/AbortSignal\.timeout\(60_000\)/);
    // The old behavior - every failure collapsing to an empty array with no
    // detail - must stay dead.
    expect(page).not.toMatch(/aiTest\.length === 0/);
  });
});
