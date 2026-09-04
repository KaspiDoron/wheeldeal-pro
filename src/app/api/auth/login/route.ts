import { NextResponse } from "next/server";
import { setSessionCookie, getSession, isOwner, sessionSecretReady } from "@/lib/session";
import {
  getUser,
  registerUser,
  isBlocked,
  touchUser,
  verifyPassword,
  setPassword,
} from "@/lib/access";
import { sbInsert } from "@/lib/runtime-config";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RX = /^\+?[\d\s\-()]{7,17}$/;

/**
 * The owner's ONE-TIME bootstrap credential (audit F258). Read from the
 * environment only - there is NO default and no literal in this file: the old
 * well-known default plus the owner address published in the docs let a single
 * anonymous POST install that password on a password-less owner row and mint an
 * owner cookie. Installed with mustChange=true, verified like any other
 * password, and refused (503) when unset or too short to be a credential.
 */
const OWNER_BOOTSTRAP_MIN_LEN = 8;
function ownerBootstrapPassword(): string | null {
  const v = (process.env.OWNER_BOOTSTRAP_PASSWORD ?? "").trim();
  return v.length >= OWNER_BOOTSTRAP_MIN_LEN ? v : null;
}
const bootstrapUnconfigured = () =>
  NextResponse.json(
    {
      error:
        "Owner bootstrap is not configured (owner: set OWNER_BOOTSTRAP_PASSWORD to a one-time secret of at least 8 characters, sign in with it once, then change it in Profile).",
    },
    { status: 503 }
  );

/**
 * Create the owner row on a fresh instance with the bootstrap secret and FORCE
 * a change on first login, so the bootstrap can never remain a live credential.
 * The caller still verifies the submitted password against the row - the
 * bootstrap creates the account, it never signs anyone in by itself.
 */
async function bootstrapOwner(email: string, bootstrap: string, phone?: string) {
  await registerUser({
    email,
    phone,
    password: bootstrap,
    provider: "email",
    acceptedTerms: true,
  });
  await setPassword(email, bootstrap, true);
  return getUser(email, { fresh: true });
}

