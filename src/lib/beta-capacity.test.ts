import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// OWNER REPORT 10, W1 - THE TWO CEILINGS THAT DECIDE AN INVITE.
//
// The beta was hard-capped at 25 testers by a bare `25` inside
// `saveBetaAllowlist`, which TRUNCATED anything longer and returned a plain
// 200 - so the owner pasted 40 emails, was told nothing, and lost 15 of them.
// The panel quoted its own separate literal `25`, so the two could drift apart
// the moment either moved.
//
// The second ceiling is the fleet: hosts x per-host cap. Being on the invite
// list has never meant a socket is waiting, and a tester past the fleet's
// capacity signs in perfectly happily and THEN fails to link WhatsApp - the
// confusing half of that failure. `inviteHeadroom` puts the arithmetic on a
// screen instead of in the owner's head.

const setConfig = vi.fn(async (_name: string, _value: string) => {});
vi.mock("./runtime-config", () => ({
  getConfig: async () => null,
  setConfig: (name: string, value: string) => setConfig(name, value),
}));

beforeEach(() => setConfig.mockClear());

describe("the tester cap lives in exactly one place", () => {
  it("BETA_ALLOWLIST_MAX is the ceiling, and it is 100 - not the old 25", async () => {
    const { BETA_ALLOWLIST_MAX } = await import("./allowlist");
    expect(BETA_ALLOWLIST_MAX).toBe(100);
  });

  it("no bare numeric literal cap survives in the save path", async () => {
    const src = readFileSync("src/lib/allowlist.ts", "utf8");
    const save = src.slice(src.indexOf("export async function saveBetaAllowlist"));
    const body = save.slice(0, save.indexOf("\n}"));
    // The bug shape: `if (clean.length >= 25) break;`
    expect(body).not.toMatch(/clean\.length\s*>=\s*\d/);
    expect(body).toMatch(/clean\.length\s*>=\s*BETA_ALLOWLIST_MAX/);
  });

  it("stores up to the cap and REPORTS the remainder instead of binning it silently", async () => {
    const { saveBetaAllowlist, BETA_ALLOWLIST_MAX } = await import("./allowlist");
    const entries = Array.from({ length: BETA_ALLOWLIST_MAX + 7 }, (_, i) => ({
      email: `t${i}@example.com`,
      plan: "free" as const,
    }));
    const res = await saveBetaAllowlist(entries);
    expect(res.saved).toHaveLength(BETA_ALLOWLIST_MAX);
    expect(res.dropped).toBe(7);
    expect(res.max).toBe(BETA_ALLOWLIST_MAX);
    // And it really wrote the capped list, not the whole thing.
    const written = JSON.parse(setConfig.mock.calls[0][1]);
    expect(written).toHaveLength(BETA_ALLOWLIST_MAX);
  });

  it("a 40-tester list saves ALL 40 - the case the old cap made impossible", async () => {
    const { saveBetaAllowlist } = await import("./allowlist");
    const entries = Array.from({ length: 40 }, (_, i) => ({
      email: `t${i}@example.com`,
      plan: "free" as const,
    }));
    const res = await saveBetaAllowlist(entries);
    expect(res.saved).toHaveLength(40);
    expect(res.dropped).toBe(0);
  });

  it("de-duplication and the owner exclusion still bite, and never count as dropped", async () => {
    const { saveBetaAllowlist } = await import("./allowlist");
    const res = await saveBetaAllowlist([
      { email: "A@Example.com", plan: "pro" },
      { email: "a@example.com", plan: "ultra" }, // dupe, case-folded
      { email: "not-an-email", plan: "free" },
      { email: process.env.OWNER_EMAIL || "kaspidoron@gmail.com", plan: "free" },
    ]);
    expect(res.saved).toEqual([{ email: "a@example.com", plan: "pro" }]);
    expect(res.dropped).toBe(0); // dropped counts CAP overflow only
  });
});

