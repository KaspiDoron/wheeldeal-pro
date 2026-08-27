import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

// OWNER REPORT 11, T2 - THE BAN-RISK SCORE, RUN NOT READ.
//
// computeRisk assigns the 0-100 ban-risk score that auto-pauses a traveller's
// number the moment it crosses risk_pause_threshold. Pausing a number is a
// safety action; scoring it too LOW leaves a number sending into a restriction,
// too HIGH freezes a healthy hunt. It had only a source pin
// (`computeRisk(rep, p, { blocks7d ...`). These EXECUTE it against the real
// default policies and assert the score and the pause decision it drives.

vi.mock("../runtime-config", () => ({
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: [] }),
  getConfig: async () => undefined,
  sbInsert: async () => true,
  sbUpdate: async () => true,
  sbDelete: async () => true,
  pgTimestamp: (d: string) => d,
}));

const AGED = new Date(Date.now() - 30 * 86_400_000).toISOString();
const rep = (o: Record<string, unknown>) => ({
  sender_key: "t@x.co",
  trust_score: 20,
  sent_total: 0,
  replies_total: 0,
  last_send_at: null,
  created_at: AGED,
  ...o,
});

describe("computeRisk drives the auto-pause, and it does so correctly", () => {
  it("EXECUTED: a warmed number with good replies scores ~0 and does not pause", async () => {
    const { computeRisk, getPolicies } = await import("../wa-guard");
    const p = await getPolicies();
    const r = computeRisk(
      rep({ sent_total: 20, replies_total: 10, delivered_total: 20, reads_total: 15 }),
      p,
      { blocks7d: 0 }
    );
    expect(r.score).toBe(0);
    expect(r.score < p.risk_pause_threshold).toBe(true);
  });

  it("EXECUTED: REPLY-SILENCE ALONE does not cross the pause line (needs a real report)", async () => {
    // The documented M6 property: a number nobody answers scores high (low
    // reply + low read) but tops out BELOW the threshold - so the auto-pause is
    // reserved for an actual recipient signal, not mere quiet.
    const { computeRisk, getPolicies } = await import("../wa-guard");
    const p = await getPolicies();
    const r = computeRisk(
      rep({ sent_total: 20, replies_total: 0, delivered_total: 20, reads_total: 0 }),
      p,
      { blocks7d: 0 }
    );
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(p.risk_pause_threshold); // does NOT auto-pause
  });

  it("EXECUTED: silence PLUS recipient blocks crosses the line and ARMS the pause", async () => {
    const { computeRisk, getPolicies } = await import("../wa-guard");
    const p = await getPolicies();
    const r = computeRisk(
      rep({ sent_total: 20, replies_total: 0, delivered_total: 20, reads_total: 0 }),
      p,
      { blocks7d: 2 }
    );
    expect(r.score).toBeGreaterThanOrEqual(p.risk_pause_threshold); // -> auto-pause
    expect(r.reasons.join(" ")).toMatch(/block\/report/);
  });

  it("EXECUTED: the 7-day block count is capped, and blindness never LOWERS the score", async () => {
    const { computeRisk, getPolicies } = await import("../wa-guard");
    const p = await getPolicies();
    const base = rep({ sent_total: 20, replies_total: 10, delivered_total: 20, reads_total: 15 });
    // Windowed count is capped at +30 (5 * 12 = 60 -> 30).
    expect(computeRisk(base, p, { blocks7d: 5 }).score).toBe(30);
    // Unreadable window (null) falls back to the CONSERVATIVE lifetime counter,
    // it does not read as zero.
    const withLifetime = { ...base, blocks_total: 3 };
    expect(computeRisk(withLifetime, p, { blocks7d: null }).score).toBeGreaterThan(0);
  });

  it("EXECUTED: a brand-new number sending on day one carries its own risk", async () => {
    const { computeRisk, getPolicies } = await import("../wa-guard");
    const p = await getPolicies();
    const fresh = rep({ created_at: new Date().toISOString(), sent_total: 5, replies_total: 5, delivered_total: 5, reads_total: 5 });
    const r = computeRisk(fresh, p, { blocks7d: 0 });
    expect(r.reasons.join(" ")).toMatch(/new number sending on day 1/);
    expect(r.score).toBeGreaterThanOrEqual(10);
  });
});
