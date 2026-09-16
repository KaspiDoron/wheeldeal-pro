import { NextResponse } from "next/server";
import { getSession, clearSessionCookie, isOwner } from "@/lib/session";
import { clearCookieConsentCookies } from "@/lib/cookies/server";

// Self-serve account erasure (the DSAR "right to be forgotten" half of
// /api/profile/export). Same walker as the admin Users action - the registry
// in src/lib/privacy/user-tables is the single source of what gets deleted.
//
// The confirmation is typed, not clicked: the request must carry the account's
// own email back, so a stray POST (a prefetch, a replayed request, a buggy
// client) can never destroy an account.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (isOwner(session.email)) {
    return NextResponse.json(
      { error: "The owner account cannot erase itself - transfer ownership first." },
      { status: 400 }
    );
  }

  const { confirm } = await req.json().catch(() => ({}));
  if (String(confirm ?? "").trim().toLowerCase() !== session.email) {
    return NextResponse.json(
      { error: "Type your email address to confirm - this deletes your account and every trace of your data." },
      { status: 400 }
    );
  }

  const { eraseUserData } = await import("@/lib/privacy/erase");
  const result = await eraseUserData(session.email);

  if (result.failed.length || !result.userDeleted) {
    // The truth, and a path forward: the account still exists (deleted LAST,
    // exactly so a partial failure can retry), so they can try again or ask
    // the operator to finish it.
    // `whatsapp:link` (audit F057) = the Evolution instance could not be
    // confirmed deleted, so the person's WhatsApp may still be linked.
    const named = result.failed.map((f) => (f === "whatsapp:link" ? "your WhatsApp link" : f));
    return NextResponse.json(
      {
        error: `Some of your data could not be deleted yet (${[
          ...named,
          ...(result.userDeleted ? [] : ["your account row"]),
        ].join(", ")}). Try again in a minute - your account remains until everything is gone.`,
      },
      { status: 500 }
    );
  }

  clearSessionCookie();
  // THE COOKIES GO TOO. Erasure walks every table that keys the person, and
  // then the browser they are sitting in front of still carries their analytics
  // id and their recorded cookie choices - a fragment of a person we just said
  // we had deleted, ready to stamp the next rows if they sign up again. The
  // ledger ROWS are already gone with consent_events; these are their echo on
  // the device, and clearing them is the difference between "we deleted your
  // data" and "we deleted the copy you cannot see".
  clearCookieConsentCookies();
  return NextResponse.json({ ok: true });
}
