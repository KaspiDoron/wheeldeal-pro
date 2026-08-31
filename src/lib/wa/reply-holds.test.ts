import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { replyLatencyStats } from "./turn-latency";
import {
  holdThrottleMsFor,
  HOLD_EVENT_THROTTLE_MS,
  REPLY_HOLD_EVENT_THROTTLE_MS,
} from "./hold-events";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// OWNER REPORT 4, ITEM 3: "make sure the agents' replies land quickly."
//
// The investigation enumerated every hold an ENGAGED reply could hit and found
// six that could exceed two minutes - each one an anti-ban decision written for
// the COLD lane and applied to both. These tests pin the lane split at every
// one of those sites: the cold lane keeps its minute-scale caution (velocity to
// new numbers is the ban vector), the reply lane re-checks on the seconds scale
// its own pacing already runs at. Revert any site to a flat hold and its pin
// goes red.

describe("every >2min hold a reply could hit is now lane-proportional", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("1. the daily-cap resume is only business-hours-clamped for COLD sends", () => {
    // The documented "answer landed at 05:38 next morning" incident: a capped
    // REPLY was snapped to the shop's opening hours. Now the clamp is gated on
    // isNewContact, exactly like gate #2's business-hours exemption.
    expect(guard).toMatch(
      /const until = isNewContact\s*\?\s*clampToBusinessHours\(freeIso, opts\.toDigits, p, region\)\s*:\s*freeIso/
    );
  });

  describe("2. a paused number sends NOTHING - but a reply re-checks instead of sleeping", () => {
    // THIS BLOCK WAS ALL REGEX, AND THAT WAS NOT AN ACCIDENT OF STYLE - it was
    // the only instrument available while the decision was an inline ternary
    // inside `guardOutbound`, which needs Supabase, WhatsApp and a policy store
    // to reach. I checked the audit's claim the honest way: inverting the
    // condition, so cold intros re-check and REPLIES sleep for four hours,
    // passed all 5,700 tests. A pin that survives its own inversion is not a
    // pin. The decision is `pauseRecheckAt` in wa/pacing now, and these run it.
    const NOW = Date.parse("2026-08-24T10:00:00.000Z");
    const mid = () => 0.5; // deterministic jitter

    it("EXECUTED: a COLD INTRO keeps the full horizon - it is the lane under treatment", async () => {
      const { pauseRecheckAt } = await import("./pacing");
      const pausedUntilIso = new Date(NOW + 4 * 3600_000).toISOString();
      expect(
        pauseRecheckAt({ nowMs: NOW, pausedUntilIso, isNewContact: true, rand: mid })
      ).toBe(pausedUntilIso);
    });

    it("EXECUTED: a REPLY under a risk pause re-checks in 10-15min, not 4 hours", async () => {
      const { pauseRecheckAt } = await import("./pacing");
      const pausedUntilIso = new Date(NOW + 240 * 60_000).toISOString(); // the 240min risk pause
      const at = Date.parse(
        pauseRecheckAt({ nowMs: NOW, pausedUntilIso, isNewContact: false, rand: mid })
      );
      const mins = (at - NOW) / 60_000;
      expect(mins).toBeGreaterThanOrEqual(10);
      expect(mins).toBeLessThanOrEqual(15);
    });

    it("EXECUTED: a REPLY under a BAN-RECOVERY pause re-checks too, and the wait is bounded", async () => {
      const { pauseRecheckAt } = await import("./pacing");
      // 24h recovery: the documented worst case. The re-check must never be a
      // disguised sleep-through - it is capped at 45min plus spread.
      const pausedUntilIso = new Date(NOW + 24 * 3600_000).toISOString();
      const mins =
        (Date.parse(
          pauseRecheckAt({ nowMs: NOW, pausedUntilIso, isNewContact: false, rand: mid })
        ) -
          NOW) /
        60_000;
      expect(mins).toBeGreaterThanOrEqual(20); // never a tight retry storm either
      expect(mins).toBeLessThanOrEqual(55); // 45 cap + 10 spread
    });

    it("EXECUTED: THE INVERSION IS CAUGHT - the two lanes can never swap", async () => {
      // The assertion whose absence let an inverted ternary pass everything:
      // whatever the numbers are, a reply must wake up STRICTLY SOONER than a
      // cold intro under the same pause.
      const { pauseRecheckAt } = await import("./pacing");
      for (const hours of [1, 4, 8, 24]) {
        const pausedUntilIso = new Date(NOW + hours * 3600_000).toISOString();
        const reply = Date.parse(
          pauseRecheckAt({ nowMs: NOW, pausedUntilIso, isNewContact: false, rand: mid })
        );
        const cold = Date.parse(
          pauseRecheckAt({ nowMs: NOW, pausedUntilIso, isNewContact: true, rand: mid })
        );
        expect(reply, `${hours}h pause: the reply lane must wake first`).toBeLessThan(cold);
      }
    });

    it("the guard calls the shared decision instead of re-inlining it", () => {
      expect(guard).toMatch(/const until = pauseRecheckAt\(\{/);
      expect(guard).not.toMatch(/const banRecovery = pauseLeftMs > 4 \* 3600_000/);
    });
  });

  it("3. all five fail-closed sync-retry sites share ONE lane-aware hold", () => {
    // Five sites held 5-10min on a transient read blip - for a reply, pure
    // added latency on an engaged shop. One helper, reply 1-2min, cold 5-10.
    expect(guard).toMatch(
      /const syncRetryHold = \(\) =>\s*replyKind \? jitteredHold\(now, 1, 1\) : jitteredHold\(now, 5, 5\)/
    );
    const sites = guard.match(/queue\(syncRetryHold\(\), "sync-retry"\)/g) ?? [];
    expect(sites.length).toBe(5);
    // ...and the lane test matches the drain's own definition of a reply row.
    expect(guard).toMatch(
      /kindStr !== "rfq" && kindStr !== "custom" && kindStr !== "human-manual"/
    );
  });

  it("4. a duplicate-claim hold is 30s for a reply, 120s for a cold intro", () => {
    expect(guard).toMatch(
      /release\(isReplyRow \? 30_000 : 120_000, \{ dupHolds: holds, reason: "human pacing gap" \}\)/
    );
  });

  it("5. the inline claim-loss re-park is sized to the LANE, minutes for cold", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    // W12h: this pinned a flat 20-40s, which was itself the defect. Wave 8's
    // own reasoning - the lanes a reply loses are measured in SECONDS, so
    // anything beyond them is invented latency - had been applied to the drain
    // and NOT to this inline path, the one SPTE actually uses for a live reply.
    // The park now uses the refusing lane's own free-at instant, and falls back
    // to the recipient mutex's length rather than to a flat guess.
    expect(engine).toMatch(/const replyParkMs =/);
    expect(engine).toMatch(/Math\.max\(2_000, Math\.min\(30_000, claim\.retryAtMs - Date\.now\(\)\)\)/);
    expect(engine).toMatch(/RECIPIENT_LOCK_SEC \* 1000 \+ 2_000/);
    // Cold intros keep the minute-scale hold - unchanged, and load-bearing.
    expect(engine).toMatch(/: jitteredHold\(Date\.now\(\), 1, 2\)/);
  });
});

