// THE PROXY LAYER, REBUILT AROUND ONE GATEWAY AND A STICKY TOKEN - plan Part
// 7.2 and Part 8 Tier 2 (the $0 items; the paid items were cut by owner
// decision and the budget moved to WABA volume).
//
// WHAT THIS REPLACES, and why each half was a defect:
//
// - `EVOLUTION_PROXY_POOL` pinned each user by `sha256(email) % lines.length`.
//   A MOD-HASH REMAPS ALMOST EVERYONE WHEN THE POOL RESIZES: add one line and
//   roughly (n-1)/n of users silently move to a different exit IP - a fleet-
//   wide simultaneous IP change, which is precisely the signal the proxy
//   exists to avoid emitting. Retired outright; there is no pool to resize.
//
// - The assignment lived only in Evolution's Proxy row, and
//   `/instance/delete` CASCADES THAT ROW AWAY - so every "Try again"
//   (`opts.fresh` = logout + delete + recreate) destroyed the user's exit and
//   silently re-derived a fresh one. The sticky identity now lives in OUR
//   `wa_sessions.proxy_session_id`, minted once and never rotated
//   automatically, so a recreate renders the SAME url and lands on the same
//   exit.
//
// The shape: one residential gateway URL template with `{country}` and
// `{session}` placeholders (the dialect every major provider speaks - the
// session token in the username selects a sticky exit), e.g.
//
//   socks5://USER:PASS_country-{country}_session-{session}@gateway:port
//
// HONESTY CONSTRAINTS, carried from the plan and not negotiable:
// - This is BLAST-RADIUS CONTAINMENT, not ban prevention. It caps how many
//   accounts share a fate; it does not change what the behaviour is.
// - Nothing here claims "fail-closed" or "impossible by construction" - the
//   challenge pass refuted both phrasings (Part 7.6). Two egress paths exist
//   that no env default covers.
// - `EVOLUTION_PROXY_REQUIRED` exists and defaults OFF (owner decision 4,
//   report 3). Enforced at ONE point - connectInstance refuses a link when the
//   flag is on and no exit resolves - so it is a real gate, not a dead knob.
//   It ships off because flipping it blind bricks linking; the owner turns it
//   on only after the prod proxy config is confirmed carrying traffic.

import { randomBytes } from "crypto";
import { getConfig, sbSelect, sbUpdate } from "../runtime-config";

/** Country codes are two lowercase letters; anything else is refused. */
const COUNTRY_RE = /^[a-z]{2}$/;

/**
 * Pick the exit country. Pure, so the precedence is testable:
 * requested (if allowlisted) -> default (if valid) -> null (no country pin).
 *
 * A malformed or non-allowlisted request falls back rather than erroring,
 * because the country is an optimisation ranked "third behind simply not being
 * a datacenter ASN" (Part 7.2) - refusing to proxy over a bad country code
 * would sacrifice the first-ranked property for the third.
 */
export function countryFor(
  requested: string | null | undefined,
  allowCsv: string | null | undefined,
  fallback: string | null | undefined
): string | null {
  const allow = new Set(
    (allowCsv ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => COUNTRY_RE.test(s))
  );
  const req = (requested ?? "").trim().toLowerCase();
  if (COUNTRY_RE.test(req) && (allow.size === 0 || allow.has(req))) return req;
  const fb = (fallback ?? "").trim().toLowerCase();
  return COUNTRY_RE.test(fb) ? fb : null;
}

/**
 * Render the gateway template. Pure.
 *
 * `{session}` is REQUIRED in the template: a template without it would put
 * every user on one rotating exit, which is co-tenancy with extra steps and
 * money. Returning null makes the misconfiguration visible at link time
 * instead of silently degrading.
 *
 * `{country}` is optional. When the template carries it but no country
 * resolves, the placeholder segment is dropped whole (`_country-{country}` or
 * `country-{country}_`) so the credentials string stays well-formed.
 */
export function renderProxyTemplate(
  template: string,
  vars: { session: string; country: string | null }
): string | null {
  const t = (template ?? "").trim();
  if (!t || !t.includes("{session}")) return null;
  if (!vars.session) return null;
  let out = t.split("{session}").join(vars.session);
  if (out.includes("{country}")) {
    if (vars.country) {
      out = out.split("{country}").join(vars.country);
    } else {
      out = out
        .replace(/[_-]?country-\{country\}/g, "")
        .replace(/\{country\}/g, "");
    }
  }
  return out;
}

/**
 * A sticky session token. Alphanumeric only, because it travels inside a
 * proxy USERNAME where URL-significant characters (@ : /) would corrupt the
 * credentials string on providers that parse it naively.
 */
