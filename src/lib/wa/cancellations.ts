import "server-only";
import { getConfig, sbDelete, sbInsert, sbSelectStrict } from "../runtime-config";
import { parseFlag } from "../config-flags";
import { digitsOnly } from "../phone";
import { nationalTail, numberFilter, numberVariants } from "./phone-key";

// Cancellation tombstones - the "absolute queue deletion" guarantee.
//
// Removing a queued message must mean the shop is NEVER messaged again by the
// agents - not by the outbox drain, not by a strategic-wait wakeup that
// re-composes a fresh message, not by a retry after a worker restart. All of
// those paths converge on guardOutbound / the send moment, so the tombstone is
// enforced THERE (see wa-guard rule -2) rather than by chasing every queue.
//
// Semantics:
//   - written by: queue removal, Clear Search / session close, deal close
//   - enforced on: AUTOMATED sends only (a human explicitly pressing Send is
//     itself the re-initiation signal)
//   - cleared by: any explicit user action toward that shop (new RFQ, custom
//     message, mass-bargain selection, pickup consent, deal close message)
//   - kill switch: app_config CANCEL_GUARD = "off" disables enforcement
//     (escape hatch if a bug ever over-blocks; writes keep happening so
//     turning it back on restores protection)

export type CancelReason = "user-removed" | "session-closed" | "deal-closed";

// MIGRATION-FREE FALLBACK: the dedicated wa_cancellations table only exists
// after the owner re-runs schema.sql - but "remove must be permanent" cannot
// wait for a migration. Marker rows in whatsapp_messages (a table that has
// existed since day one - the same trick the session-closed flag uses) carry
// the tombstone until the table is available: to_number="cancel",
// raw {sender, digits, kind: "cancelled-shop" | "cancel-cleared"}. The
// NEWEST marker for a (sender, shop) pair wins.

const MARKER_WINDOW_MS = 14 * 24 * 3600_000;

async function writeMarker(
  senderKey: string,
  digits: string,
  kind: "cancelled-shop" | "cancel-cleared",
  reason?: string
): Promise<boolean> {
  return sbInsert("whatsapp_messages", [
    {
      to_number: "cancel",
      body: kind === "cancelled-shop" ? `(stopped messages to +${digits})` : `(re-opened +${digits})`,
      type: "system",
      direction: "outbound",
      // `tail` is the canonical per-shop key (audit F035): the national tail
      // both spellings of one line agree on, so a marker written under the
      // outbox row's spelling is still found by the reply path's JID digits.
      raw: {
        sender: senderKey,
        digits,
        kind,
        ...(nationalTail(digits) ? { tail: nationalTail(digits) } : {}),
        ...(reason ? { reason } : {}),
      },
    },
  ]);
}

/**
 * The marker's "this shop" fragment, TOLERANT of spelling (audit F035): every
 * spelling numberVariants can derive from the digits in hand, plus the canonical
 * tail stamped on markers written since. Only `.eq.` clauses on jsonb paths -
 * the exact `or=(raw->>x.eq.a,raw->>y.eq.b)` shape bargain-draft, deals/restore
 * and evolution.ts already run against production PostgREST. Deliberately NO
 * `like` on a jsonb path: nothing in this repo has proven that shape, and a 400
 * here would return null and hold every automated send fleet-wide.
 */
function markerNumberFilter(digits: string): string {
  const clauses = numberVariants(digits)
    .filter((v) => /^\d{5,20}$/.test(v))
    .map((v) => `raw->>digits.eq.${v}`);
  const tail = nationalTail(digits);
  if (tail) clauses.unshift(`raw->>tail.eq.${tail}`);
  if (clauses.length === 0) return `&raw->>digits=eq.${encodeURIComponent(digits)}`;
  return `&or=(${clauses.join(",")})`;
}

