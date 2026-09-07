// AUDIT F151 - a forwarded price board's reading is not this shop's own price.
//
// Ingest stamps `raw.forwarded` on an inbound row (wa/ingest.ts), and the turn
// stamps `raw.reading` - the board's parsed prices - onto that SAME row. The
// provenance stamp was consulted at exactly two places, both on the offers
// path, so `onlyForwardedContent` correctly refused to bank an offer while the
// two consumers that turn `raw.reading.prices` into a NUMBER read it happily:
// /api/replies fed it to effectivePriceFor as `boardPrices` ("Read from their
// price-menu photo - 150/day" on shop A's card), and graph/engine's
// priceless-shop rescue wrote it into shop A's rival row, whose own comment
// says the table is quoted at OTHER shops as "another shop does 150".
//
// Three things are pinned here: the pure attribution rule, the burst predicate
// that decides whether the BOARD was forwarded, and the two readers.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attributablePrices } from "./reading";
import { onlyForwardedMedia } from "../wa/coalesce";

const board = [
  { pricePerDay: 150, currency: "THB", available: true },
  { pricePerDay: 220, currency: "THB", available: true },
];

describe("F151 - attributablePrices refuses somebody else's board", () => {
  it("THE BUG: a reading marked as forwarded contributes no price", () => {
    expect(attributablePrices({ forwardedSource: true, prices: board })).toEqual([]);
  });

  it("the shop's own board is untouched", () => {
    expect(attributablePrices({ prices: board })).toEqual(board);
    expect(attributablePrices({ forwardedSource: false, prices: board })).toEqual(board);
  });

  it("a missing or empty reading is simply empty, never a throw", () => {
    expect(attributablePrices(null)).toEqual([]);
    expect(attributablePrices(undefined)).toEqual([]);
    expect(attributablePrices({})).toEqual([]);
  });
});

describe("F151 - onlyForwardedMedia asks whose BOARD this is", () => {
  const at = (n: number) => new Date(1_800_000_000_000 + n * 1000).toISOString();

  it("a forwarded board with no board of the shop's own is somebody else's", () => {
    expect(
      onlyForwardedMedia(
        [{ direction: "inbound", body: "", received_at: at(2), forwarded: true, hasMedia: true }],
        at(1)
      )
    ).toBe(true);
  });

  it("...even when the shop also typed a price of its own", () => {
    // This is the case onlyForwardedContent deliberately lets through - the
    // shop DID quote 300 - but the BOARD is still the rival's, and the board is
    // what the reading is a reading of.
    expect(
      onlyForwardedMedia(
        [
          { direction: "inbound", body: "our rate is 300", received_at: at(2), hasMedia: false },
          { direction: "inbound", body: "", received_at: at(3), forwarded: true, hasMedia: true },
        ],
        at(1)
      )
    ).toBe(true);
  });

  it("the shop's own photo is its own, forwarded text beside it or not", () => {
    expect(
      onlyForwardedMedia(
        [
          { direction: "inbound", body: "look", received_at: at(2), forwarded: true },
          { direction: "inbound", body: "", received_at: at(3), hasMedia: true },
        ],
        at(1)
      )
    ).toBe(false);
  });

  it("no media in the burst at all is not a forwarded board", () => {
    expect(
      onlyForwardedMedia(
        [{ direction: "inbound", body: "250 a day", received_at: at(2), forwarded: true }],
        at(1)
      )
    ).toBe(false);
  });

  it("only frames since the last outbound count", () => {
    expect(
      onlyForwardedMedia(
        [{ direction: "inbound", body: "", received_at: at(0), forwarded: true, hasMedia: true }],
        at(1)
      )
    ).toBe(false);
  });
});

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

// The two readers themselves are EXECUTED in ./forwarded-board-executed.test.ts
// - these pins only guard the shapes a targeted revert could restore while
// leaving the imports and the prose in place (which is exactly what kept this
// block green over reverted code once already).
describe("F151 - the two readers that turn a reading into a number", () => {
  it("the turn marks the reading with its provenance", () => {
    const loop = read("src/lib/agent-loop.ts");
    expect(loop).toContain("onlyForwardedMedia");
    expect(loop).toContain("forwardedSource");
  });

  it("/api/replies projects the provenance and drops a forwarded board", () => {
    const route = read("src/app/api/replies/route.ts");
    // A jsonb-path scalar, not the whole `raw` blob - this route runs on a 6s
    // poll and its own comment records that projecting `raw` was the biggest
    // remaining egress.
    expect(route).toContain("forwarded:raw->>forwarded");
    expect(route).not.toContain("select=from_number,body,raw&");
    expect(route).toContain("attributablePrices");
    // ABSENCE: the unguarded merge this replaced. Restoring it leaves the
    // import and the projection in place, so only this line notices.
    expect(route).not.toContain(
      "arr.push(...m.reading.prices.filter((p) => Number(p?.pricePerDay) > 0));"
    );
  });

  it("the cross-thread rival rescue drops it too", () => {
    const engine = read("src/lib/graph/engine.ts");
    // Its query already projects `raw`, so the provenance is free there.
    const rescue = engine.slice(engine.indexOf("A BOARD PHOTOGRAPHED IN THREAD A"));
    expect(rescue).toContain("attributablePrices");
    // Both call sites go through the attribution helper...
    expect(rescue).toContain("ownBoard(m)");
    expect(rescue).toContain("ownBoard(read)");
    // ...and ABSENCE: the raw reads they replaced. `toContain("forwarded")`
    // alone was satisfied by the comment prose above, and tsconfig sets no
    // noUnusedLocals, so a revert of the two call sites left an unused helper
    // and a green suite.
    expect(rescue).not.toMatch(/raw\?\.reading\?\.prices/);
  });
});
