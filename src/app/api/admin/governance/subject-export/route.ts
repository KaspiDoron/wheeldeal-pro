import { NextResponse } from "next/server";
import { requireManagement, requireOwner } from "@/lib/session";
import { recordAdminAction } from "@/lib/admin/audit";
import { buildSubjectFile } from "@/lib/admin/subject";

// A SUBJECT ACCESS REQUEST, FULFILLED BY THE OPERATOR.
//
// The person's own Profile has a Download button and that is the path everyone
// should use. This exists for the case it cannot cover: somebody who has lost
// access to their account writes in and asks for their file, and the operator
// has to produce it.
//
// IT IS A SEPARATE ENDPOINT FROM THE SUBJECT LOOKUP, ON PURPOSE. The lookup
// returns counts; this returns CONTENT - every message, every search, every
// offer. Those are categorically different acts and they must not share a
// permission or a log line, because "I only looked at the row counts" and "I
// downloaded their WhatsApp history" have to be distinguishable afterwards.
//
// OWNER ONLY, and audited before the data is assembled rather than after, so a
// request that dies mid-assembly still leaves a record that it was made.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireOwner();
  if (!session) {
    const attempted = await requireManagement().catch(() => null);
    if (attempted) {
      await recordAdminAction({
        actorEmail: attempted.email,
        actorRole: attempted.role,
        action: "subject.export",
        subjectEmail: String(new URL(req.url).searchParams.get("email") ?? "") || null,
        outcome: "refused",
        detail: { reason: "owner-only" },
      });
    }
    return NextResponse.json(
      { error: "Exporting another person's file is owner-only." },
      { status: 403 }
    );
  }

  const email = String(new URL(req.url).searchParams.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Give a full email address." }, { status: 400 });
  }

  // AUDITED FIRST. The assembly below reads dozens of tables and can fail
  // halfway; a record written only on success would miss exactly the attempts
  // worth reviewing.
  await recordAdminAction({
    actorEmail: session.email,
    actorRole: session.role,
    action: "subject.export",
    subjectEmail: email,
    outcome: "ok",
    detail: { via: "governance-console" },
  });

  // THE SAME ASSEMBLY THE PERSON'S OWN DOWNLOAD USES. Re-implementing it here
  // would mean two answers to "what do you hold about me" that drift apart, and
  // the operator's copy would be the one nobody checks.
  const { buildDsarExport } = await import("@/lib/privacy/dsar");
  const payload = await buildDsarExport(email).catch(() => null);
  if (!payload) {
    return NextResponse.json(
      { error: "The file could not be assembled - nothing was produced." },
      { status: 502 }
    );
  }

  // The counts ride along so the recipient can see at a glance whether any
  // table came back unreadable, without diffing two documents.
  const file = await buildSubjectFile(email).catch(() => null);

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(
    JSON.stringify(
      {
        subject: email,
        producedAt: new Date().toISOString(),
        producedBy: session.email,
        summary: file
          ? { knownRows: file.knownRows, unreadable: file.degraded }
          : { note: "The summary could not be assembled; the data below still applies." },
        ...payload,
      },
      null,
      2
    ),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="wheeldeal-subject-${email.replace(/[^a-z0-9]+/gi, "-")}-${stamp}.json"`,
        "Cache-Control": "no-store",
      },
    }
  );
}