describe("6. the engagement halt cannot terminally delete a REPLY", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("a send stamped composedAgainst a real inbound re-parks instead of dying", () => {
    // By construction a reply answers something the shop said - if the
    // engagement probe reads "never replied", the PROBE is wrong (spelling,
    // replication lag), not the thread. Terminal would DELETE the composed
    // answer; the invariant re-parks it bounded instead.
    expect(guard).toMatch(/if \(stamped && \(stamped\.inboundId \|\| stamped\.inboundAt\)\)/);
  });

  it("the invariant runs BEFORE the terminal drop, and the drop still exists", () => {
    const invariant = guard.indexOf("stamped.inboundId || stamped.inboundAt");
    const terminal = guard.indexOf(
      'recordSendDropped(opts.senderKey, opts.toDigits, "engagement-halt'
    );
    // Proactive follow-ups on silent threads carry no stamp and MUST stay
    // terminally halted - unanswered-thread pressure is the #1 spam signal.
    expect(invariant).toBeGreaterThan(0);
    expect(terminal).toBeGreaterThan(invariant);
  });
});

describe("8. reply latency is measured at the wire, not promised at compose", () => {
  it("the drain stamps inbound->wire only for reply rows with a receipt", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/kind: "reply-latency"/);
    expect(guard).toMatch(/inboundToWireMs: Date\.now\(\) - inboundAtMs/);
    // Only when the row knows what it answered - cold intros answer nothing.
    const gate = guard.indexOf("if (!cold) {");
    const stamp = guard.indexOf('kind: "reply-latency"');
    expect(gate).toBeGreaterThan(0);
    expect(stamp).toBeGreaterThan(gate);
  });

  it("percentiles come from real samples; malformed rows are dropped", () => {
    const s = replyLatencyStats([
      JSON.stringify({ inboundToWireMs: 30_000 }),
      JSON.stringify({ inboundToWireMs: 45_000 }),
      JSON.stringify({ inboundToWireMs: 300_000 }),
      "not json",
      null,
      JSON.stringify({ inboundToWireMs: -5 }),
    ]);
    expect(s.samples).toBe(3);
    expect(s.p50Sec).toBe(45);
    expect(s.p95Sec).toBe(300);
  });

  it("no data reads as no data, never as zero latency", () => {
    const s = replyLatencyStats([]);
    expect(s.samples).toBe(0);
    expect(s.p50Sec).toBeNull();
    expect(s.p95Sec).toBeNull();
  });

  it("the doctor serves the observed number next to the intended one", () => {
    const route = readCode("src/app/api/admin/wa-doctor/route.ts");
    expect(route).toMatch(/kind=eq\.reply-latency&user_email=eq\./);
    expect(route).toMatch(/wire: replyLatencyStats\(/);
  });
});

