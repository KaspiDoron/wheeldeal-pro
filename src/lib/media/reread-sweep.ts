import "server-only";
import { sbSelect, sbUpdate, sbInsert } from "@/lib/runtime-config";
import type { MediaReading, RereadState } from "./reading";
import {
  REREAD_BATCH,
  REREAD_MAX_AGE_MS,
  attemptStarted,
  recovered,
  rereadSkipReason,
  withAttempt,
} from "./reread";
import type { StructuredRFQ } from "@/lib/types";

// THE IO HALF OF THE DEFERRED RE-READ. The policy is pure and lives in
// `./reread`; this is the part that needs a database, a storage bucket and a
// vision provider, and it does as little thinking as possible.
//
// Bytes come from the AUDIT COPY in Supabase Storage, not from Evolution:
// WhatsApp expires media, `storeMediaAudit` keeps a redeemable copy keyed on
// the provider message id for exactly this reason, and re-downloading through
// the shop's own host would spend a request on the linked number for no gain.

/** The extensions storeMediaAudit writes. Keep in step with its map. */
const AUDIT_EXTS = ["jpg", "png", "webp", "pdf", "mp4", "ogg"] as const;

const MIME_FOR: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  ogg: "audio/ogg",
};

/** Read the archived bytes back, or null when nothing is stored. */
export async function loadArchivedMedia(
  waMessageId: string
): Promise<{ mime: string; base64: string } | null> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key || !waMessageId) return null;
  for (const ext of AUDIT_EXTS) {
    try {
      const res = await fetch(`${base}/storage/v1/object/wa-media/${waMessageId}.${ext}`, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) continue;
      return { mime: MIME_FOR[ext] ?? "image/jpeg", base64: buf.toString("base64") };
    } catch {
      /* try the next extension - a miss is the normal case for five of six */
    }
  }
  return null;
}

interface Row {
  id: number;
  wa_message_id: string | null;
  received_at: string | null;
  raw: Record<string, unknown> | null;
}

/**
 * Retry the reads that failed for a reason about the MINUTE rather than the
 * photo, and repaint the conversation page when one recovers.
 *
 * Bounded three ways: the SQL window, `REREAD_BATCH`, and the pure policy's own
 * per-photo attempt/cooldown/age rules. Never throws - it runs on the keep-awake
 * cron, and housekeeping must not be able to fail a heartbeat.
 */
export async function sweepMediaRereads(
  nowMs = Date.now()
): Promise<{ scanned: number; retried: number; recovered: number }> {
  const out = { scanned: 0, retried: 0, recovered: 0 };
  const since = new Date(nowMs - REREAD_MAX_AGE_MS).toISOString();
  const rows = await sbSelect<Row>(
    "whatsapp_messages",
    `select=id,wa_message_id,received_at,raw&direction=eq.inbound&received_at=gte.${encodeURIComponent(
      since
    )}&raw->reading->>outcome=in.(unavailable,truncated,parse-failed)&order=received_at.desc&limit=40`
  ).catch(() => []);
  out.scanned = rows.length;

  for (const row of rows) {
    if (out.retried >= REREAD_BATCH) break;
    const raw = (row.raw ?? {}) as Record<string, unknown>;
    const reading = raw.reading as MediaReading | undefined;
    if (
      rereadSkipReason(
        { reading, receivedAt: row.received_at, waMessageId: row.wa_message_id },
        nowMs
      ) !== null
    ) {
      continue;
    }
    const state: RereadState = attemptStarted(reading!.reread, new Date(nowMs).toISOString());
    // BURN THE TRY FIRST. A crash mid-attempt must still cost an attempt, or a
    // photo that kills the invocation is retried for ever at every sweep.
    await sbUpdate("whatsapp_messages", `id=eq.${row.id}`, {
      raw: { ...raw, reading: withAttempt(reading!, state) },
    }).catch(() => {});
    out.retried += 1;

    try {
      const media = await loadArchivedMedia(row.wa_message_id!);
      if (!media) continue;
      const rfq = state.rfq as StructuredRFQ | undefined;
      if (!rfq) continue; // nothing to read the board AGAINST - not a retry we can make
      const { extractOffer } = await import("@/lib/agents");
      const { readingFrom } = await import("./reading");
      const extraction = await extractOffer(rfq, state.text ?? "", [media]);
      const next = readingFrom(extraction as never, {});
      if (!recovered(next)) continue;
      // Re-read the row: the live path may have stamped a better reading while
      // this attempt was in flight, and a deferred retry must never overwrite a
      // fresher answer with an older one.
      const fresh = await sbSelect<Row>(
        "whatsapp_messages",
        `select=id,wa_message_id,received_at,raw&id=eq.${row.id}&limit=1`
      ).catch(() => []);
      const freshRaw = (fresh[0]?.raw ?? raw) as Record<string, unknown>;
      const freshReading = freshRaw.reading as MediaReading | undefined;
      if (freshReading && recovered(freshReading)) continue;
      await sbUpdate("whatsapp_messages", `id=eq.${row.id}`, {
        raw: { ...freshRaw, reading: { ...next, reread: state } },
      });
      out.recovered += 1;
      void sbInsert("agent_events", [
        {
          kind: "vision-reread-recovered",
          detail: `attempt ${state.attempts} recovered a reading that failed as ${reading!.outcome}`.slice(0, 500),
        },
      ]).catch(() => {});
    } catch {
      /* an attempt that throws has already been counted - move to the next */
    }
  }

  // THE COUNTER THAT ANSWERS "DO WE ACTUALLY NEED OFFLINE OCR". Assumption is
  // how the tesseract ask got here; evidence is how it should be settled.
  if (out.retried > 0) {
    void sbInsert("agent_events", [
      {
        kind: "vision-reread-sweep",
        detail: JSON.stringify(out).slice(0, 400),
      },
    ]).catch(() => {});
  }
  return out;
}
