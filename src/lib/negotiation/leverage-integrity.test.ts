import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeRoundTarget } from "../graph/math";
import { pickBoardPrice, cheapestQuotable } from "../media/reading";

// THE OWNER'S ASK, LITERALLY: "make sure we are leveraging other rental shops'
// prices vs more expensive rental shops."
//
// The machinery exists and is wired. A deep audit found four hops where it
// either drops a real rival or cites a number no shop ever said. Every one of
// those survived 207 green tests, because the load-bearing guarantees were
// pinned by source-greps - one of which locked the defect in place.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("a rival price must be a cell the traveller could actually book", () => {
  // The board an audit photographed: a long-stay tier that is cheaper, and the
  // short-stay tier that is what this traveller can buy.
  const BOARD = [
    { pricePerDay: 150, tierLabel: "15-29 days", vehicle: "Click 160", available: true },
    { pricePerDay: 300, tierLabel: "1-3 days", vehicle: "PCX 125", available: true },
  ];

  it("EXECUTED: the two pickers genuinely disagree - this is the whole bug", () => {
    // cheapestQuotable filters only crossed-out rows, so it returns the
    // long-stay column. A 3-day traveller cannot buy that column.
    expect(cheapestQuotable(BOARD)?.pricePerDay).toBe(150);
    expect(pickBoardPrice(BOARD, 125, 3)?.pricePerDay).toBe(300);
  });

  it("the rival rescue and the card now pick the SAME cell", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    // The 150 used to enter ctx.session.rivals, pass the provenance basis and
    // checkOutboundNumbers, and then the cite-the-rival rail REQUIRED the draft
    // to name it - so the agent was obliged to quote a price that did not exist
    // for this rental.
    expect(engine).toMatch(/const cheapest = pickBoardPrice\(/);
    expect(engine).not.toMatch(/cheapestQuotable/);
    expect(readCode("src/lib/effective-price.ts")).toMatch(/pickBoardPrice\(/);
  });
});

describe("the ladder BEATS the rival it cites - it never matches or exceeds it", () => {
  it("EXECUTED: a floor above the rival can no longer push the ask past it", () => {
    // The reported case: quoted 300, floor 250, rival 200 produced an ask of
    // 250 - ABOVE the price being cited in the same message.
    const t = computeRoundTarget({ quoted: 300, floorPrice: 250, rivalPrice: 200, rounds: 0 });
    expect(t).toBeDefined();
    expect(t!).toBeLessThan(200);
  });

  it("EXECUTED: the ask is never exactly the rival - a match is not leverage", () => {
    const t = computeRoundTarget({ quoted: 300, rivalPrice: 200, rounds: 2 });
    expect(t).toBeDefined();
    expect(t!).toBeLessThan(200);
  });

  it("EXECUTED: across a spread of rounds and floors, strictly below always holds", () => {
    for (const rounds of [0, 1, 2, 3]) {
      for (const floorPrice of [undefined, 120, 200, 250, 400]) {
        for (const rivalPrice of [180, 200, 240]) {
          const t = computeRoundTarget({ quoted: 300, floorPrice, rivalPrice, rounds });
          if (t === undefined) continue;
          expect(t, `rounds=${rounds} floor=${floorPrice} rival=${rivalPrice}`).toBeLessThan(
            rivalPrice
          );
        }
      }
    }
  });

  it("EXECUTED: with no rival the ladder is unchanged", () => {
    expect(computeRoundTarget({ quoted: 300, floorPrice: 250, rounds: 0 })).toBe(250);
    expect(computeRoundTarget({ quoted: 300, rounds: 3 })).toBe(290);
  });

  it("EXECUTED: a rival ABOVE the ask is not leverage and does not move it", () => {
    const withRival = computeRoundTarget({ quoted: 300, floorPrice: 200, rivalPrice: 290, rounds: 0 });
    const without = computeRoundTarget({ quoted: 300, floorPrice: 200, rounds: 0 });
    expect(withRival).toBe(without);
  });
});

describe("the hot cache cannot cite what the slow path would refuse", () => {
  const cache = readCode("src/lib/rival-cache.ts");

  it("a package rate the rental does not cover is refused AND evicted", () => {
    // The comment in search-session claimed a cache hit was "by construction
    // not package arithmetic". agent-loop wrote every usablePrice into it
    // unconditionally, divisions included - and the hot path returns BEFORE the
    // Postgres filters, so the wrong-number class came straight back.
    expect(cache).toMatch(/const basis = w\.priceBasisDays \?\? 0/);
    expect(cache).toMatch(/const packageApplies =/);
    expect(cache).toMatch(/await r\.zrem\(oKey, w\.vendorId\)/);
    expect(readCode("src/lib/agent-loop.ts")).toMatch(/priceBasisDays: priceBasisDays/);
  });

  it("a shop that said NO stops being a citable rival", () => {
    // Nothing ever evicted, so a declined shop stayed leverage for the TTL -
    // and the hot path skips the dead-phase filter that would have caught it.
    expect(cache).toMatch(/export async function dropSessionOffer/);
    expect(readCode("src/lib/agent-loop.ts")).toMatch(/const \{ dropSessionOffer \} = await import/);
  });

  it("the cache TTL no longer outlives the window Postgres considers current", () => {
    expect(cache).toMatch(/const TTL_S = 18 \* 3600/);
    expect(readCode("src/lib/search-session.ts")).toMatch(/STALE_CAP_MS/);
  });
});

describe("a rival is scoped to the hunt and the machine it belongs to", () => {
  const engine = readCode("src/lib/graph/engine.ts");

  it("the primary engine's rival board is scoped by search, not only by clock", () => {
    // Two hunts for the same vehicle class in different cities inside 18h used
    // to cross-contaminate: a Krabi price cited at a Canggu shop.
    expect(engine).toMatch(/search_id\.eq\.\$\{encodeURIComponent\(String\(session\.id\)\)\}/);
    // Null-tolerant, so rows written before the column was populated do not
    // vanish from a running hunt's board.
    expect(engine).toMatch(/search_id\.is\.null/);
  });

  it("the director's session table is scoped to the SAME vehicle", () => {
    expect(engine).toMatch(/const sessionVehicleKey = sessionVehicleKeyFor\(input\.rfq\)/);
    expect(engine).toMatch(/sessionTable\(input\.ctx\.sender, input\.ctx\.vendorId, sessionVehicleKey/);
  });

  it("the graph rival lookup carries the duration, so package rivals survive", () => {
    // Without it, cheapestRivalQuoteFor drops every derived rate - even when
    // the rental fully covers the package, which is when packages are common.
    expect(engine).toMatch(/durationDays: input\.rfq\.durationDays/);
    expect(readCode("src/lib/graph/types.ts")).toMatch(/durationDays\?: number;/);
  });

  it("a reply files its offer under the thread's own hunt, not the newest one", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/search_id=not\.is\.null&order=created_at\.asc&limit=1/);
  });
});
