import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { CONSENT_KINDS, recordConsent, stampTermsVersion, type ConsentKind } from "@/lib/consent";
import { TERMS_VERSION } from "@/lib/legal";
import { finishBeforeResponse } from "@/lib/after";

export const dynamic = "force-dynamic";

// ONE ENDPOINT FOR EVERY ACCEPTANCE.
//
// Three surfaces collected a consent and none of them recorded it: the first
// app entry (which did not exist), the WhatsApp linking release (a modal you
// closed) and the booking sheet's deal-terms checkbox (a client-side gate on
// its own submit button). Each one now posts here, so a new acceptance surface
// cannot ship without a record - there is nowhere else to send it.
//
// The version is the SERVER's TERMS_VERSION, never the client's. A browser
// telling us which version it agreed to is a browser we would have to trust
// about the one fact the record exists to establish.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { kind?: string; context?: Record<string, unknown> } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* an empty body is a terms acceptance - the common case */
  }

  const kind = String(body.kind ?? "terms") as ConsentKind;
  if (!(CONSENT_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "Unknown consent." }, { status: 400 });
  }

  // The write is a durable side effect, so it goes through finishBeforeResponse
  // like every other one: on Cloud Run the CPU is throttled to ~0 the moment
  // this response flushes, and a detached insert simply never runs.
  //
  // THE TWO WRITES ARE NOT THE SAME PROMISE, so they are not reported as one.
  //
  //   `stamped`  - app_users.terms_version. This is what CLOSES THE GATE:
  //                `needsReacceptance` reads it on every entry. If it did not
  //                land, saying ok:true tells the browser to dismiss a modal
  //                that the very next page load will raise again, forever.
  //   `recorded` - the consent_events ledger row. This is the PROOF. Losing it
  //                is serious and is caught by the breadcrumb in recordConsent,
  //                but it is not a reason to bar someone from the app.
  //
  // Both booleans used to be discarded inside the closure and this returned
  // {ok:true} unconditionally, so a write to a database that had never seen
  // schema.sql was indistinguishable from a write that worked.
  let stamped = true;
  let recorded = false;
  await finishBeforeResponse("consent-record", async () => {
    recorded = await recordConsent({
      email: session.email,
      kind,
      version: TERMS_VERSION,
      context: body.context,
    });
    // ONE ACCEPTANCE ACTION, FOUR RECORDED CONSENTS.
    //
    // legal.ts documents the signup consents as collected through a single
    // clearly-labelled action whose label names each of them - but only
    // `terms` was ever written. So `consentFor(email, "number_sharing")` was
    // false for every user alive, and the WABA handoff (which exists to hand a
    // shop the traveller's number) had no provable consent for the one
    // disclosure it makes. Best-effort siblings: a lost row must never bar
    // somebody from the app, and the `terms` row above is the one that gates
    // entry.
    if (kind === "terms") {
      for (const sibling of ["wa_risk", "ai_responsibility", "number_sharing"] as ConsentKind[]) {
        await recordConsent({
          email: session.email,
          kind: sibling,
          version: TERMS_VERSION,
          context: { via: "terms-clickwrap" },
        }).catch(() => false);
      }
    }
    // The three signup consents also carry a version on the user row, which is
    // what `needsReacceptance` reads on every entry.
    if (kind === "terms" || kind === "wa_risk" || kind === "ai_responsibility") {
      stamped = await stampTermsVersion(session.email, TERMS_VERSION);
    }
  });

  if (!stamped) {
    // FirstTouchTerms already renders "we could not record your acceptance -
    // try again" on a non-ok response. Telling the truth here is the difference
    // between one honest retry and an endless silent loop.
    return NextResponse.json(
      { ok: false, error: "We could not record your acceptance. Please try again." },
      { status: 503 }
    );
  }

  return NextResponse.json({ ok: true, recorded, version: TERMS_VERSION });
}
