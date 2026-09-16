import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { buildConsentRollup } from "@/lib/cookies/rollup";
import { readAdminAudit } from "@/lib/admin/audit";
import { COOKIE_MANIFEST, COOKIE_POLICY_VERSION, OPTIONAL_CATEGORIES } from "@/lib/cookies/manifest";
import { registeredTables, USER_TABLES } from "@/lib/privacy/user-tables";
import { TERMS_VERSION } from "@/lib/legal";

// THE GOVERNANCE OVERVIEW - the whole compliance posture on one read.
//
// Four questions an operator is actually asked, answered from the systems that
// already know, never from a number somebody maintains by hand:
//
//   1. WHAT DID THE FLEET AGREE TO?        the consent rollup (people, not rows)
//   2. WHAT ARE WE ASKING THEM TO AGREE TO? the cookie manifest + policy version
//   3. WHAT DO WE PROMISE TO DELETE?        the erasure registry's own coverage
//   4. WHO HAS BEEN IN THE DATA?            the admin audit trail
//
// Every figure that could not be read is NAMED in `degraded` rather than
// rendered as a zero. On a compliance surface specifically that distinction is
// the whole product: "nobody opted into analytics" and "we cannot see who opted
// into analytics" lead to opposite decisions, and only one of them is ever
// true at a time.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Not allowed." }, { status: 403 });

  const url = new URL(req.url);
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days")) || 90));

  const [rollup, audit] = await Promise.all([
    buildConsentRollup(days).catch(() => null),
    readAdminAudit({ limit: 40 }).catch(() => ({ entries: [], degraded: ["admin_audit"] })),
  ]);

  const degraded = [...(rollup?.degraded ?? (rollup ? [] : ["consent_events"])), ...audit.degraded];

  return NextResponse.json({
    policy: {
      cookieVersion: COOKIE_POLICY_VERSION,
      termsVersion: TERMS_VERSION,
      categories: OPTIONAL_CATEGORIES,
      /** The count, not the list - the list rides on the manifest below. */
      declaredKeys: COOKIE_MANIFEST.length,
      thirdParty: COOKIE_MANIFEST.filter((c) => c.party !== "first").map((c) => ({
        name: c.name,
        party: c.party,
        category: c.category,
      })),
    },
    manifest: COOKIE_MANIFEST,
    rollup,
    // THE ERASURE PROMISE, MEASURED. `registeredTables` is what the walker
    // deletes and the export reads; a schema-grep test fails the build when a
    // user-keyed table ships without a decision here. Publishing the number on
    // the console turns that invariant into something an operator can point at.
    erasure: {
      registeredTables: registeredTables().length,
      keyedColumns: USER_TABLES.length,
    },
    audit: audit.entries,
    degraded,
    windowDays: days,
  });
}
