import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  consentFor,
  recordConsent,
  resetConsentCache,
  OPT_IN_KINDS,
  type ConsentKind,
} from "@/lib/consent";

export const dynamic = "force-dynamic";

// The opt-in purposes' own endpoint (W9): read both toggles, flip one. Only
// the OPT_IN_KINDS are reachable here - the mandatory acceptances (terms,
// wa_risk, ...) have their own recorded flows and must not be togglable off
// while the account keeps using the product they gate.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const [analytics, commercialInsights] = await Promise.all([
    consentFor(session.email, "analytics"),
    consentFor(session.email, "commercial_insights"),
  ]);
  return NextResponse.json({ analytics, commercial_insights: commercialInsights });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { kind, granted } = await req.json().catch(() => ({}));
  if (!(OPT_IN_KINDS as readonly string[]).includes(String(kind))) {
    return NextResponse.json({ error: "Unknown consent kind." }, { status: 400 });
  }
  const wantGranted = granted === true;

  // The ledger row IS the consent - an unrecorded withdrawal in particular
  // must not be reported as done (the person believes collection stopped).
  const landed = await recordConsent({
    email: session.email,
    kind: kind as ConsentKind,
    granted: wantGranted,
    context: { source: "profile-toggle" },
  });
  resetConsentCache();
  if (!landed) {
    return NextResponse.json(
      {
        error:
          "Your choice could not be recorded durably - nothing changed. Try again in a moment.",
      },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, kind, granted: wantGranted });
}
