import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// AUDIT F019 (and the registry half of F169).
//
// wa_processed and wa_inbound_seen key on claimKey(receiverEmail, waMessageId)
// = `<lowercased email>:<message id>`, so every row carried the traveller's
// address - yet both were excused from the erasure registry as "message-id
// dedupe, no user data" and appeared in no retention window. One row per
// message the person ever received survived their erasure, forever.
//
// The registry's prefix shape renders `column=like.<email>:*`, and PostgREST
// hands the value to SQL LIKE where `_` and `%` are wildcards: an underscore in
// a local part (common) would make one person's erase delete OTHER travellers'
// claim rows. The escaping is pinned here too.

const calls: { deletes: { table: string; filter: string }[] } = { deletes: [] };

vi.mock("../runtime-config", () => ({
  supabaseConfigured: () => true,
  sbDelete: async (table: string, filter: string) => {
    calls.deletes.push({ table, filter });
    return true;
  },
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: [] }),
  sbInsert: async () => true,
  sbUpdate: async () => true,
  getConfig: async () => undefined,
}));

vi.mock("../evolution", () => ({
  disconnectInstance: async () => ({ severed: true, hostsTried: 1, hadLink: true }),
}));

import { eraseUserData } from "./erase";
import { USER_TABLES, EXCLUDED_TABLES, filterFor } from "./user-tables";

beforeEach(() => {
  calls.deletes = [];
});

const filtersOn = (table: string) => calls.deletes.filter((d) => d.table === table).map((d) => d.filter);

describe("EXECUTED: the inbound claim rows leave with the person", () => {
  it("wa_processed and wa_inbound_seen are deleted by the email prefix that claimKey wrote", async () => {
    await eraseUserData("a_b@example.com");
    // THE ASSERTIONS THAT FAILED BEFORE: neither table was ever touched.
    expect(filtersOn("wa_processed")).toEqual(["wa_message_id=like.a%5C_b%40example.com%3A*"]);
    expect(filtersOn("wa_inbound_seen")).toEqual(["wa_message_id=like.a%5C_b%40example.com%3A*"]);
  });

  it("both tables are REGISTERED, not excused", () => {
    for (const t of ["wa_processed", "wa_inbound_seen"]) {
      expect(
        USER_TABLES.some((e) => e.table === t && e.column === "wa_message_id" && e.match === "prefix"),
        t
      ).toBe(true);
      expect(EXCLUDED_TABLES[t], t).toBeUndefined();
    }
  });
});

describe("filterFor escapes LIKE wildcards in the address", () => {
  it("an underscore in the local part is matched literally, never as a wildcard", () => {
    expect(filterFor({ table: "x", column: "thread_key", match: "prefix" }, "a_b@x.com")).toBe(
      "thread_key=like.a%5C_b%40x.com%3A*"
    );
  });
  it("a percent sign and a backslash are escaped too", () => {
    expect(filterFor({ table: "x", column: "thread_key", match: "prefix" }, "50%off@x.com")).toBe(
      "thread_key=like.50%5C%25off%40x.com%3A*"
    );
    expect(filterFor({ table: "x", column: "thread_key", match: "prefix" }, "a\\b@x.com")).toBe(
      "thread_key=like.a%5C%5Cb%40x.com%3A*"
    );
  });
  it("an address with no wildcard characters keeps the exact shape the walker always used", () => {
    expect(filterFor({ table: "x", column: "thread_key", match: "prefix" }, "a@x.com")).toBe(
      "thread_key=like.a%40x.com%3A*"
    );
  });
});

describe("EXECUTED (F169): golden cases keyed to the person are erased under BOTH key shapes", () => {
  it("the legacy raw-email prefix and the pseudonym prefix are both issued", async () => {
    const email = "someone@example.com";
    const pseudonym = `wd-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
    await eraseUserData(email);
    const filters = filtersOn("agent_golden_cases");
    expect(filters).toContain("thread_key=like.someone%40example.com%3A*");
    expect(filters).toContain(`thread_key=like.${pseudonym}%3A*`);
    expect(EXCLUDED_TABLES.agent_golden_cases).toBeUndefined();
  });
});

describe("retention reaches the claim tables", () => {
  it("prunes both on the short window, far past the 10-minute lease and the 14-day ingest window", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/retention.sql"), "utf8");
    expect(sql).toMatch(/delete from public\.wa_processed where created_at < cutoff;/);
    expect(sql).toMatch(/delete from public\.wa_inbound_seen where created_at < cutoff;/);
  });
});
