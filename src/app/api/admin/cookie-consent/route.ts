import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { buildConsentRollup } from "@/lib/cookies/rollup";
import { COOKIE_MANIFEST, COOKIE_POLICY_VERSION } from "@/lib/cookies/manifest";

// The owner's read on the cookie layer: what the fleet consented to, and what
// the fleet is being ASKED to consent to.
//
// Counts only - no addresses, no per-person rows. A management surface needs
// "how many people allow analytics", not "who"; the per-person ledger already
// exists for the one case that needs it (a subject access request), and it is
// owner-gated there for a reason.
//
// The manifest ships alongside the counts on purpose. The question an owner
// actually asks this page is not "what is the analytics rate" but "is the
// banner telling people the truth", and that is only answerable with the
// inventory and the numbers on one screen.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Not allowed." }, { status: 403 });

  const url = new URL(req.url);
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days")) || 90));

  const rollup = await buildConsentRollup(days).catch(() => null);
  if (!rollup) {
    // A thrown rollup is not a zero either. Say so.
    return NextResponse.json({
      version: COOKIE_POLICY_VERSION,
      rollup: null,
      degraded: ["consent_events"],
      manifest: COOKIE_MANIFEST,
    });
  }

  return NextResponse.json({
    version: COOKIE_POLICY_VERSION,
    rollup,
    degraded: rollup.degraded,
    manifest: COOKIE_MANIFEST,
  });
}
