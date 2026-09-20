import "server-only";

// PROOF OF A SIGNED-OUT VISITOR'S COOKIE CHOICE.
//
// The consent ledger (`consent_events`) is keyed by email, so it could only
// ever record people who had signed in. Everyone else's choice lived in their
// own cookie and nowhere else - and "everyone else" is precisely who search
// advertising is shown to: a visitor who arrives on a guide from a search
// engine, answers the banner, and never makes an account. Google's EU user
// consent policy asks the publisher to KEEP RECORDS of consent. "It was in
// their browser" is not a record.
//
// WHAT IS STORED, AND WHAT DELIBERATELY IS NOT.
//
//   stored      the choice, the policy version, which button made it, whether
//               the request carried a Global Privacy Control signal, the
//               consent region, the interface language, and a hash of the exact
//               category copy that was on screen.
//   not stored  IP address, user agent, referrer, URL, account, device id.
//
// The row is keyed by sha256 of the random receipt id inside the visitor's own
// `wd_cookie_prefs` cookie. The raw id never reaches the database: a visitor
// presenting their cookie can be shown their history, and nobody holding the
// database can turn a row back into a cookie or into a person.
//
// Best-effort, like every ledger write here: a database that is down must not
// stop somebody rejecting cookies. The boolean says whether it LANDED, and the
// route passes that on as `durable` rather than claiming a proof it lacks.

import { createHash } from "node:crypto";
import { sbInsert } from "@/lib/runtime-config";
import { validReceiptId, type CookieConsent } from "./consent";
import { CATEGORY_COPY, COOKIE_MANIFEST, COOKIE_POLICY_VERSION } from "./manifest";
import type { ConsentRegion } from "../traffic/region";

/** sha256(receipt id), hex. Exported so a future "show me my consent history"
 *  lookup keys on exactly the same value the writer used. */
export function visitorKeyFor(receiptId: string): string {
  return createHash("sha256").update(`wd-consent-receipt:${receiptId}`).digest("hex");
}

/**
 * A fingerprint of the words that were on screen: every category's title,
 * blurb and consequence, and every declared cookie's purpose. If the copy is
 * ever edited WITHOUT a policy-version bump, rows before and after carry
 * different hashes - so "what exactly did this visitor agree to" stays
 * answerable from the row and the git history, without storing the text per
 * row.
 */
const COPY_HASH = createHash("sha256")
  .update(JSON.stringify({ v: COOKIE_POLICY_VERSION, copy: CATEGORY_COPY, entries: COOKIE_MANIFEST.map((e) => [e.name, e.category, e.purpose, e.duration]) }))
  .digest("hex");

const REGIONS: readonly ConsentRegion[] = ["tcf", "other", "unknown"];

export async function recordVisitorConsent(
  consent: CookieConsent,
  context: { gpc: boolean; region: ConsentRegion; lang: string | null | undefined }
): Promise<boolean> {
  const id = validReceiptId(consent.id);
  if (!id) return false;
  // Closed vocabularies only. `region` and `lang` arrive from the browser, and
  // a ledger column that stores whatever a client sent is a free-text field
  // with a misleading name.
  const region: ConsentRegion = REGIONS.includes(context.region) ? context.region : "unknown";
  const lang = typeof context.lang === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(context.lang) ? context.lang : null;

  return sbInsert("visitor_consent_events", [
    {
      visitor_key: visitorKeyFor(id),
      policy_version: consent.version,
      source: consent.source,
      preferences: consent.grants.preferences === true,
      analytics: consent.grants.analytics === true,
      marketing: consent.grants.marketing === true,
      gpc: context.gpc === true,
      region,
      lang,
      copy_hash: COPY_HASH,
    },
  ]).catch(() => false);
}
