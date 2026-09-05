// A Map-backed PostgREST stand-in for EXECUTED tests (audit group G2).
//
// The reply-lane suite (src/lib/wa/reply-lane-executed.test.ts) proved that a
// mock which answers `[]` to every read cannot see a defect whose whole shape
// is "the read answered the wrong rows". This helper evaluates the real
// PostgREST query strings the code builds - `col=eq.v`, `col=like.v*`,
// `col=in.(a,b)`, `or=(...)`, jsonb paths such as `raw->>sender`, `order`,
// `limit`, `offset` - over rows a test seeded, so the subject under test runs
// against something that behaves like the store rather than a stub that
// agrees with everything.
//
// Not a test file itself (the name carries no `.test.` segment, so vitest does
// not collect it); every consumer wires it in through
// `vi.mock("../runtime-config", ...)` with `runtimeConfigMock()`.

export type Row = Record<string, unknown>;

/** Primary keys the claim/upsert helpers conflict on (PostgREST 409 / merge). */
const PRIMARY_KEYS: Record<string, string[]> = {
  app_users: ["email"],
  wa_processed: ["wa_message_id"],
  wa_inbound_seen: ["wa_message_id"],
  wa_send_claims: ["sender_key", "slot_key"],
  wa_thread_locks: ["thread_key"],
  user_cooldowns: ["email", "kind"],
  wa_sessions: ["email"],
  whatsapp_number_reputation: ["sender_key"],
};

interface Clause {
  column: string;
  op: string;
  value: string;
}

/** Resolve a column reference, including jsonb paths (`raw->>sender`, `raw->media->>key`). */
function readColumn(row: Row, column: string): unknown {
  const parts = column.split(/(->>|->)/);
  let cur: unknown = row[parts[0]];
  for (let i = 1; i < parts.length; i += 2) {
    const arrow = parts[i];
    const key = parts[i + 1];
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Row)[key];
    if (arrow === "->>" && cur !== null && cur !== undefined && typeof cur === "object") {
      cur = JSON.stringify(cur);
    }
  }
  return cur;
}

