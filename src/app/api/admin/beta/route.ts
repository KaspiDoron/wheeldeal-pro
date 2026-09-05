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
  // HONEST WRITE: a list that did not reach the durable store was not saved -
  // it would reset on the next restart and de-invited nobody. 502, not ok.
  if (!res.persisted) {
    return NextResponse.json(
      {
        error: res.error ?? "The tester list did not persist. Check Supabase and retry.",
        entries: await betaAllowlist(),
        max: res.max,
      },
      { status: 502 }
    );
  }
  const list = await betaAllowlist();
  const notes: string[] = [];
  // An over-long paste used to return a plain 200 having thrown the tail
  // away. Say so, in the owner's words, on the response they already read.
  if (res.dropped > 0) {
    notes.push(
      `Saved ${res.saved.length} testers. ${res.dropped} more were not saved - the list is capped at ${res.max}.`
    );
  }
  // De-invitation revokes sessions (audit F159); a revocation that did not
  // persist leaves that tester signed in, and the owner must hear it by name.
  if (res.revokeFailed.length > 0) {
    notes.push(
      `Removed from the list, but still signed in (the sign-out did not persist - retry): ${res.revokeFailed.join(", ")}.`
    );
  }
  return NextResponse.json({
    ok: true,
    entries: list,
    max: res.max,
    dropped: res.dropped,
    revoked: res.revoked,
    revokeFailed: res.revokeFailed,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