export function mintProxySessionId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * The persisted token for this user - minted ONCE, then reused forever.
 *
 * This is the whole fix for both pool defects at once: the identity lives in
 * `wa_sessions.proxy_session_id`, so it survives `/instance/delete` (which
 * cascades Evolution's Proxy row away on every "Try again"), and there is no
 * pool arithmetic to remap it when infrastructure changes.
 *
 * NEVER ROTATED AUTOMATICALLY, by design: rotating buys a fresh IP with no
 * history, which is worse than a stable one. The owner can clear the column to
 * force a new exit; the code never does.
 *
 * Fails SOFT to a deterministic per-email token when the table cannot be read
 * or written - unreadable storage must not block linking (proxying is
 * containment, not a gate), and a deterministic fallback keeps the exit stable
 * across retries within the outage instead of minting a new one per attempt.
 */
export async function stickyProxySession(email: string): Promise<string> {
  const key = email.trim().toLowerCase();
  try {
    const rows = await sbSelect<{ proxy_session_id: string | null }>(
      "wa_sessions",
      `select=proxy_session_id&email=eq.${encodeURIComponent(key)}&limit=1`
    );
    const existing = rows[0]?.proxy_session_id?.trim();
    if (existing) return existing;
    // Write-once via the `is.null` filter, then RE-READ rather than trusting
    // the write. Two concurrent link attempts both mint; the filter lets only
    // one land; the re-read makes both return the winner - and a PATCH that
    // matched zero rows (session row not created yet) still answers 2xx, so
    // the write's own return value cannot distinguish "stored" from "no row".
    const minted = mintProxySessionId();
    await sbUpdate(
      "wa_sessions",
      `email=eq.${encodeURIComponent(key)}&proxy_session_id=is.null`,
      { proxy_session_id: minted }
    ).catch(() => false);
    const after = await sbSelect<{ proxy_session_id: string | null }>(
      "wa_sessions",
      `select=proxy_session_id&email=eq.${encodeURIComponent(key)}&limit=1`
    );
    const stored = after[0]?.proxy_session_id?.trim();
    if (stored) return stored;
  } catch {
    /* fall through to the deterministic fallback */
  }
  // Deterministic: same email -> same token, so an outage or a pre-row link
  // does not bounce the user across exits attempt by attempt. Not stored, so
  // the stored token wins as soon as storage is back.
  const { createHash } = await import("crypto");
  return createHash("sha256").update(`proxy:${key}`).digest("hex").slice(0, 24);
}

/**
 * Resolve the proxy URL for a user under the template scheme, or null when the
 * template is not configured. The caller (evolution.ts `parseProxy`) falls
 * back to the legacy single `EVOLUTION_PROXY` when this returns null.
 */
export async function templateProxyUrl(email: string): Promise<string | null> {
  const template = (await getConfig("EVOLUTION_PROXY_TEMPLATE"))?.trim();
  if (!template) return null;
  const [allow, fallback] = await Promise.all([
    getConfig("EVOLUTION_PROXY_COUNTRY_ALLOW"),
    getConfig("EVOLUTION_PROXY_COUNTRY_DEFAULT"),
  ]);
  // Country is pinned for the life of the link and derived from config, not
  // from the traveller's current location - chasing them mid-trip buys a
  // forced socket teardown and a fresh IP with no history (Part 7.2).
  const country = countryFor(null, allow, fallback);
  const session = await stickyProxySession(email);
  return renderProxyTemplate(template, { session, country });
}

/**
 * Record what `/proxy/set` actually answered - Tier 2.2, the verification gate.
 *
 * Evolution's `/proxy/set` is a REAL verification primitive: it fetches
 * icanhazip.com directly AND through the proxy and requires the two to differ,
 * so a 2xx proves the proxy is genuinely carrying traffic. We were discarding
 * that answer. It now lands on the session row, where the transport tiles read
 * it - `proxy_verified_at` set on success, cleared on a failed apply, so
 * "asserted" and "verified" stop being the same colour on the dashboard.
 *
 * Recording only - it does NOT refuse the link. Owner decision keeps proxying
 * non-gating, and this function must never be the reason a pairing fails.
 */
export async function recordProxyVerification(email: string, applied: boolean): Promise<void> {
  try {
    await sbUpdate("wa_sessions", `email=eq.${encodeURIComponent(email.trim().toLowerCase())}`, {
      proxy_verified_at: applied ? new Date().toISOString() : null,
    });
  } catch {
    /* telemetry can never break a link */
  }
}

/** How many unproxied numbers on one datacenter host is a cluster-ban risk.
 *  WhatsApp's classic cluster-ban trigger is many companion devices egressing
 *  from ONE IP; below this the shared-IP signal is weak, at/above it loud. */
export const PROXYLESS_CLUSTER_THRESHOLD = 5;

/**
 * The datacenter-IP concentration warning, pure so it is testable.
 *
 * Takes the hosts of the numbers that are NOT protected by a confirmed
 * residential exit, and returns the loudest per-host over-concentration (owner
 * report 4, anti-ban A4), or null when no host crosses the threshold.
 *
 * It used to take a second `proxied` boolean and return null the moment ANY
 * proxy template was configured. That was a lie in the one fleet shape the
 * alarm exists for: a template is an assertion, `proxy_verified_at` is the
 * evidence, and a session whose exit was never confirmed still egresses from
 * the datacenter IP. Pasting a template silenced the alarm for every number,
 * verified or not. The caller now decides what "protected" means and passes
 * only the exposed hosts, so the pure function cannot be silenced by a config
 * value it never sees.
 */
export function clusterWarning(
  exposedHosts: Array<string | null>
): { host: string; count: number } | null {
  const hosts = exposedHosts;
  const byHost = new Map<string, number>();
  for (const h of hosts) {
    const key = (h ?? "").trim() || "(unknown host)";
    byHost.set(key, (byHost.get(key) ?? 0) + 1);
  }
  let worst: { host: string; count: number } | null = null;
  for (const [host, count] of byHost) {
    if (count >= PROXYLESS_CLUSTER_THRESHOLD && (!worst || count > worst.count)) {
      worst = { host, count };
    }
  }
  return worst;
}

export interface TransportSummary {
  /** Is a residential exit configured at all? */
  configured: boolean;
  /** Total linked sessions the read could see. Null when the read failed. */
  sessions: number | null;
  /** Sessions whose exit was CONFIRMED carrying traffic (proxy_verified_at set). */
  verified: number | null;
  /**
   * A single honest line for the transport tile.
   *
   * "not configured" is a first-class state, not a red dot: with the paid proxy
   * items cut by owner decision, an unconfigured exit is the EXPECTED baseline,
   * and painting it as a failure would cry wolf on every dashboard load.
   */
  note: string;
  /**
   * THE LOUD BANNER (anti-ban A4). Present ONLY when too many unproxied numbers
   * share one datacenter host - the classic cluster-ban trigger. This is the
   * one transport state that IS a red dot, because it is the one that gets a
   * whole host's fleet banned at once. Absent at the safe baseline.
   */
  clusterWarning?: { host: string; count: number };
}

/**
 * Summarise transport for the risk dashboard. Reads only `wa_sessions`, one
 * round trip, and NEVER invents a number: an unreadable table returns null
 * counts and says so, rather than reporting a confident zero (the fail-green
 * shape this whole tier is undoing).
 */
export async function transportSummary(): Promise<TransportSummary> {
  const template = (await getConfig("EVOLUTION_PROXY_TEMPLATE"))?.trim();
  const legacy = (await getConfig("EVOLUTION_PROXY"))?.trim();
  const configured = Boolean(template || legacy);
  // The concentration read is worth doing EVEN when no proxy is configured -
  // that is precisely when the cluster-ban risk is real.
  let hostRows: Array<{ host_url: string | null; proxy_verified_at: string | null }> = [];
  let readOk = true;
  try {
    hostRows = await sbSelect<{ host_url: string | null; proxy_verified_at: string | null }>(
      "wa_sessions",
      "select=host_url,proxy_verified_at&limit=1000"
    );
  } catch {
    readOk = false;
  }
  // A number is protected only when an exit is configured AND that session's
  // exit was CONFIRMED carrying traffic. Anything else is still egressing from
  // the shared datacenter IP, whatever the config says.
  const exposed = hostRows
    .filter((r) => !configured || !r.proxy_verified_at)
    .map((r) => r.host_url);
  const warn = readOk ? clusterWarning(exposed) ?? undefined : undefined;
  if (!configured) {
    return {
      configured: false,
      // Neutral baseline: the session COUNT is not the point when no exit is
      // configured (the tile must not cry wolf), so it stays null exactly as
      // before - the cluster warning below is the only signal that escalates.
      sessions: null,
      verified: null,
      note: warn
        ? `${warn.count} unproxied numbers share ${warn.host} - a datacenter-IP cluster-ban risk. Configure EVOLUTION_PROXY_TEMPLATE or spread the numbers across hosts.`
        : "No residential exit configured - sessions egress from the datacenter IP. Expected baseline; the paid proxy was cut by owner decision.",
      ...(warn ? { clusterWarning: warn } : {}),
    };
  }
  if (readOk) {
    const rows = hostRows;
    const sessions = rows.length;
    const verified = rows.filter((r) => r.proxy_verified_at).length;
    return {
      configured: true,
      sessions,
      verified,
      note: warn
        ? `${verified} of ${sessions} sessions have a confirmed exit, and ${warn.count} unconfirmed numbers share ${warn.host} - a datacenter-IP cluster-ban risk. Verify the exits or spread the numbers across hosts.`
        : verified === sessions
          ? "Every linked session has a confirmed residential exit."
          : `${verified} of ${sessions} sessions have a confirmed exit; the rest are asserted but unverified.`,
      ...(warn ? { clusterWarning: warn } : {}),
    };
  }
  {
    return {
      configured: true,
      sessions: null,
      verified: null,
      note: "An exit is configured, but the session table could not be read - verification is unknown.",
    };
  }
}
