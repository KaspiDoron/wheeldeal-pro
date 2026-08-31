// Server-side LLM provider abstraction.
//
// All keys are read from process.env and never leave the server. If no key is
// configured the app returns a deterministic mock so every flow stays fully
// functional in demo mode. Providers are tried in preference order.

import "server-only";
import { getConfig, pgTimestamp } from "./runtime-config";

// AI_RPM_<PROVIDER> override cache (~60s): the owner can raise a paid tier's
// per-minute ceiling without a deploy, and the hot path pays one vault read
// per provider per minute, not per call.
const rpmOverrideCache = new Map<string, { v: number | null; at: number }>();
import { reserveAiCall } from "./ai-budget";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProviderName =
  | "groq"
  | "openrouter"
  | "cerebras"
  | "gemini"
  | "mistral"
  | "huggingface"
  | "deepseek"
  | "together"
  | "sambanova"
  // PAID providers (owner report 5 #13): keys the owner buys tokens for. They
  // sit LAST in the default failover order (a free rung answering means no
  // bill) and FIRST when a caller asks for the premium tier (chatDetailed
  // opts.tier) - high-stakes turns get the strongest brains.
  | "openai"
  | "anthropic"
  | "kimi";

/** How a provider speaks on the wire. Everything OpenAI-shaped shares one code
 *  path; Gemini and Anthropic have their own request/response grammar. This
 *  field is what lets a new provider join WITHOUT a name-equality special case
 *  buried in the call path (the old `name === "gemini"` pattern). */
type ProviderDialect = "openai" | "gemini" | "anthropic";

interface ProviderConfig {
  name: ProviderName;
  token?: string;
  endpoint: string;
  model: string;
  // A safe secondary model on the SAME provider. If the primary model id is
  // rejected (400/404 - ids drift on free tiers), we retry once with this one
  // before failing over to the next provider. Keeps the app resilient to model
  // renames without a redeploy.
  fallbackModel?: string;
  /** Wire grammar. Absent = "openai" (the overwhelming default). */
  dialect?: ProviderDialect;
  /** The owner pays per token here - drives ordering and honest panel copy. */
  paid?: boolean;
  /** "reasoning" = OpenAI's newer models: they reject `max_tokens` (want
   *  `max_completion_tokens`) and refuse a non-default temperature. Sending
   *  the classic sampler params 400s EVERY call and burns the fallback rescue
   *  on each turn - the exact silent-tax failure the rescue telemetry exists
   *  to expose. */
  sampler?: "reasoning";
}

// Per provider call budget. A hung free-tier endpoint must fail over fast, not
// stall the whole request (this was a cause of the "provider did not respond"
// errors: no timeout meant one slow host blocked everything). Kept under 15s so
// a 2-3 provider failover chain still fits inside the route's 60s maxDuration.
const CALL_TIMEOUT_MS = 14000;

/** Every AI provider token key, in default failover order. The paid trio sits
 *  LAST by default - a free rung that answers means no bill - and is hoisted
 *  to the FRONT for premium-tier callers (see chatDetailed opts.tier). */
export const PROVIDER_NAMES: ProviderName[] = [
  // FREE RUNGS FIRST, cheapest-failure first. sambanova sits at the back of
  // the free block (its free tier answered 429 on both pools in the owner's
  // live probe) and deepseek left the free block entirely - it spends the
  // owner's pay-as-you-go balance, so it belongs with the paid providers, not
  // second in line ahead of five free rungs. See the allProviders() blocks.
  "groq",
  "together",
  "openrouter",
  "mistral",
  "huggingface",
  "gemini",
  "sambanova",
  "cerebras",
  // Paid balances: deepseek's is the owner's, the trio below are per-token.
  "deepseek",
  "anthropic",
  "openai",
  "kimi",
];

