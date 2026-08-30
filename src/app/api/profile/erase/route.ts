import { NextResponse } from "next/server";
import { getSession, clearSessionCookie, isOwner } from "@/lib/session";

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
    return NextResponse.json(
      {
        error: `Some of your data could not be deleted yet (${[
          ...result.failed,
          ...(result.userDeleted ? [] : ["your account row"]),
        ].join(", ")}). Try again in a minute - your account remains until everything is gone.`,
      },
      { status: 500 }
    );
  }

  clearSessionCookie();
  return NextResponse.json({ ok: true });
}
