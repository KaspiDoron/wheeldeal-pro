import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

// OWNER REPORT 10, W2 - THE THREE FINDINGS THE AUDIT FLEET NEVER REVIEWED.
//
// All three were filed as "refuted" only because all three of their skeptics
// errored on a session limit. I verified each by reading the code rather than
// re-running the fleet. Two were real; the third was real in a weaker and more
// useful form than reported.

// ---------------------------------------------------------------------------
// 1. THE `settled_at` CLAIM READ - REAL, and the mechanism is worse than the
//    fleet described.
//
// The report said: on a database where schema.sql has not been re-run, a
// duplicate webhook delivery produces two replies to one shop. I could not
// confirm that from the claim code alone - the fall-through leads to an
// election on `wa_send_claims`, which looks like a dedupe.
//
// It is not one HERE. `sbInsertReturning` returns [] for a duplicate key AND
// for a missing table AND for a network error, so the frame that WON the
// insert proceeds immediately and never enters the election. The frame that
// LOST it reaches `electReplyOwner` alone and wins uncontested. And the read
// that should have stopped it - `select=...,settled_at` - fails on every
// duplicate frame when that additive column is absent, and `.catch(() => [])`
// made that indistinguishable from "no claim row exists".
// ---------------------------------------------------------------------------
describe("the reply claim tells 'cannot read' apart from 'no claim'", () => {
  const src = () => readFileSync("src/lib/agent-loop.ts", "utf8");
  const claimBlock = () => {
    const s = src();
    const start = s.indexOf("if (claimed.length === 0) {");
    return s.slice(start, s.indexOf("// E1 (owner report 6)", start));
  };

  it("no longer swallows the read failure into an empty array", () => {
    // The exact bug shape: a failed select and an empty table looked the same.
    expect(claimBlock()).not.toMatch(/settled_at[\s\S]{0,400}?\.catch\(\(\) => \[\]\)/);
  });

  it("reads through the three-way strict reader, not the lossy one", () => {
    const b = claimBlock();
    expect(b).toMatch(/sbSelectStrict</);
    expect(b).toMatch(/"error" in read/);
  });

  it("STANDS DOWN when a claim exists but cannot be judged, instead of electing", () => {
    const b = claimBlock();
    // The narrowed re-read a pre-migration schema can still answer...
    expect(b).toMatch(/select=wa_message_id&\$\{filter\}/);
    // ...and the two answers that must never reach the election.
    expect(b).toMatch(/bare === null \|\| bare\.length > 0/);
    const guard = b.slice(b.indexOf("bare === null"));
    expect(guard.slice(0, 200)).toMatch(/return;/);
  });

  it("still elects a winner when there is genuinely no claim row", () => {
    // The case the election was written for must survive: the insert failed
    // for a reason other than a duplicate, so nobody holds anything.
    expect(claimBlock()).toMatch(/electReplyOwner/);
  });

  it("electReplyOwner really does fail OPEN, which is why the guard above matters", async () => {
    // Documented as "claims unreachable - never silence a shop". Correct in
    // isolation and exactly why an un-judgeable claim must never get there.
    const src2 = readFileSync("src/lib/wa/inbound-claim.ts", "utf8");
    const fn = src2.slice(src2.indexOf("export async function electReplyOwner"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(/catch \{\s*\n?\s*return true;/);
  });

  it("claimIsDeadTurn still refuses to retake a SETTLED claim", async () => {
    const { claimIsDeadTurn, CLAIM_LEASE_MS } = await import("./wa/inbound-claim");
    const old = new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString();
    expect(claimIsDeadTurn({ created_at: old, settled_at: null })).toBe(true);
    expect(claimIsDeadTurn({ created_at: old, settled_at: old })).toBe(false);
    expect(claimIsDeadTurn({ created_at: new Date().toISOString(), settled_at: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. sbRpc's `missing` DISCRIMINATOR - REAL, as a telemetry hole.
//
// The field existed and its only caller ignored it. The fall-through is
// deliberate and stays (one lost increment beats no write at all), but a 404
// and a REFUSAL are not the same news: a refusal means the atomic function
// exists and rejected the write, which drops the safety counters back to the
// racy path permanently with no symptom. OR8.1 already found one of exactly
// that shape - a fractional trust_score aborting the statement.
// ---------------------------------------------------------------------------
describe("a non-404 rep-bump failure is no longer silent", () => {
  const guard = () => readFileSync("src/lib/wa-guard.ts", "utf8");

  it("the discriminator is read, and only the non-missing case traces", () => {
    const g = guard();
    const at = g.indexOf('sbRpc("wa_rep_bump"');
    expect(at).toBeGreaterThan(0);
    const after = g.slice(at, at + 3600);
    expect(after).toMatch(/if \(!res\.missing\) noteRepBumpDegraded\(senderKey\)/);
    // ...and the fall-through write still happens either way.
    expect(after).toMatch(/sbUpdate\(\s*\n?\s*"whatsapp_number_reputation"/);
  });

  it("the trace is throttled, because it sits on the send path", () => {
    const g = guard();
    expect(g).toMatch(/REP_BUMP_DEGRADED_THROTTLE_MS/);
    const fn = g.slice(g.indexOf("function noteRepBumpDegraded"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/now - last < REP_BUMP_DEGRADED_THROTTLE_MS/);
  });

  it("the kind reaches the owner instead of being written and read by nobody", async () => {
    const { WATCHED_KINDS, DIGEST_KINDS } = await import("./chokepoints");
    expect(WATCHED_KINDS).toContain("wa-rep-bump-degraded");
    // Digest, not page - it is not urgent, it is invisible.
    expect(DIGEST_KINDS).toContain("wa-rep-bump-degraded");
    expect(readFileSync("SCALING.md", "utf8")).toContain("wa-rep-bump-degraded");
  });
});

// ---------------------------------------------------------------------------
// 3. LIMIT_AI_PER_DAY AT 100 USERS - the arithmetic, stated plainly.
//
// It is a per-USER cap, so 100 testers do not share it; one enthusiastic
// tester reaches it alone. A shop reply burns 2-6 model calls, so a 20-shop
// hunt at three rounds is 120-360 calls plus openers - the upper half of ONE
// hunt crosses 300. Raising the number moves the wall; it does not remove it,
// because the real fleet ceiling is the free providers' own daily RPD. So the
// cap stays and the degradation becomes visible.
// ---------------------------------------------------------------------------
describe("the AI daily ceiling, and whether it still binds", () => {
  it("a heavy single hunt can cross the cap - so the ceiling is reachable by one user", async () => {
    const { LIMIT_DEFAULTS } = await import("./usage");
    const cap = LIMIT_DEFAULTS.LIMIT_AI_PER_DAY;
    const shops = 20;
    const rounds = 3;
    const callsPerTurnLow = 2;
    const callsPerTurnHigh = 6;
    expect(shops * rounds * callsPerTurnLow).toBeLessThan(cap); // a light hunt fits
    expect(shops * rounds * callsPerTurnHigh).toBeGreaterThan(cap); // a heavy one does not
  });

  it("the cap is keyed on the EMAIL, so it is per-user and not a fleet pool", () => {
    const src = readFileSync("src/lib/ai-budget.ts", "utf8");
    expect(src).toMatch(/checkDailyLimit\("ai", email, "LIMIT_AI_PER_DAY"/);
  });

  it("exhaustion is recorded once per user per day, and the turn still runs", async () => {
    const inserts: Record<string, unknown>[] = [];
    vi.doMock("./runtime-config", () => ({
      sbInsert: async (_t: string, rows: Record<string, unknown>[]) => {
        inserts.push(...rows);
        return true;
      },
    }));
    vi.doMock("./usage", () => ({
      checkDailyLimit: async () => ({ allowed: false, used: 300, limit: 300 }),
      recordApi: async () => {},
      reserveDailyUnitFor: async () => false,
    }));
    const { runWithAiBudget } = await import("./ai-budget");
    const out = await runWithAiBudget("t@example.com", async () => "ran anyway");
    // The negotiation is NOT frozen - that is the whole design.
    expect(out).toBe("ran anyway");
    await new Promise((r) => setTimeout(r, 5));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].kind).toBe("ai-budget-exhausted");
    expect(String(inserts[0].detail)).toMatch(/deterministic composer/);

    // Second turn, same user, same day: no second row.
    await runWithAiBudget("t@example.com", async () => "again");
    await new Promise((r) => setTimeout(r, 5));
    expect(inserts).toHaveLength(1);
  });

  it("a user INSIDE their budget records nothing", async () => {
    const inserts: Record<string, unknown>[] = [];
    vi.doMock("./runtime-config", () => ({
      sbInsert: async (_t: string, rows: Record<string, unknown>[]) => {
        inserts.push(...rows);
        return true;
      },
    }));
    vi.doMock("./usage", () => ({
      checkDailyLimit: async () => ({ allowed: true, used: 10, limit: 300 }),
      recordApi: async () => {},
      reserveDailyUnitFor: async () => true,
    }));
    const { runWithAiBudget } = await import("./ai-budget");
    await runWithAiBudget("fresh@example.com", async () => "ok");
    await new Promise((r) => setTimeout(r, 5));
    expect(inserts).toHaveLength(0);
  });

  it("the owner can SEE it: the launch card carries the 24h count, fail-dark", () => {
    const kpi = readFileSync("src/lib/ops/launch-kpis.ts", "utf8");
    expect(kpi).toMatch(/aiExhausted: \{ users24h: number \| null \}/);
    expect(kpi).toMatch(/kind=eq\.ai-budget-exhausted/);
    expect(kpi).toMatch(/degraded\.push\("ai-budget"\)/);
    const card = readFileSync("src/components/ops/LaunchKpiCard.tsx", "utf8");
    expect(card).toMatch(/helpId="aiExhausted"/);
  });
});

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock("./usage"));