/** Newest marker verdict: true=cancelled, false=cleared/none, null=unreadable. */
async function markerSaysCancelled(senderKey: string, digits: string): Promise<boolean | null> {
  const res = await sbSelectStrict<{ raw: { kind?: string } | null }>(
    "whatsapp_messages",
    `select=raw&to_number=eq.cancel&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      senderKey
    )}${markerNumberFilter(digits)}&received_at=gte.${encodeURIComponent(
      new Date(Date.now() - MARKER_WINDOW_MS).toISOString()
    )}&order=received_at.desc&limit=1`
  );
  if (!("rows" in res)) return res.error === "missing" ? false : null;
  return res.rows[0]?.raw?.kind === "cancelled-shop";
}

/** Write a tombstone. Returns false when NO durable store confirmed it. */
export async function cancelSends(
  senderKey: string,
  toDigits: string,
  reason: CancelReason
): Promise<boolean> {
  const digits = digitsOnly(toDigits);
  if (!senderKey || !digits) return false;
  // Upsert on (sender_key, to_number): re-cancelling refreshes the reason.
  const table = await sbInsert(
    "wa_cancellations",
    [{ sender_key: senderKey, to_number: digits, reason }],
    "sender_key,to_number"
  );
  // The marker is ALWAYS written too: it protects the pre-migration present
  // AND survives the moment the table appears (an empty new table must not
  // silently reopen shops cancelled via markers).
  const marker = await writeMarker(senderKey, digits, "cancelled-shop", reason);
  return table || marker;
}

/**
 * Remove the tombstone - called by every EXPLICIT user send action. Returns
 * true only when at least one durable store CONFIRMED the clear; a caller
 * about to queue a message for this shop must treat false as "still
 * removed" and refuse honestly, because the guard will otherwise terminally
 * kill the row at drain - which is how six never-removed shops once rendered
 * as "REMOVED BY YOU".
 */
export async function clearCancellation(senderKey: string, toDigits: string): Promise<boolean> {
  const digits = digitsOnly(toDigits);
  if (!senderKey || !digits) return false;
  // TOLERANT delete: the tombstone may be stored under a different spelling
  // of the same line (international vs national). An exact-string miss left
  // a 14-day tombstone in force after the user explicitly re-selected the
  // shop.
  const deleted = await sbDelete(
    "wa_cancellations",
    `sender_key=eq.${encodeURIComponent(senderKey)}${numberFilter("to_number", digits)}`
  ).catch(() => false);
  // The clearing marker is written UNCONDITIONALLY. The old version only
  // wrote it when the cancelled-marker read returned exactly true - so a
  // transient read failure skipped it and left the newest marker saying
  // "cancelled-shop" for 14 days, overriding the user's explicit re-open.
  const marked = await writeMarker(senderKey, digits, "cancel-cleared").catch(() => false);
  return Boolean(deleted) || Boolean(marked);
}

/**
 * Is this recipient tombstoned for this sender?
 *   true  - cancelled: automated sends must be refused outright
 *   false - not cancelled
 *   null  - the truth is UNKNOWN (transient read failure): automated senders
 *           must fail CLOSED (hold + retry), never assume "not cancelled"
 * Checks the dedicated table first, then the marker trail - a cancel
 * recorded EITHER way is honored, so removal works before, during and after
 * the schema migration.
 */
export async function isCancelled(
  senderKey: string,
  toDigits: string
): Promise<boolean | null> {
  const digits = digitsOnly(toDigits);
  if (!senderKey || !digits) return false;
  if (!(await cancelGuardEnabled())) return false;
  // TOLERANT read (audit F035) - the same numberFilter the clear at
  // clearCancellation already uses. The tombstone is written from the outbox
  // row's spelling (Google's national number) while the reply path asks with
  // WhatsApp's JID digits; an exact match let a removed shop be auto-messaged
  // the moment it replied.
  const res = await sbSelectStrict<{ id: number }>(
    "wa_cancellations",
    `select=id&sender_key=eq.${encodeURIComponent(senderKey)}&limit=1${numberFilter(
      "to_number",
      digits
    )}`
  );
  if ("rows" in res && res.rows.length > 0) return true;
  const tableUnavailable = !("rows" in res) && res.error === "unavailable";
  const marker = await markerSaysCancelled(senderKey, digits);
  if (marker === true) return true;
  if (marker === null || tableUnavailable) return null; // unknown -> fail closed
  return false;
}

