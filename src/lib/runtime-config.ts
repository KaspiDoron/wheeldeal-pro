// Runtime configuration store.
//
// Integration secrets (LLM tokens, WhatsApp credentials) can be set two ways:
//   1. Host environment variables (process.env) - the bootstrap / source of truth.
//   2. The admin Key Vault - persisted to Supabase, encrypted at rest, and read
//      back here at request time. This is what makes "paste a key in the admin
//      panel and it takes effect" work on serverless hosts like GCP Cloud Run, where
//      per-instance memory resets and the app cannot write its own env vars.
//
// Resolution order for any key: Supabase override → process.env. Supabase reads
// are cached per-instance for a short TTL so we don't hit the DB on every call.
//
// When Supabase is not configured, overrides fall back to an in-memory map so
// the whole flow still works locally / in demo mode (non-persistent).

import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";

const CACHE_TTL_MS = 30_000;

/** How long a FAILED vault read is trusted. Short, because the outage may be
 *  brief - but non-zero, because zero is what turned a slow Supabase into a
 *  fetch storm across all 140 getConfig call sites. */
const NEGATIVE_TTL_MS = 5_000;

/**
 * AN EMERGENCY STOP THAT ARRIVES HALF A MINUTE LATE IS NOT AN EMERGENCY STOP.
 *
 * `KILL_SWITCH` read through the 30s whole-vault cache, so flipping it left
 * every warm instance sending, spending and charging for up to thirty more
 * seconds - the one moment the owner most wants everything to stop NOW. This is
 * the window for the handful of SAFETY-GATE keys instead. Deliberately not the
 * general cache TTL: this is a single-row read, not the whole vault download,
 * and it is paid only by the gates that need it.
 */
const FRESH_TTL_MS = 3_000;

/** A safety-gate read: resolved value, or the fact that it could not be read. */
type FreshEntry = { ok: boolean; value: string | undefined; exp: number };

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_cfg__:
    | {
        cache: { data: Record<string, string>; exp: number } | null;
        mem: Record<string, string>;
        /** The in-flight vault read, shared by every concurrent caller. */
        inflight: Promise<Record<string, string>> | null;
        /** Per-key short-TTL cache for the safety gates (getConfigFresh). */
        fresh: Map<string, FreshEntry>;
        /** One in-flight single-row read per key, shared by concurrent gates. */
        freshInflight: Map<string, Promise<FreshRead>>;
      }
    | undefined;
}

function state() {
  if (!globalThis.__wheeldeal_cfg__) {
    globalThis.__wheeldeal_cfg__ = {
      cache: null,
      mem: {},
      inflight: null,
      fresh: new Map(),
      freshInflight: new Map(),
    };
  }
  const s = globalThis.__wheeldeal_cfg__;
  // Older instances of this global (hot reload, or a module loaded before these
  // fields existed) will not have them.
  if (s.inflight === undefined) s.inflight = null;
  if (!s.fresh) s.fresh = new Map();
  if (!s.freshInflight) s.freshInflight = new Map();
  return s;
}

function supabase(): { url: string; key: string } | null {
  // trim(): pasted env values often carry an invisible trailing
  // newline/space, which Supabase rejects as "Invalid API key".
  const url = (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ""
  ).trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

/** Which Supabase role a JWT-style key carries ("service_role", "anon", ...). */
function jwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export interface SupabaseDiagnostics {
  configured: boolean;
  urlOk: boolean;
  keyRole: string | null; // must be "service_role"
  reachable: boolean;
  appConfigOk: boolean;
  detail: string;
}

/** Live end-to-end check of the Supabase connection, with an exact diagnosis. */
export async function supabaseDiagnostics(): Promise<SupabaseDiagnostics> {
  const conn = supabase();
  if (!conn) {
    return {
      configured: false,
      urlOk: false,
      keyRole: null,
      reachable: false,
      appConfigOk: false,
      detail:
        "SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set in the host environment (GCP Secret Manager).",
    };
  }
  const urlOk = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(conn.url);
  const keyRole = jwtRole(conn.key);
  if (keyRole && keyRole !== "service_role") {
    return {
      configured: true,
      urlOk,
      keyRole,
      reachable: false,
      appConfigOk: false,
      detail: `SUPABASE_SERVICE_ROLE_KEY currently holds the "${keyRole}" key - that is the WRONG key. In Supabase: Settings -> API -> "Project API keys" -> copy the one labelled service_role (secret), paste it into GCP Secret Manager, and redeploy.`,
    };
  }
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/app_config?select=key&limit=1`, {
      headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
      cache: "no-store",
    });
    if (res.status === 401) {
      return {
        configured: true,
        urlOk,
        keyRole,
        reachable: true,
        appConfigOk: false,
        detail:
          "Supabase says the API key is invalid (401). Re-copy the service_role key from Supabase -> Settings -> API (watch for missing characters or extra spaces), update SUPABASE_SERVICE_ROLE_KEY in GCP Secret Manager, and redeploy. If you rotated/regenerated your project's keys, the old value is dead.",
      };
    }
    if (res.status === 404) {
      return {
        configured: true,
        urlOk,
        keyRole,
        reachable: true,
        appConfigOk: false,
        detail:
          "Connected, but the app_config table is missing - run supabase/schema.sql in the Supabase SQL Editor.",
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        configured: true,
        urlOk,
        keyRole,
        reachable: true,
        appConfigOk: false,
        detail: `Supabase responded ${res.status}: ${body.slice(0, 160)}`,
      };
    }
    return {
      configured: true,
      urlOk,
      keyRole,
      reachable: true,
      appConfigOk: true,
      detail: "Connected - key vault persistence and durable accounts are working.",
    };
  } catch (e) {
    return {
      configured: true,
      urlOk,
      keyRole,
      reachable: false,
      appConfigOk: false,
      detail: `Could not reach Supabase: ${e instanceof Error ? e.message : "network error"}. Check that SUPABASE_URL is your project's https://xxxx.supabase.co URL.`,
    };
  }
}

