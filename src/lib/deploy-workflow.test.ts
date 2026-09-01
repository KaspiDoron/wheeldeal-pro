import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const wf = () => readFileSync(join(process.cwd(), ".github/workflows/deploy-gcp.yml"), "utf8");

// ERROR: (gcloud.run.deploy) ABORTED: Conflict for resource 'wheeldeal':
// version '1785219956656665' was specified but current version is
// '1785230591401735'.
//
// `gcloud run deploy` is a read-modify-write: it reads the service, applies the
// change, and writes it back stamped with the version it read. Anything that
// touches the service in between makes that write stale. There are two sources,
// and only fixing one leaves the failure in place:
//
//   1. US, racing ourselves - two workflow runs deploying at once.
//   2. THE PLATFORM - Cloud Run's own reconciliation bumps the version as the
//      previous revision finishes rolling out and traffic migrates, which can
//      land after the previous deploy command has already returned. No amount
//      of serialisation on our side prevents that one.
//
// So: a single never-interrupted deploy lane for (1), and a conflict-only retry
// for (2). The command is declarative, so re-running it is idempotent.

describe("deploys are serialised, and CI is not", () => {
  it("the deploy job owns one global lane", () => {
    const s = wf();
    const deploy = s.slice(s.indexOf("  deploy:"));
    expect(deploy).toMatch(/concurrency:\s*\n\s*group: deploy-cloud-run-wheeldeal/);
    // A literal group, NOT keyed by ref: a push to master and a manual
    // dispatch must queue behind each other, not run side by side.
    expect(deploy).not.toMatch(/group: deploy-cloud-run-wheeldeal-\$\{\{/);
  });

  it("an in-flight deploy is never cancelled", () => {
    // This looks backwards and is not: killing gcloud between its read and its
    // write is one of the ways a half-updated service gets created.
    const s = wf();
    const deploy = s.slice(s.indexOf("  deploy:"));
    const lane = deploy.slice(deploy.indexOf("concurrency:"));
    expect(lane.slice(0, 200)).toMatch(/cancel-in-progress: false/);
  });

  it("superseded pull-request CI IS cancelled, because it is disposable", () => {
    const s = wf();
    const head = s.slice(0, s.indexOf("jobs:"));
    expect(head).toMatch(/group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
    expect(head).toMatch(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });
});

describe("a version conflict is retried; a real failure is not", () => {
  const step = () => {
    const s = wf();
    return s.slice(s.indexOf("- name: Deploy to Cloud Run"), s.indexOf("- name: Show service URL"));
  };

  it("retries with backoff on ABORTED / conflict only", () => {
    const d = step();
    expect(d).toMatch(/ABORTED\|Conflict for resource/);
    expect(d).toMatch(/DELAY=\$\(\(DELAY \* 2\)\)/);
    expect(d).toMatch(/ATTEMPTS=\d/);
  });

  it("a bad image or a missing permission fails immediately", () => {
    // Retrying those hides the real error five times over.
    const d = step();
    expect(d).toMatch(/will not fix itself - not retrying/);
    expect(d).toMatch(/exit "\$CODE"/);
  });

  it("and it still fails the build if the conflict never clears", () => {
    expect(step()).toMatch(/Still conflicting after \$ATTEMPTS attempts[\s\S]{0,120}exit 1/);
  });
});

describe("secrets reach gcloud as environment variables, not as pasted text", () => {
  it("the deploy step declares them under env:", () => {
    const s = wf();
    const d = s.slice(s.indexOf("- name: Deploy to Cloud Run"), s.indexOf("- name: Show service URL"));
    expect(d).toMatch(/env:\s*\n\s*PROJECT_ID: \$\{\{ secrets\.GCP_PROJECT_ID \}\}/);
    expect(d).toMatch(/SESSION_SECRET: \$\{\{ secrets\.SESSION_SECRET \}\}/);
  });

  it("the script body interpolates no secrets at all", () => {
    const s = wf();
    const d = s.slice(s.indexOf("- name: Deploy to Cloud Run"), s.indexOf("- name: Show service URL"));
    const script = d.slice(d.indexOf("run: |"));
    // A secret containing a quote, a `$`, a backtick or a newline used to
    // rewrite the shell script around it.
    expect(script).not.toMatch(/\$\{\{\s*secrets\./);
    expect(script).toMatch(/set -euo pipefail/);
  });

  it("...and so does the heartbeat step that derives the ping token", () => {
    // Same rule, newer step: SESSION_SECRET arrives as an env var and is
    // referenced as $SESSION_SECRET. Pasted in as `${{ secrets.X }}` it would
    // be substituted before bash saw the line, and a secret containing a quote
    // or a backtick would rewrite the script around it.
    const s = wf();
    const h = s.slice(s.indexOf("- name: Ensure the drain heartbeat exists"));
    expect(h).toMatch(/env:\s*\n\s*PROJECT_ID: \$\{\{ secrets\.GCP_PROJECT_ID \}\}/);
    expect(h).toMatch(/SESSION_SECRET: \$\{\{ secrets\.SESSION_SECRET \}\}/);
    expect(h.slice(h.indexOf("run: |"))).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("an unset optional secret is skipped, not written empty", () => {
    // `[ -n "${{ secrets.X }}" ]` with an unset secret rendered as `[ -n ]`,
    // which bash evaluates as "is the string '-n' non-empty" - TRUE - so every
    // optional key was appended EMPTY, overwriting a good value on the service.
    const s = wf();
    const d = s.slice(s.indexOf("- name: Deploy to Cloud Run"), s.indexOf("- name: Show service URL"));
    expect(d).toMatch(/for OPTIONAL in EVOLUTION_API_URL EVOLUTION_API_KEY EVOLUTION_HOSTS APP_DOMAIN/);
    expect(d).toMatch(/VALUE="\$\{!OPTIONAL:-\}"/);
    expect(d).toMatch(/if \[ -n "\$VALUE" \]/);
    expect(d).not.toMatch(/if \[ -n "\$\{\{ secrets\./);
  });

  it("nothing ships without the quality gate", () => {
    const s = wf();
    expect(s.slice(s.indexOf("  deploy:"))).toMatch(/needs: verify/);
  });
});

// THE GATE HAD NEVER RUN ON THE BRANCH BEING DEVELOPED.
//
// The push trigger listed development branches BY NAME, and the one name it
// carried belonged to a branch CLAUDE.md itself calls retired. So the active
// branch was absent, `list_workflow_runs` for it returned zero, and every
// commit on it was green on a laptop and ungated in CI.
//
// The file already knew this lesson - it wrote it, at length, about how a dead
// branch name in Render's blueprint made every Manual Sync fail - and then
// repeated the mistake in its own trigger four lines later.
describe("CI runs on the branch people actually work on", () => {
  const branchBlock = () => {
    const s = wf();
    const start = s.indexOf("on:\n  push:\n    branches:");
    expect(start).toBeGreaterThan(-1);
    return s.slice(start, s.indexOf("  pull_request:", start));
  };

  it("matches development branches by PATTERN, not by name", () => {
    // A pattern cannot go stale when someone renames a branch, which is the
    // only durable fix - every named-branch scheme drifts the moment the name
    // changes, and nothing fails loudly when it does.
    expect(branchBlock()).toMatch(/^\s+- 'claude\/\*\*'$/m);
  });

  it("no branch is named individually any more", () => {
    // Any concrete claude/<name> entry is the defect coming back.
    const named = branchBlock()
      .split("\n")
      .filter((l) => /^\s+-\s+'?claude\//.test(l))
      .filter((l) => !l.includes("claude/**"));
    expect(named).toEqual([]);
  });

  it("the branch CLAUDE.md says to develop on is covered by the pattern", () => {
    // The coupling that actually matters: the doc names the working branch, and
    // the trigger has to admit it. Executed rather than eyeballed.
    const claudeMd = readFileSync(join(process.cwd(), "CLAUDE.md"), "utf8");
    const m = claudeMd.match(/Develop on `(claude\/[^`]+)`/);
    expect(m, "CLAUDE.md must name the working branch").toBeTruthy();
    const working = m![1];
    expect(working.startsWith("claude/")).toBe(true);
    // ...and the pattern in the workflow admits it.
    expect(branchBlock()).toContain("claude/**");
  });

  it("widening the trigger cannot widen DEPLOYS", () => {
    // This is what makes the pattern safe. The deploy job admits exactly two
    // refs; a feature branch gets the full quality gate and can never reach a
    // deploy no matter how the trigger is written.
    const s = wf();
    const deployIf = s.slice(s.indexOf("  deploy:"), s.indexOf("runs-on", s.indexOf("  deploy:")));
    expect(deployIf).toContain("github.ref == 'refs/heads/main'");
    expect(deployIf).toContain("github.ref == 'refs/heads/master'");
    expect(deployIf).toContain("github.event_name != 'pull_request'");
    // No branch-pattern matching in the deploy gate - only exact refs.
    expect(deployIf).not.toMatch(/startsWith\(github\.ref/);
  });

  it("the quality gate itself still runs all four checks", () => {
    // If the trigger is fixed but the gate is hollow, nothing was gained.
    const s = wf();
    for (const cmd of [
      "npm run typecheck",
      "npm run typecheck:services",
      "npm run typecheck:tests",
      "npx vitest run",
    ]) {
      expect(s).toContain(cmd);
    }
  });
});