async function allProviders(): Promise<ProviderConfig[]> {
  const [groq, openrouter, cerebras, gemini, mistral, huggingface, deepseek, together, sambanova, openai, anthropic, kimi] =
    await Promise.all([
      getConfig("GROQ_TOKEN"),
      getConfig("OPENROUTER_TOKEN"),
      getConfig("CEREBRAS_TOKEN"),
      getConfig("GEMINI_TOKEN"),
      getConfig("MISTRAL_TOKEN"),
      getConfig("HUGGINGFACE_TOKEN"),
      getConfig("DEEPSEEK_TOKEN"),
      getConfig("TOGETHER_TOKEN"),
      getConfig("SAMBANOVA_TOKEN"),
      getConfig("OPENAI_TOKEN"),
      getConfig("ANTHROPIC_TOKEN"),
      getConfig("KIMI_TOKEN"),
    ]);
  // Optional per-provider MODEL override (vault/env `<PROVIDER>_MODEL`). Free-tier
  // model ids drift constantly - a rename 404s the whole provider. This lets the
  // owner pin or upgrade any provider's model LIVE from Admin -> Keys with no
  // redeploy (paste e.g. `CEREBRAS_MODEL = qwen-3-235b-a22b-instruct-2507`).
  // Blank -> the strong default below. The fallbackModel still covers a bad id.
  const [groqM, orM, cerM, gemM, misM, hfM, dsM, togM, sambaM, oaiM, antM, kimiM] = await Promise.all([
    getConfig("GROQ_MODEL"),
    getConfig("OPENROUTER_MODEL"),
    getConfig("CEREBRAS_MODEL"),
    getConfig("GEMINI_MODEL"),
    getConfig("MISTRAL_MODEL"),
    getConfig("HUGGINGFACE_MODEL"),
    getConfig("DEEPSEEK_MODEL"),
    getConfig("TOGETHER_MODEL"),
    getConfig("SAMBANOVA_MODEL"),
    getConfig("OPENAI_MODEL"),
    getConfig("ANTHROPIC_MODEL"),
    getConfig("KIMI_MODEL"),
  ]);
  const pick = (override: string | undefined, def: string) =>
    (override && override.trim()) || def;

  // Every provider runs a TOP-TIER model (70B+/frontier), so whichever key the
  // owner has, the agents get a strong brain. Order = default failover priority
  // (fastest + steadiest free tiers first). All are OpenAI-compatible except
  // Gemini, which the chat() path special-cases.
  return [
    {
      name: "groq",
      token: groq,
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      // Groq deprecated kimi-k2 (2026-03) AND llama-3.3-70b-versatile for
      // free/dev tiers (2026-06) - both 404 now. gpt-oss-120b is Groq's own
      // recommended migration target (console.groq.com/docs/deprecations).
      model: pick(groqM, "openai/gpt-oss-120b"),
      fallbackModel: "openai/gpt-oss-20b",
    },
    {
      name: "together",
      token: together,
      endpoint: "https://api.together.xyz/v1/chat/completions",
      model: pick(togM, "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free"),
      // The old 3.1-8B-Turbo fallback is a PAID endpoint - useless as a
      // rescue for a free-tier key. R1-Distill-70B-free is the free sibling.
      fallbackModel: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
    },
    {
      name: "openrouter",
      token: openrouter,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      // The :free roster churns weekly - if this 404s paste a current id
      // from openrouter.ai/collections/free-models as OPENROUTER_MODEL.
      // gpt-oss-20b:free was delisted (owner's live test 2026-08-31: 404
      // "unavailable for free"); gemma-4-31b-it:free answered 429 on the same
      // test - rate-limited but ALIVE - so the proven-live id leads.
      //
      // The rescue is `openrouter/free`, OpenRouter's own free-model ROUTER
      // rather than another pinned slug: it selects whatever free model is
      // actually being served, so it cannot 404 on a retirement and cannot
      // drown in one model's pool - the exact two ways this row has failed
      // live. (The Llama and DeepSeek :free tiers were themselves delisted in
      // July 2026, so pinning either would repeat the bug.)
      model: pick(orM, "google/gemma-4-31b-it:free"),
      fallbackModel: "openrouter/free",
    },
    {
      name: "mistral",
      token: mistral,
      endpoint: "https://api.mistral.ai/v1/chat/completions",
      // small-latest LEADS: the owner's live test (2026-08-31) showed
      // mistral-large-latest 403s a FREE-tier key with tier_not_allowed
      // (code 1910) - Large moved behind the paid tier, so leading with it
      // burned a guaranteed failed round trip on every call. small-latest is
      // free-tier-safe and plenty for this chain's role; open-mistral-nemo
      // is the free legacy rescue. A paid key can restore Large via the
      // MISTRAL_MODEL vault override.
      model: pick(misM, "mistral-small-latest"),
      fallbackModel: "open-mistral-nemo",
    },
    {
      name: "huggingface",
      token: huggingface,
      endpoint: "https://router.huggingface.co/v1/chat/completions",
      model: pick(hfM, "meta-llama/Llama-3.3-70B-Instruct"),
      fallbackModel: "openai/gpt-oss-120b",
    },
    {
      name: "gemini",
      token: gemini,
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      // THE ROLLING ALIAS LEADS (owner's live Test AI providers, 2026-08-21):
      // the pinned gemini-3.5-flash id FAILED on the owner's key while the
      // alias answered - a pin is exactly the thing Google retires under
      // you, and every call was paying a failed round trip before the
      // rescue. gemini-flash-latest always names the current GA flash (free
      // tier); the lite alias is the lighter sibling rescue.
      // LITE LEADS (owner's live test, 2026-08-31): gemini-flash-latest took
      // >6s to first token on the owner's key and timed out its share of the
      // probe while the lite alias answered. Gemini is the DEEPEST free rung -
      // by the time the chain reaches it, most of the turn's budget is spent -
      // so the fast sibling belongs in front and the heavyweight is the
      // rescue, not the other way round.
      model: pick(gemM, "gemini-flash-lite-latest"),
      fallbackModel: GEMINI_MODEL,
      dialect: "gemini",
    },
    {
      name: "sambanova",
      token: sambanova,
      endpoint: "https://api.sambanova.ai/v1/chat/completions",
      // DEMOTED TO THE BACK OF THE FREE CHAIN (W-beta30). The owner's live
      // probe answered 429 rate_limit_exceeded on BOTH the primary and the
      // rescue - the free tier is simply at capacity, which no code change
      // can turn green. Two dead round trips at ladder position 4 ate a
      // third of SPTE's 9s reply budget before a working rung was tried; at
      // the back it costs nothing when saturated and still earns its keep
      // the moment capacity frees up (and on long-budget callers: distill,
      // admin sweeps).
      // gpt-oss-120b leads (SambaCloud's flagship with dedicated capacity).
      // The rescue is the 70B pool - SambaNova's own designated replacement
      // after it removed the whole Llama-3.1-8B line (March 2026). The owner's
      // live probe caught the previous 8B rescue returning 410 GONE on every
      // call: a rescue rung must be a model the provider still SERVES, and
      // 3.3-70B is the one SambaNova routes retired-model traffic to.
      model: pick(sambaM, "gpt-oss-120b"),
      fallbackModel: "Meta-Llama-3.3-70B-Instruct",
    },
    {
      name: "deepseek",
      token: deepseek,
      endpoint: "https://api.deepseek.com/chat/completions",
      // deepseek-chat was retired: the API now requires deepseek-v4-pro (top
      // tier) or deepseek-v4-flash (the fast fallback).
      //
      // PAID, AND ORDERED LIKE IT (W-beta30). This rung spends the OWNER'S
      // pay-as-you-go balance - it sat SECOND in the chain, so the moment
      // groq's 30 RPM minute was spent, the entire fleet's spillover silently
      // billed the owner before any of the five free rungs was tried, and an
      // emptied balance then 402-doubled every call. It now sits BEHIND the
      // free rungs; `paid: true` also lets tier:"premium" callers (the
      // distillation teacher) hoist it deliberately.
      model: pick(dsM, "deepseek-v4-pro"),
      fallbackModel: "deepseek-v4-flash",
      paid: true,
    },
    // DEMOTED TO THE FREE-TIER TAIL: Cerebras retired its open free tier in
    // July 2026 (one-time $5 trial, then 402 "payment required" on every
    // model - account-level, so no model id fixes it). With a spent trial
    // every attempt is a guaranteed failed round trip; it sits last so the
    // working free providers answer first. The row stays correct if the
    // owner ever adds billing. NO fallbackModel, deliberately: the roster
    // collapsed to essentially gpt-oss-120b (the old llama3.1-8b rescue
    // 404s - the owner's live probe paid for BOTH dead calls), and a 402
    // is account-level anyway, so a second id can never rescue it.
    {
      name: "cerebras",
      token: cerebras,
      endpoint: "https://api.cerebras.ai/v1/chat/completions",
      model: pick(cerM, "gpt-oss-120b"),
    },
    // ---- PAID providers (owner report 5 #13) --------------------------------
    // The owner buys tokens here for the turns that decide money: the premium
    // tier (chatDetailed opts.tier) runs these FIRST; the default chain runs
    // them LAST so routine turns never bill when a free rung answers.
    {
      name: "anthropic",
      token: anthropic,
      // Anthropic is NOT OpenAI-compatible: native /v1/messages, x-api-key
      // auth, top-level system, usage.input_tokens/output_tokens.
      endpoint: "https://api.anthropic.com/v1/messages",
      // claude-sonnet-5: the balanced tier ($2/$10 per Mtok intro until
      // 2026-08-31, then $3/$15). Haiku 4.5 is the cheap rescue.
      model: pick(antM, "claude-sonnet-5"),
      fallbackModel: "claude-haiku-4-5-20251001",
      dialect: "anthropic",
      paid: true,
    },
    {
      name: "openai",
      token: openai,
      endpoint: "https://api.openai.com/v1/chat/completions",
      // gpt-5.6-terra is the mid tier ($2/$12 per Mtok); luna the cheap rescue.
      // The flagship (gpt-5.6-sol) needs /v1/responses for tool calls - we use
      // none on this path, so chat/completions with terra is the right default.
      model: pick(oaiM, "gpt-5.6-terra"),
      fallbackModel: "gpt-5.6-luna",
      dialect: "openai",
      paid: true,
      // Newer OpenAI models reject max_tokens + non-default temperature.
      sampler: "reasoning",
    },
    {
      name: "kimi",
      token: kimi,
      // Moonshot is genuinely OpenAI-compatible on the wire (temperature 0.6
      // sits inside its [0,1] range, so no sampler quirk needed).
      endpoint: "https://api.moonshot.ai/v1/chat/completions",
      // kimi-k3: flagship, 1M context, native vision ($3 in/$15 out per Mtok).
      model: pick(kimiM, "kimi-k3"),
      fallbackModel: "kimi-k2.6",
      dialect: "openai",
      paid: true,
    },
  ];
}

// ---- free-tier reset cadence (documented estimates, NOT an API contract) -----
// Providers change these without notice and rarely expose the live allowance, so
// this drives the "resets daily/monthly" label + the used-this-cycle window only.
// Where a provider DOES expose a live figure (OpenRouter $, DeepSeek balance),
// aiStatus fetches it and that is authoritative.
type Cadence = "day" | "month" | "none";
const PROVIDER_META: Record<ProviderName, { cadence: Cadence; note: string }> = {
  groq: { cadence: "day", note: "Free tier resets DAILY (per-day token + request caps)." },
  cerebras: { cadence: "day", note: "Free tier resets DAILY (per-day token cap)." },
  gemini: { cadence: "day", note: "Free tier resets DAILY (requests-per-day), ~midnight PT." },
  openrouter: { cadence: "day", note: "Free models cap requests-per-DAY; $ credit shown live." },
  sambanova: { cadence: "day", note: "Free tier resets DAILY (per-day + per-minute caps)." },
  mistral: { cadence: "month", note: "Free tier is a MONTHLY token allowance." },
  huggingface: { cadence: "month", note: "Router credits reset MONTHLY." },
  together: { cadence: "none", note: "One-time free credit; free models are per-minute rate-limited." },
  deepseek: { cadence: "none", note: "Pay-as-you-go balance (shown live); no free reset." },
  // PAID tiers: no free reset to describe - the honest label is the bill.
  openai: { cadence: "none", note: "PAID per token (no free reset) - runs first on premium-tier turns." },
  anthropic: {
    cadence: "none",
    note: "PAID per token (no free reset) - Sonnet intro pricing ends 2026-08-31.",
  },
  kimi: { cadence: "none", note: "PAID per token (no free reset) - runs first on premium-tier turns." },
};

/** Start of the current cadence window as an ISO instant (UTC). */
function cycleStart(cadence: Cadence): Date | null {
  if (cadence === "none") return null;
  const n = new Date();
  return cadence === "day"
    ? new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
    : new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
}

/** Tokens we have spent per provider within THIS provider's reset window. */
async function cycleUsage(): Promise<{ byProvider: Record<string, number>; unreadable: boolean }> {
  const out: Record<string, number> = {};
  try {
    const { sbSelectDark } = await import("./runtime-config");
    // One query over the widest window (a month), then bucket per provider by
    // its own cadence. Cheap enough for an admin-only panel.
    const monthStart = cycleStart("month")!;
    // "0 TOKENS USED THIS CYCLE" IS THE MOST DANGEROUS NUMBER ON THIS PANEL.
    //
    // It reads as headroom. The owner uses it to decide whether a free tier is
    // about to run out, and the permissive reader returned [] for a missing
    // connection, a non-2xx and a thrown exception alike - so a Supabase outage
    // rendered every provider at zero spend with a full allowance remaining,
    // right when nothing could be verified. `null` is now reachable and the
    // caller renders it as unknown rather than as room to spend.
    const rows = await sbSelectDark<{ provider: string; tokens: number; created_at: string }>(
      "ai_usage",
      `select=provider,tokens,created_at&created_at=gte.${pgTimestamp(monthStart)}&limit=100000`
    );
    if (rows === null) return { byProvider: out, unreadable: true };
    const dayStartMs = cycleStart("day")!.getTime();
    const monthStartMs = monthStart.getTime();
    for (const r of rows) {
      const meta = PROVIDER_META[r.provider as ProviderName];
      if (!meta || meta.cadence === "none") continue;
      const boundary = meta.cadence === "day" ? dayStartMs : monthStartMs;
      if (Date.parse(r.created_at) >= boundary) {
        out[r.provider] = (out[r.provider] ?? 0) + (Number(r.tokens) || 0);
      }
    }
  } catch {
    // A throw is also "we do not know" - the in-memory "used here" counters
    // still render, but the cycle total must not claim zero.
    return { byProvider: out, unreadable: true };
  }
  return { byProvider: out, unreadable: false };
}

