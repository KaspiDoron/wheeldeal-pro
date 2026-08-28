import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { POLICY_SPEC, policyRowValue } from "./policy-values";
import { turnLatencyStats, percentile } from "./turn-latency";
import { isEnglishSpeaking } from "../locale";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// The engaged lane got faster. That is only allowed if every floor it could
// possibly outrun is still exactly where it was - and provably so.

describe("THE FLOORS ARE UNCHANGED", () => {
  const pacing = readCode("src/lib/wa/pacing.ts");
  const guard = readCode("src/lib/wa-guard.ts");

  it("the cold-batch hard minimum gap is still 8s", () => {
    expect(pacing).toMatch(/HARD_MIN_GAP_SEC = 8/);
  });

  it("the reply fleet gap still floors at 5s in CODE, whatever the DB says", () => {
    expect(guard).toMatch(/return Math\.max\(5, Math\.round\(\(p\.min_gap_seconds \|\| 12\) \/ 2\)\)/);
  });

  it("the burst window, day cap and per-shop min gap are untouched", () => {
    expect(guard).toMatch(/burst_window_seconds: 600/);
    expect(guard).toMatch(/burst_max_in_window: 45/);
    expect(guard).toMatch(/day_cap: 220/);
    expect(guard).toMatch(/min_gap_seconds: 12/);
  });

  it("the claim protocol still fails CLOSED when the table is unreadable", () => {
    expect(pacing).toMatch(/kind: "error"/);
  });
});

describe("a dial may not promise what the engine will override", () => {
  it("reply_gap_seconds cannot be clamped below the real 5s fleet floor", () => {
    // A row saying 1 never produced 1s spacing - the atomic fleet slot refused
    // it - so the knob was simply lying about what would happen.
    expect(POLICY_SPEC.reply_gap_seconds).toEqual({ kind: "number", min: 5, max: 600 });
    expect(policyRowValue("reply_gap_seconds", "1", 5)).toBe(5); // rejected, default survives
    expect(policyRowValue("reply_gap_seconds", "4", 5)).toBe(5);
    expect(policyRowValue("reply_gap_seconds", "7", 5)).toBe(7); // a real value still applies
  });
});

describe("the human delay got shorter, never shorter than the fleet gap", () => {
  const loop = readCode("src/lib/agent-loop.ts");

  it("close/answer replies think 6-15s, bargains 10-25s", () => {
    expect(loop).toMatch(/6 \+ Math\.floor\(Math\.random\(\) \* 10\)/);
    expect(loop).toMatch(/10 \+ Math\.floor\(Math\.random\(\) \* 16\)/);
  });

  it("the lower bound stays at or above the ~6s fleet gap", () => {
    // Below the fleet gap the claim would just re-park the message, so the cut
    // would buy nothing and only make the pacing less predictable.
    const bounds = [...loop.matchAll(/(\d+) \+ Math\.floor\(Math\.random\(\) \* \d+\)/g)].map((m) =>
      Number(m[1])
    );
    expect(bounds.length).toBeGreaterThan(0);
    for (const low of bounds) expect(low).toBeGreaterThanOrEqual(6);
  });

  it("a strategist WAIT is still clamped so it cannot blow the ceiling", () => {
    expect(loop).toMatch(/Math\.min\(strat\.waitSeconds, 90\)/);
  });

  it("the delay is SCHEDULING - every parked row is re-gated at drain time", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/claimSendSlots\(\{/);
    expect(guard).toMatch(/guardOutbound/);
  });
});

describe("every send site is claim-gated", () => {
  const loop = readCode("src/lib/agent-loop.ts");

  it("the legacy direct-send branch claims before it sends", () => {
    // guardOutbound's checks are read-then-act, so N concurrent turns for one
    // sender all passed them together - this was the only send site with no
    // atomic slot behind it, and a faster lane makes that race seconds wide.
    const i = loop.indexOf("const claim = await claimForSend(");
    const j = loop.indexOf("await opts.send(from, verdict.text)");
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
  });

  it("a DEFINITIVE failed send frees its message slot so the retry is not a self-duplicate", () => {
    // An ambiguous (status-0) failure keeps the claim - it may have landed, and
    // releasing it is how a duplicate followed (OR11 H2.2, now honoured here too).
    expect(loop).toMatch(
      /if \(!result\.ok && !result\.ambiguous\) await releaseSendClaim\(senderKey, from, verdict\.text\)/
    );
  });
});

