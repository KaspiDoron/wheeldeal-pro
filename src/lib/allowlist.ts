// Private-beta access lock.
//
// While the beta lock is ON, ONLY approved accounts may hold a session:
//   - the owner (always allowed, always Ultra/owner)
//   - up to BETA_ALLOWLIST_MAX invited testers, each pinned to a plan
//     (free / pro / ultra)
// Anyone else is refused at EVERY cookie-issuing entry point (email login,
// email-verified signup, Google OAuth) and is also kicked on the next /me poll
// if they were removed mid-session. There is no other way to obtain a session,
// so a non-listed email can never reach an authenticated page.
//
// Source of truth (first match wins):
//   1. Supabase app_config `beta_allowlist`  - JSON [{ email, plan }], editable
//      by the owner in Admin -> Users with NO redeploy.
//   2. env BETA_ALLOWLIST                     - "email:plan" per line/comma.
// The owner is always appended. Toggle the whole gate with env BETA_LOCK=off.

import "server-only";
import { getConfig, setConfig } from "./runtime-config";
import type { PlanId } from "./access";

export interface BetaEntry {
  email: string;
  plan: PlanId;
  // Test user: while global TEST_MODE is on, rides Ultra free + sandbox
  // billing. Backward-compatible - old stored JSON simply lacks the field.
  test?: boolean;
}

/**
 * THE HARD CEILING ON THE TESTER LIST - and the reason it is a constant.
 *
 * This number was written inline as a bare `25` inside `saveBetaAllowlist`,
 * where it silently TRUNCATED every entry past the 25th: the owner pasted a
 * longer list, got a 200, and lost the tail without being told. It also
 * disagreed with the copy in the admin panel the moment either moved.
 *
 * It stays a CAP rather than becoming unbounded - an invite list with no
 * ceiling is how a beta stops being a beta, and the ceiling is what keeps the
 * tester count comparable against fleet capacity (hosts x `maxPerHost`). The
 * value is the only place the number lives; the panel renders it and the save
 * path refuses past it out loud.
 *
 * 100, not 25: the beta target moved to 100 testers, and the old value made
 * that impossible to even invite regardless of how many Evolution hosts exist.
 * Capacity is enforced separately, at link time, by `resolveHost`'s per-host
 * cap - being on the list has never meant a socket is waiting.
 */
export const BETA_ALLOWLIST_MAX = 100;

function ownerEmailLocal(): string {
  return (process.env.OWNER_EMAIL || "kaspidoron@gmail.com").trim().toLowerCase();
}

/** The gate is ON unless explicitly disabled - safe by default for the beta. */
export function betaLockEnabled(): boolean {
  return (process.env.BETA_LOCK ?? "on").trim().toLowerCase() !== "off";
}

function normalizePlanLoose(p: string | undefined): PlanId {
  const v = (p ?? "").trim().toLowerCase();
  if (v === "pro") return "pro";
  if (v === "ultra" || v === "business") return "ultra";
  return "free";
}

function parseEnvList(raw: string | undefined): BetaEntry[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [email, plan] = line.split(/[:|]/).map((x) => x.trim());
      return { email: (email ?? "").toLowerCase(), plan: normalizePlanLoose(plan) };
    })
    .filter((e) => e.email.includes("@"));
}

/** The full, de-duplicated allowlist (owner always included as ultra). */
export async function betaAllowlist(): Promise<BetaEntry[]> {
  const out = new Map<string, PlanId>();
  // Config (owner-editable) first, then env fallback.
  const testFlags = new Map<string, boolean>();
  try {
    const raw = await getConfig("beta_allowlist");
    if (raw) {
      const parsed = JSON.parse(raw) as BetaEntry[];
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          const email = String(e?.email ?? "").trim().toLowerCase();
          if (email.includes("@")) {
            out.set(email, normalizePlanLoose(e?.plan));
            if (e?.test) testFlags.set(email, true);
          }
        }
      }
    }
  } catch {
    /* fall through to env */
  }
  for (const e of parseEnvList(process.env.BETA_ALLOWLIST)) {
    if (!out.has(e.email)) out.set(e.email, e.plan);
  }
  out.set(ownerEmailLocal(), "ultra"); // owner is never lockable
  return [...out.entries()].map(([email, plan]) => ({
    email,
    plan,
    ...(testFlags.get(email) ? { test: true } : {}),
  }));
}

/** The invited plan for an email, or null when the email is NOT allowed. */
export async function allowedPlanFor(email: string): Promise<PlanId | null> {
  const key = email.trim().toLowerCase();
  if (!betaLockEnabled()) return "free"; // gate off: anyone allowed (no pin)
  if (key === ownerEmailLocal()) return "ultra";
  const hit = (await betaAllowlist()).find((e) => e.email === key);
  return hit ? hit.plan : null;
}

/** True when this email may hold a session right now. */
export async function isAllowed(email: string): Promise<boolean> {
  return (await allowedPlanFor(email)) !== null;
}

/** The message shown to a blocked, non-invited visitor. */
export const BETA_BLOCK_MESSAGE =
  "WheelDeal is in a private, invite-only beta. This email is not on the tester list yet - please contact the owner to be added.";

/**
 * Owner action: replace the whole tester list (BETA_ALLOWLIST_MAX besides the
 * owner).
 *
 * Returns what was actually stored AND what was dropped. The old signature
 * returned void while silently binning everything past the cap, so a truncated
 * save and a complete one were indistinguishable to the caller and to the
 * owner. The route surfaces `dropped` so an over-long paste says so.
 */
export async function saveBetaAllowlist(
  entries: BetaEntry[]
): Promise<{ saved: BetaEntry[]; dropped: number; max: number }> {
  const clean: BetaEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const e of entries) {
    const email = String(e?.email ?? "").trim().toLowerCase();
    if (!email.includes("@") || seen.has(email) || email === ownerEmailLocal()) continue;
    seen.add(email);
    if (clean.length >= BETA_ALLOWLIST_MAX) {
      dropped += 1;
      continue;
    }
    clean.push({ email, plan: normalizePlanLoose(e?.plan), ...(e?.test ? { test: true } : {}) });
  }
  await setConfig("beta_allowlist", JSON.stringify(clean));
  return { saved: clean, dropped, max: BETA_ALLOWLIST_MAX };
}

// ---------------------------------------------------------------------------
// TEST MODE - one owner switch: while ON, testers flagged `test` in the beta
// list ride Ultra for free and billing runs in sandbox (plan applied
// instantly, no PayPal round-trip). Flip it OFF and the app is fully
// live again - plans re-derive on the very next request.
// ---------------------------------------------------------------------------

export async function testModeOn(): Promise<boolean> {
  const v = ((await getConfig("TEST_MODE")) ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true";
}

/** Is this email a flagged test user WHILE test mode is on? */
export async function isTestUser(email: string): Promise<boolean> {
  if (!(await testModeOn())) return false;
  const key = email.trim().toLowerCase();
  const entry = (await betaAllowlist()).find((e) => e.email === key);
  return Boolean(entry?.test);
}
