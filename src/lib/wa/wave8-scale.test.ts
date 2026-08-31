import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { gapBucket, RECIPIENT_LOCK_SEC, HARD_MIN_GAP_SEC } from "./pacing";

// WAVE 8 - SCALE WITHOUT TOUCHING THE ANTI-BAN SPINE.
//
// The owner's "7 shops at once stall" had four compounding mechanisms; this
// wave removes the three that were queueing artefacts (penalty stacking, the
// global reply budget, the per-send probe/history cost) and deliberately
// KEEPS the one that is an anti-ban constant (the per-traveller fleet gap).

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// DO-NOT-TOUCH PIN: the anti-ban constants are load-bearing.
//
// These numbers are the product's ban-risk posture, reviewed as a set. A
// failing assertion here is not a broken test - it is a PACING CHANGE, and it
// needs the same deliberate review the original numbers got. Scale work may
// remove queueing artefacts around them; it may not move them.
// ---------------------------------------------------------------------------

describe("anti-ban constants stay exactly where the review left them", () => {
  it("the hard per-shop floor is 8s and the recipient mutex rides it", () => {
    expect(HARD_MIN_GAP_SEC).toBe(8);
    expect(RECIPIENT_LOCK_SEC).toBe(HARD_MIN_GAP_SEC);
  });

  it("the reply fleet gap stays max(5, min_gap/2) - 6s at the default 12s", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/Math\.max\(5, Math\.round\(\(p\.min_gap_seconds \|\| 12\) \/ 2\)\)/);
    expect(guard).toMatch(/min_gap_seconds: 12,/);
  });

  it("the cold lane still allows only 2 intros per sender per invocation", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/rfqBySender\.get\(cand\.sender_key\) \?\? 0\) >= 2/);
  });
});

// ---------------------------------------------------------------------------
// The fairness fixes themselves.
// ---------------------------------------------------------------------------

describe("losing a seconds-scale lane WAITS to its edge instead of re-parking", () => {
  it("claimSendSlots names when the refusing lane frees, on every pacing refusal", () => {
    const pacing = readCode("src/lib/wa/pacing.ts");
    // One retryAtMs per refusal site: mutex, mutex straddle, gap, gap
    // straddle, fleet, fleet straddle.
    expect((pacing.match(/retryAtMs:/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(pacing).toMatch(/\(fleetBucket \+ 1\) \* opts\.fleetGapSeconds \* 1000/);
  });

  it("the bucket-edge arithmetic is the bucket function's own", () => {
    // The edge of bucket N is where bucket N+1 begins - by construction.
    const now = 1_000_000_000_000;
    const gap = 6;
    const b = gapBucket(now, gap);
    const edge = (b + 1) * gap * 1000;
    expect(gapBucket(edge, gap)).toBe(b + 1);
    expect(gapBucket(edge - 1, gap)).toBe(b);
  });

  it("the drain waits bounded (per-loss ceiling + shared allowance), replies only", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/REPLY_WAIT_CEILING_MS = 8_000/);
    expect(guard).toMatch(/waitAllowanceMs = 15_000/);
    expect(guard).toMatch(/waitMs <= REPLY_WAIT_CEILING_MS && waitMs <= waitAllowanceMs/);
    // One re-claim, not a loop: the second loss re-parks as before.
    expect(guard).toMatch(/claim = await claimSendSlots\(claimArgs\)/);
  });

  it("the inline engine path waits once too, and parks via parkOutboxOnce on a real loss", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    expect(engine).toMatch(/typeof claim\.retryAtMs === "number"/);
    // The raw sbInsert that the partial unique index could silently reject
    // (while the caller reported "queued") is gone from this path.
    expect(engine).toMatch(/parkOutboxOnce\(\{\s*senderKey,\s*toNumber,/);
    expect(engine).toMatch(/alreadyHumanized: true/);
  });
});

describe("the reply budget is per sender, like the cold lane always was", () => {
  it("one busy traveller cannot consume the whole invocation's allowance", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/const replyBySender = new Map<string, number>\(\)/);
    expect(guard).toMatch(/REPLY_PER_SENDER = 3/);
    expect(guard).not.toMatch(/let replyBudget = 6/);
    // W-beta30: the GLOBAL ceiling scales with the number of distinct senders
    // that actually have a reply due (3 each, floor 8, cap 24) instead of a
    // flat 8. The per-sender lane is what stops one traveller monopolising an
    // invocation - that is pinned above and unchanged. The flat global was
    // pure queueing latency at fleet scale: with 30 senders each holding one
    // due reply it forced 4 drain cycles, so the last traveller waited
    // minutes for a send the atomic per-sender fleet gap would have allowed
    // immediately. The floor keeps small-fleet behaviour identical.
    expect(guard).toMatch(
      /replyGlobalBudget = Math\.max\(8, Math\.min\(24, dueReplySenders \* REPLY_PER_SENDER\)\)/
    );
    expect(guard).toMatch(/const dueReplySenders = new Set\(/);
  });

  it("the drain has a WALL CLOCK, not just bounded sleeps", () => {
    // Only waitAllowanceMs was bounded, so a loaded invocation could run
    // 60-180s against Cloud Run's 90s kill - and a kill mid-loop leaves every
    // claimed row invisible for the 3-minute claim lease while the in-flight
    // send is ambiguous. Stopping at a deadline hands the remainder to the
    // next invocation cleanly, which the re-park machinery already reports.
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/const drainDeadline = Date\.now\(\) \+ Math\.max\(5_000, opts\?\.budgetMs \?\? 45_000\)/);
    expect(guard).toMatch(/if \(Date\.now\(\) > drainDeadline\)/);
    // ...and the callers pass budgets sized to their own deadlines.
    expect(readCode("src/app/api/wa/tick/route.ts")).toMatch(/budgetMs: 40_000/);
    expect(readCode("src/app/api/wa/reply-tick/route.ts")).toMatch(/budgetMs: 40_000/);
    expect(readCode("src/app/api/wa/ping/route.ts")).toMatch(/budgetMs: 50_000/);
  });
});