// Current Gemini model used by every Gemini call (chat + vision).
// gemini-2.5-flash is scheduled for retirement 2026-10-16; 3.5-flash is the
// GA successor on the free tier. This const also seeds the vision ladder.
// THE ROLLING ALIAS, not a pin. gemini-3.5-flash - the pinned GA id this
// used to be - failed live on the owner's key (Test AI providers,
// 2026-08-21) while the alias answered; Google retires pins under you, and
// a failed pinned primary taxes every call with a wasted round trip before
// the rescue. The alias always names the current free-tier GA flash.
export const GEMINI_MODEL = "gemini-flash-latest";

/** Configured providers, preferred one first (automatic failover order). */
async function providers(): Promise<ProviderConfig[]> {
  const all = await allProviders();
  const preferred = ((await getConfig("AI_PROVIDER")) || "").toLowerCase();
  const withKeys = all.filter((p) => p.token);
  withKeys.sort((a, b) =>
    a.name === preferred ? -1 : b.name === preferred ? 1 : 0
  );
  return withKeys;
}

/** True when at least one real provider key is configured. */
export async function aiEnabled(): Promise<boolean> {
  return (await providers()).length > 0;
}

/** The names of the providers that actually have a key, in the order they
 *  would be tried. Cheap (no network) - the deploy self-check reports it so a
 *  key-less deployment is visible rather than inferred from blunt replies. */
export async function configuredProviders(): Promise<ProviderName[]> {
  return (await providers()).map((p) => p.name);
}

// ---- usage accounting (per provider, per instance + durable log) ------------

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_ai_usage__:
    | Record<string, { requests: number; tokens: number; failures: number }>
    | undefined;
}

function usageStore() {
  if (!globalThis.__wheeldeal_ai_usage__) globalThis.__wheeldeal_ai_usage__ = {};
  return globalThis.__wheeldeal_ai_usage__;
}

/**
 * @param model  The model id actually SENT, not the configured default -
 *               `callProvider` silently retries on `fallbackModel` for a
 *               400/404, so those are two different facts.
 * @param detail Trimmed provider error (status + body, key-free) on a failure.
 */
/**
 * One durable breadcrumb when the WHOLE ladder refuses (W-beta30).
 *
 * Throttled to one row per minute per instance: a starved fleet fails every
 * turn, and the point is a visible signal, not a second flood on a database
 * already having a bad minute. Best-effort like every other telemetry write
 * here - it must never turn a degraded turn into a failed one.
 */
let lastExhaustedAt = 0;
async function noteChainExhausted(errors: string[]): Promise<void> {
  const now = Date.now();
  if (now - lastExhaustedAt < 60_000) return;
  lastExhaustedAt = now;
  try {
    const { sbInsert } = await import("./runtime-config");
    await sbInsert("agent_events", [
      {
        kind: "ai-chain-exhausted",
        detail: JSON.stringify({
          // The last few refusals name WHICH rungs and WHY (spent minute,
          // spent day, dead key), which is the difference between "add a key"
          // and "raise a budget".
          reasons: errors.slice(-6).map((e) => String(e).slice(0, 160)),
          at: new Date(now).toISOString(),
        }).slice(0, 2000),
      },
    ]);
  } catch {
    /* a breadcrumb is never worth an exception on the degraded path */
  }
}

async function recordUsage(
  provider: string,
  tokens: number,
  failed = false,
  model?: string,
  detail?: string
) {
  const s = usageStore();
  if (!s[provider]) s[provider] = { requests: 0, tokens: 0, failures: 0 };
  s[provider].requests += 1;
  s[provider].tokens += tokens;
  if (failed) s[provider].failures += 1;
  const { sbInsert } = await import("./runtime-config");
  // AWAITED, WHICH IS WHY THE PROVIDERS PAGE READ ZERO.
  //
  // This insert was started and not awaited. On Cloud Run the CPU is throttled
  // to ~0 the instant the response flushes, so a detached insert stops wherever
  // it happens to be and the row never lands - which is exactly why every brain
  // showed "0 tokens / 0 calls" no matter how heavily the app was used.
  //
  // Deliberately NOT wrapped in finishBeforeResponse: recordUsage is called
  // from the GCE worker loop as well as from Cloud Run request paths, and the
  // budget race there would add latency inside the provider failover chain on
  // every LLM call while cancelling nothing.
  // I-7: THE ANSWER TO "WHY" WAS BEING THROWN AWAY.
  //
  // `errorDetail` already builds a trimmed, key-free `<provider> <status> -
  // <body>` string, and `chatDetailed` catches it, pushes it onto a local
  // array and returns only the LAST one. So the Command Center could say
  // Cerebras failed 14 times out of 14 and nothing anywhere could say it was
  // a 400 on a model id the provider had renamed - which is the leading
  // hypothesis and was untestable without a redeploy that added logging.
  //
  // The model id rides along for the same reason: with `CEREBRAS_MODEL` now
  // settable, "which id actually went on the wire" stops being inferable from
  // the code and has to be recorded.
  await sbInsert("ai_usage", [
    { provider, tokens, failed, model: model ?? null, detail: detail ? detail.slice(0, 300) : null },
  ]).catch(() => false);
}

/**
 * The most recent failure per provider - what the provider actually SAID.
 *
 * I-7's first instruction was "read the recorded error", and there was no
 * recorded error to read: the reason was caught into a local array and
 * discarded. One query, newest first, keeping the first row seen per provider,
 * so this stays O(1) round trips however many providers exist.
 *
 * Permissive read on purpose. This is diagnostics beside a live status page,
 * not a safety gate - an unreadable table means "no failure to show", which
 * degrades to exactly what the page showed before this existed.
 */
async function lastFailures(): Promise<
  Record<string, { at: string; model: string | null; detail: string | null }>
> {
  const { sbSelect } = await import("./runtime-config");
  const rows = await sbSelect<{
    provider: string;
    model: string | null;
    detail: string | null;
    created_at: string;
  }>(
    "ai_usage",
    "select=provider,model,detail,created_at&failed=is.true&order=created_at.desc&limit=200"
  );
  const out: Record<string, { at: string; model: string | null; detail: string | null }> = {};
  for (const r of rows) {
    if (!out[r.provider]) out[r.provider] = { at: r.created_at, model: r.model, detail: r.detail };
  }
  return out;
}

/** Live status of every AI provider: configured, our usage, remote quota. */
export async function aiStatus() {
  const list = await allProviders();
  const preferred = ((await getConfig("AI_PROVIDER")) || "").toLowerCase();
  const s = usageStore();
  const { byProvider: cyc, unreadable: cycUnreadable } = await cycleUsage();
  const fails = await lastFailures();

  return Promise.all(
    list.map(async (p) => {
      let remaining: string | null = null;
      // OpenRouter exposes a clean $-quota endpoint.
      if (p.name === "openrouter" && p.token) {
        try {
          const res = await fetch("https://openrouter.ai/api/v1/key", {
            headers: { Authorization: `Bearer ${p.token}` },
            cache: "no-store",
          });
          const d = await res.json();
          if (res.ok && d?.data) {
            const used = d.data.usage ?? 0;
            const limit = d.data.limit;
            remaining =
              limit === null || limit === undefined
                ? `$${Number(used).toFixed(4)} used (no hard limit)`
                : `$${(limit - used).toFixed(2)} of $${limit} left`;
          }
        } catch {
          /* leave unknown */
        }
      }
      // DeepSeek exposes a live balance endpoint.
      if (p.name === "deepseek" && p.token) {
        try {
          const res = await fetch("https://api.deepseek.com/user/balance", {
            headers: { Authorization: `Bearer ${p.token}` },
            cache: "no-store",
          });
          const d = await res.json();
          const b = d?.balance_infos?.[0];
          if (res.ok && b) remaining = `${b.total_balance} ${b.currency} balance`;
        } catch {
          /* leave unknown */
        }
      }
      const meta = PROVIDER_META[p.name];
      return {
        name: p.name,
        model: p.model,
        configured: Boolean(p.token),
        preferred: p.name === preferred,
        requests: s[p.name]?.requests ?? 0,
        tokensUsed: s[p.name]?.tokens ?? 0,
        failures: s[p.name]?.failures ?? 0,
        remaining, // null = the provider does not expose remaining quota
        // Free-tier cycle: OUR measured spend this window + the documented reset.
        // null = the usage table could not be read. NOT zero: a zero here reads
        // as "plenty of allowance left", which is the opposite of the truth
        // when we cannot see the ledger at all.
        usedThisCycle: cycUnreadable ? null : (cyc[p.name] ?? 0),
        cadence: meta.cadence, // "day" | "month" | "none"
        cadenceNote: meta.note,
        // WHAT THE PROVIDER SAID, not just how often it said no. A drifted
        // model id answering 400 is the leading hypothesis for I-7's
        // "0 tokens / 14 calls / 14 failovers", and it is unfalsifiable
        // without this. `model` is the id that actually went on the wire.
        lastFailure: fails[p.name] ?? null,
      };
    })
  );
}

