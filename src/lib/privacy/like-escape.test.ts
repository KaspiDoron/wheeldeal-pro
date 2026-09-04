import { describe, it, expect, vi, beforeEach } from "vitest";

// AUDIT F022 - the erasure/DSAR prefix filter ran an UNESCAPED SQL LIKE.
//
// filterFor's `prefix` branch percent-encoded the email but left `_`, `%` and
// `\` live as LIKE metacharacters, so `thread_key LIKE 'a_b@x.com:%'` matched
// `axb@x.com:...` rows too - and the erase walker DELETED another traveller's
// agent_scores while the DSAR export handed them over. The repo had already
// fixed the identical defect one file over (graph/engine.ts's wakeup drain);
// this suite executes the walker against a LIKE-emulating store so the
// cross-account reach is a failing assertion, not a paraphrase.

vi.mock("server-only", () => ({}));

interface ScoreRow {
  id: number;
  thread_key: string;
}

const store: { agent_scores: ScoreRow[]; deletes: { table: string; filter: string }[] } = {
  agent_scores: [],
  deletes: [],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Postgres LIKE semantics over a PostgREST `like.` value: `*` is PostgREST's
 * spelling of `%` (any run), `_` is any single character, and a backslash
 * escapes the character after it. This is exactly what the database does with
 * the pattern the walker sends.
 */
function likeToRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      out += escapeRe(pattern[++i]);
      continue;
    }
    if (c === "%" || c === "*") {
      out += ".*";
      continue;
    }
    if (c === "_") {
      out += ".";
      continue;
    }
    out += escapeRe(c);
  }
  return new RegExp(`${out}$`);
}

vi.mock("../runtime-config", () => ({
  supabaseConfigured: () => true,
  sbDelete: async (table: string, filter: string) => {
    store.deletes.push({ table, filter });
    if (table !== "agent_scores") return true;
    const like = /thread_key=like\.([^&]+)/.exec(filter)?.[1];
    if (!like) return true;
    const rx = likeToRegex(decodeURIComponent(like));
    store.agent_scores = store.agent_scores.filter((r) => !rx.test(r.thread_key));
    return true;
  },
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: [] }),
  sbInsert: async () => true,
  sbUpdate: async () => true,
  getConfig: async () => undefined,
}));

vi.mock("../evolution", () => ({ disconnectInstance: async () => true }));
vi.mock("../access", () => ({
  revokeSessions: async () => true,
  deleteUser: async () => true,
}));

import { filterFor } from "./user-tables";
import { eraseUserData } from "./erase";

const PREFIX = { table: "agent_scores", column: "thread_key", match: "prefix" as const };

beforeEach(() => {
  store.agent_scores = [];
  store.deletes = [];
});

describe("filterFor escapes the three LIKE metacharacters in a prefix filter", () => {
  it("an underscore is a literal underscore, not a one-character wildcard", () => {
    expect(filterFor(PREFIX, "a_b@x.com")).toBe("thread_key=like.a%5C_b%40x.com%3A*");
  });

  it("a percent sign is a literal percent sign, not an any-run wildcard", () => {
    expect(filterFor(PREFIX, "a%b@x.com")).toBe("thread_key=like.a%5C%25b%40x.com%3A*");
  });

  it("a backslash is doubled so it cannot swallow the colon terminator", () => {
    expect(filterFor(PREFIX, "a\\b@x.com")).toBe("thread_key=like.a%5C%5Cb%40x.com%3A*");
  });

  it("an email with no metacharacters keeps the exact shape the walker always sent", () => {
    expect(filterFor(PREFIX, "a@x.com")).toBe("thread_key=like.a%40x.com%3A*");
  });
});

describe("EXECUTED: eraseUserData for a_b@x.com leaves axb@x.com's rows alone", () => {
  it("the other traveller's agent_scores survive the walk", async () => {
    store.agent_scores = [
      { id: 1, thread_key: "a_b@x.com:66811111111" },
      { id: 2, thread_key: "axb@x.com:66822222222" },
      { id: 3, thread_key: "a_b@x.com.evil:66833333333" },
    ];
    const r = await eraseUserData("a_b@x.com");
    expect(r.purged.agent_scores).toBe(true);
    // The person's own row is gone...
    expect(store.agent_scores.find((r) => r.id === 1)).toBeUndefined();
    // ...the colliding account's row is NOT (this is the assertion that failed
    // before the escape), and the colon terminator still holds.
    expect(store.agent_scores.map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it("a percent sign in the local part does not widen the delete to the whole table", async () => {
    store.agent_scores = [
      { id: 1, thread_key: "a%b@x.com:66811111111" },
      { id: 2, thread_key: "anyone@x.com:66822222222" },
      { id: 3, thread_key: "a@x.com:66833333333" },
    ];
    await eraseUserData("a%b@x.com");
    expect(store.agent_scores.map((r) => r.id).sort()).toEqual([2, 3]);
  });
});
