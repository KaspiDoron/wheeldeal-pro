import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// W8 #22 / #24: the per-user daily caps.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  /** Every api_usage row the fake store holds, in id order. */
  rows: [] as { count: number }[],
  /** Every query the code issued - the paging assertion surface. */
  queries: [] as string[],
  unavailable: false,
  cfg: {} as Record<string, string>,
}));

vi.mock("./runtime-config", () => ({
  getConfig: vi.fn(async (k: string) => db.cfg[k]),
  getConfigFresh: vi.fn(async (k: string) => ({ value: db.cfg[k] })),
  sbInsert: vi.fn(async () => true),
  sbSelect: vi.fn(async () => []),
  sbSelectStrict: vi.fn(async (_t: string, q: string) => {
    db.queries.push(q);
    if (db.unavailable) return { error: "unavailable" as const };
    const off = Number(/offset=(\d+)/.exec(q)?.[1] ?? 0);
    const lim = Number(/limit=(\d+)/.exec(q)?.[1] ?? 1000);
    return { rows: db.rows.slice(off, off + lim) };
  }),
}));
vi.mock("./rival-cache", () => ({ hotStateClient: async () => null }));

beforeEach(() => {
  db.rows = [];
  db.queries = [];
  db.unavailable = false;
  db.cfg = {};
  // The in-memory counter map is a `globalThis` singleton across cases.
  (globalThis as { __wheeldeal_limits__?: unknown }).__wheeldeal_limits__ = undefined;
});

describe("W8 #22: a PEEK must not spend", () => {
  it("REPRODUCTION: reserve:false used to consume a unit anyway", async () => {
    const { checkDailyLimit } = await import("./usage");
    db.cfg.LIMIT_AI_PER_DAY = "3";
    // Three peeks, zero model calls. The parameter's own docblock says it
    // "PEEKS instead of consuming a unit"; the counter said otherwise.
    for (let i = 0; i < 3; i++) {
      const g = await checkDailyLimit("ai", "u@x.com", "LIMIT_AI_PER_DAY", { reserve: false });
      expect(g.allowed).toBe(true);
      expect(g.used).toBe(0); // nothing was ever recorded
    }
    // A fourth peek still passes: three peeks spent nothing.
    expect(
      (await checkDailyLimit("ai", "u@x.com", "LIMIT_AI_PER_DAY", { reserve: false })).allowed
    ).toBe(true);
  });

  it("...while a real reservation still spends, and still bites", async () => {
    const { checkDailyLimit } = await import("./usage");
    db.cfg.LIMIT_AI_PER_DAY = "3";
    for (let i = 0; i < 3; i++) {
      expect((await checkDailyLimit("ai", "u@x.com", "LIMIT_AI_PER_DAY")).allowed).toBe(true);
    }
    const over = await checkDailyLimit("ai", "u@x.com", "LIMIT_AI_PER_DAY");
    expect(over.allowed).toBe(false);
  });

  it("a peek does not even move the in-memory counter a reservation reads", async () => {
    const { checkDailyLimit } = await import("./usage");
    db.cfg.LIMIT_AI_PER_DAY = "2";
    await checkDailyLimit("ai", "u@x.com", "LIMIT_AI_PER_DAY", { reserve: false });
    await checkDailyLimit("ai", "u@x.com", "LIMIT_AI_PER_DAY", { reserve: false });
    // If the peeks had counted, this would already be refused.
    expect((await checkDailyLimit("ai", "u@x.com", "LIMIT_AI_PER_DAY")).allowed).toBe(true);
  });
});

