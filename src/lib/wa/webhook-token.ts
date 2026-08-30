// Webhook token derivation + URL classification (pure, unit-testable).
//
// The Evolution webhook URL carries a token derived from SESSION_SECRET so only
// our server can post inbound events. When SESSION_SECRET is rotated the derived
// token changes; if Evolution still holds a URL with the OLD token, every event
// 403s. The fix is to RE-ARM Evolution's stored URL with the CURRENT token (see
// reassertWebhook in evolution.ts). These helpers are the pure core of that:
// deriving the current token and classifying whatever URL Evolution reports.
//
// Kept dependency-light (only node crypto) so it tests without env mutation and
// without pulling the server-only evolution.ts graph.

import { createHash, timingSafeEqual } from "crypto";

// A predictable fallback secret would make the webhook/ping token guessable, so
// it is only ever used off-production (mirrors evolution.ts:242-245).
const DEV_FALLBACK = createHash("sha256").update("wd-webhook:dev-only").digest("hex").slice(0, 32);

/**
 * The CURRENT webhook token for a given secret (sha256("wd-webhook:"+secret)
 * .slice(0,32); a <16-char secret yields a dev-only token off-production, null
 * in production).
 *
 * W9: `salt` (env WEBHOOK_TOKEN_SALT) folds into the digest when set, so the
 * webhook token can be ROTATED without touching SESSION_SECRET - which cannot
 * be rotated freely, because it is also the vault's encryption key. Unset salt
 * derives the exact historical token, so nothing re-arms until the owner
 * chooses to rotate; setting it changes every token at once and the next
 * reassertWebhook cycle re-registers the fleet (a short 403 window per host is
 * the rotation's cost, and the 403 breadcrumbs make it visible).
 *
 * DELIBERATELY STILL FLEET-WIDE, not per-instance. hmac(secret, instanceName)
 * would confine a leak to one user, but registration and authentication would
 * then have to agree on the instance name for every event Evolution posts -
 * and Evolution's payloads name the instance in the BODY, which we would have
 * to parse before authenticating. Re-keying every registered host in one
 * flight is also exactly the migration that bricked inbound once before
 * (OR11 I2.4). Recorded as deferred; the salt gives the rotation path that
 * finding actually needed.
 */
export function deriveWebhookToken(opts: {
  secret?: string | null;
  nodeEnv?: string;
  salt?: string | null;
}): string | null {
  const secret = opts.secret;
  if (!secret || secret.length < 16) {
    return opts.nodeEnv === "production" ? null : DEV_FALLBACK;
  }
  const salted = opts.salt ? `wd-webhook:${secret}:${opts.salt}` : `wd-webhook:${secret}`;
  return createHash("sha256").update(salted).digest("hex").slice(0, 32);
}

/**
 * Constant-time token comparison for the webhook/cron gates. The session
 * cookie and the Meta webhook both compare with timingSafeEqual; the Evolution
 * webhook and the tick/ping gates used plain `!==` - same class of secret,
 * weaker comparison. Length is checked first (timingSafeEqual throws on
 * mismatched lengths, and length is not the secret here).
 */
export function tokenMatches(
  presented: string | null | undefined,
  expected: string | null | undefined
): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type TokenState = "current" | "foreign" | "none";

/** Compare a presented token against the current one. */
export function classifyToken(presented: string | null | undefined, current: string | null): TokenState {
  if (!presented) return "none";
  if (current && presented === current) return "current";
  return "foreign";
}

/** Does a registered webhook URL already point at our canonical target with the
 * current token? Tolerant of a trailing slash and extra query params. Pure. */
export function sameWebhookTarget(
  registeredUrl: string | null | undefined,
  origin: string,
  token: string
): boolean {
  if (!registeredUrl) return false;
  try {
    const u = new URL(registeredUrl);
    const expected = new URL(`${origin}/api/webhooks/evolution`);
    if (u.origin !== expected.origin) return false;
    if (u.pathname.replace(/\/$/, "") !== expected.pathname.replace(/\/$/, "")) return false;
    return u.searchParams.get("token") === token;
  } catch {
    return false;
  }
}

/** Classify whatever webhook URL Evolution reports for the WA doctor: is the
 * token current/foreign/absent, and does the origin match our canonical one? */
export function classifyRegisteredWebhook(
  registeredUrl: string | null | undefined,
  currentToken: string | null,
  canonicalOrigin: string | null
): { tokenState: TokenState; originMatch: boolean | null } {
  if (!registeredUrl) return { tokenState: "none", originMatch: null };
  try {
    const u = new URL(registeredUrl);
    const presented = u.searchParams.get("token");
    const originMatch = canonicalOrigin ? u.origin === new URL(canonicalOrigin).origin : null;
    return { tokenState: classifyToken(presented, currentToken), originMatch };
  } catch {
    return { tokenState: "none", originMatch: false };
  }
}
