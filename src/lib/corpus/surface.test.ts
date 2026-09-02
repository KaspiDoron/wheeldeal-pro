import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// AN API FIELD NOBODY RENDERS IS NOT A SURFACE.
//
// The corpus tile shipped as a `corpus` key on /api/admin/health and NOTHING
// read it - so the owner was told to watch a tile that did not exist. The route
// was green, the types were green, the tests were green, and the thing the
// whole phase was supposed to be verified by was invisible. That is the same
// class as "a fix in a file nobody runs": the writer existed, the reader never
// did, and only a human opening the page could tell.
//
// These are source reads because the alternative is rendering the admin page
// under a full Supabase double, which the repo already rejects as a
// mocked-into-tautology test. Each one pins a REACHABILITY claim - field ->
// state -> markup - which is precisely what was missing.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const panel = read("src/components/HealthPanel.tsx");
const route = read("src/app/api/admin/health/route.ts");

describe("every corpus field the route returns reaches the screen", () => {
  it("the route returns a corpus block", () => {
    expect(route).toMatch(/const \{ corpusDepth \} = await import\("@\/lib\/corpus\/gate"\)/);
    expect(route).toMatch(/^\s+corpus,$/m);
  });

  it("the panel reads it into state and renders a tile", () => {
    expect(panel).toMatch(/setCorpus\(d\.corpus \?\? null\)/);
    expect(panel).toMatch(/\{corpus && \(/);
    expect(panel).toMatch(/Semantic corpus:/);
  });

  it("all three gate states are distinguishable on screen", () => {
    // "off" and "the database did not answer" must never render alike: one is
    // a choice the owner has not made, the other is an outage.
    expect(panel).toMatch(/OFF - pgvector is not enabled/);
    expect(panel).toMatch(/UNKNOWN - Supabase did not answer/);
    expect(panel).toMatch(/corpus\.state === "ready"/);
  });

  it("OFF is not painted red - an optional feature nobody enabled is not a fault", () => {
    // A permanently-red tile for a feature that is off by design trains the
    // owner to ignore the column it lives in.
    const tile = panel.slice(panel.indexOf("Semantic corpus:"));
    const missingBranch = tile.slice(0, tile.indexOf("</div>"));
    expect(missingBranch).not.toMatch(/missing[\s\S]{0,80}brandred/);
    expect(panel).toMatch(/corpus\.state === "unavailable"\s*\n?\s*\? "border-brandred/);
  });

  it("an unreadable count is shown as unread, never as zero", () => {
    expect(panel).toMatch(/corpus\.queued === null/);
    expect(panel).toMatch(/could not be read/);
  });

  it("the tile names the one action only the owner can take", () => {
    expect(panel).toMatch(/Database -&gt; Extensions/);
    expect(panel).toMatch(/re-run supabase\/schema\.sql/);
  });
});

describe("the gate breadcrumb is not filed as a send guardrail", () => {
  it("corpus-gate-missing is filtered out of the send-pipeline chips", () => {
    // It is a feature that is switched off, not a message that was dropped.
    // Sitting in that strip it would be a permanent chip beside counters whose
    // whole meaning is "something is going wrong right now".
    expect(panel).toMatch(/\.filter\(\(\[k\]\) => k !== "corpus-gate-missing"\)/);
  });

  it("it is still COUNTED by the route, so the tile can explain itself", () => {
    // Removing it from the strip must not remove it from the data.
    expect(route).toMatch(/"corpus-gate-missing"/);
  });
});