/**
 * The EXACT endpoint + model the app will use for a provider token key, so the
 * admin "Test API" button probes what production actually runs (respecting any
 * `<PROVIDER>_MODEL` override) instead of a separately-hardcoded id that drifts.
 * Returns null for non-AI keys.
 */
export async function aiProviderTestTarget(
  tokenKey: string
): Promise<{
  endpoint: string;
  model: string;
  gemini: boolean;
  dialect: ProviderDialect;
  sampler?: "reasoning";
} | null> {
  const byKey: Record<string, ProviderName> = {
    GROQ_TOKEN: "groq",
    OPENROUTER_TOKEN: "openrouter",
    CEREBRAS_TOKEN: "cerebras",
    GEMINI_TOKEN: "gemini",
    MISTRAL_TOKEN: "mistral",
    HUGGINGFACE_TOKEN: "huggingface",
    DEEPSEEK_TOKEN: "deepseek",
    TOGETHER_TOKEN: "together",
    SAMBANOVA_TOKEN: "sambanova",
    OPENAI_TOKEN: "openai",
    ANTHROPIC_TOKEN: "anthropic",
    KIMI_TOKEN: "kimi",
  };
  const name = byKey[tokenKey];
  if (!name) return null;
  const p = (await allProviders()).find((x) => x.name === name);
  return p
    ? {
        endpoint: p.endpoint,
        model: p.model,
        gemini: p.name === "gemini",
        // The test button must speak the provider's real grammar - a missing
        // dialect branch silently fell through to "No test available".
        dialect: p.dialect ?? "openai",
        sampler: p.sampler,
      }
    : null;
}

/**
 * THE VISION RUNG A `*_VISION_MODEL` KEY ACTUALLY SELECTS (Wave 7).
 *
 * The three vision overrides were settable and UNTESTABLE: Admin -> Keys drew
 * a "Test API" button next to each and it fell through to "No test available
 * for this key". So the one class of failure the owner cannot see coming - a
 * provider retiring a multimodal id, which is why these keys exist at all -
 * was also the one the panel could not check.
 *
 * Returns the token and the exact model id the ladder would try FIRST for that
 * provider, so the test exercises what production would run rather than a
 * hard-coded guess (the same mistake `aiProviderTestTarget` exists to prevent
 * on the text side).
 */
export async function visionProviderTestTarget(configKey: string): Promise<{
  provider: "gemini" | "groq" | "anthropic";
  model: string;
  token: string | null;
  tokenKey: string;
} | null> {
  const byKey: Record<string, { provider: "gemini" | "groq" | "anthropic"; tokenKey: string }> = {
    GEMINI_VISION_MODEL: { provider: "gemini", tokenKey: "GEMINI_TOKEN" },
    GROQ_VISION_MODEL: { provider: "groq", tokenKey: "GROQ_TOKEN" },
    ANTHROPIC_VISION_MODEL: { provider: "anthropic", tokenKey: "ANTHROPIC_TOKEN" },
  };
  const meta = byKey[configKey];
  if (!meta) return null;
  const ladders = await visionLadders();
  const token = (await getConfig(meta.tokenKey))?.trim() ?? null;
  return {
    provider: meta.provider,
    model: ladders[meta.provider][0],
    token: token || null,
    tokenKey: meta.tokenKey,
  };
}

/** fetch with a hard timeout so one slow provider cannot stall the request. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Trim a provider error body to a short, safe diagnostic (never leaks the key).
async function errorDetail(res: Response, name: string): Promise<string> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  let msg = body.replace(/\s+/g, " ").trim();
  // An HTML error page is the provider's EDGE talking (HuggingFace's Hub
  // limiter 429s with a full branded page before the request ever reaches
  // the API). Dumping 300 chars of markup into the admin panel buries the
  // one fact that matters - the status - under angle-bracket noise, so it
  // becomes a short honest note instead. The `name status` prefix survives,
  // which is what providerFailureKind classifies on (429 -> busy).
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html") || /^\s*<(!doctype|html)/i.test(msg)) {
    msg = "HTML error page from the provider's edge - blocked before reaching the API";
  }
  return `${name} ${res.status}${msg ? ` - ${msg}` : ""}`;
}

// A platform abort surfaces as the bare "This operation was aborted" - no
// provider name, no status, nothing a panel or a rescue gate can key on. Every
// text-completion fetch goes through here so a timeout is always reported as
// WHOSE timeout it was and how long the budget actually was.
async function fetchNamed(
  name: string,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  try {
    return await fetchWithTimeout(url, init, timeoutMs);
  } catch (e) {
    const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
    if (/abort/i.test(m)) {
      throw new Error(`${name} timed out after ${timeoutMs}ms (no response)`);
    }
    throw e;
  }
}

async function callOpenAICompatible(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<{ text: string; tokens: number }> {
  // OpenAI's newer (reasoning) models reject the classic sampler params:
  // `max_tokens` must be `max_completion_tokens` and temperature must stay at
  // its default. Sending the old shape 400s EVERY call, which silently burns
  // the fallback rescue on every single turn - the exact permanent-double-call
  // tax the rescue telemetry exists to expose.
  const sampler =
    cfg.sampler === "reasoning"
      ? { max_completion_tokens: maxTokens }
      : { temperature: 0.6, max_tokens: maxTokens };
  const res = await fetchNamed(cfg.name, cfg.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...sampler,
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(await errorDetail(res, cfg.name));
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? "",
    tokens: data.usage?.total_tokens ?? 0,
  };
}

/**
 * Anthropic's native /v1/messages - NOT OpenAI-compatible. Verified shape:
 * `x-api-key` auth (not Bearer), a required `anthropic-version` header, the
 * system prompt as a TOP-LEVEL field (a "system" role in messages is a 400),
 * and usage split into input_tokens/output_tokens.
 */
