import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// A STALE BRANCH NAME IN CONFIG IS A LIVE MISCONFIGURATION SOMEWHERE ELSE.
//
// `claude/rental-negotiation-app-pc33ux` was deleted long ago. It survived in
// CLAUDE.md ("Develop on ..."), in the deploy workflow (where a comment called
// it "the live production branch"), and in infra/gcp/README's clone command.
// Nothing broke in CI - the workflow simply never fired for a branch that could
// not receive a push - so it read as harmless.
//
// It was not. Render's Blueprint had been pointed at that branch, so every
// Manual Sync failed with "not found: file: .../render.yaml": a file that is
// present and valid on master, reported missing because the branch under it was
// gone. The Evolution retention cron therefore never got created, and the
// Evolution database was on course to fill in 17-28 days at beta scale.
//
// EPILOGUE, AND THE REASON THIS FILE GREW. The Blueprint was moved to `master`
// and Manual Sync STILL 404s. So the dead branch was a real defect and is no
// longer the live cause: the fault is now inside Render's own record (its
// Settings say `master` while its breadcrumb still names the deleted branch).
// This file therefore pins two things at once - that no config names a branch
// that does not exist, AND that the repo side of the sync is verifiably clean,
// so the next person to read the 404 does not go looking here for it.
//
// RESOLUTION (2026-08-31): the owner's screenshot showed the breadcrumb still
// reading the deleted branch while Settings read `master` - Render's record
// really was pinned to the dead name. Rather than fight Render's state, the
// branch was RE-CREATED as a mirror of master, and Manual Sync went green
// immediately (it created wd-evo-prune and applied the Evolution save-data
// env vars that had been stuck since the Blueprint broke).
//
// So the branch is no longer dead, and "it must not exist" is no longer the
// property worth pinning. The property that can actually hurt now is DRIFT:
// Render deploys whatever that mirror points at, so if it falls behind
// master, Render silently runs older infrastructure than Cloud Run. That is
// what this file checks instead - plus the unchanged rule that no config may
// name it as a branch to DEVELOP on or deploy from.

const MIRROR_BRANCH = "claude/rental-negotiation-app-pc33ux";

