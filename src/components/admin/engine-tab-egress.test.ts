import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Wave 0: the Engine tab was a standing money + Supabase-egress leak - it
// polled /api/admin/engine-inspector every 4s (~10 heavy selects) and the FULL
// /api/admin/health live sweep (a real AI completion, five billed Maps calls,
// an SMTP AUTH, a PayPal OAuth) every 30s, even while backgrounded. These pin
// the fix so a future edit cannot quietly restore the hammering.
const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("Engine tab is idle-cheap", () => {
  const inspector = read("src/components/admin/EngineInspector.tsx");

  it("polls the engine snapshot at 15s, not 4s", () => {
    expect(inspector).toMatch(/setInterval\(tick, 15000\)/);
    expect(inspector).not.toMatch(/setInterval\(tick, 4000\)/);
  });

  it("polls health at 10 minutes, cached-probes only", () => {
    expect(inspector).toMatch(/setInterval\(tick, 600000\)/);
    expect(inspector).toMatch(/\/api\/admin\/health\?probes=cached/);
    expect(inspector).not.toMatch(/setInterval\(tick, 30000\)/);
  });

  it("skips every tick while the tab is hidden", () => {
    expect(inspector).toMatch(/document\.visibilityState === "visible"/);
    expect((inspector.match(/if \(!visible\(\)\) return;/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("/api/admin/health honours ?probes=cached", () => {
  const route = read("src/app/api/admin/health/route.ts");

  it("cached mode fires NO live service probes", () => {
    expect(route).toMatch(/const cachedOnly =[\s\S]{0,120}?probes[\s\S]{0,40}?=== "cached"/);
    // The billed sweep lives entirely in `checks`; cached mode makes it empty.
    expect(route).toMatch(/cachedOnly \? \[\] :/);
  });
});
