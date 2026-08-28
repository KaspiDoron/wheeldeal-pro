import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rateLimit, clientIp, SHARED_BUCKET, _resetRateLimit } from "./rate-limit";
import { readdirSync } from "node:fs";

// WAVE 0 - security hotfixes. Each fix lands with a test that fails on revert.
// The behavioral tests exercise the new limiter directly; the source pins guard
// the route/config wiring the way this repo already pins deploy-env and
// safety-signals - a reintroduction of the defect turns the assertion red.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("rateLimit - the sessionless route limiter", () => {
  beforeEach(() => _resetRateLimit());

  it("allows up to max in a window and refuses the next", async () => {
    // No REDIS_URL in the test env, so this exercises the per-instance window.
    for (let i = 0; i < 5; i++) {
      expect((await rateLimit("t", "1.2.3.4", 5, 3600)).ok, `hit ${i + 1}`).toBe(true);
    }
    const over = await rateLimit("t", "1.2.3.4", 5, 3600);
    expect(over.ok).toBe(false);
    expect(over.retryAfter).toBeGreaterThan(0);
  });

  it("keeps separate counters per id and per bucket", async () => {
    for (let i = 0; i < 5; i++) await rateLimit("t", "a", 5, 3600);
    expect((await rateLimit("t", "a", 5, 3600)).ok).toBe(false); // a is spent
    expect((await rateLimit("t", "b", 5, 3600)).ok).toBe(true); // b is fresh
    expect((await rateLimit("other", "a", 5, 3600)).ok).toBe(true); // other bucket
  });

  // REWRITTEN, INTENT PRESERVED. This asserted that clientIp returns hop 0
  // ("newest-hop first"), which was wrong about the platform and is the whole
  // reason the limiter was bypassable: Cloud Run's front end APPENDS the address
  // it observed, so the newest hop is the LAST one and hop 0 is written by the
  // caller. Same intent - clientIp identifies the caller and answers a
  // non-empty key when it cannot - with the direction corrected. The attack
  // itself is exercised in client-ip.test.ts.
  it("clientIp reads the hop Cloud Run appends, which is the LAST one", () => {
    const req = new Request("https://x/y", {
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    });
    expect(clientIp(req)).toBe("10.0.0.1");
    expect(clientIp(new Request("https://x/y"))).toBe(SHARED_BUCKET);
  });
});

