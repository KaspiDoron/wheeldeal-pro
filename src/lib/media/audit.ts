import "server-only";

// THE AUDIT COPY, ON THE RUNTIME THAT ACTUALLY RUNS.
//
// WhatsApp expires media after a while. The vision WORKER kept a redeemable
// copy in Supabase Storage - and the worker is deployed nowhere, so on the
// live inline path every photo went un-audited and "Full conversation" lost
// the picture the moment upstream expired it. This is the worker's own
// storeMediaAudit (vision.worker.ts), verbatim in contract: deterministic
// path keyed on the provider message id, best-effort, never throws, never
// slows the turn (call it fire-and-forget).
//
// /api/wa/media reads these back by trying `wa-media/<id>.<ext>` - keep the
// extension map in step with its AUDIT_EXTS list.
//
// ONE PATH BUILDER FOR THE WRITER, THE READER AND THE DELETER (audit F168).
// These objects are personal content - a shop's price board in one
// traveller's thread, a voice note - and nothing in the tree ever deleted
// one: the erase walker and retention.sql reach tables only. The erasure
// registry now declares the bucket (privacy/user-tables.ts USER_OBJECT_STORES)
// and the walker calls `deleteMediaAudit` with the person's wa_message_ids
// BEFORE it deletes the whatsapp_messages rows that are the only index to
// them. The candidate names are derived here, from the same map the writer
// uses, so the three cannot drift.

/** The bucket every audit copy lives in. */
export const AUDIT_BUCKET = "wa-media";

/** Every extension storeMediaAudit can write. Keep in step with auditExtFor. */
export const AUDIT_EXTS = ["jpg", "png", "webp", "pdf", "mp4", "ogg"] as const;
export type AuditExt = (typeof AUDIT_EXTS)[number];

/**
 * The object names an id can be stored under, relative to the bucket. The
 * inline path writes `<id>.<ext>`; the (undeployed) vision worker wrote
 * `<id>-<frame>.<ext>` and the reader falls back to frame 0 - so the deleter
 * covers exactly the names the reader can reach.
 */
const NAME_SUFFIXES = ["", "-0"] as const;

/** Objects per Storage batch DELETE (one round trip each). */
const DELETE_BATCH = 500;
const DELETE_TIMEOUT_MS = 15_000;

/** The extension the writer picks for a mime type (and the reader's default per kind). */
export function auditExtFor(mime: string | null | undefined, kind?: string | null): AuditExt {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("ogg")) return "ogg";
  if (!m) {
    if (kind === "audio") return "ogg";
    if (kind === "video") return "mp4";
    if (kind === "document") return "pdf";
  }
  return "jpg";
}

/** The full object path (bucket included) the writer stores an id under. */
export function auditObjectPath(waMessageId: string, ext: AuditExt): string {
  return `wa-media/${waMessageId}.${ext}`;
}

/** Every bucket-relative name one id may be stored under, across every extension. */
export function auditObjectCandidates(waMessageId: string): string[] {
  const out: string[] = [];
  for (const suffix of NAME_SUFFIXES) {
    for (const ext of AUDIT_EXTS) out.push(`${waMessageId}${suffix}.${ext}`);
  }
  return out;
}

export async function storeMediaAudit(
  waMessageId: string,
  media: { mime: string; base64: string }
): Promise<string | undefined> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key || !waMessageId) return undefined;
  try {
    const mime = media.mime || "image/jpeg";
    const ext = auditExtFor(mime);
    const path = auditObjectPath(waMessageId, ext);
    const res = await fetch(`${base}/storage/v1/object/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": mime,
        "x-upsert": "true",
      },
      body: Buffer.from(media.base64, "base64"),
    });
    return res.ok ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Delete every audit copy that could exist for these ids.
 *
 * Batched through Storage's multi-object DELETE (`{prefixes: [...]}`), so a
 * heavy user costs a handful of round trips rather than one per candidate
 * name. Names that do not exist are simply absent from the response - the
 * call is a blind sweep by construction. Honest result: `ok` is false the
 * moment any batch does not confirm, so the caller can NAME the store as not
 * purged rather than report a clean erasure over bytes still in the bucket.
 *
 *   - unconfigured Storage: nothing could ever have been written -> ok
 *   - 404 (bucket never created): nothing is stored -> ok
 *   - any other non-2xx, or a network/timeout failure -> not ok
 */
export async function deleteMediaAudit(
  waMessageIds: string[]
): Promise<{ ok: boolean; deleted: number; configured: boolean }> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { ok: true, deleted: 0, configured: false };
  const paths = waMessageIds.filter(Boolean).flatMap(auditObjectCandidates);
  let deleted = 0;
  for (let i = 0; i < paths.length; i += DELETE_BATCH) {
    const chunk = paths.slice(i, i + DELETE_BATCH);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DELETE_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/storage/v1/object/${AUDIT_BUCKET}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prefixes: chunk }),
        signal: ctrl.signal,
      });
      if (res.status === 404) continue;
      if (!res.ok) return { ok: false, deleted, configured: true };
      const body = (await res.json().catch(() => [])) as unknown;
      deleted += Array.isArray(body) ? body.length : 0;
    } catch {
      return { ok: false, deleted, configured: true };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: true, deleted, configured: true };
}
