import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// THE SURFACES WHOSE ONLY JOB IS TO TELL THE TRUTH WERE THE LAST ONES TO GET IT.
//
// RC-7a fixed the Command Center and Ops Analytics. Four more panels had the
// identical shape, and each one turns an unreadable database into a specific,
// confident, wrong number:
//
//   fieldKpis      -> 0 searches, 0 bookings, escalation null. Reads as a quiet
//                     month. It is a dead database.
//   cycleUsage     -> "0 tokens used this cycle" on every AI provider. Reads as
//                     free-tier headroom, which is what the owner uses it for.
//   guardCounters  -> every drop counter at zero on the HEALTH page, at the
//                     moment nothing can be read.
//   senderSafety   -> "All good", to the TRAVELLER, mid-outage. The one verdict
//                     with a person on the other end of it.
//
// A zero is a claim. These tests execute the path where we have no right to
// make one.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("sbCountDark: a count that can say 'I could not ask'", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  async function withStubbedSupabase<T>(fn: (rc: typeof import("./runtime-config")) => Promise<T>) {
    vi.doMock("server-only", () => ({}));
    const rc = await import("./runtime-config");
    const before = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    process.env.SUPABASE_URL = "https://stub.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
    try {
      return await fn(rc);
    } finally {
      if (before.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = before.url;
      if (before.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = before.key;
    }
  }

  it("REPRODUCTION: sbCount reports a confident zero through a total outage", async () => {
    await withStubbedSupabase(async (rc) => {
      const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
      try {
        // Indistinguishable from "nothing was dropped in the last 24 hours".
        expect(await rc.sbCount("agent_events", "kind=eq.send-dropped")).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("null on an outage, 0 on a missing table, the real number on success", async () => {
    await withStubbedSupabase(async (rc) => {
      const spy = vi.spyOn(globalThis, "fetch");
      try {
        spy.mockRejectedValue(new Error("ECONNREFUSED"));
        expect(await rc.sbCountDark("agent_events", "kind=eq.x")).toBeNull();

        spy.mockResolvedValue(new Response("", { status: 500 }));
        expect(await rc.sbCountDark("agent_events", "kind=eq.x")).toBeNull();

        // Un-migrated: no row CAN exist, so zero is the truth, not a guess.
        spy.mockResolvedValue(new Response("", { status: 404 }));
        expect(await rc.sbCountDark("agent_events", "kind=eq.x")).toBe(0);

        spy.mockResolvedValue(
          new Response("[]", { status: 200, headers: { "content-range": "0-0/42" } })
        );
        expect(await rc.sbCountDark("agent_events", "kind=eq.x")).toBe(42);

        // A 2xx whose Content-Range we cannot parse is not a zero either.
        spy.mockResolvedValue(new Response("[]", { status: 200 }));
        expect(await rc.sbCountDark("agent_events", "kind=eq.x")).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("fieldKpis renders a dead database as dark, not as a quiet month", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  /** Load kpis with every read answering `unavailable`. */
  async function loadWithOutage() {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("./runtime-config", () => ({
      // The real one. A stub that just returned the input would let a raw "+00:00"
      // through here while 400ing in production - the exact gap this export closes.
      pgTimestamp: (v: string | number | Date) =>
        encodeURIComponent(new Date(v as string).toISOString()),
      sbSelectDark: async () => null,
      sbSelect: async () => [],
      sbSelectStrict: async () => ({ error: "unavailable" as const }),
      sbCount: async () => 0,
      sbCountDark: async () => null,
    }));
    return import("./kpis");
  }

  it("names every unreadable input instead of reporting a complete page", async () => {
    const { fieldKpis } = await loadWithOutage();
    const k = await fieldKpis();
    expect(
      k.degraded,
      "the KPI page reported a full 30-day picture over a dead database"
    ).toEqual(
      expect.arrayContaining(["offers", "searches", "bookings", "takeover events", "engine turns"])
    );
  });

  it("no ratio is computed from a side that could not be read", async () => {
    const { fieldKpis } = await loadWithOutage();
    const k = await fieldKpis();
    // Previously: searches.length === 0 made conversionPct null "by accident",
    // and escalationPct null the same way - both indistinguishable from a real
    // zero-activity window. Now they are null BECAUSE the inputs are unknown,
    // and `degraded` is what says so.
    expect(k.conversionPct).toBeNull();
    expect(k.escalationPct).toBeNull();
    expect(k.discountMarginPct).toBeNull();
  });

  it("a healthy but genuinely empty database is NOT degraded", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("./runtime-config", () => ({
      // The real one. A stub that just returned the input would let a raw "+00:00"
      // through here while 400ing in production - the exact gap this export closes.
      pgTimestamp: (v: string | number | Date) =>
        encodeURIComponent(new Date(v as string).toISOString()),
      sbSelectDark: async () => [],
      sbSelect: async () => [],
      sbSelectStrict: async () => ({ rows: [] }),
      sbCount: async () => 0,
      sbCountDark: async () => 0,
    }));
    const { fieldKpis } = await import("./kpis");
    const k = await fieldKpis();
    expect(k.degraded, "a fresh install must not paint itself dark").toEqual([]);
    expect(k.searches30d).toBe(0);
  });

  it("real rows still produce real numbers - the fix must not blank the page", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const since = new Date().toISOString();
    vi.doMock("./runtime-config", () => ({
      // The real one. A stub that just returned the input would let a raw "+00:00"
      // through here while 400ing in production - the exact gap this export closes.
      pgTimestamp: (v: string | number | Date) =>
        encodeURIComponent(new Date(v as string).toISOString()),
      sbSelectDark: async (table: string, query: string) => {
        if (table === "offers") return [{ price_per_day: 80, list_price_per_day: 100 }];
        if (table === "searches") return [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        if (table === "bookings") return [{ id: 1 }];
        if (query.includes("human-takeover")) return [{ user_email: "a@x.com", vendor_id: "v1" }];
        return [
          { detail: JSON.stringify({ latencyMs: 500 }), user_email: "a@x.com", vendor_id: "v1" },
          { detail: JSON.stringify({ latencyMs: 900 }), user_email: "a@x.com", vendor_id: "v2" },
        ];
      },
      sbSelect: async () => [],
      sbSelectStrict: async () => ({ rows: [] }),
      sbCount: async () => 0,
      sbCountDark: async () => 0,
    }));
    const { fieldKpis } = await import("./kpis");
    const k = await fieldKpis();
    void since;
    expect(k.degraded).toEqual([]);
    expect(k.discountMarginPct).toBe(20); // 100 -> 80
    expect(k.conversionPct).toBe(25); // 1 booking / 4 searches
    expect(k.escalationPct).toBe(50); // 1 escalated thread of 2
    expect(k.responseLatencyMs.p50).toBe(500);
  });
});

describe("the AI usage panel cannot claim an untouched allowance", () => {
  const ai = readCode("src/lib/ai.ts");

  it("cycleUsage reads through the dark reader and reports unreadable", () => {
    expect(ai).toMatch(/sbSelectDark<\{ provider: string; tokens: number; created_at: string \}>/);
    expect(ai).toMatch(/if \(rows === null\) return \{ byProvider: out, unreadable: true \}/);
  });

  it("usedThisCycle is null - never 0 - when the ledger is unreadable", () => {
    expect(ai).toMatch(/usedThisCycle: cycUnreadable \? null : \(cyc\[p\.name\] \?\? 0\)/);
  });

  it("the admin page renders it as unreadable rather than re-adding `?? 0`", () => {
    const page = readCode("src/app/admin/page.tsx");
    expect(page).not.toMatch(/Number\(p\.usedThisCycle \?\? 0\)/);
    expect(page).toMatch(/usage unreadable/);
  });
});

describe("the health page's drop counters can go dark", () => {
  const route = readCode("src/app/api/admin/health/route.ts");

  it("uses the counting reader that can answer unknown", () => {
    expect(route).toMatch(/sbCountDark\(/);
    expect(route).not.toMatch(/\bsbCount\(/);
    expect(route).toMatch(/Record<string, number \| null>/);
  });

  it("says so at the top level, not only as one dash among twelve", () => {
    expect(route).toMatch(/guardCountersUnreadable/);
  });

  it("both renderers show 'unreadable' instead of dropping the tile", () => {
    for (const p of ["src/components/HealthPanel.tsx", "src/components/admin/EngineInspector.tsx"]) {
      const ui = readCode(p);
      // The old filter was `n > 0`, which HID an unreadable counter entirely -
      // the failure mode was an empty section, i.e. "no guardrails fired".
      expect(ui, p).toMatch(/n === null \|\| \(n \?\? 0\) > 0/);
      expect(ui, p).toMatch(/"unreadable"/);
    }
  });
});

describe("the traveller is never told 'All good' from a reading we did not get", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("senderSafety reads both green-producing inputs strictly", () => {
    const fn = guard.slice(guard.indexOf("export async function senderSafety"));
    expect(fn).toMatch(/getReputationStrict\(senderKey\)/);
    expect(fn).toMatch(/sbSelectStrict<\{ meta: \{ reason\?: string \} \| null \}>/);
    // getReputation (permissive) INSERTS a trust-20 row when its read comes
    // back empty, so an outage manufactured a brand-new-healthy number.
    expect(fn).not.toMatch(/getReputation\(senderKey\)\.catch/);
  });

  it("an unreadable queue produces `unknown`, and it is placed after the real verdicts", () => {
    const fn = guard.slice(guard.indexOf("export async function senderSafety"));
    const unknownIdx = fn.indexOf('state: "unknown"');
    const pausedIdx = fn.indexOf('state: recovering ? "recovering" : "paused"');
    const signalIdx = fn.indexOf("const flag = classifySafety(");
    const pacingIdx = fn.indexOf('state: "pacing"');
    const healthyIdx = fn.indexOf('state: "healthy"');
    expect(unknownIdx).toBeGreaterThan(-1);
    // Positive evidence of a REAL problem outranks our own blindness...
    expect(unknownIdx).toBeGreaterThan(pausedIdx);
    expect(unknownIdx).toBeGreaterThan(signalIdx);
    // ...but both inferences drawn from an empty array must sit behind it.
    expect(unknownIdx).toBeLessThan(pacingIdx);
    expect(unknownIdx).toBeLessThan(healthyIdx);
  });

  it("the badge renders it neutrally - not green, not red", () => {
    const badge = readCode("src/components/WaSafetyBadge.tsx");
    expect(badge).toMatch(/safety\.state === "unknown"/);
    // Green would be the original lie; red would alarm someone about a problem
    // we have no evidence for.
    // Bound the slice to the unknown BRANCH, not to a character count: the
    // fallthrough branch right after it is legitimately red, and a fixed window
    // that swallows it would fail on correct code.
    const start = badge.indexOf('safety.state === "unknown"');
    const cfg = badge.slice(start, badge.indexOf("}", badge.indexOf("label:", start)));
    expect(cfg).toMatch(/cls:/);
    expect(cfg).not.toMatch(/bg-savings-soft/);
    expect(cfg).not.toMatch(/bg-brandred-soft/);
  });

  it("`unknown` is a real member of every type it crosses", () => {
    expect(readCode("src/components/WaSafetyBadge.tsx")).toMatch(/\| "unknown"/);
    // progress.ts consumes the verdict for the stall reason; an unmodelled
    // state there would have been a compile error, which is the point.
    expect(readCode("src/lib/progress.ts")).toMatch(/\| "unknown"/);
  });

  it("the 'Sent - reply lands here' status is a muted chip, not a green CTA", () => {
    const card = readCode("src/components/VendorCard.tsx");
    // askDone (and queued) get the muted, non-interactive treatment; only a
    // live "Ask for price" wears bg-savings. The green-button trap is gone.
    expect(card).toMatch(/\(queuedActive \|\| askDone\) && rfqState !== "sending"/);
    expect(card).toMatch(/cursor-default bg-card2 text-soft/);
    // Once a reply has landed the passive label stops promising one.
    expect(card).toMatch(/vendor\.lastInboundAt \? t\("Reply received"\)/);
  });
});
