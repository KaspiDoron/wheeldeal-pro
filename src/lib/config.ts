// Admin configuration surface (Key Vault).
//
// SECURITY: secret values are NEVER sent to the browser. The admin panel only
// ever receives a masked fingerprint (last 4 chars) and a configured/missing
// status. Values set here are persisted via runtime-config (Supabase, encrypted
// at rest) when Supabase is configured, so they survive serverless restarts and
// take effect at the next request without a redeploy.
//
// NOT EVERY MANAGED VALUE IS A SECRET. A model id and a provider name are
// settings: masking them makes them unusable, because correcting a drifted
// model id requires reading the one currently set. Those entries carry
// `secret: false` and are shown in full. The flag DEFAULTS TO SECRET, so a key
// added without thinking about it is masked - the safe direction.

import "server-only";
import { getConfig, getConfigMany, setConfig, supabaseConfigured } from "./runtime-config";

export interface KeyInfo {
  name: string;
  label: string;
  configured: boolean;
  /**
   * What the panel displays. A masked fingerprint for credentials; the value
   * itself for the entries marked `secret: false` (model ids, provider name).
   */
  masked: string;
  scope: "ai" | "data" | "messaging" | "email" | "billing" | "auth" | "maps";
  editable: boolean;
  /**
   * There is a real probe behind this key's "Test API" button even though it
   * is NOT editable here.
   *
   * The panel gated the test button on `editable`, which made sense while
   * every non-editable key was a bootstrap secret nobody could act on. It
   * stopped making sense the moment REDIS_URL was listed: it is env-only AND
   * it is the one dependency whose absence silently multiplies every daily cap
   * by the instance count. Being unable to press PING on it was the whole
   * problem restated.
   */
  testable?: boolean;
  docUrl?: string; // where to generate this key (shown when it is missing)
  /** False for SETTINGS (flags, thresholds, model ids) - the panel renders a
   *  readable input for those instead of a password field, because a value
   *  typed blind into a masked box cannot be read back or corrected. */
  secret?: boolean;
}

/**
 * Non-editable keys that still have a real probe. Deliberately an explicit
 * list rather than "everything": a Test button that always answers "No test
 * available for this key" is worse than no button, because it teaches the
 * reader that the button means nothing.
 */
const TESTABLE_READ_ONLY = new Set([
  "REDIS_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SESSION_SECRET",
]);

// Where to obtain each key - a "Get key" link surfaces when the key is unset.
const DOC_URLS: Record<string, string> = {
  GROQ_TOKEN: "https://console.groq.com/keys",
  GROQ_WHISPER_MODEL: "https://console.groq.com/docs/speech-to-text",
  // Where a managed Redis actually comes from. The free tier (500k commands +
  // 256 MB / month) already covers a beta's cap counters.
  REDIS_URL: "https://console.upstash.com/redis",
  GEMINI_TOKEN: "https://aistudio.google.com/app/apikey",
  OPENROUTER_TOKEN: "https://openrouter.ai/keys",
  CEREBRAS_TOKEN: "https://cloud.cerebras.ai/",
  MISTRAL_TOKEN: "https://console.mistral.ai/api-keys/",
  HUGGINGFACE_TOKEN: "https://huggingface.co/settings/tokens",
  DEEPSEEK_TOKEN: "https://platform.deepseek.com/api_keys",
  TOGETHER_TOKEN: "https://api.together.ai/settings/api-keys",
  SAMBANOVA_TOKEN: "https://cloud.sambanova.ai/apis",
  ANTHROPIC_TOKEN: "https://platform.claude.com/settings/keys",
  OPENAI_TOKEN: "https://platform.openai.com/api-keys",
  KIMI_TOKEN: "https://platform.moonshot.ai/console/api-keys",
  EVOLUTION_HOSTS: "https://doc.evolution-api.com/",
  EVOLUTION_API_URL: "https://doc.evolution-api.com/",
  EVOLUTION_API_KEY: "https://doc.evolution-api.com/",
  EVOLUTION_PROXY: "https://doc.evolution-api.com/v2/en/configuration/proxy",
  EVOLUTION_PROXY_POOL: "https://doc.evolution-api.com/v2/en/configuration/proxy",
  EVOLUTION_PROXY_TEMPLATE: "https://doc.evolution-api.com/v2/en/configuration/proxy",
  EVOLUTION_PROXY_COUNTRY_DEFAULT: "https://doc.evolution-api.com/v2/en/configuration/proxy",
  EVOLUTION_PROXY_COUNTRY_ALLOW: "https://doc.evolution-api.com/v2/en/configuration/proxy",
  WHATSAPP_ACCESS_TOKEN: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
  WHATSAPP_PHONE_NUMBER_ID: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
  WHATSAPP_VERIFY_TOKEN: "https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks",
  GOOGLE_MAPS_API_KEY: "https://console.cloud.google.com/google/maps-apis/credentials",
  GOOGLE_OAUTH_CLIENT_ID: "https://console.cloud.google.com/apis/credentials",
  GMAIL_USER: "https://myaccount.google.com/security",
  GMAIL_APP_PASSWORD: "https://myaccount.google.com/apppasswords",
  RESEND_API_KEY: "https://resend.com/api-keys",
  BREVO_API_KEY: "https://app.brevo.com/settings/keys/api",
  BREVO_SENDER: "https://app.brevo.com/senders",
  PAYPAL_CLIENT_ID: "https://developer.paypal.com/dashboard/applications/live",
  PAYPAL_CLIENT_SECRET: "https://developer.paypal.com/dashboard/applications/live",
  PAYPAL_PLAN_PRO: "https://www.paypal.com/billing/plans",
  PAYPAL_PLAN_ULTRA: "https://www.paypal.com/billing/plans",
  PAYPAL_WEBHOOK_ID: "https://developer.paypal.com/dashboard/applications/live",
  PAYPAL_ENV: "https://developer.paypal.com/dashboard/applications/live",
  ADSENSE_CLIENT: "https://www.google.com/adsense/",
  ADSENSE_SLOT: "https://www.google.com/adsense/new/u/0/pub/ads/myads/units",
  TWITTER_HANDLE: "https://x.com/settings/profile",
};

