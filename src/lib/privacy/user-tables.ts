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
// No Supabase import here - pure data + filter builders, so tests can walk it
// without a server context.

/** How a table's key column holds the person's email. */
export type KeyMatch =
  | "exact" // column equals the email
  | "prefix" // column is `${email}:...` (thread keys)
  | "reset-prefix"; // column equals `reset:${email}` (password-reset rows)

export interface UserTableKey {
  table: string;
  /** PostgREST filter column - may be a jsonb path (`raw->>sender`). */
  column: string;
  match: KeyMatch;
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
  // ---- thread keys shaped `${email}:${digits}` ------------------------------
  { table: "wa_thread_locks", column: "thread_key", match: "prefix" },
  { table: "agent_scores", column: "thread_key", match: "prefix" },
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
  agent_golden_cases: "owner-curated replay suite (de-identified at capture)",
  agent_tactics: "owner-authored playbook content",
  agent_training: "owner-authored training snippets",
  policy_versions: "system config history",
  wa_policy_versions: "system config history",
  whatsapp_security_policies: "system config",
  app_config: "the key vault - no user rows",
  ai_usage: "provider token counters, no user key",
  api_usage_daily: "daily rollup by (day, kind), no user key",
  billing_events: "provider event-id dedupe only - payment records live with PayPal",
  wa_processed: "message-id dedupe, no user data",
  wa_inbound_seen: "message-id dedupe, no user data",
  wa_risk_snapshots: "fleet-level aggregates",
  email_verifications: "REGISTERED above - listed here only for the two-entry shape",
  feedback_images: "REGISTERED as a child table (via feedback_id)",
  feedback_replies: "REGISTERED above (author_email) and as a child table",
  waba_events: "REGISTERED as a child table (via lead_id)",
  whatsapp_messages: "REGISTERED above (raw->>sender and raw->>receiver)",
  graph_wakeups: "REGISTERED above (user_email)",
};

/** The PostgREST horizontal filter that finds this person's rows. */
export function filterFor(entry: UserTableKey, emailRaw: string): string {
  const email = emailRaw.trim().toLowerCase();
  if (entry.match === "prefix") {
    // PostgREST `like` uses * as the wildcard; the colon terminates the email
    // so a@x.com never matches a@x.com.evil rows.
    return `${entry.column}=like.${encodeURIComponent(`${email}:`)}*`;
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