describe("prune_old_rows is no longer callable by the anon key", () => {
  // REWRITTEN, INTENT PRESERVED. The original asserted that the REVOKE exists in
  // supabase/security-fix.sql - a file referenced in no guide, no deploy note
  // and no admin screen, while the file that CREATES the vulnerable function was
  // the one owners are told to run. The test was green and every fresh
  // deployment still got the hole. The invariant worth pinning is not "the
  // revoke exists somewhere" but "the revoke cannot be skipped": any file that
  // creates the function must lock it down in the same file, after the create.
  //
  // There is no Postgres in the unit suite, so this is structural rather than
  // executed. The live check is the admin panel's "Check anon RPC lockdown"
  // probe (/api/admin/rpc-exposure), which asks the real database.
  const revokes = [
    /revoke all on function public\.prune_old_rows\(int\) from anon;/i,
    /revoke all on function public\.prune_old_rows\(int\) from authenticated/i,
    /grant execute on function public\.prune_old_rows\(int\) to service_role/i,
  ];

  it("every SQL file that creates the function also revokes the anon grant, AFTER the create", () => {
    const files = readdirSync(join(process.cwd(), "supabase")).filter((f) => f.endsWith(".sql"));
    const creators = files.filter((f) =>
      /create\s+(or\s+replace\s+)?function\s+public\.prune_old_rows/i.test(read(`supabase/${f}`))
    );
    // If nobody creates it any more the vulnerability is gone by construction;
    // as long as somebody does, that same file has to close it.
    expect(creators.length).toBeGreaterThan(0);
    for (const f of creators) {
      const sql = read(`supabase/${f}`);
      const createAt = sql.search(/create\s+(or\s+replace\s+)?function\s+public\.prune_old_rows/i);
      for (const re of revokes) {
        const m = re.exec(sql);
        expect(m, `${f} is missing ${re}`).not.toBeNull();
        expect(m!.index, `${f} revokes before it creates`).toBeGreaterThan(createAt);
      }
    }
  });

  it("retention.sql - the file the guides tell owners to run - is the one that carries it", () => {
    const sql = read("supabase/retention.sql");
    for (const re of revokes) expect(sql).toMatch(re);
    // And it refuses to finish quietly if the revoke did not take.
    expect(sql).toMatch(/has_function_privilege\('anon'/i);
    expect(sql).toMatch(/raise exception/i);
  });

  it("schema.sql - the file every owner runs, and re-runs - repairs it too", () => {
    // Belt and braces against ordering: an owner who ran the OLD retention.sql
    // and later re-runs schema.sql (which the guide tells them to do on every
    // update) is repaired without knowing any of this happened. Guarded on
    // existence so it is a clean no-op before the function is created.
    const sql = read("supabase/schema.sql");
    const idx = sql.indexOf("prune_old_rows");
    expect(idx).toBeGreaterThan(0);
    for (const re of revokes) expect(sql).toMatch(re);
    expect(sql).toMatch(/where n\.nspname = 'public' and p\.proname = 'prune_old_rows'/);
  });

  it("the standalone repair file still works for databases built before the move", () => {
    const sql = read("supabase/security-fix.sql");
    for (const re of revokes) expect(sql).toMatch(re);
  });

  it("the owner is TOLD to run it, in the guides they actually read", () => {
    // The defect was never the SQL - it was that nothing pointed at it.
    for (const doc of ["GUIDE.md", "SCALING.md", "PRODUCTION-READINESS.md"]) {
      expect(read(doc), `${doc} never mentions retention.sql`).toMatch(/retention\.sql/);
    }
    expect(read("GUIDE.md")).toMatch(/prune_old_rows/);
  });
});

describe("PayPal webhook - a hint can never drive a downgrade", () => {
  const src = read("src/app/api/webhooks/paypal/route.ts");
  // REWRITTEN, INTENT PRESERVED. The middle assertion pinned the exact string
  // `grantEmail = linked || hintEmail || ""` - the very line through which the
  // downgrade this describe-block is named after was still reachable, because
  // setPlan overwrites and a "grant" of Pro to an Ultra account IS a downgrade.
  // Same intent (the link is the trusted attribution, the hint is not), now
  // asserting the shape that actually holds: a hint bootstraps only an unlinked
  // subscription, and the grant is raise-only. The executed proof lives in
  // src/app/api/webhooks/paypal/attribution.test.ts.
  it("the verified activation link wins; the downgrade path trusts ONLY the link", () => {
    expect(src).toMatch(/const linked = subscriptionId \? await subscriberFor\(subscriptionId\) : null/);
    expect(src).toMatch(/const grantEmail = linked \|\| \(hintUsable \? hintEmail : ""\)/);
    expect(src).toMatch(/const downgradeEmail = linked \|\| ""/);
  });
  it("a grant can only ever RAISE a plan, so it cannot be used as a downgrade", () => {
    // The ladder comparison has to come BEFORE the write, not merely exist.
    const guard = src.indexOf("PLAN_RANK[tier] <= PLAN_RANK[before]");
    const write = src.indexOf("setPlan(email, tier)");
    expect(guard).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(guard);
  });
  it("the suspension/downgrade branch consumes downgradeEmail, not the raw hint", () => {
    expect(src).toMatch(/else if \(verified && downgradeEmail\)/);
    // The old, exploitable form must be gone.
    expect(src).not.toMatch(/const email = hintEmail \|\|/);
  });
  it("a sale reads billing_agreement_id first (its own id is the SALE id)", () => {
    expect(src).toMatch(/isSale\s*[\r\n ]*\?\s*resource\.billing_agreement_id \?\? resource\.id/);
  });
});

describe("wa/ping fails CLOSED", () => {
  const src = read("src/app/api/wa/ping/route.ts");
  it("refuses with 403 when the token cannot be derived, before doing any work", () => {
    expect(src).toMatch(/if \(!expected\) \{[\s\S]*?status: 403/);
    // The old fail-open shape (guarding only the check on `if (expected)`) is gone.
    expect(src).not.toMatch(/const hosts = await pingAllHosts\(\);[\s\S]{0,40}if \(expected\) \{\s*const token/);
  });
});

describe("admin erase targets the RIGHT column on every table", () => {
  const src = read("src/app/api/admin/users/route.ts");
  it("maps each table to its real user column (feedback keys on reporter_email)", () => {
    expect(src).toMatch(/bookings:\s*"user_email"/);
    expect(src).toMatch(/searches:\s*"user_email"/);
    expect(src).toMatch(/feedback:\s*"reporter_email"/);
    expect(src).toMatch(/wa_sessions:\s*"email"/);
    // The old blanket `email=eq.` loop over all four tables must be gone.
    expect(src).not.toMatch(/for \(const table of \["bookings", "searches", "feedback", "wa_sessions"\]\)/);
  });
  it("reports a partial erase instead of answering 200 on a failed purge", () => {
    expect(src).toMatch(/Partial erase/);
    expect(src).toMatch(/status: 500/);
  });
});

describe("auth/forgot is throttled", () => {
  const src = read("src/app/api/auth/forgot/route.ts");
  it("rate-limits per (ip,email) and per ip before touching the password", () => {
    expect(src).toMatch(/rateLimit\("forgot", `\$\{ip\}:\$\{key\}`/);
    expect(src).toMatch(/rateLimit\("forgot-ip", ip/);
  });
  it("also has an IP-INDEPENDENT per-victim bucket, so a rotating attacker cannot spam resets", () => {
    // The `${ip}:${key}` window resets on an IP change; without a key-only
    // bucket a known account could be locked out by repeated reset spam.
    expect(src).toMatch(/rateLimit\("forgot-target", key/);
  });
});

describe("auth/login is throttled and not an enumeration oracle", () => {
  const src = read("src/app/api/auth/login/route.ts");
  it("rate-limits by IP before the first Supabase read", () => {
    expect(src).toMatch(/rateLimit\("login-ip", clientIp\(req\)/);
    // The limit runs before isBlocked/allowedPlanFor/getUser - i.e. before the
    // three reads that made each guess cost real work.
    const ip = src.indexOf('rateLimit("login-ip"');
    const blocked = src.indexOf("isBlocked(email)");
    expect(ip).toBeGreaterThan(0);
    expect(ip).toBeLessThan(blocked);
  });
});

describe("open spend paths are throttled", () => {
  it("feedback POST rate-limits and caps image bytes", () => {
    const src = read("src/app/api/feedback/route.ts");
    expect(src).toMatch(/rateLimit\("feedback"/);
    expect(src).toMatch(/MAX_IMAGE_B64/);
  });
  it("reviews GET rate-limits the billed Places lookup", () => {
    const src = read("src/app/api/reviews/route.ts");
    expect(src).toMatch(/rateLimit\("reviews"/);
  });
});

describe("setConfig no longer pins an instance after a failed save", () => {
  const src = read("src/lib/runtime-config.ts");
  it("clears the in-memory value on a successful durable save", () => {
    // The delete must sit on the success path, right before {ok:true,persistent:true}.
    expect(src).toMatch(/delete s\.mem\[name\];\s*[\r\n]\s*return \{ ok: true, persistent: true \}/);
  });
  it("guards the vault encryption key in production", () => {
    expect(src).toMatch(/function cryptoKey\(\): Buffer \{[\s\S]*?NODE_ENV === "production"[\s\S]*?throw new Error/);
  });
});

describe("revocation is not advisory, and a fresh read is really fresh", () => {
  it("getSession refuses a blocked account", () => {
    const src = read("src/lib/session.ts");
    expect(src).toMatch(/rec\?\.status === "blocked"\) return null/);
  });
  it("getUser({fresh}) distinguishes a gone row from a transient error", () => {
    const src = read("src/lib/access.ts");
    expect(src).toMatch(/if \(opts\?\.fresh\) \{[\s\S]*?sbSelectStrict[\s\S]*?return undefined/);
  });
});