export function supabaseConfigured(): boolean {
  return supabase() !== null;
}

/**
 * A timestamp that is safe to drop into a PostgREST filter.
 *
 * THE BUG THIS EXISTS FOR. PostgREST renders a `timestamptz` column as
 * `2026-08-11T12:00:00.123456+00:00`. That value is perfectly valid, and the
 * obvious thing to do with it - feed it straight back as the lower bound of the
 * next query - is broken, because `+` in a query string decodes to a SPACE.
 * Postgres then receives `2026-08-11T12:00:00.123456 00:00`, fails to parse it,
 * and answers 400. `sbSelect` maps 400 to `[]`, so the caller sees an empty
 * table rather than an error, and the failure is invisible.
 *
 * It bit twice, in opposite directions:
 *
 *   - `/api/deals` used the oldest kept session's `created_at` as the floor for
 *     FIVE reads (outbound, replies, offers x2, risk alerts). Every one of them
 *     400'd, so the entire Trips hub rendered 0 contacted, 0 replied, no offers
 *     and no best price for anybody who had ever run a hunt. The offers read even
 *     has a two-tier fallback, and both tiers carried the same broken filter, so
 *     the fallback could not rescue it.
 *
 *   - `/api/outreach/mass` used the newest `searches.created_at` as the floor for
 *     the per-session shop cap - the one the comment calls "backend truth, cannot
 *     be bypassed by repeat taps". A 400 there means zero shops counted as already
 *     contacted, so the cap FAILS OPEN and repeat taps can exceed it.
 *
 * A date only ever came from `new Date(...).toISOString()` before, which ends in
 * `Z` and survives being interpolated raw - which is exactly why nobody noticed
 * that raw interpolation was unsafe, and why every other call site in the repo
 * looks fine.
 *
 * Normalising through `Date` also truncates PostgREST's microseconds to
 * milliseconds. That rounds the boundary DOWN, which is the safe direction for a
 * `gte` floor (it can only include a row it already included) and for an `lte`
 * ceiling (it can only exclude the final microsecond).
 *
 * Returns the value already percent-encoded, so the call site cannot forget.
 * An unparseable input throws rather than silently producing a filter that
 * matches everything - a floor that has quietly become "the beginning of time"
 * is how a cap fails open.
 */
export function pgTimestamp(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`pgTimestamp: not a timestamp: ${String(value).slice(0, 64)}`);
  }
  return encodeURIComponent(d.toISOString());
}

/**
 * fetch with a HARD timeout. undici's fetch has no short overall request
 * timeout, so a Supabase connection that accepts but stalls would block the
 * handler until Cloud Run's request timeout - and a single guardOutbound/drain pass
 * makes a dozen serial DB round-trips, so one stall cascades into killed
 * requests across the fleet instead of degrading gracefully. On abort the call
 * throws (AbortError), which every helper's existing catch already maps to its
 * fail-safe/fail-closed value (sbSelect -> [], sbSelectStrict -> "unavailable").
 */
async function timedFetch(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  // Deliberately do NOT clearTimeout at the header boundary. fetch() resolves as
  // soon as response HEADERS arrive, but the read helpers then `await
  // res.json()`/`res.text()`, and that body read shares this AbortController.
  // Clearing the timer here would leave the body read unbounded (undici's
  // default bodyTimeout is ~300s, far past Cloud Run's request limit), so a DB
  // that streams headers then stalls mid-body would still hang the handler - and
  // on the drain path a hung handler that Cloud Run terminates LOSES an already-claimed
  // row. Keeping the deadline armed bounds headers+body together; once the body
  // is fully read the pending abort is a harmless no-op on a settled request.
  // unref() so a still-pending timer never keeps the runtime alive.
  (timer as { unref?: () => void }).unref?.();
  return fetch(url, { ...init, signal: ctrl.signal });
}

/** Read rows from a Supabase table via the service role. [] if unset. */
// ---------------------------------------------------------------------------
// THE EGRESS METER (owner report 10).
//
// Supabase's free 5 GB/month egress is the ceiling the report-8 audit ranked
// FIRST - ahead of the Evolution hosts - and the only instruction anyone ever
// wrote for it was "watch the Supabase usage graph during a hunt". That needs a
// human present at the moment traffic happens and leaves nothing behind.
//
// Every read in this app goes through `sbSelect` or `sbSelectStrict`, so the
// bytes can be counted here, once, at the one place they all pass. See
// `ops/egress` for what the number is and is not.
//
// COST DISCIPLINE. This sits on the hottest path in the system, so:
//   - counting is an addition, and `content-length` is preferred over measuring
//     the body (the header is also the WIRE size, which is what is billed);
//   - the flush is fire-and-forget and never awaited by a read;
//   - it writes at most one row per instance per flush, so 20 instances cost 20
//     rows, not one row per query.
// ---------------------------------------------------------------------------
export const EGRESS_USAGE_KIND = "sb-egress-bytes";
const EGRESS_FLUSH_BYTES = 16 * 1024 * 1024;
const EGRESS_FLUSH_MS = 15 * 60_000;

let egressBytes = 0;
let egressLastFlush = Date.now();
let egressFlushing = false;

/** Wire size where PostgREST declares it; the decoded UTF-8 length otherwise. */
function measuredBytes(res: Response, text: string): number {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 0) return declared;
  // Byte length, not string length: this app carries Thai, Lao, Khmer and
  // Myanmar text, where `.length` under-counts by up to 3x - and under-counting
  // a safety ceiling is the wrong direction to be wrong in.
  return Buffer.byteLength(text, "utf8");
}

