import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUser } from "@/lib/access";
import { sbSelect, supabaseConfigured } from "@/lib/runtime-config";
import { rateLimit } from "@/lib/rate-limit";
import { USER_TABLES, CHILD_TABLES, filterFor } from "@/lib/privacy/user-tables";

export const dynamic = "force-dynamic";

const ROWS_PER_TABLE = 1000;

// DSAR export: everything the registry attributes to the signed-in person, as
// one JSON document. Driven by the SAME registry as erasure, so "what we hold
// about you" and "what we delete" can never quietly diverge.
//
// Honesty: tables that could not be read are named in `unreadable` rather than
// silently returned empty - an export that hides a third of the data behind a
// DB hiccup is a false statement about what we hold.
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

  const data: Record<string, unknown[]> = {};
  const unreadable: string[] = [];

  // The account record itself, minus secret material.
  const rec = await getUser(session.email, { fresh: true });
  const account = rec
    ? {
        email: rec.email,
        phone: rec.phone,
        name: rec.name,
        provider: rec.provider,
        status: rec.status,
        plan: rec.plan,
        termsAcceptedAt: rec.termsAcceptedAt,
        stayLabel: rec.stayLabel,
        stayLat: rec.stayLat,
        stayLng: rec.stayLng,
        stayShareConsentAt: rec.stayShareConsentAt,
        addedAt: rec.addedAt,
        lastSeen: rec.lastSeen,
        // passwordHash, sessionsValidFrom: security material, not personal data
        // the person needs a copy of.
      }
    : null;

  if (supabaseConfigured()) {
    for (const entry of USER_TABLES) {
      if (entry.exportSkip) continue;
      const select = entry.exportSelect ?? "*";
      try {
        const rows = await sbSelect<Record<string, unknown>>(
          entry.table,
          `select=${select}&${filterFor(entry, session.email)}&limit=${ROWS_PER_TABLE}`
        );
        data[entry.table] = [...(data[entry.table] ?? []), ...rows];
      } catch {
        if (!unreadable.includes(entry.table)) unreadable.push(entry.table);
      }
    }
    for (const child of CHILD_TABLES) {
      if (child.exportSkip) continue;
      const parentEntry = USER_TABLES.find(
        (t) => t.table === child.parentTable && t.column === child.parentColumn
      );
      if (!parentEntry) continue;
      try {
        const parents = await sbSelect<Record<string, unknown>>(
          child.parentTable,
          `select=${child.parentIdColumn}&${filterFor(parentEntry, session.email)}&limit=${ROWS_PER_TABLE}`
        );
        const ids = parents
          .map((r) => r[child.parentIdColumn])
          .filter((v) => v !== null && v !== undefined);
        if (!ids.length) {
          data[child.table] = data[child.table] ?? [];
          continue;
        }
        const rows = await sbSelect<Record<string, unknown>>(
          child.table,
          `select=${child.exportSelect ?? "*"}&${child.childColumn}=in.(${ids
            .map((v) => encodeURIComponent(String(v)))
            .join(",")})&limit=${ROWS_PER_TABLE}`
        );
        data[child.table] = [...(data[child.table] ?? []), ...rows];
      } catch {
        if (!unreadable.includes(child.table)) unreadable.push(child.table);
      }
    }
  }

  const body = {
    exportedAt: new Date().toISOString(),
    email: session.email,
    account,
    // Non-durable mode holds no queryable history; say so instead of implying
    // an empty history.
    durableStore: supabaseConfigured(),
    unreadable,
    rowLimitPerTable: ROWS_PER_TABLE,
    data,
  };
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="wheeldeal-export-${session.email.replace(/[^a-z0-9.@-]/gi, "_")}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
