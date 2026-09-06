import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import {
  pulse,
  queueDepth,
  turnLatency,
  providerErrors,
  pushBreadcrumbs,
  HEARTBEAT_STALE_MS,
} from "./vitals";
import { distinctThreads } from "../kpis";
import { judgeMove } from "../learning/outcomes";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const NOW = 1_700_000_000_000;

// A GREEN DASHBOARD OVER A DEAD SYSTEM.

describe("the watchdog's watchdog", () => {
  it("REPRODUCTION: never-pinged and stopped-pinging are DIFFERENT failures", () => {
    // Nothing has ever pinged means the schedule was never created; stale means
    // it exists and is failing. Reporting both as "down" sent the owner looking
    // in the wrong place.
    expect(pulse(null, NOW).state).toBe("never");
    expect(pulse(new Date(NOW - HEARTBEAT_STALE_MS - 1).toISOString(), NOW).state).toBe("stale");
  });

  it("...and each says what to DO - a red tile with no next step is anxiety", () => {
    expect(pulse(null, NOW).action).toMatch(/never created/i);
    expect(pulse(new Date(NOW - 3600_000).toISOString(), NOW).action).toMatch(/ran and stopped/i);
    expect(pulse(new Date(NOW - 60_000).toISOString(), NOW).action).toBeNull();
  });

  it("a recent ping is beating, with its real age", () => {
    const p = pulse(new Date(NOW - 120_000).toISOString(), NOW);
    expect(p.state).toBe("beating");
    expect(p.ageMs).toBe(120_000);
  });

  it("an unparseable timestamp is 'never', not a crash or a false green", () => {
    expect(pulse("not a date", NOW).state).toBe("never");
  });
});

describe("a deep queue is fine; a LATE queue is not", () => {
  it("only rows whose time has passed count as overdue", () => {
    const rows = [
      { not_before: new Date(NOW - 600_000).toISOString() },
      { not_before: new Date(NOW - 60_000).toISOString() },
      { not_before: new Date(NOW + 600_000).toISOString() },
    ];
    const q = queueDepth(rows, NOW);
    expect(q.waiting).toBe(3);
    expect(q.overdue).toBe(2);
    expect(q.oldestOverdueMs).toBe(600_000);
  });

  it("a queue that is entirely in the future is not late at all", () => {
    const q = queueDepth([{ not_before: new Date(NOW + 60_000).toISOString() }], NOW);
    expect(q.overdue).toBe(0);
    expect(q.oldestOverdueMs).toBeNull();
  });

  it("an empty queue reports zeroes, not nulls the UI has to guess about", () => {
    expect(queueDepth([], NOW)).toEqual({ waiting: 0, overdue: 0, oldestOverdueMs: null });
  });
});

describe("REPRODUCTION: 'no key' and 'every key failing' looked identical", () => {
  const rows = [
    { detail: JSON.stringify({ latencyMs: 1000, providerError: null }) },
    { detail: JSON.stringify({ latencyMs: 3000, providerError: "429 rate limited" }) },
    { detail: JSON.stringify({ latencyMs: 2000, providerError: "429 rate limited" }) },
    { detail: "not json" },
  ];

  it("the reasons are aggregated, most frequent first", () => {
    const e = providerErrors(rows);
    expect(e.degraded).toBe(2);
    expect(e.total).toBe(4);
    expect(e.reasons[0]).toEqual({ reason: "429 rate limited", count: 2 });
  });

  it("a clean window reports nothing to look at", () => {
    expect(providerErrors([{ detail: JSON.stringify({ latencyMs: 5 }) }]).degraded).toBe(0);
  });

  it("latency percentiles come from the same stamps", () => {
    const l = turnLatency(rows);
    expect(l.samples).toBe(3);
    expect(l.p50).toBe(2000);
    expect(l.p95).toBe(3000);
  });

  it("an unparseable row is not a latency of zero", () => {
    expect(turnLatency([{ detail: "{" }]).samples).toBe(0);
    expect(turnLatency([{ detail: "{" }]).p50).toBeNull();
  });
});

describe("a skip is a decision; a failure is a traveller who was not told", () => {
  it("they are counted separately, and the rate is over ATTEMPTS", () => {
    const b = pushBreadcrumbs([
      { kind: "push-sent" },
      { kind: "push-sent" },
      { kind: "push-failed" },
      { kind: "push-skipped" },
      { kind: "push-skipped" },
    ]);
    expect(b).toEqual({ sent: 2, failed: 1, skipped: 2, failureRate: 33.3 });
  });

  it("no attempts means no rate to report, not a zero", () => {
    expect(pushBreadcrumbs([{ kind: "push-skipped" }]).failureRate).toBeNull();
  });
});

