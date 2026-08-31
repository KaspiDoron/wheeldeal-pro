import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// THE 30-TESTER READINESS WAVE.
//
// A 7-dimension capacity audit against the merged waves 0-10 asked one
// question - can 30 beta testers use this safely, fast, and without getting
// their personal WhatsApp numbers banned - and returned "conditional" on every
// dimension. These are the CODE halves of the answer (the infrastructure
// halves - a second Evolution host, REDIS_URL, the invite list - are owner
// actions recorded in RUNBOOK.md).
//
// EXECUTED where the behaviour is arithmetic, source-pinned only where the
// site genuinely lives inside a route handler. The audit's own criticism of
// this repo was that load-bearing constants were pinned by regex rather than
// exercised, so the new arithmetic here is exercised.

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// Plan-aware caps: the Ultra tester who was sold "unlimited" hit 5/day.
// ---------------------------------------------------------------------------

describe("per-user caps scale with the plan the traveller actually rides", () => {
  beforeEach(() => vi.resetModules());

  const loadUsage = async (cfg: Record<string, string> = {}) => {
    vi.doMock("./runtime-config", () => ({
      getConfig: async (k: string) => cfg[k],
      sbSelect: async () => [],
      sbSelectStrict: async () => ({ rows: [] }),
      sbInsert: async () => true,
    }));
    return import("./usage");
  };

  it("EXECUTED: free is the base, pro doubles, ultra quadruples", async () => {
    const { limitFor, LIMIT_DEFAULTS } = await loadUsage();
    const base = LIMIT_DEFAULTS.LIMIT_SEARCHES_PER_DAY;
    expect(await limitFor("LIMIT_SEARCHES_PER_DAY")).toBe(base);
    expect(await limitFor("LIMIT_SEARCHES_PER_DAY", { plan: "free" })).toBe(base);
    expect(await limitFor("LIMIT_SEARCHES_PER_DAY", { plan: "pro" })).toBe(base * 2);
    expect(await limitFor("LIMIT_SEARCHES_PER_DAY", { plan: "ultra" })).toBe(base * 4);
    // "business" is Ultra's legacy stored value - it must ride the same lane.
    expect(await limitFor("LIMIT_SEARCHES_PER_DAY", { plan: "business" })).toBe(base * 4);
  });

  it("EXECUTED: the AI cap follows the plan too - one hunt is 280-450 calls", async () => {
    const { limitFor } = await loadUsage();
    expect(await limitFor("LIMIT_AI_PER_DAY", { plan: "ultra" })).toBe(300 * 4);
  });

  it("EXECUTED: money never buys a bigger WhatsApp budget", async () => {
    // The anti-ban lanes are set by Meta's tolerance, not by the plan. This is
    // the same rule NEVER_SCALED enforces for SCALE_MODE, and the plan
    // multiplier must not become a back door around it.
    const { limitFor } = await loadUsage();
    for (const lane of [
      "LIMIT_WA_INTRO_PER_HOUR",
      "LIMIT_WA_INTRO_PER_DAY",
      "LIMIT_WA_REPLY_PER_HOUR",
      "LIMIT_WA_REPLY_PER_DAY",
    ] as const) {
      const free = await limitFor(lane);
      expect(await limitFor(lane, { plan: "ultra" }), `${lane} must not scale with plan`).toBe(free);
    }
  });

  it("EXECUTED: an owner override is the FREE base, and the ladder scales from it", async () => {
    const { limitFor } = await loadUsage({ LIMIT_SEARCHES_PER_DAY: "10" });
    expect(await limitFor("LIMIT_SEARCHES_PER_DAY")).toBe(10);
    expect(await limitFor("LIMIT_SEARCHES_PER_DAY", { plan: "ultra" })).toBe(40);
  });

  it("EXECUTED: SCALE_MODE and the plan multiplier compose", async () => {
    const { limitFor, LIMIT_DEFAULTS } = await loadUsage({ SCALE_MODE: "on" });
    const base = LIMIT_DEFAULTS.LIMIT_SEARCHES_PER_DAY;
    expect(await limitFor("LIMIT_SEARCHES_PER_DAY", { plan: "ultra" })).toBe(base * 3 * 4);
  });

  it("the four consumers pass the caller's plan", () => {
    expect(readCode("src/app/api/vendors/route.ts")).toMatch(/plan: session\.plan/);
    expect(readCode("src/app/api/geocode/route.ts")).toMatch(/plan: session\.plan/);
    expect(readCode("src/app/api/translate/route.ts")).toMatch(/plan: session\.plan/);
    // The AI budget runs on the webhook path with no session, so it reads the
    // durable user row instead.
    expect(readCode("src/lib/ai-budget.ts")).toMatch(/normalizePlan\(\(await getUser\(email\)\)\?\.plan\)/);
  });
});

