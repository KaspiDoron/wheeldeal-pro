// AUDIT F179 + M10 - THE SALT THAT LOCKED THE FLEET OUT OF ITS OWN HEARTBEAT.
//
// The app derives the webhook/cron token with WEBHOOK_TOKEN_SALT folded in
// (evolution.ts webhookToken/webhookAuthToken -> wa/webhook-token.ts:50), but
// both provisioned schedulers derived it WITHOUT the salt:
//
//   TOKEN="$(printf 'wd-webhook:%s' "$SESSION_SECRET" | sha256sum | cut -c1-32)"
//
// So the documented rotation knob (README, RUNBOOK, .env.example) 403'd every
// Cloud Scheduler minute-tick and every hourly GitHub backstop at
// /api/wa/ping. That route is the only place rearmOpenWebhooks is called, so
// Evolution kept posting the OLD token and inbound went dark with no self-
// repair - the exact opposite of what .env.example promises.
//
// This test EXECUTES each workflow's own derivation snippet through bash and
// compares the result with deriveWebhookToken, so the two derivations cannot
// drift again. It also pins the other half of the fix (M10's fixConcern):
// --set-env-vars REPLACES the whole Cloud Run environment, so a salt that is
// not in the deploy step's env block AND its OPTIONAL loop would be wiped on
// the next deploy - which inverts the failure instead of fixing it.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveWebhookToken } from "./webhook-token";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const DEPLOY = ".github/workflows/deploy-gcp.yml";
const HEARTBEAT = ".github/workflows/heartbeat.yml";

// A secret of realistic length - the derivation refuses anything under 16.
const SECRET = "a-strong-secret-of-adequate-length";

/**
 * Pull the workflow's OWN token derivation out of the YAML: every line from
 * the one that starts building the salted string up to and including the line
 * that assigns TOKEN. Deliberately loose - the shape is proven by EXECUTING
 * it, not by matching it, so a change to the arithmetic is caught by a wrong
 * digest rather than by a regex nobody updated.
 */
function derivationSnippet(file: string): string {
  const lines = read(file).split("\n");
  const start = lines.findIndex((l) => /SALTED=/.test(l));
  expect(start, `${file} has no salted-token derivation`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i >= start && /^\s*TOKEN=/.test(l));
  expect(end, `${file} builds SALTED but never assigns TOKEN`).toBeGreaterThanOrEqual(start);
  return lines
    .slice(start, end + 1)
    .map((l) => l.replace(/^\s+/, ""))
    .join("\n");
}

/** Run the extracted snippet in a real shell and print what it derived. */
function runDerivation(file: string, env: Record<string, string>): string {
  const script = `set -uo pipefail\n${derivationSnippet(file)}\nprintf '%s' "$TOKEN"\n`;
  // A deterministic environment: this process's own salt (if any) must never
  // leak into the case that asserts the UNSALTED historical token.
  const base: NodeJS.ProcessEnv = { ...process.env, SESSION_SECRET: SECRET };
  delete base.WEBHOOK_TOKEN_SALT;
  return execFileSync("bash", ["-c", script], { encoding: "utf8", env: { ...base, ...env } });
}

describe("the schedulers derive the token the app actually expects", () => {
  for (const file of [DEPLOY, HEARTBEAT]) {
    it(`EXECUTED: ${file} matches deriveWebhookToken WITH a salt set`, () => {
      const salted = deriveWebhookToken({ secret: SECRET, nodeEnv: "production", salt: "r1" });
      expect(salted).toBeTruthy();
      expect(runDerivation(file, { WEBHOOK_TOKEN_SALT: "r1" })).toBe(salted);
    });

    it(`EXECUTED: ${file} still derives the historical token with NO salt`, () => {
      // Unset salt must keep deriving exactly what every live host already
      // holds, so shipping this fix re-arms nothing by itself.
      const plain = deriveWebhookToken({ secret: SECRET, nodeEnv: "production" });
      expect(runDerivation(file, {})).toBe(plain);
      // ...and an EMPTY salt is the same as none (the .env.example default).
      expect(runDerivation(file, { WEBHOOK_TOKEN_SALT: "" })).toBe(plain);
    });

    it(`EXECUTED: a DIFFERENT salt in ${file} changes the token`, () => {
      const a = runDerivation(file, { WEBHOOK_TOKEN_SALT: "r1" });
      const b = runDerivation(file, { WEBHOOK_TOKEN_SALT: "r2" });
      expect(a).not.toBe(b);
    });

    it(`${file} no longer carries the unsalted derivation`, () => {
      expect(read(file)).not.toMatch(/printf 'wd-webhook:%s'/);
    });
  }
});

describe("the salt survives a deploy, so the two halves cannot invert", () => {
  const wf = read(DEPLOY);

  it("the deploy step exports WEBHOOK_TOKEN_SALT and passes it to Cloud Run", () => {
    // --set-env-vars REPLACES the service environment: a console-set salt that
    // the deploy does not carry is wiped, and the schedulers would then send a
    // salted token the app no longer expects. Both lists, or neither.
    const m = wf.match(/for OPTIONAL in ([^;]+); do/);
    expect(m).toBeTruthy();
    expect(m![1].trim().split(/\s+/)).toContain("WEBHOOK_TOKEN_SALT");
    expect(wf).toMatch(/^\s{10}WEBHOOK_TOKEN_SALT:\s*\$\{\{ secrets\.WEBHOOK_TOKEN_SALT \}\}/m);
  });

  it("the scheduler step can see the salt it derives with", () => {
    const step = wf.slice(wf.indexOf("      - name: Ensure the drain heartbeat exists"));
    expect(step).toMatch(/WEBHOOK_TOKEN_SALT:\s*\$\{\{ secrets\.WEBHOOK_TOKEN_SALT \}\}/);
  });

  it("the backstop ping step can see it too", () => {
    expect(read(HEARTBEAT)).toMatch(
      /WEBHOOK_TOKEN_SALT:\s*\$\{\{ secrets\.WEBHOOK_TOKEN_SALT \}\}/
    );
  });
});
