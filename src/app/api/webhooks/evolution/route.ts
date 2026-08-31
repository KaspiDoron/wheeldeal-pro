// Evolution API webhook - inbound messages from users' personal WhatsApp
// sessions (QR-connected in Profile). Feeds the same agentic loop as the
// official Cloud API webhook; auto-replies go back out through the SAME
// user's session, so the whole conversation stays authentic and in-app.
//
// The webhook URL we register includes ?token=<derived-from-api-key>, so
// random internet traffic cannot inject fake vendor replies.
//
// THIN ROUTE: the whole ingestion pipeline lives in src/lib/wa/ingest.ts
// (processEvolutionWebhook), shared verbatim with the BullMQ incoming.worker
// of the GCP migration - one brain, two transports. This route only
// authenticates, parses and delegates.

import { NextResponse } from "next/server";
import { webhookAuthToken } from "@/lib/evolution";
import { processEvolutionWebhook } from "@/lib/wa/ingest";
import { noteWebhookAccepted, noteWebhook403 } from "@/lib/wa/webhook-trace";
import { selfKickOrigin } from "@/lib/request-origin";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const presented = url.searchParams.get("token");
  // AUTHENTICATE ON THE HOST-INDEPENDENT TOKEN (OR11 I2.4). The old
  // `webhookToken()` returned null whenever getHosts() came back empty - which a
  // vault outage causes falsely - so a webhook carrying a VALID token was 403'd
  // and Evolution DROPPED the shop's reply for good. The token is derived from
  // SESSION_SECRET alone (bootstrap env), so authenticity never needed the host
  // list; `!expected` now means SESSION_SECRET is genuinely missing, not a
  // transient vault wobble.
  // Constant-time compare (W9): the session cookie and the Meta webhook both
  // timingSafeEqual their secrets; this gate compared with `!==`.
  const { tokenMatches } = await import("@/lib/wa/webhook-token");
  const expected = webhookAuthToken();
  if (!expected || !tokenMatches(presented, expected)) {
    // Leave a throttled breadcrumb (per process) so a stale-token 403 storm is
    // visible in-app instead of silent. NO body parse, NO full token logged.
    void noteWebhook403("webhooks/evolution", presented);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: true });

  // Durable "last inbound accepted at" (throttled per instance).
  void noteWebhookAccepted(String((body as { instance?: string; instanceName?: string })?.instance ?? (body as { instanceName?: string })?.instanceName ?? "") || undefined, String((body as { event?: string })?.event ?? "") || undefined);

  // NOT url.origin: on Cloud Run that is the bind address (0.0.0.0:8080), and
  // the self-kicks built from it silently failed - which is why composed
  // replies never reached WhatsApp.
  const origin = await selfKickOrigin(req);
  const outcome = await processEvolutionWebhook(body, { origin, token: expected });

  // FAIL LOUD ON OUR OWN OUTAGE. When a message could not be ingested because
  // our storage was unreachable (not because it was judged not-ours), a 200
  // here told Evolution "delivered" and the reply was permanently eaten. A
  // 503 makes the provider redeliver once we are back.
  if (outcome?.retryable) {
    return NextResponse.json({ ok: false, retry: true }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