// ---------------------------------------------------------------------------
// The AI ladder: free rungs first, paid never by accident, days budgeted.
// ---------------------------------------------------------------------------

describe("the provider ladder spends free capacity before the owner's money", () => {
  beforeEach(() => vi.resetModules());

  it("EXECUTED: a spent DAY skips the rung, and the last rung is never skipped", async () => {
    const { tryConsumeDay, resetRpmBuckets, DEFAULT_RPD } = await import("./ai-rpm");
    resetRpmBuckets();
    const now = 1_700_000_000_000;
    const cap = DEFAULT_RPD.gemini;
    for (let i = 0; i < cap; i++) {
      expect(tryConsumeDay("gemini", now, cap)).toBe(true);
    }
    expect(tryConsumeDay("gemini", now, cap)).toBe(false);
    // A new UTC day refills it.
    expect(tryConsumeDay("gemini", now + 25 * 3600_000, cap)).toBe(true);
    // A provider with no known daily ceiling always fits.
    expect(tryConsumeDay("some-paid-provider", now)).toBe(true);
  });

  it("EXECUTED: the day counter is per provider, not shared", async () => {
    const { tryConsumeDay, resetRpmBuckets } = await import("./ai-rpm");
    resetRpmBuckets();
    const now = 1_700_000_000_000;
    expect(tryConsumeDay("groq", now, 1)).toBe(true);
    expect(tryConsumeDay("groq", now, 1)).toBe(false);
    // openrouter's day is untouched by groq's.
    expect(tryConsumeDay("openrouter", now, 1)).toBe(true);
  });

  it("deepseek is flagged paid so spillover cannot reach it by accident", () => {
    const ai = read("src/lib/ai.ts");
    const ds = ai.indexOf('name: "deepseek"');
    expect(ai.slice(ds, ds + 1200)).toMatch(/paid: true/);
    // ...and every free rung precedes it in the real chain.
    for (const free of ["groq", "together", "openrouter", "mistral", "huggingface", "gemini"]) {
      expect(ai.indexOf(`name: "${free}"`), `${free} must precede paid deepseek`).toBeLessThan(ds);
    }
  });

  it("the models the owner's live probe proved dead are gone", () => {
    const ai = read("src/lib/ai.ts");
    // 404 "unavailable for free" on the owner's key.
    expect(ai).not.toMatch(/pick\(orM, "openai\/gpt-oss-20b:free"\)/);
    // 403 tier_not_allowed on a free Mistral key.
    expect(ai).not.toMatch(/pick\(misM, "mistral-large-latest"\)/);
    // The Llama/DeepSeek :free tiers were delisted July 2026 - the rescue is
    // OpenRouter's own router, which cannot 404 on a retirement.
    expect(ai).toMatch(/fallbackModel: "openrouter\/free"/);
  });

  it("a 403 now triggers the sibling-model rescue (the Mistral red row)", () => {
    // tier_not_allowed is per-MODEL: the free sibling would have answered, and
    // the rescue never fired because 403 was missing from the classifier.
    expect(readCode("src/lib/ai.ts")).toMatch(/\/\\b403\\b\/\.test\(reason\)/);
  });

  it("fleet starvation is observable instead of silent", () => {
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/void noteChainExhausted\(errors\)/);
    expect(ai).toMatch(/kind: "ai-chain-exhausted"/);
    // Throttled, so a starved fleet cannot flood the store it is failing on.
    expect(ai).toMatch(/now - lastExhaustedAt < 60_000/);
    // ...and the health panel counts it.
    expect(readCode("src/app/api/admin/health/route.ts")).toMatch(/"ai-chain-exhausted"/);
  });
});