// Email + password auth. Accounts live durably in Supabase (app_users), so
// logins, signups and password changes work across serverless instances.
//   mode "login"  : { email, password }
//   mode "signup" : { email, phone, password, acceptTerms }
export async function POST(req: Request) {
  if (!sessionSecretReady()) {
    return NextResponse.json(
      { error: "Server is not configured securely yet (owner: set SESSION_SECRET). Try again shortly." },
      { status: 503 }
    );
  }
  const body = await req.json().catch(() => ({}));
  const mode = body.mode === "signup" ? "signup" : "login";
  const email = String(body.email ?? "").trim().toLowerCase();
  const phone = String(body.phone ?? "").trim();
  const password = String(body.password ?? "");
  const acceptTerms = Boolean(body.acceptTerms);
  // Two additional mandatory consents (WhatsApp ban risk + AI responsibility).
  const acceptWaRisk = Boolean(body.acceptWaRisk);
  const acceptAiResp = Boolean(body.acceptAiResp);

  if (!EMAIL_RX.test(email)) {
    return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
  }
  // IP RATE LIMIT, before the first Supabase read. Without it this route is an
  // unthrottled user + beta-allowlist enumeration oracle: the per-email lock
  // below is bypassed by rotating the email, and each attempt costs three
  // Supabase round trips (isBlocked, allowedPlanFor, getUser). 30/hour/IP is far
  // above any real person and closes the oracle to a scripted sweep.
  {
    const { rateLimit, clientIp } = await import("@/lib/rate-limit");
    const ipVerdict = await rateLimit("login-ip", clientIp(req), 30, 3600);
    if (!ipVerdict.ok) {
      return NextResponse.json(
        { error: "Too many attempts from this network. Wait a minute and try again." },
        { status: 429, headers: { "Retry-After": String(ipVerdict.retryAfter) } }
      );
    }
  }
  if (await isBlocked(email)) {
    return NextResponse.json(
      { error: "This account has been restricted by an administrator." },
      { status: 403 }
    );
  }
  // PRIVATE-BETA LOCK: only invited accounts may proceed (allowlist, max 100) - refuse
  // everyone else at the door (both login AND signup), before any account is
  // created or any code is emailed.
  const { allowedPlanFor, BETA_BLOCK_MESSAGE } = await import("@/lib/allowlist");
  const invitedPlan = await allowedPlanFor(email);
  if (invitedPlan === null) {
    return NextResponse.json({ error: BETA_BLOCK_MESSAGE, betaBlocked: true }, { status: 403 });
  }

  if (mode === "signup") {
    if (await getUser(email, { fresh: true })) {
      return NextResponse.json(
        { error: "This email already has an account - use Log in instead." },
        { status: 400 }
      );
    }
    if (!isOwner(email)) {
      if (!PHONE_RX.test(phone)) {
        return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
      }
      if (password.length < 6) {
        return NextResponse.json(
          { error: "Choose a password with at least 6 characters." },
          { status: 400 }
        );
      }
      if (!acceptTerms || !acceptWaRisk || !acceptAiResp) {
        return NextResponse.json(
          { error: "Please tick all three required consents to continue." },
          { status: 400 }
        );
      }
      // Normally a user must prove they own the email via a 6-digit code. In
      // the private beta the account is ALREADY invited by the owner, so if no
      // email provider is configured we let the invited tester in directly
      // rather than block the whole beta on email setup. When email IS set up,
      // we still send the code (extra proof, and it exercises the OTP flow).
      const { startEmailVerification, emailVerificationAvailable } = await import("@/lib/verify");
      if (!(await emailVerificationAvailable())) {
        await registerUser({
          email,
          phone: phone || undefined,
          password,
          provider: "email",
          acceptedTerms: true,
          acceptedWaRisk: true,
          acceptedAiResp: true,
          plan: invitedPlan,
        });
        // fall through to sign the user in below
      } else {
        const started = await startEmailVerification({
          email,
          phone: phone || undefined,
          password,
          acceptedTerms: true,
          acceptedWaRisk: true,
          acceptedAiResp: true,
        });
        if (!started.ok) {
          return NextResponse.json({ error: started.error }, { status: started.cooldown ? 429 : 400 });
        }
        return NextResponse.json({ needsVerification: true, email });
      }
    }
    // Owner bootstrap: no email round-trip needed (invited testers were already
    // registered above in the no-email-provider fall-through). The row is
    // created with the BOOTSTRAP secret - never the caller's own choice - and
    // the submitted password must match it (audit F258): before this, anyone
    // who knew the owner address could sign up as the owner on a fresh
    // deployment with a password of their choosing.
    if (isOwner(email)) {
      const bootstrap = ownerBootstrapPassword();
      if (!bootstrap) return bootstrapUnconfigured();
      const owner = await bootstrapOwner(email, bootstrap, phone || undefined);
      if (!verifyPassword(password, owner?.passwordHash)) {
        return NextResponse.json(
          { error: "Wrong password. Try again or use Forgot password." },
          { status: 401 }
        );
      }
    }
  } else {
    // Brute-force throttle, keyed on (email, ip) - NOT on the email alone.
    // An email-keyed lock was itself a weapon: six wrong passwords from
    // anyone locked the real owner of the address out for 15 minutes,
    // repeatable forever (a lockout DoS on any known email). Keyed on the
    // pair, an attacker only ever locks their own network path; the real
    // person logging in from their own device is untouched, and a rotating
    // attacker still runs into the 30/hour per-IP limit above. Same
    // clientIp discipline as the Google route: the appended hop, never the
    // caller-typed leftmost one.
    const { authLockLeft, noteAuthFailure, clearAuthFailures } = await import("@/lib/cooldown");
    const { clientIp } = await import("@/lib/rate-limit");
    const lockKey = `${email}|ip:${clientIp(req)}`;
    const lockLeft = await authLockLeft(lockKey, "login");
    if (lockLeft > 0) {
      return NextResponse.json(
        { error: `Too many attempts - try again in ${lockLeft} min or use Forgot password.` },
        { status: 429 }
      );
    }
    // Log in - always verify against the freshest durable record.
    let user = await getUser(email, { fresh: true });
    if (!user && isOwner(email)) {
      // Owner bootstrap on a fresh instance: the row is created with the
      // env-only bootstrap secret and FORCED to change on first login, so it
      // can never remain a live credential. Unset -> 503, never a well-known
      // default (audit F258). The submitted password is verified below like
      // any other; setPassword revokes every session, and the caller's own
      // cookie is minted after that, at the end of this handler.
      const bootstrap = ownerBootstrapPassword();
      if (!bootstrap) return bootstrapUnconfigured();
      user = await bootstrapOwner(email, bootstrap);
    }
    if (!user) {
      return NextResponse.json(
        { error: "No account with this email - tap Sign up to create one.", needsSignup: true },
        { status: 400 }
      );
    }
    // A password-less owner row is an account whose credential is Google (the
    // Google route registers it with no hash). It gets the same 401 every other
    // password-less account gets. The re-install branch that used to sit here
    // wrote a well-known password onto that row for ANY anonymous caller - and
    // revoked every live owner session doing it (audit F258).
    if (!verifyPassword(password, user?.passwordHash)) {
      const { locked, lockedMinutes } = await noteAuthFailure(lockKey, "login");
      return NextResponse.json(
        {
          error: locked
            ? `Too many attempts - locked for ${lockedMinutes} min. Use Forgot password.`
            : "Wrong password. Try again or use Forgot password.",
        },
        { status: locked ? 429 : 401 }
      );
    }
    clearAuthFailures(lockKey, "login");
    await touchUser(email);
  }

  // Pin the invited plan (5 pro / 5 ultra testers get their tier automatically;
  // the owner/admins stay Ultra via role). No-op when it already matches.
  if (!isOwner(email) && invitedPlan) {
    const { getUser, setPlan } = await import("@/lib/access");
    const current = await getUser(email, { fresh: true });
    if (current && current.plan !== invitedPlan) await setPlan(email, invitedPlan);
  }

  setSessionCookie(email);
  const session = await getSession();
  await sbInsert("auth_events", [
    { email, event: mode, provider: "email" },
  ]);
  const fresh = await getUser(email);
  return NextResponse.json({
    ok: true,
    session,
    mustChangePassword: Boolean(fresh?.mustChangePassword),
    isNew: mode === "signup",
  });
}
