import { NextResponse } from "next/server";
import { getSession, setSessionCookie } from "@/lib/session";
import { revokeSessions } from "@/lib/access";

// "Sign out everywhere": move the account's revocation horizon to now, so
// every cookie minted before this instant - a stolen one included - is refused
// by getSession from the next request on. The caller's own cookie is re-issued
// so THIS device stays signed in; that is the whole point of the button being
// usable from a device you trust.
//
// The result is honest: if the horizon did not persist (Supabase down, or the
// sessions_valid_from column not migrated), we say so with a 500 rather than
// claim a revocation that did not happen - "signed out everywhere" is exactly
// the kind of promise that must not be made on a failed write.
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const revoked = await revokeSessions(session.email).catch(() => false);
  if (!revoked) {
    return NextResponse.json(
      {
        error:
          "Could not revoke your other sessions - the database write failed, so they are all still signed in. Check that Supabase is connected and schema.sql has been run, then try again.",
      },
      { status: 500 }
    );
  }
  try {
    setSessionCookie(session.email);
  } catch {
    /* worst case: this device signs in again too - the revocation still holds */
  }
  return NextResponse.json({ ok: true });
}