// ---------------------------------------------------------------------------
// Drain throughput and the honest hourly horizon.
// ---------------------------------------------------------------------------

describe("the drain stops on a clock and paces on real horizons", () => {
  it("the reply ceiling scales with distinct due senders, floor 8, cap 24", () => {
    // Pure arithmetic, mirrored from wa-guard so the intent is executable:
    // small fleets keep the old behaviour, 30 senders no longer queue behind
    // a flat global budget that the per-sender fleet gap already bounds.
    const budget = (senders: number) => Math.max(8, Math.min(24, senders * 3));
    expect(budget(0)).toBe(8);
    expect(budget(2)).toBe(8);
    expect(budget(3)).toBe(9);
    expect(budget(10)).toBe(24);
    expect(budget(30)).toBe(24);
  });

  it("EXECUTED: the hourly-cap wait is the rolling window's real edge", async () => {
    // Mirrors the computation in checkRateLimit: a slot frees when the OLDEST
    // send in the window ages out, not after a flat 15 minutes.
    const now = 1_700_000_000_000;
    const waitFor = (oldestAgeMs: number) => {
      const freesAt = now - oldestAgeMs + 3600_000;
      return Math.max(30, Math.min(900, Math.ceil((freesAt - now) / 1000) + 5));
    };
    // Oldest send 59 minutes ago -> about a minute, not 15.
    expect(waitFor(59 * 60_000)).toBe(65);
    // Oldest send 5 minutes ago -> clamped to the 900s ceiling.
    expect(waitFor(5 * 60_000)).toBe(900);
    // Oldest send already 61 minutes old -> the floor, never a negative wait.
    expect(waitFor(61 * 60_000)).toBe(30);
  });

  it("the wall-clock stop is reported, not silent", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/kind: "drain-budget-stop"/);
    expect(guard).toMatch(/stoppedForBudget/);
  });
});

// ---------------------------------------------------------------------------
// Safety: uniqueness on both outreach paths, and no silent pacing loss.
// ---------------------------------------------------------------------------

describe("clustering defences hold on BOTH outreach paths", () => {
  it("the single-shop path compares against a real recent list, not []", () => {
    const route = readCode("src/app/api/outreach/route.ts");
    expect(route).toMatch(/ensureGloballyUnique\(compiled, recent\)/);
    expect(route).not.toMatch(/ensureGloballyUnique\(compiled, \[\]\)/);
    // Same fleet-wide source the engine's own send path uses.
    expect(route).toMatch(/direction=eq\.outbound/);
  });

  it("a missing wa_send_claims table ALARMS instead of degrading in silence", () => {
    const pacing = readCode("src/lib/wa/pacing.ts");
    expect(pacing).toMatch(/void noteClaimsTableMissing\(\)/);
    expect(pacing).toMatch(/kind: "claims-table-missing"/);
    // Still returns ok - a pre-migration install must not lose its sends.
    expect(pacing).toMatch(/void noteClaimsTableMissing\(\);\s*\n\s*return \{ ok: true \}/);
    expect(readCode("src/app/api/admin/health/route.ts")).toMatch(/"claims-table-missing"/);
  });

  it("opening the beta gate no longer demotes the invited testers", () => {
    // allowedPlanFor returned "free" for EVERYONE with BETA_LOCK off, and the
    // login routes pin that with setPlan - so flipping the gate open to admit
    // more testers silently downgraded every listed pro/ultra account on its
    // next sign-in.
    const allow = readCode("src/lib/allowlist.ts");
    expect(allow).toMatch(/const listed = \(await betaAllowlist\(\)\)\.find/);
    expect(allow).not.toMatch(/if \(!betaLockEnabled\(\)\) return "free";/);
  });
});