describe("9. the trail shows every fate a queued message can meet", () => {
  const path = readCode("src/lib/wa/message-path.ts");

  it("expired, stale and both claim outcomes are read into the trail", () => {
    // I1 (owner report 6): the filter is DERIVED from the stage map now, so
    // the fetched kinds and the labels can never drift apart - the old
    // hand-maintained list is exactly how six vision kinds went unfetched.
    expect(path).toMatch(/kind=in\.\(\$\{EVENT_KINDS\}\)/);
    expect(path).toMatch(/const EVENT_KINDS = Object\.keys\(EVENT_STAGE\)\.join\(","\)/);
    expect(path).toMatch(/"wa-send-expired": "send-expired"/);
    expect(path).toMatch(/"wa-send-stale": "send-stale"/);
    expect(path).toMatch(/"claim-lost": "claim-lost"/);
    expect(path).toMatch(/"claim-error": "claim-error"/);
    // ...and the screenshot-only failure classes are in the trail too.
    expect(path).toMatch(/"inbound-dropped": "inbound-dropped"/);
    expect(path).toMatch(/"vision-parse-failed": "vision"/);
    expect(path).toMatch(/"media-fetch-failed": "media"/);
    expect(path).toMatch(/"localize-fallback": "localize"/);
    expect(path).toMatch(/"engine-v3-turn": "engine-turn"/);
  });

  it("the emitting sites stamp the join keys the trail query matches on", () => {
    // The trail filters user_email AND (to_number | vendor_name). These events
    // used to carry neither, so they could never appear - a message showed as
    // "queued" and then NOTHING.
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/async function insertPathEvent/);
    const stale = guard.slice(guard.indexOf('kind: "wa-send-stale"'));
    expect(stale.slice(0, 300)).toMatch(/to_number: row\.to_number/);
    const expired = guard.slice(guard.indexOf('kind: "wa-send-expired"'));
    expect(expired.slice(0, 300)).toMatch(/to_number: cand\.to_number/);
    const claim = guard.slice(
      guard.indexOf('kind: claim.kind === "pacing" ? "claim-lost" : "claim-error"')
    );
    expect(claim.slice(0, 300)).toMatch(/to_number: row\.to_number/);
    expect(claim.slice(0, 300)).toMatch(/user_email: row\.sender_key/);
  });

  it("the hold-event throttle is lane-aware: reply churn is visible", () => {
    // A reply's holds live on the seconds-to-minutes scale; a 10min throttle
    // collapsed its whole re-park story into one event.
    expect(holdThrottleMsFor("rfq")).toBe(HOLD_EVENT_THROTTLE_MS);
    expect(holdThrottleMsFor("custom")).toBe(HOLD_EVENT_THROTTLE_MS);
    expect(holdThrottleMsFor("human-manual")).toBe(HOLD_EVENT_THROTTLE_MS);
    // "no kind means auto reply" - the same reading as REPLY_KIND_FILTER.
    expect(holdThrottleMsFor(undefined)).toBe(REPLY_HOLD_EVENT_THROTTLE_MS);
    expect(holdThrottleMsFor("bargain")).toBe(REPLY_HOLD_EVENT_THROTTLE_MS);
    expect(REPLY_HOLD_EVENT_THROTTLE_MS).toBeLessThan(HOLD_EVENT_THROTTLE_MS);
    // Still a real throttle - a re-park every drain pass must not write
    // hundreds of identical events.
    expect(REPLY_HOLD_EVENT_THROTTLE_MS).toBeGreaterThanOrEqual(60_000);
  });
});