/** SQL LIKE with PostgREST's `*` wildcard and `\` as the escape character. */
function likeToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      out += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    } else if (c === "*" || c === "%") {
      out += "[\\s\\S]*";
    } else if (c === "_") {
      out += "[\\s\\S]";
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    if (!quoted) {
      if (c === "(") depth += 1;
      if (c === ")") depth -= 1;
      if (c === sep && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

function parseInList(value: string): string[] {
  const inner = value.replace(/^\(/, "").replace(/\)$/, "");
  return splitTopLevel(inner, ",").map((v) => {
    const t = v.trim();
    const unquoted = t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
    try {
      return decodeURIComponent(unquoted);
    } catch {
      return unquoted;
    }
  });
}

/** `col.op.value` (an or-clause) or `col` + `op.value` (a plain filter). */
function parseOpValue(column: string, rest: string): Clause {
  let op: string;
  let value: string;
  const dot = rest.indexOf(".");
  if (dot === -1) return { column, op: rest, value: "" };
  op = rest.slice(0, dot);
  value = rest.slice(dot + 1);
  if (op === "not") {
    const dot2 = value.indexOf(".");
    op = `not.${dot2 === -1 ? value : value.slice(0, dot2)}`;
    value = dot2 === -1 ? "" : value.slice(dot2 + 1);
  }
  return { column, op, value };
}

function parseOrClause(clause: string): Clause {
  const dot = clause.indexOf(".");
  return parseOpValue(clause.slice(0, dot), clause.slice(dot + 1));
}

function compare(a: unknown, b: string): number {
  if (typeof a === "number") return a - Number(b);
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
}

function clauseMatches(row: Row, c: Clause): boolean {
  const actual = readColumn(row, c.column);
  const isNull = actual === null || actual === undefined;
  switch (c.op) {
    case "eq":
      return !isNull && String(actual) === c.value;
    case "neq":
    case "not.eq":
      return isNull || String(actual) !== c.value;
    case "is":
      return c.value === "null" ? isNull : String(actual) === c.value;
    case "not.is":
      return c.value === "null" ? !isNull : String(actual) !== c.value;
    case "like":
      return !isNull && likeToRegex(c.value).test(String(actual));
    case "ilike":
      return !isNull && new RegExp(likeToRegex(c.value).source, "i").test(String(actual));
    case "not.like":
      return isNull || !likeToRegex(c.value).test(String(actual));
    case "in":
      return !isNull && parseInList(c.value).includes(String(actual));
    case "not.in":
      return isNull || !parseInList(c.value).includes(String(actual));
    case "gt":
      return !isNull && compare(actual, c.value) > 0;
    case "gte":
      return !isNull && compare(actual, c.value) >= 0;
    case "lt":
      return !isNull && compare(actual, c.value) < 0;
    case "lte":
      return !isNull && compare(actual, c.value) <= 0;
    default:
      throw new Error(`fake postgrest: unsupported operator "${c.op}" on ${c.column}`);
  }
}

interface ParsedQuery {
  clauses: Clause[];
  ors: Clause[][];
  order: { column: string; desc: boolean }[];
  limit: number | null;
  offset: number;
  select: string[] | null;
}

function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { clauses: [], ors: [], order: [], limit: null, offset: 0, select: null };
  for (const part of splitTopLevel(query, "&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? "" : part.slice(eq + 1);
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      /* keep raw */
    }
    if (key === "select") {
      parsed.select = value === "*" ? null : value.split(",").map((s) => s.trim());
    } else if (key === "order") {
      for (const o of value.split(",")) {
        const [column, dir] = o.split(".");
        parsed.order.push({ column, desc: dir === "desc" });
      }
    } else if (key === "limit") {
      parsed.limit = Number(value);
    } else if (key === "offset") {
      parsed.offset = Number(value);
    } else if (key === "or") {
      const inner = value.replace(/^\(/, "").replace(/\)$/, "");
      parsed.ors.push(splitTopLevel(inner, ",").map(parseOrClause));
    } else if (key === "on_conflict") {
      /* handled by the insert path */
    } else {
      parsed.clauses.push(parseOpValue(key, value));
    }
  }
  return parsed;
}

function rowMatches(row: Row, q: ParsedQuery): boolean {
  if (!q.clauses.every((c) => clauseMatches(row, c))) return false;
  return q.ors.every((group) => group.some((c) => clauseMatches(row, c)));
}

export interface WriteLog {
  op: "insert" | "claim" | "delete" | "update";
  table: string;
  query?: string;
  rows?: Row[];
  patch?: Row;
}

export class FakePostgrest {
  tables = new Map<string, Row[]>();
  /** Tables whose reads answer "unavailable" (5xx / timeout) and whose writes fail. */
  unavailable = new Set<string>();
  /** Tables that do not exist on this database (PostgREST 404). */
  missing = new Set<string>();
  /** Tables whose DELETE / INSERT / UPDATE fail while reads still work. */
  failWrites = new Set<string>();
  /** Key Vault values for getConfig and friends. */
  config = new Map<string, string>();
  /** Whether supabase() reports a connection (false = demo mode). */
  configured = true;
  /** Every write the subject issued, in order. */
  log: WriteLog[] = [];

  reset(): void {
    this.tables = new Map();
    this.unavailable = new Set();
    this.missing = new Set();
    this.failWrites = new Set();
    this.config = new Map();
    this.configured = true;
    this.log = [];
  }

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table) as Row[];
  }

  seed(table: string, rows: Row[]): void {
    this.rows(table).push(...rows.map((r) => ({ ...r })));
  }

  select(table: string, query: string): Row[] {
    const q = parseQuery(query);
    let out = this.rows(table).filter((r) => rowMatches(r, q));
    for (const o of [...q.order].reverse()) {
      out = [...out].sort((a, b) => {
        const av = readColumn(a, o.column);
        const bv = readColumn(b, o.column);
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = av < bv ? -1 : 1;
        return o.desc ? -cmp : cmp;
      });
    }
    out = out.slice(q.offset);
    if (q.limit !== null) out = out.slice(0, q.limit);
    if (!q.select) return out.map((r) => ({ ...r }));
    return out.map((r) => {
      const picked: Row = {};
      for (const col of q.select ?? []) picked[col] = r[col];
      return picked;
    });
  }

  private conflictOf(table: string, row: Row, keys?: string[]): Row | undefined {
    const pk = keys ?? PRIMARY_KEYS[table];
    if (!pk) return undefined;
    return this.rows(table).find((r) => pk.every((k) => String(r[k]) === String(row[k])));
  }

  insert(table: string, rows: Row[], onConflict?: string): boolean {
    this.log.push({ op: "insert", table, rows });
    if (this.unavailable.has(table) || this.failWrites.has(table) || this.missing.has(table)) return false;
    const keys = onConflict ? onConflict.split(",").map((s) => s.trim()) : undefined;
    for (const row of rows) {
      const existing = this.conflictOf(table, row, keys);
      if (existing && onConflict) {
        Object.assign(existing, row);
      } else if (existing) {
        return false;
      } else {
        this.rows(table).push({ ...row });
      }
    }
    return true;
  }

  insertReturning(table: string, rows: Row[]): Row[] {
    this.log.push({ op: "insert", table, rows });
    if (this.unavailable.has(table) || this.failWrites.has(table) || this.missing.has(table)) return [];
    for (const row of rows) if (this.conflictOf(table, row)) return [];
    const stamped = rows.map((r, i) => ({ id: this.rows(table).length + i + 1, ...r }));
    this.rows(table).push(...stamped);
    return stamped.map((r) => ({ ...r }));
  }

  claim(table: string, row: Row): "won" | "lost" | "error" {
    this.log.push({ op: "claim", table, rows: [row] });
    if (this.unavailable.has(table) || this.missing.has(table)) return "error";
    if (this.conflictOf(table, row)) return "lost";
    this.rows(table).push({ ...row });
    return "won";
  }

  delete(table: string, query: string): boolean {
    this.log.push({ op: "delete", table, query });
    if (this.unavailable.has(table) || this.failWrites.has(table)) return false;
    if (this.missing.has(table)) return false;
    const q = parseQuery(query);
    this.tables.set(
      table,
      this.rows(table).filter((r) => !rowMatches(r, q))
    );
    return true;
  }

  deleteReturning(table: string, query: string): Row[] {
    this.log.push({ op: "delete", table, query });
    if (this.unavailable.has(table) || this.failWrites.has(table) || this.missing.has(table)) return [];
    const q = parseQuery(query);
    const gone = this.rows(table).filter((r) => rowMatches(r, q));
    this.tables.set(
      table,
      this.rows(table).filter((r) => !rowMatches(r, q))
    );
    return gone;
  }

  update(table: string, query: string, patch: Row): Row[] | null {
    this.log.push({ op: "update", table, query, patch });
    if (this.unavailable.has(table) || this.failWrites.has(table) || this.missing.has(table)) return null;
    const q = parseQuery(query);
    const hit = this.rows(table).filter((r) => rowMatches(r, q));
    for (const r of hit) Object.assign(r, patch);
    return hit.map((r) => ({ ...r }));
  }
}