describe("per-send cost: the two dominant reads are gone from the hot loop", () => {
  it("the rate check is two exact HEAD counts, not a 300-row body read", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/sbCountDark\(\s*"whatsapp_messages"/);
    expect(evo).not.toMatch(/limit=300/);
    // Fail direction preserved: unreadable holds the send.
    expect(evo).toMatch(/dayCount === null \|\| hourCount === null/);
  });

  it("a recently-open socket is cached briefly; link/status flows stay fresh", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/OPEN_STATE_TTL_MS = 45_000/);
    // Only the OPEN verdict is cached - caching a non-open state would delay
    // recovery detection, the direction that hurts.
    expect(evo).toMatch(/openStateCache\(\)\.delete\(email\)/);
    // The connect/QR flows and the status page must see live truth.
    expect((evo.match(/\{ fresh: true \}/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(readCode("src/app/api/wa/status/route.ts")).toMatch(/fresh: true/);
  });

  it("the claims GC is genuinely throttled and the schema carries its index", () => {
    const pacing = readCode("src/lib/wa/pacing.ts");
    expect(pacing).toMatch(/GC_EVERY_MS = 5 \* 60_000/);
    expect(pacing).toMatch(/if \(Date\.now\(\) - last < GC_EVERY_MS\) return;/);
    const schema = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");
    expect(schema).toMatch(/wa_send_claims_created_idx on public\.wa_send_claims \(created_at\)/);
  });
});

describe("one ping runs at a time, and it feeds the risk dashboard", () => {
  const ping = readCode("src/app/api/wa/ping/route.ts");

  it("ping takes a 45s single-runner slot; a claims outage still proceeds", () => {
    expect(ping).toMatch(/sender_key: "__ping__"/);
    expect(ping).toMatch(/ping:\$\{Math\.floor\(Date\.now\(\) \/ 45_000\)\}/);
    expect(ping).toMatch(/skipped: "another ping is already running"/);
  });

  it("the hourly risk rollup finally has a production runner", () => {
    // It lived only in the undeployed BullMQ scheduler, so wa_risk_snapshots
    // was never written and the ban-risk panel was permanently dark.
    expect(ping).toMatch(/rollupBucket\(Date\.now\(\)\)/);
  });
});

describe("admission control and the recovery roster", () => {
  it("the inbound gate's patience fits under Cloud Run's 90s ceiling", () => {
    const gate = readCode("src/lib/wa/inbound-gate.ts");
    expect(gate).toMatch(/MAX_WAIT_MS = 20_000/);
    expect(gate).not.toMatch(/MAX_WAIT_MS = 8_000/);
  });

  it("the recovery sweep's roster is the linked fleet, not the loudest senders", () => {
    const sync = readCode("src/lib/wa-sync.ts");
    expect(sync).toMatch(/"wa_sessions",\s*"select=email&status=eq\.open/);
  });

  it("the status poll's drain budget matches its two siblings (3s, not 8s twice)", () => {
    const status = readCode("src/app/api/wa/status/route.ts");
    expect(status).toMatch(/DRAIN_BUDGET_MS = 3_000/);
  });
});

describe("AI RPM buckets go fleet-wide when Redis exists", () => {
  it("the chain consumes through the Redis-backed path with owner overrides", () => {
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/tryConsumeFleet/);
    expect(ai).toMatch(/AI_RPM_\$\{name\.toUpperCase\(\)\}/);
    expect(ai).toMatch(/ai-rpm:\$\{name\}:\$\{Math\.floor\(Date\.now\(\) \/ 60_000\)\}/);
    // A Redis hiccup degrades to the in-process bucket, never to a refusal.
    expect(ai).toMatch(/return tryConsume\(name, Date\.now\(\), capacity\)/);
  });

  it("tryConsume accepts the resolved capacity without changing its default behavior", async () => {
    const { tryConsume, resetRpmBuckets } = await import("../ai-rpm");
    resetRpmBuckets();
    const t0 = 1_000_000_000_000;
    // Two-capacity override: third call in the same minute is refused.
    expect(tryConsume("groq", t0, 2)).toBe(true);
    expect(tryConsume("groq", t0, 2)).toBe(true);
    expect(tryConsume("groq", t0, 2)).toBe(false);
    resetRpmBuckets();
    // No override: the published default still applies (30 for groq).
    for (let i = 0; i < 30; i++) expect(tryConsume("groq", t0)).toBe(true);
    expect(tryConsume("groq", t0)).toBe(false);
  });
});
