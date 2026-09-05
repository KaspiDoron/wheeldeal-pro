// THE ERASURE REGISTRY: every table that keys a person, in one place.
//
// The admin erase action used to purge FOUR tables out of the ~30 that hold a
// person's data - the route answered 200 "erased" while every WhatsApp
// transcript, thread, offer, consent row and risk event stayed behind. The
// registry exists so that "which tables hold this person" is a fact the code
// owns once: the erase walker and the DSAR export both drive off it, and a
// schema-grep test fails the build when a new user-keyed table ships without a
// registry decision (erase it, or say WHY not in EXCLUDED_TABLES).
//
// The registry has a SECOND dimension since audit F168: "which stores hold
// this person" is not only "which tables". Supabase Storage holds the audit
// copies of every inbound photo, PDF, video and voice note, and SQL cannot
// reach it - USER_OBJECT_STORES declares those buckets and how their object
// ids are found, so the walker and the export can reach them too.
//
// No Supabase import here - pure data + filter builders, so tests can walk it
// without a server context.

import { pseudonymForEmail } from "./pseudonym";

/** How a table's key column holds the person's email. */
export type KeyMatch =
  | "exact" // column equals the email
  | "prefix" // column is `${email}:...` (thread keys, inbound claim keys)
  | "pseudonym-prefix" // column is `${pseudonymForEmail(email)}:...` (de-identified provenance)
  | "pseudonym" // column equals `pseudonymForEmail(email)` (de-identified transcript rows)
  | "reset-prefix"; // column equals `reset:${email}` (password-reset rows)

export interface UserTableKey {
  table: string;
  /** PostgREST filter column - may be a jsonb path (`raw->>sender`). */
  column: string;
  match: KeyMatch;
  /**
   * For `prefix`: the character that terminates the address in the key
   * (default `:`). The login throttle writes `${email}|ip:<addr>` (F187).
   */
  separator?: string;
  /**
   * Omit this table from the DSAR export payload (still ERASED): transient
   * auth material nobody needs a copy of, or blobs that dwarf the response.
   */
  exportSkip?: boolean;
  /** Narrow the export to these columns (erase still hits the whole row). */
  exportSelect?: string;
}

/**
 * Every user-keyed table. `app_users` itself is deliberately NOT here: the
 * erase walker deletes it LAST (via deleteUser), so a partial failure leaves
 * an account that can retry its own erasure rather than an orphaned session.
 */
