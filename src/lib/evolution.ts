// Evolution API integration - per-user WhatsApp sessions via QR scan.
//
// Why: without a registered business you cannot pass Meta's verification for
// the official Cloud API. Evolution API (open source, self-hosted, free) lets
// each traveller connect their OWN personal WhatsApp by scanning a QR code in
// their Profile - messages then go out from their real number (authentic
// bargaining) and replies stream back into the app through our webhook.
//
// HONESTY & SAFETY: this rides the unofficial WhatsApp Web protocol, which is
// against WhatsApp's Terms of Service - numbers CAN get banned if they behave
// like bots. We therefore enforce strict, human-like limits below (min gap
// between messages, hourly/daily caps, typing delay) and the UI warns users.
//
// Config (Admin -> Keys): EVOLUTION_API_URL, EVOLUTION_API_KEY.

import "server-only";
import { createHash } from "crypto";
import { getConfig, sbInsert, sbSelect, sbDelete, sbSelectStrict } from "./runtime-config";
import { deriveWebhookToken, sameWebhookTarget, classifyRegisteredWebhook } from "./wa/webhook-token";
import type { TokenState } from "./wa/webhook-token";
import { jidMatches } from "./wa/jid";
import { waMessageText } from "./wa/message-text";
import { isLinkedFromStatus } from "./wa/linked-status";
import { routableOrigin } from "./request-origin";
import { digitsOnly } from "./phone";
import { boundedSet } from "./bounded-map";
import { parseDialPrefixes, affinityFor, AFFINITY_MISMATCH } from "./wa/host-region";
import { placeHost } from "./wa/host-placement";
import { isHardSendFailure } from "./wa/send-classify";
import { readOrientationFromBase64 } from "./media/orientation";
import type { InboundImage } from "./media/orientation";

// ---- anti-ban limits (human-like behaviour; owner-adjustable in Admin) --------

// PAIRING-LAYER anti-ban: the client fingerprint presented at socket connect.
// Baileys' default fingerprint (a generic "Evolution API" / library string) reads
// as an automation client and is a top-weighted flag vector AT PAIRING TIME -
// before a single message is sent (the exact failure the owner hit). Presenting a
// STANDARD desktop WhatsApp-Web fingerprint (Chrome on macOS) makes the socket
// indistinguishable from a normal linked-device Web session.
//   [platform, browser, version] - Baileys' Browsers.macOS('Chrome') shape.
// Passed on EVERY instance/create below. On stock Evolution API the authoritative
// equivalent is the SERVER env CONFIG_SESSION_PHONE_CLIENT="Mac OS" +
// CONFIG_SESSION_PHONE_NAME="Chrome" (see docs/ANTI-BAN.md); setting both the
// per-instance field AND the server env is belt-and-suspenders - the field is a
// harmless no-op on builds that read only the env, and authoritative on forks
// that pass `browser` straight to makeWASocket.
// The VERSION is refreshed to a current stable build (owner report 4, anti-ban
// A3): a linked-device fingerprint pinned to a long-retired Chrome is itself a
// mild tell as the real fleet moves on. The platform + browser stay fleet-
// UNIFORM on purpose - the unofficial-client axis is a full ban keyed on client
// IDENTITY that resolves 100%/0% for everyone at once (see
// wa/device-fingerprint.test.ts), so varying "Mac OS"/"Chrome" per account buys
// nothing; only the version tracks reality. Keep it current on each refresh.
const CLIENT_BROWSER: readonly [string, string, string] = ["Mac OS", "Chrome", "131.0.0"];

// Connection-safety defaults shared by every instance/create path. mobile:false
// pins the WhatsApp WEB protocol (not the flagged/deprecated mobile API); the
// history/read flags below keep the socket from pulling the user's past chats or
// media on connect (data minimization AND removing the "reads everything on link"
// bot signature). NOTE: syncFullHistory:false is intentionally ALSO written as a
// literal in each create body - the hardening-invariants test pins that literal.
// THE EVENT SET, WRITTEN ONCE.
//
// It lived as three separate literals - register, recreate, create - and the
// only reason they matched was that nobody had edited one of them lately.
// CALL is here because a shop RINGING the traveller is a real event this app
// has to answer: the traveller is abroad, may be on airplane mode or simply
// cannot take a call in a language they do not speak, and an unanswered ring
// reads to a shop as a customer who lost interest.
const WEBHOOK_EVENTS = [
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "CONNECTION_UPDATE",
  "CALL",
  // WE DO NOT OWN THE PAIRING CODE'S LIFETIME (W-5).
  //
  // `PAIRING_TTL_MS` is OUR number. Baileys mints the code, Baileys rotates it,
  // on its own timer, and this is the event that says so. Without it the app is
  // structurally unable to learn that the credential on the traveller's screen
  // has been replaced: it keeps counting down its own 55 seconds over a code
  // that Evolution retired twenty seconds ago, the traveller types it, WhatsApp
  // says "incorrect", and "Try again" - which re-polls and gets the current one
  // - works. That is the first-attempt failure the owner reported, exactly.
  "QRCODE_UPDATED",
] as const;

const CONNECT_FINGERPRINT = { browser: CLIENT_BROWSER, mobile: false } as const;

// A per-message "typing" duration that scales with message length, jittered so
// it is never a flat constant (a faint machine tell). ~18ms/char lands a 40-char
// reply near ~1.9s and a 180-char paragraph near ~4.4s, and it is CAPPED at 4.5s.
// The cap matters for more than realism: Evolution honours this `delay` by
// holding the send request server-side, and evoFetch aborts at 12s - so the hold
// must stay well under that budget or a slow host would time out (status 0) mid
// send. 4.5s leaves ~7.5s of headroom for the actual network round-trip.
const typingDelayForLength = (len: number): number => {
  const base = 1200 + Math.max(0, len) * 18;
  const jittered = base * (0.9 + Math.random() * 0.2);
  return Math.round(Math.max(1200, Math.min(4500, jittered)));
};

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_wa_rate__: Map<string, number[]> | undefined;
}

function rateStore() {
  if (!globalThis.__wheeldeal_wa_rate__) globalThis.__wheeldeal_wa_rate__ = new Map();
  return globalThis.__wheeldeal_wa_rate__;
}

export interface RateVerdict {
  allowed: boolean;
  reason?: string;
  waitSeconds?: number;
  /** True when a CAP refused this, not a host fault. The drain must not
   *  misclassify it as an Evolution outage and re-park by the wrong backoff. */
  rateLimited?: boolean;
  /** Which budget refused it. */
  lane?: SendLane;
}

/** Human-like send budget per user. Durable check + in-memory fast path. */
/**
 * Which budget a send draws from.
 *
 *   intro - a first contact with a shop that has never written back. This is
 *           the risk-bearing lane: unanswered new chats are the quantity
 *           WhatsApp actually meters.
 *   reply - a message inside a thread the shop already answered. Reciprocal
 *           traffic, and the SAFE lane on the documented axis.
 */
export type SendLane = "intro" | "reply";

/**
 * PostgREST filter selecting one lane's rows out of whatsapp_messages.
 *
 * THE NULL-KIND TRAP THE GUARD ALREADY FIXED, STILL LIVE IN THE ANTI-BAN
 * BUDGET.
 *
 * The reply lane was spelled `raw->>kind=not.in.(rfq,custom,human-manual)` -
 * the EXACT predicate wa-guard's REPLY_KIND_FILTER was rewritten to stop using,
 * for the exact reason documented there: when `raw` carries no `kind`,
 * `raw->>kind` is SQL NULL, `NOT (NULL IN (...))` is NULL rather than true, and
 * PostgREST keeps only TRUE. The intro lane's `eq.rfq` drops NULL too. So a
 * sent row with no stamped kind - anything parked by a path that forgot
 * `meta.kind`, plus every row written before kinds existed - was counted in
 * NEITHER budget. Those are free sends as far as the anti-ban ceiling is
 * concerned, on a traveller's personal number, and the caps are the last thing
 * in this system that should quietly under-count.
 *
 * Spelled as an explicit `or`, matching the guard: no kind means reply.
 */
const LANE_FILTER: Record<SendLane, string> = {
  // `raw` is spread from the outbox row's `meta`, so meta.kind lands as
  // raw.kind on every drain-sent row.
  intro: "&raw->>kind=eq.rfq",
  reply: "&or=(raw->>kind.is.null,raw->>kind.not.in.(rfq,custom,human-manual))",
};

export async function checkRateLimit(
  email: string,
  lane: SendLane = "intro"
): Promise<RateVerdict> {
  const now = Date.now();
  const mem = rateStore().get(email) ?? [];
  const recent = mem.filter((t) => now - t < 24 * 3600_000);

  // THE 20s IN-MEMORY GAP IS GONE, and not because pacing stopped mattering.
  //
  // MIN_GAP_MS was enforced only against `globalThis`, which on Cloud Run is
  // per-INSTANCE and empty after every cold start. So it fired on a warm
  // container and missed entirely on a cold one: whether a message was refused
  // depended on which container happened to answer. Nondeterministic pacing is
  // worse than either having the floor or not having it, because nothing
  // downstream can reason about it.
  //
  // guardOutbound's jittered gap and the atomic wa_send_claims slot are both
  // DURABLE and cross-instance, and they are now the single pacing authority.
  // The in-memory counts below survive only as a CONSERVATIVE supplement -
  // they can push a count higher, never lower, so a cold start cannot loosen
  // a budget.

  // Durable hourly/daily counts (webhook + other instances included).
  //
  // THIS IS THE ANTI-BAN BUDGET, AND IT USED TO READ ZERO ON FAILURE.
  //
  // sbSelect returns [] for a 500, a timeout, a DNS blip - anything. Both
  // counters are `.length` over that array, so a Supabase wobble made lastHour
  // and lastDay read 0 and BOTH caps allow. Combined with the kill switch and
  // the daily limits (usage.ts), which failed open through the same helper, one
  // dependency hiccup turned off every send-rate protection the app has, on a
  // traveller's PERSONAL WhatsApp number. Nothing in the system would have said
  // anything until the ban arrived.
  //
  // Unreadable now means at-limit: hold the send until the count can be
  // trusted. A table that does not exist yet stays fail-open, because a fresh
  // install has genuinely sent nothing.
  const hourIso = new Date(now - 3600_000).toISOString();
  const read = await sbSelectStrict<{ id: number; received_at: string }>(
    "whatsapp_messages",
    `select=id,received_at&direction=eq.outbound&to_number=not.in.(session,takeover,cancel)&raw->>sender=eq.${encodeURIComponent(
      email
    )}&received_at=gte.${encodeURIComponent(
      new Date(now - 24 * 3600_000).toISOString()
    )}${LANE_FILTER[lane]}&limit=300`
  );
  if ("error" in read && read.error === "unavailable") {
    return {
      allowed: false,
      reason:
        "Send history is temporarily unreadable, so we cannot confirm your safety budget. Holding the message rather than risking your number.",
      waitSeconds: 120,
    };
  }
  const rows = "rows" in read ? read.rows : [];
  const lastHour = rows.filter((r) => r.received_at >= hourIso).length;
  const lastDay = rows.length;

  const { limitFor } = await import("./usage");
  const maxHour = await limitFor(
    lane === "reply" ? "LIMIT_WA_REPLY_PER_HOUR" : "LIMIT_WA_INTRO_PER_HOUR"
  );
  const maxDay = await limitFor(
    lane === "reply" ? "LIMIT_WA_REPLY_PER_DAY" : "LIMIT_WA_INTRO_PER_DAY"
  );

  // The in-memory supplement is NOT lane-aware (it is just timestamps), so it
  // is applied only to the intro lane. Adding it to the reply lane would let
  // a burst of introductions eat reply headroom through the back door - which
  // is the exact starvation this split exists to end.
  const memHour = lane === "intro" ? recent.filter((t) => now - t < 3600_000).length : 0;
  const memDay = lane === "intro" ? recent.length : 0;

  if (lastHour + memHour >= maxHour) {
    return {
      allowed: false,
      rateLimited: true,
      lane,
      reason:
        lane === "reply"
          ? `Reply cap reached (${maxHour}/h). Answers resume shortly.`
          : `Hourly cap on NEW conversations reached (${maxHour}/h). Replies to shops already talking to you are unaffected.`,
      waitSeconds: 900,
    };
  }
  if (lastDay + memDay >= maxDay) {
    return {
      allowed: false,
      rateLimited: true,
      lane,
      reason:
        lane === "reply"
          ? `Daily reply cap reached (${maxDay}/day).`
          : `Daily cap on new conversations reached (${maxDay}/day). Sending resumes tomorrow.`,
    };
  }
  return { allowed: true };
}

export function recordSend(email: string) {
  const now = Date.now();
  const mem = (rateStore().get(email) ?? []).filter((t) => now - t < 24 * 3600_000);
  mem.push(now);
  rateStore().set(email, mem);
}

// ---- Multi-host Evolution client -----------------------------------------------
//
// Free hosts (Render/Koyeb/etc.) sleep and restart. To stay reliable on 100%
// free tiers we support a POOL of Evolution servers that all point at the SAME
// Supabase Postgres database. Because the Baileys credentials live in that
// shared DB, ANY host can resume a user's session - so if a user's host is
// asleep/down we transparently fail the user over to a healthy host with NO
// re-linking. Users are also sharded across hosts to spread the load and stay
// within each free tier's limits.
//
// Config (Admin -> Keys):
//   EVOLUTION_HOSTS  (preferred) - one "url|apikey" per line/comma, e.g.
//       https://wd-wa-1.onrender.com|KEY1
//       https://wd-wa-2.koyeb.app|KEY2
//   EVOLUTION_API_URL + EVOLUTION_API_KEY - single-host fallback (legacy).

export interface Host {
  url: string;
  key: string;
  /**
   * Calling-code prefixes this host is geographically right for, parsed from
   * the OPTIONAL third field of an EVOLUTION_HOSTS line
   * (`https://sg.example.com|KEY|66,84,855`). Empty = region-neutral, which is
   * what every existing one- or two-field line already means, so opting in is
   * strictly additive. See `wa/host-region` for why geo matters here.
   */
  dialPrefixes: string[];
}

/**
 * ONE HOST PER LINE - AND THE COMMA IS NOT ALWAYS A SEPARATOR.
 *
 * This used to be `multi.split(/[\n,]+/)`, which ran BEFORE a line was split on
 * `|`. That was harmless while a host was two fields, and it silently destroyed
 * the third the moment owner report 8 added one: the documented
 *
 *     https://sg.example.com|KEY|66,84,855,856,60,65
 *
 * became a host claiming only `66`, plus five keyless fragments ("84", "855",
 * ...) that the `url && key` filter then dropped without a word. So geo-aware
 * placement - the whole point of wave C - was inert for exactly the line every
 * one of its own docs tells the owner to paste, and the fleet looked correctly
 * configured while ranking every number as a region MISMATCH.
 *
 * Newlines are the real separator. The comma stays supported only in the legacy
 * shape it was added for - `url1|key1,url2|key2` - which is recognisable
 * because EVERY fragment carries its own `|`. A line whose fragments are not
 * all hosts is one host, commas and all.
 */