// 7. THE ARMER - executed, with fake timers. A reply re-parked 20-40s out used
// to land on the next cron MINUTE: the floor was paid and the ceiling charged
// on top. The armer's timer fires an HTTP self-kick of the per-sender reply
// dispatcher; it never drains in-process (Cloud Run freezes CPU after the
// response - the kicked dispatcher runs in its own invocation).

const kicked = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("./kick", () => ({
  kickDispatcher: vi.fn(async (url: string) => {
    kicked.urls.push(url);
  }),
}));
vi.mock("../evolution", () => ({ webhookToken: vi.fn(async () => "tok-123") }));
vi.mock("../site", () => ({ resolveSiteOrigin: vi.fn(async () => "https://wheeldeal.pro") }));

import { armReplyDrain, ARM_HORIZON_MS } from "./drain-armer";

describe("7. the Next-runtime drain armer", () => {
  beforeEach(() => {
    kicked.urls.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kicks the PER-SENDER reply dispatcher when the row comes due", async () => {
    armReplyDrain(Date.now() + 5_000, "armer-a@x.com");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(kicked.urls.length).toBe(1);
    // The per-sender dispatcher, not the global chain - a hop=0 kick at
    // /api/wa/tick loses to a live cold chain every time.
    expect(kicked.urls[0]).toContain("/api/wa/reply-tick");
    expect(kicked.urls[0]).toContain("sender=armer-a%40x.com");
    expect(kicked.urls[0]).toContain("token=tok-123");
  });

  it("a row beyond the horizon is left to the cron - no timer armed", async () => {
    armReplyDrain(Date.now() + ARM_HORIZON_MS + 30_000, "armer-b@x.com");
    await vi.advanceTimersByTimeAsync(ARM_HORIZON_MS + 60_000);
    expect(kicked.urls.length).toBe(0);
  });

  it("one timer per sender: a later arm is covered by the earlier kick", async () => {
    armReplyDrain(Date.now() + 10_000, "armer-c@x.com");
    armReplyDrain(Date.now() + 30_000, "armer-c@x.com");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kicked.urls.length).toBe(1);
  });

  it("an EARLIER arm replaces a later one - the soonest row wins", async () => {
    armReplyDrain(Date.now() + 60_000, "armer-d@x.com");
    armReplyDrain(Date.now() + 5_000, "armer-d@x.com");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kicked.urls.length).toBe(1);
  });

  it("no sender, no arm - and never a throw", () => {
    expect(() => armReplyDrain(Date.now() + 5_000, undefined)).not.toThrow();
    expect(() => armReplyDrain(Date.now() + 5_000, null)).not.toThrow();
  });

  it("park.ts falls back to this armer when no worker hook is set", () => {
    const park = readCode("src/lib/wa/park.ts");
    expect(park).toMatch(/import\("\.\/drain-armer"\)/);
    expect(park).toMatch(/armReplyDrain\(row\.notBeforeMs, row\.senderKey\)/);
  });
});
