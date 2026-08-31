import { NextResponse } from "next/server";
import { setSessionCookie, getSession, isOwner, sessionSecretReady } from "@/lib/session";
import { getGoogleClientId } from "@/lib/runtime-config";
import { getUser, registerUser, isBlocked, touchUser } from "@/lib/access";

const PHONE_RX = /^\+?[\d\s\-()]{7,17}$/;

// Google's tokeninfo call is the one outbound request on this path, and it was
// the only unbounded fetch left in the app: every other integration
// (runtime-config, google.ts, whatsapp.ts, ai.ts) already carries an
// AbortController. Without one, a Google endpoint that accepts the connection
// and then stalls pins this handler until Cloud Run's request ceiling while the
// browser sits on a spinner with nothing to show - the server half of the
// "OAuth hangs with no feedback" report. 12s matches src/lib/google.ts.
const TOKENINFO_TIMEOUT_MS = 12_000;

async function fetchTokenInfo(credential: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKENINFO_TIMEOUT_MS);
  // Deliberately not cleared at the header boundary: the `res.json()` below
  // shares this signal, so clearing early would leave the body read unbounded.
  (timer as unknown as { unref?: () => void }).unref?.();
  return fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
    { cache: "no-store", signal: ctrl.signal }
  );
}

// Google OAuth sign in (Google Identity Services credential flow).
// The client posts the ID token; we verify it against Google's tokeninfo
// endpoint server-side, then apply the same signup rules as email login.
export async function POST(req: Request) {
  if (!sessionSecretReady()) {
    return NextResponse.json(
      { error: "Server is not configured securely yet (owner: set SESSION_SECRET)." },
      { status: 503 }
    );
  }
  const body = await req.json().catch(() => ({}));
  const credential = String(body.credential ?? "");
  const phone = String(body.phone ?? "").trim();
  const acceptTerms = Boolean(body.acceptTerms);
  const acceptWaRisk = Boolean(body.acceptWaRisk);
  const acceptAiResp = Boolean(body.acceptAiResp);

  if (!credential) {
    return NextResponse.json({ error: "Missing Google credential." }, { status: 400 });
  }

  // Brute-force throttle. /api/auth/login has had one since it was written; this
  // route had none, so a forged credential could be replayed without limit and
  // each attempt cost us a live round trip to Google. The counter is keyed on the
  // CALLER, not on an email, for two reasons: the email is only knowable after a
  // token verifies (so there is nothing else to key on), and an email-keyed
  // counter here would turn a 429 into an account-existence oracle.
  const { authLockLeft, noteAuthFailure, clearAuthFailures } = await import("@/lib/cooldown");
  // The IP comes from clientIp, not from hop 0 of X-Forwarded-For. Google's
  // front end APPENDS the address it saw, so the leftmost hop is whatever the
  // caller typed - a brute-force throttle keyed on it is bypassed by rotating a
  // header. See lib/rate-limit.
  const { clientIp } = await import("@/lib/rate-limit");
  const callerKey = `ip:${clientIp(req)}`;
  const callerLock = await authLockLeft(callerKey, "google");
  if (callerLock > 0) {
    return NextResponse.json(
      { error: `Too many attempts - try again in ${callerLock} min or sign in with email.` },
      { status: 429 }
    );
  }

  // Verify the ID token with Google.
  let email = "";
  let name = "";
  try {
    const res = await fetchTokenInfo(credential);
    const info = await res.json();
    if (!res.ok || !info.email || info.email_verified !== "true") {
      await noteAuthFailure(callerKey, "google");
      return NextResponse.json({ error: "Google sign-in could not be verified." }, { status: 401 });
    }
    // Same resilient resolve as the client button, so token verification and
    // button rendering agree on the client ID across every host/vault state.
    //
    // THE AUDIENCE CHECK IS THE ONLY THING THAT MAKES THIS TOKEN OURS.
    //
    // Google's tokeninfo endpoint will happily validate an ID token minted for
    // ANY OAuth client - that is what it is for. `aud` is the claim that says
    // the token was issued for us. The guard used to be `if (expectedAud && ...)`,
    // and expectedAud comes from the vault, so a Supabase brownout turned it
    // undefined and the check SKIPPED ITSELF: any valid Google ID token from any
    // app in the world, replayed here, minted a wd_session for that token's
    // email. Every account with a Google address was takeoverable for the
    // duration of a database hiccup, and nothing would have logged a thing.
    //
    // An absent secret now REFUSES. A sign-in that fails during a vault outage
    // is an inconvenience with an obvious workaround (email sign-in, which is
    // still up); a sign-in that succeeds without an audience is a full account
    // takeover with no trace.
    const expectedAud = await getGoogleClientId();
    if (!expectedAud) {
      return NextResponse.json(
        { error: "Google sign-in is temporarily unavailable - use email sign-in." },
        { status: 503 }
      );
    }
    if (info.aud !== expectedAud) {
      await noteAuthFailure(callerKey, "google");
      return NextResponse.json({ error: "Google credential audience mismatch." }, { status: 401 });
    }
    email = String(info.email).toLowerCase();
    name = String(info.name ?? "");
  } catch {
    // An AbortError from the 12s deadline lands here too and reads correctly:
    // from the user's side an unanswered Google is an unreachable Google.
    return NextResponse.json({ error: "Could not reach Google to verify." }, { status: 502 });
  }
  clearAuthFailures(callerKey, "google");

  if (await isBlocked(email)) {
    return NextResponse.json(
      { error: "This account has been restricted by an administrator." },
      { status: 403 }
    );
  }
  // PRIVATE-BETA LOCK: Google is a valid credential but the email must still be
  // on the invite allowlist (max 100 entries).
  const { allowedPlanFor, BETA_BLOCK_MESSAGE } = await import("@/lib/allowlist");
  const invitedPlan = await allowedPlanFor(email);
  if (invitedPlan === null) {
    return NextResponse.json({ error: BETA_BLOCK_MESSAGE, betaBlocked: true }, { status: 403 });
  }

  const existing = await getUser(email, { fresh: true });
  const isNew = !existing;
  if (!existing && !isOwner(email)) {
    if (!phone || !PHONE_RX.test(phone) || !acceptTerms || !acceptWaRisk || !acceptAiResp) {
      // Client should collect phone + all three consents, then re-post with the
      // credential. Google accounts never need a password - Google is the credential.
      return NextResponse.json({ needsSignup: true, email, name });
    }
    await registerUser({
      email,
      phone,
      name,
      provider: "google",
      acceptedTerms: true,
      acceptedWaRisk: true,
      acceptedAiResp: true,
    });
  } else if (!existing && isOwner(email)) {
    await registerUser({
      email,
      name,
      provider: "google",
      acceptedTerms: true,
      acceptedWaRisk: true,
      acceptedAiResp: true,
    });
  } else {
    await touchUser(email);
  }

  // Pin the invited plan for tester accounts (owner stays Ultra via role).
  if (!isOwner(email) && invitedPlan) {
    const { getUser: getU, setPlan } = await import("@/lib/access");
    const current = await getU(email, { fresh: true });
    if (current && current.plan !== invitedPlan) await setPlan(email, invitedPlan);
  }

  setSessionCookie(email);
  const session = await getSession();
  const { sbInsert } = await import("@/lib/runtime-config");
  await sbInsert("auth_events", [
    { email, event: isNew ? "signup" : "login", provider: "google" },
  ]);
  return NextResponse.json({ ok: true, session, isNew });
}
