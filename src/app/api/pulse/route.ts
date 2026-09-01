import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelectDark, pgTimestamp } from "@/lib/runtime-config";

export const dynamic = "force-dynamic";

// THE CHEAP CHANGE DETECTOR.
//
// A shop's reply is durable within ~1-3 seconds of the webhook: the row lands
// in whatsapp_messages and advanceThreadStage writes the funnel event. But the
// traveller only SAW it on the next heavy poll - /api/activity issues fourteen
// selects and /api/replies nine, so they cannot run often without becoming the
// app's dominant database cost, and at 6-8s intervals (15-20s under SCALE_MODE)
// they were also the freshness ceiling.
//
// This endpoint answers one question - "has anything happened for this user?" -
// with one integer, from four `limit=1` reads that all hit an existing index
// (perf-indexes.sql: wa_msgs_receiver_at, wa_msgs_sender_at, vendor_replies_
// user_at, agent_events_user_at). It can be polled every 2.5s for less database
// work than one activity poll, and the heavy fetches become event-driven.
//
// NO WRITE PATH CHANGED TO SUPPORT THIS. advanceThreadStage already stamps
// user_email on every transition and the inbound insert already stamps
// raw.receiver, so the version moves at the same instant the ledger does.
//
// HONEST WHEN BLIND. Every read goes through sbSelectDark, and a source that
// could not be read is NAMED rather than contributing a confident zero - a
// pulse that silently reported "nothing changed" over a dead store would
// freeze the board while looking healthy. `degraded` non-empty tells the client
// to fall back to its own interval instead of trusting the version.

const MAX_AGE_MS = 6 * 3600_000;

type Row = { at: string | null };

export async function GET() {
  const session = await getSession();
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const enc = encodeURIComponent(session.email);
  // Only the recent past matters: a version built from six-month-old rows is
  // the same integer for ever and costs the same query. The floor also keeps
  // the index scan tight.
  // The floor is a plain epoch; pgTimestamp is applied AT each interpolation
  // site, which is what pg-timestamp.test.ts requires and why: a raw "+00:00"
  // decodes to a space and 400s the read, which sbSelectDark would then have to
  // render as an unreadable table.
  const floor = Date.now() - MAX_AGE_MS;

  const sources: [string, string, string][] = [
    // A shop reply that has been stored - the fastest signal there is.
    [
      "inbound",
      "whatsapp_messages",
      `select=received_at&direction=eq.inbound&raw->>receiver=eq.${enc}` +
        `&received_at=gte.${pgTimestamp(floor)}&order=received_at.desc&limit=1`,
    ],
    // Our own send landing (the card leaves "Sending").
    [
      "outbound",
      "whatsapp_messages",
      `select=received_at&direction=eq.outbound&raw->>sender=eq.${enc}` +
        `&received_at=gte.${pgTimestamp(floor)}&order=received_at.desc&limit=1`,
    ],
    // The turn produced a fact: a price, a term, an availability verdict.
    [
      "replies",
      "vendor_replies",
      `select=created_at&user_email=eq.${enc}&created_at=gte.${pgTimestamp(floor)}` +
        `&order=created_at.desc&limit=1`,
    ],
    // Everything else worth repainting for, funnel-stage transitions included.
    [
      "events",
      "agent_events",
      `select=created_at&user_email=eq.${enc}&created_at=gte.${pgTimestamp(floor)}` +
        `&order=created_at.desc&limit=1`,
    ],
  ];

  const results = await Promise.all(
    sources.map(async ([name, table, query]) => {
      const rows = await sbSelectDark<Record<string, string>>(table, query);
      if (rows === null) return { name, at: null as number | null, dark: true };
      const first = rows[0] as Row | undefined;
      const raw = first ? Object.values(first)[0] : null;
      const at = raw ? Date.parse(String(raw)) : NaN;
      return { name, at: Number.isFinite(at) ? at : null, dark: false };
    })
  );

  const degraded = results.filter((r) => r.dark).map((r) => r.name);
  const stamps = results.map((r) => r.at ?? 0);
  const v = Math.max(0, ...stamps);

  return NextResponse.json(
    { v, degraded, now: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