export function splitHostLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (!line.includes(",")) return [line];
      const parts = line.split(",").map((p) => p.trim()).filter(Boolean);
      // Legacy comma-separated hosts: every part is itself `url|key`.
      const everyPartIsAHost =
        parts.length > 1 && parts.every((p) => p.split("|").filter(Boolean).length >= 2);
      return everyPartIsAHost ? parts : [line];
    });
}

// Exported for `wa/fleet-truth`, which needs the same host list this module
// routes on. A second parser would be a second source of truth about which
// hosts exist, which is exactly the class of drift the dual-socket detector is
// there to catch.
export async function getHosts(): Promise<Host[]> {
  const multi = (await getConfig("EVOLUTION_HOSTS")) ?? "";
  const parsed = splitHostLines(multi)
    .map((line) => {
      const [url, key, regions] = line.split("|").map((x) => x?.trim());
      return url && key
        ? { url: url.replace(/\/$/, ""), key, dialPrefixes: parseDialPrefixes(regions) }
        : null;
    })
    .filter((h): h is Host => h !== null);
  if (parsed.length) return parsed;

  const [url, key] = await Promise.all([
    getConfig("EVOLUTION_API_URL"),
    getConfig("EVOLUTION_API_KEY"),
  ]);
  if (url && key)
    return [{ url: url.trim().replace(/\/$/, ""), key: key.trim(), dialPrefixes: [] }];
  return [];
}

export async function evolutionConfigured(): Promise<boolean> {
  return (await getHosts()).length > 0;
}

interface Proxy {
  host: string;
  port: string;
  protocol: string;
  username: string;
  password: string;
}

/**
 * Optional residential proxy for the WhatsApp WebSocket. Datacenter IPs (Render
 * / cloud) are a TOP-weighted ban signal per the research (Φ_net); routing
 * through a residential SOCKS5/HTTP proxy that maps to the phone's country is
 * the single biggest network-level protection. Config EVOLUTION_PROXY accepts a
 * URL: socks5://user:pass@host:port  (or http://host:port).
 */