describe("choke point: invited testers vs fleet capacity", () => {
  it("green with room to spare, and states the arithmetic", async () => {
    const { inviteHeadroom } = await import("./chokepoints");
    const h = inviteHeadroom(30, 4, 25, 100); // 4 hosts x 25 = 100
    expect(h.state).toBe("ok");
    expect(h.capacity).toBe(100);
    expect(h.headroom).toBe(70);
    expect(h.detail).toMatch(/4 host\(s\) x 25 = 100/);
  });

  it("WARNS while the remaining room is under one host's worth", async () => {
    const { inviteHeadroom } = await import("./chokepoints");
    const h = inviteHeadroom(80, 4, 25, 100); // 20 left, one host holds 25
    expect(h.state).toBe("warn");
    expect(h.headroom).toBe(20);
    expect(h.detail).toMatch(/Stand up the next lane now/);
  });

  it("ALARMS once invites exceed what the fleet can hold, and counts the broken testers", async () => {
    const { inviteHeadroom } = await import("./chokepoints");
    const h = inviteHeadroom(100, 1, 25, 100); // one host: 25 linkable
    expect(h.state).toBe("alarm");
    expect(h.headroom).toBe(-75);
    expect(h.detail).toMatch(/75 of them can sign in and then FAIL to link/);
    // and it names the OTHER ceiling too, so both are visible at once
    expect(h.detail).toMatch(/invite list is also at its own 100 ceiling/);
  });

  it("no host configured is UNKNOWN, not a comfortable zero", async () => {
    const { inviteHeadroom } = await import("./chokepoints");
    const h = inviteHeadroom(12, 0, 25, 100);
    expect(h.state).toBe("unknown");
    expect(h.detail).toMatch(/NO Evolution host is configured/);
  });

  it("exactly full is a WARNING, not an alarm - nobody invited is broken yet", async () => {
    const { inviteHeadroom } = await import("./chokepoints");
    const h = inviteHeadroom(100, 4, 25, 100);
    expect(h.headroom).toBe(0);
    expect(h.state).toBe("warn");
    expect(h.detail).toMatch(/Exactly full/);
  });

  it("100 testers need 4 hosts at the shipped default cap - the report-10 claim, as arithmetic", async () => {
    const { inviteHeadroom } = await import("./chokepoints");
    expect(inviteHeadroom(100, 3, 25, 100).state).toBe("alarm"); // 75 linkable
    expect(inviteHeadroom(100, 4, 25, 100).state).not.toBe("alarm"); // 100 linkable
  });
});

describe("the admin panel reads the cap rather than restating it", () => {
  it("the beta route serves `max` on GET and PUT", async () => {
    const src = readFileSync("src/app/api/admin/beta/route.ts", "utf8");
    expect(src).toMatch(/BETA_ALLOWLIST_MAX/);
    expect(src).toMatch(/max:\s*BETA_ALLOWLIST_MAX/);
    expect(src).toMatch(/dropped:\s*res\.dropped/);
  });

  it("the panel no longer hard-codes a tester ceiling in its copy", async () => {
    const src = readFileSync("src/app/admin/page.tsx", "utf8");
    expect(src).not.toMatch(/Up to 25 testers/);
    expect(src).toMatch(/Up to \{max \?\? "-"\} testers/);
  });
});

// ---------------------------------------------------------------------------
// DOC PINS - and they are labelled as such deliberately.
//
// These execute nothing. They exist because the fleet runbook is the ONLY
// place several of these facts live, and two of them (Koyeb, Fly.io) are
// things a future session will otherwise re-research from stale training data
// and re-add as live options. A grep is the honest instrument for that; it is
// not behavioural coverage and is not presented as any.
// ---------------------------------------------------------------------------
describe("doc pin: the fleet runbook does not resurrect dead free tiers", () => {
  const read = () => readFileSync("deploy/fleet/README.md", "utf8");

  it("Koyeb and Fly.io are recorded as closed/dead, not offered as lanes", () => {
    const md = read();
    expect(md).toMatch(/Koyeb/);
    expect(md).toMatch(/CLOSED/);
    expect(md).toMatch(/Fly\.io/);
    expect(md).toMatch(/DEAD/);
  });

  it("Oracle is built LAST, because its home region is permanent", () => {
    const md = read();
    expect(md).toMatch(/home region .*can NEVER be changed|home region is permanent/i);
    expect(md).toMatch(/\*\*Oracle, LAST\.\*\*/);
  });

  it("the runbook states the host-vs-provider distinction the table would otherwise hide", () => {
    expect(read()).toMatch(/A HOST buys capacity\. A PROVIDER buys blast radius/);
  });

  it("the EVOLUTION_HOSTS example still carries its dial prefixes", () => {
    // The exact shape whose parsing was broken in OR8 (see or8-audit-blockers).
    expect(read()).toMatch(/\|<the key from \.env>\|66,84,855,856,60,65/);
  });
});
