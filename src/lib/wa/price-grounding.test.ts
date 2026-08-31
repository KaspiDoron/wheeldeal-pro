import { describe, it, expect } from "vitest";
import { isPriceGrounded, agreesWithUs } from "./price-grounding";

// OWNER PROBLEM 4: a price on the card that the shop never said.
//
// The rail's first version took one flat bag of numerals built from the shop's
// message AND the history window - and that window renders our own turns as
// "Us: ...". So a number we proposed grounded itself. Since our ask is anchored
// to the market floor, a model hallucinating on a template reply hallucinates
// precisely the anchored number: the rail was weakest exactly where the problem
// is strongest.

describe("the shop's own words ground a price", () => {
  it("a per-day number verbatim in the reply is grounded", () => {
    expect(isPriceGrounded(250, 4, { shopText: "250 baht per day" })).toBe(true);
  });

  it("a stated TOTAL (number x duration) grounds the derived per-day", () => {
    // "1000 total for the 4 days" -> 250/day; 1000 is in the text.
    expect(isPriceGrounded(250, 4, { shopText: "1000 total for your dates" })).toBe(true);
  });

  it("an earlier INBOUND turn still counts - the shop said it, just not now", () => {
    expect(
      isPriceGrounded(250, 4, {
        shopText: "yes still available",
        shopHistory: ["our rate is 250 per day"],
      })
    ).toBe(true);
  });
});

describe("OUR words ground a price only when the shop agrees", () => {
  it("a figure we proposed and the shop accepted is grounded", () => {
    expect(
      isPriceGrounded(250, 4, {
        shopText: "ok deal, come tomorrow",
        ourHistory: ["Could you do 250/day?"],
      })
    ).toBe(true);
  });

  it("THE HOLE: our own anchor does NOT ground itself when the shop said nothing", () => {
    // The template reply the owner photographed: an automated closure notice.
    // The model returns the number it saw us type, and the old rail agreed.
    expect(
      isPriceGrounded(250, 4, {
        shopText: "Thanks for your message! Our office is closed.",
        ourHistory: ["Could you do 250/day for the 4 days?"],
      })
    ).toBe(false);
  });

  it("a COUNTER-question is not an agreement", () => {
    expect(agreesWithUs("ok what about 300?")).toBe(false);
    expect(
      isPriceGrounded(250, 4, {
        shopText: "ok what about 300?",
        ourHistory: ["Could you do 250/day?"],
      })
    ).toBe(false);
  });

  it("a plain acceptance IS an agreement, in several spellings", () => {
    for (const yes of ["ok", "deal", "yes can", "confirmed", "no problem", "👍"]) {
      expect(agreesWithUs(yes), yes).toBe(true);
    }
    for (const no of ["", null, undefined, "hello", "we are closed today"]) {
      expect(agreesWithUs(no), String(no)).toBe(false);
    }
  });
});

describe("numerals that are structurally not money ground nothing", () => {
  it("a street address does not ground a price", () => {
    // "We are at 55/1 Moo 3" used to ground 55.
    expect(isPriceGrounded(55, 4, { shopText: "We are at 55/1 Moo 3, Ao Nang" })).toBe(false);
  });

  it("a phone number does not ground a price", () => {
    expect(isPriceGrounded(66812345678, 4, { shopText: "Call us 66812345678" })).toBe(false);
  });

  it("a real price in the SAME message as an address is still grounded", () => {
    // The strip must remove the address span, not the whole message.
    expect(
      isPriceGrounded(250, 4, { shopText: "We are at 55/1 Moo 3. Scooter is 250 per day." })
    ).toBe(true);
  });
});

describe("the hallucination cases stay refused", () => {
  it("a number that appears NOWHERE is not grounded", () => {
    expect(
      isPriceGrounded(250, 4, {
        shopText: "Please visit our website to book: example.com",
        shopHistory: ["Hi, do you have a scooter?"],
      })
    ).toBe(false);
  });

  it("a greeting with no number is not grounded", () => {
    expect(isPriceGrounded(300, 3, { shopText: "Sawasdee! welcome" })).toBe(false);
  });

  it("a zero/absent price is vacuously grounded (nothing to show)", () => {
    expect(isPriceGrounded(0, 4, { shopText: "anything" })).toBe(true);
  });

  it("no sources at all cannot ground anything", () => {
    expect(isPriceGrounded(250, 4, {})).toBe(false);
  });
});

describe("a DERIVED price is grounded through its dividend", () => {
  // agent-loop grounds `usablePrice * priceBasisDays` with days=1 for a
  // division, because the per-day figure is ours and the total is the shop's.
  it("the phantom divisions the exemption used to wave through are refused", () => {
    // Each of these divided to a per-day price the card actually showed, and
    // the `priceBasisDays !== undefined` exemption meant the rail never ran on
    // any of them. Grounding the DIVIDEND refuses all three: a clock time is
    // not a price numeral, and a number that is simply absent grounds nothing.
    for (const [dividend, text] of [
      [9, "We are open 7 days 9am to 6pm"],
      [100, "Hi! This is an automated message. We will get back to you soon"],
      [3000, "Booking requires 2 days deposit and passport"],
    ] as [number, string][]) {
      expect(isPriceGrounded(dividend, 1, { shopText: text }), text).toBe(false);
    }
  });

  it("a DEPOSIT does not ground a rent price - guardrails already excludes it", () => {
    // "Minimum rental 3 days 500 deposit" divided to 167/day on the card. The
    // dividend is 500, and verbatimNumerals refuses to harvest a number in a
    // deposit context at all - so grounding the dividend kills this phantom
    // outright, which the priceBasisDays exemption had been preventing.
    expect(isPriceGrounded(500, 1, { shopText: "Minimum rental 3 days 500 deposit" })).toBe(false);
  });

  it("a genuine package total grounds its per-day", () => {
    expect(isPriceGrounded(1250, 1, { shopText: "5 days 1250 total" })).toBe(true);
  });
});
