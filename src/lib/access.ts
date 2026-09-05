// User registry / access control, with password auth and plans.
//
// Supabase (app_users) is the DURABLE source of truth: signups, password
// changes and plan upgrades are written there and read back on every lookup,
// so accounts work across serverless instances and deploys. A short in-memory
// cache keeps latency low, and everything still works (non-durably) with no
// Supabase configured.
//
// Plan naming: the top tier is "ultra" in the product. It is stored as
// "business" in the app_users.plan column (legacy check constraint) and
// normalised on read, so old databases keep working without a migration.

import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import {
  sbInsert,
  sbSelect,
  sbSelectStrict,
  sbDelete,
  sbUpdate,
  supabaseConfigured,
} from "./runtime-config";
import { boundedSet } from "./bounded-map";

export type PlanId = "free" | "pro" | "ultra";

/** Normalise any stored plan value ("business" was renamed to Ultra). */
export function normalizePlan(p: string | undefined | null): PlanId {
  if (p === "pro") return "pro";
  if (p === "ultra" || p === "business") return "ultra";
  return "free";
}

/** Value written to the app_users.plan column (kept legacy-compatible). */
function dbPlan(p: PlanId): string {
  return p === "ultra" ? "business" : p;
}

export interface UserRecord {
  email: string;
  phone?: string;
  name?: string;
  provider: "email" | "google" | "dev";
  status: "active" | "blocked";
  plan: PlanId;
  passwordHash?: string;
  mustChangePassword?: boolean;
  termsAcceptedAt?: number;
  /**
   * WHICH VERSION they accepted. The column shipped with the schema and nothing
   * ever wrote it, so a TERMS_VERSION bump changed the document under everyone
   * with no re-acceptance and no way to say what anyone had agreed to - see
   * lib/consent.
   */
  termsVersion?: string;
  // The two additional mandatory consents (WhatsApp ban risk + AI responsibility).
  waRiskAcceptedAt?: number;
  aiResponsibilityAcceptedAt?: number;
  // Where the traveller is staying (for delivery). Shared with shops ONLY when
  // stayShareConsentAt is set - coordinates never leave the app without it.
  stayLabel?: string;
  stayLat?: number;
  stayLng?: number;
  stayShareConsentAt?: number;
  /** REVOCATION HORIZON (ms): any session cookie issued BEFORE this instant is
   *  dead, whatever its own age says. Set by password change/reset, block,
   *  erase and "Sign out everywhere"; checked in getSession. */
  sessionsValidFrom?: number;
  addedAt: number;
  lastSeen: number;
}

interface CacheEntry {
  rec: UserRecord;
  fetchedAt: number;
}

const CACHE_TTL_MS = 10_000;

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_users_v2__: Map<string, CacheEntry> | undefined;
}

function cache() {
  if (!globalThis.__wheeldeal_users_v2__) {
    globalThis.__wheeldeal_users_v2__ = new Map();
  }
  return globalThis.__wheeldeal_users_v2__;
}

function remember(rec: UserRecord) {
  boundedSet(cache(), rec.email, { rec, fetchedAt: Date.now() }, 5000);
}

