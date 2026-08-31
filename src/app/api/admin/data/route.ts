import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect, sbCountDark } from "@/lib/runtime-config";
import { redactRow } from "@/lib/admin/redact-data";

// Owner data explorer: read recent rows from any of the app's tables so the
// owner has full visibility into everything the app records. Read-only, an
// allow-list of tables, capped rows.
//
// IT SHIPPED CREDENTIALS AND SLEEPING COORDINATES TO A BROWSER (owner report 11
// S1). The row path below was `select=*`, returned verbatim, over an allow-list
// whose very first table is `app_users`. So one click on the Data tab handed the
// caller's browser every account's scrypt `password_hash`, every traveller's
// precise `stay_lat`/`stay_lng`, and - from `wa_sessions` - `proxy_session_id`,
// a live per-user proxy token. The sibling route `admin/users` was rewritten
// months ago (its docblock: "THE MANAGEMENT LIST SHIPPED EVERY PASSWORD HASH TO
// A BROWSER") to withhold exactly these; the fix was applied there and never
// here, and this route's OWN comment named `password_hash` as the hazard while
// the follow-up only fixed the COUNT path.
//
// TWO LAYERS, both allow-list in spirit:
//   1. The tables that carry a secret column get an explicit `select` of the
//      columns worth seeing, so the credential never crosses the wire.
//   2. Whatever a table returns, `redactRow` drops any key that looks like a
//      credential or a precise coordinate - by exact name AND by pattern - so a
//      NEW secret column added to any table is withheld by default rather than
//      leaked until someone remembers this file. That is the "opt-in, not
//      opt-out" property the admin/users docblock argued for.
// W9: ownerOnly. Every cross-user CONVERSATION surface in /api/admin/ops/*
// (transcript, conversations, review, message-path) is gated requireOwner, on
// the admin/users docblock's own argument: an admin is trusted to manage
// accounts, which is not the same as being trusted to read every traveller's
// WhatsApp messages. This route let any admin do exactly that through the
// Data tab. Tables carrying message TEXT are owner-only now; counts stay
// visible to all of management (a number is not a transcript).
type TableSpec = {
  name: string;
  label: string;
  order: string;
  select?: string;
  ownerOnly?: boolean;
};
const TABLES: TableSpec[] = [
  {
    name: "app_users",
    label: "Users",
    order: "last_seen.desc",
    // Everything an owner needs to see, and none of the three that are pure
    // liability: password_hash, stay_lat, stay_lng.
    select:
      "email,phone,name,provider,status,plan,must_change_password,terms_version," +
      "terms_accepted_at,wa_risk_accepted_at,ai_responsibility_accepted_at,stay_label," +
      "stay_share_consent_at,number_sharing_accepted_at,warmed_up_at,added_at,last_seen",
  },
  { name: "bookings", label: "Bookings", order: "created_at.desc" },
  { name: "searches", label: "Searches", order: "created_at.desc" },
  { name: "offers", label: "Offers", order: "created_at.desc" },
  { name: "vendor_replies", label: "Vendor replies", order: "created_at.desc", ownerOnly: true },
  { name: "bargain_drafts", label: "Bargain drafts", order: "created_at.desc", ownerOnly: true },
  { name: "whatsapp_messages", label: "WhatsApp messages", order: "received_at.desc", ownerOnly: true },
  {
    name: "wa_sessions",
    label: "WhatsApp sessions",
    order: "updated_at.desc",
    // proxy_session_id is a live credential; proxy_verified_at (a timestamp) is
    // fine to see and is kept.
    select:
      "email,instance_name,status,host_url,pairing_code_issued_at,proxy_verified_at," +
      "last_active,idle_paused,updated_at",
  },
  { name: "agent_training", label: "Agent memory", order: "created_at.desc" },
  { name: "feedback", label: "Feedback", order: "created_at.desc" },
  { name: "auth_events", label: "Auth events", order: "created_at.desc" },
  { name: "billing_events", label: "Billing events", order: "created_at.desc" },
  { name: "api_usage", label: "API usage", order: "created_at.desc" },
  { name: "ai_usage", label: "AI usage", order: "created_at.desc" },
  { name: "market_floor_prices", label: "Market floor prices", order: "updated_at.desc" },
  { name: "whatsapp_number_reputation", label: "WA trust scores", order: "created_at.desc" },
  { name: "whatsapp_security_policies", label: "WA security policies", order: "id.asc" },
  { name: "wa_outbox", label: "WA outbox (queued)", order: "not_before.asc", ownerOnly: true },
];

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const table = url.searchParams.get("table");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));

  if (!table) {
    // A COUNT IS A COUNT, NOT A THOUSAND ROWS WITH .length TAKEN.
    //
    // This downloaded up to 1000 FULL rows from all tables in parallel and
    // reported `rows.length`. Three things wrong with that, and sbCount's own
    // docblock in runtime-config already forbids the pattern by name:
    //
    //   - the number saturates at exactly 1000 and then never moves again;
    //   - sbSelect maps a timeout or non-2xx to [], so a slow table reports
    //     ZERO rows rather than "could not read";
    //   - `select=*` over 1000 whatsapp_messages rows (full `raw` jsonb)
    //     realistically trips the 8s timedFetch deadline - and every byte is
    //     discarded except .length.
    //
    // sbCountDark answers from Content-Range with a single-row body, and
    // returns null on an outage so an unreadable table reads as unknown rather
    // than as empty - the fail-dark contract this panel is supposed to honour.
    const tables = await Promise.all(
      TABLES.map(async (t) => {
        // No filter - the whole table. Range: 0-0 keeps the body to one row.
        const n = await sbCountDark(t.name, "");
        return {
          name: t.name,
          label: t.label,
          count: n,
          unreadable: n === null,
          // So the panel can render the lock instead of a row view that 403s.
          ownerOnly: Boolean(t.ownerOnly) && session.role !== "owner",
        };
      })
    );
    return NextResponse.json({
      tables,
      // So the panel can say so rather than rendering a confident zero.
      degraded: tables.filter((t) => t.unreadable).map((t) => t.name),
    });
  }

  const meta = TABLES.find((t) => t.name === table);
  if (!meta) return NextResponse.json({ error: "Unknown table." }, { status: 400 });
  if (meta.ownerOnly && session.role !== "owner") {
    return NextResponse.json(
      { error: "Conversation content is owner-only. Admins see counts, not transcripts." },
      { status: 403 }
    );
  }
  const rows = await sbSelect<Record<string, unknown>>(
    meta.name,
    `select=${meta.select ?? "*"}&order=${meta.order}&limit=${limit}`
  );
  // The redactor runs on EVERY table, even those with an explicit select, so a
  // future secret column is caught whether or not anyone updates the projection.
  return NextResponse.json({ table: meta.name, label: meta.label, rows: rows.map(redactRow) });
}
