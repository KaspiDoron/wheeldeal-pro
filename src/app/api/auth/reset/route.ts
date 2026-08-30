import { NextResponse } from "next/server";
import { redeemPasswordReset } from "@/lib/verify";
import { setPassword, getUser } from "@/lib/access";
import { setSessionCookie } from "@/lib/session";
import { rateLimit, clientIp } from "@/lib/rate-limit";

// Redeem a password-reset token (from the emailed /login?reset=<token> link)
// and set the new password in the same request. Redemption proves control of
// the inbox, so the person is signed in directly - and because setPassword
// moves the session revocation horizon, every other device (including whoever
// prompted the reset by holding a stolen session) is signed out.
export async function POST(req: Request) {
  // The token carries 256 bits - guessing is not a real path - but a redeem
  // endpoint that writes passwords has no business being hammerable at all.
  const gate = await rateLimit("reset-redeem", clientIp(req), 10, 3600);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many attempts - try again later." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } }
    );
  }

  const { token, next } = await req.json().catch(() => ({}));
  if (typeof next !== "string" || next.length < 6) {
    return NextResponse.json(
      { error: "New password needs at least 6 characters." },
      { status: 400 }
    );
  }

  const redeemed = await redeemPasswordReset(String(token ?? ""));
  if (!redeemed.ok || !redeemed.email) {
    return NextResponse.json({ error: redeemed.error }, { status: 400 });
  }

  // The account may have been erased between request and redemption.
  const user = await getUser(redeemed.email, { fresh: true });
  if (!user) {
    return NextResponse.json(
      { error: "This account no longer exists - sign up again." },
      { status: 400 }
    );
  }

  const saved = await setPassword(redeemed.email, next, false);
  if (!saved) {
    return NextResponse.json(
      {
        error:
          "Could not save the new password to the database - your OLD password still works. Try again in a minute, or request a new link.",
      },
      { status: 500 }
    );
  }
  try {
    setSessionCookie(redeemed.email);
  } catch {
    /* they can sign in with the password they just set */
  }
  return NextResponse.json({ ok: true });
}