describe("REPRODUCTION: escalation was measured per TURN, not per conversation", () => {
  it("a thread with twelve turns counts once", () => {
    // The denominator was the raw count of engine-v3-turn events, so the rate
    // was divided by the average conversation length - and the number that
    // decides whether the agents run unattended was wrong by an order of
    // magnitude, in the flattering direction.
    const rows = Array.from({ length: 12 }, () => ({ user_email: "a@b.c", vendor_id: "v1" }));
    expect(distinctThreads(rows)).toBe(1);
  });

  it("two shops for one traveller are two conversations", () => {
    expect(
      distinctThreads([
        { user_email: "a@b.c", vendor_id: "v1" },
        { user_email: "a@b.c", vendor_id: "v2" },
      ])
    ).toBe(2);
  });

  it("the same shop for two travellers is two conversations", () => {
    expect(
      distinctThreads([
        { user_email: "a@b.c", vendor_id: "v1" },
        { user_email: "d@e.f", vendor_id: "v1" },
      ])
    ).toBe(2);
  });

  it("unattributed legacy rows share ONE bucket rather than being dropped", () => {
    // Dropping them would understate the denominator and inflate the rate all
    // over again.
    expect(distinctThreads([{}, { user_email: "a@b.c" }, { vendor_id: "v1" }])).toBe(1);
  });

  it("email case does not split a conversation in two", () => {
    expect(
      distinctThreads([
        { user_email: "A@B.c", vendor_id: "v1" },
        { user_email: "a@b.c", vendor_id: "v1" },
      ])
    ).toBe(1);
  });

  it("and the KPI actually uses it", () => {
    const kpis = readCode("src/lib/kpis.ts");
    expect(kpis).toMatch(/const escalated = distinctThreads\(takeovers\);/);
    expect(kpis).toMatch(/const conversations = distinctThreads\(threads\);/);
  });
});

describe("REPRODUCTION: the learning panel was fed by a dead engine", () => {
  it("a price that came down is a win, scored by how far", () => {
    expect(judgeMove(300, 240)).toEqual({ won: true, discountPct: 20 });
  });

  it("a price that did not move is a loss, not silence", () => {
    expect(judgeMove(300, 300)).toEqual({ won: false, discountPct: 0 });
  });

  it("a price that went UP teaches nothing - it is usually a misread", () => {
    // Scoring it as a negative would learn the wrong lesson from a different
    // vehicle or a different duration.
    expect(judgeMove(300, 400)).toBeNull();
  });

  it("a missing price is silence, never a fabricated outcome", () => {
    expect(judgeMove(null, 200)).toBeNull();
    expect(judgeMove(300, null)).toBeNull();
    expect(judgeMove(0, 200)).toBeNull();
    expect(judgeMove(NaN, 200)).toBeNull();
  });

  it("the SPTE turn credits the move the shop just answered", () => {
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/const \{ learnFromReply \} = await import\("\.\.\/learning\/outcomes"\);/);
    expect(live).toMatch(/previousQuote: tc\.thread\.digest\.quotedPricePerDay,/);
    expect(live).toMatch(/newQuote: tc\.inbound\.verified\.pricePerDay,/);
  });

  it("...and reads the tactic off the message we actually sent", () => {
    const last = readCode("src/lib/learning/last-move.ts");
    expect(last).toMatch(/direction=eq\.outbound&raw->>sender=eq\./);
    expect(last).toMatch(/raw\?\.tacticId \?\? raw\?\.move/);
  });
});

describe("the ban-risk alert points at the screen that can answer it", () => {
  it("REPRODUCTION: it sent the owner to the orchestrator", () => {
    // Number reputation - trust score, pause state, block and read rates - is
    // rendered on the Command tab. The Agents tab has nothing about WhatsApp
    // numbers at all, so the one tap the owner makes when a number is
    // auto-paused took them somewhere that could not help.
    const cmd = readCode("src/app/api/admin/command/route.ts");
    const banBlock = cmd.slice(cmd.indexOf("AUTO-PAUSED"), cmd.indexOf("AI provider failures"));
    expect(banBlock).not.toMatch(/href: "agents"/);
    expect(banBlock.match(/href: "command"/g)?.length).toBe(3);
  });
});

describe("the health surface reports the vitals, not only the roll call", () => {
  const route = readCode("src/app/api/admin/health/route.ts");
  const panel = readCode("src/components/HealthPanel.tsx");

  it("the route computes all five, and threads an unreadable store through as null (F090)", () => {
    expect(route).toMatch(/heartbeat: pulse\(/);
    // The pure reducers keep their contract (an empty array IS 0/0/null); the
    // route decides between "empty" and "unknown" BEFORE calling them, and
    // never hands a dark read to a reducer as if it were an empty table.
    expect(route).toMatch(/queue: queued === null \? null : queueDepth\(/);
    expect(route).toMatch(/turnLatencyMs: turns60 === null \? null : turnLatency\(/);
    expect(route).toMatch(/providerErrors: turns60 === null \? null : providerErrors\(/);
    expect(route).toMatch(/push24h: pushes24 === null \? null : pushBreadcrumbs\(/);
    expect(route).toMatch(/queueUnreadable: queued === null/);
    // The three feeds read through sbSelectDark, not the permissive sbSelect.
    expect(route).toMatch(/sbSelectDark<\{ not_before: string \}>\(\s*"wa_outbox"/);
    expect(route).not.toMatch(/sbSelect<\{ not_before: string \}>/);
    // Executed coverage: src/app/api/admin/health/queue-unreadable.test.ts.
  });

  it("the panel renders a dash for an unreadable queue, never 'queue 0'", () => {
    expect(panel).toMatch(/vitals\.queue === null \?/);
    expect(panel).toMatch(/outbox unreadable/);
  });

  it("the panel renders the heartbeat RED when it is not beating", () => {
    expect(panel).toMatch(/vitals\.heartbeat\.state === "beating"/);
    expect(panel).toMatch(/NEVER - nothing has ever pinged the drain/);
    expect(panel).toMatch(/\{vitals\.heartbeat\.action\}/);
  });

  it("...and shows the provider reasons, not just a count", () => {
    expect(panel).toMatch(/vitals\.providerErrors\.reasons\.map/);
  });
});
