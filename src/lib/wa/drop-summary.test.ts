import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeInboundDrops, DROP_SCAN_LIMIT } from "./drop-summary";
import { BENIGN_DROP_REASONS, isLoudDrop } from "./safety-signals";

// W-beta30b: the owner photographed "inbound-dropped: 79" on the health tile
// and could not tell whether the fleet had lost 79 shop replies or the privacy
// gate had refused 79 of their own personal chats. Both were true of that
// integer. Every test here EXECUTES the reducer - the split has to be provable
// arithmetic, not a source grep, because the whole defect was a number nobody
// could interrogate.

const row = (reason: string, extra: Record<string, unknown> = {}) => ({
  detail: JSON.stringify({ reason, ...extra }),
});

describe("the split separates hygiene from loss", () => {
  it("EXECUTED: the privacy gate's own chatter lands entirely in 'by design'", () => {
    const s = summarizeInboundDrops([
      row("vendor-gate"),
      row("vendor-gate"),
      row("non-chat-jid"),
      row("image-coalesced"),
      row("session-expired"),
      row("store-claim-lost"),
    ]);
    expect(s.unreadable).toBe(false);
    expect(s.loud).toBe(0);
    expect(s.benign).toBe(6);
  });

  it("EXECUTED: a muted shop reply is counted LOUD and named", () => {
    const s = summarizeInboundDrops([
      row("vendor-gate"),
      row("no-rfq-thread"),
      row("takeover-unreadable"),
      row("pause-unreadable"),
    ]);
    expect(s.loud).toBe(3);
    expect(s.benign).toBe(1);
    const loudReasons = s.reasons.filter((r) => r.loud).map((r) => r.reason).sort();
    expect(loudReasons).toEqual(["no-rfq-thread", "pause-unreadable", "takeover-unreadable"]);
  });

  it("EXECUTED: a deliberate hold and an unreadable store are no longer the same row", () => {
    // THE BUG THIS WHOLE SPLIT EXISTS FOR. Before it, both spellings were
    // `takeover-hold` - benign - so a store outage muted every reply in the
    // fleet while the safety banner stayed green and the feed stayed empty.
    expect(isLoudDrop("takeover-hold")).toBe(false);
    expect(isLoudDrop("takeover-unreadable")).toBe(true);
    expect(isLoudDrop("pause-hold")).toBe(false);
    expect(isLoudDrop("pause-unreadable")).toBe(true);
  });

  it("EXECUTED: rows understate volume - alsoSuppressed is folded into events", () => {
    // The trace throttle writes one row per (email|digits|reason) per 5 min and
    // records how many it swallowed. Reading rows alone makes a chatty burst
    // look small and therefore makes a genuine loss look proportionally huge.
    const s = summarizeInboundDrops([
      row("vendor-gate", { alsoSuppressed: 12 }),
      row("vendor-gate", { alsoSuppressed: 3 }),
      row("no-rfq-thread"),
    ]);
    expect(s.benign + s.loud).toBe(3);
    expect(s.events).toBe(1 + 12 + 1 + 3 + 1);
    const vg = s.reasons.find((r) => r.reason === "vendor-gate")!;
    expect(vg.rows).toBe(2);
    expect(vg.events).toBe(17);
  });

  it("EXECUTED: a negative or junk alsoSuppressed cannot shrink the event count", () => {
    const s = summarizeInboundDrops([
      row("vendor-gate", { alsoSuppressed: -50 }),
      row("vendor-gate", { alsoSuppressed: "many" }),
    ]);
    expect(s.events).toBe(2);
  });

  it("EXECUTED: derived-unattributed is an integrity warning on a turn that RAN, not a loss", () => {
    // agent-loop writes it and then FALLS THROUGH - the turn proceeds. It rode
    // the inbound-dropped kind only because that was the nearest breadcrumb.
    const s = summarizeInboundDrops([row("derived-unattributed", { notDropped: true })]);
    expect(s.loud).toBe(0);
    expect(s.benign).toBe(1);
  });

  it("EXECUTED: an unknown reason is LOUD - a new drop is a problem until proven benign", () => {
    const s = summarizeInboundDrops([row("some-brand-new-reason")]);
    expect(s.loud).toBe(1);
  });

  it("EXECUTED: unparseable and reason-less rows get their OWN bucket, never a silent benign", () => {
    const s = summarizeInboundDrops([{ detail: "{not json" }, { detail: null }, { detail: "{}" }]);
    expect(s.loud).toBe(3);
    expect(s.reasons).toEqual([
      { reason: "(unparseable)", rows: 3, events: 3, loud: true },
    ]);
  });
});

