import { describe, it, expect } from "vitest";
import { isPriceGrounded } from "./price-grounding";

describe("isPriceGrounded - a shown price must trace to something the shop said", () => {
  it("a per-day number verbatim in the reply is grounded", () => {
    expect(isPriceGrounded(250, 4, ["250 baht per day", ""])).toBe(true);
  });

  it("a stated TOTAL (number x duration) grounds the derived per-day", () => {
    // "1000 total for the 4 days" -> 250/day; 1000 is in the text.
    expect(isPriceGrounded(250, 4, ["1000 total for your dates", ""])).toBe(true);
  });

  it("a figure WE proposed and the shop agreed to is grounded via history", () => {
    expect(isPriceGrounded(250, 4, ["ok deal, come tomorrow", "Could you do 250/day?"])).toBe(true);
  });

  it("a number that appears NOWHERE is NOT grounded (the hallucination)", () => {
    // A template reply that redirects to a website, no price anywhere.
    expect(
      isPriceGrounded(250, 4, ["Please visit our website to book: example.com", "Hi, do you have a scooter?"])
    ).toBe(false);
  });

  it("a greeting with no number is not grounded", () => {
    expect(isPriceGrounded(300, 3, ["Sawasdee! welcome", ""])).toBe(false);
  });

  it("a zero/absent price is vacuously grounded (nothing to show)", () => {
    expect(isPriceGrounded(0, 4, ["anything"])).toBe(true);
  });
});