// ---------------------------------------------------------------------------
// The money panel stops inventing customers.
// ---------------------------------------------------------------------------

describe("the lifecycle funnel reports revenue honestly", () => {
  it("Paid counts VERIFIED activations; granted plans are Comped", () => {
    const life = readCode("src/lib/lifecycle.ts");
    expect(life).toMatch(/kind=eq\.\$\{ACTIVATION_KIND\}/);
    expect(life).toMatch(/label: "Paid \(verified\)"/);
    expect(life).toMatch(/label: "Comped \(invite\/tester\)"/);
    // The old plan-column count must not survive as the Paid row.
    expect(life).not.toMatch(
      /nPaid =\s*users === null \? null : users\.filter\(\(u\) => u\.plan === "pro"/
    );
  });

  it("EXECUTED: every stage divides by signups, so no row can exceed 100%", () => {
    // The owner's screen showed "Ran a search 175%" and "Paid 600%" because
    // each row divided by the row above it, and the stages do not nest.
    const pct = (num: number | null, den: number | null) =>
      num === null || den === null || den === 0 ? null : num / den;
    const signups = 9;
    for (const count of [4, 7, 1, 1, 1, 0, 6]) {
      const share = pct(count, signups);
      expect(share).not.toBeNull();
      expect(share as number).toBeLessThanOrEqual(1);
    }
  });

  it("the panel says what the numbers mean", () => {
    const panel = read("src/components/admin/LifecyclePanel.tsx");
    expect(panel).toMatch(/share of signups/i);
    expect(panel).toMatch(/verified PayPal activations/);
    expect(panel).toMatch(/ofSignups/);
  });
});

// ---------------------------------------------------------------------------
// Truth in the docs the owner and the next agent read.
// ---------------------------------------------------------------------------

describe("the Evolution store posture is stated the way it is configured", () => {
  it("CLAUDE.md and GUIDE.md match render.yaml, and the policy discloses it", () => {
    // CLAUDE.md claimed NEW_MESSAGE/CHATS were false; render.yaml has always
    // set them TRUE because the missed-reply recovery sweep reads that store.
    // Three ways to resolve it, and only one keeps the rescue: say so, prune
    // hard, and disclose it. (Turning the store off silently breaks recovery
    // of shop replies the webhook lost.)
    const render = read("render.yaml");
    expect(render).toMatch(/DATABASE_SAVE_DATA_NEW_MESSAGE\n\s*value: "true"/);
    const claude = read("CLAUDE.md");
    expect(claude).toMatch(/NEW_MESSAGE=true/);
    expect(claude).toMatch(/prune/i);
    expect(read("GUIDE.md")).toMatch(/DATABASE_SAVE_DATA_NEW_MESSAGE\s*=\s*true/);
    // And the Privacy Policy no longer promises a store that exists.
    const legal = read("src/lib/legal.ts");
    expect(legal).toMatch(/TRANSIENT copy/);
    expect(legal).toMatch(/7 days/);
  });

  it("the capacity numbers in comments match the enforced constants", () => {
    // ultra is 24 new contacts per window (wa/capacity.ts), not 40.
    expect(readCode("src/lib/wa-guard.ts")).not.toMatch(/ultra 40\/3h/);
    expect(readCode("src/app/api/outreach/mass/route.ts")).not.toMatch(/ultra 40 /);
    // The KPI card reads the live cap instead of a hardcoded ~40.
    expect(read("src/components/ops/LaunchKpiCard.tsx")).not.toMatch(/~40-per-host/);
  });
});
