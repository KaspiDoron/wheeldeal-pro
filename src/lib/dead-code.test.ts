import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// WAVE 4.2 - STAYS-DELETED ASSERTIONS.
//
// Every entry below was deleted with proof (a repo-wide `rg -w -l NAME`
// returning zero references outside the deleted cluster). A route that
// grows back silently re-opens the exact hole that got it deleted -
// /api/safety in particular was an UNAUTHENTICATED LLM-spend endpoint.
// If one of these fails, the file returned without its consumers: either
// wire it in for real or delete it again.

const ROOT = path.resolve(__dirname, "../..");

const DELETED = [
  // Orphan API routes (zero client references, zero cross-route imports).
  "src/app/api/safety", // unauthenticated LLM spend - the worst one
  "src/app/api/contact",
  "src/app/api/wa/health",
  "src/app/api/admin/funnel",
  "src/app/api/admin/orchestrator", // graph-era Pipeline Studio backend (+ /simulate)
  "src/app/api/admin/prompts",
  // Cascade of admin/funnel - its only importer.
  "src/lib/funnel.ts",
  // The graph-era Pipeline Studio UI - nothing outside the folder imported it.
  "src/components/studio",
  // Never imported by any runtime (`from "@wheeldeal/db"` had zero hits);
  // the GCP services talk PostgREST through @wheeldeal/core instead.
  "packages/db",
  // Wave 7: the rest of the Pipeline Studio backend, deleted with the same
  // zero-reference proof as admin/orchestrator above. The UI was recorded as
  // deleted (admin/page.tsx header) while these kept running - graph/route.ts
  // in particular could persist a graph spec AROUND saveVersionedSpec, i.e.
  // around the golden gate and the version history. graph/coach survives: it
  // is the one graph route with a live consumer (ReviewControls).
  "src/app/api/admin/graph/route.ts",
  "src/app/api/admin/graph/simulate",
  "src/app/api/admin/graph/prompts",
  "src/app/api/admin/graph/replay",
  "src/app/api/admin/graph/scenario-gen",
  "src/app/api/admin/graph/scores",
  "src/app/api/admin/graph/media-test",
  // Sent REAL WhatsApp through the production chain with zero UI consumers -
  // attack surface with no justification (lib/drill.ts, the ingestion gate,
  // is unrelated and very much alive).
  "src/app/api/admin/drill",
];

describe("dead code stays deleted", () => {
  for (const rel of DELETED) {
    it(`${rel} does not exist`, () => {
      expect(existsSync(path.join(ROOT, rel)), `${rel} came back`).toBe(false);
    });
  }

  // The survivors the sweep explicitly KEPT because the confirm-grep proved
  // them alive - documented so a future sweep does not re-litigate them.
  // THE GREP SCOPE THAT BIT US (deploy run #247): the 4.2 zero-reference
  // sweep covered src/packages/apps/services/scripts but NOT the build
  // artifacts - the Dockerfile still COPY'd packages/db/package.json and the
  // Docker build died in CI, three minutes after a fully green verify. Every
  // deleted cluster must be absent from the build/deploy surface too.
  const BUILD_SURFACE = ["Dockerfile", ".dockerignore", "render.yaml"];
  for (const rel of BUILD_SURFACE) {
    it(`${rel} references no deleted cluster`, () => {
      const body = readFileSync(path.join(ROOT, rel), "utf8");
      for (const dead of DELETED) {
        expect(body, `${rel} still references deleted ${dead}`).not.toContain(dead);
      }
    });
  }

  const KEPT = [
    "src/lib/spte/index.ts", // dynamically imported: engine-route.ts `await import("./spte")`
    "src/lib/simulate.ts", // ops golden replay (replayConversation)
    "src/lib/i18n-extras.ts", // already deleted once by a sweep; catalog source
    "render.yaml", // live Render half
    "src/app/api/health", // Cloud Run liveness probe
    "src/app/api/admin/graph/coach", // ReviewControls' rule authoring
    "src/lib/drill.ts", // the ingestion gate (NOT the deleted drill route)
    "src/app/api/admin/wa-queue", // the Command tab's queue panel backend
  ];
  for (const rel of KEPT) {
    it(`${rel} still exists (kept on purpose)`, () => {
      expect(existsSync(path.join(ROOT, rel)), `${rel} was deleted - it is ALIVE`).toBe(true);
    });
  }
});