describe("the reducer never reports a confident zero", () => {
  it("EXECUTED: a failed read is UNREADABLE, not 'nothing was dropped'", () => {
    const s = summarizeInboundDrops(null);
    expect(s.unreadable).toBe(true);
    expect(s.benign).toBe(0);
    expect(s.loud).toBe(0);
    expect(s.reasons).toEqual([]);
  });

  it("EXECUTED: hitting the scan cap marks every count a FLOOR", () => {
    const rows = Array.from({ length: 5 }, () => row("vendor-gate"));
    expect(summarizeInboundDrops(rows, 5).truncated).toBe(true);
    expect(summarizeInboundDrops(rows, 6).truncated).toBe(false);
    expect(DROP_SCAN_LIMIT).toBeGreaterThanOrEqual(500);
  });

  it("EXECUTED: an empty 24h is an honest zero with the split still present", () => {
    const s = summarizeInboundDrops([]);
    expect(s).toEqual({
      unreadable: false,
      benign: 0,
      loud: 0,
      events: 0,
      truncated: false,
      reasons: [],
    });
  });
});

describe("the histogram is ordered and bounded", () => {
  it("EXECUTED: reasons sort by row count, loudest volume first in the eye", () => {
    const s = summarizeInboundDrops([
      row("no-rfq-thread"),
      ...Array.from({ length: 9 }, () => row("vendor-gate")),
      ...Array.from({ length: 4 }, () => row("non-chat-jid")),
    ]);
    expect(s.reasons.map((r) => r.reason)).toEqual([
      "vendor-gate",
      "non-chat-jid",
      "no-rfq-thread",
    ]);
  });

  it("EXECUTED: a long tail is clipped to the chip budget, totals stay whole", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`reason-${i}`));
    const s = summarizeInboundDrops(rows);
    expect(s.reasons.length).toBe(12);
    // The clip is DISPLAY only: the split counts still cover all 40.
    expect(s.benign + s.loud).toBe(40);
  });
});

describe("the wiring: the route and the panel actually use this", () => {
  const readCode = (p: string) =>
    readFileSync(join(process.cwd(), p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  it("the health route reads through the pure reducer, not a second inline copy", () => {
    const route = readCode("src/app/api/admin/health/route.ts");
    expect(route).toMatch(/summarizeInboundDrops/);
    expect(route).toMatch(/kind=eq\.inbound-dropped/);
    expect(route).toMatch(/inboundDrops,/);
    // Reading through sbSelectDark is what makes `unreadable` reachable at all.
    expect(route).toMatch(/sbSelectDark<\{ detail: string \| null \}>/);
  });

  it("the panel renders the split instead of the one misleading chip", () => {
    const panel = readCode("src/components/HealthPanel.tsx");
    expect(panel).toMatch(/needing attention/);
    expect(panel).toMatch(/by design/);
    expect(panel).toMatch(/k === "inbound-dropped" && inboundDrops && !inboundDrops\.unreadable/);
  });

  it("both admin surfaces now name the SAME 24h window", () => {
    // EngineInspector said 6h over the identical payload, so one integer read
    // four times worse on one screen than the other.
    expect(readCode("src/components/admin/EngineInspector.tsx")).toMatch(
      /Refused in the last 24h/
    );
    expect(readCode("src/components/HealthPanel.tsx")).toMatch(/Send-pipeline guardrails \(24h\)/);
  });

  it("the taxonomy stays an exception list even after the three additions", () => {
    expect(BENIGN_DROP_REASONS.size).toBeLessThan(13);
    for (const r of ["image-coalesced", "non-chat-jid", "session-expired"]) {
      expect(BENIGN_DROP_REASONS.has(r), r).toBe(true);
    }
  });
});
