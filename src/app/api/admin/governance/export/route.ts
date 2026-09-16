import { NextResponse } from "next/server";
import { requireManagement, requireOwner } from "@/lib/session";
import { sbSelectDark } from "@/lib/runtime-config";
import { recordAdminAction } from "@/lib/admin/audit";
import { CONSENT_KINDS } from "@/lib/consent";

// THE CONSENT REGISTER, AS A FILE - the artefact a regulator or an auditor
// actually asks for, produced from the ledger rather than reconstructed from a
// dashboard screenshot.
//
// CSV rather than JSON, and that is not a style choice: this file's readers
// open it in a spreadsheet, sort it, and filter it. A JSON array is a worse
// answer to "show me every marketing consent withdrawn in March".
//
// OWNER ONLY. It is the whole register - every address, every choice - in one
// download, which is a different act from reading a rollup. Management sees the
// counts; the owner can take the file.
//
// BOUNDED AND HONEST ABOUT ITS BOUND. A register truncated at the cap says so
// IN THE FILE, on its own final line, because a spreadsheet with a silently
// missing tail is the worst possible compliance artefact: it looks complete.

export const dynamic = "force-dynamic";

const MAX_ROWS = 20000;

/** RFC 4180 quoting. A shop name with a comma in it is not hypothetical, and
 *  neither is an address someone typed a quote into. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // The leading-character guard is deliberate: Excel evaluates a cell that
  // begins =, +, - or @ as a formula, so an address crafted as `=cmd|...` is a
  // real attack on whoever opens this file. Prefixing with a quote neutralises
  // it without changing what the value reads as.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

interface LedgerRow {
  email: string;
  kind: string;
  version: string | null;
  granted: boolean | null;
  context: Record<string, unknown> | null;
  accepted_at: string;
}

export async function GET(req: Request) {
  const session = await requireOwner();
  if (!session) {
    const attempted = await requireManagement().catch(() => null);
    if (attempted) {
      await recordAdminAction({
        actorEmail: attempted.email,
        actorRole: attempted.role,
        action: "consent.export",
        outcome: "refused",
        detail: { reason: "owner-only" },
      });
    }
    return NextResponse.json(
      { error: "Exporting the consent register is owner-only." },
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const days = Math.max(1, Math.min(3650, Number(url.searchParams.get("days")) || 365));
  const kind = url.searchParams.get("kind");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const filters = [
    `select=email,kind,version,granted,context,accepted_at`,
    `accepted_at=gte.${encodeURIComponent(since)}`,
    `order=accepted_at.desc`,
    `limit=${MAX_ROWS + 1}`,
  ];
  if (kind && (CONSENT_KINDS as readonly string[]).includes(kind)) {
    filters.push(`kind=eq.${encodeURIComponent(kind)}`);
  }

  const rows = await sbSelectDark<LedgerRow>("consent_events", filters.join("&"));

  if (rows === null) {
    // UNREADABLE IS NOT EMPTY. Handing back a CSV with a header row and nothing
    // under it would be a signed statement that nobody ever consented.
    await recordAdminAction({
      actorEmail: session.email,
      actorRole: session.role,
      action: "consent.export",
      outcome: "failed",
      detail: { reason: "consent_events unreadable", days },
    });
    return NextResponse.json(
      { error: "The consent ledger could not be read - no file was produced." },
      { status: 502 }
    );
  }

  const truncated = rows.length > MAX_ROWS;
  const body = rows.slice(0, MAX_ROWS);

  const header = [
    "accepted_at",
    "email",
    "kind",
    "granted",
    "policy_version",
    "source",
  ].join(",");

  const lines = body.map((r) =>
    [
      csvCell(r.accepted_at),
      csvCell(r.email),
      csvCell(r.kind),
      // A legacy row with no `granted` column has always meant an acceptance -
      // the same reading recordConsent's pre-migration fallback relies on.
      csvCell(r.granted === false ? "withdrawn" : "granted"),
      csvCell(r.version ?? ""),
      csvCell((r.context as { source?: string } | null)?.source ?? ""),
    ].join(",")
  );

  if (truncated) {
    lines.push(
      [csvCell(""), csvCell(`TRUNCATED at ${MAX_ROWS} rows - narrow the window or filter by kind`), csvCell(""), csvCell(""), csvCell(""), csvCell("")].join(",")
    );
  }

  await recordAdminAction({
    actorEmail: session.email,
    actorRole: session.role,
    action: "consent.export",
    outcome: "ok",
    detail: { rows: body.length, days, kind: kind ?? "all", truncated },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse([header, ...lines].join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="wheeldeal-consent-register-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
