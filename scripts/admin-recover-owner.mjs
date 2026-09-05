#!/usr/bin/env node
// WheelDeal - administrative account recovery (owner / any user).
//
// WHAT IT DOES
//   1. Sets a known password on an account (default: the owner).
//   2. Ensures the account row exists and is ACTIVE (un-blocks it).
//   3. Clears every durable auth lockout (the "Too many attempts - locked
//      for 15 min" brute-force cooldown) so the next login attempt is allowed.
//
// WHY IT IS WRITTEN THIS WAY (read before "fixing" it to use supabase-js auth)
//   WheelDeal does NOT use Supabase Auth. Accounts live in the app's OWN
//   `app_users` table and passwords are hashed with Node scrypt in the format
//   `s1:<salt-hex>:<hash-hex>` (see src/lib/access.ts hashPassword). So:
//     - `supabase.auth.admin.updateUserById(...)` would write the WRONG store
//       (auth.users) and the app would never read it -> login still fails.
//     - The password MUST be a scrypt `s1:...` string or verifyPassword()
//       rejects it. This script reproduces that exact hash with core `crypto`.
//   It also means there is NO `email_confirmed_at` gate in this app: the owner
//   login path bypasses email verification entirely, so "confirming the email"
//   is a no-op here - the account is usable the moment the row + password exist
//   and the lockouts are cleared.
//
//   The lockout ("locked for 15 min") is written to the durable `user_cooldowns`
//   table with kind `lock:login` (see src/lib/cooldown.ts). There is also a
//   per-instance in-memory counter, but that resets on its own when the process
//   rotates; the DURABLE row is the only thing that survives, so deleting it is
//   what actually unlocks the account across every serverless/Cloud Run instance.
//
// SAFETY
//   Reuses the same PostgREST + service-role path the app itself writes with,
//   so the row it produces is byte-identical to what the app reads back. It
//   only ever touches the ONE target email. No secrets are printed.
//
// USAGE
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/admin-recover-owner.mjs --password '<8+ chars>' [--email you@example.com] [--must-change]
//
//   Default: --email kaspidoron@gmail.com. THERE IS NO DEFAULT PASSWORD (audit
//   F258b): the well-known literal this script used to fall back on was a
//   published credential - anyone who could run it installed a known password
//   on the owner row. Pass --password explicitly (8+ characters), or set
//   OWNER_BOOTSTRAP_PASSWORD in the environment - the same one-time secret the
//   login route's owner bootstrap reads - and the script refuses otherwise.
//   A password taken from OWNER_BOOTSTRAP_PASSWORD is installed with
//   must_change_password so it cannot remain a live credential (override with
//   --no-must-change); an explicit --password is left as-is unless --must-change.
//
//   Reads SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY
//   from the environment - the same bootstrap vars the deployed service uses.

import { randomBytes, scryptSync } from "node:crypto";

// ---- args -------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

const EMAIL = String(arg("email", "kaspidoron@gmail.com")).trim().toLowerCase();
// NO BUILT-IN DEFAULT (audit F258b). Explicit --password, or the one-time
// OWNER_BOOTSTRAP_PASSWORD from the environment; anything else is a refusal,
// checked BEFORE the database is even looked for.
const PASSWORD_MIN_LEN = 8;
const explicitPassword = arg("password", "");
const envPassword = String(process.env.OWNER_BOOTSTRAP_PASSWORD ?? "").trim();
const PASSWORD = explicitPassword !== "" ? String(explicitPassword) : envPassword;
const passwordFromEnv = explicitPassword === "" && envPassword !== "";
if (PASSWORD.length < PASSWORD_MIN_LEN) {
  die(
    `A password is required and there is no default: pass --password '<at least ${PASSWORD_MIN_LEN} characters>'\n` +
      "    or set OWNER_BOOTSTRAP_PASSWORD in the environment (the one-time bootstrap secret the login\n" +
      "    route reads). The old built-in default was a published credential and is gone."
  );
}
// A bootstrap secret taken from the environment must never remain a live
// credential (matches the login route's owner bootstrap): force a change on
// next login unless --no-must-change. An explicit --password the operator
// chose is left as-is unless they add --must-change.
const MUST_CHANGE = hasFlag("must-change") || (passwordFromEnv && !hasFlag("no-must-change"));

// ---- connection (mirrors src/lib/runtime-config.ts supabase()) --------------
const URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "")
  .trim()
  .replace(/\/$/, "");
const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!URL || !KEY) {
  die(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set in the environment.\n" +
      "    Copy them from your host (GCP Secret Manager / Cloud Run) or Supabase -> Settings -> API\n" +
      "    (use the service_role secret, NOT the anon key), then re-run."
  );
}

