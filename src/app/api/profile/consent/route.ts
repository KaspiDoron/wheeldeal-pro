import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  consentFor,
  recordConsent,
  resetConsentCache,
  OPT_IN_KINDS,
  type ConsentKind,
} from "@/lib/consent";
import { encodeCookieConsent } from "@/lib/cookies/consent";
import {
  CATEGORY_CONSENT_KIND,
  readAnalyticsId,
  readCookieConsent,
  setConsentCookie,
  syncAnalyticsCookie,
} from "@/lib/cookies/server";

export const dynamic = "force-dynamic";

// The opt-in purposes' own endpoint (W9): read the toggles, flip one. Only
// the OPT_IN_KINDS are reachable here - the mandatory acceptances (terms,
// wa_risk, ...) have their own recorded flows and must not be togglable off
// while the account keeps using the product they gate.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const kinds = OPT_IN_KINDS;
  const values = await Promise.all(kinds.map((k) => consentFor(session.email, k)));
  const out: Record<string, boolean> = {};
  kinds.forEach((k, i) => {
    out[k] = values[i];
  });
  return NextResponse.json(out);
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

  // TWO DOORS, ONE ROOM.
  //
  // Three of these purposes are also cookie categories, and the cookie is what
  // every client-side gate and every per-request server gate reads. Flipping
  // `analytics` off in Profile while the cookie on this device still said yes
  // would leave collection running here until the person happened to find the
  // banner - two controls with one name, disagreeing, which is the exact
  // failure CATEGORY_CONSENT_KIND exists to prevent. So the ledger write above
  // pulls the cookie along with it.
  //
  // Best-effort and last: the ledger row is the consent, and a cookie that
  // could not be rewritten must not turn a recorded choice into a 500.
  //
  // ONLY WHEN A CHOICE ALREADY EXISTS, and carrying its VERSION forward
  // untouched. Minting a fresh current-version cookie here would answer the
  // banner on the person's behalf - they would never be asked about
  // preferences or advertising, both would sit silently at the deny default,
  // and their theme would quietly stop persisting with nothing on screen
  // explaining why. A person with no cookie yet still has the banner due; the
  // ledger row written above already governs collection, because
  // analyticsAllowed requires the ledger AND the cookie.
  const category = (
    Object.keys(CATEGORY_CONSENT_KIND) as (keyof typeof CATEGORY_CONSENT_KIND)[]
  ).find((c) => CATEGORY_CONSENT_KIND[c] === kind);
  const current = category ? readCookieConsent() : null;
  if (category && current) {
    try {
      const next = {
        ...current,
        at: Date.now(),
        source: "custom" as const,
        grants: { ...current.grants, [category]: wantGranted },
      };
      setConsentCookie(encodeCookieConsent(next));
      syncAnalyticsCookie(next.grants, readAnalyticsId());
    } catch {
      /* the recorded consent stands; this device re-syncs on its next save */
    }
  }

  return NextResponse.json({ ok: true, kind, granted: wantGranted });
}
