// Cookie-based sessions with a three-tier role model.
//
// owner  - the single OWNER_EMAIL (default kaspidoron@gmail.com). Can do
//          everything, including managing management.
// admin  - ADMIN_EMAILS env allowlist + admins added at runtime by management
//          (stored in the encrypted Key Vault under ADMIN_EMAILS_EXTRA).
// user   - everyone else.
//
// The cookie is an HMAC-signed token holding only the email; the role is
// re-derived on every request so promotions/demotions apply instantly.
//
// "INSTANTLY" WAS A CLAIM ABOUT THE DERIVATION, NOT ABOUT THE DATA.
//
// The role IS recomputed per request - but the runtime admin list lives in
// `ADMIN_EMAILS_EXTRA`, and that was read through the 30-second WHOLE-VAULT
// cache. Only the instance that performed the demotion dropped its copy, so on
// Cloud Run - where a demotion is served by one container out of N - every other
// warm instance kept honouring the removed admin for up to half a minute, with
// full Key-Vault access. Half a minute is a long time to hold the keys to an
// account somebody has just decided to take them from.
//
// It reads through `getConfigFresh` now: a single-row, 3-second read, the same
// mechanism the safety gates use for `KILL_SWITCH` and for the same reason. It
// fails CLOSED - an unreadable vault yields owner + env admins only - because a
// privilege list we cannot read is not a privilege list we should honour, and
// the owner (env-derived) can never be locked out by it.
//
// The residual window is documented in PRODUCTION-READINESS.md: the user record
// behind `status` / tester flags still carries a 10-second cache.

import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { getConfig, getConfigFresh, setConfig } from "./runtime-config";
import type { Session, Role } from "./types";

const COOKIE = "wd_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
// ABSOLUTE ceiling: slide-renewal extends a session 30 days at a time, which
// without a second clock makes one stolen cookie immortal - each renewal mints
// a fresh issuedAt, forever. firstIssuedAt survives every renewal untouched,
// and past 90 days the session ends no matter how active it looks.
const ABSOLUTE_MAX_AGE = 60 * 60 * 24 * 90; // 90 days, from FIRST issue

const INSECURE_DEFAULT = "dev-insecure-secret-change-me";

/** True when a real signing secret is configured (always true off-production). */
export function sessionSecretReady(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const s = process.env.SESSION_SECRET;
  return Boolean(s && s.length >= 16 && s !== INSECURE_DEFAULT);
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16 && s !== INSECURE_DEFAULT) return s;
  // In production a missing/weak secret would let ANYONE forge the wd_session
  // cookie for any email (including the owner). Refuse to sign or validate
  // rather than hand out forgeable tokens.
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set to a strong value (>= 16 chars) in production.");
  }
  return INSECURE_DEFAULT;
}

export function ownerEmail(): string {
  return (process.env.OWNER_EMAIL || "kaspidoron@gmail.com").toLowerCase();
}

export function isOwner(email: string): boolean {
  return email.trim().toLowerCase() === ownerEmail();
}

function envAdmins(): string[] {
  return (process.env.ADMIN_EMAILS || "kaspidoron@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Full management list: owner + env admins + runtime-added admins.
 *
 * The runtime half is read FRESH (3s, single row) rather than through the 30s
 * vault cache - see the note at the top of this file. An unreadable vault
 * yields owner + env admins only.
 */
export async function adminEmails(): Promise<string[]> {
  const read = await getConfigFresh("ADMIN_EMAILS_EXTRA").catch(() => ({
    error: "unavailable" as const,
  }));
  const raw = "error" in read ? "" : (read.value ?? "");
  const extra = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set([ownerEmail(), ...envAdmins(), ...extra]));
}

export async function roleFor(email: string): Promise<Role> {
  const e = email.trim().toLowerCase();
  if (isOwner(e)) return "owner";
  if ((await adminEmails()).includes(e)) return "admin";
  return "user";
}

/**
 * Add or remove a runtime admin (management action). Owner is immutable.
 *
 * FRESH on the read-modify-write too: through the 30s vault cache, a demotion
 * issued moments after a promotion could rebuild the list from a stale snapshot
 * and hand the admin right back.
 */
export async function setAdmin(email: string, admin: boolean): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (isOwner(e)) return true;
  const current = await getConfigFresh("ADMIN_EMAILS_EXTRA").catch(() => ({
    error: "unavailable" as const,
  }));
  const extra = new Set(
    ("error" in current ? "" : (current.value ?? ""))
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  );
  if (admin) extra.add(e);
  else extra.delete(e);
  // The write's outcome IS the answer - a role change that did not persist is
  // a role change that did not happen, and the caller must be able to say so
  // (the status branch of admin/users already does exactly this).
  const wrote = await setConfig("ADMIN_EMAILS_EXTRA", Array.from(extra).join(",")).catch(
    () => ({ ok: false, persistent: false }) as { ok: boolean; persistent: boolean }
  );
  // A legacy/mocked setConfig that resolves undefined keeps the old behavior.
  return wrote ? wrote.ok : true;
}

