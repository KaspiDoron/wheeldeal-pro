import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { refill, tryConsume, spentProviders, resetRpmBuckets, DEFAULT_RPM } from "./ai-rpm";
import { sweepCapForFleet, rotateWindow } from "./wa/sweep";
import {
  withInboundSlot,
  inboundInflight,
  resetInboundGate,
} from "./wa/inbound-gate";
import { WHISPER_DAILY_CAP, WHISPER_SOFT_FRACTION } from "./usage";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// OWNER REPORT 4, WAVE 3.2 - scale to hundreds. The break-first items: the AI
// chain must spill before the 429, the recovery sweep must scale with the
// fleet, heavy turns must be bounded per instance, and the launch card must
// tell the truth.

describe("scale #5 - per-provider RPM budgeter", () => {
  beforeEach(() => resetRpmBuckets());

  it("a bucket refills at capacity-per-minute, never past capacity", () => {
    const b = { tokens: 0, updatedAt: 0, capacity: 60 };
    // 60/min = 1/sec: 10s later, ~10 tokens back.
    expect(refill(b, 10_000).tokens).toBeCloseTo(10, 5);
    // A full minute refills to capacity and no further.
    expect(refill(b, 120_000).tokens).toBe(60);
  });

  it("consumes a token per call and REFUSES once the minute is spent", () => {
    const cap = DEFAULT_RPM.sambanova; // 20
    let now = 1_000_000;
    for (let i = 0; i < cap; i++) expect(tryConsume("sambanova", now)).toBe(true);
    expect(tryConsume("sambanova", now)).toBe(false); // spent
    // A minute later the bucket has fully refilled.
    now += 60_000;
    expect(tryConsume("sambanova", now)).toBe(true);
  });

  it("a provider with no known ceiling always fits, consuming nothing", () => {
    expect(tryConsume("some-future-provider", 0)).toBe(true);
    expect(spentProviders(0)).toEqual([]);
  });

  it("spentProviders reports exactly the dry buckets (the spillover depth)", () => {
    const now = 500_000;
    while (tryConsume("groq", now)) {
      /* drain groq */
    }
    expect(spentProviders(now)).toContain("groq");
  });

  it("the chain skips a spent rung BEFORE the 429, but never the last rung", () => {
    // Wave 8: the consume goes through the fleet-backed path (Redis when
    // REDIS_URL is set, the in-process bucket otherwise) - the skip-the-spent
    // and never-the-last-rung semantics are unchanged.
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/const \{ tryConsume, DEFAULT_RPM \} = await import\("\.\/ai-rpm"\)/);
    expect(ai).toMatch(/if \(idx < list\.length - 1 && !\(await tryConsumeFleet\(cfg\.name\)\)\)/);
  });
});

describe("scale #5 - Whisper daily-cap metering", () => {
  it("the soft cap is 80% of the free 2k/day global pool", () => {
    expect(WHISPER_DAILY_CAP).toBe(2_000);
    expect(WHISPER_SOFT_FRACTION).toBe(0.8);
  });

  it("transcribe skips Groq and falls to Gemini past the soft cap", () => {
    const t = readCode("src/lib/graph/transcribe.ts");
    expect(t).toMatch(/whisperOverSoftCap/);
    expect(t).toMatch(/if \(token && groqBudgetLeft\)/);
    // A metering blip must never disable transcription.
    expect(t).toMatch(/whisperOverSoftCap\(\)\.catch\(\(\) => false\)/);
  });
});