function proxyFromUrl(raw: string): Proxy | null {
  try {
    const u = new URL(raw.trim());
    return {
      protocol: u.protocol.replace(":", "") || "socks5",
      host: u.hostname,
      port: u.port || (u.protocol.startsWith("socks") ? "1080" : "8080"),
      username: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the proxy for a given user, in priority order:
 *   1. EVOLUTION_PROXY_TEMPLATE - ONE residential gateway with `{session}` (and
 *      optionally `{country}`) placeholders. The per-user session token is
 *      persisted on `wa_sessions.proxy_session_id`, minted once, never rotated
 *      automatically - so the exit survives "Try again" (`/instance/delete`
 *      cascades Evolution's own Proxy row away) and there is no pool to resize.
 *   2. EVOLUTION_PROXY - a single shared proxy (pre-revenue / testing).
 * Returns null when neither is set (datacenter IP - baseline behaviour).
 *
 * THE MOD-HASH POOL IS RETIRED, not moved (Tier 2.3). `EVOLUTION_PROXY_POOL`
 * pinned users by `sha256(email) % lines.length`, and a mod-hash remaps
 * roughly (n-1)/n of the fleet whenever the pool resizes - a simultaneous
 * fleet-wide IP change, which is exactly the signal proxying exists to avoid
 * emitting. Do not reintroduce a pool; the sticky-token gateway is the shape
 * every major provider actually sells.
 */
async function parseProxy(email?: string): Promise<Proxy | null> {
  if (email) {
    const { templateProxyUrl } = await import("./wa/proxy");
    const url = await templateProxyUrl(email).catch(() => null);
    if (url) {
      const p = proxyFromUrl(url);
      if (p) return p;
    }
  }
  const raw = (await getConfig("EVOLUTION_PROXY"))?.trim();
  return raw ? proxyFromUrl(raw) : null;
}

/** Deterministic, collision-safe instance name for a user (same on every host). */
export function instanceNameFor(email: string): string {
  return `wd-${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Teardown churn guard (owner report 3, 3.4 #8)
// ---------------------------------------------------------------------------
//
// A destructive logout+delete+recreate is not free: WhatsApp sees the same
// number re-registering from a fresh session, and rapid re-registration is a
// known restriction vector. The connecting-branch above already removed the
// 55s auto-refresh storm; this cooldown catches what remains - a user
// hammering "Try again", a retried request, two tabs - and turns each rebuild
// into a LEDGER FACT (`instance_recreated`) so churn is visible on the risk
// dashboard instead of leaving no trace at all. In-process by design: the
// storm it guards against is a rapid same-instance loop, and a durable stamp
// would put a Supabase read on the pairing path for marginal extra coverage.
const TEARDOWN_COOLDOWN_MS = 90_000;

declare global {
  // eslint-disable-next-line no-var
  var __wd_teardown_at__: Map<string, number> | undefined;
}

function teardownStore(): Map<string, number> {
  if (!globalThis.__wd_teardown_at__) globalThis.__wd_teardown_at__ = new Map();
  return globalThis.__wd_teardown_at__;
}

function inTeardownCooldown(email: string): boolean {
  const at = teardownStore().get(email.trim().toLowerCase()) ?? 0;
  return Date.now() - at < TEARDOWN_COOLDOWN_MS;
}

/** Stamp a destructive rebuild and feed the churn into the risk ledger. */
function markTeardown(email: string, trigger: string): void {
  const key = email.trim().toLowerCase();
  const store = teardownStore();
  if (store.size > 2000) store.clear();
  store.set(key, Date.now());
  void import("./wa/risk-events")
    .then(({ noteRisk }) => noteRisk({ senderKey: key, kind: "instance_recreated", detail: { trigger } }))
    .catch(() => {});
}

/** Webhook token derived from a stable secret so it works across all hosts.
 * Derivation lives in the pure `wa/webhook-token` module (unit-tested); this
 * wrapper keeps the no-hosts gate. There is deliberately NO previous-secret
 * acceptance - the fix for a rotated secret is to RE-ARM Evolution's stored URL
 * with the current token (reassertWebhook), not to accept stale tokens. */
export async function webhookToken(): Promise<string | null> {
  if ((await getHosts()).length === 0) return null;
  return deriveWebhookToken({ secret: process.env.SESSION_SECRET, nodeEnv: process.env.NODE_ENV });
}

/** The canonical public origin the webhook must point at. The admin-set
 * APP_DOMAIN (the GCP gateway URL) WINS over the request origin, so a
 * preview/tap-time origin can never get baked into Evolution. Returns null when
 * neither resolves (caller skips the re-arm). */
export async function canonicalWebhookOrigin(requestOrigin?: string): Promise<string | null> {
  const norm = (s?: string | null): string | null => {
    if (!s) return null;
    let v = s.trim();
    if (!v) return null;
    if (!/^https?:\/\//.test(v)) v = `https://${v}`;
    try {
      return new URL(v).origin;
    } catch {
      return null;
    }
  };
  const configured = await getConfig("APP_DOMAIN").catch(() => null);
  // The request-origin candidate must be reachable from Evolution's side: on
  // Cloud Run the raw request origin is the container bind address
  // (https://0.0.0.0:8080) - registering that as a webhook silently kills
  // inbound. APP_DOMAIN is trusted as-is (an explicit owner choice).
  return norm(configured) ?? routableOrigin(norm(requestOrigin)) ?? null;
}

// Per-instance re-arm throttle. SHARED ACROSS RUNTIME INSTANCES (owner report
// 4, anti-ban A8): it used to live in a per-process Map, so N Cloud Run
// instances each kept their own clock and the "once per hour" re-arm actually
// fired up to N times an hour - unnecessary /webhook/set churn that scales with
// the fleet. A config row is the shared clock every instance reads. The 30s
// runtime-config cache is negligible against a 1h window. In-memory is kept as
// a same-process fast-path so a warm instance does not read the vault every
// send-adjacent re-arm.
declare global {
  // eslint-disable-next-line no-var
  var __wd_wh_rearm__: Map<string, number> | undefined;
}
function rearmStore(): Map<string, number> {
  if (!globalThis.__wd_wh_rearm__) globalThis.__wd_wh_rearm__ = new Map();
  return globalThis.__wd_wh_rearm__;
}
const REARM_THROTTLE_MS = 60 * 60 * 1000; // ~1h per instance unless forced
const rearmConfigKey = (instance: string) => `WH_REARM_${instance}`;

/** The last re-arm time for an instance, from the shared config row (falling
 *  back to this process's own memory). Returns 0 when never re-armed / unread. */
async function lastRearmAt(instance: string): Promise<number> {
  const local = rearmStore().get(instance) ?? 0;
  try {
    const raw = await getConfig(rearmConfigKey(instance));
    const shared = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(shared) ? Math.max(local, shared) : local;
  } catch {
    return local; // vault unreadable - the local clock still throttles this process
  }
}

/** Stamp the re-arm time in BOTH the shared row and this process's memory. */
async function stampRearm(instance: string, atMs: number): Promise<void> {
  rearmStore().set(instance, atMs);
  try {
    const { setConfig } = await import("./runtime-config");
    await setConfig(rearmConfigKey(instance), new Date(atMs).toISOString());
  } catch {
    /* the local stamp above still throttles this process */
  }
}

/**
 * Re-assert the user's webhook URL on Evolution with the CURRENT token, WITHOUT
 * touching the session. This is the fix for a rotated SESSION_SECRET (Evolution
 * still holds a URL with the old token) and for preview-origin pairings. It ONLY
 * ever calls GET /webhook/find + POST /webhook/set - never instance
 * create/logout/delete - so it can never break the working outbound path. Every
 * Evolution call is guarded; read-before-write skips the set when the canonical
 * URL is already registered.
 */
export async function reassertWebhook(
  email: string,
  opts: { requestOrigin?: string; force?: boolean } = {}
): Promise<{
  ok: boolean;
  changed: boolean;
  registeredUrl: string | null;
  skipped?: "no-origin" | "no-host" | "throttled";
}> {
  const instance = instanceNameFor(email);
  const host = await resolveHost(email);
  if (!host) return { ok: false, changed: false, registeredUrl: null, skipped: "no-host" };

  const origin = await canonicalWebhookOrigin(opts.requestOrigin);
  if (!origin) return { ok: false, changed: false, registeredUrl: null, skipped: "no-origin" };

  const now = Date.now();
  if (!opts.force && now - (await lastRearmAt(instance)) < REARM_THROTTLE_MS) {
    return { ok: true, changed: false, registeredUrl: null, skipped: "throttled" };
  }
  await stampRearm(instance, now);

  const token = await webhookToken();
  if (!token) return { ok: false, changed: false, registeredUrl: null, skipped: "no-host" };
  const webhookUrl = `${origin}/api/webhooks/evolution?token=${token}`;
  const events = [...WEBHOOK_EVENTS];

  // Read-before-write: don't churn a healthy instance.
  let registeredUrl: string | null = null;
  try {
    const found = await evoFetch(host, `/webhook/find/${instance}`);
    registeredUrl =
      (typeof found.data?.url === "string" && found.data.url) ||
      (typeof found.data?.webhook?.url === "string" && found.data.webhook.url) ||
      null;
  } catch {
    /* proceed to set */
  }
  if (registeredUrl && sameWebhookTarget(registeredUrl, origin, token)) {
    return { ok: true, changed: false, registeredUrl };
  }

  // ONLY /webhook/set - never touch the session.
  const set = await evoFetch(host, `/webhook/set/${instance}`, {
    method: "POST",
    body: JSON.stringify({
      webhook: { enabled: true, url: webhookUrl, byEvents: false, events },
      enabled: true,
      url: webhookUrl,
      events,
    }),
  }).catch(() => ({ ok: false, status: 0, data: {} }));

  // Visibility when APP_DOMAIN overrode a different request origin.
  if (opts.requestOrigin) {
    try {
      if (new URL(opts.requestOrigin).origin !== origin) {
        await sbInsert("agent_events", [
          {
            kind: "webhook-origin-override",
            vendor_id: "",
            vendor_name: instance,
            detail: `Re-armed webhook to ${origin} (request origin was ${new URL(opts.requestOrigin).origin}).`,
          },
        ]).catch(() => {});
      }
    } catch {
      /* non-fatal */
    }
  }

  return { ok: set.ok, changed: set.ok, registeredUrl: set.ok ? webhookUrl : registeredUrl };
}

/** Read-only webhook diagnostics for the WA doctor: host health, the live
 * connection state, the URL Evolution ACTUALLY holds (via /webhook/find) and how
 * it compares to what we expect (token current/foreign/none, origin match). */
export async function webhookDiagnostics(
  email: string,
  requestOrigin?: string
): Promise<{
  instance: string;
  hosts: { url: string; ok: boolean; detail: string }[];
  liveState: string | null;
  webhook: {
    expectedUrl: string | null;
    registeredUrl: string | null;
    tokenState: TokenState;
    originMatch: boolean | null;
  };
}> {
  const instance = instanceNameFor(email);
  const host = await resolveHost(email);
  const token = await webhookToken();
  const origin = await canonicalWebhookOrigin(requestOrigin);
  const expectedUrl = origin && token ? `${origin}/api/webhooks/evolution?token=${token}` : null;

  const hosts: { url: string; ok: boolean; detail: string }[] = [];
  for (const h of await getHosts()) {
    const hd = await hostHealthDetail(h);
    hosts.push({ url: h.url, ok: hd.ok, detail: hd.detail });
  }

  let registeredUrl: string | null = null;
  if (host) {
    const found = await evoFetch(host, `/webhook/find/${instance}`).catch(() => ({
      ok: false,
      status: 0,
      data: {} as any,
    }));
    registeredUrl =
      (typeof found.data?.url === "string" && found.data.url) ||
      (typeof found.data?.webhook?.url === "string" && found.data.webhook.url) ||
      null;
  }
  const { tokenState, originMatch } = classifyRegisteredWebhook(registeredUrl, token, origin);
  const liveState = await connectionState(email).catch(() => null);
  return { instance, hosts, liveState, webhook: { expectedUrl, registeredUrl, tokenState, originMatch } };
}

// ---- host health (short-lived cache) --------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __wd_wa_health__: Map<string, { ok: boolean; detail: string; exp: number }> | undefined;
}
function healthStore() {
  if (!globalThis.__wd_wa_health__) globalThis.__wd_wa_health__ = new Map();
  return globalThis.__wd_wa_health__;
}

/**
 * Probe one host and explain the result. "ok" means reachable AND usable for
 * placement: a 500 is a crashing box, and a 401/403 is a box that answers but
 * rejects our API key - both are `ok:false`, because `resolveHost` must not put
 * a real user on a host we cannot send through (owner report 11 H2.1). The
 * human-readable detail powers the owner panel's "why is this host down" line
 * and the per-host Test API output.
 */
async function hostHealthDetail(h: Host): Promise<{ ok: boolean; detail: string }> {
  const cache = healthStore();
  const hit = cache.get(h.url);
  if (hit && hit.exp > Date.now()) return { ok: hit.ok, detail: hit.detail };

  let ok = false;
  let detail = "";
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    // 4500ms was BELOW the thing it measures. Render's own health check gives
    // a host 5s, and a loaded Evolution box answering fetchInstances in ~5-6s
    // is slow, not down - so this probe reported the fleet unhealthy at
    // exactly the moments the owner most needed to know the difference. 9s
    // still returns well inside any caller's budget.
    const timer = setTimeout(() => ctrl.abort(), 9_000);
    const res = await fetch(`${h.url}/instance/fetchInstances`, {
      headers: { apikey: h.key },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    const ms = Date.now() - started;
    if (res.status === 401 || res.status === 403) {
      // ALIVE BUT UNUSABLE (owner report 11 H2.1). A wrong API key means the box
      // answers, but we cannot send through it - and it used to be rated
      // `ok:true` ("401 still = alive"), so `resolveHost` placed real users on
      // it. Every send then 401s, and the send path classified an Evolution
      // apikey rejection as an ACCOUNT-level restriction, tripping ban-recovery
      // on the traveller's own number. A single mistyped key silently drove its
      // whole cohort toward a ban. It is NOT healthy for placement; the detail
      // still tells the owner exactly what to fix.
      ok = false;
      detail = `Awake but rejecting the API key (HTTP ${res.status}) - this host's AUTHENTICATION_API_KEY does not match the key in EVOLUTION_HOSTS. No user can send through it until they match.`;
    } else if (res.status < 500) {
      ok = true; // reachable and not erroring
      detail = `Healthy (HTTP ${res.status}, ${ms}ms).`;
    } else {
      detail = `Server error HTTP ${res.status} - Evolution is crashing. Known causes: the OnWhatsappCache/Prisma bug (fix: redeploy the updated render.yaml Blueprint - it adds Redis + DATABASE_SAVE_IS_ON_WHATSAPP=false) or a bad DATABASE_CONNECTION_URI.`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unreachable";
    detail = /abort/i.test(msg)
      ? "No response within 9s - host is asleep or cold-starting. Keep-awake cron should wake it; the pool routes around it meanwhile."
      : `Unreachable: ${msg}. Check the URL is correct and the service is deployed.`;
  }
  cache.set(h.url, { ok, detail, exp: Date.now() + 15_000 });
  return { ok, detail };
}

async function hostHealthy(h: Host): Promise<boolean> {
  return (await hostHealthDetail(h)).ok;
}

function hostPref(email: string, url: string): number {
  return parseInt(
    createHash("sha256").update(`${email.toLowerCase()}:${url}`).digest("hex").slice(0, 8),
    16
  );
}

/**
 * How many paired users each host currently carries (for even load-balancing).
 * Cached 10s so a burst of concurrent sends from hundreds of users does not fire
 * one table scan per message - the count only needs to be approximately fresh.
 */
declare global {
  // eslint-disable-next-line no-var
  var __wd_wa_counts__: { data: Record<string, number>; exp: number } | undefined;
}
async function hostUserCounts(): Promise<Record<string, number>> {
  const cache = globalThis.__wd_wa_counts__;
  if (cache && cache.exp > Date.now()) return cache.data;
  const rows = await sbSelect<{ host_url: string | null }>(
    "wa_sessions",
    "select=host_url&status=eq.open&limit=50000"
  );
  const counts: Record<string, number> = {};
  for (const r of rows) if (r.host_url) counts[r.host_url] = (counts[r.host_url] ?? 0) + 1;
  globalThis.__wd_wa_counts__ = { data: counts, exp: Date.now() + 10_000 };
  return counts;
}

/** Nudge the cached count when we place/relocate a user, so back-to-back new
 *  users in the same 10s window don't all pile onto the same "emptiest" host. */
function bumpHostCount(url: string, by = 1) {
  const cache = globalThis.__wd_wa_counts__;
  if (cache && cache.exp > Date.now()) {
    cache.data[url] = (cache.data[url] ?? 0) + by;
  }
}

/**
 * Cap of paired users per host (owner-adjustable).
 *
 * 25, not 40. Evolution's own documented production floor is 2 vCPU / 2 GB,
 * a Render `starter` is 512 MB, and render.yaml itself estimates only
 * "~30-50 live sockets" for that box while PRODUCTION-READINESS puts the safe
 * occupancy at 25-30. The failure mode when this is wrong is not a slow queue:
 * the container OOMs, every socket on it drops at once, and each of those
 * numbers is then a personal WhatsApp account reconnecting in a storm. Adding
 * capacity later does not un-ban a traveller's number, so the default sits at
 * the conservative end and the owner raises it deliberately.
 */
export async function maxPerHost(): Promise<number> {
  const v = Number(await getConfig("EVOLUTION_MAX_PER_HOST"));
  return Number.isFinite(v) && v > 0 ? v : 25;
}

/**
 * OCCUPANCY AGAINST THE CAP - the choke point with the worst failure mode.
 *
 * Every other ceiling in this system degrades into a queue. This one degrades
 * into a BANNED PERSONAL WHATSAPP NUMBER, which no amount of capacity added
 * afterwards reverses. The pool panel already showed "N users" per host; a
 * bare count says nothing about how close that is to the wall, so the number
 * that matters (used / cap) was left for the reader to compute.
 *
 * Exported separately from `hostsStatus` so the choke-point panel can read the
 * cap WITHOUT re-probing every host's health.
 */
export async function hostCapacity(): Promise<{
  cap: number;
  hosts: { url: string; users: number }[];
  users: number;
  capacity: number;
}> {
  const [hosts, counts, cap] = await Promise.all([getHosts(), hostUserCounts(), maxPerHost()]);
  const rows = hosts.map((h) => ({ url: h.url, users: counts[h.url] ?? 0 }));
  return {
    cap,
    hosts: rows,
    users: rows.reduce((s, h) => s + h.users, 0),
    capacity: rows.length * cap,
  };
}

/**
 * The Evolution host this user's session should live on right now.
 *
 * Scales cleanly to many hosts: health is probed in PARALLEL, a paired user
 * sticks to their (healthy) host, and brand-new users are placed on the
 * LEAST-LOADED healthy host under the per-host cap - so load spreads evenly and
 * no user is left without a home.
 *
 * ...AND, since owner report 8, on a host that is geographically right for
 * their NUMBER where one has capacity. A number transmitting from a datacenter
 * on the wrong continent is a separately-scored ban signal, and correcting it
 * costs nothing: it is only a question of which box a user lands on at link
 * time. Load still breaks every tie, so an opted-in fleet spreads exactly as
 * evenly as a neutral one - see `wa/host-region` for the tiers.
 *
 * @param phoneHint the number being linked, when the caller knows it (the
 *   connect route does). Omitted elsewhere: placement happens once, at link
 *   time, and every later call finds `host_url` already stored.
 */
/**
 * The number this account has linked, for a placement whose caller did not
 * carry one (a re-placement after a host died, say). Best-effort: a miss just
 * means the ranking treats every host as neutral, which is the pre-existing
 * behaviour, so this must never throw into a link attempt.
 */
async function linkedNumberFor(email: string): Promise<string> {
  const rows = await sbSelect<{ phone: string | null }>(
    "app_users",
    `select=phone&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
  ).catch(() => [] as { phone: string | null }[]);
  return digitsOnly(rows[0]?.phone ?? "");
}

/**
 * Record that a number was placed on a host that claims a different region.
 * Fire-and-forget and failure-swallowing: this is a note about a decision that
 * has already been made correctly, never a gate on it.
 */
async function noteHostGeoMismatch(email: string, hostUrl: string, digits: string): Promise<void> {
  try {
    await sbInsert("agent_events", [
      {
        kind: "host-geo-mismatch",
        user_email: email,
        to_number: digits,
        vendor_id: "",
        vendor_name: hostUrl,
        detail:
          `Linked +${digits.slice(0, 4)}... on ${hostUrl}, which declares other regions - ` +
          `every host claiming this number's country was at capacity or unhealthy. ` +
          `A number transmitting from the wrong region is a scored WhatsApp signal; ` +
          `adding capacity in the right region clears it.`,
      },
    ]);
  } catch {
    /* a note about a placement must never be able to break the placement */
  }
}

async function resolveHost(email: string, phoneHint?: string | null): Promise<Host | null> {
  const hosts = await getHosts();
  if (hosts.length === 0) return null;

  // ALREADY PLACED USERS COME FIRST, AND THE CAP DOES NOT APPLY TO THEM.
  //
  // Read before anything else, because it is the answer on every call except a
  // link: the cap governs PLACEMENT, and evicting a user who is already on a
  // full host would break sends for someone who is not the problem.
  const rows = await sbSelect<{ host_url: string | null }>(
    "wa_sessions",
    `select=host_url&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
  );
  const stored = rows[0]?.host_url;

  // THE PLACEMENT DECISION ITSELF LIVES IN `wa/host-placement`, as a pure
  // function. It has produced three separate defects - the single-host cap
  // escape, the "place them anyway" fallback, and the missing occupant
  // exemption on the multi-host branch - and every test written about it was a
  // regex over this file, so none of them could have caught any of the three.
  // The IO stays here; the shape of the decision is now executable.
  //
  // The health probe is skipped entirely with one host: there is nothing to
  // fail over TO, and connectInstance probes this host directly a few lines
  // later (the B1 honesty gate).
  let healthy: Host[] | undefined;
  if (hosts.length > 1) {
    const health = await Promise.all(hosts.map(async (h) => ({ h, ok: await hostHealthy(h) })));
    healthy = health.filter((x) => x.ok).map((x) => x.h);
  }
  const counts = await hostUserCounts();
  const digits = digitsOnly(phoneHint ?? "") || (await linkedNumberFor(email));
  const chosen = placeHost<Host>({
    hosts,
    stored,
    counts,
    cap: await maxPerHost(),
    healthy,
    digits,
    pref: (h) => hostPref(email, h.url),
  });
  // A MISMATCHED PLACEMENT IS A DECISION, SO IT LEAVES A RECORD. It is the
  // right call - a scored signal beats a user who cannot link at all - but it
  // is invisible from the host panel, which would otherwise show a fleet that
  // is uniformly green while a real risk quietly accumulates on it.
  if (chosen && digits && affinityFor(chosen, digits) === AFFINITY_MISMATCH) {
    void noteHostGeoMismatch(email, chosen.url, digits);
  }
  // Reserve a slot immediately so concurrent new users spread out instead of
  // stampeding onto the same emptiest host before the DB count catches up.
  if (chosen && chosen.url !== stored) bumpHostCount(chosen.url);
  return chosen;
}

/** Live health + load + reason of every configured host (for the owner panel). */
export async function hostsStatus(): Promise<
  { url: string; healthy: boolean; users: number; detail: string }[]
> {
  const [hosts, counts] = await Promise.all([getHosts(), hostUserCounts()]);
  return Promise.all(
    hosts.map(async (h) => {
      const { ok, detail } = await hostHealthDetail(h);
      return { url: h.url, healthy: ok, users: counts[h.url] ?? 0, detail };
    })
  );
}

/**
 * On-demand deep test of ONE host: forces a fresh probe (bypassing the 15s
 * cache) and, if the key is accepted, reports how many Evolution instances that
 * server is actually running - so the owner can confirm a specific server is
 * live and its API key/credentials work, right from the Keys screen.
 */
export async function testOneHost(
  url: string
): Promise<{ url: string; healthy: boolean; detail: string; instances?: number }> {
  const hosts = await getHosts();
  const host = hosts.find((h) => h.url === url.replace(/\/$/, ""));
  if (!host) return { url, healthy: false, detail: "This host is not in the pool anymore." };
  healthStore().delete(host.url); // force a live re-check
  const { ok, detail } = await hostHealthDetail(host);
  if (!ok) return { url: host.url, healthy: false, detail };
  // Alive + key accepted: count the live instances as a concrete proof of life.
  try {
    const res = await fetch(`${host.url}/instance/fetchInstances`, {
      headers: { apikey: host.key },
      cache: "no-store",
    });
    const data = await res.json().catch(() => null);
    const instances = Array.isArray(data) ? data.length : undefined;
    return {
      url: host.url,
      healthy: true,
      detail:
        instances === undefined
          ? "Live and the API key works."
          : `Live, API key accepted - running ${instances} WhatsApp instance(s).`,
      instances,
    };
  } catch {
    return { url: host.url, healthy: true, detail: "Live and the API key works." };
  }
}

async function evoFetch(
  host: Host,
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: any }> {
  // HARD TIMEOUT. undici's fetch has no short overall request timeout, so a
  // cold/asleep Evolution host (Render free tier) could hang the caller until
  // The platform kills the whole function - which, on the drain path, permanently
  // LOSES an already-claimed outbox row. Bounding every call well under the 60s
  // function limit turns a fatal hang into a transient failure the drain
  // re-queues. The sibling probes (hostHealthDetail 4.5s, pingAllHosts 7s)
  // already do this; the actual send/connect path must too.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${host.url}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        apikey: host.key,
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      status: 0,
      data: { error: aborted ? "evolution host timed out (12s)" : e instanceof Error ? e.message : "network error" },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the user's host and call it. */
async function evo(
  email: string,
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: any }> {
  const host = await resolveHost(email);
  if (!host) return { ok: false, status: 0, data: { error: "not configured" } };
  return evoFetch(host, path, init);
}

/**
 * BLUE TICKS, ON A HUMAN'S CLOCK (owner report 4, anti-ban A1).
 *
 * A real linked device sends read receipts: you open the chat, WhatsApp marks
 * the message read, and only THEN do you reply. Our sessions did neither -
 * `readMessages:false` at link time and no markMessageAsRead anywhere - so
 * every one of our numbers presented the same never-reads-then-replies pattern,
 * which is one of the strongest behavioural bot tells on the platform (research
 * corroborated: read-receipt absence clusters accounts).
 *
 * Fired post-store from ingest with a humanized delay (see the caller), so the
 * receipt lands 2-7s after arrival - the "just glanced at my phone" beat, not
 * an instant machine ack. Best-effort by contract: a failed receipt must never
 * affect the reply, but it is COUNTED (agent_events) rather than swallowed, so
 * the @lid-recipient silent-failure class that bit sendPresence cannot hide
 * here. Product note: shops now see blue ticks - the pre-link consent copy
 * says so.
 */
export async function markMessageAsRead(
  email: string,
  key: { remoteJid?: string; fromMe?: boolean; id?: string } | null | undefined
): Promise<boolean> {
  if (!email || !key?.remoteJid || !key?.id) return false;
  const instance = instanceNameFor(email);
  const r = await evo(email, `/chat/markMessageAsRead/${instance}`, {
    method: "POST",
    body: JSON.stringify({
      readMessages: [{ remoteJid: key.remoteJid, fromMe: Boolean(key.fromMe), id: key.id }],
    }),
  }).catch(() => ({ ok: false, status: 0, data: {} }));
  if (!r.ok) {
    // COUNTED, not swallowed - the @lid presence bug class was invisible for
    // exactly this reason. Throttled by the caller's own cadence (one inbound
    // per shop message), so no extra throttle is needed here.
    await sbInsert("agent_events", [
      {
        kind: "wa-read-failed",
        user_email: email,
        vendor_name: digitsOnly(key.remoteJid) || key.remoteJid,
        detail: `markMessageAsRead ${r.status} for ${instance}`.slice(0, 200),
      },
    ]).catch(() => {});
  }
  return r.ok;
}

/** The humanized "I just glanced at my phone" delay before a blue tick, in ms.
 *  Floor 2s + exponential tail (mean ~4s), capped so it stays inside the
 *  webhook's after-work budget - a receipt that never leaves the instance is
 *  worse than a slightly-quicker one. Pure + injectable for the test. */
export function readReceiptDelayMs(rand: () => number = Math.random): number {
  const u = Math.min(Math.max(rand(), 0), 0.999_999);
  const tail = -Math.log(1 - u) * 4_000;
  return Math.round(Math.min(7_000, 2_000 + tail));
}

/** Keep-awake: ping every configured host so none of them sleeps. */
export async function pingAllHosts(): Promise<{ url: string; ok: boolean }[]> {
  const hosts = await getHosts();
  return Promise.all(
    hosts.map(async (h) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 7000);
        const res = await fetch(`${h.url}/`, { signal: ctrl.signal, cache: "no-store" });
        clearTimeout(timer);
        return { url: h.url, ok: res.status < 500 };
      } catch {
        return { url: h.url, ok: false };
      }
    })
  );
}

/** Look up which user owns an instance (used by the webhook). */
export async function emailForInstance(instance: string): Promise<string | null> {
  const read = await resolveInstanceEmail(instance);
  return read.ok ? read.email : null;
}

/**
 * WHOSE INBOX IS THIS? - with "I could not find out" kept separate from "nobody".
 *
 * THE DEFECT THIS EXISTS TO KILL. Every inbound WhatsApp frame is attributed to
 * a traveller by looking up the Evolution instance here. Read through the
 * permissive `sbSelect`, a Supabase timeout and an unknown instance produced the
 * same `null` - and the webhook treats `null` as "not one of ours": it drops
 * every frame in the batch with `continue`, leaves `retryable` false, and
 * answers 200. Evolution takes a 200 as delivered and NEVER REDELIVERS.
 *
 * So a database blip of a few seconds silently and permanently destroyed every
 * shop reply that arrived during it - along with the read/delivery receipts,
 * inbound calls and connection.update transitions that resolve through the same
 * read. The only trace said "unknown Evolution instance", which sends whoever
 * investigates to look at Evolution rather than at the database.
 *
 * `ok: false` means UNKNOWN. The webhook must mark the delivery retryable and
 * answer non-2xx so Evolution sends it again, which is the entire point of
 * having a retry protocol at all.
 */
export async function resolveInstanceEmail(
  instance: string
): Promise<{ ok: true; email: string | null } | { ok: false }> {
  const read = await sbSelectStrict<{ email: string }>(
    "wa_sessions",
    `select=email&instance_name=eq.${encodeURIComponent(instance)}&limit=1`
  );
  // "missing" is a database with no wa_sessions table at all - nobody has ever
  // linked, so there genuinely is no receiver. That is an answer, not an outage.
  if ("error" in read) return read.error === "missing" ? { ok: true, email: null } : { ok: false };
  return { ok: true, email: read.rows[0]?.email ?? null };
}

/**
 * How long a pairing code is assumed live when nothing better is known.
 *
 * A CEILING, NOT A CONTRACT (W-5). WhatsApp codes die in about a minute, so 55s
 * is a reasonable outer bound - but the code is minted and rotated by Baileys,
 * on Baileys' timer, and this constant cannot know when that happened. Treating
 * it as authoritative is what stranded travellers on a dead code: the countdown
 * said 30 seconds left while Evolution had already replaced the credential.
 *
 * The truth now arrives as `QRCODE_UPDATED`, which re-stamps
 * `wa_sessions.pairing_code_issued_at`; the window is measured from that stamp,
 * so a rotation restarts the clock. This number is only the fallback for the
 * span before any rotation has been observed.
 */
export const PAIRING_TTL_MS = 55_000;

/**
 * Evolution rotated the pairing credential - re-anchor our window to now.
 *
 * Narrow on purpose: it touches one column and never the status, because a
 * rotation says nothing about whether the socket opened. Never throws; a
 * missed stamp degrades to the old fixed-window behaviour rather than
 * breaking the link.
 */
export async function notePairingRotation(email: string): Promise<void> {
  try {
    const { sbUpdate } = await import("./runtime-config");
    await sbUpdate(
      "wa_sessions",
      `email=eq.${encodeURIComponent(email.trim().toLowerCase())}`,
      { pairing_code_issued_at: new Date().toISOString() }
    );
  } catch {
    /* the countdown is a hint, never a gate */
  }
}

async function saveSession(
  email: string,
  instance: string,
  status: string,
  hostUrl?: string,
  pairingIssuedAt?: Date | null
) {
  await sbInsert(
    "wa_sessions",
    [
      {
        // ALWAYS lowercased: every read (hasSessionRow, storedStatus,
        // resolveHost) queries email=eq.<lowercase>. A mixed-case email (e.g.
        // from Google sign-in) written raw made a truly-connected user look
        // "not connected" to the import/teach features.
        email: email.trim().toLowerCase(),
        instance_name: instance,
        status,
        ...(hostUrl ? { host_url: hostUrl } : {}),
        ...(pairingIssuedAt !== undefined
          ? { pairing_code_issued_at: pairingIssuedAt ? pairingIssuedAt.toISOString() : null }
          : {}),
        updated_at: new Date().toISOString(),
      },
    ],
    "email"
  );
}

// ---- Idle pause: quiet the session while the user is not using the app ------
//
// WhatsApp shows a linked device as "connected" as long as the pairing exists;
// what makes it feel intrusive is the device appearing ACTIVE around the
// clock. When the app has been idle past the policy window we push presence
// "unavailable" (no online status, no activity), and the first app use flips
// it back - the user never re-pairs.

async function setInstancePresence(email: string, presence: "available" | "unavailable") {
  const instance = instanceNameFor(email);
  await evo(email, `/instance/setPresence/${instance}`, {
    method: "POST",
    body: JSON.stringify({ presence }),
  });
}

/** App-activity heartbeat (called from the status poll while the app is open). */
export async function touchActivity(email: string): Promise<void> {
  try {
    const { sbUpdate } = await import("./runtime-config");
    const rows = await sbSelect<{ idle_paused: boolean | null }>(
      "wa_sessions",
      `select=idle_paused&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
    );
    if (rows[0]?.idle_paused) {
      setInstancePresence(email, "available").catch(() => {});
    }
    await sbUpdate("wa_sessions", `email=eq.${encodeURIComponent(email.toLowerCase())}`, {
      last_active: new Date().toISOString(),
      idle_paused: false,
    });
  } catch {
    /* best-effort */
  }
}

