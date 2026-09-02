import { describe, it, expect } from "vitest";
import { isMoneyContext, findNumerals, citesPrice } from "./money-context";
import { normalizeDigits } from "./translation";

// The rail this backs used to count ANY numeral within 1 unit of a real rival
// as "the rival was cited". Every case in the first block below satisfied it
// while naming no price at all.

const cites = (s: string, prices: number[]) => citesPrice(normalizeDigits(s), prices);

describe("a coincidence is not a citation", () => {
  it("a date does not cite a rival at 17", () => {
    expect(cites("Can we pick it up on the 17 Aug?", [17])).toBe(false);
    expect(cites("Aug 17 pickup, is that ok?", [17])).toBe(false);
    expect(cites("we arrive on the 17th", [17])).toBe(false);
    expect(cites("17/08 to 20/08", [17])).toBe(false);
  });
  it("a duration does not cite a rival at 5", () => {
    expect(cites("We need it for 5 days", [5])).toBe(false);
    expect(cites("5 nights, starting Friday", [5])).toBe(false);
  });
  it("a spec does not cite a rival at 125", () => {
    expect(cites("Do you have the 125cc one?", [125])).toBe(false);
    expect(cites("about 125 km per day", [125])).toBe(false);
  });
  it("a headcount does not cite a rival at 2", () => {
    expect(cites("2 people, 2 helmets please", [2])).toBe(false);
  });
  it("a clock time does not cite a rival at 12", () => {
    expect(cites("pickup at 12:30", [12])).toBe(false);
  });
});

describe("a real citation still passes - the rail must not reject correct output", () => {
  it("the owner's own sentence", () => {
    expect(cites("Another shop offered 200 for the same scooter, can you do 180?", [200])).toBe(true);
  });
  it("the deterministic bargain template, with currency and a per-day suffix", () => {
    expect(
      cites("Thanks! Another shop offered IDR 100000/day for the same scooter - could you do IDR 95000/day for 5 days?", [100000])
    ).toBe(true);
  });
  it("a bare number in a money sentence", () => {
    expect(cites("I was quoted 250 elsewhere - can you beat that?", [250])).toBe(true);
  });
  it("a symbol-suffixed price", () => {
    expect(cites("another shop said 200฿ per day", [200])).toBe(true);
  });
  it("a price range keeps its numbers as money", () => {
    expect(cites("others are quoting 200-250", [250])).toBe(true);
  });
  it("thousands separators fold", () => {
    expect(cites("another shop offered 1,200 a day", [1200])).toBe(true);
  });
  it("Thai numerals - the local-language markets this app is sold for", () => {
    expect(cites("อีกร้านเสนอ ๒๐๐ บาท", [200])).toBe(true);
  });
  it("the rounding tolerance survives", () => {
    expect(cites("another shop offered 201", [200])).toBe(true);
    expect(cites("another shop offered 203", [200])).toBe(false);
  });
});

describe("the mixed sentence - the case that makes this worth doing", () => {
  // A bargain that carries a date AND a real citation must pass; one that
  // carries only the date must not.
  const withCite = "Another shop offered 200 - can you do 180 for the 17 Aug pickup?";
  const dateOnly = "Can you give us a better rate for the 17 Aug pickup?";
  it("passes when the price is named alongside the date", () => {
    expect(cites(withCite, [200])).toBe(true);
  });
  it("fails when only the date happens to match the rival", () => {
    expect(cites(dateOnly, [17])).toBe(false);
    // and the pre-fix behaviour is what this replaces: a bare numeral scan
    // would have found 17 and called it a citation.
    expect((dateOnly.match(/\d[\d,.]*/g) ?? []).map(Number)).toContain(17);
  });
});

describe("findNumerals reports offsets and money-ness per numeral", () => {
  it("tags each numeral independently in one sentence", () => {
    const found = findNumerals(normalizeDigits("200 per day for 5 days from 17 Aug"));
    expect(found.map((n) => [n.value, n.money])).toEqual([
      [200, true],
      [5, false],
      [17, false],
    ]);
  });
  it("a trailing sentence period is not a decimal point", () => {
    const found = findNumerals("we can do 180.");
    expect(found[0]?.value).toBe(180);
  });
});

describe("isMoneyContext is exported for callers that already have offsets", () => {
  it("reads the window around the numeral, not the whole string", () => {
    const s = "budget 200, arriving 17 Aug";
    expect(isMoneyContext(s, 7, 10)).toBe(true); // 200
    expect(isMoneyContext(s, 21, 23)).toBe(false); // 17
  });
});

describe("no prices to cite means no citation", () => {
  it("empty and non-finite price lists return false", () => {
    expect(cites("another shop offered 200", [])).toBe(false);
    expect(cites("another shop offered 200", [Number.NaN, 0, -5])).toBe(false);
  });
});
