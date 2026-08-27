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

export function shouldRedact(key: string): boolean {
  return REDACTED_EXACT.has(key) || REDACTED_PATTERN.test(key);
}

export function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!shouldRedact(k)) out[k] = v;
  return out;
}
