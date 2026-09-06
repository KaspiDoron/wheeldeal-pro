import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { disconnectInstance } from "@/lib/evolution";

// Log out + delete the user's personal WhatsApp session.
//
// HONEST (audit F057): this answered {ok:true} over a discarded boolean, so a
// host past its abort left the socket live while the app said "unlinked". A
// sever that no host confirmed is a 502 the client shows and the person can
// retry; "never linked / nothing configured" is a real success with nothing
// to sever and stays a 200.
//
// `purged` (audit M50) says whether the person's parked work went with the
// link. A false is still a 200 - the link IS gone - but it is named rather
// than assumed, and the re-link path drains the purge it stands for.
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const result = await disconnectInstance(session.email);
  if (!result.severed) {
    return NextResponse.json(
      {
        ok: false,
        severed: false,
        hostsTried: result.hostsTried,
        error: "WhatsApp could not be unlinked right now - the link is still live. Try again in a minute.",
      },
      { status: 502 }
    );
  }
  return NextResponse.json({
    ok: true,
    severed: true,
    hostsTried: result.hostsTried,
    purged: result.purged,
  });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