describe("scale #9 - the recovery sweep scales with the fleet", () => {
  it("ceil(fleet/20), floored 3, capped 10", () => {
    expect(sweepCapForFleet(1)).toBe(3);
    expect(sweepCapForFleet(12)).toBe(3);
    expect(sweepCapForFleet(60)).toBe(3);
    expect(sweepCapForFleet(80)).toBe(4);
    expect(sweepCapForFleet(300)).toBe(10); // capped
    expect(sweepCapForFleet(10_000)).toBe(10);
  });

  it("full-window rotation covers 300 users in ceil(300/10)=30 ticks (was ~300)", () => {
    const fleet = Array.from({ length: 300 }, (_, i) => `u${i}@x.com`);
    const cap = sweepCapForFleet(fleet.length); // 10
    const seen = new Set<string>();
    for (let m = 0; m < 30; m++) for (const e of rotateWindow(fleet, m, cap)) seen.add(e);
    expect(seen.size).toBe(300); // everyone covered within 30 minutes
  });

  it("the ping route uses the proportional cap with a full-window rotation", () => {
    const ping = readCode("src/app/api/wa/ping/route.ts");
    expect(ping).toMatch(/rotateWindow\(roster, minute, sweepCapForFleet\(roster\.length\)\)/);
    expect(ping).not.toMatch(/pickSweepEmails\(senders, minute, 3\)/);
  });
});

describe("scale #7 - bounded concurrency for heavy inbound turns", () => {
  beforeEach(() => resetInboundGate());

  it("runs up to 4 turns concurrently, queues the rest, never drops one", async () => {
    let peak = 0;
    let running = 0;
    const gate = (ms: number) =>
      withInboundSlot(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, ms));
        running--;
        return "done";
      });
    const results = await Promise.all(Array.from({ length: 12 }, () => gate(20)));
    expect(results).toEqual(Array(12).fill("done")); // all completed
    expect(peak).toBeLessThanOrEqual(4); // never more than 4 at once
    expect(inboundInflight()).toEqual({ inflight: 0, queued: 0 }); // fully drained
  });

  it("a throwing turn still releases its slot (a gate never wedges the counter)", async () => {
    await expect(withInboundSlot(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(inboundInflight().inflight).toBe(0);
  });

  it("ingest wraps the AI turn in the slot", () => {
    expect(readCode("src/lib/wa/ingest.ts")).toMatch(/withInboundSlot\(async \(\) => processVendorReply/);
  });
});

describe("scale #2/#3/#4 - infra shape", () => {
  it("the Cloud Run deploy has the scale shape and passes REDIS_URL", () => {
    const yaml = read(".github/workflows/deploy-gcp.yml");
    expect(yaml).toMatch(/--concurrency 32/);
    expect(yaml).toMatch(/--min-instances 1/);
    expect(yaml).toMatch(/--max-instances 20/);
    expect(yaml).toMatch(/REDIS_URL/);
  });

  it("the retention migration prunes the four unbounded tables and keeps priced rows", () => {
    const sql = read("supabase/retention.sql");
    expect(sql).toMatch(/prune_old_rows/);
    expect(sql).toMatch(/delete from public\.whatsapp_messages/);
    expect(sql).toMatch(/delete from public\.agent_events/);
    expect(sql).toMatch(/delete from public\.agent_traces/);
    expect(sql).toMatch(/api_usage_daily/); // rollup, not a raw delete
    expect(sql).toMatch(/raw ->> 'reading'\) is null/); // priced rows survive
    expect(sql).toMatch(/pg_cron/);
  });
});

describe("scale #10 - the launch KPI card", () => {
  it("assembles the five go/no-go numbers, degrading to null not zero", () => {
    const kpis = readCode("src/lib/ops/launch-kpis.ts");
    expect(kpis).toMatch(/replyLatencyStats/); // true reply p50/p95
    expect(kpis).toMatch(/spentProviders/); // AI spillover depth
    expect(kpis).toMatch(/transportSummary/); // host occupancy + cluster
    expect(kpis).toMatch(/dbGrowth/);
    expect(kpis).toMatch(/degraded/);
  });

  it("the route is management-gated and includes live gate depth", () => {
    const route = readCode("src/app/api/admin/ops/launch-kpis/route.ts");
    expect(route).toMatch(/requireManagement/);
    expect(route).toMatch(/inboundInflight\(\)/);
  });
});
