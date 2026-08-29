import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// FLEET-WIDE SUPPRESSION: one store, every lane.
//
// The owner decided opt-out is fleet-wide. That only holds if (a) the store
// itself reads honestly - a missing table and an unreadable table are OPPOSITE
// facts - and (b) every cold lane actually consults it. (a) is executable
// below; (b) is pinned in the wiring section because the consumers (guard,
// admitLead, agent-loop stop-intent) are deep in integration code.

let selectResult: unknown = { rows: [] };
let insertOk = true;
const inserts: { table: string; rows: Record<string, unknown>[]; onConflict?: string }[] = [];

vi.mock("../runtime-config", () => ({
  sbSelectStrict: async () => selectResult,
  sbInsert: async (table: string, rows: Record<string, unknown>[], onConflict?: string) => {
    inserts.push({ table, rows, onConflict });
    if (!insertOk) throw new Error("down");
    return true;
  },
}));

beforeEach(() => {
  selectResult = { rows: [] };
  insertOk = true;
  inserts.length = 0;
});

describe("shopSuppression reads honestly", () => {
  it("a stored tail is suppressed, and carries its reason", async () => {
    selectResult = { rows: [{ reason: "stop-intent: please stop" }] };
    const { shopSuppression } = await import("./suppression");
    const s = await shopSuppression("66812345678");
    expect(s.suppressed).toBe(true);
    expect(s.reason).toBe("stop-intent: please stop");
  });

  it("no row means not suppressed, with no unreadable flag", async () => {
    const { shopSuppression } = await import("./suppression");
    expect(await shopSuppression("66812345678")).toEqual({ suppressed: false });
  });

  it("a not-yet-migrated table is genuinely empty, not an outage", async () => {
    // Pre-migration deployments must not flag every send "unreadable".
    selectResult = { error: "missing" };
    const { shopSuppression } = await import("./suppression");
    expect(await shopSuppression("66812345678")).toEqual({ suppressed: false });
  });

  it("an unreadable store proceeds but SAYS SO", async () => {
    // Fail-open on read (the per-sender opt-out still stands underneath) -
    // but the caller must know not to cache this "not suppressed".
    selectResult = { error: "unavailable" };
    const { shopSuppression } = await import("./suppression");
    const s = await shopSuppression("66812345678");
    expect(s.suppressed).toBe(false);
    expect(s.unreadable).toBe(true);
  });

  it("an unusable number never reaches the store", async () => {
    selectResult = { error: "unavailable" };
    const { shopSuppression } = await import("./suppression");
    expect(await shopSuppression("123")).toEqual({ suppressed: false });
  });
});

describe("suppressShop writes durably", () => {
  it("upserts on the number tail so a second stop-intent is idempotent", async () => {
    const { suppressShop } = await import("./suppression");
    const ok = await suppressShop("66812345678", "please stop messaging me");
    expect(ok).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("wa_suppressions");
    expect(inserts[0].onConflict).toBe("number_tail");
    expect(inserts[0].rows[0].number_tail).toBe("812345678");
    expect(inserts[0].rows[0].source).toBe("stop-intent");
  });

  it("clips the reason so a hostile message cannot bloat the row", async () => {
    const { suppressShop } = await import("./suppression");
    await suppressShop("66812345678", "x".repeat(500));
    expect((inserts[0].rows[0].reason as string).length).toBe(200);
  });

  it("a write failure is reported, never swallowed as success", async () => {
    insertOk = false;
    const { suppressShop } = await import("./suppression");
    expect(await suppressShop("66812345678", "stop")).toBe(false);
  });

  it("an unusable number is refused without a write", async () => {
    const { suppressShop } = await import("./suppression");
    expect(await suppressShop("abc", "stop")).toBe(false);
    expect(inserts).toHaveLength(0);
  });
});

// THE CONSUMERS - the store is only fleet-wide if every cold lane asks it.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the guard's veto is scoped and terminal", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("only COLD contacts are vetoed - a live conversation is per-sender territory", () => {
    // The fleet store answers "may WheelDeal introduce itself to this shop";
    // a shop mid-thread with THIS traveller has its own opted_out_at state.
    expect(guard).toMatch(
      /if \(isNewContact\) \{\s*const \{ shopSuppression \} = await import\("\.\/wa\/suppression"\)/
    );
  });

  it("it runs AFTER the per-sender opted-out veto, and both are terminal with a trace", () => {
    const perSender = guard.indexOf('"opted-out - this shop asked not to be messaged again"');
    const fleet = guard.indexOf('"suppressed - this shop asked WheelDeal not to contact it"');
    expect(perSender).toBeGreaterThan(-1);
    expect(fleet).toBeGreaterThan(perSender);
    const veto = guard.slice(fleet, fleet + 600);
    expect(veto).toMatch(/terminal: true/);
    expect(guard.slice(fleet - 400, fleet + 50)).toMatch(/recordSendDropped/);
  });
});

describe("stop-intent writes the fleet store beside the per-sender stamp", () => {
  const loop = readCode("src/lib/agent-loop.ts");

  it("both stop-intent sites in the agent loop suppress fleet-wide", () => {
    // The regex fast path and the deferred LLM verdict each stamp the
    // per-sender opt-out; each must ALSO write wa_suppressions, or a shop's
    // "stop" only protects the one traveller it was said to.
    const sites = loop.match(/suppressShop\(/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(2);
    expect(loop).toMatch(/markRecipientOptedOut[\s\S]{0,600}suppressShop\(/);
  });

  it("the WABA webhook's stop-intent suppresses too", () => {
    const hook = readCode("src/app/api/webhooks/waba/route.ts");
    expect(hook).toMatch(/suppressShop\(/);
  });
});
