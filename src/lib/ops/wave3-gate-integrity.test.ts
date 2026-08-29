import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// WAVE 3 - EVAL-GATE INTEGRITY. Executed falsification for each defect the
// investigation verified: the gate now evaluates the CANDIDATE in the engine
// that ships (SPTE), under the candidate's own policy; an unreadable golden
// store fails CLOSED; the authored coherence guards are pinned into the
// replayed window; the misread freeze carries the real facts; the replay's
// session/context models what live builds. Where a defect lives in a Next
// route (hard to execute in vitest), a source pin holds the fix in place.

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async () => ({ text: null }),
  chatVision: async () => null,
  extractJson: () => null,
}));

const store = vi.hoisted(() => ({
  cases: [] as Array<Record<string, unknown>>,
  mode: "ok" as "ok" | "unavailable",
  refuseInserts: false,
  configWrites: [] as Array<{ key: string; value: string }>,
  inserts: [] as Array<{ table: string; rows: Array<Record<string, unknown>> }>,
}));
vi.mock("../runtime-config", () => ({
  getConfig: async () => undefined,
  setConfig: async (key: string, value: string) => {
    store.configWrites.push({ key, value });
  },
  sbInsert: async (table: string, rows: Array<Record<string, unknown>>) => {
    if (store.refuseInserts) return false;
    store.inserts.push({ table, rows });
    if (table === "agent_golden_cases") {
      store.cases.push(
        ...rows.map((r) => ({ id: 1000 + store.cases.length, created_at: "2026-08-01T00:00:00Z", ...r }))
      );
    }
    return true;
  },
  sbInsertReturning: async (table: string, rows: Array<Record<string, unknown>>) => {
    store.inserts.push({ table, rows });
    return rows.map((_, i) => ({ id: 7 + i }));
  },
  sbSelect: async () => [],
  sbSelectStrict: async (table: string, query: string) => {
    if (store.mode === "unavailable") return { error: "unavailable" as const };
    if (table !== "agent_golden_cases") return { rows: [] as Array<Record<string, unknown>> };
    let rows = [...store.cases];
    if (query.includes("enabled=eq.true")) rows = rows.filter((r) => r.enabled !== false);
    if (query.includes("not.like.coherence")) {
      rows = rows.filter((r) => !String(r.name).startsWith("coherence:"));
    } else if (query.includes("like.coherence")) {
      rows = rows.filter((r) => String(r.name).startsWith("coherence:"));
    }
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const lim = Number(/limit=(\d+)/.exec(query)?.[1] ?? 1000);
    return { rows: rows.slice(0, lim) };
  },
  sbUpdate: async () => true,
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
  supabaseConfigured: () => false,
}));
vi.mock("../wa-guard", () => ({
  guardOutbound: async ({ text }: { text: string }) => ({ allow: true, text }),
  afterSend: async () => {},
}));
vi.mock("../market", () => ({
  floorPriceFor: async () => ({ floor: 150, typical: 240, currency: "THB" }),
  vehicleKeyFor: () => "motorbike-125",
  regionKeysFor: () => ["chiang-mai"],
}));

import { replaySpteTurns } from "../simulate";
import {
  evaluateTurn,
  expectationFromOutbound,
  goldenGateBlocks,
  listGoldenCasesStrict,
  runGoldenCase,
  runGoldenSuite,
} from "./golden";
import { clampOverlay } from "./overlay";
import { misreadStubExtraction, misreadTurn } from "./misread";
import { recompileOpsLearning } from "./learning";
import { saveVersionedSpec } from "../policy";
import type { GoldenCase } from "./types";
import type { GraphSpec } from "../graph/types";
import type { PlayedTurn } from "../simulate";

const RFQ = { vehicleClass: "scooter", durationDays: 5 } as Record<string, unknown>;
const FLOOR = { floor: 150, typical: 240, currency: "THB" };

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

beforeEach(() => {
  store.cases = [];
  store.mode = "ok";
  store.refuseInserts = false;
  store.configWrites = [];
  store.inserts = [];
});

// ---------------------------------------------------------------------------
// Defects 1 + 2: the candidate spec/overlay reach the SPTE replay
// ---------------------------------------------------------------------------

