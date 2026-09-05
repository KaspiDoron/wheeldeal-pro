// WHICH INBOUND DROPS MAY NOT NAME THE NUMBER (audit F173).
//
// `inbound-dropped` breadcrumbs are addressed (to_number + detail.digits) so
// the message-path panel and the WA doctor can find a shop thread's trail.
// But the privacy gate fires on chats that are NOT a shop thread the traveller
// opened - their partner, their friends, a group - and its breadcrumb was
// writing the third party's bare phone number into the app's own store, one
// durable row per personal contact, for the 90-day agent_events window. The
// ingest comment says "never stored, never read"; the Privacy Policy promises
// the same. So for the reasons below the writer stores NO number: an 8-hex
// hash of the spelling-normalised number stands in, stable across instances,
// so the doctor can still ask "was THIS shop refused?" by hashing the number
// it is asked about, and the per-reason counters and distinct-chat magnitude
// survive unchanged.
//
// Pure (node crypto only) so the writer, the doctor and the tests share one
// definition without a server context.

import { createHash } from "node:crypto";
import { identityKey } from "./phone-key";

/**
 * Drop reasons raised BEFORE a thread is known to be the traveller's own shop
 * thread. Their breadcrumb must not carry the chat's number.
 */
export const PRIVACY_DROP_REASONS: ReadonlySet<string> = new Set([
  "vendor-gate", // not a shop thread this traveller opened - the feature working
  "vendor-gate-unavailable", // the gate could not be read; the chat is still unknown
  "non-chat-jid", // a group / broadcast / status post
  "receiver-unresolvable", // no inbox resolved - nobody's thread yet
  "identity-unavailable", // an @lid chat whose identity could not be read
  "unresolved-identity", // an @lid chat with no known phone identity
]);

/**
 * A short, stable, non-reversible stand-in for a number in a privacy drop:
 * sha256 of the spelling-normalised key (so a national and an international
 * spelling agree), first 8 hex chars - enough for the doctor to match, far too
 * few to enumerate back to a phone number.
 */
export function dropDigitsHash(digits: string | null | undefined): string {
  const key = identityKey(digits) || String(digits ?? "").trim();
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}
