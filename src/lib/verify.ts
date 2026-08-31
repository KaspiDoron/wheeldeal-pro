// Email-ownership verification for signup. A user CANNOT create an account until
// they prove they control the email: we email a 6-digit code, store the pending
// signup (encrypted) + a hash of the code, and only create the account once the
// code is confirmed. Durable in Supabase so it survives serverless restarts.

import "server-only";
import { createHash, createHmac, randomInt } from "crypto";
import {
  sbSelect,
  sbInsert,
  sbDelete,
  encryptString,
  decryptString,
  supabaseConfigured,
} from "./runtime-config";
import { sendEmail } from "./email";
import { boundedSet } from "./bounded-map";

const TTL_MS = 15 * 60_000; // codes expire after 15 minutes
const RESEND_GAP_MS = 30_000; // do not spam: 30s between sends per email

export interface PendingSignup {
  email: string;
  phone?: string;
  password?: string;
  acceptedTerms: boolean;
  acceptedWaRisk?: boolean;
  acceptedAiResp?: boolean;
}

function hashCode(email: string, code: string): string {
  // HMAC under SESSION_SECRET, not a bare sha256. A 6-digit code has only a
  // million shapes, so anyone who can READ email_verifications could brute an
  // unkeyed hash offline in milliseconds and finish someone else's signup.
  // With the server secret in the key, a leaked row alone proves nothing.
  // (The 256-bit reset tokens below stay plain sha256 - guessing a preimage
  // there is not a real path.)
  const key = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
  return createHmac("sha256", key).update(`${email.toLowerCase()}:${code}`).digest("hex");
}

// In-memory fallback when Supabase is not configured (dev only).
declare global {
  // eslint-disable-next-line no-var
  var __wd_email_verify__: Map<string, { codeHash: string; payload: string; exp: number; sentAt: number }> | undefined;
}
function memStore() {
  if (!globalThis.__wd_email_verify__) globalThis.__wd_email_verify__ = new Map();
  return globalThis.__wd_email_verify__;
}

/** True when we can actually send verification emails (Gmail/Brevo/Resend). */
export async function emailVerificationAvailable(): Promise<boolean> {
  const { getConfig } = await import("./runtime-config");
  return Boolean(
    ((await getConfig("GMAIL_USER")) && (await getConfig("GMAIL_APP_PASSWORD"))) ||
      (await getConfig("BREVO_API_KEY")) ||
      (await getConfig("RESEND_API_KEY"))
  );
}

/**
 * Generate + email a 6-digit code and stash the pending signup. Returns
 * { ok } on success, or an error the caller surfaces to the user.
 */
