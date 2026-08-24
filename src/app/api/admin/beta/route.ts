import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  betaAllowlist,
  saveBetaAllowlist,
  betaLockEnabled,
  BETA_ALLOWLIST_MAX,
  type BetaEntry,
} from "@/lib/allowlist";

// Owner-only management of the private-beta invite list (up to
// BETA_ALLOWLIST_MAX testers + the owner). GET returns the current list, the
// lock state and the remaining headroom; PUT replaces the list and reports
// anything the cap dropped rather than binning it silently.
export async function GET() {
  const session = await getSession();
  if (session?.role !== "owner") return NextResponse.json({ error: "Owner only" }, { status: 403 });
  const list = await betaAllowlist();
  return NextResponse.json({
    lockEnabled: betaLockEnabled(),
    entries: list,
    max: BETA_ALLOWLIST_MAX,
    counts: {
      total: list.length,
      free: list.filter((e) => e.plan === "free").length,
      pro: list.filter((e) => e.plan === "pro").length,
      ultra: list.filter((e) => e.plan === "ultra").length,
    },
  });
}

export async function PUT(req: Request) {
  const session = await getSession();
  if (session?.role !== "owner") return NextResponse.json({ error: "Owner only" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const entries: BetaEntry[] = Array.isArray(body.entries) ? body.entries : [];
  const res = await saveBetaAllowlist(entries);
  const list = await betaAllowlist();
  return NextResponse.json({
    ok: true,
    entries: list,
    max: res.max,
    dropped: res.dropped,
    // An over-long paste used to return a plain 200 having thrown the tail
    // away. Say so, in the owner's words, on the response they already read.
    ...(res.dropped > 0
      ? {
          note: `Saved ${res.saved.length} testers. ${res.dropped} more were not saved - the list is capped at ${res.max}.`,
        }
      : {}),
  });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
