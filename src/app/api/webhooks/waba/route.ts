import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getConfig, sbUpdate, sbSelectStrict } from "@/lib/runtime-config";
import { wabaConfig } from "@/lib/waba/config";
import { noteWabaEvent, markTemplateCapped, advanceLead } from "@/lib/waba/leads";
import { nationalTail } from "@/lib/wa/phone-key";

export const dynamic = "force-dynamic";

// INBOUND AND STATUS FOR THE OFFICIAL NUMBER.
//
// Two kinds of event arrive here and they do very different things:
//
//   STATUSES tell us what happened to a message we sent - delivered, read, or
//   failed. The failure codes are the load-bearing part: 131049 means the
//   recipient has hit their per-user marketing cap across ALL businesses, which
//   is a property of their inbox rather than of our request. Treating it as a
//   retryable error is how a soft cap turns into a quality-rating problem.
//
//   MESSAGES are an agency writing back to us, and each one is worth more than
//   it looks: it opens a 24-hour service window in which we may send free-form
//   text, for free, outside the messaging tier entirely. Every lead held on that
//   agency flushes on the free lane the moment this fires.
//
// AUTHENTICATION. Meta signs with X-Hub-Signature-256; most resellers do not
// sign at all. So this accepts either a valid HMAC or a shared secret, and with
// neither configured it refuses everything rather than trusting the internet -
// an unauthenticated webhook that can open service windows and mark leads
// handed-off is a way for anyone to inject state into the ledger.

function verifyHmac(raw: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Meta's verification handshake, harmless for resellers that never call it. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const secret = await getConfig("WABA_WEBHOOK_SECRET");
  if (mode === "subscribe" && secret && token === secret && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

interface StatusEvt {
  id?: string;
  status?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string }[];
}
interface MsgEvt {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
}

export async function POST(req: Request) {
  const c = await wabaConfig();
  // With the handoff off nothing should be pointing here. Answer 200 so a
  // stale provider subscription does not retry forever, but do no work.
  if (!c.enabled) return NextResponse.json({ ok: true, ignored: "flag-off" });

  const raw = await req.text();
  const secret = (await getConfig("WABA_WEBHOOK_SECRET")) ?? "";
  if (!secret) {
    // Fail closed. Opening service windows and advancing leads on unsigned
    // internet traffic would let anyone inject state into the ledger.
    return NextResponse.json({ error: "unconfigured" }, { status: 403 });
  }
  const signed = verifyHmac(raw, req.headers.get("x-hub-signature-256"), secret);
  const shared =
    req.headers.get("x-waba-secret") === secret ||
    new URL(req.url).searchParams.get("secret") === secret;
  if (!signed && !shared) {
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const entries =
    (body as { entry?: { changes?: { value?: { statuses?: StatusEvt[]; messages?: MsgEvt[] } }[] }[] })
      .entry ?? [];

  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      for (const s of value.statuses ?? []) {
        await handleStatus(s);
      }
      for (const m of value.messages ?? []) {
        await handleInbound(m);
      }
    }
  }

  return NextResponse.json({ ok: true });
}

async function leadByMessageId(id: string): Promise<{ id: number; agency_tail: string } | null> {
  const read = await sbSelectStrict<{ id: number; agency_tail: string }>(
    "waba_leads",
    `select=id,agency_tail&provider_message_id=eq.${encodeURIComponent(id)}&limit=1`
  );
  return "error" in read ? null : read.rows[0] ?? null;
}

async function handleStatus(s: StatusEvt) {
  const code = s.errors?.[0]?.code;
  const tail = s.recipient_id ? nationalTail(s.recipient_id) : "";
  await noteWabaEvent("status", {
    agencyTail: tail || undefined,
    errorCode: code,
    raw: { status: s.status, id: s.id },
  });

  // 131049 - the per-user marketing cap. NOT retryable: the message is
  // guaranteed undeliverable until the recipient's own cap resets, and
  // re-sending only spends quality rating to be told so again.
  if (code === 131049 && tail) {
    await markTemplateCapped(tail);
    // ...and the LEAD whose send just capped goes back to HELD. The old early
    // return skipped the lead lookup entirely, so an async cap status left
    // the lead stranded in template_sent forever - waiting on a delivery that
    // was never coming, invisible to the hold-flush that would have freed it.
    if (s.id) {
      const capped = await leadByMessageId(s.id);
      if (capped) await advanceLead(capped.id, "held", { terminal_reason: null });
    }
    return;
  }

  if (!s.id) return;
  const lead = await leadByMessageId(s.id);
  if (!lead) return;

  const now = new Date().toISOString();
  if (s.status === "delivered") {
    await sbUpdate("waba_leads", `id=eq.${lead.id}&delivered_at=is.null`, { delivered_at: now }).catch(() => false);
  } else if (s.status === "read") {
    await sbUpdate("waba_leads", `id=eq.${lead.id}&read_at=is.null`, { read_at: now }).catch(() => false);
  } else if (s.status === "failed") {
    await advanceLead(lead.id, "failed", {
      terminal_reason: s.errors?.[0]?.title ?? "provider-failed",
      error_code: code ?? null,
    });
  }
}

/**
 * An agency wrote to us.
 *
 * This is the highest-value event in the system: it opens the 24-hour service
 * window, which converts that agency from "costs a template and a cap slot" to
 * "free, uncapped, instant" for every traveller who picks it in the next day.
 */
async function handleInbound(m: MsgEvt) {
  if (!m.from) return;
  // STOP-INTENT FIRST (owner decision: fleet-wide). A shop telling the
  // business number to stop is telling all of WheelDeal - record it before
  // anything treats this inbound as a window-opening opportunity.
  if (m.text?.body) {
    try {
      const { detectOptOutIntent } = await import("@/lib/inbound-risk");
      if (detectOptOutIntent(m.text.body)) {
        const { suppressShop } = await import("@/lib/wa/suppression");
        await suppressShop(m.from, m.text.body.slice(0, 120), "stop-intent");
        await noteWabaEvent("inbound", {
          agencyTail: nationalTail(m.from) || undefined,
          raw: { type: m.type, stopIntent: true },
        });
        return; // a stop is not a service-window to exploit
      }
    } catch {
      /* detection is best-effort; the reply below still records the inbound */
    }
  }
  const { onAgencyReplied } = await import("@/lib/waba/dispatch");
  const { renderHeldHandoff } = await import("@/lib/waba/render");
  await onAgencyReplied(m.from, renderHeldHandoff);
  await noteWabaEvent("inbound", {
    agencyTail: nationalTail(m.from) || undefined,
    raw: { type: m.type, preview: m.text?.body?.slice(0, 120) },
  });
}