export async function startEmailVerification(
  pending: PendingSignup
): Promise<{ ok: boolean; error?: string; cooldown?: boolean }> {
  const email = pending.email.toLowerCase();

  // Rate-limit resends.
  const existing = await readRow(email);
  if (existing && Date.now() - existing.sentAt < RESEND_GAP_MS) {
    return { ok: false, cooldown: true, error: "Please wait a few seconds before requesting another code." };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = {
    codeHash: hashCode(email, code),
    payload: encryptString(JSON.stringify(pending)),
    exp: Date.now() + TTL_MS,
    sentAt: Date.now(),
  };
  await writeRow(email, row);

  const res = await sendEmail({
    to: [email],
    subject: `Your WheelDeal verification code: ${code}`,
    html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:420px;margin:auto">
      <h2 style="color:#2f6fed">Confirm your email</h2>
      <p>Welcome to WheelDeal! Enter this code to finish creating your account:</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#eef3ff;color:#1b2a4a;padding:16px;border-radius:14px;text-align:center">${code}</div>
      <p style="color:#6b7280;font-size:13px">This code expires in 15 minutes. If you did not request it, ignore this email.</p>
    </div>`,
  });
  if (!res.sent) {
    return {
      ok: false,
      error:
        res.reason === "unconfigured"
          ? "Email sending is not set up yet (owner: add Gmail, Brevo or Resend keys in Admin -> Keys, then tap 'Send live test email')."
          : `Could not send the verification email${res.provider ? ` via ${res.provider}` : ""}: ${
              res.error ?? "unknown error"
            }. Please try again in a moment.`,
    };
  }
  return { ok: true };
}

/** Verify a code. On success returns the pending signup and clears the record. */
export async function confirmEmailVerification(
  emailRaw: string,
  code: string
): Promise<{ ok: boolean; pending?: PendingSignup; error?: string }> {
  const email = emailRaw.toLowerCase();
  const row = await readRow(email);
  if (!row) return { ok: false, error: "No pending verification - start signup again." };
  if (Date.now() > row.exp) {
    await clearRow(email);
    return { ok: false, error: "This code expired - start signup again to get a new one." };
  }
  if (row.codeHash !== hashCode(email, String(code).trim())) {
    return { ok: false, error: "Wrong code. Check the email and try again." };
  }
  const decoded = decryptString(row.payload);
  await clearRow(email);
  if (!decoded) return { ok: false, error: "Verification data was corrupted - start signup again." };
  return { ok: true, pending: JSON.parse(decoded) as PendingSignup };
}

// ---- storage (durable Supabase, else in-memory) ------------------------------

interface Row { codeHash: string; payload: string; exp: number; sentAt: number }

async function readRow(email: string): Promise<Row | null> {
  if (supabaseConfigured()) {
    const rows = await sbSelect<{ code_hash: string; payload: string; expires_at: string; sent_at: string }>(
      "email_verifications",
      `select=code_hash,payload,expires_at,sent_at&email=eq.${encodeURIComponent(email)}&limit=1`
    );
    const r = rows[0];
    return r
      ? { codeHash: r.code_hash, payload: r.payload, exp: Date.parse(r.expires_at), sentAt: Date.parse(r.sent_at) }
      : null;
  }
  return memStore().get(email) ?? null;
}

async function writeRow(email: string, row: Row): Promise<void> {
  if (supabaseConfigured()) {
    await sbInsert(
      "email_verifications",
      [
        {
          email,
          code_hash: row.codeHash,
          payload: row.payload,
          expires_at: new Date(row.exp).toISOString(),
          sent_at: new Date(row.sentAt).toISOString(),
        },
      ],
      "email"
    );
  } else {
    boundedSet(memStore(), email, row, 5000);
  }
}

async function clearRow(email: string): Promise<void> {
  if (supabaseConfigured()) await sbDelete("email_verifications", `email=eq.${encodeURIComponent(email)}`);
  else memStore().delete(email);
}

/** Discard a pending verification (e.g. after too many wrong-code attempts). */
export async function clearEmailVerification(email: string): Promise<void> {
  await clearRow(email.toLowerCase());
}

// ---- Password reset tokens ---------------------------------------------------
//
// A reset REQUEST must not change anything. The old flow overwrote the real
// password with a temporary one at request time, which handed anyone who knew
// an email address a lockout button (rate-limited, but still a lockout button)
// - and once a password change started revoking sessions, it would have signed
// the victim out of every device too. Token flow: the request only stores a
// hash and emails a link; the password changes ONLY when the link's token is
// redeemed, which proves control of the inbox.
//
// Rows share email_verifications, namespaced under `reset:<email>` so a
// pending signup and a pending reset can never collide. Only the sha256 of the
// token is stored - a database read cannot mint a working link.

const RESET_TTL_MS = 30 * 60_000; // reset links live 30 minutes

function resetKey(email: string): string {
  return `reset:${email.toLowerCase()}`;
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(`reset:${token}`).digest("hex");
}

/**
 * Create a reset token for an EXISTING account and email the link. The caller
 * has already decided the account exists and handled enumeration concerns.
 */
export async function startPasswordReset(
  emailRaw: string
): Promise<{ ok: boolean; error?: string; cooldown?: boolean }> {
  const email = emailRaw.toLowerCase();

  const existing = await readRow(resetKey(email));
  if (existing && Date.now() - existing.sentAt < RESEND_GAP_MS) {
    return { ok: false, cooldown: true, error: "Please wait a few seconds before requesting another link." };
  }

  const { randomBytes } = await import("crypto");
  const token = randomBytes(32).toString("base64url");
  await writeRow(resetKey(email), {
    codeHash: hashResetToken(token),
    payload: "",
    exp: Date.now() + RESET_TTL_MS,
    sentAt: Date.now(),
  });

  const { resolveSiteOrigin } = await import("./site");
  const origin = await resolveSiteOrigin();
  const link = `${origin}/login?reset=${token}`;
  const res = await sendEmail({
    to: [email],
    subject: "Reset your WheelDeal password",
    html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:420px;margin:auto">
      <h2 style="color:#2f6fed">Reset your password</h2>
      <p>Tap the button below to choose a new WheelDeal password. Your current
      password keeps working until you do.</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${link}" style="background:#2f6fed;color:#fff;font-weight:800;padding:14px 26px;border-radius:14px;text-decoration:none;display:inline-block">Choose a new password</a>
      </p>
      <p style="color:#6b7280;font-size:13px">This link expires in 30 minutes and works once.
      If you did not request it, ignore this email - nothing changes.</p>
    </div>`,
  });
  if (!res.sent) {
    // The stored hash is harmless on its own (it expires, and no email carried
    // the token), but do not leave a live token nobody can ever receive.
    await clearRow(resetKey(email)).catch(() => undefined);
    return {
      ok: false,
      error:
        res.reason === "unconfigured"
          ? "Email sending isn't configured yet (the owner must add an email key in Admin -> Keys). Your current password is unchanged - ask the app owner to reset it."
          : `The reset email could not be sent (${res.error ?? "email error"}). Your current password is unchanged - try again in a minute.`,
    };
  }
  return { ok: true };
}

/**
 * Redeem a reset token: returns the account email exactly once, clearing the
 * row. The caller sets the new password and signs the person in.
 */
export async function redeemPasswordReset(
  token: string
): Promise<{ ok: boolean; email?: string; error?: string }> {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) return { ok: false, error: "This reset link is incomplete - request a new one." };
  const hash = hashResetToken(trimmed);

  let email: string | null = null;
  let exp = 0;
  if (supabaseConfigured()) {
    const rows = await sbSelect<{ email: string; expires_at: string }>(
      "email_verifications",
      `select=email,expires_at&code_hash=eq.${encodeURIComponent(hash)}&limit=1`
    );
    const r = rows[0];
    if (r?.email?.startsWith("reset:")) {
      email = r.email.slice("reset:".length);
      exp = Date.parse(r.expires_at);
    }
  } else {
    for (const [key, row] of memStore()) {
      if (key.startsWith("reset:") && row.codeHash === hash) {
        email = key.slice("reset:".length);
        exp = row.exp;
        break;
      }
    }
  }
  if (!email) return { ok: false, error: "This reset link is invalid or was already used - request a new one." };
  await clearRow(resetKey(email));
  if (Date.now() > exp) {
    return { ok: false, error: "This reset link expired - request a new one." };
  }
  return { ok: true, email };
}