// Firm once, quote 170 vs floor 150: the bargain-vs-stop verdict hinges
// ENTIRELY on priceFarAboveFloor (170 > 150*1.08 but not > 150*1.25 or *1.6),
// so this case observes exactly the threshold the overlay owns.
const FIRM_CASE: GoldenCase = {
  id: 900,
  name: "wave3: firm once, quote in the contested band",
  thread_key: null,
  rfq: RFQ,
  region: null,
  floor: FLOOR,
  turns: [
    {
      shopSays: "Okay 170 per day, last price for you.",
      stubExtraction: { found: true, pricePerDay: 170, currency: "THB", firm: true, confidence: "high" },
    },
  ],
  expects: [{ move: "bargain" }],
  enabled: true,
  created_at: "t",
};

describe("defect 1+2: the gate evaluates the candidate in the engine that ships", () => {
  it("the SPTE replay runs under the pinned DEFAULT overlay (1.08), not the 1.25 outage literal", async () => {
    const r = await replaySpteTurns({ turns: FIRM_CASE.turns, rfq: RFQ, floor: FLOOR });
    // 170 > 150*1.08: one more push is licensed. Reverting the overlay plumbing
    // drops the guard back to the 1.25 literal (170 < 187.5) and this fails.
    expect(r.turns[0].move).toBe("bargain");
  });

  it("a candidate overlay CHANGES the SPTE verdict - baseline and candidate can now disagree", async () => {
    const soft = clampOverlay({ priceFarAboveFloor: 1.6 });
    const r = await replaySpteTurns({ turns: FIRM_CASE.turns, rfq: RFQ, floor: FLOOR, overlay: soft });
    expect(r.turns[0].move).not.toBe("bargain");
    expect(r.turns[0].move).toBe("deposit-probe");
  });

  it("runGoldenCase forwards the candidate to the SPTE column (the gate can fail there)", async () => {
    const baseline = await runGoldenCase(FIRM_CASE, {});
    expect(baseline.pass).toBe(true);
    const candidate = await runGoldenCase(FIRM_CASE, {
      overlay: clampOverlay({ priceFarAboveFloor: 1.6 }),
    });
    // Before Wave 3 the candidate was never handed to replaySpteTurns, so this
    // column agreed with baseline by construction and the gate could not bite.
    expect(candidate.pass).toBe(false);
    expect(candidate.turns[0].failures.join(" ")).toContain("move");
  });

  it("the candidate's bannedPhrases scrub is exercised by the replay", async () => {
    const turns = [
      {
        shopSays: "300 baht per day.",
        stubExtraction: { found: true, pricePerDay: 300, currency: "THB", confidence: "high" },
      },
    ];
    const clean = await replaySpteTurns({ turns, rfq: RFQ, floor: FLOOR });
    expect(clean.turns[0].ourReply ?? "").toMatch(/any chance/i);
    const banned = await replaySpteTurns({
      turns,
      rfq: RFQ,
      floor: FLOOR,
      overlay: clampOverlay({ bannedPhrases: ["any chance"] }),
    });
    expect(banned.turns[0].ourReply ?? "").not.toMatch(/any chance/i);
    expect(banned.turns[0].ourReply ?? "").not.toBe("");
  });

  it("the candidate spec's round cap governs the replay", async () => {
    const turns = [
      {
        shopSays: "300 baht per day.",
        stubExtraction: { found: true, pricePerDay: 300, currency: "THB", confidence: "high" },
      },
    ];
    const noRounds = { settings: { maxRoundsPerShop: 0 } } as unknown as GraphSpec;
    const capped = await replaySpteTurns({ turns, rfq: RFQ, floor: FLOOR, spec: noRounds });
    expect(capped.turns[0].move).not.toBe("bargain");
    const free = await replaySpteTurns({ turns, rfq: RFQ, floor: FLOOR });
    expect(free.turns[0].move).toBe("bargain");
  });
});

// ---------------------------------------------------------------------------
// Defect 3: an unreadable golden store fails CLOSED
// ---------------------------------------------------------------------------

