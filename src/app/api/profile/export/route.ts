import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { buildDsarExport } from "@/lib/privacy/dsar";

export const dynamic = "force-dynamic";

// DSAR export: everything the registry attributes to the signed-in person, as
// one JSON document.
//
// The assembly moved to `lib/privacy/dsar` when the governance console gained
// an operator-fulfilled path for people who have lost account access. Both call
// `buildDsarExport`, so the document a person downloads and the document an
// operator hands them are the same document - two implementations would drift,
// and the operator's copy is the one nobody checks and the one that ends up in
// front of a regulator. Everything that made this correct lives there now, with
// its reasoning: the registry walk, the strict reads, and `unreadable` naming
// the tables whose truth is unknown instead of returning them as empty.
//
// What stays HERE is what is specific to the self-serve path: the session, and
// the rate limit.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // Walking ~30 tables is not free; nobody needs their export more than a few
  // times an hour.
  const gate = await rateLimit("dsar-export", session.email, 5, 3600);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Export was just generated - try again in a little while." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } }
    );
  }

  const body = await buildDsarExport(session.email);
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="wheeldeal-export-${session.email.replace(/[^a-z0-9.@-]/gi, "_")}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