// ---- password hashing --------------------------------------------------------

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, 32).toString("hex");
  return `s1:${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored?: string): boolean {
  if (!stored) return false;
  const [v, salt, hash] = stored.split(":");
  if (v !== "s1" || !salt || !hash) return false;
  const candidate = scryptSync(plain, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

// ---- Supabase row mapping -----------------------------------------------------

interface UserRow {
  email: string;
  phone: string | null;
  name: string | null;
  provider: string | null;
  status: string | null;
  plan: string | null;
  password_hash: string | null;
  must_change_password: boolean | null;
  terms_accepted_at: string | null;
  terms_version: string | null;
  wa_risk_accepted_at: string | null;
  ai_responsibility_accepted_at: string | null;
  stay_label: string | null;
  stay_lat: number | null;
  stay_lng: number | null;
  stay_share_consent_at: string | null;
  sessions_valid_from: string | null;
  added_at: string | null;
  last_seen: string | null;
}

function fromRow(r: UserRow): UserRecord {
  return {
    email: r.email,
    phone: r.phone ?? undefined,
    name: r.name ?? undefined,
    provider: (["email", "google", "dev"].includes(r.provider ?? "")
      ? r.provider
      : "email") as UserRecord["provider"],
    status: r.status === "blocked" ? "blocked" : "active",
    plan: normalizePlan(r.plan),
    passwordHash: r.password_hash ?? undefined,
    mustChangePassword: Boolean(r.must_change_password),
    termsAcceptedAt: r.terms_accepted_at ? Date.parse(r.terms_accepted_at) : undefined,
    termsVersion: r.terms_version ?? undefined,
    waRiskAcceptedAt: r.wa_risk_accepted_at ? Date.parse(r.wa_risk_accepted_at) : undefined,
    aiResponsibilityAcceptedAt: r.ai_responsibility_accepted_at
      ? Date.parse(r.ai_responsibility_accepted_at)
      : undefined,
    stayLabel: r.stay_label ?? undefined,
    stayLat: typeof r.stay_lat === "number" ? r.stay_lat : undefined,
    stayLng: typeof r.stay_lng === "number" ? r.stay_lng : undefined,
    stayShareConsentAt: r.stay_share_consent_at ? Date.parse(r.stay_share_consent_at) : undefined,
    sessionsValidFrom: r.sessions_valid_from ? Date.parse(r.sessions_valid_from) : undefined,
    addedAt: r.added_at ? Date.parse(r.added_at) : Date.now(),
    lastSeen: r.last_seen ? Date.parse(r.last_seen) : Date.now(),
  };
}

/** Write a record to Supabase. Returns false when the durable write failed. */
async function mirror(rec: UserRecord): Promise<boolean> {
  remember(rec);
  const base = {
    email: rec.email,
    phone: rec.phone ?? null,
    name: rec.name ?? null,
    provider: rec.provider,
    status: rec.status,
    plan: dbPlan(rec.plan),
    password_hash: rec.passwordHash ?? null,
    must_change_password: rec.mustChangePassword ?? false,
    terms_accepted_at: rec.termsAcceptedAt ? new Date(rec.termsAcceptedAt).toISOString() : null,
    last_seen: new Date(rec.lastSeen).toISOString(),
  };
  const withConsents = {
    ...base,
    wa_risk_accepted_at: rec.waRiskAcceptedAt ? new Date(rec.waRiskAcceptedAt).toISOString() : null,
    ai_responsibility_accepted_at: rec.aiResponsibilityAcceptedAt
      ? new Date(rec.aiResponsibilityAcceptedAt).toISOString()
      : null,
  };
  const withStay = {
    ...withConsents,
    stay_label: rec.stayLabel ?? null,
    stay_lat: rec.stayLat ?? null,
    stay_lng: rec.stayLng ?? null,
    stay_share_consent_at: rec.stayShareConsentAt
      ? new Date(rec.stayShareConsentAt).toISOString()
      : null,
  };
  // sbInsert fails silently on an unknown column, so before a column migration
  // runs the whole upsert (and thus signup) would break. Three-tier fallback so
  // registration never depends on a pending migration, and adding the stay
  // columns never regresses the already-migrated consent columns.
  if (await sbInsert("app_users", [withStay], "email")) return true;
  if (await sbInsert("app_users", [withConsents], "email")) return true;
  return sbInsert("app_users", [base], "email");
}

/** The traveller's consented stay for the agent - null when none/unconsented. */
export async function getUserStay(
  email: string
): Promise<{ label: string; lat?: number; lng?: number; shareConsent: boolean } | null> {
  const rec = await getUser(email);
  if (!rec?.stayLabel) return null;
  const shareConsent = Boolean(rec.stayShareConsentAt);
  return {
    label: rec.stayLabel,
    // Coordinates ONLY travel with explicit consent (privacy).
    lat: shareConsent ? rec.stayLat : undefined,
    lng: shareConsent ? rec.stayLng : undefined,
    shareConsent,
  };
}

/** Save the traveller's stay + the explicit share-with-shops consent. */
export async function setUserStay(
  email: string,
  stay: { label?: string; lat?: number; lng?: number; shareConsent: boolean }
): Promise<boolean> {
  const rec = await getUser(email, { fresh: true });
  if (!rec) return false;
  rec.stayLabel = stay.label?.trim() || undefined;
  rec.stayLat = typeof stay.lat === "number" ? stay.lat : undefined;
  rec.stayLng = typeof stay.lng === "number" ? stay.lng : undefined;
  // Consent is a server-recorded timestamp; clearing it revokes sharing.
  rec.stayShareConsentAt = stay.shareConsent && rec.stayLabel ? Date.now() : undefined;
  const persisted = await mirror(rec);
  return supabaseConfigured() ? persisted : true;
}

// ---- CRUD ---------------------------------------------------------------------

/**
 * Look a user up. Reads through to Supabase (the durable store) with a short
 * per-instance cache; pass { fresh: true } for auth-critical checks.
 */
export async function getUser(
  email: string,
  opts?: { fresh?: boolean }
): Promise<UserRecord | undefined> {
  const key = email.trim().toLowerCase();
  const hit = cache().get(key);
  if (hit && !opts?.fresh && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.rec;
  }
  if (supabaseConfigured()) {
    // A FRESH READ MUST NOT SERVE STALE. Callers pass {fresh:true} to get ground
    // truth (password reset checks whether an account still exists). sbSelect
    // collapses a transient failure and a genuinely-empty result to the same
    // []], so the old code fell back to the 10s cache on BOTH - reporting a
    // deleted account as still present. sbSelectStrict separates them: an empty
    // read means the row is gone (return undefined); only an UNAVAILABLE read
    // (transient) falls back to cache, so a DB hiccup never wrongly reports a
    // real account as missing.
    //
    // THE NON-FRESH READ MUST NOT SERVE A CONFIRMED-GONE ROW EITHER (audit
    // F048). It used sbSelect and fell through to the cache on `[]` - which is
    // exactly what an erased account reads as - so on every warm container
    // except the one that ran the delete, the erased traveller's cached record
    // (status active, pre-revocation horizon) kept their cookie alive and
    // re-created rows under the deleted email. Both branches are now the same
    // single strict call: rows = remember; a POSITIVE empty read = the row is
    // gone, drop it from this cache and say so; missing/unavailable = fall
    // back to the cache, so an outage or an un-migrated table never signs the
    // fleet out.
    const read = await sbSelectStrict<UserRow>(
      "app_users",
      `select=*&email=eq.${encodeURIComponent(key)}&limit=1`
    );
    if ("rows" in read) {
      if (read.rows.length) {
        const rec = fromRow(read.rows[0]);
        remember(rec);
        return rec;
      }
      cache().delete(key);
      return undefined;
    }
  }
  // Unreadable store (or no Supabase): fall back to what this instance knows.
  return hit?.rec;
}

export async function registerUser(u: {
  email: string;
  phone?: string;
  name?: string;
  password?: string;
  provider: "email" | "google" | "dev";
  acceptedTerms: boolean;
  acceptedWaRisk?: boolean;
  acceptedAiResp?: boolean;
  plan?: PlanId;
}): Promise<UserRecord> {
  const key = u.email.trim().toLowerCase();
  const now = Date.now();
  const existing = await getUser(key, { fresh: true });
  const rec: UserRecord = existing
    ? {
        ...existing,
        phone: u.phone || existing.phone,
        name: u.name || existing.name,
        passwordHash: u.password ? hashPassword(u.password) : existing.passwordHash,
        plan: u.plan ?? existing.plan,
        lastSeen: now,
      }
    : {
        email: key,
        phone: u.phone,
        name: u.name,
        provider: u.provider,
        status: "active",
        plan: u.plan ?? "free",
        passwordHash: u.password ? hashPassword(u.password) : undefined,
        termsAcceptedAt: u.acceptedTerms ? now : undefined,
        waRiskAcceptedAt: u.acceptedWaRisk ? now : undefined,
        aiResponsibilityAcceptedAt: u.acceptedAiResp ? now : undefined,
        addedAt: now,
        lastSeen: now,
      };
  // The durable write is what makes the account (and its phone) survive
  // sign-out, new serverless instances and cache expiry. Never trust the
  // 10s memory cache alone: retry once, then leave a visible trail.
  let persisted = await mirror(rec);
  if (!persisted && supabaseConfigured()) {
    persisted = await mirror(rec);
    if (!persisted) {
      await sbInsert("agent_events", [
        {
          kind: "user-persist-failed",
          vendor_id: "",
          vendor_name: key,
          detail: "app_users upsert failed twice - phone/profile may not survive this instance",
        },
      ]).catch(() => {});
    }
  }
  return rec;
}

/**
 * Set a new password. Returns false when the user does not exist OR when the
 * durable write failed (so callers can tell the user instead of lying).
 */
export async function setPassword(
  email: string,
  password: string,
  mustChange = false
): Promise<boolean> {
  const rec = await getUser(email, { fresh: true });
  if (!rec) return false;
  rec.passwordHash = hashPassword(password);
  rec.mustChangePassword = mustChange;
  const persisted = await mirror(rec);
  // A credential change is a REVOCATION EVENT: every outstanding cookie was
  // minted under the old password, and the likeliest reason for the change is
  // that someone else may hold one. Best-effort - the password change itself
  // must never fail on the revocation column being un-migrated - and the
  // caller re-issues its own cookie so the person changing stays signed in.
  if (persisted) await revokeSessions(email).catch(() => false);
  return supabaseConfigured() ? persisted : true;
}

/**
 * Kill every outstanding session for this account: cookies issued before this
 * instant are refused by getSession from the next request on. Returns whether
 * the horizon PERSISTED (an un-migrated column returns false - callers that
 * promise "signed out everywhere" must not claim it on a failed write).
 */
export async function revokeSessions(email: string): Promise<boolean> {
  const key = email.trim().toLowerCase();
  const nowIso = new Date().toISOString();
  const wrote = await sbUpdate("app_users", `email=eq.${encodeURIComponent(key)}`, {
    sessions_valid_from: nowIso,
  }).catch(() => false);
  // Keep this instance's cache honest immediately - the fresh read path would
  // catch up anyway, but a 10s window on a revocation is 10s too many.
  const cached = cache().get(key)?.rec;
  if (cached) cached.sessionsValidFrom = Date.parse(nowIso);
  return wrote;
}

/**
 * Permanently erase a user (not a block): removes their account row from the
 * durable store and the in-memory cache. The caller also severs the user's
 * WhatsApp link so nothing about them remains.
 */
export async function deleteUser(email: string): Promise<boolean> {
  const key = email.toLowerCase();
  cache().delete(key);
  cache().delete(email);
  return sbDelete("app_users", `email=eq.${encodeURIComponent(key)}`);
}

/**
 * Grant a plan. Returns whether the grant actually PERSISTED.
 *
 * This used to be `Promise<void>`, and mirror()'s boolean was thrown away. So
 * the two ways a paid upgrade can be lost - the user row cannot be read, or the
 * write to app_users fails - both looked identical to success at every call
 * site. The traveller paid, PayPal captured, the confirm route answered
 * `{ok:true}`, and the account stayed on `free` with nothing anywhere recording
 * that it had not worked.
 *
 * Callers that took money MUST check this and tell the person the truth.
 */
export async function setPlan(email: string, plan: PlanId): Promise<boolean> {
  const rec = await getUser(email, { fresh: true });
  if (!rec) return false;
  rec.plan = plan;
  return await mirror(rec);
}

export async function touchUser(email: string): Promise<void> {
  const rec = await getUser(email);
  if (!rec) return;
  rec.lastSeen = Date.now();
  await mirror(rec);
}

export async function isBlocked(email: string): Promise<boolean> {
  return (await getUser(email))?.status === "blocked";
}

/**
 * Registered users, durable store first, newest activity first.
 *
 * PAGED and QUERY-SEARCHED. The hard 500-row window used to be the whole
 * answer: with more accounts the older ones were unreachable through any UI,
 * a search matched only inside the window ("No users match" about a user who
 * exists), and the Users tab silently disagreed with the Analytics tab's
 * exact total. `q` runs as an ilike on the email COLUMN so a match beyond
 * the current page is still found.
 */
export async function listUsers(
  opts: { q?: string; offset?: number; limit?: number } = {}
): Promise<UserRecord[]> {
  const limit = Math.min(500, Math.max(1, Math.round(opts.limit ?? 500)));
  const offset = Math.max(0, Math.round(opts.offset ?? 0));
  const needle = (opts.q ?? "").trim().toLowerCase().replace(/[,()."'\\%*]/g, "").slice(0, 60);
  const qFilter = needle ? `&email=ilike.${encodeURIComponent(`*${needle}*`)}` : "";
  const seen = new Map<string, UserRecord>();
  if (supabaseConfigured()) {
    const rows = await sbSelect<UserRow>(
      "app_users",
      `select=*${qFilter}&order=last_seen.desc&limit=${limit}&offset=${offset}`
    );
    for (const r of rows) {
      const rec = fromRow(r);
      seen.set(rec.email, rec);
      remember(rec);
    }
  }
  // Include anything this instance knows that has not landed durably yet -
  // first page only, or a fresh signup would be appended to every later page.
  if (offset === 0) {
    for (const { rec } of cache().values()) {
      if (seen.has(rec.email)) continue;
      if (needle && !rec.email.includes(needle)) continue;
      seen.set(rec.email, rec);
    }
  }
  return [...seen.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Block or unblock an account. Returns whether the status write PERSISTED
 * (in demo mode, true) - the admin route reads the list back as well, but a
 * caller such as the integrity ladder has only this to go on.
 */
export async function setUserStatus(
  email: string,
  status: "active" | "blocked"
): Promise<boolean> {
  const key = email.trim().toLowerCase();
  const rec = (await getUser(key, { fresh: true })) ?? {
    email: key,
    provider: "email" as const,
    status,
    plan: "free" as PlanId,
    addedAt: Date.now(),
    lastSeen: Date.now(),
  };
  rec.status = status;
  const persisted = await mirror(rec);
  // Blocking is the urgent revocation: the status check in getSession already
  // refuses blocked accounts per-request, and the horizon closes the remaining
  // door (a race with the 10s cache, an unblock-then-reblock).
  if (status === "blocked") await revokeSessions(key).catch(() => false);
  // ...and the wire half: nothing parked drains, no shop reply is answered.
  if (status === "blocked") await cancelWireForUser(key);
  return supabaseConfigured() ? persisted : true;
}

/**
 * THE WIRE HALF OF A BLOCK (audit F049). The cookie revocation above stops the
 * browser; it stopped nothing on WhatsApp. No send path reads account status -
 * the fleet drain selects wa_outbox fleet-wide and the inbound path is
 * token/claim-gated - so a blocked traveller's parked batch kept draining from
 * their own linked number and every shop reply kept getting an agent answer.
 *
 * Done on the WRITE side, the way disconnectInstance and closeSearchSession
 * already are, so nothing is added to the drain or the reply path: purge the
 * sender's parked outbox rows and wakeups, then tombstone every shop the
 * account has contacted in wa_cancellations - the veto guardOutbound already
 * enforces on every automated send, so a shop reply that arrives after the
 * block is refused at the send moment. Best-effort per step: the status write
 * and the horizon have already landed, and a purge that could not run must
 * not un-block the account.
 */
async function cancelWireForUser(key: string): Promise<void> {
  const enc = encodeURIComponent(key);
  const rc = await import("./runtime-config");
  const purged = await rc
    .sbDeleteReturning<{ to_number: string }>("wa_outbox", `sender_key=eq.${enc}`)
    .catch(() => [] as { to_number: string }[]);
  await rc.sbDelete("graph_wakeups", `user_email=eq.${enc}`).catch(() => {});
  // wa_recipient_state holds exactly one row per shop this sender has ever
  // contacted - including the live threads with no outbox row, whose next
  // inbound would otherwise still trigger an auto-answer. No time window: a
  // block means every thread, warm or cold.
  const contacted = await sbSelect<{ to_number: string }>(
    "wa_recipient_state",
    `select=to_number&sender_key=eq.${enc}&limit=500`
  ).catch(() => [] as { to_number: string }[]);
  const digits = new Set<string>(
    [...purged.map((r) => r.to_number), ...contacted.map((r) => r.to_number)].filter(Boolean)
  );
  if (digits.size === 0) return;
  const { cancelSends } = await import("./wa/cancellations");
  for (const d of digits) {
    await cancelSends(key, d, "account-blocked").catch(() => false);
  }
}
