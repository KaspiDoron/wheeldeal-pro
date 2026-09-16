import { NextResponse } from "next/server";
import { requireManagement, requireOwner, isOwner } from "@/lib/session";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { buildSubjectFile } from "@/lib/admin/subject";
import { recordAdminAction, readAdminAudit } from "@/lib/admin/audit";

// THE SUBJECT DESK - one person's data file, and the two actions on it.
//
// This is the most powerful endpoint in the management console, so it is also
// the most constrained:
//
//   READ  (GET)    - management. Counts and consent history, never row content.
//   ERASE (DELETE) - OWNER ONLY, with a typed confirmation, and it is the same
//                    walker the person's own Profile button drives. An admin is
//                    trusted to manage accounts; destroying one on somebody
//                    else's behalf is a different trust and it stops at the
//                    owner.
//
// EVERY CALL IS AUDITED, INCLUDING THE ONES THAT FAIL. A refused erase is the
// single most interesting row this console can produce, and a trail that logs
// only successes misses every probe that did not work. The audit write is
// best-effort and never blocks the action - but whether it landed is REPORTED,
// because an operator acting on someone's data deserves to know their action
// went unrecorded.
//
// The export is deliberately NOT here. It lives at ../export with its own
// audit action, because handing an operator a person's entire message history
// is a categorically different act from showing them a row count, and the two
// should not share a permission or a log line.

export const dynamic = "force-dynamic";

function cleanEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Not allowed." }, { status: 403 });

  const url = new URL(req.url);
  const email = cleanEmail(url.searchParams.get("email"));
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Give a full email address." }, { status: 400 });
  }

  // A lookup is cheap per call and ~40 indexed counts underneath, so it is
  // rate-limited per actor: an enumeration sweep over a stolen admin cookie
  // should hit a wall long before it finishes, and leave 60 audit rows saying so.
  const limit = await rateLimit(`gov-subject:${session.email}`, clientIp(req), 40, 300).catch(
    () => ({ ok: true, retryAfter: 0 })
  );
  if (!limit.ok) {
    await recordAdminAction({
      actorEmail: session.email,
      actorRole: session.role,
      action: "subject.lookup",
      subjectEmail: email,
      outcome: "refused",
      detail: { reason: "rate-limited" },
    });
    return NextResponse.json(
      { error: "Too many lookups. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter || 300) } }
    );
  }

  const file = await buildSubjectFile(email).catch(() => null);
  const audited = await recordAdminAction({
    actorEmail: session.email,
    actorRole: session.role,
    action: "subject.lookup",
    subjectEmail: email,
    outcome: file ? "ok" : "failed",
    detail: file
      ? { knownRows: file.knownRows, tables: file.tables.length, degraded: file.degraded.length }
      : { reason: "build-failed" },
  });

  if (!file) {
    return NextResponse.json(
      { error: "Could not assemble the file - nothing was read.", audited },
      { status: 502 }
    );
  }

  // The subject's OWN audit history rides along: "who in this organisation has
  // looked at my file" is a question a data subject may ask, and an operator
  // who has to go and find that in another screen usually does not.
  const history = await readAdminAudit({ subjectEmail: email, limit: 25 }).catch(() => ({
    entries: [],
    degraded: ["admin_audit"],
  }));

  return NextResponse.json({
    file,
    history: history.entries,
    degraded: [...file.degraded, ...history.degraded],
    audited,
    canErase: isOwner(session.email),
  });
}

export async function DELETE(req: Request) {
  // OWNER ONLY. requireManagement would be the consistent-looking choice and
  // the wrong one: this destroys an account and everything attached to it, and
  // the app already draws that line for cross-user transcripts.
  const session = await requireOwner();
  if (!session) {
    // Audit the refusal with whatever identity we can establish - a denied
    // attempt from a real admin session is exactly the row worth having.
    const attempted = await requireManagement().catch(() => null);
    if (attempted) {
      await recordAdminAction({
        actorEmail: attempted.email,
        actorRole: attempted.role,
        action: "subject.erase",
        outcome: "refused",
        detail: { reason: "owner-only" },
      });
    }
    return NextResponse.json(
      { error: "Erasing an account is owner-only." },
      { status: 403 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { email?: unknown; confirm?: unknown };
  const email = cleanEmail(body.email);
  const confirm = cleanEmail(body.confirm);

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Give a full email address." }, { status: 400 });
  }
  // TYPED, NOT CLICKED - the same discipline the self-serve path uses. A stray
  // POST, a replayed request or a mis-bound button must not destroy an account.
  if (confirm !== email) {
    await recordAdminAction({
      actorEmail: session.email,
      actorRole: session.role,
      action: "subject.erase",
      subjectEmail: email,
      outcome: "refused",
      detail: { reason: "confirmation-mismatch" },
    });
    return NextResponse.json(
      { error: "Type the account's email address to confirm." },
      { status: 400 }
    );
  }
  if (isOwner(email)) {
    await recordAdminAction({
      actorEmail: session.email,
      actorRole: session.role,
      action: "subject.erase",
      subjectEmail: email,
      outcome: "refused",
      detail: { reason: "owner-account" },
    });
    return NextResponse.json(
      { error: "The owner account cannot be erased - transfer ownership first." },
      { status: 400 }
    );
  }

  const { eraseUserData } = await import("@/lib/privacy/erase");
  const result = await eraseUserData(email).catch(() => null);

  const ok = Boolean(result && result.failed.length === 0 && result.userDeleted);
  const audited = await recordAdminAction({
    actorEmail: session.email,
    actorRole: session.role,
    action: "subject.erase",
    subjectEmail: email,
    outcome: ok ? "ok" : "failed",
    detail: {
      failed: result?.failed ?? ["erase-threw"],
      userDeleted: result?.userDeleted ?? false,
    },
  });

  if (!ok) {
    // THE TRUTH, AND A PATH FORWARD - the account survives a partial failure
    // (it is deleted LAST, exactly so this can be retried).
    return NextResponse.json(
      {
        error: `Some data could not be deleted (${[
          ...(result?.failed ?? ["the erase could not run"]),
          ...(result?.userDeleted === false ? ["the account row"] : []),
        ].join(", ")}). The account remains until everything is gone - retry.`,
        result,
        audited,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, result, audited });
}