describe("no config points at a branch that does not exist", () => {
  it("the deploy workflow neither triggers on nor deploys the mirror branch", () => {
    const wf = read(".github/workflows/deploy-gcp.yml");
    // The name may appear in the comment explaining its removal - what must be
    // gone is any LIST ENTRY or ref comparison naming it.
    expect(wf).not.toMatch(new RegExp(`^\\s*-\\s*${MIRROR_BRANCH}\\s*$`, "m"));
    expect(wf).not.toContain(`refs/heads/${MIRROR_BRANCH}`);
    // ...and master still both triggers and deploys.
    expect(wf).toMatch(/^\s*-\s*master\s*$/m);
    expect(wf).toContain("refs/heads/master");
  });

  it("CLAUDE.md names the branch this work actually ships from", () => {
    const md = read("CLAUDE.md");
    const section = md.slice(md.indexOf("## Working branch"));
    expect(section).toContain("claude/rental-agents-legal-setup-o7rgcv");
    // The instruction must not tell a future session to develop on a dead
    // branch - that is how the blueprint got pointed at one.
    expect(section).not.toMatch(new RegExp(`Develop on \`${MIRROR_BRANCH}\``));
  });

  it("CLAUDE.md says which branch Render reads, because that is not obvious", () => {
    // The Cloud Run deploy follows a push; the Render Blueprint does not follow
    // anything - it reads one configured branch when a human clicks sync. A
    // render.yaml change on a feature branch is inert, and nothing in the repo
    // said so.
    const section = read("CLAUDE.md").slice(read("CLAUDE.md").indexOf("## Working branch"));
    expect(section).toMatch(/Render/);
    expect(section).toMatch(/Manual Sync/i);
    expect(section).toMatch(/master/);
  });

  it("render.yaml tells an editor how a change here actually reaches Render", () => {
    // INTENT PRESERVED, WORDING MOVED ON. This used to pin the sentence "THE
    // BLUEPRINT MUST TRACK `master`", written when a dead branch was the whole
    // story. The Blueprint now tracks `master` and STILL 404s (see below), so
    // that sentence is no longer the thing an editor needs to read. What the
    // header must still do is state the branch and state how to apply a change.
    const y = read("render.yaml");
    const header = y.slice(0, y.indexOf("databases:"));
    expect(header).toMatch(/`master`/);
    expect(header).toMatch(/BY HAND/);
    expect(header).toMatch(/OPTIONAL/);
  });

  it("nothing in the repo still blames the dead branch for the CURRENT sync failure", () => {
    // The disproved diagnosis. The Blueprint's own Settings show `master` and
    // Manual Sync still fails, so a doc that says "it fails because it is
    // pinned to a deleted branch" sends the next reader to fix a setting that
    // is already correct. A wrong cause stated confidently is worse than none.
    for (const f of ["CLAUDE.md", "render.yaml"]) {
      const text = read(f);
      expect(
        text,
        `${f} still presents the dead branch as the live cause`
      ).not.toMatch(/pinned to `?claude\/rental-negotiation-app/);
    }
  });

  it("the infra clone command checks out a branch that exists", () => {
    const md = read("infra/gcp/README.md");
    expect(md).not.toContain(`git clone -b ${MIRROR_BRANCH}`);
    expect(md).toMatch(/git clone -b master/);
  });

  it("the GCE bootstrap scripts default to a branch that EXISTS (OR11 D2.2)", () => {
    // THE SWEEP GAP THIS FILE MISSED. startup.sh and deploy.sh each defaulted
    // BRANCH to the dead branch and then `git clone --branch "$BRANCH"` - so a
    // GCE worker VM booted straight into a clone of a branch that cannot be
    // fetched and never came up. The README was swept; these two shell scripts,
    // where the failure actually happens, were not. Pin them here so the next
    // rename cannot leave them behind again.
    for (const f of ["infra/gcp/startup.sh", "infra/gcp/deploy.sh"]) {
      const sh = read(f);
      expect(sh, `${f} still names the dead branch`).not.toContain(MIRROR_BRANCH);
      expect(sh, `${f} must default BRANCH to master`).toMatch(/BRANCH[:=]"?\$\{BRANCH:-master\}"?|BRANCH="\$\{BRANCH:-master\}"/);
    }
  });

  it("REALITY CHECK: the branches these files name are really on the remote", () => {
    // The point of this whole file. Skips rather than fails where git or the
    // remote is unavailable (a fresh CI checkout, an offline sandbox) - a test
    // that cannot reach the remote must not invent a verdict about it.
    let heads = "";
    try {
      heads = execSync("git ls-remote --heads origin", {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return;
    }
    if (!heads.trim()) return;
    expect(heads).toContain("refs/heads/master");
    // THE MIRROR MUST NOT DRIFT. The Render Blueprint reads MIRROR_BRANCH
    // (Render's own record is pinned there and re-creating the branch is what
    // finally made Manual Sync work). Render therefore deploys whatever that
    // ref points at - so if it falls behind master, the infrastructure Render
    // runs is older than the app Cloud Run runs, silently. When the mirror
    // exists it must name the SAME commit as master; refresh it with
    // `git push origin master:refs/heads/<mirror>` after any render.yaml
    // change. (Absent is also fine - that is the pre-2026-08-31 state, where
    // nothing reads it.)
    const shaFor = (branch: string) =>
      heads
        .split("\n")
        .find((l) => l.endsWith(`refs/heads/${branch}`))
        ?.split(/\s+/)[0];
    const mirrorSha = shaFor(MIRROR_BRANCH);
    if (mirrorSha) {
      expect(
        mirrorSha,
        `${MIRROR_BRANCH} is the Render Blueprint mirror and has drifted from master - ` +
          `Render would deploy stale infrastructure. Refresh it: ` +
          `git push origin master:refs/heads/${MIRROR_BRANCH}`
      ).toBe(shaFor("master"));
    }
    // Every branch the deploy workflow lists must actually exist, except the
    // conventional `main` fallback which is deliberately kept for a future
    // rename.
    const wf = read(".github/workflows/deploy-gcp.yml");
    const listed = [...wf.matchAll(/^\s*-\s*(claude\/[\w./-]+)\s*$/gm)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    for (const b of listed) expect(heads, `workflow lists ${b}`).toContain(`refs/heads/${b}`);
  });

  it("THE REPO SIDE IS CLEAN - the four checks that locate the 404 inside Render", () => {
    // Recorded as a test so nobody re-derives this a fourth time. Render
    // reports `render.yaml` missing on a branch where it demonstrably is not.
    // If all four of these hold, the fault is not in this repository.
    const root = process.cwd();
    // 1. tracked by git at the ROOT of master (not merely present on disk)
    let tree = "";
    try {
      tree = execSync("git ls-tree origin/master --name-only", {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      tree = "";
    }
    if (tree.trim()) {
      const rootYaml = tree.split("\n").filter((n) => /\.ya?ml$/i.test(n.trim()));
      expect(rootYaml).toContain("render.yaml");
      // 2. exactly one root-level YAML, so a rename or a case slip is visible
      expect(rootYaml).toHaveLength(1);
    }
    // 3. not gitignored (an ignored file is invisible to every integration)
    let ignored = false;
    try {
      execSync("git check-ignore -q render.yaml", { cwd: root, stdio: "ignore" });
      ignored = true;
    } catch {
      ignored = false;
    }
    expect(ignored).toBe(false);
    // 4. spelled exactly `render.yaml` - not .yml, not RENDER.yaml
    expect(existsSync(join(root, "render.yaml"))).toBe(true);
    expect(existsSync(join(root, "render.yml"))).toBe(false);
  });

  it("render.yaml really is at the root, with every Dockerfile it names", () => {
    // The other half of the sync error: Render reported the FILE missing. It is
    // not - and if any referenced build context were missing, the sync would
    // fail again for a different reason the moment the branch is fixed.
    expect(existsSync(join(process.cwd(), "render.yaml"))).toBe(true);
    const y = read("render.yaml");
    for (const m of y.matchAll(/dockerfilePath:\s*\.\/(\S+)/g)) {
      expect(existsSync(join(process.cwd(), m[1])), `missing ${m[1]}`).toBe(true);
    }
  });
});
