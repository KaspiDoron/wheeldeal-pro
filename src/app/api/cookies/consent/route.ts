// THE COOKIE CHOICE ENDPOINT. Open to signed-out visitors by design.
//
// The banner is the first thing a visitor meets, on /welcome, before any
// account exists - so this route cannot be session-gated. What it does with a
// session is add to the record, never gate it: signed in, the choice ALSO lands
// in the consent ledger (provable, follows the account to every device, shows
// up in the DSAR export); signed out, the cookie is the whole record, which is
// the most any system can honestly hold about someone who has not identified
// themselves.
//
// WHAT "SAVED" MEANS HERE, EXACTLY:
//   ok:true, durable:true   - cookie set, and the ledger rows landed.
//   ok:true, durable:false  - cookie set; the ledger is unreachable or the
//                             visitor is signed out. THE CHOICE IS IN FORCE -
//                             the cookie is what every gate in the app reads -
//                             but we cannot prove it later, and the response
//                             says so rather than pretending.
//   4xx/5xx                 - nothing changed.
//
// The cookie is written even when the ledger write fails, and that is the
// deliberate direction. The alternative - refusing the choice because we could
// not file the paperwork - means a person who tapped "Reject all" gets
// advertising cookies because a database was down. Applying a "no" we cannot
// prove is strictly better than proving nothing and honouring nothing.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import {
  ALLOW_ALL,
  DENY_ALL,
  encodeCookieConsent,
  makeConsent,
  needsCookieChoice,
  normalizeGrants,
  type CookieConsent,
} from "@/lib/cookies/consent";
import {
  COOKIE_MANIFEST,
  COOKIE_POLICY_VERSION,
  CATEGORY_COPY,
  COOKIE_CATEGORIES,
  OPTIONAL_CATEGORIES,
} from "@/lib/cookies/manifest";
import {
  readAnalyticsId,
  readCookieConsent,
  recordCookieConsent,
  setConsentCookie,
  syncAnalyticsCookie,
} from "@/lib/cookies/server";

export const dynamic = "force-dynamic";

/** The shape both GET and POST answer with, so the client has one parser. */
function state(consent: CookieConsent | null) {
  return {
    version: COOKIE_POLICY_VERSION,
    needsChoice: needsCookieChoice(consent),
    consent: consent
      ? { version: consent.version, at: consent.at, source: consent.source, grants: consent.grants }
      : null,
    grants: consent?.grants ?? DENY_ALL,
  };
}

/**
 * The current choice, plus the inventory the banner renders from.
 *
 * The manifest ships in the response rather than being imported into the client
 * bundle so the panel's cookie table and the /cookies policy page are the SAME
 * list on the SAME deploy - a table the client compiled in could lag the server
 * by one cache generation and quietly show a traveller a set of cookies that is
 * not the set they are being asked about.
 */
export async function GET() {
  return NextResponse.json({
    ...state(readCookieConsent()),
    categories: COOKIE_CATEGORIES,
    optional: OPTIONAL_CATEGORIES,
    copy: CATEGORY_COPY,
    manifest: COOKIE_MANIFEST,
  });
}

export async function POST(req: Request) {
  // Cheap, but not free: this sets a cookie and can write four ledger rows, and
  // it is reachable without a session. A generous ceiling - a person fiddling
  // with four toggles legitimately saves several times in a row.
  const limit = await rateLimit("cookie-consent", clientIp(req), 30, 60).catch(() => ({
    ok: true,
    retryAfter: 0,
  }));
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many changes in a row. Try again in a moment." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter || 60) } }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    choice?: unknown;
    grants?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: "Malformed request." }, { status: 400 });

  const choice = String(body.choice ?? "custom");
  if (choice !== "accept-all" && choice !== "reject-all" && choice !== "custom") {
    return NextResponse.json({ error: "Unknown choice." }, { status: 400 });
  }
  // The two one-tap buttons define their own grants server-side. A client that
  // posts {choice:"reject-all", grants:{marketing:true}} does not get to have
  // it both ways, and the ledger row records what the button MEANT rather than
  // what the payload happened to carry.
  const grants =
    choice === "accept-all"
      ? { ...ALLOW_ALL }
      : choice === "reject-all"
        ? { ...DENY_ALL }
        : normalizeGrants(body.grants);

  const consent = makeConsent(grants, choice);
  const encoded = encodeCookieConsent(consent);

  // THE COOKIE FIRST. Whatever happens below, the choice is in force from here.
  try {
    setConsentCookie(encoded);
  } catch {
    // Nothing else is worth attempting if the choice itself cannot be stored:
    // the ledger row would then claim a state the app is not actually in.
    return NextResponse.json(
      { error: "Your browser refused to store the choice, so nothing was changed." },
      { status: 500 }
    );
  }

  // The analytics id lives and dies with the analytics grant. Reading the
  // existing one first keeps a person who toggles preferences from being
  // re-counted as a new visitor every time they touch the panel.
  const analyticsId = syncAnalyticsCookie(consent.grants, readAnalyticsId());

  const session = await getSession().catch(() => null);
  let durable = false;
  if (session?.email) {
    durable = await recordCookieConsent(session.email, consent).catch(() => false);
  }

  return NextResponse.json({
    ok: true,
    ...state(consent),
    /** True only when the choice is also provable - see the header comment. */
    durable,
    signedIn: Boolean(session?.email),
    analyticsId: analyticsId ? true : false,
    note: session?.email
      ? durable
        ? undefined
        : "Your choice is in force on this device, but we could not file the durable record. It will be recorded again next time you change it."
      : undefined,
  });
}