async function callAnthropic(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<{ text: string; tokens: number }> {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  const res = await fetchNamed(cfg.name, cfg.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.token ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.6,
      ...(system ? { system } : {}),
      // /v1/messages requires at least one user turn.
      messages: turns.length ? turns : [{ role: "user", content: "" }],
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(await errorDetail(res, cfg.name));
  const data = await res.json();
  const text = Array.isArray(data.content)
    ? data.content
        .map((b: { type?: string; text?: string }) => (b?.type === "text" ? b.text ?? "" : ""))
        .join("")
        .trim()
    : "";
  return {
    text,
    tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
  };
}

async function callGemini(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<{ text: string; tokens: number }> {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const endpoint = cfg.endpoint.replace(/models\/[^:]+:/, `models/${model}:`);
  const res = await fetchNamed("gemini", `${endpoint}?key=${cfg.token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: { temperature: 0.6, maxOutputTokens: maxTokens },
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(await errorDetail(res, "gemini"));
  const data = await res.json();
  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "",
    tokens: data.usageMetadata?.totalTokenCount ?? 0,
  };
}

// One provider attempt: primary model, then its fallback model on a model-id
// error (400/404). Returns text or throws with a readable reason.
async function callProvider(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  maxTokens: number,
  timeoutMs = CALL_TIMEOUT_MS
  // `model` is the id that actually ANSWERED. The fallback retry below means
  // the configured id and the served id are two different facts, and the
  // telemetry is worthless if it records the one we hoped for.
  // `primaryFailure` is WHY the primary lost, kept only on a successful
  // rescue: without it, "the fallback answered" was one undifferentiated
  // amber - a busy pool at peak (nothing to fix) and a retired id (fix it
  // now) rendered as the same nagging note.
): Promise<{ text: string; tokens: number; model: string; primaryFailure?: string }> {
  // `timeoutMs` is a DEADLINE for the whole provider attempt, primary and
  // fallback together - not a per-call duration. Duplicating the full budget
  // on the rescue used to let one provider spend 2x its share of the caller's
  // chain budget (spte runs the reply path at 9s total), and it also meant a
  // HUNG primary consumed everything, so a timeout-rescue could never fire.
  // With a fallback available the primary may spend at most ~60%.
  const deadline = Date.now() + timeoutMs;
  const primaryMs = cfg.fallbackModel
    ? Math.max(2_000, Math.round(timeoutMs * 0.6))
    : timeoutMs;
  // Dispatch on the DIALECT, not on a name equality - a new provider joins by
  // declaring how it speaks, never by another special case buried here.
  const run = async (model: string, ms: number) => ({
    ...(cfg.dialect === "gemini"
      ? await callGemini(cfg, messages, model, maxTokens, ms)
      : cfg.dialect === "anthropic"
        ? await callAnthropic(cfg, messages, model, maxTokens, ms)
        : await callOpenAICompatible(cfg, messages, model, maxTokens, ms)),
    model,
  });
  try {
    return await run(cfg.model, primaryMs);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // 400/404: the id is wrong or renamed. 429: THIS model's pool is
    // congested - SambaNova and OpenRouter throttle PER MODEL, so the
    // sibling fallback id on the same key routinely answers immediately
    // while the popular primary is drowning. A TIMEOUT is the same
    // congestion signal wearing a different mask (SambaNova queues free-tier
    // requests until the socket budget expires), so it earns the same
    // rescue - visionFailureFromThrown is the classifier the vision ladder
    // already trusts for exactly this call. Either way the fallback id is
    // the right next move; a provider-wide quota 429 just fails a second
    // cheap call and the cross-provider failover chain moves on as before.
    const modelIssue =
      /\b(400|404|429)\b/.test(reason) ||
      // 403 is PER-MODEL too, and its absence here is why the Mistral row
      // went red on the owner's live test instead of rescuing itself: a free
      // key calling a tier-gated flagship gets `403 tier_not_allowed` (code
      // 1910), the sibling small model is free and would have answered - and
      // the rescue never fired because 403 was not in this set. An
      // ACCOUNT-level 403 (a dead or revoked key) simply fails the second
      // cheap call and the cross-provider chain moves on, the same shrug the
      // 402 branch below takes.
      /\b403\b/.test(reason) ||
      // 402 "payment required" can arrive PER MODEL (a flagship moved behind
      // a paid plan while a smaller sibling stays free) - there the free
      // fallback id is exactly the right next move. When it is ACCOUNT-level
      // instead (Cerebras retired its open free tier July 2026; a spent $5
      // trial 402s everything), the second call just fails fast and the
      // cross-provider chain moves on - the same shrug as the quota-429 case.
      /\b402\b/.test(reason) ||
      // Anthropic reports overload as 529, per model pool - the cheaper
      // sibling (Haiku) routinely answers while the primary is drowning,
      // exactly the SambaNova per-model-429 pattern with a different number.
      /\b529\b/.test(reason) ||
      visionFailureFromThrown(e) === "timeout";
    if (cfg.fallbackModel && modelIssue) {
      // A SUCCESSFUL RESCUE HID THE THING THAT NEEDED FIXING.
      //
      // When the fallback works, the primary's error was discarded entirely:
      // nothing recorded it, no counter moved, no admin surface changed. So a
      // configured model id the provider had RENAMED - which is the ordinary
      // way this breaks, not an exotic one - stayed broken forever while
      // DOUBLING every single LLM call: two HTTP round trips and two latencies
      // on every turn, permanently, invisibly. The retry was designed as a
      // safety net and had quietly become the steady state.
      //
      // Record it as a non-fatal failure. `recordUsage` already carries the
      // model and a trimmed, key-free reason, and the Providers panel already
      // renders `lastFailure` - so the drifted id becomes visible on a screen
      // the owner already reads, with no new surface to build.
      //
      // Awaited, not detached: on Cloud Run a detached insert dies at the
      // response boundary, which is the reason this telemetry read zero for
      // months in the first place.
      await recordUsage(cfg.name, 0, true, cfg.model, `primary model failed, fell back: ${reason}`)
        .catch(() => {});
      try {
        // The rescue gets whatever the deadline has left (a fast-failing
        // primary leaves nearly everything; a hung one leaves its reserved
        // ~40%), never a duplicated budget.
        const rescued = await run(cfg.fallbackModel, Math.max(2_000, deadline - Date.now()));
        return { ...rescued, primaryFailure: reason };
      } catch (e2) {
        // BOTH ids failed. Reporting only one of the two errors made the
        // live panel ambiguous: a red card naming the primary's error reads
        // as "the fallback was never tried" when it was tried and also
        // refused. Name both attempts, each with its own model id.
        const r2 = e2 instanceof Error ? e2.message : String(e2);
        // Bound each half so the second one survives downstream truncation.
        throw new Error(
          `primary ${cfg.model}: ${reason.slice(0, 220)} | fallback ${cfg.fallbackModel}: ${r2.slice(0, 220)}`
        );
      }
    }
    throw e;
  }
}

// ---- test ALL providers in one sweep (Admin -> AI providers) ----------------
//
// The per-key test (key-test route) exercises one provider at a time; this
// fires a tiny real completion at EVERY configured provider concurrently and
// reports which MODEL actually answered - primary or fallback - so a drifted
// model id shows up as "answered by the fallback" instead of hiding behind a
// successful rescue. Failures return the provider's own trimmed error.
export interface ProviderTestResult {
  name: ProviderName;
  configured: boolean;
  ok: boolean;
  /** The model that actually ANSWERED (fallback if the primary 404'd). */
  model?: string;
  /** The configured primary - when ok && model !== configuredModel, the
   *  primary id is drifted and should be fixed or overridden in the vault. */
  configuredModel?: string;
  ms?: number;
  detail?: string;
  /** WHY the primary lost when the fallback answered (ok && drifted). The
   *  panel classifies this: a busy pool reads calm, a dead id reads fix-me. */
  primaryDetail?: string;
}

export async function testAllProviders(): Promise<ProviderTestResult[]> {
  const providers = await allProviders();
  const probe: ChatMessage[] = [
    { role: "user", content: "Reply with exactly the two letters: OK" },
  ];
  return Promise.all(
    providers.map(async (p): Promise<ProviderTestResult> => {
      if (!p.token) return { name: p.name, configured: false, ok: false, detail: "no key set" };
      const t0 = Date.now();
      // Hard per-provider deadline. Primary and fallback each get 10s, raced
      // against 12s overall, so ONE hung provider cannot stretch the sweep
      // past an intermediary's response timeout - the whole route answers in
      // ~12s or not at all, and "too slow" is itself an honest verdict.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const r = await Promise.race([
          callProvider(p, probe, 16, 10_000),
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(
              () => reject(new Error("probe timed out after 12s - the provider hung or is unreachable")),
              12_000
            );
          }),
        ]);
        return {
          name: p.name,
          configured: true,
          ok: true,
          model: r.model,
          configuredModel: p.model,
          ms: Date.now() - t0,
          // Bounded like `detail`: the panel renders it verbatim.
          primaryDetail: r.primaryFailure?.slice(0, 500),
        };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          name: p.name,
          configured: true,
          ok: false,
          configuredModel: p.model,
          ms: Date.now() - t0,
          // Wide enough for a both-ids-failed report (two bounded halves).
          detail: reason.slice(0, 500),
        };
      } finally {
        clearTimeout(watchdog);
      }
    })
  );
}

/**
 * Run a chat completion against the first healthy provider.
 * Returns null when no provider is configured (caller should fall back to mock).
 */
export async function chat(
  messages: ChatMessage[],
  opts?: { maxTokens?: number; budgetMs?: number }
): Promise<string | null> {
  return (await chatDetailed(messages, opts)).text;
}

/**
 * Like chat(), but also returns which provider answered and, on total failure,
 * a readable reason (the last provider error) so callers can show something
 * useful instead of a generic "did not respond".
 */
export async function chatDetailed(
  messages: ChatMessage[],
  opts?: {
    maxTokens?: number;
    budgetMs?: number;
    preferProvider?: ProviderName;
    /**
     * "premium" hoists the PAID providers (OpenAI/Anthropic/Kimi, when keyed)
     * to the front of the chain for this call - the high-stakes turns (first
     * push, farewell, comprehension) get the strongest brains, while the
     * default order keeps paid rungs LAST so routine turns never bill when a
     * free rung answers. This is what makes SPTE's pickRoute tier REAL: it
     * used to compute "Tier M" and route nothing.
     */
    tier?: "premium";
  }
): Promise<{ text: string | null; provider?: ProviderName; error?: string }> {
  // THE PER-USER AI CAP, AT THE ONE PLACE EVERY LLM CALL PASSES THROUGH.
  //
  // `LIMIT_AI_PER_DAY` used to be enforced at exactly ONE route
  // (api/extract-offer), so the negotiation engine - where essentially all the
  // spend is - was ungoverned, while the owner's slider claimed otherwise.
  // Gating here rather than at the ~20 call sites is deliberate: a new caller
  // cannot forget to opt in, because it does not have to.
  //
  // The identity arrives via an AsyncLocalStorage scope (lib/ai-budget), opened
  // once per turn/request. No scope means ungoverned, which keeps every
  // un-migrated path behaving exactly as it does today.
  //
  // Over-cap returns the SAME shape as "no provider configured" - text: null
  // with a readable reason - because every caller already handles that, and the
  // engine's deterministic composer takes over. A traveller who exhausts their
  // allowance keeps a working template-driven negotiation instead of a frozen
  // one, which is this app's degradation contract everywhere else.
  const reservation = await reserveAiCall();
  if (reservation === "over-cap") {
    return {
      text: null,
      error: "Daily AI limit reached for this account - continuing without the model.",
    };
  }
  let list = await providers();
  // PREMIUM TIER: paid providers first (stable within each half), free chain
  // as the fallback. Only reorders what is CONFIGURED - with no paid key this
  // is a no-op and the call behaves exactly like the default chain.
  if (opts?.tier === "premium") {
    list = [...list.filter((p) => p.paid), ...list.filter((p) => !p.paid)];
  }
  // preferProvider hoists one provider to the front WHEN it is configured
  // (used by the distillation "teacher" to prefer DeepSeek, while still falling
  // back to the free chain when no DeepSeek key exists). Not a hard pin.
  if (opts?.preferProvider) {
    const pref = opts.preferProvider;
    list = [...list].sort((a, b) => (a.name === pref ? -1 : b.name === pref ? 1 : 0));
  }
  if (list.length === 0) {
    return { text: null, error: "No AI provider key is configured. Add one in Admin -> Keys." };
  }
  const maxTokens = opts?.maxTokens ?? 900;
  const errors: string[] = [];
  // Total chain budget: however many providers are configured, the whole
  // failover run must finish well inside the route's 60s maxDuration. Callers
  // on a user-facing hot path (search start) pass a much tighter budget and
  // fall back to their deterministic heuristic instead of making people wait.
  const deadline = Date.now() + (opts?.budgetMs ?? 38_000);

  const { tryConsume, DEFAULT_RPM, tryConsumeDay, DEFAULT_RPD, dayKey } = await import("./ai-rpm");
  // FLEET-WIDE RPM when REDIS_URL is set; per-instance otherwise (the exact
  // upgrade path ai-rpm's header promised). One INCR per attempt against a
  // per-(provider, minute) key - a fixed window, which is all the pre-429
  // spillover needs. AI_RPM_<PROVIDER> config rows finally let the owner
  // raise a paid tier without a deploy (cached ~60s). Any Redis hiccup
  // degrades to the in-process bucket, never to a refusal.
  const rpmCap = async (name: string): Promise<number | undefined> => {
    const cached = rpmOverrideCache.get(name);
    if (cached && Date.now() - cached.at < 60_000) return cached.v ?? DEFAULT_RPM[name];
    let v: number | null = null;
    try {
      const raw = Number(await getConfig(`AI_RPM_${name.toUpperCase()}`));
      if (Number.isFinite(raw) && raw > 0) v = Math.round(raw);
    } catch {
      /* no override */
    }
    rpmOverrideCache.set(name, { v, at: Date.now() });
    return v ?? DEFAULT_RPM[name];
  };
  const tryConsumeFleet = async (name: string): Promise<boolean> => {
    const capacity = await rpmCap(name);
    if (!capacity) return true;
    try {
      const { hotStateClient } = await import("./rival-cache");
      const r = await hotStateClient();
      if (r) {
        const key = `ai-rpm:${name}:${Math.floor(Date.now() / 60_000)}`;
        const n = await r.incr(key);
        if (n === 1) await r.expire(key, 90);
        return n <= capacity;
      }
    } catch {
      /* Redis hiccup -> the per-instance bucket below */
    }
    return tryConsume(name, Date.now(), capacity);
  };
  // THE CEILING THE MINUTE BUCKET COULD NOT SEE (W-beta30). Free tiers are
  // metered per DAY as well as per minute, and nothing modeled it: once a
  // provider's day was spent, every later turn still paid it a 429 round trip
  // (doubled by the sibling-model rescue) for the rest of the day. Same shape
  // and same fail-open contract as the minute budget - Redis when present so
  // the whole fleet shares one day counter, the in-process counter otherwise,
  // and any hiccup admits the call rather than refusing it.
  const rpdCache = new Map<string, { v: number | null; at: number }>();
  const rpdCap = async (name: string): Promise<number | undefined> => {
    const cached = rpdCache.get(name);
    if (cached && Date.now() - cached.at < 60_000) return cached.v ?? DEFAULT_RPD[name];
    let v: number | null = null;
    try {
      const raw = Number(await getConfig(`AI_RPD_${name.toUpperCase()}`));
      if (Number.isFinite(raw) && raw > 0) v = Math.round(raw);
    } catch {
      /* no override */
    }
    rpdCache.set(name, { v, at: Date.now() });
    return v ?? DEFAULT_RPD[name];
  };
  const tryConsumeDayFleet = async (name: string): Promise<boolean> => {
    const capacity = await rpdCap(name);
    if (!capacity) return true;
    try {
      const { hotStateClient } = await import("./rival-cache");
      const r = await hotStateClient();
      if (r) {
        const key = `ai-rpd:${name}:${dayKey()}`;
        const n = await r.incr(key);
        // 36h: comfortably past the UTC rollover, so a spent day expires on
        // its own without a sweeper.
        if (n === 1) await r.expire(key, 129_600);
        return n <= capacity;
      }
    } catch {
      /* Redis hiccup -> the per-instance counter below */
    }
    return tryConsumeDay(name, Date.now(), capacity);
  };
  for (let idx = 0; idx < list.length; idx++) {
    const cfg = list[idx];
    if (Date.now() > deadline) {
      errors.push("time budget exhausted before trying remaining providers");
      break;
    }
    // RPM SPILLOVER, BEFORE THE 429 (owner report 4, scale #5). A provider whose
    // minute is spent is skipped so the fleet spreads across rungs instead of
    // all hammering the first one and paying a wasted round trip on its refusal.
    // The LAST rung is never skipped - better a possible 429 than no attempt at
    // all when every bucket is dry.
    if (idx < list.length - 1 && !(await tryConsumeFleet(cfg.name))) {
      errors.push(`${cfg.name}: skipped (rpm budget spent this minute)`);
      continue;
    }
    // ...and the same for the DAY. A provider whose free RPD is gone answers
    // 429 for hours; skipping it is strictly cheaper than discovering that
    // again on every turn. Never skips the last rung, exactly like the minute
    // budget - an attempt that might 429 still beats no attempt at all.
    if (idx < list.length - 1 && !(await tryConsumeDayFleet(cfg.name))) {
      errors.push(`${cfg.name}: skipped (daily request budget spent)`);
      continue;
    }
    try {
      // Never let one call overshoot the caller's total budget.
      const remaining = Math.max(2_000, Math.min(CALL_TIMEOUT_MS, deadline - Date.now()));
      const { text, tokens, model } = await callProvider(cfg, messages, maxTokens, remaining);
      await recordUsage(cfg.name, tokens, false, model);
      if (text) return { text, provider: cfg.name };
      errors.push(`${cfg.name}: empty reply`);
    } catch (e) {
      // Automatic failover: log the failure and try the next provider - and
      // PERSIST the reason, which used to live only in this local array.
      const reason = e instanceof Error ? e.message : String(e);
      await recordUsage(cfg.name, 0, true, cfg.model, reason);
      errors.push(reason);
    }
  }
  // THE FLEET RAN OUT, AND NOTHING SAID SO (W-beta30). Past this point every
  // caller degrades silently: the engine composes from deterministic
  // templates, comprehension falls back to regex, outbound localization sends
  // English. That is the right BEHAVIOUR - a working template negotiation
  // beats a frozen one - but the only telemetry that existed fired for the
  // per-USER daily cap, so fleet-wide starvation (every rung's minute or day
  // spent, or every key dead) was invisible: the owner saw "the agents got
  // stupid" with no number anywhere. One throttled event per minute names it,
  // with the reason each rung refused.
  void noteChainExhausted(errors);
  return { text: null, error: errors[errors.length - 1] ?? "All AI providers failed." };
}

// ---- vision ------------------------------------------------------------------

// The vocabulary that lets a caller tell an outage from a blank picture lives in
// lib/vision-read (pure, so the classification rules are unit-testable without a
// provider). This module owns the CALLS; that one owns the MEANING.
export type { VisionAttempt, VisionFailure, VisionRead } from "./vision-read";
import {
  RETRYABLE_VISION,
  summariseVisionFailure,
  visionFailureDetail,
  visionFailureFromStatus,
  visionFailureFromThrown,
  type VisionAttempt,
  type VisionFailure,
  type VisionRead,
} from "./vision-read";

declare global {
  // eslint-disable-next-line no-var
  var __wd_vision_diag__: { at: number; attempts: VisionAttempt[] } | undefined;
}

/**
 * The attempt log of the most recent vision call on this instance - which
 * providers/models were tried and the VERBATIM upstream error of each failure.
 * The Media Lab reads this so "the image agent is broken" always comes with
 * the exact reason (e.g. Gemini 429 quota, Groq 400 model decommissioned).
 */
export function lastVisionDiagnostics(): VisionAttempt[] {
  return globalThis.__wd_vision_diag__?.attempts ?? [];
}

// THE VISION LADDER, KEPT ALIVE.
//
// A vision id that a provider has retired does not degrade - it 400s, and the
// whole rung is wasted latency inside a bounded budget. Both ladders were
// pinned to models that have since been decommissioned (Groq deprecated the
// Llama-4 vision pair; Google retired gemini-2.0-flash), which is a large part
// of why a real price board in Thailand came back as "we could not read it".
//
// Groq: Qwen3.6-27B is Groq's current multimodal model and OCRs non-Latin
// scripts (Thai included) far better than Llama-4 did. Scout stays as a
// temporary rung until it 404s, so a deployment mid-migration is never blind.
const GROQ_VISION_FALLBACKS = [
  "qwen/qwen3.6-27b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
];
// gemini-2.5-flash-lite 404s for NEW API keys ("no longer available to new
// users" - seen verbatim in the owner's Media Lab), and the pinned
// gemini-3.5-flash failed live on the owner's key too - so the ladder is
// rolling aliases only now: they keep working when Google retires a pin.
const GEMINI_VISION_FALLBACKS = [
  GEMINI_MODEL, // gemini-flash-latest
  "gemini-flash-lite-latest",
];

/**
 * The vision ladders, with the owner's Key Vault override FIRST.
 *
 * Text model ids have been hot-fixable from Admin -> Keys for a long time
 * (GROQ_MODEL, GEMINI_MODEL, ...); vision ids were hard-coded, so the one
 * class of failure the owner cannot see coming - a provider retiring a
 * multimodal id - was also the only one they could not fix without a
 * redeploy. GEMINI_VISION_MODEL / GROQ_VISION_MODEL close that gap.
 */
async function visionLadders(): Promise<{ gemini: string[]; groq: string[]; anthropic: string[] }> {
  const [gemOverride, groqOverride, antOverride] = await Promise.all([
    getConfig("GEMINI_VISION_MODEL"),
    getConfig("GROQ_VISION_MODEL"),
    getConfig("ANTHROPIC_VISION_MODEL"),
  ]);
  const withOverride = (override: string | undefined, defaults: string[]) => {
    const o = (override ?? "").trim();
    return o ? [o, ...defaults.filter((m) => m !== o)] : defaults;
  };
  return {
    gemini: withOverride(gemOverride, GEMINI_VISION_FALLBACKS),
    groq: withOverride(groqOverride, GROQ_VISION_FALLBACKS),
    // A PAID rescue rung (owner report 5 #13): every current Claude model
    // accepts image input, and a menu photo the free rungs failed on decides
    // real money. Haiku is the cheap default; the vault override can raise it.
    anthropic: withOverride(antOverride, ["claude-haiku-4-5-20251001"]),
  };
}

// A VISION CALL IS NOT A TEXT COMPLETION.
//
// It ships megabytes of base64 and the model spends real time looking at it, so
// the shared 14s text budget was aborting perfectly good reads - and, before the
// contract below existed, that abort was indistinguishable from "the board was
// blank". Vision gets its own per-call budget, and the whole ladder gets a total
// budget so a 2-provider failover chain still fits inside the route's 60s.
const VISION_CALL_TIMEOUT_MS = 22_000;
const VISION_TOTAL_BUDGET_MS = 45_000;
/** Backoff before the single bounded retry of a transient failure. */
const VISION_RETRY_DELAY_MS = 1_200;

/** One (provider, model) attempt: either the text, or a classified failure. */
type VisionAttemptOutcome = { text: string; tokens: number } | { failure: VisionFailure; error: string };

/**
 * THE OUTPUT CEILING FOR THIS CALL, and the raised one a cut-off earns.
 *
 * 2_048 covers ONE dense board; each extra coalesced frame buys 512 more,
 * capped where the provider's own output limit lives. The RETRY ceiling is what
 * a `truncated` classification is worth: retrying a MAX_TOKENS cut-off at the
 * same ceiling can only produce the same cut-off.
 */
function visionCeiling(frames: number, raised: boolean): number {
  const base = Math.min(6_144, 2_048 + 512 * Math.max(0, frames - 1));
  return raised ? Math.min(8_192, Math.round(base * 1.75)) : base;
}

async function geminiVisionAttempt(
  key: string,
  model: string,
  system: string,
  userText: string,
  images: { mime: string; base64: string }[],
  timeoutMs: number,
  json: boolean,
  raiseCeiling = false
): Promise<VisionAttemptOutcome> {
  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [
            {
              role: "user",
              parts: [
                { text: userText },
                ...images.map((img) => ({
                  inline_data: { mime_type: img.mime, data: img.base64 },
                })),
              ],
            },
          ],
          // A REAL PRICE BOARD IS LONG. 600 tokens truncated a 17-row Thai
          // board mid-JSON, and a truncated generation returns no parseable
          // candidate - which this code then reported as "blocked", i.e. an
          // outage. The ceiling has to fit the artefact, not the average - and
          // since bursts coalesce (owner report 4), the artefact is now up to
          // 8 boards in one call, so it scales with the frame count
          // (visionCeiling, shared by every rung).
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: visionCeiling(images.length, raiseCeiling),
            // STRUCTURE, NOT FENCES. The caller that reads price boards parses
            // JSON out of this; asking the PROVIDER for JSON removes the whole
            // class of "the model wrapped it in prose / half a fence" failures
            // that fence-parsing can only guess around.
            ...(json ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
      timeoutMs
    );
    if (!res.ok) {
      return { failure: visionFailureFromStatus(res.status), error: await errorDetail(res, "gemini") };
    }
    const data = await res.json();
    const out = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    // A CUT-OFF GENERATION IS NOT A READ (owner report 5, #2).
    //
    // Nothing here ever looked at finishReason, so a MAX_TOKENS cut-off came
    // back as non-empty PARTIAL JSON, was recorded ok:true, sailed past the
    // ladder, failed extractJson in agents.ts and landed in the "nothing
    // usable in this image" fallback - a model failure reported to the
    // traveller as a fact about their photo. The provider tells us plainly;
    // we now listen, and the classification earns the raised-ceiling retry.
    const finish = String(data.candidates?.[0]?.finishReason ?? "");
    if (/^(MAX_TOKENS|LENGTH)$/i.test(finish)) {
      return {
        failure: "truncated",
        error: `generation cut off at the output ceiling (finishReason=${finish}, ${
          data.usageMetadata?.candidatesTokenCount ?? "?"
        } output tokens)`,
      };
    }
    if (out) return { text: out, tokens: data.usageMetadata?.totalTokenCount ?? 0 };
    // A 200 carrying no candidate text is the provider REFUSING - a safety
    // filter. It is not a reading of the picture.
    return {
      failure: "blocked",
      error: `empty reply (possibly safety-blocked, finishReason=${finish || "none"})`,
    };
  } catch (e) {
    return {
      failure: visionFailureFromThrown(e),
      error: e instanceof Error ? e.message : "network error",
    };
  }
}

async function groqVisionAttempt(
  key: string,
  model: string,
  system: string,
  userText: string,
  images: { mime: string; base64: string }[],
  timeoutMs: number,
  json: boolean,
  raiseCeiling = false
): Promise<VisionAttemptOutcome> {
  try {
    const res = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          // Same reason as the Gemini ceiling above: a long board must fit -
          // and the comment used to say exactly that while the value stayed a
          // flat 2_048 no matter how many frames the burst carried, so this
          // rung could still truncate a coalesced album back into the failure
          // the Gemini formula had fixed. Same helper now, same behaviour.
          max_tokens: visionCeiling(images.length, raiseCeiling),
          ...(json ? { response_format: { type: "json_object" } } : {}),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `${system}\n\n${userText}` },
                ...images.map((img) => ({
                  type: "image_url",
                  image_url: { url: `data:${img.mime || "image/jpeg"};base64,${img.base64}` },
                })),
              ],
            },
          ],
        }),
      },
      timeoutMs
    );
    if (!res.ok) {
      return { failure: visionFailureFromStatus(res.status), error: await errorDetail(res, "groq") };
    }
    const data = await res.json();
    const out = data.choices?.[0]?.message?.content?.trim();
    // Same cut-off contract as the Gemini rung, in OpenAI's spelling.
    if (String(data.choices?.[0]?.finish_reason ?? "").toLowerCase() === "length") {
      return { failure: "truncated", error: "generation cut off at the output ceiling (finish_reason=length)" };
    }
    if (out) return { text: out, tokens: data.usage?.total_tokens ?? 0 };
    return { failure: "blocked", error: "empty reply" };
  } catch (e) {
    return {
      failure: visionFailureFromThrown(e),
      error: e instanceof Error ? e.message : "network error",
    };
  }
}

async function anthropicVisionAttempt(
  key: string,
  model: string,
  system: string,
  userText: string,
  images: { mime: string; base64: string }[],
  timeoutMs: number,
  json: boolean,
  raiseCeiling = false
): Promise<VisionAttemptOutcome> {
  try {
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          // Same frame-scaled ceiling reasoning as the Gemini rung: a
          // coalesced multi-board burst must fit.
          max_tokens: visionCeiling(images.length, raiseCeiling),
          temperature: 0.2,
          system: json
            ? `${system}\n\nAnswer with ONLY the JSON object - no prose, no code fences.`
            : system,
          messages: [
            {
              role: "user",
              content: [
                ...images.map((img) => ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: img.mime || "image/jpeg",
                    data: img.base64,
                  },
                })),
                { type: "text", text: userText },
              ],
            },
          ],
        }),
      },
      timeoutMs
    );
    if (!res.ok) {
      return { failure: visionFailureFromStatus(res.status), error: await errorDetail(res, "anthropic") };
    }
    const data = await res.json();
    if (String(data.stop_reason ?? "") === "max_tokens") {
      return { failure: "truncated", error: "generation cut off at the output ceiling (stop_reason=max_tokens)" };
    }
    const out = Array.isArray(data.content)
      ? data.content
          .map((b: { type?: string; text?: string }) => (b?.type === "text" ? b.text ?? "" : ""))
          .join("")
          .trim()
      : "";
    if (out) {
      return {
        text: out,
        tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      };
    }
    return { failure: "blocked", error: "empty reply" };
  } catch (e) {
    return {
      failure: visionFailureFromThrown(e),
      error: e instanceof Error ? e.message : "network error",
    };
  }
}

/**
 * READ IMAGES, AND SAY WHETHER WE ACTUALLY SAW THEM.
 *
 * Tries every Gemini vision model, then every Groq Llama-4 vision model, then -
 * ONCE, with backoff - retries the preferred model if (and only if) its failure
 * was transient. Every attempt's exact upstream error is recorded (see
 * lastVisionDiagnostics), and the return value carries the provenance the
 * caller needs to tell an outage from a blank picture.
 */
export async function readImages(
  system: string,
  userText: string,
  images: { mime: string; base64: string }[],
  opts?: { json?: boolean; budgetMs?: number }
): Promise<VisionRead> {
  const json = opts?.json === true;
  const attempts: VisionAttempt[] = [];
  globalThis.__wd_vision_diag__ = { at: Date.now(), attempts };
  // A SECOND LADDER MUST NOT COST A SECOND BUDGET. The failure-class re-read in
  // agents.ts calls this again inside the same webhook turn, and the route is
  // capped at 60s - two calls each helping themselves to the full 45s would
  // blow it. Callers that run after a first read pass their own smaller budget;
  // it can only ever shrink the default.
  const deadline =
    Date.now() + Math.max(4_000, Math.min(VISION_TOTAL_BUDGET_MS, opts?.budgetMs ?? VISION_TOTAL_BUDGET_MS));

  const [gemini, groq, anthropic, models] = await Promise.all([
    getConfig("GEMINI_TOKEN"),
    getConfig("GROQ_TOKEN"),
    getConfig("ANTHROPIC_TOKEN"),
    visionLadders(),
  ]);
  if (!gemini)
    attempts.push({
      provider: "gemini",
      model: "(all)",
      ok: false,
      failure: "unconfigured",
      error: "GEMINI_TOKEN is not configured",
    });
  if (!groq)
    attempts.push({
      provider: "groq",
      model: "(all)",
      ok: false,
      failure: "unconfigured",
      error: "GROQ_TOKEN is not configured",
    });

  // Groq vision (Llama-4 is multimodal): image reading must never depend on
  // Gemini alone - most deployments have a GROQ_TOKEN. Only image parts are
  // sent (audio has its own Groq-Whisper path in graph/transcribe.ts).
  const groqImages = images.filter((i) => (i.mime || "").startsWith("image/"));

  const ladder: Array<{
    provider: "gemini" | "groq" | "anthropic";
    model: string;
    run: (timeoutMs: number, raiseCeiling?: boolean) => Promise<VisionAttemptOutcome>;
  }> = [];
  if (gemini) {
    for (const model of models.gemini) {
      ladder.push({
        provider: "gemini",
        model,
        run: (ms, raise) =>
          geminiVisionAttempt(gemini, model, system, userText, images, ms, json, raise),
      });
    }
  }
  if (groq && groqImages.length > 0) {
    for (const model of models.groq) {
      ladder.push({
        provider: "groq",
        model,
        run: (ms, raise) =>
          groqVisionAttempt(groq, model, system, userText, groqImages, ms, json, raise),
      });
    }
  } else if (groq && images.length > 0 && groqImages.length === 0) {
    attempts.push({
      provider: "groq",
      model: "(vision)",
      ok: false,
      failure: "unconfigured",
      error: "no image parts (audio-only input)",
    });
  }
  // PAID rescue rung (only when the owner keyed it): a menu photo the free
  // rungs failed on decides real money, so it earns a premium read. Runs LAST -
  // it is a rescue, not the default spend. Image parts only (like Groq).
  if (anthropic && groqImages.length > 0) {
    for (const model of models.anthropic) {
      ladder.push({
        provider: "anthropic",
        model,
        run: (ms, raise) =>
          anthropicVisionAttempt(anthropic, model, system, userText, groqImages, ms, json, raise),
      });
    }
  }

  const perCall = () => Math.max(2_000, Math.min(VISION_CALL_TIMEOUT_MS, deadline - Date.now()));
  const attempt = async (
    step: (typeof ladder)[number],
    label: string,
    raiseCeiling = false
  ): Promise<string | null> => {
    const r = await step.run(perCall(), raiseCeiling);
    if ("text" in r) {
      attempts.push({ provider: step.provider, model: label, ok: true });
      await recordUsage(step.provider, r.tokens);
      return r.text;
    }
    attempts.push({
      provider: step.provider,
      model: label,
      ok: false,
      failure: r.failure,
      error: r.error,
    });
    return null;
  };

  for (const step of ladder) {
    if (Date.now() > deadline) {
      attempts.push({
        provider: step.provider,
        model: step.model,
        ok: false,
        failure: "timeout",
        error: "vision time budget exhausted before this model was tried",
      });
      break;
    }
    const text = await attempt(step, step.model);
    if (text) return { ok: true, text, provider: step.provider, model: step.model, attempts };
  }

  // ONE BOUNDED RETRY, ON TRANSIENTS ONLY. A 429 or a timeout is a statement
  // about this minute, not about the photo; retrying the preferred model once
  // recovers the read that would otherwise be reported as an unreadable image.
  // A rejected key or a safety block is never retried - it cannot succeed.
  //
  // A CUT-OFF ANSWER RETRIES DIFFERENTLY. `truncated` is retryable for the
  // opposite reason to a 429: nothing about the minute was wrong, OUR ceiling
  // was too low - so the one retry it earns is at a RAISED ceiling. Repeating
  // the same call would only reproduce the same cut-off.
  const first = ladder[0];
  const firstFailure = attempts.find(
    (a) => !a.ok && first && a.provider === first.provider && a.model === first.model
  )?.failure;
  // Truncation anywhere on the ladder means the ceiling is the problem, even
  // when the preferred rung failed for another reason.
  const anyTruncated = attempts.some((a) => !a.ok && a.failure === "truncated");
  if (
    first &&
    firstFailure &&
    RETRYABLE_VISION.has(firstFailure) &&
    deadline - Date.now() > VISION_RETRY_DELAY_MS + 4_000
  ) {
    await new Promise((r) => setTimeout(r, VISION_RETRY_DELAY_MS));
    const raise = firstFailure === "truncated" || anyTruncated;
    const text = await attempt(first, `${first.model} (retry${raise ? ", raised ceiling" : ""})`, raise);
    if (text) return { ok: true, text, provider: first.provider, model: first.model, attempts };
  }

  const failure = summariseVisionFailure(attempts);
  return {
    ok: false,
    failure,
    retryable: RETRYABLE_VISION.has(failure),
    detail: visionFailureDetail(attempts),
    attempts,
  };
}

/**
 * Vision chat, LOSSY. Kept for callers that genuinely only want the text
 * (transcription, the admin training bench): `null` here means "no text", with
 * the reason discarded. Anything that reports to a traveller, or decides what
 * to do about a photo, must use `readImages` and read the provenance.
 */
export async function chatVision(
  system: string,
  userText: string,
  images: { mime: string; base64: string }[]
): Promise<string | null> {
  const read = await readImages(system, userText, images);
  return read.ok ? read.text : null;
}

/**
 * Grounded chat: a single Gemini call with Google Search grounding enabled, so
 * the model answers from REAL current web results (used to research live rental
 * market floors). Returns the text plus any source URLs Gemini cites. Null when
 * no Gemini key is set, so callers fall back to an ungrounded estimate.
 */
export async function chatGrounded(
  system: string,
  user: string
): Promise<{ text: string; sources: string[] } | null> {
  const key = await getConfig("GEMINI_TOKEN");
  if (!key) return null;
  // 2.5-flash supports the google_search tool; lite is the higher-quota fallback.
  const models = [GEMINI_MODEL, "gemini-flash-latest", "gemini-flash-lite-latest"];
  for (const model of models) {
    try {
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 900 },
          }),
        }
      );
      if (!res.ok) continue; // 429/404 - try the next model
      const data = await res.json();
      const cand = data.candidates?.[0];
      const text = cand?.content?.parts
        ?.map((p: any) => p?.text ?? "")
        .join("")
        .trim();
      if (!text) continue;
      const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
      const sources: string[] = chunks
        .map((c: any) => c?.web?.uri)
        .filter(Boolean)
        .slice(0, 6);
      await recordUsage("gemini", data.usageMetadata?.totalTokenCount ?? 0);
      return { text, sources };
    } catch {
      /* try next model */
    }
  }
  return null;
}

/** Extract the first JSON object from an LLM response, tolerating code fences. */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