export const USER_TABLES: UserTableKey[] = [
  // ---- direct email columns -------------------------------------------------
  { table: "auth_events", column: "email", match: "exact" },
  { table: "consent_events", column: "email", match: "exact" },
  { table: "user_cooldowns", column: "email", match: "exact" },
  // The login brute-force lock is keyed `${email}|ip:<addr>` (so an attacker
  // only ever locks their own network path) and setCooldown stores that
  // composite verbatim in `email`. Registered as a `|`-terminated prefix
  // (F187): the exact entry above never matched it, so a row pairing the
  // address with the IP it signed in from outlived the erasure. The Google
  // lane's `ip:<addr>` rows carry no account and are left to retention.
  { table: "user_cooldowns", column: "email", match: "prefix", separator: "|" },
  { table: "wa_sessions", column: "email", match: "exact" },
  { table: "email_verifications", column: "email", match: "exact", exportSkip: true },
  { table: "email_verifications", column: "email", match: "reset-prefix", exportSkip: true },
  { table: "push_subscriptions", column: "user_email", match: "exact" },
  { table: "searches", column: "user_email", match: "exact" },
  { table: "search_sessions", column: "user_email", match: "exact" },
  { table: "bookings", column: "user_email", match: "exact" },
  { table: "offers", column: "user_email", match: "exact" },
  { table: "negotiation_threads", column: "user_email", match: "exact" },
  { table: "wa_turns", column: "user_email", match: "exact" },
  { table: "vendor_replies", column: "user_email", match: "exact" },
  { table: "bargain_drafts", column: "user_email", match: "exact" },
  { table: "game_scores", column: "user_email", match: "exact" },
  { table: "vendor_tag_signals", column: "user_email", match: "exact" },
  { table: "waba_leads", column: "user_email", match: "exact" },
  { table: "agent_reviews", column: "user_email", match: "exact" },
  { table: "agent_traces", column: "user_email", match: "exact" },
  { table: "agent_events", column: "user_email", match: "exact" },
  { table: "api_usage", column: "user_email", match: "exact" },
  { table: "graph_wakeups", column: "user_email", match: "exact" },
  { table: "product_events", column: "user_email", match: "exact" },
  // The semantic corpus sidecar. It holds a capped copy of shop reply text
  // DERIVED FROM this person's threads, so it is registered rather than
  // excused - "a vector is not personal data" is not a claim this repo is
  // willing to make. exportSelect omits `embedding` for the same reason
  // feedback_images does: 768 floats per row would dwarf the DSAR payload
  // while telling the person nothing they can read. The ERASE still deletes
  // the whole row - exportSelect narrows the export only.
  {
    table: "corpus_embeddings",
    column: "user_email",
    match: "exact",
    exportSelect: "id,source_table,source_id,embed_model,snippet,dim,created_at",
  },
  { table: "feedback", column: "reporter_email", match: "exact" },
  { table: "feedback_replies", column: "author_email", match: "exact" },
  // ---- sender_key IS the email (one WhatsApp number per account) -----------
  { table: "wa_outbox", column: "sender_key", match: "exact" },
  { table: "wa_cancellations", column: "sender_key", match: "exact" },
  { table: "wa_recipient_state", column: "sender_key", match: "exact" },
  { table: "wa_risk_events", column: "sender_key", match: "exact" },
  { table: "wa_send_claims", column: "sender_key", match: "exact" },
  { table: "whatsapp_number_reputation", column: "sender_key", match: "exact" },
  // ---- the transcripts themselves (the digest's headline omission) ---------
  { table: "whatsapp_messages", column: "raw->>sender", match: "exact" },
  { table: "whatsapp_messages", column: "raw->>receiver", match: "exact" },
  // Priced rows past the 180-day window are DE-IDENTIFIED in place by
  // retention.sql, and that used to REMOVE the two keys above - so from that
  // moment the rows were unfindable by the walker and the export, while never
  // being deleted by any window (F025). The de-identify now rewrites both keys
  // to the same address-free pseudonym the golden-case provenance and the
  // WhatsApp instance name use (`wd-` + sha256(email)[0:16], pseudonym.ts);
  // these two entries are what reach those rows. `to_number` on an inbound
  // row IS that pseudonym too (instanceNameFor) and needs no entry of its own.
  { table: "whatsapp_messages", column: "raw->>sender", match: "pseudonym" },
  { table: "whatsapp_messages", column: "raw->>receiver", match: "pseudonym" },
  // ---- thread keys shaped `${email}:${digits}` ------------------------------
  { table: "wa_thread_locks", column: "thread_key", match: "prefix" },
  { table: "agent_scores", column: "thread_key", match: "prefix" },
  // ---- inbound claim leases keyed `${email}:${wa_message_id}` (claimKey) ---
  // Excused for months as "message-id dedupe, no user data" - and the primary
  // key carries the address once per message the person ever received (F019).
  // Legacy bare-id rows carry no email and are correctly left alone.
  {
    table: "wa_processed",
    column: "wa_message_id",
    match: "prefix",
    exportSelect: "wa_message_id,created_at",
  },
  {
    table: "wa_inbound_seen",
    column: "wa_message_id",
    match: "prefix",
    exportSelect: "wa_message_id,created_at",
  },
  // ---- the golden replay suite's provenance keys (F169) ---------------------
  // The capture stamps a pseudonym (lib/ops/provenance.ts) instead of the raw
  // address, but the row STILL holds the person's RFQ and up to eight verbatim
  // shop messages from their thread - so it is registered, not excused. Two
  // entries: rows frozen before the pseudonym (raw `${email}:${digits}`) and
  // rows frozen after it (`${pseudonym}:${digits}`). retention.sql carries a
  // one-off UPDATE that rewrites the legacy keys; both entries stay so an
  // erase is complete whether or not the owner has re-run that file.
  { table: "agent_golden_cases", column: "thread_key", match: "prefix" },
  { table: "agent_golden_cases", column: "thread_key", match: "pseudonym-prefix" },
];

/**
 * Rows keyed by a PARENT row's id rather than by the email - erased (and
 * exported) by first collecting the parent ids the registry entry above finds.
 */
export interface ChildTableKey {
  table: string;
  /** Column on the child holding the parent id. */
  childColumn: string;
  /** Parent table + the id column to collect. */
  parentTable: string;
  parentIdColumn: string;
  /** The registry entry whose filter finds the parent rows. */
  parentColumn: string;
  exportSkip?: boolean;
  exportSelect?: string;
}

export const CHILD_TABLES: ChildTableKey[] = [
  {
    table: "feedback_images",
    childColumn: "feedback_id",
    parentTable: "feedback",
    parentIdColumn: "id",
    parentColumn: "reporter_email",
    // data_url is a base64 blob per row - the export lists the images, the
    // erase deletes them whole.
    exportSelect: "id,feedback_id,created_at",
  },
  {
    table: "feedback_replies",
    childColumn: "feedback_id",
    parentTable: "feedback",
    parentIdColumn: "id",
    parentColumn: "reporter_email",
  },
  {
    table: "waba_events",
    childColumn: "lead_id",
    parentTable: "waba_leads",
    parentIdColumn: "id",
    parentColumn: "user_email",
  },
];

/**
 * Object stores (Supabase Storage buckets) that hold a person's content, and
 * the table whose rows are the ONLY index from the person to the object ids.
 *
 * The walker purges these BEFORE it deletes the index rows - once the rows are
 * gone nothing can ever find the objects again - and reports each under
 * `purgedKey` in EraseResult.purged, so a failed purge is named exactly like a
 * failed table. The DSAR export lists the objects by name under the same key
 * (names only, never bytes).
 */