/** A tombstone with its ACTOR attached - who cancelled, and when. */
export interface CancelledEntry {
  digits: string;
  reason: CancelReason | "unknown";
  at: string | null;
}

/**
 * All tombstones for a user WITH their reason and timestamp. The reason
 * column was always written but never read - so the client rendered every
 * tombstone as "Removed by you", attributing the system's own session-close
 * sweeps to the traveller ("REMOVED BY YOU (6)" on shops the owner never
 * touched). Membership semantics are unchanged: the table wins, and the
 * newest marker per shop fills in marker-only tombstones.
 */
export async function cancelledEntries(senderKey: string): Promise<CancelledEntry[]> {
  const out = new Map<string, CancelledEntry>();
  const res = await sbSelectStrict<{ to_number: string; reason: string | null; created_at: string | null }>(
    "wa_cancellations",
    `select=to_number,reason,created_at&sender_key=eq.${encodeURIComponent(senderKey)}&limit=100`
  );
  if ("rows" in res) {
    for (const r of res.rows) {
      out.set(r.to_number, {
        digits: r.to_number,
        reason: isCancelReason(r.reason) ? r.reason : "unknown",
        at: r.created_at ?? null,
      });
    }
  }
  // Fold the marker trail (newest marker per shop wins).
  const markers = await sbSelectStrict<{
    raw: { digits?: string; kind?: string; reason?: string } | null;
    received_at: string | null;
  }>(
    "whatsapp_messages",
    `select=raw,received_at&to_number=eq.cancel&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      senderKey
    )}&received_at=gte.${encodeURIComponent(
      new Date(Date.now() - MARKER_WINDOW_MS).toISOString()
    )}&order=received_at.desc&limit=200`
  );
  if ("rows" in markers) {
    const seen = new Set<string>();
    for (const m of markers.rows) {
      const d = m.raw?.digits;
      if (!d || seen.has(d)) continue;
      seen.add(d);
      if (m.raw?.kind === "cancelled-shop" && !out.has(d)) {
        out.set(d, {
          digits: d,
          reason: isCancelReason(m.raw?.reason) ? m.raw.reason : "unknown",
          at: m.received_at ?? null,
        });
      }
    }
  }
  return [...out.values()];
}

function isCancelReason(v: unknown): v is CancelReason {
  return v === "user-removed" || v === "session-closed" || v === "deal-closed";
}

/** Back-compat digest of cancelledEntries - digits only. */
export async function cancelledNumbers(senderKey: string): Promise<string[]> {
  return (await cancelledEntries(senderKey)).map((e) => e.digits);
}

/** Owner kill switch (default ON). One flag dialect - "false"/"0"/"no" and
 * a stray " off " all disable it too; an unreadable value keeps it ON. */
export async function cancelGuardEnabled(): Promise<boolean> {
  const flag = await getConfig("CANCEL_GUARD").catch(() => undefined);
  return parseFlag(flag, true);
}

/**
 * Housekeeping: tombstones older than 14 days are stale (any session they
 * protected is long gone; explicit sends clear them anyway). Called
 * opportunistically from session close - cheap and throttle-free because a
 * session close is itself rare.
 */
export async function pruneCancellations(senderKey: string): Promise<void> {
  await sbDelete(
    "wa_cancellations",
    `sender_key=eq.${encodeURIComponent(senderKey)}&created_at=lt.${encodeURIComponent(
      new Date(Date.now() - 14 * 24 * 3600_000).toISOString()
    )}`
  ).catch(() => {});
}

/** Record a suppressed send so the Ops/Health surfaces can count them. */
export async function recordSuppressedSend(
  senderKey: string,
  toDigits: string,
  kind: "cancelled-send-blocked" | "takeover-send-blocked"
): Promise<void> {
  await sbInsert("agent_events", [
    {
      kind,
      detail: `Automated message to +${digitsOnly(toDigits)} suppressed (${
        kind === "cancelled-send-blocked" ? "user removed queued messages" : "human takeover"
      }) for ${senderKey}.`,
    },
  ]).catch(() => {});
}
