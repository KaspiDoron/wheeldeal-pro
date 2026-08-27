// PRIVACY-JID ALIASES: giving an @lid chat a name we can route on.
//
// WhatsApp is migrating chats to privacy identities. When it does, an inbound
// message arrives with `key.remoteJid = "<opaque>@lid"` and NO phone number in
// the obvious place. Every layer of this app routes on a phone key, so an @lid
// reply had exactly two possible fates, and both were wrong:
//
//   - drop it (what we did): the shop answered and the traveller never saw it,
//     the agent stayed silent, and the thread looked like a ghosting shop;
//   - route on the lid's own digits: they are NOT a phone number, so the reply
//     would be filed under a number nobody owns - and in the worst case under
//     someone else's real number.
//
// The missing capability was an ALIAS: an @lid is a second name for a line we
// may already know. This module resolves the alias FROM EVIDENCE ONLY, in
// descending order of certainty, and fails CLOSED when there is none. A
// resolution is never a guess, so the privacy rule ("only chats this user's
// agent opened") survives the migration untouched.
//
// Nothing here needs a migration: a learned alias is written into the `raw`
// JSONB we already store on the inbound row, so it survives a process restart.

import { boundedSet } from "../bounded-map";
import { isPhoneJid, lidKey, waDigits } from "./phone-key";

/** How the phone behind an @lid was established - carried into traces. */
export type AliasVia = "jid" | "payload" | "memory" | "thread";

export interface ResolvedIdentity {
  /** Canonical phone key for the chat. */
  phone: string;
  via: AliasVia;
  /** The privacy identifier, when this chat is addressed by one. */
  lid: string;
}

// Payload fields Evolution/Baileys are known to carry the real phone in for a
// lid-addressed chat. Each candidate is VALIDATED before it is believed, so an
// unknown build adding a new field can never inject junk.
const PAYLOAD_PATHS = [
  ["key", "remoteJidAlt"],
  ["key", "senderPn"],
  ["key", "participantPn"],
  ["key", "previousRemoteJid"],
  ["key", "participant"],
  ["key", "participantAlt"],
  ["senderPn"],
  ["remoteJidAlt"],
  ["participant"],
  ["contextInfo", "participant"],
  ["message", "contextInfo", "participant"],
] as const;

/**
 * Digits of a candidate value that plausibly names a PHONE LINE - in ANY
 * spelling a provider build uses: a full phone JID, bare digits, or a
 * human-formatted "+63 977 662 0146". The old validator required a strict
 * JID shape, so a build writing the formatted form was thrown away and a
 * resolvable first reply was dropped as "unresolved-identity".
 *
 * PRIVACY KEYSTONE, unchanged: an @lid's own digits are NEVER a phone -
 * reading them as one is how a reply once got filed under a number nobody
 * owns. Any lid-shaped candidate is rejected outright.
 */
function candidatePhone(v: string): string {
  if (/@lid\b/i.test(v)) return "";
  if (isPhoneJid(v)) {
    const digits = waDigits(v);
    return digits.length >= 8 ? digits : "";
  }
  // Free-form spelling: keep only digits, require a plausible E.164 length.
  const digits = v.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : "";
}