/** Quiet every session idle past the policy window. Returns paused count. */
export async function pauseIdleSessions(): Promise<number> {
  try {
    const { getPolicies } = await import("./wa-guard");
    const { sbUpdate } = await import("./runtime-config");
    const p = await getPolicies();
    const cutoff = new Date(
      Date.now() - Math.max(1, p.idle_pause_hours) * 3600_000
    ).toISOString();
    const idle = await sbSelect<{ email: string }>(
      "wa_sessions",
      `select=email&status=eq.open&idle_paused=eq.false&last_active=lt.${encodeURIComponent(
        cutoff
      )}&limit=10`
    );
    let n = 0;
    for (const row of idle) {
      await setInstancePresence(row.email, "unavailable").catch(() => {});
      await sbUpdate(
        "wa_sessions",
        `email=eq.${encodeURIComponent(row.email.toLowerCase())}`,
        { idle_paused: true }
      );
      n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * Last durable status we recorded for this user's session. Returns the sentinel
 * "unknown" when the store is UNREACHABLE (transient Supabase blip) so callers
 * can fail SAFE and never mistake a DB hiccup for "never linked" - the old
 * sbSelect collapsed every error to [] -> null -> "not connected".
 */
async function storedStatus(email: string): Promise<string | null> {
  // EXACT match on the lowercased email. saveSession ALWAYS writes
  // email.trim().toLowerCase() (see its comment), so rows are guaranteed
  // lowercase and eq. is correct. The old `ilike.` was a cross-user hazard: an
  // underscore in one user's email is a single-char SQL wildcard, so
  // `a_b@x.com` could match a DIFFERENT registered user `axb@x.com` and return
  // their linked state.
  const res = await sbSelectStrict<{ status: string }>(
    "wa_sessions",
    `select=status&email=eq.${encodeURIComponent(email.trim().toLowerCase())}&limit=1`
  );
  if ("error" in res) return res.error === "unavailable" ? "unknown" : null;
  return res.rows[0]?.status ?? null;
}

/** True once the user has successfully paired (and hasn't explicitly logged out). */
export async function wasEverConnected(email: string): Promise<boolean> {
  return (await storedStatus(email)) === "open";
}

/**
 * Linked FOR THE UI: the user completed pairing at least once (durable status
 * "open"), OR the store is momentarily unreachable (fail SAFE - a DB blip must
 * never push a genuinely-paired user to re-link). A mere "connecting" row
 * (connectInstance handed out a pairing code but the socket never opened) is
 * explicitly NOT linked. hasSessionRow returns true for ANY row including that
 * "connecting" one, which made /api/wa/status report connected=true on the
 * first 3s poll of a first-time pairing - clearing the code before the user
 * could enter it and stranding them "linked but never open". The status/health
 * UI must use THIS, not raw row existence.
 */
export async function isLinkedForUi(email: string): Promise<boolean> {
  return isLinkedFromStatus(await storedStatus(email));
}

/**
 * True if the user has a session row at all (i.e. they went through linking on
 * this or any host). Used by the send/status paths so a transient reconnect is
 * NEVER mistaken for "not connected" - the user is told to wait, never to
 * re-link. FAILS SAFE: on an unreachable store it returns true (assume still
 * linked), so a Supabase blip can never tell a paired user to re-link.
 */
export async function hasSessionRow(email: string): Promise<boolean> {
  const res = await sbSelectStrict<{ email: string }>(
    "wa_sessions",
    `select=email&email=eq.${encodeURIComponent(email.trim().toLowerCase())}&limit=1`
  );
  if ("error" in res) return res.error === "unavailable"; // unavailable -> assume linked
  return res.rows.length > 0;
}

/** Record that the session is live and paired (never downgraded automatically). */
export async function markOpen(email: string) {
  await saveSession(email, instanceNameFor(email), "open");
}

/**
 * NOTHING IN THIS CODEBASE EVER WROTE "close".
 *
 * `wa_sessions.status` only ever went to "open" or "connecting", so a link that
 * WhatsApp had severed still read as connected: `isLinkedForUi` said linked,
 * `/api/wa/status` said CONNECTED, `classifySafety`'s one red branch was
 * unreachable, and the outbox kept retrying into a dead session for 24 hours
 * before dropping the messages silently. The traveller was told everything was
 * fine while nothing they sent could arrive.
 *
 * Only call this for a cause classified `sessionDead` - see
 * `wa/disconnect-reason.ts`. A transient close (428/440/515, or a 401 inside
 * the pairing handshake) must NOT land here, or we would log people out mid-link.
 */
export async function markClosed(email: string, reason: string) {
  await saveSession(email, instanceNameFor(email), "close");
  await sbInsert("agent_events", [
    {
      kind: "wa-session-closed",
      detail:
        `${email}: WhatsApp link closed (${reason}). The session is dead until ` +
        `the user re-links - queued messages park instead of retrying into it.`,
    },
  ]).catch(() => {});
}

/**
 * Make sure the session is live, resuming from saved credentials if the
 * connection dropped (Render free tier sleeps/restarts). Returns quickly if
 * already open; otherwise kicks a reconnect and polls within a small budget.
 * Does NOT require the user to re-link as long as their creds are persisted.
 */
export async function ensureConnected(
  email: string,
  budgetMs = 6000
): Promise<{ ok: boolean; state: string | null }> {
  // THE DEAD-LINK REFUSAL LIVES HERE, NOT ONLY IN THE GUARD.
  //
  // Owner report 8 wave A put a `wa_sessions.status === "close"` gate inside
  // guardOutbound, because `ensureConnected` fires POST /instance/create + GET
  // /instance/connect unconditionally - a fresh device registration against a
  // number WhatsApp has just severed, which ANTI-BAN.md's first line calls a
  // fresh strike. But the gate only covered the callers that go THROUGH the
  // guard, and three do not: /api/outreach/mass hits this at the top of a batch
  // (before its first guardOutbound, hundreds of lines later), the admin
  // training import calls it bare, and sendFromUser calls it before its own
  // checks. So tapping "bargain with all shops" on a severed number still
  // registered a device against it, once per tap.
  //
  // Refusing HERE means the route, the drain and sendFromUser all inherit it
  // and none of them has to remember. Fails OPEN by construction: storedStatus
  // returns "unknown" when the read is unavailable and null when there is no
  // row, and only the literal "close" refuses - a Supabase blip must never
  // block a healthy re-pair.
  if ((await storedStatus(email)) === "close") {
    return { ok: false, state: "close" };
  }

  const instance = instanceNameFor(email);
  const host = await resolveHost(email);
  if (!host) return { ok: false, state: null };

  let state = await connectionState(email);
  if (state === "open") {
    markOpen(email).catch(() => {});
    return { ok: true, state };
  }

  // If we've failed the user over to a different host, the instance may not
  // exist there yet - creating it makes Evolution load the SHARED creds from
  // the database and reconnect the session (no re-linking needed).
  //
  // CRITICAL: this recreate MUST carry the webhook, or a host restart silently
  // recreates a webhook-LESS instance (outbound keeps working, inbound stops).
  // Resolve the canonical origin (APP_DOMAIN - the GCP gateway) + current token.
  const recreateOrigin = await canonicalWebhookOrigin();
  const recreateToken = await webhookToken();
  const recreateEvents = [...WEBHOOK_EVENTS];
  const recreateWebhook =
    recreateOrigin && recreateToken
      ? {
          webhook: {
            url: `${recreateOrigin}/api/webhooks/evolution?token=${recreateToken}`,
            byEvents: false,
            events: recreateEvents,
          },
        }
      : {};
  await evoFetch(host, "/instance/create", {
    method: "POST",
    body: JSON.stringify({
      instanceName: instance,
      qrcode: false,
      integration: "WHATSAPP-BAILEYS",
      // Standard Chrome-on-macOS fingerprint + web protocol on the failover
      // recreate too, so a reconnect never re-links under the flagged default.
      ...CONNECT_FINGERPRINT,
      // Privacy: never backfill the user's full personal history on a failover
      // recreate either (data minimization must be set at create time on EVERY
      // instance/create path, not applied post-hoc via a best-effort settings call).
      syncFullHistory: false,
      ...recreateWebhook,
    }),
  });
  // Kick a reconnect on the resolved host.
  await evoFetch(host, `/instance/connect/${instance}`);
  // NEVER regress a durable "open" to "connecting" on a failed/unknown probe:
  // a transient host outage must not make a linked user read as "never
  // connected" (wasEverConnected == status "open"). Only record "connecting"
  // when we are not already durably open. The success branch below still
  // writes "open" when the socket returns; if it never returns, the row
  // correctly stays "open" = still-linked (genuine unlink goes through the
  // explicit logout/ban paths, never this transient one).
  const prior = await storedStatus(email);
  // A null stored status means the user is NOT linked (never paired, or just
  // disconnected). A background drain must NEVER mint a "connecting" session for
  // them - that resurrected a torn-down link. Only ever record "connecting" for
  // a session that genuinely exists and is not already durably open/unknown.
  if (prior === null) return { ok: false, state };
  if (prior !== "open" && prior !== "unknown") {
    await saveSession(email, instance, "connecting", host.url);
  }

  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    state = await connectionState(email);
    if (state === "open") {
      markOpen(email).catch(() => {});
      await saveSession(email, instance, "open", host.url);
      // Ensure the reconnected instance points at the current webhook URL
      // (throttled; find+set only - never re-arms more than ~1/hour/instance).
      reassertWebhook(email).catch(() => {});
      return { ok: true, state };
    }
  }
  return { ok: false, state };
}

/**
 * Create (or reuse) the user's instance and point its webhook at us.
 * Returns a QR code (base64 image) while the session is not yet paired.
 *
 * `opts.fresh` is PERMISSION to rebuild, never an order: it lets an explicit
 * user "Try again" tap force the destructive logout+delete+recreate. It is
 * deliberately NOT set by the client's automatic code-expiry refresh, because
 * a `connecting` instance is a live handshake and re-issuing its code via
 * /instance/connect achieves the same result without any teardown.
 */
export async function connectInstance(
  email: string,
  appOrigin: string,
  phone?: string,
  opts?: { fresh?: boolean }
): Promise<{
  ok: boolean;
  state?: string;
  qr?: string;
  pairingCode?: string;
  /** Milliseconds the returned pairing code is still expected to be valid. */
  pairingExpiresInMs?: number;
  /** True when the Evolution host itself is down/restarting (crash-loop, not a
   *  user problem) - the client shows an honest "server restarting" state. */
  hostDown?: boolean;
  error?: string;
}> {
  const instance = instanceNameFor(email);
  // THE ONE CALLER THAT KNOWS THE NUMBER. Placement happens here and nowhere
  // else in practice (every later call finds `host_url` stored), so this is
  // the only site where passing the phone changes which box a user lands on -
  // and therefore whether their number transmits from its own region.
  const host = await resolveHost(email, phone);
  if (!host) {
    // TWO DIFFERENT FACTS, ONE SENTENCE. resolveHost returns null both when no
    // Evolution host is configured AT ALL and when every configured host is at
    // its per-number cap, and both used to be reported as "not set up yet" -
    // which sends the owner to Admin -> Keys to fix a setting that is already
    // correct, while the real answer is "add a host or raise the cap". The
    // capacity case is also the one a TESTER can hit, so it has to say
    // something a tester can act on.
    const configured = await getHosts();
    return {
      ok: false,
      error: configured.length
        ? "WhatsApp linking is at capacity right now - every connection slot is in use. Try again shortly, or ask the owner to add a host."
        : "The WhatsApp connector is not set up yet.",
    };
  }

  // HONESTY GATE (B1): with a single host there is no failover, and resolveHost
  // skips probing - so probe HERE. Pairing against a crash-looping server just
  // mints codes that die mid-handshake with zero signal; tell the user the
  // truth instead of showing an undifferentiated timeout.
  {
    const health = await hostHealthDetail(host);
    if (!health.ok) {
      return {
        ok: false,
        hostDown: true,
        error:
          "Our WhatsApp server is restarting right now - nothing is wrong on your side. Give it a minute, then tap Try again.",
      };
    }
  }
  const token = await webhookToken();
  // Canonicalize before registering: APP_DOMAIN wins, and an unroutable bind
  // address (0.0.0.0 on Cloud Run) is rejected rather than handed to Evolution
  // as a webhook nobody can deliver to.
  const webhookOrigin = (await canonicalWebhookOrigin(appOrigin)) ?? appOrigin;
  const webhookUrl = `${webhookOrigin}/api/webhooks/evolution?token=${token}`;
  const digits = digitsOnly(phone);

  // NEVER destroy an already-linked session. If the instance is already open,
  // the user has connected - return that instead of wiping it (this was the
  // cause of "WhatsApp says linked but the app keeps asking to connect": a
  // re-entry into connect() deleted the fresh session).
  const existing = await connectionState(email);
  if (existing === "open") {
    await markOpen(email);
    // RE-ARM the webhook even for an already-open instance: this is the only
    // non-destructive path to refresh a stale URL (secret rotation / a
    // preview-origin pairing) without wiping the live session. find+set only.
    await reassertWebhook(email, { requestOrigin: appOrigin, force: true }).catch(() => {});
    return { ok: true, state: "open" };
  }

  // A `connecting` instance is a LIVE HANDSHAKE. Never logout+delete it just
  // because the code we happened to show aged out: the phone may be typing that
  // code right now, and wiping the instance is what produced "my WhatsApp
  // disconnected by itself" plus an endless re-pair loop.
  //
  // `/instance/connect` RE-ISSUES a code on the SAME instance, so an expired
  // code is refreshed with zero teardown. That kills the destroy/recreate storm
  // that the client's 55s auto-refresh used to drive (up to 4 full instance
  // rebuilds per pairing) - the same churn that hammers the Evolution
  // container. Only an explicit user "Try again" (opts.fresh) or an instance
  // that hands back NO code at all falls through to the destructive recreate.
  // A "Try again" DURING the teardown cooldown re-enters the non-destructive
  // re-issue below instead of rebuilding again: the previous rebuild is still
  // settling, and a second one inside 90s is pure churn (see markTeardown).
  if (existing === "connecting" && (!opts?.fresh || inTeardownCooldown(email))) {
    const row = await sbSelect<{ updated_at: string | null; pairing_code_issued_at?: string | null }>(
      "wa_sessions",
      `select=updated_at,pairing_code_issued_at&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
    ).catch(() => []);
    const issued = row[0]?.pairing_code_issued_at ?? row[0]?.updated_at;
    const startedMs = issued ? Date.parse(issued) : NaN;
    const codeAgeMs = Number.isFinite(startedMs) ? Date.now() - startedMs : NaN;
    // Inside the window the SAME code is still on the user's screen, so report
    // its remaining life. Past the window Evolution mints a NEW one, so the
    // window restarts and we re-stamp it.
    const stillLive = Number.isFinite(codeAgeMs) && codeAgeMs < PAIRING_TTL_MS;

    const conn = await evoFetch(
      host,
      `/instance/connect/${instance}${digits ? `?number=${digits}` : ""}`
    );
    const rawPairing =
      conn.data?.pairingCode ?? conn.data?.qrcode?.pairingCode ?? conn.data?.instance?.pairingCode;
    const pairing =
      typeof rawPairing === "string" &&
      /^[A-Za-z0-9]{3,}-?[A-Za-z0-9]{0,}$/.test(rawPairing) &&
      rawPairing.length <= 12
        ? rawPairing
        : undefined;
    const qrNow =
      conn.data?.base64 ??
      conn.data?.qrcode?.base64 ??
      (typeof conn.data?.code === "string" && conn.data.code.startsWith("data:")
        ? conn.data.code
        : undefined);
    // The state may have flipped to open while we polled - honor it.
    const nowState = await connectionState(email);
    if (nowState === "open") {
      await markOpen(email);
      return { ok: true, state: "open" };
    }
    if (pairing || qrNow) {
      if (!stillLive) {
        // A newly-minted code: restart the validity window so the client's
        // countdown reflects the code actually on screen.
        await saveSession(email, instance, "connecting", host.url, new Date()).catch(() => {});
      }
      return {
        ok: true,
        state: "connecting",
        qr: qrNow,
        pairingCode: pairing,
        pairingExpiresInMs: stillLive
          ? Math.max(1_000, PAIRING_TTL_MS - codeAgeMs)
          : PAIRING_TTL_MS,
      };
    }
    // No code at all from the live handshake - the pairing is genuinely wedged,
    // so fall through to the clean recreate below.
  }

  // Otherwise start from a CLEAN slate. A leftover half-linked instance (from a
  // previous attempt, common in the signup funnel) hands WhatsApp a stale
  // pairing code, which WhatsApp rejects as "Incorrect code". Deleting first
  // guarantees the code we show is the current, valid one.
  //
  // ...unless we JUST did this. Inside the cooldown a second rebuild buys
  // nothing but re-registration churn - the honest answer is "the new link is
  // still settling", not another teardown.
  if (inTeardownCooldown(email)) {
    return {
      ok: false,
      error:
        "We just rebuilt your WhatsApp link and it is still settling. Give it a minute, then tap Try again.",
    };
  }
  markTeardown(email, opts?.fresh ? "user-try-again" : `state-${existing ?? "unknown"}`);
  await evoFetch(host, `/instance/logout/${instance}`, { method: "DELETE" });
  await evoFetch(host, `/instance/delete/${instance}`, { method: "DELETE" });
  // Settle window so Evolution finishes tearing the instance down before we
  // recreate the same name. 250ms is enough in practice and this now runs only
  // on an explicit "Try again", not on every 55s code refresh.
  await new Promise((r) => setTimeout(r, 250));

  // Anti-ban instance hardening (from the WhatsApp ban-vector research):
  //  - always_online:false  -> the device NEVER shows as permanently online
  //    (this is the root cause of "always connected"; presence is driven only
  //    while the app is in use).
  //  - markMessagesRead:false-> we never auto-read the user's other chats.
  //  - groupsIgnore:true     -> group traffic is dropped (privacy + less noise).
  //  - a residential proxy (if configured) routes the WebSocket through a
  //    non-datacenter IP - datacenter IPs are a top-weighted ban signal.
  const proxy = await parseProxy(email);
  // EVOLUTION_PROXY_REQUIRED (owner decision 4): BUILT, and built DEFAULT OFF.
  // When the owner flips it on (after confirming the prod proxy config), a
  // link that cannot resolve a residential exit is REFUSED here - fail closed
  // at link time - instead of silently pairing through the datacenter IP the
  // proxy exists to avoid. Default off because flipping it blind bricks
  // linking for every user the moment the template is missing or the token
  // table is unreadable; an UNREADABLE flag keeps the default (off), so a
  // config blip can never lock the front door by itself.
  if (!proxy) {
    const { parseFlag } = await import("./config-flags");
    const required = parseFlag(await getConfig("EVOLUTION_PROXY_REQUIRED").catch(() => undefined), false);
    if (required) {
      return {
        ok: false,
        error:
          "Linking is paused: this deployment requires a residential proxy and none could be resolved. The owner can fix the proxy settings (or turn EVOLUTION_PROXY_REQUIRED off) in Admin - Keys.",
      };
    }
  }
  const hardening = {
    rejectCall: false,
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    readStatus: false,
    // PRIVACY / DATA MINIMISATION: do NOT backfill the user's entire WhatsApp
    // history into the Evolution store. We only ever need the LIVE messages of
    // the rental-shop threads the agent opened; keeping the full personal
    // history out of the store shrinks the blast radius of any future scoping
    // bug to near zero (the per-message JID filter is the primary guard). The
    // teaching import still reads recent messages of numbers the owner names.
    syncFullHistory: false,
  };
  const events = [...WEBHOOK_EVENTS];

  // Pairing code needs the number PASSED AT CREATE time in Evolution v2 - the
  // create response then carries the pairing code directly.
  const createBody: Record<string, unknown> = {
    instanceName: instance,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
    // PAIRING-LAYER defense: present a standard Chrome-on-macOS Web fingerprint
    // and pin the web protocol, so the socket does not get flagged at connect
    // time (the ban happened BEFORE any message - at pairing).
    ...CONNECT_FINGERPRINT,
    alwaysOnline: false,
    groupsIgnore: true,
    readMessages: false,
    readStatus: false,
    // Privacy: do NOT backfill the user's entire personal WhatsApp history into
    // the store at link time. Same rationale as the hardening object below -
    // keep only the rental-shop threads the agent opens; the per-message JID
    // filter is the primary guard, this shrinks the blast radius to near zero.
    syncFullHistory: false,
    ...(proxy ? { proxyHost: proxy.host, proxyPort: proxy.port, proxyProtocol: proxy.protocol, proxyUsername: proxy.username, proxyPassword: proxy.password } : {}),
    webhook: { url: webhookUrl, byEvents: false, events },
  };
  if (digits) createBody.number = digits;

  let created = await evoFetch(host, "/instance/create", {
    method: "POST",
    body: JSON.stringify(createBody),
  });
  if (!created.ok && created.status !== 403 && created.status !== 409) {
    // Older Evolution builds use a flat webhook field - retry once.
    created = await evoFetch(host, "/instance/create", {
      method: "POST",
      body: JSON.stringify({
        instanceName: instance,
        qrcode: true,
        ...(digits ? { number: digits } : {}),
        webhook: webhookUrl,
        // THE SAME EVENT SET AS EVERY OTHER PATH.
        //
        // This literal said `["MESSAGES_UPSERT"]` while the three modern paths
        // used WEBHOOK_EVENTS - so anyone who paired through this legacy
        // fallback got no CALL (their ring is never answered), no
        // MESSAGES_UPDATE (no delivery receipts, so the ghost-send guard has
        // nothing to confirm against) and no CONNECTION_UPDATE (the app never
        // learns their socket dropped, and shows them connected while nothing
        // sends). Silent, per-user, and invisible to anyone who paired the
        // normal way.
        //
        // It is spread rather than referenced so the hardening-invariants test
        // can still pin a literal set at each create site.
        events: [...WEBHOOK_EVENTS],
        // NOTE: the fingerprint fields (browser/mobile) are DELIBERATELY omitted
        // here. This retry is the LAST-RESORT minimal body: it fires when the
        // main create failed with a non-403/409 status, which on a strict build
        // could be a 400 rejecting the very browser/mobile fields. Keeping this
        // path fingerprint-free means such a build can still pair via the legacy
        // shape (those builds read the fingerprint from server env anyway -
        // CONFIG_SESSION_PHONE_CLIENT/NAME, per docs/ANTI-BAN.md).
        // Privacy: the flat-retry path fires precisely BECAUSE this is an older
        // Evolution build - the exact build whose comment below admits it
        // ignores the post-hoc /settings/set hardening. So syncFullHistory
        // MUST be declared here at create time, or the user's entire personal
        // WhatsApp history gets backfilled into the shared store on a fresh link.
        syncFullHistory: false,
      }),
    });
    if (!created.ok && created.status !== 403 && created.status !== 409) {
      return {
        ok: false,
        error:
          created.data?.response?.message?.toString?.() ??
          created.data?.message ??
          created.data?.error ??
          `Evolution API ${created.status} - check the URL + API key in Admin.`,
      };
    }
  }

  // Webhook + hardening + proxy are INDEPENDENT of each other, so run them
  // concurrently. Serially these were three round-trips (each up to the 12s
  // evoFetch ceiling) stacked directly in front of the user's code, for no
  // ordering benefit. Only the webhook is required; the other two are
  // best-effort on older Evolution builds that ignore unknown fields.
  const [webhookSet, , proxySet] = await Promise.all([
    evoFetch(host, `/webhook/set/${instance}`, {
      method: "POST",
      body: JSON.stringify({
        webhook: { enabled: true, url: webhookUrl, byEvents: false, events },
        enabled: true,
        url: webhookUrl,
        events,
      }),
    }),
    evoFetch(host, `/settings/set/${instance}`, {
      method: "POST",
      body: JSON.stringify(hardening),
    }).catch(() => undefined),
    proxy
      ? evoFetch(host, `/proxy/set/${instance}`, {
          method: "POST",
          body: JSON.stringify({ enabled: true, ...proxy }),
        }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  void webhookSet;
  // TIER 2.2: /proxy/set is a REAL verification primitive - Evolution fetches
  // icanhazip.com directly AND through the proxy and requires them to differ,
  // so a 2xx proves the exit is genuinely carrying traffic. We were discarding
  // that answer. Record it on the session row (best-effort, after the response
  // boundary work is already scheduled) so the transport tiles can tell
  // "asserted" from "verified". It does NOT gate the link - owner decision
  // keeps proxying non-gating. Only meaningful when a proxy was configured.
  if (proxy) {
    const { recordProxyVerification } = await import("./wa/proxy");
    void recordProxyVerification(email, Boolean(proxySet?.ok));
  }

  const pickPairing = (d: any): string | undefined => {
    const raw = d?.pairingCode ?? d?.qrcode?.pairingCode ?? d?.instance?.pairingCode;
    return typeof raw === "string" && /^[A-Za-z0-9]{3,}-?[A-Za-z0-9]{0,}$/.test(raw) && raw.length <= 12
      ? raw
      : undefined;
  };
  const pickQr = (d: any): string | undefined =>
    d?.base64 ??
    d?.qrcode?.base64 ??
    (typeof d?.code === "string" && d.code.startsWith("data:") ? d.code : undefined);

  // The pairing code may already be in the create response (Evolution v2 with
  // number passed at create).
  let pairingCode = pickPairing(created.data);
  let qr = pickQr(created.data);
  // WHEN the code actually arrived - the TTL anchor. Stamping at saveSession
  // (after the poll backoff and a connectionState round trip) over-stated the
  // code's life by several seconds, so the client's countdown promised time
  // the code no longer had - the tail of the first-attempt "Incorrect code".
  let mintedAt = pairingCode ? Date.now() : null;

  // Otherwise poll the connect endpoint a few times. Baileys sometimes needs a
  // moment to mint the code; we DON'T recreate the instance (that would
  // invalidate an already-shown code and cause "couldn't link device").
  // Adaptive backoff instead of a flat 1400ms x 4: Baileys usually mints the
  // code on the first or second look, so a short first wait returns most users
  // in well under a second of added latency, while the later steps still give a
  // slow host room. Worst case is now ~2.9s of sleep instead of ~4.2s.
  const POLL_BACKOFF_MS = [0, 300, 800, 1800];
  const attempts = digits ? POLL_BACKOFF_MS.length : 1;
  for (let i = 0; i < attempts && !pairingCode; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, POLL_BACKOFF_MS[i]));
    const conn = await evoFetch(
      host,
      `/instance/connect/${instance}${digits ? `?number=${digits}` : ""}`
    );
    const got = pickPairing(conn.data);
    if (got && !pairingCode) {
      pairingCode = got;
      mintedAt = Date.now();
    }
    qr = qr ?? pickQr(conn.data);
  }

  const state = await connectionState(email);
  // Stamp WHEN this fresh code was minted so retries can tell live from dead
  // (the whole B1 "Invalid code" class). The stamp is the MINT moment, not
  // "now" - the connectionState round trip above already spent part of the
  // code's life. No code -> clear the stamp.
  await saveSession(
    email,
    instance,
    state ?? "connecting",
    host.url,
    pairingCode && mintedAt ? new Date(mintedAt) : null
  );

  return {
    ok: true,
    state: state ?? "connecting",
    qr,
    pairingCode,
    ...(pairingCode && mintedAt
      ? { pairingExpiresInMs: Math.max(1_000, PAIRING_TTL_MS - (Date.now() - mintedAt)) }
      : {}),
    error:
      !pairingCode && !qr
        ? "The WhatsApp server didn't hand out a code - wait ~30 seconds and tap Try again."
        : !pairingCode && qr
        ? "Code not available right now - use the QR tab from a computer, or tap Try again."
        : undefined,
  };
}

/** Force a brand-new session (used by the 'New code' button when linking fails). */
export async function resetInstance(email: string): Promise<void> {
  const instance = instanceNameFor(email);
  markTeardown(email, "reset");
  await evo(email, `/instance/logout/${instance}`, { method: "DELETE" });
  await evo(email, `/instance/delete/${instance}`, { method: "DELETE" });
  await saveSession(email, instance, "disconnected");
}

// `numberOnWhatsApp` was deleted here (owner report 3, 3.4 #7): a repo-wide
// grep (static AND dynamic imports) found ZERO call sites, and an existence
// probe with no caller is exactly the "is this number on WhatsApp" pattern
// Meta meters as contact scraping - dead code that only a future bug could
// resurrect. resolveChatJid below is the one surviving prober, cache-first
// and budgeted.

// ---- Chat history (for auto-teaching the bargaining agents) --------------------

export interface WaChat {
  jid: string;
  name?: string;
}

/** List the user's individual (non-group) chats. */
export async function fetchChats(email: string): Promise<WaChat[]> {
  const instance = instanceNameFor(email);
  const res = await evo(email, `/chat/findChats/${instance}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const arr: any[] = Array.isArray(res.data) ? res.data : res.data?.chats ?? [];
  return arr
    .map((c) => ({
      jid: String(c.remoteJid ?? c.id ?? c.jid ?? ""),
      name: c.pushName ?? c.name ?? c.subject ?? undefined,
    }))
    .filter((c) => c.jid.endsWith("@s.whatsapp.net")); // individuals only, no groups
}

export interface WaMessage {
  fromMe: boolean;
  text: string;
  ts: number;
}

// waMessageText now lives in wa/message-text.ts and is SHARED with the live
// webhook path. It used to be private to this file and wired only to
// fetchMessages/fetchMessagesRaw - the recovery sweep - while the live path
// carried a weaker private copy that dropped stickers, reactions, button
// replies, view-once media and edited messages. See that file for the story.

// Evolution's findMessages body shape varies across versions; try each so a
// real chat is never wrongly reported empty. EVERY returned record is then
// hard-filtered to the requested JID, so a version that ignores the server-side
// remoteJid filter (and returns the whole inbox) can NEVER leak another chat's
// messages into this thread. If a shape returns records but none match the
// requested chat, that response was unscoped - we discard it and try the next
// shape, never returning cross-chat rows.
async function findMessagesRecords(
  email: string,
  jid: string,
  limit: number
): Promise<any[]> {
  const instance = instanceNameFor(email);
  const bodies = [
    { where: { key: { remoteJid: jid } }, limit },
    { where: { remoteJid: jid }, limit },
    { remoteJid: jid, limit },
  ];
  for (const body of bodies) {
    try {
      const res = await evo(email, `/chat/findMessages/${instance}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const arr: any[] = Array.isArray(res.data)
        ? res.data
        : res.data?.messages?.records ?? res.data?.messages ?? res.data?.records ?? [];
      if (!arr.length) continue;
      // Keep ONLY records that belong to the requested chat.
      const scoped = arr.filter((m) => jidMatches(String(m?.key?.remoteJid ?? ""), jid));
      if (scoped.length) return scoped;
      // Records came back but none were this chat's - an unscoped response.
      // Do not return it; try the next shape (also filtered).
    } catch {
      /* try the next body shape */
    }
  }
  return [];
}

// JID PROBE HYGIENE (owner report 3, 3.4 #7). `/chat/whatsappNumbers` is a
// contact-EXISTENCE check against WhatsApp's directory - the exact query
// pattern Meta meters as contact scraping when it arrives in volume. Before
// this, every recovery sweep re-probed every shop on every pass. Now a
// resolution is answered from memory first (the lid-alias store, then a
// per-instance memo of past resolutions), and the live probe itself draws
// from a bounded hourly discovery budget - past the budget the resolver falls
// through to the synced chat list and the default form, which cost nothing.
const JID_MEMO_TTL_MS = 24 * 3600_000;
const JID_PROBES_PER_HOUR = 30;

declare global {
  // eslint-disable-next-line no-var
  var __wd_jid_memo__: Map<string, { jid: string; at: number }> | undefined;
  // eslint-disable-next-line no-var
  var __wd_jid_probes__: Map<string, number[]> | undefined;
}

/** Consume one discovery-probe slot for this sender; false = budget spent. */
function takeJidProbeSlot(email: string): boolean {
  if (!globalThis.__wd_jid_probes__) globalThis.__wd_jid_probes__ = new Map();
  const store = globalThis.__wd_jid_probes__;
  const key = email.trim().toLowerCase();
  const now = Date.now();
  const recent = (store.get(key) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= JID_PROBES_PER_HOUR) {
    store.set(key, recent);
    return false;
  }
  recent.push(now);
  if (store.size > 500) store.clear();
  store.set(key, recent);
  return true;
}

/**
 * Resolve a pasted phone number to the exact JID WhatsApp stores for it. This
 * fixes "no chat found" when the owner types the number in a slightly different
 * format than WhatsApp's canonical one (e.g. a leading 0, a missing country
 * code, or the new @lid privacy JIDs).
 */
export async function resolveChatJid(
  email: string,
  rawNumber: string
): Promise<string | null> {
  const digits = digitsOnly(rawNumber);
  if (digits.length < 7) return null;
  const memoKey = `${email.trim().toLowerCase()}|${digits}`;
  if (!globalThis.__wd_jid_memo__) globalThis.__wd_jid_memo__ = new Map();
  const memo = globalThis.__wd_jid_memo__;
  const hit = memo.get(memoKey);
  if (hit && Date.now() - hit.at < JID_MEMO_TTL_MS) return hit.jid;
  const remember = (jid: string): string => {
    if (memo.size > 2000) memo.clear();
    memo.set(memoKey, { jid, at: Date.now() });
    return jid;
  };

  // 0) THE ALIAS STORE FIRST. A shop the fleet has already exchanged messages
  //    with under an @lid privacy JID has its canonical identity on record -
  //    answering from memory costs nothing and skips the directory probe.
  try {
    const { lidAliasForShop } = await import("./wa/lid-alias");
    const lid = await lidAliasForShop(email, digits);
    if (lid) return remember(`${lid}@lid`);
  } catch {
    /* fall through to the probe */
  }

  const instance = instanceNameFor(email);
  // 1) Ask WhatsApp for the canonical JID of this number - under the budget.
  if (takeJidProbeSlot(email)) {
    try {
      const res = await evo(email, `/chat/whatsappNumbers/${instance}`, {
        method: "POST",
        body: JSON.stringify({ numbers: [digits] }),
      });
      const jid = res.data?.[0]?.jid ?? res.data?.[0]?.remoteJid;
      if (typeof jid === "string" && jid.includes("@")) return remember(jid);
    } catch {
      /* fall through */
    }
  }
  // 2) Otherwise match against the synced chat list by trailing digits.
  try {
    const chats = await fetchChats(email);
    const tail = digits.slice(-9);
    const found = chats.find((c) => digitsOnly(c.jid).endsWith(tail));
    if (found) return remember(found.jid);
  } catch {
    /* fall through */
  }
  // 3) Best-effort default form. NOT memoised - it is a guess, not a
  //    resolution, and remembering it would mask a later successful probe.
  return `${digits}@s.whatsapp.net`;
}

/** Recent messages of one chat, oldest-first. */
export async function fetchMessages(
  email: string,
  jid: string,
  limit = 60
): Promise<WaMessage[]> {
  const arr = await findMessagesRecords(email, jid, limit);
  return arr
    .map((m) => ({
      fromMe: Boolean(m.key?.fromMe),
      text: waMessageText(m.message ?? {}),
      ts: Number(m.messageTimestamp ?? 0),
    }))
    .filter((m) => m.text.trim().length > 0)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Recent messages of one chat WITH their WhatsApp ids - the shape the
 * pull-sync needs to detect inbound replies whose webhook never arrived
 * (e.g. the Evolution host was down at delivery time).
 */
export interface WaMessageRaw {
  id: string;
  fromMe: boolean;
  text: string;
  ts: number; // seconds since epoch
  hasImage: boolean;
  remoteJid: string; // the message's TRUE origin chat - the per-message privacy anchor
  record: unknown; // full Evolution record (needed for media download)
}

export async function fetchMessagesRaw(
  email: string,
  jid: string,
  limit = 10
): Promise<WaMessageRaw[]> {
  const arr = await findMessagesRecords(email, jid, limit);
  return arr
    .map((m) => {
      const msg = m.message ?? {};
      // ROBUST fromMe: Evolution stores it in different spots depending on
      // version/endpoint. Missing the flag once misattributes the user's OWN
      // message as a shop reply (and the risk screen then "flags" it), so we
      // check every known location before defaulting to false.
      const fromMe = Boolean(
        m.key?.fromMe ?? (m as { fromMe?: boolean }).fromMe ?? m.message?.key?.fromMe
      );
      return {
        id: String(m.key?.id ?? ""),
        fromMe,
        text: waMessageText(msg),
        ts: Number(m.messageTimestamp ?? 0),
        hasImage: Boolean(msg.imageMessage ?? msg.ephemeralMessage?.message?.imageMessage),
        remoteJid: String(m.key?.remoteJid ?? ""),
        record: m,
      };
    })
    .filter((m) => m.id)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Download an inbound media message (a price-list photo) as base64 so the
 * vision agent can read the prices off it. Evolution v2 exposes
 * getBase64FromMediaMessage; returns an InboundImage or null.
 *
 * THIS IS THE ORIENTATION CHOKEPOINT. Every WhatsApp image byte in the system
 * passes through here - the vision worker, wa/ingest, wa-sync and the media
 * proxy all call this one function - so measuring EXIF orientation once, here,
 * is what stops four independent consumers each guessing differently about a
 * price board photographed with a phone held upright. The bytes themselves are
 * returned UNCHANGED (see lib/media/orientation.ts for why we declare rather
 * than rotate); `orientation` is a description of them, not a modification.
 * The parse is bounded and cannot throw, so a hostile image still yields a reply.
 */
export async function fetchMediaBase64(
  email: string,
  message: unknown
): Promise<InboundImage | null> {
  const instance = instanceNameFor(email);
  try {
    const res = await evo(email, `/chat/getBase64FromMediaMessage/${instance}`, {
      method: "POST",
      body: JSON.stringify({ message, convertToMp4: false }),
    });
    const base64 = res.data?.base64 ?? res.data?.media ?? res.data?.buffer;
    const mime = res.data?.mimetype ?? res.data?.mimeType ?? "image/jpeg";
    if (typeof base64 === "string" && base64.length > 100) {
      const clean = base64.replace(/^data:[^,]+,/, "");
      return { base64: clean, mime, orientation: readOrientationFromBase64(clean) };
    }
  } catch {
    /* media fetch is best-effort */
  }
  return null;
}

// EPHEMERAL SHOP AVATARS.
//
// A shop's WhatsApp profile picture makes the negotiation feel like the real
// conversation it is. It is also personal data belonging to someone who never
// signed up for this app, so it is NEVER written to a database - it lives in
// this process cache for a few minutes and in React state for the length of one
// search, and disappears with both. The route that calls this proves the user
// actually messaged the number first.
const AVATAR_TTL_MS = 10 * 60_000;
// A FAILURE is cached too - briefly. Uncached failures meant five mount sites
// hammered a dead Evolution host in lockstep on every board render; ten
// minutes would freeze every avatar behind one bad moment. 45s is long enough
// to absorb a render storm and short enough to recover within the minute.
const AVATAR_FAIL_TTL_MS = 45_000;
const AVATAR_CAP = 2000;
function avatarStore(): Map<string, { url: string | null; exp: number; err?: string }> {
  const g = globalThis as unknown as {
    __wd_wa_avatars__?: Map<string, { url: string | null; exp: number; err?: string }>;
  };
  if (!g.__wd_wa_avatars__) g.__wd_wa_avatars__ = new Map();
  return g.__wd_wa_avatars__;
}
// IN-FLIGHT DEDUP: the board mounts many <img> tags for the same shop at once
// (card, map pin, status panel...). One upstream chain per (email, digits);
// everyone else awaits the same promise instead of quadrupling the load.
const avatarInFlight = new Map<string, Promise<ProfilePicture>>();

/**
 * The shop's WhatsApp profile picture URL, or null when it has none / hides it.
 * Never throws; a miss is simply an initial-letter fallback in the UI.
 */
/**
 * The shop's WhatsApp profile picture, with the REASON when there is none.
 *
 * Every avatar on the board came back empty in the field while the same shops
 * plainly had pictures in WhatsApp. There was no way to tell "this shop hides
 * its photo" from "this build's endpoint answered 404", so the first fix added
 * the JID fallback and a log line. It was still one endpoint's opinion.
 *
 * Evolution builds disagree about which route serves a profile picture and
 * about which identifier it takes, so this asks in order and stops at the first
 * real https URL:
 *
 *   1. /chat/fetchProfilePictureUrl  with bare digits   (the documented one)
 *   2. the same route with the canonical JID            (some builds insist)
 *   3. /chat/fetchProfile                                (returns `picture`)
 *   4. /chat/findContacts                                (`profilePicUrl`)
 *
 * The reason for a miss is returned rather than swallowed, so the WhatsApp
 * doctor in Admin can show the owner exactly what their host said - from a
 * phone, with no terminal.
 */
export interface ProfilePicture {
  url: string | null;
  /** Only set when we genuinely failed, never for "this shop has no photo". */
  error?: string;
}

function httpsUrlIn(data: unknown): string | null {
  const d = data as Record<string, unknown> | null;
  if (!d) return null;
  const direct = [d.profilePictureUrl, d.profilePicUrl, d.picture, d.url, d.profilePicture];
  for (const c of direct) {
    if (typeof c === "string" && /^https:\/\//i.test(c)) return c;
  }
  // findContacts answers with an array (or {contacts:[...]}) of contact rows.
  const rows = Array.isArray(d) ? d : Array.isArray(d.contacts) ? d.contacts : null;
  if (rows) {
    for (const r of rows as Record<string, unknown>[]) {
      const hit = httpsUrlIn(r);
      if (hit) return hit;
    }
  }
  return null;
}

export async function fetchProfilePicture(
  email: string,
  digits: string
): Promise<ProfilePicture> {
  // CANONICAL KEY: whatever spelling the caller holds, one shop is one cache
  // entry and one in-flight chain.
  const canon = digitsOnly(digits) || digits;
  const key = `${email}:${canon}`;
  const store = avatarStore();
  const hit = store.get(key);
  if (hit && hit.exp > Date.now()) return { url: hit.url, error: hit.err };

  const running = avatarInFlight.get(key);
  if (running) return running;
  const task = fetchProfilePictureUncached(email, canon, key, store).finally(() => {
    avatarInFlight.delete(key);
  });
  avatarInFlight.set(key, task);
  return task;
}

async function fetchProfilePictureUncached(
  email: string,
  digits: string,
  key: string,
  store: Map<string, { url: string | null; exp: number; err?: string }>
): Promise<ProfilePicture> {
  const instance = instanceNameFor(email);
  let jid: string | null = null;
  try {
    jid = await resolveChatJid(email, digits);
  } catch {
    jid = `${digits}@s.whatsapp.net`;
  }
  // NEVER stuff an @lid into a `number` field. An @lid's digits are NOT the
  // phone number (privacy keystone) - a build that parses the digits out of
  // the identifier would look up a DIFFERENT person's picture. Phone-shaped
  // identifiers only.
  if (jid && /@lid\b/i.test(jid)) jid = null;

  const attempts: Array<{ path: string; body: Record<string, unknown> }> = [
    { path: `/chat/fetchProfilePictureUrl/${instance}`, body: { number: digits } },
  ];
  if (jid && jid !== digits) {
    attempts.push({ path: `/chat/fetchProfilePictureUrl/${instance}`, body: { number: jid } });
  }
  attempts.push({ path: `/chat/fetchProfile/${instance}`, body: { number: jid || digits } });
  attempts.push({
    path: `/chat/findContacts/${instance}`,
    body: { where: { id: jid || `${digits}@s.whatsapp.net` } },
  });

  // TOTAL deadline, not per-attempt: four routes each allowed a 12s abort
  // meant a dead host held an avatar request open for ~48s while the page
  // had long since rendered its initial. Whatever is not answered in ~4s is
  // answered next time - the negative cache above keeps retries cheap.
  const deadline = Date.now() + 4_000;
  let url: string | null = null;
  let lastError = "";
  let settled = false; // a clean 200 that simply had no picture
  for (const attempt of attempts) {
    if (Date.now() > deadline) {
      lastError = lastError || "avatar lookup deadline exceeded";
      break;
    }
    try {
      const res = await evo(email, attempt.path, {
        method: "POST",
        body: JSON.stringify(attempt.body),
      });
      if (!res.ok) {
        lastError = `${attempt.path.split("/")[1]} -> ${res.status}${
          res.data?.message ? `: ${String(res.data.message).slice(0, 120)}` : ""
        }`;
        continue;
      }
      const found = httpsUrlIn(res.data);
      if (found) {
        url = found;
        break;
      }
      settled = true; // answered fine, just no picture on this route
    } catch (e) {
      lastError = `${attempt.path.split("/")[1]} -> ${
        e instanceof Error ? e.message : "network error"
      }`;
    }
  }

  const error = url || settled ? undefined : lastError || "no route returned a picture";
  if (error) console.warn(`[wa/avatar] ${digits}: ${error}`);
  // A genuine answer (picture or proven absence) is cached for the full TTL; a
  // FAILURE is cached only briefly - long enough to absorb a render storm,
  // short enough that one bad moment cannot freeze the board.
  if (!error) boundedSet(store, key, { url, exp: Date.now() + AVATAR_TTL_MS }, AVATAR_CAP);
  else boundedSet(store, key, { url: null, exp: Date.now() + AVATAR_FAIL_TTL_MS, err: error }, AVATAR_CAP);
  return { url, error };
}

/** Back-compat thin wrapper: the URL only, errors swallowed. */
export async function fetchProfilePictureUrl(
  email: string,
  digits: string
): Promise<string | null> {
  return (await fetchProfilePicture(email, digits)).url;
}

/**
 * Read the state directly off Evolution's instance list. Right after a
 * pairing-code link the dedicated /connectionState endpoint is often still
 * "connecting" (stale cache) while fetchInstances already reports "open" - so
 * we cross-check both. Returns "open" | "connecting" | "close" | null.
 */
async function stateFromFetchInstances(email: string): Promise<string | null> {
  const instance = instanceNameFor(email);
  const res = await evo(email, `/instance/fetchInstances?instanceName=${instance}`);
  if (!res.ok) return null;
  const arr: any[] = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
  // Evolution v2 shapes vary: [{ name, connectionStatus }] or
  // [{ instance: { instanceName, state|status } }].
  const match =
    arr.find(
      (x) =>
        x?.name === instance ||
        x?.instanceName === instance ||
        x?.instance?.instanceName === instance ||
        x?.instance?.name === instance
    ) ?? arr[0];
  if (!match) return null;
  const raw =
    match.connectionStatus ??
    match.state ??
    match.status ??
    match.instance?.state ??
    match.instance?.status ??
    match.instance?.connectionStatus ??
    null;
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  return s === "connected" ? "open" : s;
}

/** "open" = paired and ready to send. Cross-checks both Evolution endpoints. */
export async function connectionState(email: string): Promise<string | null> {
  const instance = instanceNameFor(email);
  const res = await evo(email, `/instance/connectionState/${instance}`);
  let state: string | null = res.ok
    ? res.data?.instance?.state ?? res.data?.state ?? null
    : null;
  // If the dedicated endpoint is not already "open", ask the instance list -
  // it reflects a fresh pairing-code link faster. This is the fix for
  // "WhatsApp says linked but the app still says NOT CONNECTED".
  if (state !== "open") {
    const alt = await stateFromFetchInstances(email);
    if (alt === "open") state = "open";
    else if (!state && alt) state = alt;
  }
  if (state === "open") markOpen(email).catch(() => {});
  return state;
}

/**
 * Fully sever our link to the user's WhatsApp. Logs out and DELETES the instance
 * on EVERY host (so no server keeps a live socket) and on the shared database
 * (so the Baileys credentials are gone), then removes our own wa_sessions record
 * entirely - we retain nothing about their WhatsApp afterwards.
 */
export async function disconnectInstance(email: string): Promise<boolean> {
  const instance = instanceNameFor(email);
  const hosts = await getHosts();
  let ok = false;
  for (const h of hosts) {
    await evoFetch(h, `/instance/logout/${instance}`, { method: "DELETE" });
    const res = await evoFetch(h, `/instance/delete/${instance}`, { method: "DELETE" });
    ok = ok || res.ok;
  }
  const enc = encodeURIComponent(email.toLowerCase());
  await sbDelete("wa_sessions", `email=eq.${enc}`);
  // Purge the user's PARKED work too. Without this, an orphaned wa_outbox row
  // would (a) be drained by a background poll, whose ensureConnected re-created
  // the wa_sessions row we just deleted (silently undoing the disconnect), and
  // (b) fire stale sends the moment the user ever re-links. A torn-down link
  // must leave nothing behind that can message a shop.
  await sbDelete("wa_outbox", `sender_key=eq.${enc}`).catch(() => {});
  await sbDelete("graph_wakeups", `user_email=eq.${enc}`).catch(() => {});
  return ok;
}

/** Send a text from the user's own WhatsApp (rate-limited, human-like).
 *  `fast` skips the blocking presence-mimicry wait so the API returns quickly
 *  (used for interactive sends where the UI needs to feel instant; a short
 *  typing indicator still fires, and the guard already spaced the message). */
/**
 * A real Evolution /message/sendText success ALWAYS returns a message receipt:
 * `key.id` (the WhatsApp message id) and/or a `messageTimestamp`. HTTP 200 with
 * neither means the request was accepted by the HTTP layer but Baileys did not
 * actually create/dispatch a message - the ghost-send case. An explicit
 * status:"ERROR" is a hard reject. This is the single source of truth for
 * "did the message really leave".
 */
function hasSendReceipt(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as {
    key?: { id?: unknown };
    messageTimestamp?: unknown;
    messageId?: unknown;
    status?: unknown;
  };
  const status = String(d.status ?? "").toLowerCase();
  if (status === "error" || status === "failed") return false;
  return Boolean(d.key?.id || d.messageTimestamp || d.messageId);
}

/**
 * Did the host reject the BODY SHAPE (as opposed to refusing the send)?
 *
 * Only a shape rejection can be rescued by re-posting in the older Evolution v1
 * format. A 401, an offline instance or an unknown number are all settled
 * answers that a different body will not change.
 */
export function looksLikeShapeRejection(r: { status: number; data?: unknown }): boolean {
  if (r.status !== 400 && r.status !== 422) return false;
  const d = r.data as { message?: unknown; response?: { message?: unknown } } | undefined;
  const msg = JSON.stringify(d?.message ?? d?.response?.message ?? d ?? "").toLowerCase();
  return /requires property|should have required|is not allowed|must be|invalid body|validation/.test(msg);
}

export async function sendFromUser(
  email: string,
  to: string,
  message: string,
  /**
   * Skip the multi-second PRESENCE simulation (typing/paused/typing). Every
   * drain sets this: the simulation costs 4-12s per row and the drains run
   * inside an 8s budget, so leaving it on meant one message per poll.
   */
  fast = false,
  opts?: {
    /**
     * Skip the sub-3s Poisson inter-arrival gap as well. TRUE ONLY where a
     * person is watching a spinner - see the comment at the gap itself.
     */
    skipJitter?: boolean;
    /**
     * Which budget this send draws from. Defaults to "intro" - the tighter of
     * the two - so a caller that forgets to say is metered CONSERVATIVELY
     * rather than handed the roomier reply allowance by accident.
     */
    lane?: SendLane;
  }
): Promise<{
  ok: boolean;
  error?: string;
  rateLimited?: boolean;
  /**
   * The budget could not be READ (Supabase blip), so we held rather than
   * risking the number. Not a cap, not a host fault - a third thing, and the
   * drain must say so instead of inventing one of the other two.
   */
  budgetUnreadable?: boolean;
  /** How long the CAP says to wait. Absent for every non-cap failure. */
  retryAfterSeconds?: number;
  messageId?: string;
  unconfirmed?: boolean;
  /** The provider's own record of WHICH chat this landed in. For a
   * privacy-migrated contact this is the `<opaque>@lid` form - the exact
   * lid<->phone mapping the inbound path needs to resolve the shop's FIRST
   * reply (see wa/lid-alias: outbound rows stamp raw.lid from this). */
  chatJid?: string;
}> {
  const rate = await checkRateLimit(email, opts?.lane ?? "intro");
  if (!rate.allowed) {
    // Carry the limiter's OWN wait forward. Without it the drain had no way to
    // tell a cap refusal from a dead host, so it re-parked by the transient
    // backoff and told the owner Evolution was unreachable.
    //
    // AND CARRY WHICH REFUSAL IT WAS. `checkRateLimit` has two distinct
    // `allowed:false` outcomes and only ONE of them is a cap: a genuine
    // refusal stamps `rateLimited`, while an unreadable send-history read
    // deliberately does not (it carries an honest reason string instead).
    // Hardcoding `rateLimited: true` here collapsed them, so a Supabase outage
    // was reported to the owner, word for word, as "DAILY MESSAGE ALLOWANCE
    // REACHED" - sending them to look at a budget that was nowhere near spent
    // while the actual fault sat in the database.
    return {
      ok: false,
      rateLimited: rate.rateLimited === true,
      budgetUnreadable: rate.rateLimited !== true,
      retryAfterSeconds: rate.waitSeconds,
      error: rate.reason,
    };
  }

  const instance = instanceNameFor(email);
  const number = digitsOnly(to);

  // Resume the session if it dropped, instead of failing outright.
  const conn = await ensureConnected(email, 6000);
  if (!conn.ok) {
    // A session row means the user HAS linked - a failed resume is a transient
    // reconnect (Render waking), never a reason to make them re-link.
    const paired = await hasSessionRow(email);
    // ...BUT THE RISK ENGINE HAS TO HEAR ABOUT IT.
    //
    // This return happens BEFORE `noteSendOutcome`/`recordSendFailure`, so a
    // number whose link WhatsApp had severed produced a perfect silence in the
    // telemetry: every attempt failed, nothing was counted, `computeRisk` never
    // moved, and the 3-hard-fails-in-180s stop-loss could never fire. The one
    // signal that a number is in trouble was the one signal we discarded.
    // The guard now refuses to reach this path at all for a `close` session
    // (see wa-guard 0.a); this records the residue so the breaker still has
    // evidence when the failure is something else.
    // ...EXCEPT WHEN THE FAILURE IS OUR OWN REFUSAL. `state === "close"` is
    // ensureConnected declining to touch the transport for a severed link (see
    // its head). That is a decision we made, not evidence WhatsApp gave us, and
    // counting it would feed the 3-hard-fails-in-180s stop-loss with our own
    // caution until it paused a number for a restriction it had already
    // detected - punishing the account twice for one event.
    if (paired && conn.state !== "close") {
      const { noteSendOutcome } = await import("./wa-guard");
      await noteSendOutcome(email, "hard").catch(() => {});
    }
    return {
      ok: false,
      error: paired ? "reconnecting" : "not-connected",
    };
  }
  // We reached the socket live: persist "open" so wasEverConnected stays true
  // durably and future sends never regress to "not connected".
  markOpen(email).catch(() => {});

  // Presence mimicry (anti-ban): show a "typing…" indicator before the message.
  // FAST path (interactive sends) fires the indicator but does NOT block on the
  // full multi-step wait, so the UI feels instant; the anti-ban GAP between
  // messages is already enforced by the guard. SLOW path (queued/background
  // sends) does the full human-like composing -> pause -> composing sequence.
  try {
    const { getPolicies } = await import("./wa-guard");
    const p = await getPolicies();
    const span = Math.max(0, p.presence_max_ms - p.presence_min_ms);
    // COUNT presence failures instead of swallowing them (owner report 4,
    // anti-ban A6). The @lid sendPresence bug class made lid recipients
    // silently presence-less - a real behavioural gap that left no trace
    // because every presence call was fire-and-forget. One throttled event per
    // (sender, shop) on the FIRST failure of the sequence is enough to see it.
    let presenceFailed = false;
    const presence = async (state: string, delay: number) => {
      const r = await evo(email, `/chat/sendPresence/${instance}`, {
        method: "POST",
        body: JSON.stringify({ number, presence: state, delay }),
      });
      if (!r.ok && !presenceFailed) {
        presenceFailed = true;
        void sbInsert("agent_events", [
          {
            kind: "wa-presence-failed",
            user_email: email,
            vendor_name: number,
            detail: `sendPresence(${state}) ${r.status} for ${instance}`.slice(0, 200),
          },
        ]).catch(() => {});
      }
      return r;
    };
    if (fast) {
      // One short typing burst, no blocking wait beyond ~1.2s.
      await presence("composing", 1500);
      await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 500)));
    } else {
      const t1 = p.presence_min_ms + Math.floor(Math.random() * span * 0.6);
      const pause = 600 + Math.floor(Math.random() * 1400);
      const t2 = Math.min(4000, 900 + Math.floor(message.length * (18 + Math.random() * 22)) / 4);
      await presence("composing", t1);
      await new Promise((r) => setTimeout(r, Math.min(t1, 5000)));
      await presence("paused", pause);
      await new Promise((r) => setTimeout(r, pause));
      await presence("composing", t2);
      await new Promise((r) => setTimeout(r, Math.min(t2, 4000)));
    }
  } catch {
    /* presence is cosmetic - never block the send */
  }

  // THE LAST GAP BEFORE THE WIRE, AND THE ONLY ONE WITH THE RIGHT SHAPE.
  //
  // Everything above is uniform noise, which still forms a flat block with hard
  // edges when you collect enough of it. Real human message arrivals are a
  // Poisson process, so the gap between them is exponential - mostly short,
  // occasionally long. This draw sits immediately before the API call, so it is
  // the inter-arrival time an observer on the other side actually measures.
  //
  // AND IT USED TO RUN ON ALMOST NOTHING.
  //
  // This was gated on `!fast`, and `fast` is set by EVERY drain caller -
  // including /api/wa/ping (the heartbeat) and /api/wa/tick, which are the
  // least interactive paths in the entire system. So the one pause with the
  // right distribution was skipped on essentially every real send, and what
  // reached the wire was the uniform noise this exists to replace.
  //
  // `fast` conflates two unrelated things. Skipping the 4-12s PRESENCE
  // simulation is genuinely necessary in a drain (it would consume the whole 8s
  // budget on one row). Skipping a 0.8-2.4s gap is not: MIN_GAP_MS is 20s per
  // user and HARD_MIN_GAP_SEC is 8, so a ~1.3s mean draw is lost in the noise
  // of pacing that already exists. They are separate flags now.
  //
  // `skipJitter` is for the three paths where a person is watching a spinner -
  // the admin drill, the admin queue force-send, and a single tapped outreach.
  if (!opts?.skipJitter) {
    const { poissonPause } = await import("./wa/jitter");
    await poissonPause();
  }

  const trySend = async () => {
    // v2 shape first, then the legacy v1 body. IMPORTANT: only fall back to the
    // v1 shape on a DEFINITIVE status error (4xx/5xx = the server rejected the
    // shape, so nothing was delivered). A status 0 is an ABORT/TIMEOUT (our 12s
    // evoFetch deadline) - the request was in flight and MAY have delivered, so
    // re-POSTing it would risk a duplicate message (a velocity/uniformity ban
    // signal). Ambiguous timeouts propagate as {ok:false} and the drain's
    // transient re-queue handles recovery.
    const r = await evo(email, `/message/sendText/${instance}`, {
      method: "POST",
      body: JSON.stringify({ number, text: message, delay: typingDelayForLength(message.length) }),
    });
    // ONLY a host that rejected the v2 BODY SHAPE can be helped by the v1 body.
    //
    // This used to retry on ANY definitive status, and on a v2 host the v1 body
    // is invalid - so a first failure of any kind ("instance not connected", a
    // 401, an unknown number) was followed by a second request that could only
    // ever come back `instance requires property "text"`. That schema complaint
    // then REPLACED the real reason and was shown to the traveller verbatim,
    // under a green "Ask for price" button. Two bugs in one line: a useless
    // retry, and an error message about the wrong failure.
    if (r.ok || r.status === 0 || !looksLikeShapeRejection(r)) return r;
    const legacy = await evo(email, `/message/sendText/${instance}`, {
      method: "POST",
      body: JSON.stringify({
        number,
        options: { delay: typingDelayForLength(message.length), presence: "composing" },
        textMessage: { text: message },
      }),
    });
    // If the legacy shape did not help either, report the FIRST failure - it is
    // the one that explains what actually went wrong.
    return legacy.ok ? legacy : r;
  };

  // One reconnect-and-retry, but ONLY on a definitive HTTP status error (e.g.
  // "instance not connected" 4xx) where the send provably did not deliver. A
  // status 0 (abort/timeout) is ambiguous - never blindly re-POST it. We do NOT
  // retry on a 2xx-without-receipt: that response MAY have delivered, so a
  // re-POST would create a duplicate WhatsApp message (a velocity/uniformity ban
  // signal) - and the receipt shape varies across Evolution builds.
  let res = await trySend();
  if (!res.ok && res.status !== 0) {
    await evo(email, `/instance/connect/${instance}`);
    await new Promise((r) => setTimeout(r, 1200));
    res = await trySend();
  }
  // A 2xx from Evolution means the send request was accepted. A real send also
  // carries a message receipt (key.id / messageTimestamp); an EXPLICIT
  // status:"error"/"failed" is a hard reject. Everything else 2xx is a delivery.
  //
  // CRITICAL: we must NOT treat a 2xx WITHOUT a receipt as a failure. Different
  // Evolution builds return different success shapes (some omit key.id on the
  // first ACK, some nest it), so requiring a receipt made EVERY send look like a
  // ghost -> the drain re-queued the row for 24h -> the queue never cleared
  // (the "stuck queue" / "app non-functional" regression). Instead: a 2xx with a
  // receipt is CONFIRMED; a 2xx without one is accepted as SENT-BUT-UNCONFIRMED
  // (the row clears, the batch proceeds) and flagged so the UI can show it as
  // unverified rather than lying. Only an explicit error status re-queues.
  if (res.ok) {
    const rawStatus = String(res.data?.status ?? "").toLowerCase();
    if (rawStatus === "error" || rawStatus === "failed") {
      // An explicit WhatsApp reject on an otherwise-2xx response is an
      // account-level signal - feed the stop-loss so a run of them halts sends.
      import("./wa-guard").then((m) => m.noteSendOutcome(email, "hard")).catch(() => {});
      return { ok: false, error: "WhatsApp rejected the message" };
    }
    recordSend(email);
    // A clean send clears the stop-loss streak (the account is responding).
    import("./wa-guard").then((m) => m.noteSendOutcome(email, "ok")).catch(() => {});
    const id = String(res.data?.key?.id ?? res.data?.messageId ?? "");
    const chatJid = String(res.data?.key?.remoteJid ?? "");
    return {
      ok: true,
      messageId: id || undefined,
      unconfirmed: !hasSendReceipt(res.data),
      chatJid: chatJid || undefined,
    };
  }
  const errText =
    res.data?.response?.message?.toString?.() ??
    res.data?.message ??
    res.data?.error ??
    `Evolution API ${res.status}`;
  // A send failure to a number that is not on WhatsApp (or that blocked us)
  // looks like list-blasting to Meta - feed it to the risk engine so the
  // number's ban-risk score reflects it.
  try {
    const { recordSendFailure, noteSendOutcome } = await import("./wa-guard");
    // THREE OUTCOMES, NOT TWO.
    //
    // This regex used to be one alternation that lumped "the number is not on
    // WhatsApp" together with "the recipient blocked us" and called both a
    // BLOCK. They are completely different facts: the first is a data-quality
    // problem with a scraped listing, the second is a human deciding they do
    // not want to hear from this traveller.
    //
    // It mattered because blocks_total scores +12 each toward a +30 ceiling on
    // a 100-point risk score that AUTO-PAUSES the account at 70. Three stale
    // numbers in one batch - routine for scraped shop listings - could
    // therefore pause a perfectly healthy number and stop a traveller's whole
    // search, for something no recipient ever did.
    const text = String(errText);
    const notOnWhatsApp = /not.*(?:on\s*)?whatsapp|does ?n[o']?t exist|invalid.*number|no.*account/i.test(text);
    const trueBlock = /\bblocked\b|forbidden/i.test(text);
    await recordSendFailure(
      email,
      number,
      notOnWhatsApp ? "invalid" : trueBlock ? "block" : "fail"
    );
    // STOP-LOSS classification (distinct from the per-recipient risk above):
    // "hard" = an ACCOUNT-level restriction signal ONLY - an auth/rate HTTP
    // status (401/403/429) or text that reads as a restriction/ban/rate limit.
    // DELIBERATELY NOT status 0: a status-0 result is evoFetch's own 12s
    // abort/timeout or a network blip (a cold/slow Evolution host - the target
    // infra), NOT a WhatsApp restriction. The send path treats status 0 as an
    // ambiguous transient (never re-POSTed), and the drain re-queues it; feeding
    // it to the breaker would let a slow host self-inflict a 12h halt on a
    // healthy number. A scattered dead number (invalid/not-on-WhatsApp) is also
    // a LIST-quality problem, so it stays "soft" and resets the streak - only a
    // genuine run of account-level failures halts the whole queue.
    // Classify for the stop-loss breaker via the pure `isHardSendFailure` helper
    // (owner report 11 H2.1): 429 or WhatsApp-restriction text is HARD; an
    // Evolution 401/403 apikey rejection is our config, NOT the number, so it is
    // SOFT and never trips ban-recovery on the traveller. See send-classify.ts.
    await noteSendOutcome(email, isHardSendFailure(res.status, errText) ? "hard" : "soft");
  } catch {
    /* best-effort */
  }
  return { ok: false, error: errText };
}
