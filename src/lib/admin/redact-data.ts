// THE NET UNDER THE ADMIN DATA EXPLORER (owner report 11 S1).
//
// `/api/admin/data` returned raw rows with `select=*`, so the Users table shipped
// every account's scrypt `password_hash` and precise `stay_lat`/`stay_lng`, and
// WhatsApp sessions shipped `proxy_session_id`, a live per-user proxy token, to
// the caller's browser. The primary fix is a per-table column projection so a
// credential never leaves the database; this is the second layer, applied to
// EVERY table's rows regardless of projection, so a NEW secret column added
// anywhere is withheld by default instead of leaked until someone remembers to
// update the projection. Opt-in, not opt-out - the property the admin/users
// docblock argued for.
//
// Pure (no server-only), so a test can prove the classification without a
// database, and the route stays a clean set of HTTP handlers.

/** Columns that are secrets or precise coordinates by exact name. */
export const REDACTED_EXACT = new Set(["password_hash", "stay_lat", "stay_lng", "proxy_session_id"]);

/** hash / password / secret / token / api key / any *_key column. */
export const REDACTED_PATTERN = /pass(word)?|secret|token|_?hash$|hash$|api_?key|_key$/i;

/**
 * Identifier columns the bare `_key$` alternative used to swallow:
 * `sender_key` is a traveller's email and `thread_key`/`to_key`/`slot_key`
 * are join keys - blanking them removed the PRIMARY IDENTIFIER from
 * wa_outbox, the reputation ledger and every thread-keyed row, so the
 * explorer showed rows that keyed to nothing. An explicit exception list
 * (not a narrower pattern) keeps the fail-safe direction: a NEW *_key column
 * is still withheld by default, and genuinely credential-shaped names like
 * `evolution_key` keep matching.
 */
export const KEPT_IDENTIFIERS = new Set(["sender_key", "thread_key", "to_key", "slot_key"]);

export function shouldRedact(key: string): boolean {
  if (KEPT_IDENTIFIERS.has(key)) return false;
  return REDACTED_EXACT.has(key) || REDACTED_PATTERN.test(key);
}

export function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!shouldRedact(k)) out[k] = v;
  return out;
}
