import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("a send with no recipient never reaches the provider", () => {
  it("the one send chokepoint refuses it, and says where it came from", () => {
    const evo = read("src/lib/evolution.ts");
    // The guard sits AFTER the number is derived and BEFORE any transport call,
    // so nothing can be posted on a destination we do not have.
    const at = evo.indexOf("const number = digitsOnly(to);");
    const guard = evo.indexOf("if (!number) {", at);
    const firstSend = evo.indexOf("/message/sendText/", at);
    expect(at).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(at);
    expect(firstSend).toBeGreaterThan(guard);
    // It is recorded, not swallowed: an empty recipient was invisible for as
    // long as it existed, and a wire log outside the app was what found it.
    expect(evo).toMatch(/kind: "send-no-recipient"/);
    expect(evo).toMatch(/stack:/);
  });
});