export interface UserObjectStore {
  /** Supabase Storage bucket name. */
  bucket: string;
  /** The `purged` / export key the walker and the export report it under. */
  purgedKey: string;
  /** The table whose rows are the only index from the person to the object ids. */
  indexTable: string;
  /** The column holding the object id (`wa_message_id` -> `wa-media/<id>.<ext>`). */
  indexIdColumn: string;
  /** The USER_TABLES entry (on indexTable) whose filter finds the person's index rows. */
  indexEntryColumn: string;
  /** Extra PostgREST filter narrowing the index rows (only inbound frames are audited). */
  indexExtraFilter: string;
  reason: string;
}

export const USER_OBJECT_STORES: UserObjectStore[] = [
  {
    bucket: "wa-media",
    purgedKey: "storage:wa-media",
    indexTable: "whatsapp_messages",
    indexIdColumn: "wa_message_id",
    indexEntryColumn: "raw->>receiver",
    indexExtraFilter: "direction=eq.inbound",
    reason:
      "audit copies of every inbound photo, PDF, video and voice note (lib/media/audit.ts). " +
      "SQL cannot reach Storage, so the walker deletes them by id BEFORE the index rows go.",
  },
];

/**
 * Tables that hold NO per-person key, with the reason on record. The
 * completeness test walks schema.sql and refuses any table that is neither
 * registered above nor excused here - a new PII table cannot ship un-erasable.
 */
export const EXCLUDED_TABLES: Record<string, string> = {
  app_users: "deleted LAST by the erase walker itself (deleteUser), never mid-walk",
  deal_memory: "de-identified by design: region/vehicle/price/tactic, no user or shop id",
  response_times: "shop-latency samples keyed by SHOP phone (hashed), no traveller key",
  vendors: "shop-side directory",
  sponsored_shops: "shop-side directory",
  market_floor_prices: "market aggregates, no user key",
  waba_agencies: "shop-side WABA partners",
  wa_suppressions: "shop-side opt-outs - deleting them on user erasure would RE-CONTACT the shop",
  agent_tactics: "owner-authored playbook content",
  agent_training: "owner-authored training snippets",
  policy_versions: "system config history",
  wa_policy_versions: "system config history",
  whatsapp_security_policies: "system config",
  app_config: "the key vault - no user rows",
  ai_usage: "provider token counters, no user key",
  api_usage_daily: "daily rollup by (day, kind), no user key",
  billing_events: "provider event-id dedupe only - payment records live with PayPal",
  wa_risk_snapshots: "fleet-level aggregates",
  email_verifications: "REGISTERED above - listed here only for the two-entry shape",
  feedback_images: "REGISTERED as a child table (via feedback_id)",
  feedback_replies: "REGISTERED above (author_email) and as a child table",
  waba_events: "REGISTERED as a child table (via lead_id)",
  whatsapp_messages: "REGISTERED above (raw->>sender and raw->>receiver)",
  graph_wakeups: "REGISTERED above (user_email)",
};

/**
 * Escape the LIKE metacharacters in a value that must match LITERALLY.
 *
 * PostgREST hands a `like.` value straight to SQL LIKE (only `*` is rewritten
 * to `%`), where `_` matches any one character and `%` any run. An underscore
 * in a local part is common; without this, one person's erase would delete
 * OTHER travellers' claim rows and thread locks. Backslash is LIKE's default
 * escape character, so it escapes itself too.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The PostgREST horizontal filter that finds this person's rows. */
export function filterFor(entry: UserTableKey, emailRaw: string): string {
  const email = emailRaw.trim().toLowerCase();
  if (entry.match === "prefix") {
    // PostgREST `like` uses * as the wildcard; the separator (`:` unless the
    // entry says otherwise) terminates the email so a@x.com never matches
    // a@x.com.evil rows. LIKE-ESCAPED (audit F022 / F019): `_`, `%` and `\`
    // are live metacharacters inside the pattern, so an unescaped
    // "a_b@x.com:%" reached "axb@x.com"'s rows - on the erase DELETE and the
    // DSAR export alike. Same escape the wakeup drain in graph/engine.ts
    // already applies for the same reason.
    const sep = escapeLike(entry.separator ?? ":");
    return `${entry.column}=like.${encodeURIComponent(`${escapeLike(email)}${sep}`)}*`;
  }
  if (entry.match === "pseudonym-prefix") {
    // The pseudonym is hex - nothing in it needs escaping.
    return `${entry.column}=like.${encodeURIComponent(`${pseudonymForEmail(email)}:`)}*`;
  }
  if (entry.match === "pseudonym") {
    return `${entry.column}=eq.${pseudonymForEmail(email)}`;
  }
  if (entry.match === "reset-prefix") {
    return `${entry.column}=eq.${encodeURIComponent(`reset:${email}`)}`;
  }
  return `${entry.column}=eq.${encodeURIComponent(email)}`;
}

/** Every table name the registry can touch (for tests and the export shape). */
export function registeredTables(): string[] {
  return Array.from(
    new Set([...USER_TABLES.map((t) => t.table), ...CHILD_TABLES.map((t) => t.table)])
  );
}
