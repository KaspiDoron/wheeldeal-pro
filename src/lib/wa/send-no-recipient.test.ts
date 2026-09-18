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

  it("the engine refuses it first, while it still knows which move produced it", () => {
    const engine = read("src/lib/graph/engine.ts");
    const entry = engine.indexOf("async guardAndSend({ senderKey, toNumber, text, meta, shopOpenNow })");
    const guard = engine.indexOf('if (!String(toNumber ?? "").trim())', entry);
    const firstGuardOutbound = engine.indexOf("guardOutbound({", entry);
    expect(entry).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(entry);
    // Before anything else runs: a send with nowhere to go must not consume a
    // pacing slot, a claim, or an outbox row on its way to being refused.
    expect(firstGuardOutbound).toBeGreaterThan(guard);
    // The context is the point - `kind` names the move that produced it.
    const detail = engine.slice(guard, guard + 900);
    expect(detail).toMatch(/where: "engine\.guardAndSend"/);
    expect(detail).toMatch(/kind: \(meta/);
  });
});