function noteEgress(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  egressBytes += bytes;
  const now = Date.now();
  if (egressBytes < EGRESS_FLUSH_BYTES && now - egressLastFlush < EGRESS_FLUSH_MS) return;
  if (egressFlushing) return;
  egressFlushing = true;
  const flushing = egressBytes;
  egressBytes = 0;
  egressLastFlush = now;
  // Fire and forget: a read must never wait on its own telemetry, and a lost
  // flush under-reports rather than failing a request.
  void sbInsert("api_usage", [{ kind: EGRESS_USAGE_KIND, count: Math.round(flushing) }])
    .catch(() => {})
    .finally(() => {
      egressFlushing = false;
    });
}

/** Bytes measured by THIS instance and not yet flushed (diagnostics only). */
export function pendingEgressBytes(): number {
  return egressBytes;
}

export async function sbSelect<T = Record<string, unknown>>(
  table: string,
  query = "select=*&limit=50"
): Promise<T[]> {
  const conn = supabase();
  if (!conn) return [];
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${query}`, {
      headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    // text() rather than json() so the payload can be weighed on the way past.
    // Same cost - json() materialises the same string internally - and a
    // malformed body still throws into the same catch.
    const text = await res.text();
    noteEgress(measuredBytes(res, text));
    return JSON.parse(text) as T[];
  } catch {
    return [];
  }
}

/**
 * How many rows match, without transferring any of them.
 *
 * The alternative - selecting rows and taking `.length` - is bounded by a
 * `limit`, so it silently under-reports the moment the real count exceeds it.
 * That is fine for a preview and wrong for a counter. PostgREST answers the
 * exact number in `Content-Range` when asked with `count=exact`, and
 * `Range: 0-0` keeps the body to a single row.
 *
 * Returns 0 on any failure - a metric is not worth throwing over - so callers
 * that need to distinguish "none" from "could not read" must use sbSelectStrict.
 */
export async function sbCount(table: string, filter: string): Promise<number> {
  const conn = supabase();
  if (!conn) return 0;
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?select=id&${filter}`, {
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
      cache: "no-store",
    });
    if (!res.ok) return 0;
    // "0-0/1234" or "*/1234" - the total is after the slash.
    const total = res.headers.get("content-range")?.split("/")[1];
    const n = Number(total);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * EVERY WAY POSTGREST SAYS "THAT DOES NOT EXIST YET".
 *
 * Three dialects, and only the first two were ever matched:
 *   - Postgres SQLSTATE in the body: 42P01 (undefined table), 42703 (undefined
 *     column).
 *   - PGRST204 / PGRST205: PostgREST's OWN schema-cache misses, which carry no
 *     Postgres code at all because the query never reached the database.
 *   - Bare prose ("column x does not exist", "relation y does not exist") from
 *     versions that forward the message without the code.
 *
 * Exported so a test can prove all three map to "missing" rather than
 * "unavailable" - the two answers send callers in opposite directions.
 */
export function isMissingSchemaBody(body: string): boolean {
  if (!body) return false;
  return (
    body.includes("42P01") ||
    body.includes("42703") ||
    body.includes("PGRST204") ||
    body.includes("PGRST205") ||
    /does not exist/i.test(body) ||
    /schema cache/i.test(body)
  );
}

/**
 * STRICT variant of sbSelect for guard-critical reads where "empty" and
 * "unreadable" mean opposite things. sbSelect collapses every failure to []
 * which makes safety gates FAIL OPEN (a Supabase blip reads as "nothing sent
 * today / no tombstones"). This returns:
 *   { rows }                     - the read genuinely succeeded ([] = empty)
 *   { error: "missing" }         - the table/column does not exist yet (schema
 *                                  not migrated): vacuously empty, safe to
 *                                  treat as "no rows can exist"
 *   { error: "unavailable" }     - transient failure: the truth is UNKNOWN and
 *                                  callers must fail CLOSED for automated sends
 */
