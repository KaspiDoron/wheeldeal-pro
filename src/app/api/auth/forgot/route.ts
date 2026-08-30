import { NextResponse } from "next/server";
import { getUser } from "@/lib/access";
import { startPasswordReset } from "@/lib/verify";
import { rateLimit, clientIp } from "@/lib/rate-limit";

// Forgot password: email a single-use reset LINK. Nothing about the account
// changes at request time - the password is only replaced when the link's
// token is redeemed (see /api/auth/reset), which proves control of the inbox.
//
// The old flow overwrote the real password with a temporary one at request
// time. That meant anyone who knew an email address could destroy its owner's
// working credential (a lockout DoS the rate limits below could only slow
// down) - and once password changes started revoking sessions, a hostile
// request would have signed the victim out of every device too.
export async function POST(req: Request) {
  const { email } = await req.json().catch(() => ({}));
  const key = String(email ?? "").trim().toLowerCase();

  // THROTTLE. The route emails a live reset link, so an unthrottled caller
  // could flood a victim's inbox or hammer many addresses from one host.
  // Three windows: per-(ip,email) stops targeting one victim from one host,
  // per-ip stops one host cycling addresses, and the IP-INDEPENDENT per-victim
  // bucket holds when the attacker rotates IPs. All refuse with the SAME
  // generic body used below, so the throttle leaks no more than the happy path.
  const ip = clientIp(req);
  const generic = {
    ok: true,
    message:
      "If this email has an account, a password reset link is on its way. Check your inbox (and spam).",
  };
  const perTarget = await rateLimit("forgot", `${ip}:${key}`, 3, 3600);
  const perIp = await rateLimit("forgot-ip", ip, 10, 3600);
  const perVictim = await rateLimit("forgot-target", key, 3, 3600);
  if (!perTarget.ok || !perIp.ok || !perVictim.ok) {
    return NextResponse.json(generic, {
      headers: {
        "Retry-After": String(Math.max(perTarget.retryAfter, perIp.retryAfter, perVictim.retryAfter)),
      },
    });
  }

  const user = await getUser(key, { fresh: true });

  // Do not reveal whether an account exists.
  if (!user) return NextResponse.json(generic);

  const result = await startPasswordReset(key);
  if (!result.ok) {
    // A cooldown is not an error the caller can distinguish from success
    // without learning the account exists - generic answer, honest header.
    if (result.cooldown) {
      return NextResponse.json(generic, { headers: { "Retry-After": "30" } });
    }
    return NextResponse.json({ error: result.error }, { status: 503 });
  }
  return NextResponse.json(generic);
}
