import { describe, it, expect, vi } from "vitest";

// The golden harness itself, run through the REAL engine with the default
// graph - deterministic end to end (stubbed extraction, frozen floor, no LLM,
// frozen clock). These hardcoded cases make CI an eval gate for engine
// changes, exactly like the owner's frozen production conversations.

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async () => ({ text: null }),
  chatVision: async () => null,
  extractJson: () => null,
}));
vi.mock("../runtime-config", () => ({
  getConfig: async () => undefined,
  setConfig: async () => {},
  sbInsert: async () => true,
  sbInsertReturning: async () => [],
  sbSelect: async () => [],
  sbUpdate: async () => {},
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

import { replayConversation, replaySpteTurns } from "../simulate";
import { evaluateCase, evaluateTurn } from "./golden";
import { defaultGraphSpec } from "../graph/default-graph";
import type { GoldenCase } from "./types";

const RFQ = { vehicleClass: "scooter", durationDays: 5 } as Record<string, unknown>;

const CASE_BARGAIN: GoldenCase = {
  id: 1,
  name: "quote far above floor -> bargain toward the floor",
  thread_key: null,
  rfq: RFQ,
  region: "Chiang Mai, Thailand",
  floor: { floor: 150, typical: 240, currency: "THB" },
  turns: [
    {
      shopSays: "Hello! Yes we have Click 125 available, 300 baht per day.",
      stubExtraction: { found: true, pricePerDay: 300, currency: "THB", matchesSpec: true, confidence: "high" },
    },
  ],
  expects: [{ action: "bargain", targetAtLeast: 150, noMessageContains: ["final offer"] }],
  enabled: true,
  created_at: "t",
};

describe("golden replay harness", () => {
  it("replays deterministically through the real engine (bargain case)", async () => {
    const spec = defaultGraphSpec();
    const a = await replayConversation({ turns: CASE_BARGAIN.turns, rfq: RFQ, region: CASE_BARGAIN.region ?? undefined, floor: CASE_BARGAIN.floor, spec });
    const b = await replayConversation({ turns: CASE_BARGAIN.turns, rfq: RFQ, region: CASE_BARGAIN.region ?? undefined, floor: CASE_BARGAIN.floor, spec });
    // The deterministic contract: identical DECISIONS across runs - action,
    // traversed path, chosen edge, negotiated target. Message WORDING varies
    // deliberately (the anti-template uniqueness layer), which is why the
    // gate's expectations are decision-level, not prose-level.
    expect(a.turns.map((t) => t.action)).toEqual(b.turns.map((t) => t.action));
    expect(a.turns.map((t) => t.path)).toEqual(b.turns.map((t) => t.path));
    expect(a.turns.map((t) => t.ladder?.find((r) => r.chosen)?.edgeId)).toEqual(
      b.turns.map((t) => t.ladder?.find((r) => r.chosen)?.edgeId)
    );
    expect(a.turns.map((t) => t.state.lastTarget)).toEqual(b.turns.map((t) => t.state.lastTarget));

    const result = evaluateCase(CASE_BARGAIN, a.turns);
    expect(result.pass).toBe(true);
    expect(a.turns[0].action).toBe("bargain");
    expect(a.turns[0].state.lastTarget).toBeGreaterThanOrEqual(150);
  });

  it("a broken candidate overlay FAILS the same case (the gate bites)", async () => {
    const spec = defaultGraphSpec();
    // floorTolerance clamped max 1.15... use priceFarAboveFloor at max 1.6 +
    // defaultCut 0.95: quote 300 vs floor 150 is still far above, so bargain
    // still fires - instead break it via floorTolerance 1.15 with a quote
    // near the floor in a second scenario? Simpler: an expectation that the
    // candidate's higher lowball guard breaks (targetAtLeast tightened).
    const tightened: GoldenCase = {
      ...CASE_BARGAIN,
      expects: [{ action: "bargain", targetAtLeast: 500 }], // impossible on purpose
    };
    const run = await replayConversation({ turns: tightened.turns, rfq: RFQ, region: tightened.region ?? undefined, floor: tightened.floor, spec });
    const result = evaluateCase(tightened, run.turns);
    expect(result.pass).toBe(false);
    expect(result.turns[0].failures.join(" ")).toContain("target");
  });

  it("W10 INVERSION: a MOVE-LESS case still replays the PRIMARY engine", async () => {
    // CASE_BARGAIN asserts only graph-engine facts (action/target) - under the
    // old `wantsMove` skip, SPTE never ran for it, so an SPTE crash on exactly
    // this frozen conversation passed the gate. Now every case replays both:
    // got.move is populated (proof SPTE ran), and a replay crash in either
    // engine fails the case via runGoldenCase's catch.
    const { runGoldenCase } = await import("./golden");
    const result = await runGoldenCase(CASE_BARGAIN);
    expect(result.pass).toBe(true);
    expect(result.turns[0].got.move).toBeTruthy();
  });

  it("multi-turn: firm shop with rival leverage keeps pushing, then respects two firms", async () => {
    const spec = defaultGraphSpec();
    const turns = [
      {
        shopSays: "Click 125 is 300 baht per day.",
        stubExtraction: { found: true, pricePerDay: 300, currency: "THB", matchesSpec: true, confidence: "high" },
      },
      {
        shopSays: "Sorry, 280 is my last price.",
        stubExtraction: { found: true, pricePerDay: 280, currency: "THB", matchesSpec: true, confidence: "high", shopFirm: true },
        rivalPricePerDay: 220,
      },
    ];
    const run = await replayConversation({
      turns,
      rfq: RFQ,
      region: "Chiang Mai, Thailand",
      floor: { floor: 150, typical: 240, currency: "THB" },
      spec,
    });
    expect(run.turns[0].action).toBe("bargain");
    // One firm + a cheaper rival + far above floor = the engine keeps pushing
    // (the exact behavior the owner demanded in the negotiation audit).
    expect(run.turns[1].action).toBe("bargain");
    expect(run.turns[1].state.rounds).toBe(2);
  });

  // --------------------------------------------------------------------------
  // THE PRIMARY ENGINE. Everything above gates the GRAPH engine, which is the
  // dormant fallback. These two cases are frozen from the live Krabi threads of
  // 26 Jul and gate SPTE - the engine that actually answers shops.
  // --------------------------------------------------------------------------
  describe("SPTE replay - real misreads frozen so they cannot come back", () => {
    it("MARLIN: a price MENU is resolved, never answered with a goodbye", async () => {
      const marlin: GoldenCase = {
        id: 101,
        name: "menu of two tiers -> option-probe, not redirect-close",
        thread_key: null,
        rfq: RFQ,
        region: "Krabi, Thailand",
        floor: { floor: 150, typical: 240, currency: "THB" },
        turns: [
          {
            // Verbatim. The old engine read "Normal scooters?" as the shop
            // naming a different vehicle, returned wrongVehicle, and the whole
            // thread became terminal after one message.
            shopSays: "Hi! Normal scooters? Some models 200 and some new 250/day",
            stubExtraction: {
              found: true,
              pricePerDay: 200,
              currency: "THB",
              vehicleVerdict: "unclear",
              variance: true,
              confidence: "medium",
            },
          },
        ],
        expects: [
          {
            move: "option-probe",
            // `close` was RENAMED to `farewell` (spte/types.ts explains why: the
// model read the English word "close" as close-the-deal and agreed a
// price with a shop that had just withdrawn). This assertion was
// naming a move that can no longer occur - i.e. asserting nothing.
            moveNot: ["redirect-close", "farewell", "silent"],
            // It must not ask for the price it was just given twice.
            noMessageContains: ["send it as text"],
          },
        ],
        enabled: true,
        created_at: "t",
      };
      const spte = await replaySpteTurns({
        turns: marlin.turns,
        rfq: RFQ,
        floor: marlin.floor,
      });
      // Both tiers were read - the 200 is no longer thrown away.
      expect(spte.turns[0].optionCount).toBe(2);
      expect(spte.turns[0].move).toBe("option-probe");
      // The reply names what the shop actually said.
      expect(spte.turns[0].ourReply).toMatch(/200|250/);

      const graph = await replayConversation({
        turns: marlin.turns,
        rfq: RFQ,
        region: marlin.region ?? undefined,
        floor: marlin.floor,
        spec: defaultGraphSpec(),
      });
      expect(evaluateCase(marlin, graph.turns, spte.turns).pass).toBe(true);
    });

    it("PRICE BOARD: a photo is read and confirmed, never retyped by the shop", async () => {
      const board: GoldenCase = {
        id: 102,
        name: "photo price board -> clarify that confirms the read",
        thread_key: null,
        rfq: RFQ,
        region: "Krabi, Thailand",
        floor: { floor: 150, typical: 240, currency: "THB" },
        turns: [
          {
            shopSays: "",
            imageKind: "price_sheet",
            stubExtraction: {
              found: true,
              pricePerDay: 250,
              sheetPricePerDay: 250,
              currency: "THB",
              vehicleVerdict: "match",
              confidence: "medium",
            },
          },
        ],
        expects: [
          {
            move: "bargain",
            // The live failure, verbatim: four boards arrived and we asked for
            // the price "as text". Never again, on either engine.
            noMessageContains: ["as text", "send the price"],
          },
        ],
        enabled: true,
        created_at: "t",
      };
      const spte = await replaySpteTurns({ turns: board.turns, rfq: RFQ, floor: board.floor });
      // A price we READ is a live quote, so the ladder is bargain-first - the
      // shop is never asked to retype a board we already understood.
      expect(spte.turns[0].move).toBe("bargain");
      expect(spte.turns[0].ourReply ?? "").not.toMatch(/as text/i);
    });

    it("a regression re-appearing FAILS the gate (the move assertion bites)", async () => {
      const impossible: GoldenCase = {
        id: 103,
        name: "guard against a silent pass",
        thread_key: null,
        rfq: RFQ,
        region: null,
        floor: { floor: 150, typical: 240, currency: "THB" },
        turns: [
          {
            shopSays: "Hi! Normal scooters? Some models 200 and some new 250/day",
            stubExtraction: {
              found: true,
              pricePerDay: 200,
              currency: "THB",
              vehicleVerdict: "unclear",
              variance: true,
              confidence: "medium",
            },
          },
        ],
        // Asserting the OLD broken behaviour must fail.
        expects: [{ move: "redirect-close" }],
        enabled: true,
        created_at: "t",
      };
      const spte = await replaySpteTurns({
        turns: impossible.turns,
        rfq: RFQ,
        floor: impossible.floor,
      });
      const graph = await replayConversation({
        turns: impossible.turns,
        rfq: RFQ,
        floor: impossible.floor,
        spec: defaultGraphSpec(),
      });
      const res = evaluateCase(impossible, graph.turns, spte.turns);
      expect(res.pass).toBe(false);
      expect(res.turns[0].failures.join(" ")).toContain("move");
    });

    it("a case that asserts a move but never replayed SPTE is a failure, not a pass", () => {
      const played = {
        shopSays: "s",
        action: "bargain",
        ourReply: "x",
        path: [],
        state: {},
        stages: [],
      } as unknown as Parameters<typeof evaluateTurn>[1];
      expect(evaluateTurn({ move: "option-probe" }, played)).toHaveLength(1);
    });

    it("replay is bit-stable: same case, same moves, every run", async () => {
      const turns = [
        {
          shopSays: "Some models 200 and some new 250/day",
          stubExtraction: { found: true, pricePerDay: 200, currency: "THB", variance: true },
        },
      ];
      const a = await replaySpteTurns({ turns, rfq: RFQ, floor: { floor: 150, currency: "THB" } });
      const b = await replaySpteTurns({ turns, rfq: RFQ, floor: { floor: 150, currency: "THB" } });
      expect(a.turns.map((t) => t.move)).toEqual(b.turns.map((t) => t.move));
      expect(a.turns.map((t) => t.ourReply)).toEqual(b.turns.map((t) => t.ourReply));
    });
  });

  it("evaluateTurn covers every expectation dimension", () => {
    const played = {
      shopSays: "s",
      action: "bargain",
      ourReply: "Could you do 250? My last chance offer",
      path: ["extract", "director", "bargain", "deliver"],
      ladder: [{ edgeId: "d-bargain", label: "b", toNodeId: "bargain", toKind: "bargain", legal: true, chosen: true, why: "" }],
      state: { rounds: 1, firmCount: 0, dealComplete: false, lastTarget: 250 },
      stages: [],
    } as unknown as Parameters<typeof evaluateTurn>[1];
    expect(evaluateTurn({ action: "bargain" }, played)).toEqual([]);
    expect(evaluateTurn({ action: "close" }, played)).toHaveLength(1);
    expect(evaluateTurn({ edgeId: "d-bargain" }, played)).toEqual([]);
    expect(evaluateTurn({ edgeId: "d-close" }, played)).toHaveLength(1);
    expect(evaluateTurn({ pathContains: ["director", "bargain"] }, played)).toEqual([]);
    expect(evaluateTurn({ pathContains: ["momentum"] }, played)).toHaveLength(1);
    expect(evaluateTurn({ targetAtLeast: 200 }, played)).toEqual([]);
    expect(evaluateTurn({ targetAtLeast: 300 }, played)).toHaveLength(1);
    expect(evaluateTurn({ noMessageContains: ["last chance"] }, played)).toHaveLength(1);
  });
});
