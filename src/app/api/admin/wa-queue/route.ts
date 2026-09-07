import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect, sbDelete } from "@/lib/runtime-config";
import { drainOutbox } from "@/lib/wa-guard";
import { sendFromUser } from "@/lib/evolution";

// Queued WhatsApp messages viewer + control (#10/#11). Shows exactly which
// messages are waiting, to whom, when they will send, and WHY they are paced
// (the anti-ban reason). The owner can flush all due messages now, or drop one.
//
// THE WORDS ARE THE OWNER'S (audit F163). wa_outbox is one of the tables
// admin/data marks owner-only ("tables carrying message TEXT"), and this
// route shipped the first 90 characters of every queued body plus the shop's
// number to any management session - the same admin refused on one route and
// served on another. The queue view stays management-visible because the
// parking reason, due state and lapsed claim are genuine ops signal; the
// preview and the recipient number are built for the owner only.

/** The recipient identifier a non-owner sees: the national tail, never the number. */
function redactedNumber(digits: string): string {
  const d = String(digits ?? "").replace(/\D/g, "");
  return d.length > 4 ? `***${d.slice(-4)}` : "***";
}

interface OutboxRow {
  id: number;
  sender_key: string;
  to_number: string;
  body: string;
  not_before: string;
  meta: { reason?: string; vendorName?: string; kind?: string } | null;
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await sbSelect<OutboxRow>(
    "wa_outbox",
    "select=id,sender_key,to_number,body,not_before,meta&order=not_before.asc&limit=100"
  ).catch(() => []);

  const now = Date.now();
  const owner = session.role === "owner";
  const items = rows.map((r) => {
    const due = Date.parse(r.not_before) <= now;
    const overdue = Date.parse(r.not_before) < now - 30 * 60_000;
    return {
      id: r.id,
      to: owner ? r.to_number : redactedNumber(r.to_number),
      // Conversation content crosses the owner line only (F163).
      preview: owner ? (r.body || "").slice(0, 90) : null,
      locked: !owner,
      notBefore: r.not_before,
      due,
      overdue,
      vendorName: r.meta?.vendorName ?? null,
      kind: r.meta?.kind ?? null,
      // The queue reason lives in meta when we parked it; fall back to a clear
      // default so the owner always sees WHY it is waiting.
      reason:
        r.meta?.reason ??
        (due
          ? "Ready to send - waiting for the next drain (open the app or flush now)."
          : "Paced by the anti-ban engine (shop hours / rate limit)."),
    };
  });

  return NextResponse.json({
    items,
    total: items.length,
    due: items.filter((i) => i.due).length,
    overdue: items.filter((i) => i.overdue).length,
  });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  if (body.action === "delete" && body.id) {
    // HONEST WRITE (audit M45): this answered ok:true without reading the
    // boolean, so a cancel that Supabase refused was reported done while the
    // row stayed queued and the next drain put the message on the shop's
    // phone. sbDelete's false is a transport/permission failure (PostgREST
    // answers a zero-row DELETE with 204), so it is never read as "already
    // gone" - and no representation round trip is added to a path the owner
    // taps during a live drain.
    const removed = await sbDelete("wa_outbox", `id=eq.${Number(body.id)}`);
    if (!removed) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "The drop did not go through - the row is still queued and the next drain will send it. Check Supabase and retry.",
        },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "flush") {
    // Send every DUE queued message right now, respecting the anti-ban gate.
    const sent = await drainOutbox(async (senderKey, to, text, lane) => {
      // Owner pressed "send now" and is looking at the row. The lane still
      // matters: flushing a stuck reply through the cold-intro budget is how a
      // manual rescue turns into a rate-limit refusal on the reply lane that
      // had headroom all along.
      // Pass the WHOLE result through: narrowing to {ok} discarded the provider
      // message id, the @lid chat anchor, the rate-limit signal and - the unsafe
      // one - the `ambiguous` flag, so this admin flush was the one drain adapter
      // that could release a claim on a status-0 send that had actually landed.
      return await sendFromUser(senderKey, to, text, true, { skipJitter: true, lane });
    });
    return NextResponse.json({ ok: true, sent });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