describe("a parked reply is drained when it comes due, not when a heartbeat happens", () => {
  it("park arms a drain, without importing a queue into the Next bundle", () => {
    const park = readCode("src/lib/wa/park.ts");
    expect(park).toMatch(/export function setDrainArmer/);
    // The arm carries the sender so the Next armer can kick the PER-SENDER
    // reply dispatcher (a hop=0 kick at the global tick loses to a live cold
    // chain - the exact starvation reply-tick was built to end).
    expect(park).toMatch(/armDrainAt\(row\.notBeforeMs, row\.senderKey\)/);
    expect(park).toMatch(/armReplyDrain\(row\.notBeforeMs, row\.senderKey\)/);
    expect(park).not.toMatch(/bullmq/);
  });

  it("the Next armer kicks over HTTP, never drains in a dying invocation", () => {
    // Cloud Run freezes CPU once the response is flushed - a timer that tried
    // to drain in-process would freeze mid-write. The timer's only action is a
    // self-kick; the kicked dispatcher runs with its own CPU allocation.
    const armer = readCode("src/lib/wa/drain-armer.ts");
    expect(armer).toMatch(/kickDispatcher\(/);
    expect(armer).toMatch(/api\/wa\/reply-tick/);
    expect(armer).not.toMatch(/drainOutbox/);
    // Bounded: beyond the cron's own cadence, arming buys nothing.
    expect(armer).toMatch(/ARM_HORIZON_MS = 90_000/);
    // Never keeps the process alive (tests, local dev, shutdown).
    expect(armer).toMatch(/timer\.unref\?\.\(\)/);
  });

  it("the worker runtime supplies it, collapsing same-second arms to one job", () => {
    const sched = readCode("services/workers/src/scheduler.worker.ts");
    expect(sched).toMatch(/setDrainArmer\(\(atMs\) => \{/);
    expect(sched).toMatch(/delay,/);
    expect(sched).toMatch(/jobId: `drain-at-\$\{Math\.floor\(atMs \/ 1000\)\}`/);
  });

  it("the Next runtime keeps its self-chaining tick (it has no worker)", () => {
    expect(readCode("src/lib/wa/ingest.ts")).toMatch(/api\/wa\/tick\?token=/);
  });
});

describe("work that does not depend on the turn no longer waits for it", () => {
  it("the safety screen starts before the extraction, not after", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    const screen = loop.indexOf('await import("./inbound-risk")');
    const extract = loop.indexOf("const extraction =");
    expect(screen).toBeGreaterThan(0);
    expect(screen).toBeLessThan(extract);
  });

  it("English is not translated into English", () => {
    // Region-keyed localization spent up to two 9s LLM round trips returning
    // the text it was given, on the critical path between composing and sending.
    expect(isEnglishSpeaking("Kuta, Bali, Indonesia")).toBe(false);
    expect(isEnglishSpeaking("Ko Pha-ngan, Thailand")).toBe(false);
    expect(isEnglishSpeaking("Brighton, United Kingdom")).toBe(true);
    expect(isEnglishSpeaking("Singapore")).toBe(true);
    expect(isEnglishSpeaking(undefined)).toBe(false);
    // `source` is `message` with the free/available ambiguity already rewritten -
    // that rail is about meaning, so it runs even when no translation happens.
    expect(readCode("src/lib/agents.ts")).toMatch(
      /if \(isEnglishSpeaking\(region\)\) return \{ text: source, localized: false, reason: "english-region" \}/
    );
  });

  it("an unlisted country still behaves exactly as before", () => {
    // The list is a latency optimisation, never a correctness gate.
    expect(isEnglishSpeaking("Lisbon, Portugal")).toBe(false);
  });
});

describe("the speed claim is now a measurement", () => {
  const sample = (composeMs: number, plannedDelayS: number, outcome = "parked") =>
    JSON.stringify({ composeMs, plannedDelayS, outcome });

  it("percentiles are nearest-rank - never a latency that did not happen", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 50)).toBeNull();
  });

  it("compose time and total time are reported separately", () => {
    const s = turnLatencyStats([
      sample(2_000, 10),
      sample(4_000, 12),
      sample(30_000, 15, "sent"),
    ]);
    expect(s.samples).toBe(3);
    expect(s.composeP50).toBe(4_000);
    expect(s.composeP95).toBe(30_000);
    expect(s.totalP50Sec).toBe(16); // 4s chain + 12s pacing
    expect(s.totalP95Sec).toBe(45); // 30s chain + 15s pacing
    expect(s.parked).toBe(2);
    expect(s.sent).toBe(1);
  });

  it("a malformed row is dropped, never counted as a fast turn", () => {
    const s = turnLatencyStats(["not json", null, undefined, sample(-5, 10), sample(1_000, 8)]);
    expect(s.samples).toBe(1);
    expect(s.composeP50).toBe(1_000);
  });

  it("no data reads as no data, not as zero latency", () => {
    const s = turnLatencyStats([]);
    expect(s.samples).toBe(0);
    expect(s.composeP50).toBeNull();
    expect(s.totalP95Sec).toBeNull();
  });

  it("the engine stamps one event per composed turn, fire-and-forget", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/kind: "turn-latency"/);
    expect(loop).toMatch(/outcome: "parked"/);
    expect(loop).toMatch(/outcome: result\.ok \? "sent" : "send-failed"/);
    expect(loop).toMatch(/function stampTurnLatency\(/);
    expect(loop).toMatch(/void sbInsert\("agent_events"/);
  });
});

describe("the doctor can see the floors, not just trust them", () => {
  const route = readCode("src/app/api/admin/wa-doctor/route.ts");

  it("it checks the pacing claim table exists at all", () => {
    // Pre-migration the guard fails OPEN: every time-based check still passes,
    // so nothing turned red while the only atomic floor was simply absent.
    expect(route).toMatch(/sbSelect<\{ slot_key: string \}>\("wa_send_claims"/);
    expect(route).toMatch(/claimsTable/);
    const card = readCode("src/components/admin/WaDoctorCard.tsx");
    expect(card).toMatch(/floors are not enforced/);
  });

  it("it reports p50/p95 reply speed for the user being diagnosed", () => {
    expect(route).toMatch(/kind=eq\.turn-latency&user_email=eq\./);
    expect(route).toMatch(/turnLatencyStats\(/);
    expect(readCode("src/components/admin/WaDoctorCard.tsx")).toMatch(
      /Engaged reply \(p50 \/ p95\)/
    );
  });
});
