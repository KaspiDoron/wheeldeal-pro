import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUser } from "@/lib/access";
import { sbSelectStrict, supabaseConfigured } from "@/lib/runtime-config";
import { rateLimit } from "@/lib/rate-limit";
import {
  USER_TABLES,
  CHILD_TABLES,
  USER_OBJECT_STORES,
  filterFor,
} from "@/lib/privacy/user-tables";
import { auditExtFor, auditObjectPath } from "@/lib/media/audit";

export const dynamic = "force-dynamic";

const ROWS_PER_TABLE = 1000;

// DSAR export: everything the registry attributes to the signed-in person, as
// one JSON document. Driven by the SAME registry as erasure, so "what we hold
// about you" and "what we delete" can never quietly diverge.
//
// Honesty: tables that could not be read are named in `unreadable` rather than
// silently returned empty - an export that hides a third of the data behind a
// DB hiccup is a false statement about what we hold.
//
// That promise was inert (audit F166): the reads used sbSelect, which answers
// [] for every failure and never throws, so both catch blocks were unreachable
// and a table Supabase refused to read was exported as an empty array. The
// reads are now STRICT and the three answers are kept apart:
//   rows          - the read succeeded ([] = genuinely nothing)
//   "missing"     - the table does not exist on this database: vacuously []
//   "unavailable" - the truth is unknown: NAMED in `unreadable`
// A "missing" on a table with a custom export column list is probed once more
// with select=* before it is believed: a stale column in that list answers
// the same way as an absent table, and rows that exist must never be handed
// over as "none".

type Read = { rows: Record<string, unknown>[] } | "unreadable" | "absent";

async function readTable(
  table: string,
  select: string,
  filter: string,
  customSelect: boolean
): Promise<Read> {
  const read = await sbSelectStrict<Record<string, unknown>>(
    table,
    `select=${select}&${filter}&limit=${ROWS_PER_TABLE}`
  );
  if ("rows" in read) return { rows: read.rows };
  if (read.error === "unavailable") return "unreadable";
  if (!customSelect) return "absent";
  // Absent table, or a stale column in the export list? Only the table can say.
  const probe = await sbSelectStrict<Record<string, unknown>>(
    table,
    `select=*&${filter}&limit=1`
  );
  if ("rows" in probe) return probe.rows.length ? "unreadable" : { rows: [] };
  return probe.error === "missing" ? "absent" : "unreadable";
}

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
  const nameUnreadable = (key: string) => {
    if (!unreadable.includes(key)) unreadable.push(key);
    // Partial rows under a name we could not fully read would imply
    // completeness; the person can retry and get the whole table.
    delete data[key];
  };

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
      if (unreadable.includes(entry.table)) continue;
      const select = entry.exportSelect ?? "*";
      try {
        const read = await readTable(
          entry.table,
          select,
          filterFor(entry, session.email),
          Boolean(entry.exportSelect)
        );
        if (read === "unreadable") nameUnreadable(entry.table);
        else if (read === "absent") data[entry.table] = data[entry.table] ?? [];
        else data[entry.table] = [...(data[entry.table] ?? []), ...read.rows];
      } catch {
        nameUnreadable(entry.table);
      }
    }
    for (const child of CHILD_TABLES) {
      if (child.exportSkip) continue;
      const parentEntry = USER_TABLES.find(
        (t) => t.table === child.parentTable && t.column === child.parentColumn
      );
      if (!parentEntry) continue;
      try {
        const parents = await readTable(
          child.parentTable,
          child.parentIdColumn,
          filterFor(parentEntry, session.email),
          false
        );
        if (parents === "unreadable") {
          nameUnreadable(child.table);
          continue;
        }
        if (parents === "absent") {
          data[child.table] = data[child.table] ?? [];
          continue;
        }
        const ids = parents.rows
          .map((r) => r[child.parentIdColumn])
          .filter((v) => v !== null && v !== undefined);
        if (!ids.length) {
          data[child.table] = data[child.table] ?? [];
          continue;
        }
        const rows = await readTable(
          child.table,
          child.exportSelect ?? "*",
          `${child.childColumn}=in.(${ids.map((v) => encodeURIComponent(String(v))).join(",")})`,
          Boolean(child.exportSelect)
        );
        if (rows === "unreadable") nameUnreadable(child.table);
        else if (rows === "absent") data[child.table] = data[child.table] ?? [];
        else data[child.table] = [...(data[child.table] ?? []), ...rows.rows];
      } catch {
        nameUnreadable(child.table);
      }
    }
    // The object stores (audit F168): the audit copies of inbound media, listed
    // by NAME beside the table rows - never bytes, the same reasoning
    // feedback_images.exportSelect already uses. Derived from the index rows
    // already exported above, so an unreadable index means an unknown list.
    for (const store of USER_OBJECT_STORES) {
      if (unreadable.includes(store.indexTable)) {
        nameUnreadable(store.purgedKey);
        continue;
      }
      const rows = (data[store.indexTable] ?? []) as {
        direction?: string;
        [k: string]: unknown;
        raw?: { media?: { kind?: string | null; mime?: string | null } | null } | null;
      }[];
      const objects: { waMessageId: string; path: string; kind: string }[] = [];
      for (const row of rows) {
        const id = row[store.indexIdColumn];
        const media = row.raw?.media;
        if (row.direction !== "inbound" || !media || typeof id !== "string" || !id) continue;
        const kind = media.kind ?? "image";
        objects.push({
          waMessageId: id,
          path: auditObjectPath(id, auditExtFor(media.mime, kind)),
          kind,
        });
      }
      data[store.purgedKey] = objects;
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
