import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { resolveAlternativeOffer } from "@/lib/vehicle/substitution-store";

export const dynamic = "force-dynamic";

// THE TRAVELLER'S ANSWER TO "WE HAVE A 150 INSTEAD".
//
// The choice was parked on the thread by the substitution pass; this is the
// only thing that clears it. Accepting retargets the thread to the vehicle they
// agreed to and lets the agent carry on negotiating it. Declining ends the
// thread, which is exactly where it would have been without the question.
//
// Deliberately NOT a send endpoint. Nothing goes to the shop from here: the
// next ordinary turn does that, inside the same rails as every other message,
// with the same pacing and the same recipient mutex. A decision the traveller
// makes in the app is not a licence to bypass any of it.

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const vendorId = typeof body?.vendorId === "string" ? body.vendorId : "";
  const accept = body?.accept === true;
  if (!vendorId) return NextResponse.json({ error: "vendorId required" }, { status: 400 });

  const decided = await resolveAlternativeOffer({
    email: session.email,
    vendorId,
    accept,
  });
  if (!decided.ok) {
    if (decided.reason === "unavailable") {
      // HONEST WRITE (audit F016). The decision did not persist - the choice
      // is still open on the thread, and the card must keep showing it. The
      // copy is the catalogue string the client already renders for a
      // choice that could not be saved.
      return NextResponse.json(
        { error: "Could not save your choice - try again.", stale: false },
        { status: 502 }
      );
    }
    // The commonest cause is a stale tab: the choice expired, or the traveller
    // already answered it on another device. Say so rather than pretending.
    return NextResponse.json(
      { error: "That choice is no longer open.", stale: true },
      { status: 409 }
    );
  }
  const { offer } = decided;

  try {
    const { sbInsert } = await import("@/lib/runtime-config");
    await sbInsert("agent_events", [
      {
        kind: "alternative-decision",
        user_email: session.email,
        vendor_id: vendorId,
        detail: JSON.stringify({ accept, vehicle: offer?.vehicle ?? null }),
      },
    ]);
  } catch {
    /* telemetry is never the reason a decision fails */
  }

  return NextResponse.json({ ok: true, accepted: accept, vehicle: offer?.vehicle ?? null });
}