export async function sbSelectStrict<T = Record<string, unknown>>(
  table: string,
  query = "select=*&limit=50"
): Promise<{ rows: T[] } | { error: "missing" | "unavailable" }> {
  const conn = supabase();
  // Unconfigured (demo mode) behaves like "missing": no table, no rows.
  if (!conn) return { error: "missing" };
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${query}`, {
      headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
      cache: "no-store",
    });
    if (res.ok) {
      const text = await res.text();
      noteEgress(measuredBytes(res, text));
      return { rows: JSON.parse(text) as T[] };
    }
    // PostgREST: 404 = unknown relation; 400 + 42703/42P01 = missing column/table.
    //
    // THE CODES ARE NOT THE ONLY SHAPE. PostgREST answers a missing column from
    // its own schema cache as PGRST204 with no Postgres code at all, and several
    // versions return only the prose ("column x does not exist"). A miss here
    // degrades to "unavailable", and the two errors point callers in OPPOSITE
    // directions - "missing" means the schema has not been run and the read is
    // vacuously empty; "unavailable" means the truth is unknown and a guard must
    // fail closed. Matching only the codes made a not-yet-migrated database look
    // like a flaky one.
    if (res.status === 404) return { error: "missing" };
    if (res.status === 400) {
      const body = await res.text().catch(() => "");
      if (isMissingSchemaBody(body)) return { error: "missing" };
    }
    return { error: "unavailable" };
  } catch {
    return { error: "unavailable" };
  }
}

/**
 * THE READ FOR A SURFACE THAT REPORTS TRUTH. Rows, or `null` for "unknown".
 *
 * WHY THIS EXISTS, AND WHY THE OBVIOUS VERSION DID NOT WORK.
 *
 * Several panels tried to fail dark by writing `sbSelect(...).catch(() => null)`
 * and treating `null` as "could not read". That code has never run. `sbSelect`
 * has no rejection path at all - a missing connection, a non-2xx and a thrown
 * exception all `return []` - so the catch is unreachable and the `null` branch
 * behind it is dead. The Command Center and the Ops Analytics panel both shipped
 * that way and both still rendered a confident green over a dead database, which
 * is the exact failure their fix was written to prevent.
 *
 * The mapping here is the whole point, and the two error values are NOT
 * interchangeable:
 *
 *   { rows }                 -> the rows. `[]` is a real, trustworthy zero.
 *   { error: "missing" }     -> `[]`. The table is not migrated, so no row CAN
 *                               exist. Vacuously empty, and NOT degraded - a
 *                               fresh install must not paint itself dark.
 *   { error: "unavailable" } -> `null`. The truth is unknown. A caller that
 *                               renders this as zero is lying to its operator.
 *
 * Use this for KPIs, health tiles and alert feeds. For a SAFETY GATE - a budget,
 * a cap, a restriction check - use `sbSelectStrict` directly and branch on the
 * error, because "unknown" there must deny rather than merely display a dash.
 */
export async function sbSelectDark<T = Record<string, unknown>>(
  table: string,
  query = "select=*&limit=50"
): Promise<T[] | null> {
  const read = await sbSelectStrict<T>(table, query);
  if ("error" in read) return read.error === "missing" ? [] : null;
  return read.rows;
}

/**
 * THE COUNTER FOR A SURFACE THAT REPORTS TRUTH. A number, or `null` for
 * "unknown" - the same three-way mapping as `sbSelectDark`, applied to
 * `sbCount`.
 *
 * `sbCount` documents "returns 0 on any failure", which is right for a metric
 * nobody acts on and wrong for a health page. Every drop counter on
 * /api/admin/health read zero during an outage, so the twelve numbers that say
 * whether messages are being dropped looked their most reassuring exactly when
 * the system could not answer. The `.catch(() => 0)` those calls used to carry
 * was dead code on top of that - `sbCount` cannot reject either.
 *
 * A missing table still counts zero: no row can exist in a table that was never
 * migrated, and a fresh install must not paint its dashboard dark.
 */
export async function sbCountDark(table: string, filter: string): Promise<number | null> {
  const conn = supabase();
  if (!conn) return 0; // demo mode: no table, no rows - a real zero.
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?select=id&${filter}`, {
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 404) return 0;
      if (res.status === 400) {
        const body = await res.text().catch(() => "");
        if (isMissingSchemaBody(body)) return 0;
      }
      return null;
    }
    const total = res.headers.get("content-range")?.split("/")[1];
    const n = Number(total);
    // A 2xx whose Content-Range we cannot parse is not a zero either - it is a
    // response we did not understand.
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Insert rows into a Supabase table via the service role. No-op if unset. */
// WHEN THE OBSERVABILITY LAYER ITSELF GOES BLIND.
//
// Every telemetry write in this codebase is `.catch(() => {})` by design: a
// failed trace must never break a real turn. The cost is that a Supabase blip
// silences the panels completely, and a silent panel is indistinguishable from
// a quiet system - the owner reads "no drops today" when the truth is "nothing
// could be written today". This counts what was lost, per process, so
// /api/admin/health can say so out loud.
const TELEMETRY_TABLES = new Set(["agent_events", "agent_traces"]);
declare global {
  // eslint-disable-next-line no-var
  var __wd_lost_telemetry__: { count: number; lastAt: string | null } | undefined;
}
function noteLostTelemetryWrite(table: string): void {
  if (!TELEMETRY_TABLES.has(table)) return;
  const g = (globalThis.__wd_lost_telemetry__ ??= { count: 0, lastAt: null });
  g.count += 1;
  g.lastAt = new Date().toISOString();
}

/** How many telemetry rows this instance failed to write (and when last). */
export function lostTelemetryWrites(): { count: number; lastAt: string | null } {
  return globalThis.__wd_lost_telemetry__ ?? { count: 0, lastAt: null };
}

export async function sbInsert(
  table: string,
  rows: Record<string, unknown>[],
  onConflict?: string
): Promise<boolean> {
  const conn = supabase();
  if (!conn || rows.length === 0) return false;
  try {
    const url = onConflict
      ? `${conn.url}/rest/v1/${table}?on_conflict=${onConflict}`
      : `${conn.url}/rest/v1/${table}`;
    const res = await timedFetch(url, {
      method: "POST",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: onConflict
          ? "return=minimal,resolution=merge-duplicates"
          : "return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) noteLostTelemetryWrite(table);
    return res.ok;
  } catch {
    noteLostTelemetryWrite(table);
    return false;
  }
}

/**
 * Atomic slot claim: plain INSERT with NO conflict resolution, so a duplicate
 * primary key is a hard 409 - the one signal PostgREST gives us that another
 * concurrent invocation already owns the slot. This is the lock-free
 * serialization primitive for sends (see wa_send_claims).
 *   "won"   - this invocation owns the slot
 *   "lost"  - another invocation owns it (409 conflict)
 *   "error" - unknown (network/5xx/missing table): callers must fail CLOSED
 */
export async function sbInsertClaim(
  table: string,
  row: Record<string, unknown>
): Promise<"won" | "lost" | "error"> {
  const conn = supabase();
  if (!conn) return "error";
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify([row]),
    });
    if (res.ok) return "won";
    if (res.status === 409) return "lost";
    return "error";
  } catch {
    return "error";
  }
}

/** Insert and return the created rows (needs the id back, e.g. feedback). */
export async function sbInsertReturning<T = Record<string, unknown>>(
  table: string,
  rows: Record<string, unknown>[]
): Promise<T[]> {
  const conn = supabase();
  if (!conn || rows.length === 0) return [];
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) return [];
    return (await res.json()) as T[];
  } catch {
    return [];
  }
}

/** Delete rows matching a PostgREST filter (e.g. `id=eq.42`). */
export async function sbDelete(table: string, filter: string): Promise<boolean> {
  const conn = supabase();
  if (!conn) return false;
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${filter}`, {
      method: "DELETE",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        Prefer: "return=minimal",
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Delete rows and return the ones actually deleted (PostgREST
 * `return=representation`). This is an ATOMIC CLAIM: two concurrent callers
 * deleting the same rows each get back only the rows THEY deleted - exactly
 * one wins per row. Used to make outbox draining exactly-once.
 */
export async function sbDeleteReturning<T = Record<string, unknown>>(
  table: string,
  filter: string
): Promise<T[]> {
  const conn = supabase();
  if (!conn) return [];
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${filter}`, {
      method: "DELETE",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        Prefer: "return=representation",
      },
    });
    if (!res.ok) return [];
    return (await res.json()) as T[];
  } catch {
    return [];
  }
}

