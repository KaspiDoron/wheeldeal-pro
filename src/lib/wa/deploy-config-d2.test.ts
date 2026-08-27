import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// OWNER REPORT 11, WAVE D2 - config/deploy defects (owner-visible, cheap).

describe("D2.1 - the deploy PRESERVES BETA_LOCK instead of wiping it", () => {
  const wf = read(".github/workflows/deploy-gcp.yml");
  it("BETA_LOCK is sourced into a shell var and passed through the optional loop", () => {
    // --set-env-vars replaces the whole service env, so a value not passed here
    // is WIPED. BETA_LOCK defaults to locked when absent, so a wipe silently
    // re-locked the beta after every push.
    expect(wf).toMatch(/BETA_LOCK: \$\{\{ vars\.BETA_LOCK \}\}/);
    expect(wf).toMatch(/for OPTIONAL in [^\n]*\bBETA_LOCK\b/);
  });
  it("the admin panel points the owner at the DURABLE place to set it", () => {
    const admin = read("src/app/admin/page.tsx");
    // Not the Cloud Run console (wiped on deploy) - the repo variable.
    expect(admin).toMatch(/repo variable BETA_LOCK/);
  });
});

describe("D2.3 - the SESSION_SECRET-rotation repair runs in PRODUCTION", () => {
  it("rearmOpenWebhooks lives in the deployed lib, not only the worker", () => {
    expect(code("src/lib/evolution.ts")).toMatch(/export async function rearmOpenWebhooks\(/);
    expect(read("packages/core/index.ts")).toMatch(/rearmOpenWebhooks,/);
  });
  it("the deployed /api/wa/ping cron calls it (the one runner that exists in prod)", () => {
    expect(code("src/app/api/wa/ping/route.ts")).toMatch(/rearmOpenWebhooks\(\)/);
  });
  it("the worker no longer DEFINES it - it imports the shared one (single source)", () => {
    const w = code("services/workers/src/scheduler.worker.ts");
    expect(w).not.toMatch(/export async function rearmOpenWebhooks\(/);
    expect(w).toMatch(/rearmOpenWebhooks,/); // imported from @wheeldeal/core
  });
});
