import { NextResponse } from "next/server";
import { getUser, setPassword } from "@/lib/access";
import { sendEmail } from "@/lib/email";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { randomBytes } from "crypto";

// Forgot password: set a temporary password, email it with an easy-copy block,
// and force a change on next login (profile page opens first).
//
// Order matters: we send the email FIRST and only overwrite the password after
// it is actually on its way, so a broken email setup never locks anyone out.
export async function POST(req: Request) {
  const { email } = await req.json().catch(() => ({}));
  const key = String(email ?? "").trim().toLowerCase();

  // THROTTLE. This route overwrites a real password and emails it, so an
  // unthrottled caller could hammer a known address to keep rewriting its
  // password (locking the owner out) and flood their inbox. Two windows: a
  // tight per-(ip,email) one that stops targeting a single victim, and a looser
  // per-ip one that stops one host cycling through many addresses. Both refuse
  // with the SAME generic body used below, so the throttle leaks no more than
  // the happy path does.
  const ip = clientIp(req);
  const generic = {
    ok: true,
    message:
      "If this email has an account, a temporary password is on its way. Check your inbox (and spam).",
  };
  const perTarget = await rateLimit("forgot", `${ip}:${key}`, 3, 3600);
  const perIp = await rateLimit("forgot-ip", ip, 10, 3600);
  // IP-INDEPENDENT per-victim bucket. The `${ip}:${key}` window resets when the
  // attacker rotates IPs, so without this a known account could be spammed with
  // temporary-password resets (a lockout DoS, since each reset overwrites the
  // real password). A limiter that only ever refuses MORE is always safe to add.
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

  const temp = randomBytes(6).toString("hex").toUpperCase(); // 12 chars, ~48 bits

  const result = await sendEmail({
    to: [key],
    subject: "Your WheelDeal temporary password",
    html: `
      <p>Hi! You asked to reset your WheelDeal password.</p>
      <p>Your temporary password (tap to select, then copy):</p>
      <p style="font-size:22px;font-weight:800;letter-spacing:2px;background:#f4f6f9;border:2px dashed #2f6fed;border-radius:12px;padding:14px 18px;display:inline-block;font-family:monospace">${temp}</p>
      <p>Log in with it, then <b>change your password right away</b> in the
      Profile page (it will open first automatically).</p>
      <p>If you didn't request this, you can ignore this email.</p>
    `,
  });

  if (!result.sent) {
    return NextResponse.json(
      {
        error:
          result.reason === "unconfigured"
            ? "Email sending isn't configured yet (the owner must add RESEND_API_KEY in Admin -> Keys). Your current password is unchanged - ask the app owner to reset it."
            : `The reset email could not be sent (${result.error ?? "email error"}). Your current password is unchanged - try again in a minute.`,
      },
      { status: 503 }
    );
  }

  const saved = await setPassword(key, temp, true);
  if (!saved) {
    return NextResponse.json(
      {
        error:
          "The email was sent but the temporary password could not be saved (database issue). Ask the owner to check Supabase, then request a new reset.",
      },
      { status: 500 }
    );
  }
  return NextResponse.json(generic);
}