// ---- cookie plumbing --------------------------------------------------------

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function setSessionCookie(email: string, opts?: { firstIssuedAt?: number }) {
  const now = Date.now();
  const payload = JSON.stringify({
    email: email.toLowerCase(),
    issuedAt: now,
    // Carried through slide-renewals verbatim; a fresh login starts the
    // 90-day absolute clock at zero.
    firstIssuedAt: opts?.firstIssuedAt || now,
  });
  const b64 = Buffer.from(payload).toString("base64url");
  cookies().set(COOKIE, `${b64}.${sign(b64)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export function clearSessionCookie() {
  cookies().delete(COOKIE);
}

function decode(
  token: string | undefined
): { email: string; issuedAt: number; firstIssuedAt?: number } | null {
  if (!token) return null;
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return null;
  const expected = sign(b64);
  try {
    if (
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    return JSON.parse(Buffer.from(b64, "base64url").toString());
  } catch {
    return null;
  }
}

/** Current session with a freshly-derived role and plan, or null. */
export async function getSession(): Promise<Session | null> {
  let raw: { email: string; issuedAt: number; firstIssuedAt?: number } | null = null;
  try {
    raw = decode(cookies().get(COOKIE)?.value);
  } catch {
    // secret() throws in production without a strong SESSION_SECRET - treat as
    // no session (the app is locked until the secret is set) rather than 500.
    return null;
  }
  if (!raw?.email) return null;
  // SERVER-SIDE EXPIRY: maxAge only tells the BROWSER to drop the cookie -
  // a stolen token replayed directly would otherwise stay valid forever.
  // Reject anything older than the same 30-day window; active sessions are
  // slide-renewed BELOW, after every validity gate has passed - renewing
  // first would hand a blocked or revoked session a fresh cookie whose new
  // issuedAt walks straight past the revocation horizon.
  const ageMs = Date.now() - (Number(raw.issuedAt) || 0);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_AGE * 1000) return null;
  // Absolute lifetime, measured from the FIRST issue. Legacy cookies (minted
  // before firstIssuedAt existed) fall back to issuedAt: their absolute clock
  // starts at their newest renewal, which only ever errs longer by one 30-day
  // window - and every cookie minted from here on carries the real thing.
  const firstIssuedAt = Number(raw.firstIssuedAt) || Number(raw.issuedAt) || 0;
  if (Date.now() - firstIssuedAt > ABSOLUTE_MAX_AGE * 1000) return null;
  const role = await roleFor(raw.email);
  // Management holds the Ultra plan automatically, free of charge.
  const { getUser, normalizePlan } = await import("./access");
  let plan: ReturnType<typeof normalizePlan> = "ultra";

  // REVOCATION IS NOT ADVISORY, AND IT WAS NOT ADVISORY ONLY FOR USERS.
  //
  // getSession re-derived role and plan on every request but never STATUS, so a
  // blocked account kept full API access for the whole 30-day cookie life
  // simply by never calling /me. That was fixed for `user` sessions - and the
  // gate was scoped to them on the assumption that management is never blocked.
  // The admin panel offered the Block button on every admin row, the route
  // performed the write, and the blocked admin kept the Key Vault: the one
  // account whose revocation is urgent was the one revocation did not reach.
  //
  // The owner is deliberately exempt: the owner is derived from OWNER_EMAIL, is
  // refused by the block route, and must not be lockable out of their own
  // product by a row in a table an admin can reach.
  const rec = await getUser(raw.email);
  if (role !== "owner") {
    if (rec?.status === "blocked") return null;
    if (role === "user") plan = normalizePlan(rec?.plan);
  }
  // REVOCATION HORIZON: any cookie issued before sessions_valid_from is dead,
  // whatever its age. Set by password change, block, erasure and "Sign out
  // everywhere" - those flows re-issue THEIR caller's cookie after moving the
  // horizon, so the person who acted stays signed in while every other
  // device's session ends.
  //
  // The OWNER is NOT exempt, unlike the block gate above - and that is not an
  // inconsistency. A blocked owner row would lock the owner out permanently
  // (login refuses blocked accounts), so the block gate must not honour it.
  // The horizon can never do that: a fresh login always mints a cookie that
  // postdates it, so the worst a horizon write can do to the owner is ask them
  // to sign in again - and the owner's cookie is the one whose theft matters
  // most, so their password change MUST end it. A horizon dated in the future
  // is the one shape that WOULD refuse fresh logins; no code path writes one
  // (revokeSessions writes now()), so it can only be corruption - ignored, for
  // everyone, past a small clock-skew allowance.
  const horizon = rec?.sessionsValidFrom;
  if (
    horizon &&
    horizon <= Date.now() + 5 * 60_000 &&
    (Number(raw.issuedAt) || 0) < horizon
  ) {
    return null;
  }
  // Slide-renew past the halfway mark so real users never notice the 30-day
  // window - only now, once the session has proven valid, and carrying the
  // original firstIssuedAt so renewal never resets the absolute clock.
  if (ageMs > (MAX_AGE * 1000) / 2) {
    try {
      setSessionCookie(raw.email, { firstIssuedAt });
    } catch {
      /* renewal is best-effort (read-only contexts cannot set cookies) */
    }
  }
  if (role === "user") {
    // TEST MODE: flagged testers ride Ultra for free while the switch is on -
    // flipping it off instantly returns them to their real (paid) plan, since
    // the plan is re-derived on every request.
    if (plan !== "ultra") {
      try {
        const { isTestUser } = await import("./allowlist");
        if (await isTestUser(raw.email)) plan = "ultra";
      } catch {
        /* never block a session on the test-mode lookup */
      }
    }
  }
  return { email: raw.email, issuedAt: raw.issuedAt, role, plan };
}

/** True for owner or admin. */
export async function requireManagement(): Promise<Session | null> {
  const s = await getSession();
  return s && s.role !== "user" ? s : null;
}

/** Owner ONLY - the Ops Center (cross-user review + learning) gate. */
export async function requireOwner(): Promise<Session | null> {
  const s = await getSession();
  return s && s.role === "owner" ? s : null;
}