function at(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * The phone JID the provider itself attached to this frame, when it did.
 * PURE - this is the whole reason an @lid chat can be resolved without a
 * network call, and it is the only branch that can learn a NEW alias.
 */
export function phoneFromPayload(data: unknown): string {
  for (const path of PAYLOAD_PATHS) {
    const v = at(data, path);
    if (typeof v !== "string" || !v) continue;
    const digits = candidatePhone(v);
    if (digits) return digits;
  }
  return "";
}

// ---- learned aliases (process memory, bounded, best-effort) ----------------

const ALIAS_CAP = 5000;

function aliasStore(): Map<string, string> {
  const g = globalThis as unknown as { __wd_wa_lid_alias__?: Map<string, string> };
  if (!g.__wd_wa_lid_alias__) g.__wd_wa_lid_alias__ = new Map();
  return g.__wd_wa_lid_alias__;
}

/** Scoped per receiving user: an alias learned in one inbox is not evidence in
 * another (two users can hold different chats behind the same opaque id). */
function aliasKey(email: string, lid: string): string {
  return `${email}|${lid}`;
}

export function rememberAlias(email: string, lid: string, phone: string): void {
  if (!email || !lid || !phone) return;
  boundedSet(aliasStore(), aliasKey(email, lid), phone, ALIAS_CAP);
}

export function aliasFromMemory(email: string, lid: string): string {
  if (!email || !lid) return "";
  return aliasStore().get(aliasKey(email, lid)) ?? "";
}

/** Test seam: drop learned aliases (each test starts from no knowledge). */
export function resetAliases(): void {
  aliasStore().clear();
}

/**
 * Resolve the chat this frame belongs to. Phone chats resolve trivially; an
 * @lid chat resolves only through evidence:
 *   1. the provider's own phone field on this frame  (learns the alias)
 *   2. an alias this process already learned
 *   3. an alias persisted on an earlier inbound row for THIS receiver
 * and otherwise not at all - the caller drops the frame with a trace rather
 * than attributing it to a number we cannot prove.
 */
export async function resolveChatIdentity(
  email: string,
  remoteJid: string,
  data: unknown
): Promise<ResolvedIdentity | "unavailable" | null> {
  if (isPhoneJid(remoteJid)) {
    const phone = waDigits(remoteJid);
    return phone ? { phone, via: "jid", lid: "" } : null;
  }

  const lid = lidKey(remoteJid);
  if (!lid) return null;

  const fromPayload = phoneFromPayload(data);
  if (fromPayload) {
    rememberAlias(email, lid, fromPayload);
    return { phone: fromPayload, via: "payload", lid };
  }

  const remembered = aliasFromMemory(email, lid);
  if (remembered) return { phone: remembered, via: "memory", lid };

  const stored = await aliasFromThreads(email, lid);
  // null = the thread store was UNREACHABLE (our outage). Do NOT guess and do
  // NOT drop - hand "unavailable" up so ingest can ask for a redelivery, the
  // same way isVendorThread's null is treated (OR11 I2.3).
  if (stored === null) return "unavailable";
  if (stored) {
    rememberAlias(email, lid, stored);
    return { phone: stored, via: "thread", lid };
  }

  return null;
}

/**
 * REVERSE lookup: the lid our own outbound anchors recorded for this shop.
 * Lets the recovery sweep pull a privacy-migrated chat under its @lid form
 * when the phone-jid pull finds nothing.
 */
export async function lidAliasForShop(email: string, digits: string): Promise<string> {
  if (!email || !digits) return "";
  const { sbSelect } = await import("../runtime-config");
  const { numberFilter } = await import("./phone-key");
  const rows = await sbSelect<{ raw: { lid?: string } | null }>(
    "whatsapp_messages",
    `select=raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      email
    )}&raw->>lid=not.is.null&order=received_at.desc&limit=1${numberFilter("to_number", digits)}`
  ).catch(() => [] as { raw: { lid?: string } | null }[]);
  return String(rows[0]?.raw?.lid ?? "");
}

/**
 * An alias persisted on an earlier thread row (`raw.lid`) for this user -
 * read from BOTH directions. The outbound side is decisive: our own send is
 * the strongest evidence there is, and it is the row that EXISTS on a fresh
 * thread. The old inbound-only read needed a PREVIOUSLY-SUCCESSFUL ingest to
 * have written the alias - a chicken-and-egg that made the FIRST reply of
 * every privacy-migrated thread unresolvable (Qui's three price messages
 * died exactly here). Scoped per user on both queries, so one user's chats
 * can never name another's. Returns "" on any failure - a missing alias is
 * a normal outcome.
 */
async function aliasFromThreads(email: string, lid: string): Promise<string | null> {
  if (!email || !lid) return "";
  const { sbSelectStrict } = await import("../runtime-config");
  // STRICT reads (OR11 I2.3). A permissive `.catch(() => [])` here made a DB
  // OUTAGE indistinguishable from "no alias on file", so an @lid shop reply -
  // whose phone can ONLY be recovered from these rows - was DROPPED on our own
  // wobble (the route answers 200, so nothing redelivers). "unavailable" now
  // propagates as null so the caller can fail loud; "missing" (no table, fresh
  // deploy) is a real empty and stays "".
  // Outbound anchor first: raw.lid is stamped at send time from the
  // provider's own key.remoteJid (see sendFromUser -> the sent-row writers).
  const outs = await sbSelectStrict<{ to_number: string }>(
    "whatsapp_messages",
    `select=to_number&direction=eq.outbound&raw->>lid=eq.${encodeURIComponent(
      lid
    )}&raw->>sender=eq.${encodeURIComponent(email)}&order=received_at.desc&limit=1`
  );
  if (!("rows" in outs)) return outs.error === "missing" ? "" : null;
  const fromOutbound = waDigits(outs.rows[0]?.to_number ?? "");
  if (fromOutbound) return fromOutbound;
  const rows = await sbSelectStrict<{ from_number: string }>(
    "whatsapp_messages",
    `select=from_number&direction=eq.inbound&raw->>lid=eq.${encodeURIComponent(
      lid
    )}&raw->>receiver=eq.${encodeURIComponent(email)}&order=received_at.desc&limit=1`
  );
  if (!("rows" in rows)) return rows.error === "missing" ? "" : null;
  return waDigits(rows.rows[0]?.from_number ?? "");
}