/**
 * Patch rows matching a PostgREST filter and return the ones actually updated.
 *
 * This is what makes a CONDITIONAL UPDATE usable as an atomic claim: two callers
 * patching the same row with a predicate in the filter serialize on the row
 * lock, and the loser re-evaluates the predicate against the winner's committed
 * row - so exactly one of them gets a row back. Used by the outbound lifecycle
 * to claim a queued message without deleting it (see wa/outbox-lifecycle).
 */
export async function sbUpdateReturning<T = Record<string, unknown>>(
  table: string,
  filter: string,
  values: Record<string, unknown>
): Promise<T[]> {
  const conn = supabase();
  if (!conn) return [];
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${filter}`, {
      method: "PATCH",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(values),
    });
    if (!res.ok) return [];
    return (await res.json()) as T[];
  } catch {
    return [];
  }
}

/** Patch rows matching a PostgREST filter with the given values. */
/**
 * Call a Postgres function through PostgREST.
 *
 * `false` on every failure, exactly like sbUpdate, so a caller that treats an
 * RPC as best-effort keeps behaving that way - and a caller that must fail
 * closed can see the false and say so.
 *
 * A MISSING FUNCTION IS DISTINGUISHABLE. PostgREST answers 404 for a function
 * that has not been created yet, which is the state of any database where the
 * owner has not re-run schema.sql. Reporting that separately lets a caller fall
 * back to the old path instead of silently dropping the write - the difference
 * between "not migrated yet" and "the database is down".
 */
export async function sbRpc(
  fn: string,
  args: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; missing: boolean }> {
  const conn = supabase();
  if (!conn) return { ok: false, missing: false };
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(args),
    });
    if (res.ok) return { ok: true };
    return { ok: false, missing: res.status === 404 };
  } catch {
    return { ok: false, missing: false };
  }
}

export async function sbUpdate(
  table: string,
  filter: string,
  values: Record<string, unknown>
): Promise<boolean> {
  const conn = supabase();
  if (!conn) return false;
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${filter}`, {
      method: "PATCH",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(values),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- encryption (AES-256-GCM, key derived from SESSION_SECRET) --------------

// A 71-MILLISECOND SYNCHRONOUS BLOCK, ONCE PER ROW, ON EVERY VAULT READ.
//
// scryptSync is deliberately expensive - that is the point of a KDF - and it is
// SYNCHRONOUS, so it does not merely take time, it blocks the entire Node event
// loop. This function was called once per row inside decrypt(), and
// loadOverrides() decrypts the whole table, so a single vault read cost
// (rows x 71ms) of dead server. With ~19 concurrent misses on a cold /profile
// that measured around 27 seconds during which NO route could be answered.
//
// The derivation is a pure function of the secret, and the secret set is
// bounded and tiny (SESSION_SECRET + SESSION_SECRET_PREVIOUS). Memoizing it is
// therefore both safe and complete: the cache can never grow beyond the number
// of secrets the operator has configured, and it removes the scrypt from
// encrypt() and from encryptString/decryptString on the signup path too.
const KEY_CACHE = new Map<string, Buffer>();

function cryptoKeyFrom(secret: string): Buffer {
  const s = secret || "dev-insecure-secret-change-me";
  let k = KEY_CACHE.get(s);
  if (!k) {
    k = scryptSync(s, "wheeldeal-config-v1", 32);
    KEY_CACHE.set(s, k);
  }
  return k;
}

/** Test seam - the memo is a module singleton. */
export function _resetKeyCache(): void {
  KEY_CACHE.clear();
}

const INSECURE_SECRET = "dev-insecure-secret-change-me";

// The CURRENT secret - new writes (encrypt) always use this one.
//
// PRODUCTION STRENGTH GUARD (mirrors session.ts's cookie-signing guard). A
// deploy with SESSION_SECRET missing or weak would ENCRYPT the whole Key Vault
// AND the pending-signup blobs (which hold plaintext passwords) under a key
// derived from a constant published in this repo - trivially decryptable by
// anyone with the source. The cookie layer already refuses to sign in that
// state (the app is locked until the secret is set), so refusing to encrypt is
// consistent: we never write recoverable-by-anyone ciphertext. Decryption
// (cryptoKeyFrom) stays lenient so existing rows can still be read.
function cryptoKey(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && !(s && s.length >= 16 && s !== INSECURE_SECRET)) {
    throw new Error(
      "SESSION_SECRET must be set to a strong value (>= 16 chars) in production before secrets can be encrypted."
    );
  }
  return cryptoKeyFrom(s || INSECURE_SECRET);
}

// Secrets to TRY when DECRYPTING, newest first. This is the graceful-recovery
// path for a rotated SESSION_SECRET (e.g. a host migration): the
// vault is AES-encrypted with a key derived from SESSION_SECRET, so a changed
// secret makes every stored key undecryptable and the whole vault reads empty.
// Set SESSION_SECRET_PREVIOUS to the OLD secret (comma-separated for several) and
// old rows decrypt again immediately - WITHOUT reverting the new secret. Any key
// re-saved afterwards is re-encrypted under the current secret, so the vault
// migrates itself over time. Unset -> only the current secret is tried (no
// behavior change).
function decryptSecrets(): string[] {
  const cur = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
  const prev = (process.env.SESSION_SECRET_PREVIOUS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [cur, ...prev];
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString(
    "base64"
  )}`;
}

/** AES-256-GCM encrypt an arbitrary string (used for transient signup payloads). */
export function encryptString(plain: string): string {
  return encrypt(plain);
}
/** Decrypt a string produced by encryptString. Returns null on tamper/failure. */
export function decryptString(blob: string): string | null {
  return decrypt(blob);
}

function decrypt(blob: string): string | null {
  const [v, ivB, tagB, dataB] = blob.split(":");
  if (v !== "v1") return null;
  // Try the current secret first, then any SESSION_SECRET_PREVIOUS (rotation
  // recovery). Each attempt is isolated: a wrong key throws on final()/auth-tag
  // check, so we fall through to the next secret rather than failing the row.
  for (const secret of decryptSecrets()) {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        cryptoKeyFrom(secret),
        Buffer.from(ivB, "base64")
      );
      decipher.setAuthTag(Buffer.from(tagB, "base64"));
      return (
        decipher.update(Buffer.from(dataB, "base64")).toString("utf8") +
        decipher.final("utf8")
      );
    } catch {
      /* wrong secret for this blob - try the next one */
    }
  }
  return null;
}

// ---- Supabase REST ----------------------------------------------------------

/**
 * THE VAULT IS NOT THE ONLY THING IN THIS TABLE.
 *
 * `/api/translate` caches its dictionaries into `app_config` under `I18N_<lang>`
 * via setConfig, which AES-encrypts them. This read had no key filter, so every
 * cold start downloaded and decrypted THE ENTIRE TRANSLATION CORPUS FOR ALL 20
 * LANGUAGES before it could answer "what is OPERATOR_NAME".
 *
 * That made the cold-start cost a monotonically increasing function of how much
 * text the app had ever translated - permanently, for everyone. And it had a
 * terminal state: once the corpus exceeded what transfers inside timedFetch's 8s
 * deadline, this threw, the catch returned {}, and getConfig silently fell
 * through to process.env for every key - where most of them are not declared.
 * The app would lose every integration key with no error anywhere.
 *
 * PostgREST `not.like` keeps the big rows server-side. They are still readable
 * by their own reader, which asks for them by exact key.
 */
const VAULT_SELECT = "select=key,value&key=not.like.I18N_*";

/**
 * WAS THE LAST VAULT READ REAL?
 *
 * loadOverrides swallows every failure and returns {} (now a short-lived
 * negative cache). That is right for the 140 call sites that want a value or a
 * default - and catastrophic for the handful that are SAFETY GATES, because
 * "the key is absent" and "I could not read the table" arrive as the same empty
 * object. `KILL_SWITCH` reads OFF during a Supabase brownout for exactly that
 * reason. This records which of the two actually happened.
 *
 * "unconfigured" is deliberately distinct from "unavailable": with no Supabase
 * connection at all the app is in env-only/demo mode, which is a supported
 * state and must not trip a fail-closed branch.
 */
type VaultReadState = "ok" | "unconfigured" | "unavailable";
let lastVaultRead: VaultReadState = "unconfigured";

export function vaultReadState(): VaultReadState {
  return lastVaultRead;
}

async function loadOverrides(): Promise<Record<string, string>> {
  const s = state();
  const conn = supabase();
  if (!conn) {
    lastVaultRead = "unconfigured";
    return s.mem;
  }

  if (s.cache && s.cache.exp > Date.now()) return { ...s.cache.data, ...s.mem };

  // ONE FETCH FOR N CONCURRENT CALLERS.
  //
  // The cache was only consulted before the await and only written after it, so
  // every caller that arrived during an in-flight read missed and started its
  // own - each paying the full download + decrypt. getSession() calls getConfig,
  // and every route calls getSession(), so a cold instance fanned this out
  // across every request in the burst. Sharing the pending promise collapses
  // that back to one.
  if (s.inflight) return s.inflight;
  const run = (async () => {
    try {
      return await fetchOverrides(conn, s);
    } finally {
      s.inflight = null;
    }
  })();
  s.inflight = run;
  return run;
}

async function fetchOverrides(
  conn: { url: string; key: string },
  s: ReturnType<typeof state>
): Promise<Record<string, string>> {
  try {
    const res = await timedFetch(
      `${conn.url}/rest/v1/app_config?${VAULT_SELECT}`,
      {
        headers: {
          apikey: conn.key,
          Authorization: `Bearer ${conn.key}`,
        },
        cache: "no-store",
      }
    );
    if (!res.ok) throw new Error(`supabase ${res.status}`);
    const rows = (await res.json()) as { key: string; value: string }[];
    const data: Record<string, string> = {};
    let undecryptable = 0;
    for (const row of rows) {
      const plain = decrypt(row.value);
      if (plain) data[row.key] = plain;
      // A ROW THAT WILL NOT DECRYPT IS A KEY THE APP HAS SILENTLY LOST.
      //
      // SESSION_SECRET is BOTH the cookie signing key and the vault encryption
      // key, so rotating it makes every stored key undecryptable. That was
      // handled by dropping the row with no counter, no log and no diagnostic:
      // the owner saw a working app with every integration blank and nothing
      // anywhere saying why. Count it, so the health surface can say
      // "N of M keys failed to decrypt - set SESSION_SECRET_PREVIOUS".
      else undecryptable += 1;
    }
    lastUndecryptable = { count: undecryptable, of: rows.length, at: Date.now() };
    if (undecryptable > 0) {
      console.error(
        `[vault] ${undecryptable}/${rows.length} rows failed to decrypt - SESSION_SECRET was probably rotated. Set SESSION_SECRET_PREVIOUS to the old value.`
      );
    }
    s.cache = { data, exp: Date.now() + CACHE_TTL_MS };
    lastVaultRead = "ok";
    // In-memory overrides (e.g. saved while Supabase was unreachable) win.
    return { ...data, ...s.mem };
  } catch {
    // NEGATIVE CACHING: A SLOW SUPABASE MUST NOT BECOME A FETCH STORM.
    //
    // The cache was written only on the success path, so while Supabase was
    // unhealthy there was effectively NO cache: all 140 getConfig call sites
    // issued a fresh request with an 8s abort, on every call, for as long as
    // the outage lasted. Caching the (possibly empty) fallback for a short
    // window turns an unbounded amplification into one retry per window.
    const fallback = s.cache?.data ?? {};
    s.cache = { data: fallback, exp: Date.now() + NEGATIVE_TTL_MS };
    lastVaultRead = "unavailable";
    return { ...fallback, ...s.mem };
  }
}

/** How many vault rows could not be decrypted on the last successful read.
 *  Surfaced by the health route so a rotated secret is visible, not silent. */
let lastUndecryptable: { count: number; of: number; at: number } | null = null;

export function vaultDecryptHealth(): { count: number; of: number; at: number } | null {
  return lastUndecryptable;
}

/** Effective value for a key: Supabase override first, then process.env. */
export async function getConfig(name: string): Promise<string | undefined> {
  const overrides = await loadOverrides();
  return overrides[name] ?? process.env[name];
}

/**
 * THE EXACT-KEY READER THE VAULT COMMENT PROMISED - I-6a.
 *
 * `VAULT_SELECT` filters `key=not.like.I18N_*` so the huge translation
 * dictionaries never ride the whole-table vault read (they would make cold
 * start a monotonically growing cost for every key lookup). The comment beside
 * it claimed those rows were "still readable by their own reader, which asks
 * for them by exact key" - but that reader was never written, and the translate
 * route read the cache with plain `getConfig`, which goes through the SAME
 * filtered load and therefore returned undefined every time.
 *
 * The consequence was a live LLM cost leak: every cold load in a non-English
 * language re-translated the ENTIRE catalogue and wrote back a row that nothing
 * could ever read, so the next cold load did it again. This is the reader that
 * closes the loop - one row, by exact key, decrypted the same way the vault
 * decrypts everything else.
 *
 * It deliberately does NOT touch the loadOverrides cache: these rows are large
 * and read rarely (once per language per cold load), so caching them is exactly
 * what the exclusion filter exists to prevent.
 */
export async function getConfigExact(name: string): Promise<string | undefined> {
  const s = state();
  // A value written this session (Supabase unreachable) is plaintext in mem.
  if (s.mem[name]) return s.mem[name];
  const conn = supabase();
  if (!conn) return process.env[name];
  try {
    const res = await timedFetch(
      `${conn.url}/rest/v1/app_config?select=value&key=eq.${encodeURIComponent(name)}&limit=1`,
      {
        headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
        cache: "no-store",
      }
    );
    if (!res.ok) return process.env[name];
    const rows = (await res.json()) as { value: string }[];
    const raw = rows[0]?.value;
    if (raw === undefined) return process.env[name];
    // setConfig always encrypts, so decrypt first; fall back to the raw value
    // for any legacy plaintext row, mirroring how fetchOverrides treats rows.
    return decrypt(raw) ?? raw;
  } catch {
    return process.env[name];
  }
}

/**
 * STRICT variant of getConfig for SAFETY GATES, where "not set" and "could not
 * be read" must lead to opposite decisions.
 *
 * getConfig cannot tell them apart: a brownout makes loadOverrides return {},
 * and if the key is not in process.env either (KILL_SWITCH is not in the deploy
 * env list) the caller sees `undefined` and concludes the switch is off. The
 * kill switch turning ITSELF off during a dependency wobble is the single worst
 * failure mode in this file.
 *
 * A value found in process.env is still authoritative during an outage - the
 * environment does not go unreadable - so only a genuine miss escalates.
 */
export async function getConfigStrict(
  name: string
): Promise<{ value: string | undefined } | { error: "unavailable" }> {
  const overrides = await loadOverrides();
  const hit = overrides[name] ?? process.env[name];
  if (hit !== undefined) return { value: hit };
  if (vaultReadState() === "unavailable") return { error: "unavailable" };
  return { value: undefined };
}

type FreshRead = { value: string | undefined } | { error: "unavailable" };

/**
 * STRICT, AND FRESH WITHIN SECONDS - for the safety gates only.
 *
 * `getConfigStrict` has the right error semantics but reads through the 30s
 * whole-vault cache, so `KILL_SWITCH` took up to thirty seconds to reach a warm
 * instance. During an incident that is thirty more seconds of sends, spend and
 * charges after the owner has already pulled the handle.
 *
 * This reads the ONE row by exact key - a tiny query next to the whole-table
 * download the general cache exists to avoid - and caches it for
 * FRESH_TTL_MS. Bounded cost regardless of traffic: one small query per key per
 * 3s per instance, no matter how many sends are in flight, because concurrent
 * callers share the in-flight promise.
 *
 * ERROR SEMANTICS ARE getConfigStrict'S, UNCHANGED, and they matter more than
 * the freshness:
 *   - a value in `mem` (saved this session while Supabase was unreachable) wins;
 *   - with no Supabase connection at all the app is in env-only/demo mode, which
 *     is supported and must NOT trip a fail-closed branch;
 *   - `process.env` stays authoritative during an outage - the environment does
 *     not go unreadable;
 *   - only a genuine unreadable-with-no-env-fallback escalates to `unavailable`,
 *     and that is cached for the short negative window so an outage cannot turn
 *     every send into a fresh query.
 */
export async function getConfigFresh(name: string): Promise<FreshRead> {
  const s = state();
  if (s.mem[name] !== undefined) return { value: s.mem[name] };
  const conn = supabase();
  if (!conn) return { value: process.env[name] };

  const hit = s.fresh.get(name);
  if (hit && hit.exp > Date.now()) {
    return hit.ok ? { value: hit.value } : { error: "unavailable" };
  }
  const pending = s.freshInflight.get(name);
  if (pending) return pending;

  const run = (async (): Promise<FreshRead> => {
    let entry: FreshEntry;
    try {
      const res = await timedFetch(
        `${conn.url}/rest/v1/app_config?select=value&key=eq.${encodeURIComponent(name)}&limit=1`,
        {
          headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
          cache: "no-store",
        }
      );
      if (!res.ok) throw new Error(`supabase ${res.status}`);
      const rows = (await res.json()) as { value: string }[];
      const raw = rows[0]?.value;
      // setConfig always encrypts; fall back to the raw value for any legacy
      // plaintext row, mirroring how fetchOverrides treats rows.
      const stored = raw === undefined ? undefined : (decrypt(raw) ?? raw);
      entry = {
        ok: true,
        value: stored ?? process.env[name],
        exp: Date.now() + FRESH_TTL_MS,
      };
    } catch {
      const env = process.env[name];
      entry =
        env !== undefined
          ? { ok: true, value: env, exp: Date.now() + FRESH_TTL_MS }
          : { ok: false, value: undefined, exp: Date.now() + NEGATIVE_TTL_MS };
    }
    s.fresh.set(name, entry);
    return entry.ok ? { value: entry.value } : { error: "unavailable" };
  })().finally(() => {
    s.freshInflight.delete(name);
  });
  s.freshInflight.set(name, run);
  return run;
}

/**
 * MANY KEYS, ONE VAULT READ.
 *
 * `Promise.all(names.map(getConfig))` looks equivalent and is not: before the
 * in-flight dedupe above, revealKeys() fanned 52 keys into 52 simultaneous
 * full-table downloads, and /api/config/public did the same with 6. The dedupe
 * fixes the worst of that, but this makes the intent explicit at the call site
 * and is correct regardless of how the cache is behaving.
 */
export async function getConfigMany(
  names: readonly string[]
): Promise<Record<string, string | undefined>> {
  const overrides = await loadOverrides();
  const out: Record<string, string | undefined> = {};
  for (const n of names) out[n] = overrides[n] ?? process.env[n];
  return out;
}

/**
 * Resolve the Google OAuth client ID with a resilient, multi-source fallback so
 * Google sign-in survives a vault miss (a decryption failure when SESSION_SECRET
 * differs between hosts, an unreachable Supabase, or the value simply never
 * pasted into the Key Vault). getConfig already fails over from the vault to
 * `process.env.GOOGLE_OAUTH_CLIENT_ID`; this adds the alternate PUBLIC env name
 * that the build inlines (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`), which is the name the
 * client ID is usually provided under on a fresh Cloud Run deploy. The
 * client ID is public by design, so surfacing it from any of these sources is
 * safe - it only ever gates which account the button signs in as. `||` (not
 * `??`) also skips an empty-string stored value, not just a null one.
 */
export async function getGoogleClientId(): Promise<string | undefined> {
  return (
    (await getConfig("GOOGLE_OAUTH_CLIENT_ID")) ||
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
    undefined
  );
}

/**
 * Persist (or clear) a runtime override. Returns a clear error message when
 * durable persistence fails, so the admin UI never fails silently.
 */
export async function setConfig(
  name: string,
  value: string
): Promise<{ ok: boolean; persistent: boolean; error?: string }> {
  const s = state();
  const conn = supabase();

  if (!conn) {
    if (value) s.mem[name] = value;
    else delete s.mem[name];
    s.cache = null;
    // The safety gates read per-key; drop those too so the instance that
    // FLIPPED the switch is not the last one to notice.
    s.fresh.clear();
    return {
      ok: true,
      persistent: false,
      error:
        "Saved for this session only: Supabase is not connected (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in GCP Secret Manager), so the value will reset on the next deploy/restart.",
    };
  }

  try {
    let res: Response;
    if (value) {
      res = await timedFetch(`${conn.url}/rest/v1/app_config?on_conflict=key`, {
        method: "POST",
        headers: {
          apikey: conn.key,
          Authorization: `Bearer ${conn.key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal,resolution=merge-duplicates",
        },
        body: JSON.stringify([
          { key: name, value: encrypt(value), updated_at: new Date().toISOString() },
        ]),
      });
    } else {
      res = await timedFetch(
        `${conn.url}/rest/v1/app_config?key=eq.${encodeURIComponent(name)}`,
        {
          method: "DELETE",
          headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
        }
      );
    }
    s.cache = null;
    // The safety gates read per-key; drop those too so the instance that
    // FLIPPED the switch is not the last one to notice.
    s.fresh.clear();
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const hint =
        res.status === 401
          ? "Invalid Supabase key: SUPABASE_SERVICE_ROLE_KEY in GCP Secret Manager is wrong (it may be the anon key, have a typo, or the project keys were rotated). Copy the service_role key from Supabase -> Settings -> API, update GCP Secret Manager, redeploy, then use Admin -> Keys -> Test Supabase."
          : /relation .*app_config.* does not exist|404/.test(detail + res.status)
          ? "The app_config table is missing - run supabase/schema.sql in the Supabase SQL Editor."
          : detail.slice(0, 180);
      // Keep an in-memory copy so it at least works right now.
      if (value) s.mem[name] = value;
      return { ok: false, persistent: false, error: `Could not save to Supabase (${res.status}). ${hint}` };
    }
    // A DURABLE SAVE SUPERSEDES ANY EARLIER IN-MEMORY PIN. `s.mem` wins over the
    // vault cache and the fresh per-key read, and a PRIOR failed save left the
    // old value pinned here. Without this delete, a later successful save was
    // invisible on this instance forever - including a KILL_SWITCH flip stuck at
    // its old value after one transient write error. Clear it so the value we
    // just persisted is the one that is read back.
    delete s.mem[name];
    return { ok: true, persistent: true };
  } catch (e) {
    if (value) s.mem[name] = value;
    s.cache = null;
    // The safety gates read per-key; drop those too so the instance that
    // FLIPPED the switch is not the last one to notice.
    s.fresh.clear();
    return {
      ok: false,
      persistent: false,
      error: `Could not reach Supabase: ${e instanceof Error ? e.message : "network error"}`,
    };
  }
}