/** The one store every consumer shares (reset it in beforeEach). */
export const store = new FakePostgrest();

/**
 * The `vi.mock("../runtime-config", ...)` factory body: every export the code
 * under test may touch, routed through the shared store.
 */
export function runtimeConfigMock(): Record<string, unknown> {
  const strict = async (
    table: string,
    query: string
  ): Promise<{ rows: Row[] } | { error: "missing" | "unavailable" }> => {
    if (!store.configured || store.missing.has(table)) return { error: "missing" };
    if (store.unavailable.has(table)) return { error: "unavailable" };
    return { rows: store.select(table, query) };
  };
  const config = async (name: string) => store.config.get(name) ?? process.env[name] ?? undefined;
  return {
    supabaseConfigured: () => store.configured,
    supabase: () => (store.configured ? { url: "https://sb.test", key: "test-key" } : null),
    supabaseDiagnostics: async () => ({}),
    pgTimestamp: (v: string | number | Date) =>
      encodeURIComponent((v instanceof Date ? v : new Date(v)).toISOString()),
    EGRESS_USAGE_KIND: "sb-egress-bytes",
    pendingEgressBytes: () => 0,
    lostTelemetryWrites: () => 0,
    isMissingSchemaBody: () => false,
    sbSelect: async (table: string, query = "select=*&limit=50") => {
      const read = await strict(table, query);
      return "rows" in read ? read.rows : [];
    },
    sbSelectStrict: strict,
    sbSelectDark: async (table: string, query = "select=*&limit=50") => {
      const read = await strict(table, query);
      if ("error" in read) return read.error === "missing" ? [] : null;
      return read.rows;
    },
    sbCount: async (table: string, filter: string) => {
      const read = await strict(table, `select=id&${filter}`);
      return "rows" in read ? read.rows.length : 0;
    },
    sbCountDark: async (table: string, filter: string) => {
      const read = await strict(table, `select=id&${filter}`);
      if ("error" in read) return read.error === "missing" ? 0 : null;
      return read.rows.length;
    },
    sbInsert: async (table: string, rows: Row[], onConflict?: string) =>
      store.configured && rows.length > 0 ? store.insert(table, rows, onConflict) : false,
    sbInsertClaim: async (table: string, row: Row) =>
      store.configured ? store.claim(table, row) : ("error" as const),
    sbInsertReturning: async (table: string, rows: Row[]) =>
      store.configured && rows.length > 0 ? store.insertReturning(table, rows) : [],
    sbDelete: async (table: string, filter: string) =>
      store.configured ? store.delete(table, filter) : false,
    sbDeleteReturning: async (table: string, filter: string) =>
      store.configured ? store.deleteReturning(table, filter) : [],
    sbUpdate: async (table: string, filter: string, values: Row) =>
      store.configured ? store.update(table, filter, values) !== null : false,
    sbUpdateReturning: async (table: string, filter: string, values: Row) =>
      store.configured ? (store.update(table, filter, values) ?? []) : [],
    sbRpc: async () => null,
    getConfig: config,
    getConfigExact: config,
    getConfigFresh: async (name: string) => ({ value: await config(name) }),
    getConfigStrict: async (name: string) => ({ value: await config(name) }),
    getConfigMany: async (names: readonly string[]) => {
      const out: Record<string, string | undefined> = {};
      for (const n of names) out[n] = await config(n);
      return out;
    },
    getGoogleClientId: async () => null,
    setConfig: async () => true,
    _resetKeyCache: () => {},
    encryptString: (s: string) => s,
    decryptString: (s: string) => s,
    vaultReadState: () => ({ state: "ok", at: Date.now() }),
    vaultDecryptHealth: () => null,
  };
}