describe("W8 #24: the durable half is a SUM, not the first 1000 rows", () => {
  it("REPRODUCTION: a cap above 1000 could never be reached by a truncated read", async () => {
    const { checkDailyLimit } = await import("./usage");
    // An owner-raised geocode limit, or SCALE_MODE tripling 400 -> 1200.
    db.cfg.LIMIT_GEOCODE_PER_DAY = "1200";
    db.rows = Array.from({ length: 1500 }, () => ({ count: 1 }));
    const g = await checkDailyLimit("geocode", "u@x.com", "LIMIT_GEOCODE_PER_DAY");
    // A single `limit=1000` read tops out at 1000, which is < 1200, so the cap
    // could never be enforced on the Postgres side at all.
    expect(g.used).toBeGreaterThanOrEqual(1200);
    expect(g.allowed).toBe(false);
    expect(db.queries.length).toBeGreaterThan(1); // it paged
  });

  it("it stops the moment it has enough to answer - one page in the normal case", async () => {
    const { checkDailyLimit } = await import("./usage");
    db.cfg.LIMIT_GEOCODE_PER_DAY = "300";
    db.rows = Array.from({ length: 40 }, () => ({ count: 1 }));
    await checkDailyLimit("geocode", "u@x.com", "LIMIT_GEOCODE_PER_DAY");
    expect(db.queries).toHaveLength(1);
  });

  it("rows carrying a count > 1 are summed, not counted", async () => {
    const { checkDailyLimit } = await import("./usage");
    db.cfg.LIMIT_AI_PER_DAY = "10";
    db.rows = [{ count: 4 }, { count: 7 }]; // recordApi("ai", scope.spent, ...)
    const g = await checkDailyLimit("ai", "u@x.com", "LIMIT_AI_PER_DAY");
    expect(g.used).toBe(11);
    expect(g.allowed).toBe(false);
  });

  it("an unreadable count still fails CLOSED, with the reason", async () => {
    const { checkDailyLimit } = await import("./usage");
    db.unavailable = true;
    const g = await checkDailyLimit("ai", "u@x.com", "LIMIT_AI_PER_DAY");
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("unreadable");
  });

  it("the paging is bounded - a pathological day cannot loop", async () => {
    const usage = readCode("src/lib/usage.ts");
    expect(usage).toMatch(/const USAGE_MAX_PAGES = \d+;/);
    expect(usage).toMatch(/page < USAGE_MAX_PAGES/);
    expect(usage).not.toMatch(/created_at=\$\{encodeURIComponent\(today\)\}&limit=1000`/);
  });
});

// ---------------------------------------------------------------------------
// W8 #23: two caps whose debits were written under different names.
// ---------------------------------------------------------------------------

describe("W8 #23: the gate and the debit finally name the same thing", () => {
  it("REPRODUCTION: lib/google records the COST kinds, with no user at all", () => {
    const google = readCode("src/lib/google.ts");
    // These are the cost tracker's kinds (QUOTAS in usage.ts) - whose SPEND,
    // not whose QUOTA - and none of them carries a user_email.
    expect(google).toMatch(/recordApi\("places_search"\)/);
    expect(google).toMatch(/recordApi\("geocoding"\)/);
    expect(google).not.toMatch(/recordApi\("search",/);
    expect(google).not.toMatch(/recordApi\("geocode",/);
  });

  it("/api/vendors debits `search` against the signed-in user, PLAN-AWARE", () => {
    const route = readCode("src/app/api/vendors/route.ts");
    // W-beta30: the gate now carries the caller's plan. The flat 5/day wall
    // was plan-blind while plans.ts sells Ultra "Unlimited daily searches
    // (fair use)", so every Ultra tester hit it on day one - and read a
    // refusal claiming the cap "keeps the service free for everyone".
    expect(route).toMatch(
      /checkDailyLimit\("search", session\.email, "LIMIT_SEARCHES_PER_DAY", \{\s*plan: session\.plan,?\s*\}\)/
    );
    expect(route).toMatch(/recordApi\("search", 1, session\.email\)/);
  });

  it("/api/geocode debits `geocode` against the signed-in user, PLAN-AWARE", () => {
    const route = readCode("src/app/api/geocode/route.ts");
    expect(route).toMatch(
      /checkDailyLimit\("geocode", session\.email, "LIMIT_GEOCODE_PER_DAY", \{\s*plan: session\.plan,?\s*\}\)/
    );
    expect(route).toMatch(/recordApi\("geocode", 1, session\.email\)/);
  });

  it("EXECUTED: the debit shape the gate reads does add up to a refusal", async () => {
    const { checkDailyLimit } = await import("./usage");
    db.cfg.LIMIT_SEARCHES_PER_DAY = "2";
    // Two rows of kind `search` for this user - what recordApi now writes.
    db.rows = [{ count: 1 }, { count: 1 }];
    const g = await checkDailyLimit("search", "u@x.com", "LIMIT_SEARCHES_PER_DAY");
    expect(g.allowed).toBe(false);
    expect(db.queries[0]).toContain("kind=eq.search");
    expect(db.queries[0]).toContain("user_email=eq.u%40x.com");
  });

  it("every per-user cap now has a debit written under its own kind", () => {
    // ai -> ai-budget.ts, translate -> the translate route, and the two above.
    expect(readCode("src/lib/ai-budget.ts")).toMatch(/recordApi\("ai", scope\.spent, email\)/);
    expect(readCode("src/app/api/translate/route.ts")).toMatch(
      /recordApi\("translate", 1, session\.email\)/
    );
  });
});

// ---------------------------------------------------------------------------
// W8 #27: revocation latency.
// ---------------------------------------------------------------------------

describe("W8 #27: a demoted admin does not keep the keys for half a minute", () => {
  it("the runtime admin list is read FRESH, not through the 30s vault cache", () => {
    const session = readCode("src/lib/session.ts");
    expect(session).toMatch(/getConfigFresh\("ADMIN_EMAILS_EXTRA"\)/);
    expect(session).not.toMatch(/getConfig\("ADMIN_EMAILS_EXTRA"\)/);
  });

  it("the fresh window is seconds, and every write drops it on that instance", () => {
    const rc = readCode("src/lib/runtime-config.ts");
    const ttl = Number(/const FRESH_TTL_MS = ([\d_]+);/.exec(rc)![1].replace(/_/g, ""));
    expect(ttl).toBeLessThanOrEqual(5_000);
    const vault = Number(/const CACHE_TTL_MS = ([\d_]+);/.exec(rc)![1].replace(/_/g, ""));
    expect(ttl).toBeLessThan(vault);
    expect((rc.match(/s\.fresh\.clear\(\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("an unreadable vault yields owner + env admins only - it fails CLOSED", () => {
    const session = readCode("src/lib/session.ts");
    expect(session).toMatch(/const raw = "error" in read \? "" : \(read\.value \?\? ""\);/);
  });

  it("the residual 10s user-record window is documented, not hidden", () => {
    const doc = readFileSync(join(process.cwd(), "PRODUCTION-READINESS.md"), "utf8");
    expect(doc).toMatch(/Revocation latency across warm instances/);
    expect(doc).toMatch(/Accepted - the user record \(10s/);
    // The accepted one must state its own blast radius, not just its existence.
    expect(doc.replace(/\s+/g, " ")).toMatch(
      /A blocked account can therefore keep a session alive for up to ~10 seconds/
    );
  });
});
