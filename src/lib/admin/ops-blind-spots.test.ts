import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A DASHBOARD THAT CANNOT GO RED IS NOT A DASHBOARD.
//
// Every field test ended the same way: a thread got no reply, and no admin
// surface could say why. The reasons were all being recorded - they simply had
// nowhere to appear.
//
//   * guardOutbound's TERMINAL refusals (duplicate-suppressed, rfq-dedup,
//     engagement-halt) write agent_events kind "send-dropped". The inspector's
//     query did not include it, and health tracked the similarly-spelled but
//     DIFFERENT "wa-send-dropped". These rows also never touch wa_outbox, so
//     the queue view structurally cannot show them either: invisible everywhere.
//   * guardCounters were fetched by the inspector every 30 seconds and used for
//     exactly one boolean, then discarded.
//   * "5 failovers in 6h" was a bare count while the rows behind it carried the
//     vendor AND the exception message.
//   * chatDetailed returns the provider's real failure; pass.ts dropped it, so
//     "no key configured" and "eight keys all failing" looked identical.

describe("the terminal drops are visible somewhere", () => {
  it("REPRODUCTION: send-dropped is counted, and it is a different kind from wa-send-dropped", () => {
    const health = readCode("src/app/api/admin/health/route.ts");
    expect(health).toMatch(/"send-dropped"/);
    expect(health).toMatch(/"wa-send-dropped"/); // both, because they mean different things
  });

  it("and the inspector fetches them too", () => {
    const route = readCode("src/app/api/admin/engine-inspector/route.ts");
    expect(route).toMatch(/send-dropped/);
    expect(route).toMatch(/wa-send-stale/);
  });

  it("a graph-engine turn is counted as the anomaly it now is", () => {
    // After the routing fix, the old engine should answer ~nothing. If it does,
    // that is the single most important thing on the screen.
    const health = readCode("src/app/api/admin/health/route.ts");
    expect(health).toMatch(/"engine-graph-turn"/);
  });
});

describe("counts carry the rows behind them", () => {
  const route = readCode("src/app/api/admin/engine-inspector/route.ts");

  it("a failover names the shop and the exception", () => {
    expect(route).toMatch(/failoverDetail/);
    expect(route).toMatch(/const detailOf = \(e: EventRow\)/);
  });

  it("a refused message names the shop and the reason", () => {
    expect(route).toMatch(/const dropped = events/);
    expect(route).toMatch(/kind: e\.kind/);
  });

  it("and all three reach the payload", () => {
    expect(route).toMatch(/failoverDetail,\s*\n\s*dropped,\s*\n\s*graphTurns,/);
  });
});

describe("the panel renders what it already fetched", () => {
  const ui = readCode("src/components/admin/EngineInspector.tsx");

  it("REPRODUCTION: guardCounters are no longer fetched and thrown away", () => {
    // One `health.guardCounters` reference existed - inside the type. Now it is
    // rendered, and the two most alarming kinds are coloured as such.
    // The window is 24h (health/route.ts sinceIso), and this label said 6h -
    // so the identical payload read four times worse here than on the Health
    // panel, which has always labelled it "(24h)".
    expect(ui).toMatch(/Refused in the last 24h/);
    expect(ui).toMatch(/Object\.entries\(health\.guardCounters\)/);
    // The alarming colour now also covers `n === null` - a counter we could not
    // READ is at least as urgent as a counter with a number in it - so the
    // condition spans lines. Pin the two kinds, not the formatting.
    expect(ui).toMatch(/kind === "send-dropped" \|\|\s*\n?\s*kind === "engine-graph-turn"/);
  });

  it("and the threads that need a look are listed with their reasons", () => {
    expect(ui).toMatch(/Threads that need a look/);
    expect(ui).toMatch(/answered by the OLD engine/);
    expect(ui).toMatch(/engine failover/);
    expect(ui).toMatch(/draft dropped as stale/);
  });
});

describe("a silent model is distinguishable from an absent one", () => {
  it("REPRODUCTION: the provider's own failure is kept, not discarded", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/const \{ text: raw, provider, error \} = await chatDetailed/);
    expect(pass).toMatch(/route\.error = error \?\? "no provider available"/);
  });

  it("and it rides along on the turn telemetry", () => {
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/providerError: outcome\.route\.error \?\? null/);
    const types = readCode("src/lib/spte/types.ts");
    expect(types).toMatch(/error\?: string;/);
  });
});