// Confirm the key really is a service_role key (an anon key cannot bypass RLS).
function jwtRole(key) {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()).role ?? null;
  } catch {
    return null;
  }
}
const role = jwtRole(KEY);
if (role && role !== "service_role") {
  die(
    `SUPABASE_SERVICE_ROLE_KEY holds the "${role}" key - that is the WRONG key.\n` +
      "    Use the one labelled service_role (secret) from Supabase -> Settings -> API."
  );
}

// ---- password hashing (IDENTICAL to src/lib/access.ts hashPassword) ---------
function hashPassword(plain) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, 32).toString("hex");
  return `s1:${salt}:${hash}`;
}

// ---- PostgREST helpers (mirror sbSelect / sbInsert / sbUpdate / sbDelete) ----
const rest = (path) => `${URL}/rest/v1/${path}`;
const authHeaders = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

async function sbSelect(table, query) {
  const res = await fetch(rest(`${table}?${query}`), {
    headers: authHeaders,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`select ${table} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function sbUpsert(table, rows, onConflict) {
  const url = onConflict ? rest(`${table}?on_conflict=${onConflict}`) : rest(table);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders, Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert ${table} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}
async function sbDeleteReturning(table, filter) {
  const res = await fetch(rest(`${table}?${filter}`), {
    method: "DELETE",
    headers: { ...authHeaders, Prefer: "return=representation" },
  });
  if (!res.ok) throw new Error(`delete ${table} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---- run --------------------------------------------------------------------
async function main() {
  console.log(`\n  WheelDeal account recovery`);
  console.log(`  ------------------------------------------------------------`);
  console.log(`  Target : ${EMAIL}`);
  console.log(`  Host   : ${URL}`);
  console.log(``);

  // 1. Look up the existing row (owner plan defaults to Ultra = stored 'business').
  const existing = await sbSelect(
    "app_users",
    `select=email,status,plan,provider&email=eq.${encodeURIComponent(EMAIL)}&limit=1`
  );
  const row = existing[0];
  const isOwner = EMAIL === (process.env.OWNER_EMAIL || "kaspidoron@gmail.com").trim().toLowerCase();

  const password_hash = hashPassword(PASSWORD);
  const now = new Date().toISOString();

  if (row) {
    // PATCH-by-upsert: keep the row's plan/provider, force it active, set the
    // password, and drop must_change unless explicitly requested.
    await sbUpsert(
      "app_users",
      [
        {
          email: EMAIL,
          provider: row.provider || "email",
          status: "active",
          plan: row.plan || (isOwner ? "business" : "free"),
          password_hash,
          must_change_password: MUST_CHANGE,
          last_seen: now,
        },
      ],
      "email"
    );
    console.log(`  ✓ Account found - password reset, status set to ACTIVE`);
  } else {
    await sbUpsert(
      "app_users",
      [
        {
          email: EMAIL,
          provider: "email",
          status: "active",
          plan: isOwner ? "business" : "free",
          password_hash,
          must_change_password: MUST_CHANGE,
          added_at: now,
          last_seen: now,
        },
      ],
      "email"
    );
    console.log(`  ✓ Account did not exist - created it ACTIVE with the password`);
  }

  // 2. Clear EVERY durable lockout/cooldown for this email (lock:login,
  //    lock:verify, and any pickup cooldowns). This is what removes the
  //    "Too many attempts - locked for 15 min" wall on the next request.
  const cleared = await sbDeleteReturning(
    "user_cooldowns",
    `email=eq.${encodeURIComponent(EMAIL)}`
  );
  console.log(
    `  ✓ Cleared ${cleared.length} durable lockout/cooldown row(s) (login brute-force lock + others)`
  );

  console.log(``);
  console.log(`  Done. Log in with:`);
  console.log(`      email    : ${EMAIL}`);
  console.log(`      password : ${passwordFromEnv ? "(the OWNER_BOOTSTRAP_PASSWORD you set)" : "(the --password you passed)"}`);
  console.log(``);
  console.log(`  Notes:`);
  console.log(`   - The in-memory attempt counter (if any) is per-instance and`);
  console.log(`     expires on its own; the durable row deleted above is what`);
  console.log(`     actually unlocks the account across all instances.`);
  console.log(`   - This app has no email-confirmation gate for the owner, so`);
  console.log(`     there is nothing else to "confirm" - the account is usable now.`);
  if (MUST_CHANGE) {
    console.log(``);
    console.log(`   ⚠ The account must change this password on its first login (Profile -> password).`);
  }
  console.log(``);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
