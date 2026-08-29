// Official Meta WhatsApp Cloud API webhook (used when the owner has a
// verified business + Cloud API credentials). Inbound vendor replies are
// persisted and fed into the shared agentic loop (lib/agent-loop.ts) - the
// same pipeline the per-user Evolution sessions use.
//
// GET  - verification handshake. Meta calls this with hub.verify_token; we echo
//        hub.challenge when the token matches WHATSAPP_VERIFY_TOKEN.
// POST - inbound events.
//
// Configure the callback URL in Meta as: https://<your-domain>/api/webhooks/whatsapp

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getConfig, sbInsert, sbSelect, sbSelectStrict } from "@/lib/runtime-config";
import { processVendorReply } from "@/lib/agent-loop";
import { numberFilter } from "@/lib/wa/phone-key";
import { sendWhatsApp } from "@/lib/whatsapp";
import { digitsOnly } from "@/lib/phone";
import { readOrientation } from "@/lib/media/orientation";
import type { InboundImage } from "@/lib/media/orientation";

// Verify Meta's X-Hub-Signature-256 over the RAW request body.
//
// The comment that used to sit here said this "returns true when no app secret
// is configured (demo/dev) so the endpoint still works". It did not return
// true - the CALLER skipped the check entirely, which is worse, because the
// skip lived at the call site where nobody reading this function could see it.
// See the POST handler for why an absent secret now refuses.
function signatureValid(raw: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  try {
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = await getConfig("WHATSAPP_VERIFY_TOKEN");
  if (mode === "subscribe" && expected && token === expected) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

interface WaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
}
interface WaMessage {
  id: string;
  from: string;
  timestamp?: string;
  text?: { body?: string };
  image?: WaMedia;
  document?: WaMedia;
  audio?: WaMedia;
  type?: string;
}
interface WaValue {
  metadata?: { phone_number_id?: string };
  messages?: WaMessage[];
}

// Download an inbound Cloud API media object as base64 (two-step Graph API
// flow: media-id -> temporary URL -> bytes). Best-effort; returns null on any
// failure so a photo never breaks the webhook. Enables photo understanding on
// the official channel too, not just Evolution.
//
// This is the SECOND ingest boundary (Evolution's fetchMediaBase64 is the
// other), so it measures EXIF orientation too - otherwise the official channel
// would be a blind spot where the same sideways price board reaches the vision
// model with nothing declared about it. Cheaper here than there: the raw Buffer
// is already in hand, so no base64 round trip is needed to read the tag.
async function fetchCloudMedia(mediaId: string): Promise<InboundImage | null> {
  const token = await getConfig("WHATSAPP_ACCESS_TOKEN");
  if (!token) return null;
  // Both Graph fetches are awaited INLINE in the webhook before it returns 200
  // to Meta. A stalled Meta CDN with no timeout would hang the shared handler
  // until the platform kills it -> Meta gets no 200, re-delivers, and can disable the
  // callback, and the end-of-handler drain never runs. Bound both calls, and
  // cap the download so an oversized media object cannot exhaust memory.
  const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
  const timed = async (url: string, ms: number): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    (timer as { unref?: () => void }).unref?.();
    return fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: ctrl.signal,
    });
  };
  try {
    const metaRes = await timed(`https://graph.facebook.com/v20.0/${mediaId}`, 10_000);
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    if (!meta?.url) return null;
    const lenHdr = Number(meta?.file_size ?? 0);
    if (lenHdr && lenHdr > MAX_MEDIA_BYTES) return null; // oversized - skip
    const binRes = await timed(meta.url, 12_000);
    if (!binRes.ok) return null;
    const declared = Number(binRes.headers.get("content-length") ?? 0);
    if (declared && declared > MAX_MEDIA_BYTES) return null;
    const ab = await binRes.arrayBuffer();
    if (ab.byteLength > MAX_MEDIA_BYTES) return null; // cap post-read too
    const buf = Buffer.from(ab);
    return {
      mime: meta.mime_type || "image/jpeg",
      base64: buf.toString("base64"),
      orientation: readOrientation(buf),
    };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  // Read the RAW body once - signature verification must run over the exact
  // bytes Meta signed, so we cannot use req.json() first.
  const raw = await req.text();
  // NO SECRET MEANS REFUSE, NOT SKIP.
  //
  // The check used to live inside `if (appSecret)`. `getConfig` resolves from
  // the Supabase-backed vault, so a brownout - or an unset key, or a rotated
  // SESSION_SECRET making the stored value undecryptable - silently disabled
  // authentication on a public endpoint. Anyone who knew the URL could then POST
  // fabricated shop replies, complete with prices, straight into
  // `processVendorReply` and a live negotiation. The agent would read them as
  // the shop's real position and bargain against them.
  //
  // The old behaviour was justified as "demo/dev still works", but the cost of
  // that convenience is an unauthenticated write path into the negotiation
  // engine that opens itself whenever the vault hiccups. A Cloud API deployment
  // that has not configured its app secret is not configured; 401 says so.
  const appSecret = await getConfig("WHATSAPP_APP_SECRET");
  if (!appSecret) {
    return NextResponse.json(
      { error: "Webhook not configured - set WHATSAPP_APP_SECRET." },
      { status: 401 }
    );
  }
  const sig = req.headers.get("x-hub-signature-256");
  if (!signatureValid(raw, sig, appSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!body) return NextResponse.json({ ok: true });

  try {
    // The Cloud number is SHARED by all users, so the receiving user must be
    // resolved per sender-number: the distinct owners of recent outbound
    // threads to that number. Exactly one owner = unambiguous. Several =
    // PARK, DON'T GUESS: attributing to the newest sender put user A's reply
    // inside user B's thread (the cross-user leak class). An unattributed
    // row (no raw.receiver) is invisible to every user surface by
    // construction - visible to nobody beats visible to the wrong person -
    // and the ambiguity is logged for the owner's Ops review.
    // "db-unavailable" is DISTINCT from "no matching thread": a transient read
    // failure must make Meta RETRY (503), never be collapsed into a null-receiver
    // unattributed row that returns 200 and drops the vendor reply forever.
    const DB_ERR = Symbol("db-unavailable");
    const resolveReceiver = async (fromDigits: string): Promise<string | null | typeof DB_ERR> => {
      const res = await sbSelectStrict<{ raw: { sender?: string } | null }>(
        "whatsapp_messages",
        `select=raw&direction=eq.outbound&received_at=gte.${encodeURIComponent(
          new Date(Date.now() - 14 * 86_400_000).toISOString()
        )}&order=received_at.desc&limit=20${numberFilter("to_number", fromDigits)}`
      );
      // Genuine DB outage -> retry. A missing table (pre-migration) behaves as
      // before (no attribution possible -> null), never a false retry storm.
      if ("error" in res) return res.error === "unavailable" ? DB_ERR : null;
      const outs = res.rows;
      const senders = [
        ...new Set(outs.map((o: { raw: { sender?: string } | null }) => o.raw?.sender).filter(Boolean)),
      ] as string[];
      if (senders.length === 0) return null;
      if (senders.length > 1) {
        await sbInsert("agent_events", [
          {
            kind: "ambiguous-inbound",
            vendor_id: "",
            vendor_name: fromDigits,
            detail: `Cloud inbound from +${fromDigits} matches ${senders.length} users' threads (${senders
              .slice(0, 4)
              .join(", ")}) - PARKED unattributed, visible to no user. Shared-number limitation.`,
          },
        ]).catch(() => {});
        return null;
      }
      return senders[0];
    };

    const inbound: { msg: WaMessage; receiver: string | null }[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value as WaValue;
        for (const msg of value.messages ?? []) {
          const kind = msg.type ?? "text";
          const caption = msg.image?.caption ?? msg.document?.caption;
          const resolved = await resolveReceiver(msg.from);
          // Attribution read failed (DB outage): store NOTHING and make Meta
          // retry the whole batch when the DB recovers, instead of parking this
          // reply unattributed (invisible to its rightful user, never retried).
          if (resolved === DB_ERR) {
            return NextResponse.json({ error: "attribution unavailable - retry" }, { status: 503 });
          }
          // SAME ingestion gate as the Evolution path: only attribute/process a
          // message from a number that is an ACTIVE rental-shop thread for the
          // resolved user (rfq-bearing, recency- and drill-windowed). Without
          // this, the shared Cloud number ingested a user's non-shop contacts
          // for up to 14 days as "shop replies". A non-vendor-thread inbound is
          // stored UNATTRIBUTED (receiver=null) so it is invisible to everyone.
          const { isVendorThread } = await import("@/lib/drill");
          let receiver: string | null = null;
          if (resolved) {
            // The text rides along for the staff-mobile opener allowance only
            // (drill.ts / waba/expectation) - a WABA agency replying from a
            // personal device whose tail matches no lead.
            const gate = await isVendorThread(
              digitsOnly(msg.from),
              resolved,
              (msg.text?.body ?? caption ?? "") || undefined
            );
            // null = the vendor-gate store was UNREACHABLE (our outage), NOT a
            // verdict of "not a shop". Treating it as `false` parked a possibly
            // genuine shop reply unattributed - invisible to its user, and Meta
            // answered 200 so it never redelivered. Mirror the attribution-
            // unavailable path (and the Evolution ingest gate, which fails loud
            // on this exact null): make Meta retry the whole batch. OR11 I2.1.
            if (gate === null) {
              return NextResponse.json(
                { error: "vendor-gate unavailable - retry" },
                { status: 503 }
              );
            }
            receiver = gate ? resolved : null;
          }
          rows.push({
            wa_message_id: msg.id,
            from_number: msg.from,
            to_number: value.metadata?.phone_number_id ?? null,
            body:
              msg.text?.body ??
              caption ??
              (kind === "image" ? "[photo]" : kind === "audio" ? "[voice note]" : ""),
            type: kind,
            direction: "inbound",
            // receiver = the thread owner - the privacy-scoping keystone.
            // A null receiver (unknown, ambiguous, or not-a-vendor-thread) is
            // stored but PARKED: no user surface sees it, no agent processes it.
            raw: { ...msg, receiver, ...(receiver ? {} : { unattributed: true }) },
          });
          // Text, image/document AND voice notes are processed (a shop that
          // replies with a price-list photo or an audio price must be understood).
          // Parked rows are NOT processed - an agent run without a confirmed
          // owner would write thread state into somebody's negotiation.
          if (
            receiver &&
            (kind === "text" || kind === "image" || kind === "document" || kind === "audio")
          ) {
            inbound.push({ msg, receiver });
          }
        }
      }
    }
    // DURABILITY: if the store is unreachable, tell Meta so it RETRIES -
    // returning 200 here would permanently drop every vendor reply that
    // arrives during a database blip (no other recovery path exists for the
    // Cloud channel; wa-sync only reconciles the Evolution channel).
    if (rows.length) {
      // CLAIM BEFORE STORING. Meta retries a batch whenever our 200 is slow or
      // lost, and this insert had no dedupe of any kind - so every retry wrote
      // a second copy of every message in it. The traveller saw the shop's
      // price twice and the agent counted a burst that never happened.
      //
      // The Evolution path has claimed its stores since owner report 6; this
      // one simply never did. Same claim, same receiver scoping, same
      // fail-open: an unreachable claim table stores the row rather than
      // dropping a real shop reply.
      const { claimInboundStore } = await import("@/lib/wa/inbound-claim");
      const fresh: typeof rows = [];
      for (const r of rows) {
        const owner = (r.raw as { receiver?: string | null } | null)?.receiver ?? null;
        if (await claimInboundStore(String(r.wa_message_id ?? ""), owner)) fresh.push(r);
      }
      if (fresh.length) {
        const stored = await sbInsert("whatsapp_messages", fresh);
        const { supabaseConfigured } = await import("@/lib/runtime-config");
        if (stored === false && supabaseConfigured()) {
          // Hand the claims back, or this batch can never be retried: the
          // claim would say "stored" for rows that are not in the table.
          const { releaseInboundStore } = await import("@/lib/wa/inbound-claim");
          for (const r of fresh) {
            const owner = (r.raw as { receiver?: string | null } | null)?.receiver ?? null;
            await releaseInboundStore(String(r.wa_message_id ?? ""), owner).catch(() => {});
          }
          return NextResponse.json({ error: "store unavailable - retry" }, { status: 503 });
        }
      }
    }

    // Agentic processing, bounded so Meta always gets its 200.
    //
    // The bound used to be `inbound.slice(0, 3)`: messages four and beyond were
    // dropped on the floor, silently, with no trace and no recovery - and
    // unlike the Evolution channel there is no wa-sync sweep behind this one to
    // pick them up later. A shop answering with a four-message burst simply
    // lost its tail.
    //
    // A CLOCK is the honest bound. The ceiling is 60s, so spend at most 40 of
    // them here and let whatever is left over be RECORDED rather than
    // forgotten. In practice that processes the whole burst; when it genuinely
    // cannot, the drop is visible on the same panel every other drop is.
    const PROCESS_BUDGET_MS = 40_000;
    const processingDeadline = Date.now() + PROCESS_BUDGET_MS;
    let processed = 0;
    for (const { msg, receiver } of inbound) {
      if (Date.now() >= processingDeadline) {
        const { noteInboundDropped } = await import("@/lib/wa/webhook-trace");
        for (const left of inbound.slice(processed)) {
          await noteInboundDropped(left.receiver, digitsOnly(left.msg.from), "meta-batch-overflow", {
            note: "webhook ran out of request budget before this message could be answered",
            retryable: true,
            batchSize: inbound.length,
            processed,
          }).catch(() => {});
        }
        break;
      }
      processed++;
      const media = msg.image ?? msg.document;
      const images =
        media?.id && (media.mime_type ?? "").startsWith("image/")
          ? await fetchCloudMedia(media.id).then((m) => (m ? [m] : []))
          : [];
      // Voice note? Download + transcribe (heavy-accent primed).
      let transcript: { text: string; language?: string; source: string } | null = null;
      const txt = msg.text?.body ?? media?.caption ?? "";
      if (msg.audio?.id && !txt) {
        const audio = await fetchCloudMedia(msg.audio.id);
        if (audio) {
          const { transcribeAudio } = await import("@/lib/graph/transcribe");
          transcript = await transcribeAudio({
            mime: audio.mime || "audio/ogg",
            base64: audio.base64,
          });
        }
      }
      await processVendorReply({
        fromDigits: msg.from,
        text: txt,
        waMessageId: msg.id,
        images,
        transcript,
        // The resolved thread owner - never the globally-latest outbound.
        senderEmail: receiver ?? undefined,
        send: async (to, message) => {
          const r = await sendWhatsApp(to, message);
          return { ok: r.ok && r.channel === "cloud-api", error: r.error };
        },
      });
    }
    // Drain due graph wakeups (strategic waits + judge jobs) opportunistically.
    try {
      const { drainGraphWakeups } = await import("@/lib/graph/engine");
      await drainGraphWakeups(async (_s, to, message) => {
        const r = await sendWhatsApp(to, message);
        return { ok: r.ok && r.channel === "cloud-api", error: r.error };
      });
    } catch {
      /* best-effort */
    }
    // FAST COUNTER-REPLY: our just-composed reply is parked ~10-40s out, so kick
    // the dispatchers to wait it out in-process and deliver in seconds.
    //
    // TWO FIXES HERE. This path only ever kicked the GLOBAL tick - the one
    // runner a cold introductions batch keeps permanently busy, which is the
    // whole reason the per-sender reply lane exists - so a reply arriving on
    // the Cloud channel was still queued behind the batch. And the kick was
    // un-awaited, which on Cloud Run means it may never have left the
    // instance at all (see wa/kick.ts).
    try {
      const { webhookToken } = await import("@/lib/evolution");
      const tok = await webhookToken();
      const { selfKickOrigin } = await import("@/lib/request-origin");
      const origin = await selfKickOrigin(req);
      if (tok) {
        const { kickDispatcher } = await import("@/lib/wa/kick");
        const token = encodeURIComponent(tok);
        const senders = new Set(
          inbound.map(({ receiver }) => receiver).filter((r): r is string => Boolean(r))
        );
        await Promise.all([
          ...[...senders].map((sender) =>
            kickDispatcher(
              `${origin}/api/wa/reply-tick?token=${token}&sender=${encodeURIComponent(sender)}&hop=0`
            )
          ),
          kickDispatcher(`${origin}/api/wa/tick?token=${token}&hop=0`),
        ]);
      }
    } catch {
      /* best-effort */
    }
  } catch {
    // Never fail the webhook - Meta retries and will disable a flaky endpoint.
  }

  return NextResponse.json({ ok: true });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
