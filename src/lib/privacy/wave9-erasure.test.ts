import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// WAVE 9: ERASURE IS A REGISTRY, NOT A ROUTE'S PRIVATE LIST.
//
// The admin erase action purged FOUR tables out of the ~30 holding a person's
// data and answered 200 "erased" - every WhatsApp transcript, thread, offer,
// consent row and risk event stayed. user-tables.ts is now the single source
// of "which tables hold this person"; the erase walker and the DSAR export
// both drive off it, and the completeness suite below refuses any table that
// ships without a registry decision.

vi.mock("server-only", () => ({}));

const calls: {
  deletes: { table: string; filter: string }[];
  updates: { table: string }[];
  disconnects: string[];
  failTables: Set<string>;
} = { deletes: [], updates: [], disconnects: [], failTables: new Set() };

vi.mock("../runtime-config", () => ({
  supabaseConfigured: () => true,
  sbDelete: async (table: string, filter: string) => {
    calls.deletes.push({ table, filter });
    return !calls.failTables.has(table);
  },
  sbSelect: async (table: string, query: string) => {
    // Parent-id collection for the child walks.
    if (table === "feedback" && query.includes("select=id")) return [{ id: 7 }, { id: 9 }];
    if (table === "waba_leads" && query.includes("select=id")) return [];
    return [];
  },
  sbSelectStrict: async () => ({ rows: [] }),
  sbInsert: async () => true,
  sbUpdate: async (table: string) => {
    calls.updates.push({ table });
    return true;
  },
  getConfig: async () => undefined,
}));

vi.mock("../evolution", () => ({
  disconnectInstance: async (email: string) => {
    calls.disconnects.push(email);
    return true;
  },
}));

import { USER_TABLES, CHILD_TABLES, EXCLUDED_TABLES, filterFor, registeredTables } from "./user-tables";
import { eraseUserData } from "./erase";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

beforeEach(() => {
  calls.deletes = [];
  calls.updates = [];
  calls.disconnects = [];
  calls.failTables = new Set();
});

// ---------------------------------------------------------------------------
// Completeness: the schema cannot grow a user-keyed table the registry misses.
// ---------------------------------------------------------------------------

describe("the registry covers the schema", () => {
  const schema = read("supabase/schema.sql") + "\n" + read("supabase/retention.sql");
  const allTables = Array.from(
    schema.matchAll(/create table if not exists public\.(\w+)/g),
    (m) => m[1]
  );

  it("EVERY table is either registered or excused by name - no third state", () => {
    const known = new Set([...registeredTables(), ...Object.keys(EXCLUDED_TABLES)]);
    const undecided = allTables.filter((t) => !known.has(t));
    expect(
      undecided,
      `tables with no erasure decision: ${undecided.join(", ")} - register them in ` +
        `USER_TABLES/CHILD_TABLES or excuse them in EXCLUDED_TABLES with a reason`
    ).toEqual([]);
  });

  it("every registered table actually exists in the schema (no typos)", () => {
    const existing = new Set(allTables);
    const ghosts = registeredTables().filter((t) => !existing.has(t));
    expect(ghosts).toEqual([]);
  });

  it("every registered column exists on its table", () => {
    for (const entry of USER_TABLES) {
      // A jsonb path like raw->>sender needs the jsonb column itself.
      const col = entry.column.split("->")[0];
      const block = schema.slice(
        schema.indexOf(`create table if not exists public.${entry.table}`)
      );
      const create = block.slice(0, block.indexOf(");") + 2);
      const altered = new RegExp(
        `alter table public\\.${entry.table} add column if not exists ${col}\\b`
      ).test(schema);
      const inCreate = new RegExp(`^\\s+${col}\\s`, "m").test(create);
      expect(
        inCreate || altered,
        `${entry.table}.${col} is registered but not in the schema`
      ).toBe(true);
    }
  });

  it("the digest's headline omission is covered: transcripts by BOTH directions", () => {
    const wm = USER_TABLES.filter((t) => t.table === "whatsapp_messages").map((t) => t.column);
    expect(wm.sort()).toEqual(["raw->>receiver", "raw->>sender"]);
  });

  it("the reset rows are erased under their namespaced key too", () => {
    expect(
      USER_TABLES.some((t) => t.table === "email_verifications" && t.match === "reset-prefix")
    ).toBe(true);
  });
});