describe("defect 3: the gate refuses to approve what it could not check", () => {
  it("an unreadable store marks the report and goldenGateBlocks refuses", async () => {
    store.mode = "unavailable";
    const report = await runGoldenSuite();
    expect(report.storeError).toBe("unavailable");
    expect(report.total).toBe(0);
    const blocked = goldenGateBlocks(report);
    expect(blocked).toBeTruthy();
    expect(blocked).toMatch(/could not read|refusing/i);
  });

  it("a READABLE empty suite passes vacuously, with an honest note", async () => {
    store.refuseInserts = true; // keep the coherence seeder from populating it
    const report = await runGoldenSuite();
    expect(report.storeError).toBeUndefined();
    expect(report.total).toBe(0);
    expect(report.note).toMatch(/no golden cases/i);
    expect(goldenGateBlocks(report)).toBeNull();
  });

  it("a red case still blocks (the classic gate)", async () => {
    store.refuseInserts = true;
    store.cases.push({
      ...FIRM_CASE,
      id: 1,
      name: "red on purpose",
      expects: [{ move: "farewell" }],
      created_at: "2026-08-02T00:00:00Z",
    });
    const report = await runGoldenSuite();
    expect(report.total).toBe(1);
    expect(report.passed).toBe(0);
    expect(goldenGateBlocks(report)).toMatch(/failed \(0\/1\)/);
  });

  it("every activation gate goes through goldenGateBlocks (source pins)", () => {
    const gates = [
      "src/app/api/admin/graph/route.ts",
      "src/app/api/admin/ops/rules/route.ts",
      "src/app/api/admin/ops/policy/route.ts",
      "src/app/api/admin/ops/review/route.ts",
      "src/app/api/admin/graph/coach/route.ts",
    ];
    for (const p of gates) {
      const code = readCode(p);
      expect(code, p).toMatch(/goldenGateBlocks/);
      // The fail-open shape must not come back: total 0 means UNKNOWN when the
      // store is unreadable, and only goldenGateBlocks knows the difference.
      expect(code, p).not.toMatch(/total > 0 && \w+\.passed < /);
    }
    // ops/policy has both the save gate and the rollback gate.
    expect(readCode("src/app/api/admin/ops/policy/route.ts").match(/goldenGateBlocks\(/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Defect 4: the Coach writes through the same gate (source pin - Next route)
// ---------------------------------------------------------------------------

describe("defect 4: the Coach path is gated", () => {
  it("the coach route runs the golden suite on its candidate and refuses on a block", () => {
    const code = readCode("src/app/api/admin/graph/coach/route.ts");
    expect(code).toMatch(/runGoldenSuite\(\{ spec: candidate \}\)/);
    expect(code).toMatch(/goldenGateBlocks/);
    expect(code).toMatch(/status: 409/);
    expect(code).toMatch(/replayReport: report/);
  });
});

// ---------------------------------------------------------------------------
// Defect 5: compiled learning is versioned + gated via saveVersionedSpec
// ---------------------------------------------------------------------------

describe("defect 5: ops_learning goes through the policy chokepoint", () => {
  it("saveVersionedSpec supports kind ops_learning: config write + policy_versions row", async () => {
    const res = await saveVersionedSpec({
      kind: "ops_learning",
      spec: { compiledAt: "t", edgePriorLines: [], directorExemplars: [], judgeCalibration: [] },
      note: "test",
      author: "t@t",
    });
    expect(res.ok).toBe(true);
    expect(store.configWrites.some((w) => w.key === "ops_learning")).toBe(true);
    const version = store.inserts.find((i) => i.table === "policy_versions");
    expect(version?.rows[0]?.kind).toBe("ops_learning");
  });

  it("recompileOpsLearning lands as a versioned ops_learning row, not a bare setConfig", async () => {
    store.refuseInserts = false;
    await recompileOpsLearning();
    expect(store.configWrites.some((w) => w.key === "ops_learning")).toBe(true);
    const version = store.inserts.find(
      (i) => i.table === "policy_versions" && i.rows[0]?.kind === "ops_learning"
    );
    expect(version).toBeTruthy();
  });

  it("recompile REFUSES to activate when the golden store is unreadable", async () => {
    store.mode = "unavailable";
    await recompileOpsLearning();
    expect(store.configWrites.some((w) => w.key === "ops_learning")).toBe(false);
    expect(store.inserts.some((i) => i.table === "policy_versions")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Defect 7: the coherence guards are pinned into the replayed window
// ---------------------------------------------------------------------------

describe("defect 7: authored coherence guards can never be evicted by the window", () => {
  it("all coherence cases are included regardless of age; the window applies to the rest", async () => {
    for (let i = 1; i <= 12; i++) {
      store.cases.push({
        id: i,
        name: `coherence: guard ${i}`,
        enabled: true,
        created_at: "2026-01-01T00:00:00Z", // far older than every frozen case
        turns: [],
        expects: [],
      });
    }
    for (let i = 1; i <= 40; i++) {
      store.cases.push({
        id: 100 + i,
        name: `frozen ${i}`,
        enabled: true,
        created_at: `2026-08-01T00:${String(i).padStart(2, "0")}:00Z`,
        turns: [],
        expects: [],
      });
    }
    const list = await listGoldenCasesStrict(true);
    expect(list.storeError).toBeUndefined();
    const names = list.cases.map((c) => c.name);
    // The twelve authored guards are ALL present - the old single newest-first
    // window (48) kept only the newest rows, so 12 old seeds + 40 frozen cases
    // silently dropped four guards.
    for (let i = 1; i <= 12; i++) expect(names).toContain(`coherence: guard ${i}`);
    // The remainder window: 48 total = 12 pinned + the newest 36 frozen cases.
    expect(list.cases.length).toBe(48);
    expect(names).toContain("frozen 40");
    expect(names).not.toContain("frozen 1");
  });

  it("an unreadable store is reported, not collapsed to an empty suite", async () => {
    store.mode = "unavailable";
    const list = await listGoldenCasesStrict(true);
    expect(list.storeError).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// Defect 8: create-from-thread freezes the PRIMARY engine's move
// ---------------------------------------------------------------------------

describe("defect 8: frozen real conversations gate SPTE, not only the graph", () => {
  it("an SPTE-composed outbound freezes both the action and the move", () => {
    expect(expectationFromOutbound({ kind: "auto-bargain", engine: "v3", move: "bargain" })).toEqual({
      action: "bargain",
      move: "bargain",
    });
  });

  it("the legacy move name normalizes and unknown moves are dropped, never frozen", () => {
    expect(expectationFromOutbound({ kind: "auto-close", engine: "v3", move: "close" })).toEqual({
      action: "close",
      move: "farewell",
    });
    expect(expectationFromOutbound({ kind: "auto-bargain", engine: "v3", move: "nonsense" })).toEqual({
      action: "bargain",
    });
  });

  it("a graph-composed outbound stays action-only (no invented move)", () => {
    expect(expectationFromOutbound({ kind: "auto-bargain" })).toEqual({ action: "bargain" });
    expect(expectationFromOutbound(null)).toEqual({});
  });

  it("the route uses the shared builder and probes before freezing the move column", () => {
    const code = readCode("src/app/api/admin/ops/golden/route.ts");
    expect(code).toMatch(/expectationFromOutbound\(next\?\.raw\)/);
    expect(code).toMatch(/runGoldenCase/); // the red-from-birth probe
  });
});

// ---------------------------------------------------------------------------
// Defect 9: the misread freeze carries the REAL facts
// ---------------------------------------------------------------------------

describe("defect 9: a misread golden case replays the facts the misread was about", () => {
  it("the stub derives the verified facts each misread kind implies", () => {
    expect(misreadStubExtraction("option-menu", { found: true, pricePerDay: 200, currency: "THB" }))
      .toMatchObject({ found: true, pricePerDay: 200, currency: "THB", variance: true });
    expect(misreadStubExtraction("clarifying-question", null)).toMatchObject({ askedQuestion: true });
    expect(misreadStubExtraction("location-request", null)).toMatchObject({ askedLocation: true });
    expect(misreadStubExtraction("decline", null)).toMatchObject({ declined: true, found: false });
    expect(misreadStubExtraction("firm", { found: true, pricePerDay: 280 })).toMatchObject({
      firm: true,
      pricePerDay: 280,
    });
    expect(
      misreadStubExtraction("photo-price-board", { found: true, pricePerDay: 250 })
    ).toMatchObject({ sheetPricePerDay: 250 });
    expect(misreadTurn({ shopMessage: "x", actualMeaning: "photo-price-board" }).imageKind).toBe(
      "price_sheet"
    );
  });

  it("a clarifying-question freeze now PASSES its probe (the old empty stub was a dead end)", async () => {
    const correction = {
      shopMessage: "Which day you want to start? And how many days?",
      actualMeaning: "clarifying-question" as const,
      shouldHaveMoved: "answer" as const,
    };
    // NEW: the stub carries askedQuestion, so `answer` is legal and chosen.
    const fixed = await replaySpteTurns({
      turns: [misreadTurn(correction, null)],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(fixed.turns[0].move).toBe("answer");
    // OLD: an empty stubExtraction erased the question - the very fact the
    // misread was about - so the probe failed and the case was stored disabled.
    const deadEnd = await replaySpteTurns({
      turns: [{ shopSays: correction.shopMessage, stubExtraction: {} }],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(deadEnd.turns[0].move).not.toBe("answer");
  });

  it("the frozen case passes runGoldenCase end to end (enabled, gating)", async () => {
    const gc: GoldenCase = {
      id: 901,
      name: "misread clarifying-question - shop",
      thread_key: "u:1",
      rfq: RFQ,
      region: null,
      floor: FLOOR,
      turns: [
        misreadTurn(
          {
            shopMessage: "Which day you want to start? And how many days?",
            actualMeaning: "clarifying-question",
            shouldHaveMoved: "answer",
          },
          null
        ),
      ],
      expects: [{ move: "answer" }],
      enabled: true,
      created_at: "t",
    };
    const probe = await runGoldenCase(gc);
    expect(probe.pass).toBe(true);
  });

  it("the review route feeds the real thread context into the freeze (source pin)", () => {
    const code = readCode("src/app/api/admin/ops/review/route.ts");
    expect(code).toMatch(/misreadTurn\(misread, parse\)/);
    expect(code).toMatch(/vendor_replies/);
    expect(code).toMatch(/floor=\(\\d\+\)/); // the comparator-trace floor parse
    expect(code).not.toMatch(/stubExtraction: \{\}/);
  });
});

// ---------------------------------------------------------------------------
// Defect 10: session.lowest models the live session (one nudge at floor, lock)
// ---------------------------------------------------------------------------

describe("defect 10: the replay's session low is the live one", () => {
  it("this shop's own prior quote IS the session low - no explicit rival needed", async () => {
    const r = await replaySpteTurns({
      turns: [
        {
          shopSays: "We have Click, 200 per day.",
          stubExtraction: { found: true, pricePerDay: 200, currency: "THB", confidence: "high" },
        },
        {
          shopSays: "Okay for you 180 per day.",
          stubExtraction: { found: true, pricePerDay: 180, currency: "THB", confidence: "high" },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(r.turns[0].sessionLowest).toBeNull(); // fresh session, nothing stored yet
    expect(r.turns[1].sessionLowest).toBe(200); // the prior stored quote, as live reads it
  });

  it("with listed rivals the anchor is the CHEAPEST, not the first", async () => {
    const r = await replaySpteTurns({
      turns: [
        {
          shopSays: "300 per day.",
          stubExtraction: { found: true, pricePerDay: 300, currency: "THB", confidence: "high" },
          rivalOffers: [
            { vendorId: "a", pricePerDay: 250, currency: "THB", createdAt: "t" },
            { vendorId: "b", pricePerDay: 190, currency: "THB", createdAt: "t" },
          ],
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(r.turns[0].sessionLowest).toBe(190);
  });

  it("one nudge at/below the session low, then LOCK - now reachable in the gate", async () => {
    const r = await replaySpteTurns({
      turns: [
        {
          shopSays: "We have Click, 200 per day.",
          stubExtraction: { found: true, pricePerDay: 200, currency: "THB", confidence: "high" },
        },
        {
          // The case carries OUR push (Wave 3 schema: ourReplyBefore), so
          // alreadyPushedAtFloor sees the 170 ask; the shop's 180 sits at/below
          // the session low (200) -> exactly one nudge was spent -> lock.
          ourReplyBefore: "Could you do 170? that would work for me",
          shopSays: "Okay for you 180 per day.",
          stubExtraction: { found: true, pricePerDay: 180, currency: "THB", confidence: "high" },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(r.turns[1].legalMoves).not.toContain("bargain");
    expect(r.turns[1].move).not.toBe("bargain");
  });
});

// ---------------------------------------------------------------------------
// Defect 11: replay context completeness (ledger, stock, logistics, identity)
// ---------------------------------------------------------------------------

describe("defect 11: the replayed context carries what live derives", () => {
  it("the ask-once ledger gate is testable: an outstanding deposit ask retires the probe", async () => {
    const r = await replaySpteTurns({
      turns: [
        {
          // Firm once + quote below the far-above band -> bargaining retires,
          // so the probe ladder is what decides - and our earlier deposit ask
          // (carried by the case) makes deposit-probe illegal.
          ourReplyBefore: "Could you tell me the deposit?",
          shopSays: "155 per day, last price cannot go lower.",
          stubExtraction: { found: true, pricePerDay: 155, currency: "THB", firm: true, confidence: "high" },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(r.turns[0].legalMoves).not.toContain("deposit-probe");
    expect(r.turns[0].move).toBe("fulfillment-probe");
  });

  it("the out-of-stock branch is testable: the ledger's stock state reaches the replay", async () => {
    const r = await replaySpteTurns({
      turns: [{ shopSays: "Now I don't have bike.", stubExtraction: { found: false } }],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(r.turns[0].move).toBe("restock-probe");
  });

  it("the logistics close-out is testable: settled deposit+handover complete the deal", async () => {
    const r = await replaySpteTurns({
      turns: [
        {
          shopSays: "200 per day, deposit 3000 cash, you pickup at our shop.",
          stubExtraction: { found: true, pricePerDay: 200, currency: "THB", confidence: "high" },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    // A complete deal goes to the shop for confirmation FIRST (step 7 -
    // verify-recap); `present` is state-only and comes after the shop's yes.
    expect(r.turns[0].legalMoves).toContain("verify-recap");
    expect(r.turns[0].legalMoves).not.toContain("bargain");
  });

  it("the identity gate is testable: a frozen needs-confirmation verdict blocks price moves", async () => {
    const r = await replaySpteTurns({
      turns: [
        {
          shopSays: "Beat is 400 per day.",
          stubExtraction: {
            found: true,
            pricePerDay: 400,
            currency: "THB",
            confidence: "high",
            vehicleStatus: "needs-confirmation",
            vehicleQuestion: "Is that for the 125cc Click?",
          },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(r.turns[0].move).toBe("confirm-vehicle");
    expect(r.turns[0].ourReply).toContain("125cc Click");
  });

  it("BACKWARD COMPAT: a bare pre-Wave3 case still replays to the same move", async () => {
    // No ourReplyBefore, no new stub fields, single plain turn - the derived
    // context computes today's values (empty ledger effects, no lock) and the
    // decision is unchanged.
    const r = await replaySpteTurns({
      turns: [
        {
          shopSays: "Hello! Yes we have Click 125 available, 300 baht per day.",
          stubExtraction: { found: true, pricePerDay: 300, currency: "THB", confidence: "high" },
        },
      ],
      rfq: RFQ,
      floor: FLOOR,
    });
    expect(r.turns[0].move).toBe("bargain");
  });
});

// ---------------------------------------------------------------------------
// Defect 12: engine-scoped noMessageContains reporting
// ---------------------------------------------------------------------------

describe("defect 12: noMessageContains is checked per target engine", () => {
  const graphPlayed = (reply: string): PlayedTurn =>
    ({
      shopSays: "s",
      action: "bargain",
      ourReply: reply,
      path: [],
      state: { rounds: 0, firmCount: 0, dealComplete: false },
      stages: [],
    }) as unknown as PlayedTurn;

  it("an SPTE-only turn is NOT judged on the dormant graph's reply", () => {
    const failures = evaluateTurn(
      { move: "bargain", noMessageContains: ["as text"] },
      graphPlayed("please send it as text"), // graph said the banned thing...
      { move: "bargain", ourReply: "clean reply" } // ...but SPTE - which ships - did not
    );
    expect(failures).toEqual([]);
  });

  it("a graph-targeting turn still checks the graph reply, labeled as such", () => {
    const failures = evaluateTurn(
      { action: "bargain", noMessageContains: ["as text"] },
      graphPlayed("please send it as text"),
      { move: "bargain", ourReply: "clean reply" }
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("graph message contains banned");
  });

  it("a banned phrase in BOTH engines on a dual-target turn reports each engine once", () => {
    const failures = evaluateTurn(
      { action: "bargain", noMessageContains: ["as text"] },
      graphPlayed("please send it as text"),
      { move: "bargain", ourReply: "send it as text please" }
    );
    expect(failures).toHaveLength(2);
    expect(failures.join(" ")).toContain("SPTE message contains banned");
    expect(failures.join(" ")).toContain("graph message contains banned");
  });

  it("legacy graph-only evaluation (no SPTE replay) keeps checking the graph reply", () => {
    const failures = evaluateTurn(
      { noMessageContains: ["as text"] },
      graphPlayed("please send it as text")
    );
    expect(failures).toHaveLength(1);
  });
});