// Keys that can be set from the admin panel at runtime. Bootstrap secrets
// (Supabase connection, SESSION_SECRET) are intentionally env-only.
const KEYS: {
  name: string;
  label: string;
  scope: KeyInfo["scope"];
  editable: boolean;
  /**
   * False for values that are settings, not credentials - a model id, a
   * provider name. Masking those makes them unusable: the whole point of a
   * live model override is reading what is currently set and correcting it,
   * and `••••2507` cannot be corrected. Defaults to true, so a new key is a
   * secret unless someone says otherwise.
   */
  secret?: boolean;
}[] = [
  { name: "GROQ_TOKEN", label: "Groq Gateway", scope: "ai", editable: true },
  { name: "GEMINI_TOKEN", label: "Gemini Gateway", scope: "ai", editable: true },
  { name: "OPENROUTER_TOKEN", label: "OpenRouter Gateway", scope: "ai", editable: true },
  { name: "CEREBRAS_TOKEN", label: "Cerebras Gateway", scope: "ai", editable: true },
  { name: "MISTRAL_TOKEN", label: "Mistral (mistral-large - top tier)", scope: "ai", editable: true },
  { name: "HUGGINGFACE_TOKEN", label: "Hugging Face router (Llama 3.3 70B - free)", scope: "ai", editable: true },
  { name: "DEEPSEEK_TOKEN", label: "DeepSeek (deepseek-v4-pro - top tier)", scope: "ai", editable: true },
  { name: "TOGETHER_TOKEN", label: "Together AI (Llama 3.3 70B - free)", scope: "ai", editable: true },
  { name: "SAMBANOVA_TOKEN", label: "SambaNova (gpt-oss-120b - fast, free)", scope: "ai", editable: true },
  // ---- PAID providers (owner report 5 #13) - premium brains for the turns
  // that decide money. Last in the default failover chain (a free rung
  // answering means no bill), first on premium-tier calls.
  { name: "ANTHROPIC_TOKEN", label: "Anthropic Claude (PAID - premium tier)", scope: "ai", editable: true },
  { name: "OPENAI_TOKEN", label: "OpenAI (PAID - premium tier)", scope: "ai", editable: true },
  { name: "KIMI_TOKEN", label: "Kimi / Moonshot AI (PAID - premium tier)", scope: "ai", editable: true },
  // Not a secret, and I-7 makes it the FIRST thing to read: the default order
  // returns Groq first, so a "Cerebras primary, fails over to Groq" report is
  // only possible under a non-default value here. Masked, it could not be
  // confirmed or denied.
  { name: "AI_PROVIDER", label: "Preferred AI provider", scope: "ai", editable: true, secret: false },

  // ---- MODEL OVERRIDES - the escape hatch that was documented and unusable --
  //
  // `ai.ts` reads all eleven of these through `getConfig`, and its own comment
  // calls a pasted `<PROVIDER>_MODEL` the way to correct a drifted model id
  // without a redeploy. None of them were in this allowlist, and `setKey`
  // refuses anything absent from it - so the documented lever did nothing and
  // the only fix for a provider answering 400 on a renamed model was a deploy.
  // That is I-7's one surviving gap: a free-tier provider renames or retires a
  // model on its own schedule, which is exactly the failure Cerebras showed
  // (14 calls, 14 failovers, 0 tokens).
  //
  // A model id is a setting, so none of them are masked.
  { name: "GROQ_MODEL", label: "Groq model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "GEMINI_MODEL", label: "Gemini model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "OPENROUTER_MODEL", label: "OpenRouter model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "CEREBRAS_MODEL", label: "Cerebras model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "MISTRAL_MODEL", label: "Mistral model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "HUGGINGFACE_MODEL", label: "Hugging Face model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "DEEPSEEK_MODEL", label: "DeepSeek model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "TOGETHER_MODEL", label: "Together model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "SAMBANOVA_MODEL", label: "SambaNova model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "ANTHROPIC_MODEL", label: "Anthropic model id (blank = claude-sonnet-5)", scope: "ai", editable: true, secret: false },
  { name: "OPENAI_MODEL", label: "OpenAI model id (blank = gpt-5.6-terra)", scope: "ai", editable: true, secret: false },
  { name: "KIMI_MODEL", label: "Kimi model id (blank = kimi-k3)", scope: "ai", editable: true, secret: false },
  // The SECOND Groq SKU. One token, two billed products (chat completions and
  // audio transcription), and the key test only ever exercised the first - so
  // a dead voice-note path wore the same green chip as a healthy one. Its own
  // model id, its own Test API button (see api/admin/key-test).
  { name: "GROQ_WHISPER_MODEL", label: "Groq voice-note model id (blank = whisper-large-v3)", scope: "ai", editable: true, secret: false },
  { name: "GEMINI_VISION_MODEL", label: "Gemini vision model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "GROQ_VISION_MODEL", label: "Groq vision model id (blank = default)", scope: "ai", editable: true, secret: false },
  { name: "ANTHROPIC_VISION_MODEL", label: "Anthropic vision model id (blank = default)", scope: "ai", editable: true, secret: false },
  // THE ENGINE SWITCHES, honestly labelled. The legacy pipeline the old
  // GRAPH_ENGINE label pointed at is DELETED - 'off' now means "no failover
  // net behind SPTE", which is an emergency lever, not a mode.
  { name: "NEGOTIATION_ENGINE", label: "Negotiation engine ('spte' = default primary; 'graph' = run every turn on the failover engine)", scope: "ai", editable: true, secret: false },
  { name: "ENGINE_V3", label: "SPTE kill switch ('off' = same as NEGOTIATION_ENGINE=graph; historical spelling)", scope: "ai", editable: true, secret: false },
  { name: "GRAPH_ENGINE", label: "Failover engine ('off' = NO net behind SPTE - replies stop if SPTE throws)", scope: "ai", editable: true, secret: false },
  // ---- Monetization: the warm-up gate and its measurement holdout ----------
  //
  // The thresholds are here rather than hardcoded so the gate can be loosened or
  // tightened against real cohort data without a redeploy. The number that says
  // whether they are right is p90 time-to-unlock on Admin -> money; if that
  // exceeds a typical trip, the gate is too tight.
  { name: "WARMUP_GATE", label: "Warm-up gate ('off' = anyone may buy immediately; default on)", scope: "billing", editable: true, secret: false },
  { name: "WARMUP_MIN_SEARCHES", label: "Warm-up: searches required (default 1)", scope: "billing", editable: true, secret: false },
  { name: "WARMUP_MIN_ENGAGED", label: "Warm-up: distinct shops reached (default 3)", scope: "billing", editable: true, secret: false },
  { name: "WARMUP_MIN_REPLIES", label: "Warm-up: shops that replied (default 1)", scope: "billing", editable: true, secret: false },
  // The holdout is a MEASUREMENT INSTRUMENT. Without a slice that can buy
  // immediately, "the gate improves conversion" is unfalsifiable forever.
  // Ships at 0 - turn it on deliberately when you want the comparison.
  { name: "WARMUP_HOLDOUT_PCT", label: "Warm-up holdout % (0-100) - this slice may buy without warming up", scope: "billing", editable: true, secret: false },
  { name: "WARMUP_HOLDOUT_LIST", label: "Warm-up holdout: specific emails (comma or newline separated)", scope: "billing", editable: true, secret: false },
  { name: "HUMAN_TAKEOVER", label: "Human takeover detection ('off' = ignore user-typed WhatsApp messages)", scope: "messaging", editable: true, secret: false },
  // WHICH WIRE CARRIES FIRST CONTACT (src/lib/wa/transports). Per-thread
  // stamps always outrank this; a WABA mode with no ready WABA config
  // degrades to evolution, never to dead air.
  { name: "TRANSPORT_MODE", label: "Transport mode ('evolution' default; 'waba-first' / 'waba-fallback' = company-number lead handoff for first contact)", scope: "messaging", editable: true, secret: false },
  { name: "FAST_DISPATCH", label: "Fast dispatch ('off' = cold intros wait for shop opening hours; default on - batches fire within their 15-min window)", scope: "messaging", editable: true, secret: false },
  { name: "CANCEL_GUARD", label: "Cancellation enforcement ('off' = removed shops may be messaged again; default on)", scope: "messaging", editable: true, secret: false },
  { name: "EVOLUTION_HOSTS", label: "Evolution host pool (url|key per line)", scope: "messaging", editable: true },
  { name: "EVOLUTION_MAX_PER_HOST", label: "Max WhatsApp users per host", scope: "messaging", editable: true, secret: false },
  { name: "EVOLUTION_PROXY", label: "Residential proxy URL (anti-ban - socks5://user:pass@host:port)", scope: "messaging", editable: true },
  { name: "EVOLUTION_PROXY_POOL", label: "Residential proxy POOL (DEPRECATED - use EVOLUTION_PROXY_TEMPLATE; the mod-hash pin remaps users on any pool edit)", scope: "messaging", editable: true },
  { name: "EVOLUTION_PROXY_TEMPLATE", label: "Residential gateway template - one URL with {session} (required) and {country} (optional), e.g. socks5://USER:PASS_country-{country}_session-{session}@gateway:port", scope: "messaging", editable: true },
  { name: "EVOLUTION_PROXY_COUNTRY_DEFAULT", label: "Default exit country (two letters, e.g. th) when a lead has none", scope: "messaging", editable: true, secret: false },
  { name: "EVOLUTION_PROXY_COUNTRY_ALLOW", label: "Allowed exit countries (comma-separated two-letter codes; empty = any)", scope: "messaging", editable: true, secret: false },
  { name: "EVOLUTION_API_URL", label: "Evolution API URL (single-host fallback)", scope: "messaging", editable: true },
  { name: "EVOLUTION_API_KEY", label: "Evolution API Key (single-host fallback)", scope: "messaging", editable: true },
  // ---- The business-number handoff (plan Part 12) --------------------------
  //
  // OFF until every one of these is set AND WABA_ENABLED is flipped on. With the
  // flag off, no new code path runs and no new request leaves the process - the
  // existing engine, where the traveller's own number makes first contact,
  // stays the live path exactly as it is today.
  //
  // WABA_DRY_RUN ships ON: the whole pipeline renders the exact wire text and
  // sends nothing, so the template and its button can be verified without
  // spending quality rating on a rented account.
  { name: "WABA_ENABLED", label: "Business-number handoff ('on' = our official number makes first contact; default OFF)", scope: "messaging", editable: true, secret: false },
  { name: "WABA_DRY_RUN", label: "Business-number DRY RUN ('off' = really send; default ON - renders text, sends nothing)", scope: "messaging", editable: true, secret: false },
  { name: "WABA_PROVIDER", label: "Business API provider ('meta' direct or 'reseller')", scope: "messaging", editable: true, secret: false },
  { name: "WABA_BASE_URL", label: "Business API base URL (provider host, no trailing slash)", scope: "messaging", editable: true, secret: false },
  { name: "WABA_API_KEY", label: "Business API key", scope: "messaging", editable: true },
  { name: "WABA_SENDER_ID", label: "Business API sender / phone-number id", scope: "messaging", editable: true },
  { name: "WABA_WEBHOOK_SECRET", label: "Business API webhook shared secret (resellers usually do not sign)", scope: "messaging", editable: true },
  { name: "WABA_TEMPLATE_FIRST_CONTACT", label: "Approved first-contact template name", scope: "messaging", editable: true, secret: false },
  { name: "WABA_TEMPLATE_REENGAGE", label: "Approved re-engagement template name (agency quiet past 24h)", scope: "messaging", editable: true, secret: false },
  { name: "WABA_LINK_BASE", label: "Handoff link base - MUST match the approved template button URL", scope: "messaging", editable: true, secret: false },
  { name: "WABA_AGENCY_COOLDOWN_HOURS", label: "Min hours between templates to one agency (default 24 - error 131049 guard)", scope: "messaging", editable: true, secret: false },
  { name: "WABA_HOLD_TIMEOUT_MINUTES", label: "How long a lead waits for the agency to open the window (default 25)", scope: "messaging", editable: true, secret: false },
  { name: "WABA_EXPECTATION_TTL_HOURS", label: "How long a dispatched handoff authorises inbound from that agency (default 72)", scope: "messaging", editable: true, secret: false },
  { name: "WABA_DAILY_SPEND_CEILING_USD", label: "Daily spend ceiling on the official number", scope: "messaging", editable: true, secret: false },
  { name: "WABA_KILL", label: "Business-number EMERGENCY STOP ('on' = halt all first contact immediately)", scope: "messaging", editable: true, secret: false },
  { name: "WABA_QUALITY_RATING", label: "Quality rating as last reported (GREEN/YELLOW/RED) - RED pauses first contact", scope: "messaging", editable: true, secret: false },
  { name: "WABA_TIER_UNIQUE_PER_DAY", label: "Messaging tier: unique recipients per 24h (250 unverified, 1000 after verification)", scope: "messaging", editable: true, secret: false },
  { name: "WABA_TEMPLATE_COST_USD", label: "Cost per template, for the spend estimate (default 0.05)", scope: "messaging", editable: true, secret: false },
  // The LEGACY Cloud sender's own switch (lib/whatsapp.ts). Deliberately NOT
  // WABA_ENABLED: rehearsing the governed handoff lane (WABA_ENABLED on,
  // WABA_DRY_RUN on) must never arm this ungoverned sender as a side effect.
  { name: "CLOUD_API_ENABLED", label: "Legacy Cloud API sender ('on' = owner-number Graph API sends; default OFF - separate from the handoff lane)", scope: "messaging", editable: true, secret: false },
  { name: "WHATSAPP_ACCESS_TOKEN", label: "WhatsApp Cloud API Token (optional)", scope: "messaging", editable: true },
  { name: "WHATSAPP_PHONE_NUMBER_ID", label: "WhatsApp Phone Number ID (optional)", scope: "messaging", editable: true },
  { name: "WHATSAPP_VERIFY_TOKEN", label: "WhatsApp Webhook Verify Token (optional)", scope: "messaging", editable: true },
  { name: "WHATSAPP_APP_SECRET", label: "WhatsApp App Secret (verifies inbound webhook signatures)", scope: "messaging", editable: true },
  { name: "VAPID_PUBLIC_KEY", label: "Web Push VAPID public key (reply alerts - auto-generated on first use; paste your own only to override)", scope: "messaging", editable: true },
  { name: "VAPID_PRIVATE_KEY", label: "Web Push VAPID private key (auto-generated with the public key)", scope: "messaging", editable: true },
  { name: "GOOGLE_MAPS_API_KEY", label: "Google Maps API Key", scope: "maps", editable: true },
  { name: "GOOGLE_OAUTH_CLIENT_ID", label: "Google OAuth Client ID", scope: "auth", editable: true },
  { name: "GMAIL_USER", label: "Gmail address (free SMTP - preferred)", scope: "email", editable: true },
  { name: "GMAIL_APP_PASSWORD", label: "Gmail App Password (Google Account -> Security -> App passwords)", scope: "email", editable: true },
  { name: "RESEND_API_KEY", label: "Resend Email API Key (needs a domain)", scope: "email", editable: true },
  { name: "BREVO_API_KEY", label: "Brevo Email API Key (no domain needed)", scope: "email", editable: true },
  { name: "BREVO_SENDER", label: "Brevo verified sender email", scope: "email", editable: true },
  { name: "FEEDBACK_FROM_EMAIL", label: "Feedback From Address", scope: "email", editable: true },
  { name: "PAYPAL_CLIENT_ID", label: "PayPal Client ID (REST app)", scope: "billing", editable: true },
  { name: "PAYPAL_CLIENT_SECRET", label: "PayPal Client Secret", scope: "billing", editable: true },
  { name: "PAYPAL_PLAN_PRO", label: "PayPal Billing Plan ID - Pro", scope: "billing", editable: true },
  { name: "PAYPAL_PLAN_ULTRA", label: "PayPal Billing Plan ID - Ultra", scope: "billing", editable: true },
  { name: "PAYPAL_WEBHOOK_ID", label: "PayPal Webhook ID (verifies webhook signatures)", scope: "billing", editable: true },
  { name: "PAYPAL_ENV", label: "PayPal environment ('live' | 'sandbox'; blank = live)", scope: "billing", editable: true, secret: false },
  { name: "ADSENSE_CLIENT", label: "Google AdSense Client (ca-pub-...)", scope: "billing", editable: true, secret: false },
  // WITHOUT THIS, NO BANNER CAN EVER FILL. The client id says whose account
  // this is; the slot id says which ad unit to serve into. AdBanner rendered
  // data-ad-slot only when a caller passed one and none ever did, so the free
  // tier reserved its ad space, showed its placeholder, and earned nothing.
  { name: "ADSENSE_SLOT", label: "Google AdSense Ad Unit ID (numeric, from a Display unit)", scope: "billing", editable: true, secret: false },
  { name: "TWITTER_HANDLE", label: "X (Twitter) handle (@wheeldeal)", scope: "auth", editable: true, secret: false },
  // The legal entity the Terms, the Privacy Policy and every indemnity clause
  // protect. It was a placeholder constant with a TODO on it, so registering a
  // company meant a code change - the one value in the legal text that names
  // WHO is protected, and the only one that could not be set.
  { name: "OPERATOR_NAME", label: "Legal entity name in the Terms (e.g. 'WheelDeal Ltd.')", scope: "auth", editable: true, secret: false },
  // Will's ACTING half. "off" keeps every answer (status, why, compare, help)
  // and turns his hands-on commands into directions to the real control - for
  // when part of the action path is mid-rebuild and a confident "Done" that
  // changes nothing would be worse than a refusal.
  { name: "WILL_ACTIONS", label: "Will can operate the app ('off' = guidance only, answers still work)", scope: "auth", editable: true, secret: false },
  { name: "APP_DOMAIN", label: "Public app domain (https://... - drives share links, SEO & sender identity)", scope: "auth", editable: true, secret: false },
  // The allow-list for `x-forwarded-host`. Not a secret - it is a list of the
  // owner's own hostnames, and masking it would mean never being able to read
  // back what was set. APP_DOMAIN is always trusted; this is for the extra
  // hosts a deployment legitimately answers on (the GCP gateway URL, a staging
  // host) so they can be added without a redeploy. Anything NOT listed here
  // cannot choose the URL we fetch, the webhook URL we register, or where a
  // payer lands after checkout.
  { name: "TRUSTED_HOSTS", label: "Extra hostnames this app answers on (comma-separated; APP_DOMAIN is always trusted)", scope: "auth", editable: true, secret: false },
  { name: "TEST_MODE", label: "Test Mode ('on' = flagged testers ride Ultra free + sandbox billing + banner)", scope: "auth", editable: true, secret: false },
  { name: "SCALE_MODE", label: "Scale Mode ('on' = 3x per-user limits + relaxed polling for high load)", scope: "data", editable: true, secret: false },
  { name: "PACING_MODE", label: "Pacing Mode (WhatsApp speed vs ban-safety dial: 'fast' | 'balanced' | 'cautious'; blank = balanced)", scope: "data", editable: true, secret: false },
  // Not a secret - it is a duration, and masking it would mean the owner could
  // never read back what they set. `secret: false` shows the live value.
  { name: "SEARCH_SESSION_TTL_HOURS", label: "How long a search stays the live hunt, in hours (blank = 3; older hunts move to Trips)", scope: "data", editable: true, secret: false },
  // THE DEPENDENCY THAT APPEARED ON NO SCREEN AT ALL (Wave 7).
  //
  // Four subsystems read it - the atomic daily caps in usage.ts, the AI budget
  // cache, the copy-uniqueness window and the SSE session fan-out - and it is
  // the single documented difference between a daily cap that is ATOMIC and
  // one that is a per-process counter, which `--max-instances 20` multiplies
  // by twenty. It had no vault row, no probe and no status chip, so "the cap
  // is enforcing nothing" and "everything is fine" looked the same.
  //
  // env-only ON PURPOSE, and NOT an oversight to be "fixed" later: the client
  // reads `process.env.REDIS_URL` once at first use, in a module that also
  // runs inside the workers/gateway services where the Supabase vault is not
  // in the request path. A pasteable field here would report "configured" and
  // change nothing - the worst possible lie for this particular key. It is
  // listed so it can be SEEN and TESTED; set the value in GCP Secret Manager.
  { name: "REDIS_URL", label: "Redis URL (env-only - atomic caps + hot state; unset = per-instance counters)", scope: "data", editable: false },
  { name: "NEXT_PUBLIC_SUPABASE_URL", label: "Supabase URL", scope: "data", editable: false },
  { name: "SUPABASE_SERVICE_ROLE_KEY", label: "Supabase Service Role", scope: "data", editable: false },
  { name: "SESSION_SECRET", label: "Session Signing Secret", scope: "auth", editable: false },
];

function mask(v?: string): string {
  if (!v) return "- not set -";
  if (v.length <= 6) return "••••";
  return `${"•".repeat(Math.min(20, v.length - 4))}${v.slice(-4)}`;
}

/**
 * What the admin panel shows for a key.
 *
 * A credential is masked. A SETTING is not - a model id shown as `••••2507`
 * cannot be checked against the provider's docs or corrected, which defeats
 * the entire purpose of having it be editable at runtime.
 *
 * `secret` defaults to true, so this stays fail-safe: a key added without
 * thinking about it is masked.
 */
function displayValue(v: string | undefined, secret: boolean | undefined): string {
  if (secret === false) return v || "- not set -";
  return mask(v);
}

/** True when runtime edits will persist (Supabase configured). */
export function persistenceEnabled(): boolean {
  return supabaseConfigured();
}

/** Masked, browser-safe view of every managed credential. */
export async function listKeys(): Promise<KeyInfo[]> {
  return Promise.all(
    KEYS.map(async (k) => {
      const v = await getConfig(k.name);
      return {
        name: k.name,
        label: k.label,
        scope: k.scope,
        editable: k.editable,
        testable: k.editable || TESTABLE_READ_ONLY.has(k.name),
        configured: Boolean(v),
        masked: displayValue(v, k.secret),
        docUrl: DOC_URLS[k.name],
        secret: k.secret !== false,
      };
    })
  );
}

/** Apply a runtime override. Returns the masked view (never the raw secret). */
export async function setKey(
  name: string,
  value: string
): Promise<{ key: KeyInfo; warning?: string } | null> {
  const meta = KEYS.find((k) => k.name === name);
  if (!meta || !meta.editable) return null;
  const result = await setConfig(name, value);
  const v = await getConfig(name);
  return {
    key: {
      name,
      label: meta.label,
      scope: meta.scope,
      editable: meta.editable,
      testable: meta.editable || TESTABLE_READ_ONLY.has(name),
      configured: Boolean(v),
      masked: displayValue(v, meta.secret),
      // Carried on the write response too: the client replaces the whole row
      // with this object, and dropping either field cost the row its "Get
      // this key" link and flipped a setting's input back to a password box.
      docUrl: DOC_URLS[name],
      secret: meta.secret !== false,
    },
    warning: result.error,
  };
}

/** OWNER ONLY: raw values for every managed key, ready to view and copy.
 *
 *  This was `Promise.all` over 52 individual `getConfig` calls, i.e. 52
 *  simultaneous full-vault reads - each of which decrypted every row with a
 *  synchronous scrypt per row. It was the single largest contributor to the
 *  cold-load stall, and it fired on the Profile page for EVERY user, not just
 *  owners. One read now. */
export async function revealKeys(): Promise<
  { name: string; label: string; value: string }[]
> {
  const values = await getConfigMany(KEYS.map((k) => k.name));
  return KEYS.map((k) => ({
    name: k.name,
    label: k.label,
    value: values[k.name] ?? "",
  }));
}