describe("filterFor builds the exact PostgREST shapes", () => {
  it("exact, prefix and reset-prefix", () => {
    expect(filterFor({ table: "x", column: "user_email", match: "exact" }, "A@X.com")).toBe(
      "user_email=eq.a%40x.com"
    );
    expect(filterFor({ table: "x", column: "thread_key", match: "prefix" }, "a@x.com")).toBe(
      "thread_key=like.a%40x.com%3A*"
    );
    expect(filterFor({ table: "x", column: "email", match: "reset-prefix" }, "a@x.com")).toBe(
      "email=eq.reset%3Aa%40x.com"
    );
  });
});

// ---------------------------------------------------------------------------
// The walker itself.
// ---------------------------------------------------------------------------

describe("eraseUserData walks the whole registry, in the right order", () => {
  it("touches every registered table and reports full success honestly", async () => {
    const r = await eraseUserData("Someone@Example.com");
    expect(r.failed).toEqual([]);
    expect(r.userDeleted).toBe(true);
    expect(r.sessionsRevoked).toBe(true);
    const touched = new Set(calls.deletes.map((d) => d.table));
    for (const t of USER_TABLES) expect(touched.has(t.table), t.table).toBe(true);
    // Children with live parent ids are deleted by id in-list...
    expect(
      calls.deletes.find((d) => d.table === "feedback_images")?.filter
    ).toBe("feedback_id=in.(7,9)");
    // ...and an empty parent set is a SUCCESSFUL no-op, not a failure.
    expect(r.purged.waba_events).toBe(true);
  });

  it("WhatsApp is severed first, sessions revoked before any row dies, account row LAST", async () => {
    await eraseUserData("someone@example.com");
    expect(calls.disconnects).toEqual(["someone@example.com"]);
    // revokeSessions is the sbUpdate on app_users - it must precede the deletes.
    expect(calls.updates[0]?.table).toBe("app_users");
    // Children go before their parents, so the id collection still works.
    const order = calls.deletes.map((d) => d.table);
    expect(order.indexOf("feedback_images")).toBeLessThan(order.indexOf("feedback"));
    expect(order.indexOf("feedback_replies")).toBeLessThan(order.indexOf("feedback"));
    // app_users is the very last delete.
    expect(order.at(-1)).toBe("app_users");
  });

  it("a failed table is NAMED, and the account row survives so the erase can retry", async () => {
    calls.failTables = new Set(["whatsapp_messages", "app_users"]);
    const r = await eraseUserData("someone@example.com");
    expect(r.failed).toContain("whatsapp_messages");
    expect(r.userDeleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wiring pins: the routes drive off the registry, and honesty survives.
// ---------------------------------------------------------------------------

const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the routes drive off the registry", () => {
  it("the admin erase action uses the walker, not a private table map", () => {
    const route = readCode("src/app/api/admin/users/route.ts");
    expect(route).toMatch(/eraseUserData/);
    expect(route).not.toMatch(/userColumn/);
    expect(route).toMatch(/Partial erase - could not purge/); // honesty survives
  });

  it("self-serve erase demands the TYPED email, refuses the owner, ends the session", () => {
    const route = readCode("src/app/api/profile/erase/route.ts");
    expect(route).toMatch(/isOwner\(session\.email\)/);
    expect(route).toMatch(/confirm.*session\.email|session\.email.*confirm/);
    expect(route).toMatch(/eraseUserData\(session\.email\)/);
    expect(route).toMatch(/clearSessionCookie\(\)/);
    expect(route).toMatch(/status: 500/); // partial failure is not "ok"
  });

  it("the DSAR export walks the SAME registry and names what it could not read", () => {
    const route = readCode("src/app/api/profile/export/route.ts");
    expect(route).toMatch(/USER_TABLES/);
    expect(route).toMatch(/CHILD_TABLES/);
    expect(route).toMatch(/filterFor/);
    expect(route).toMatch(/unreadable/);
    expect(route).toMatch(/rateLimit\("dsar-export"/);
    // The account block withholds the password hash.
    expect(route).not.toMatch(/passwordHash: rec\.passwordHash/);
  });

  it("the Profile page offers both halves of the DSAR pair", () => {
    const page = read("src/app/profile/page.tsx");
    expect(page).toMatch(/\/api\/profile\/export/);
    expect(page).toMatch(/\/api\/profile\/erase/);
  });
});

// ---------------------------------------------------------------------------
// Retention: the tables the prune never touched, the de-identify step, and a
// heartbeat the app can SEE.
// ---------------------------------------------------------------------------

describe("retention completion", () => {
  const sql = read("supabase/retention.sql");

  it("prunes the user-keyed tables the first version never touched", () => {
    for (const t of [
      "wa_turns",
      "wa_risk_events",
      "bargain_drafts",
      "graph_wakeups",
      "negotiation_threads",
      "vendor_replies",
      "search_sessions",
      "auth_events",
      "waba_events",
      "response_times",
      "email_verifications",
      "user_cooldowns",
      "offers",
      "searches",
    ]) {
      expect(sql, t).toMatch(new RegExp(`delete from public\\.${t} where`));
    }
  });

  it("priced transcripts are DE-IDENTIFIED past the window, not kept verbatim forever", () => {
    expect(sql).toMatch(/update public\.whatsapp_messages/);
    expect(sql).toMatch(/raw - 'sender' - 'receiver'/);
    expect(sql).toMatch(/'deidentified_at', now\(\)/);
    // Idempotent: already-stripped rows are filtered out.
    expect(sql).toMatch(/\(raw ->> 'deidentified_at'\) is null/);
    // The pricing evidence survives: only rows WITH a reading/priced mark.
    expect(sql).toMatch(/\(raw ->> 'reading'\) is not null\s*\n\s*or coalesce/);
  });

  it("Trips-visible history (searches/offers) lives on the LONG window", () => {
    expect(sql).toMatch(/delete from public\.offers where created_at < cutoff_long/);
    expect(sql).toMatch(/delete from public\.searches where created_at < cutoff_long/);
  });

  it("bookings and consent proof are deliberately NOT pruned", () => {
    expect(sql).not.toMatch(/delete from public\.bookings/);
    expect(sql).not.toMatch(/delete from public\.consent_events/);
    expect(sql).toMatch(/DELIBERATELY NOT PRUNED/);
  });

  it("every run writes the 'retention-ran' heartbeat the health tile reads", () => {
    expect(sql).toMatch(/insert into public\.agent_events \(kind, detail\)\s*\n\s*values \('retention-ran'/);
    const health = readCode("src/app/api/admin/health/route.ts");
    expect(health).toMatch(/kind=eq\.retention-ran/);
    expect(health).toMatch(/unreadable: retentionRows === null/);
    const panel = read("src/components/HealthPanel.tsx");
    expect(panel).toMatch(/NEVER RAN - no prune heartbeat exists/);
  });

  it("response_times stores md5 keys and the reader hashes its probe", () => {
    expect(sql).toMatch(/update public\.response_times set phone = md5\(phone\)/);
    const stats = readCode("src/lib/stats.ts");
    expect(stats).toMatch(/createHash\("md5"\)\.update\(digitsOnly\(phoneRaw\)\)/);
    expect(stats).toMatch(/\{ phone: key, ms \}/);
    const google = readCode("src/lib/google.ts");
    expect(google).toMatch(/fast\.has\(responsePhoneKey\(v\.whatsapp\)\)/);
  });
});
