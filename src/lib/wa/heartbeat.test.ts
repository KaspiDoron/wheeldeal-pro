import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// NOTHING WAS WAKING THE SYSTEM.
//
// A queued message, a strategic wait, a three-minute check-back on a quiet
// thread: each is a row with a due time and no timer behind it. Every drain
// runs inside a request handler - the webhook, the app's own polling - so with
// the owner's phone locked and no shop replying, a due row waits.
//
// The only periodic-drain artifact this repo had was render.yaml's cron, which
// is a Render.com Blueprint resource and does precisely nothing for a service
// running on Cloud Run. The documented fallback was an out-of-repo cron-job.org
// job that PRODUCTION-READINESS.md itself calls a single point of failure
// nobody would notice lapsing. So the honest answer to "what fires a wakeup
// when the app is closed?" was: whatever the owner next taps.

describe("the heartbeat exists in infrastructure, not in a doc", () => {
  const wf = read(".github/workflows/deploy-gcp.yml");

  it("REPRODUCTION: the deploy provisions a Cloud Scheduler job", () => {
    expect(wf).toMatch(/gcloud scheduler jobs create http "\$JOB"/);
    expect(wf).toMatch(/gcloud scheduler jobs update http "\$JOB"/);
  });

  it("it runs every minute and calls the drain endpoint", () => {
    expect(wf).toMatch(/--schedule "\* \* \* \* \*"/);
    expect(wf).toMatch(/TARGET="\$URL\/api\/wa\/ping\?token=\$TOKEN"/);
  });

  it("it authenticates with the token the ping route already accepts", () => {
    // Same derivation as src/lib/wa/webhook-token.ts - no new secret to set,
    // nothing extra for the owner to configure by hand. This USED TO PIN the
    // unsalted shape, which is exactly what audit F179/M10 found: the app
    // folds WEBHOOK_TOKEN_SALT in and the schedulers did not, so the
    // documented rotation 403'd the whole heartbeat. The equality of the two
    // derivations is now proven by EXECUTING the workflow's own snippet in
    // src/lib/wa/scheduler-token-salt.test.ts; this only pins that the salted
    // form is what is there.
    expect(wf).toMatch(/SALTED="wd-webhook:\$SESSION_SECRET"/);
    expect(wf).toMatch(/TOKEN="\$\(printf '%s' "\$SALTED" \| sha256sum \| cut -c1-32\)"/);
    expect(wf).not.toMatch(/printf 'wd-webhook:%s'/);
    const tok = readCode("src/lib/wa/webhook-token.ts");
    expect(tok).toMatch(/wd-webhook:\$\{secret\}/);
    expect(tok).toMatch(/\.slice\(0, 32\)/);
  });

  it("wiring it is idempotent - a redeploy updates rather than duplicates", () => {
    expect(wf).toMatch(/if gcloud scheduler jobs describe "\$JOB"/);
  });

  it("the running revision is stamped so the owner can verify what shipped", () => {
    expect(wf).toMatch(/ENV_VARS="WD_BUILD_SHA=\$IMAGE_TAG"/);
    expect(wf).toMatch(/WD_BUILD_AT=/);
  });
});

describe("a heartbeat that stops must be visible", () => {
  it("every ping leaves a dated mark", () => {
    const ping = readCode("src/app/api/wa/ping/route.ts");
    expect(ping).toMatch(/kind: "cron-ping"/);
  });

  it("and the ping's own tick kick can survive the response too", () => {
    const ping = readCode("src/app/api/wa/ping/route.ts");
    expect(ping).toMatch(/await kickDispatcher\(/);
    expect(ping).not.toMatch(/fetch\(\s*`\$\{new URL\(req\.url\)\.origin\}\/api\/wa\/tick/);
  });

  it("the self-check reports its age and says plainly what a lapse means", () => {
    const info = readCode("src/app/api/admin/deploy-info/route.ts");
    expect(info).toMatch(/kind=eq\.cron-ping/);
    expect(info).toMatch(/HEARTBEAT_STALE_MS/);
    // The wording now names WHICH failure it is - "never provisioned" and
    // "it lapsed" have different fixes, and the old copy said the same thing
    // for both.
    expect(read("src/app/api/admin/deploy-info/route.ts")).toMatch(
      /the drain STOPPED being called/
    );
  });
});

describe("the self-check answers the questions a field failure raises", () => {
  const info = readCode("src/app/api/admin/deploy-info/route.ts");

  it("what is serving right now", () => {
    expect(info).toMatch(/WD_BUILD_SHA/);
    expect(info).toMatch(/K_REVISION/);
  });

  it("does the database actually have what the fixes need", () => {
    // Each of these degrades SILENTLY to pre-fix behaviour when missing, which
    // is the least debuggable failure this app has.
    expect(info).toMatch(/probe\("wa_send_claims"/);
    expect(info).toMatch(/probe\("wa_outbox", "to_key"\)/);
    expect(info).toMatch(/probe\("searches", "rfq,snapshot"\)/);
    expect(info).toMatch(/probe\("graph_wakeups"/);
  });

  it("can the agents think at all", () => {
    expect(info).toMatch(/configuredProviders\(\)/);
  });

  it("it is owner-gated", () => {
    expect(info).toMatch(/requireManagement\(\)/);
    expect(info).toMatch(/status: 403/);
  });

  it("and it is reachable from the admin screen on a phone", () => {
    const admin = readCode("src/app/admin/page.tsx");
    expect(admin).toMatch(/DeployInfoCard/);
  });
});

// THE OWNER'S PRODUCTION SCREENSHOT: database green, 8 providers green, and two
// red lines - "Build: commit unknown" and "Heartbeat: last drain never".
//
// That combination is diagnostic. The card, the schema probes and the cron-ping
// breadcrumb all shipped in ONE commit, so the card rendering at all proves
// that code is live. The red lines were never missing code: they were
// deploy-time wiring that never ran.

describe("the build can say what it is, however it was deployed", () => {
  it("REPRODUCTION: the SHA is baked into the IMAGE, not only passed at deploy", () => {
    // As a Cloud Run env var alone it exists only if that one deploy step ran.
    // A console redeploy, a manual gcloud run deploy, or an image promoted from
    // an earlier build all ship new code with the previous revision's env - and
    // the service can no longer name the commit it is serving.
    const df = read("Dockerfile");
    expect(df).toMatch(/ARG WD_BUILD_SHA=unknown/);
    expect(df).toMatch(/ENV WD_BUILD_SHA=\$WD_BUILD_SHA/);
    const wf = read(".github/workflows/deploy-gcp.yml");
    expect(wf).toMatch(/--build-arg WD_BUILD_SHA="\$\{\{ github\.sha \}\}"/);
  });
});

describe("a heartbeat with one source of failure is not a heartbeat", () => {
  const wf = read(".github/workflows/deploy-gcp.yml");

  it("REPRODUCTION: the scheduler step can no longer fail silently", () => {
    // `gcloud services enable ... || true` swallowed the permission error, the
    // create then 403'd, and the deploy had already printed a green URL.
    expect(wf).not.toMatch(/gcloud services enable cloudscheduler\.googleapis\.com --quiet \|\| true/);
    expect(wf).toMatch(/ACTION REQUIRED - the queue heartbeat was NOT provisioned/);
    expect(wf).toMatch(/roles\/cloudscheduler\.admin/);
    expect(wf).toMatch(/roles\/serviceusage\.serviceUsageAdmin/);
  });

  it("it VERIFIES the job exists rather than trusting an exit code", () => {
    expect(wf).toMatch(/Heartbeat verified:/);
    expect(wf).toMatch(/fail_loudly "the job did not exist after writing it"/);
  });

  it("and the required roles are documented where the secrets are", () => {
    expect(wf).toMatch(/Cloud Scheduler Admin \+/);
  });

  it("a backstop pinger runs on GitHub's own schedule, needing no GCP role", () => {
    const hb = read(".github/workflows/heartbeat.yml");
    // HOURLY, deliberately: GitHub bills a 1-minute minimum per run, so */5
    // was ~8,640 billed minutes a month - 4x the free allowance, spent on
    // rounding (commit 32b4310). The backstop stays a backstop.
    expect(hb).toMatch(/cron: "0 \* \* \* \*"/);
    expect(hb).not.toMatch(/cron: "\*\/5/);
    expect(hb).toMatch(/\/api\/wa\/ping\?token=/);
    // Same token derivation - no new secret for the owner to manage, and the
    // optional rotation salt folded in the way the app folds it (F179/M10:
    // this line used to pin the UNSALTED form, so a rotation locked the
    // backstop out too).
    expect(hb).toMatch(/SALTED="wd-webhook:\$SESSION_SECRET"/);
    expect(hb).toMatch(/TOKEN="\$\(printf '%s' "\$SALTED" \| sha256sum \| cut -c1-32\)"/);
    expect(hb).not.toMatch(/printf 'wd-webhook:%s'/);
    // A failed ping must not paint the repo red and train the owner to ignore it.
    expect(hb).toMatch(/::warning::/);
  });
});

describe("the owner can prove the drain works without waiting for a cron", () => {
  it("one owner-gated route runs exactly what the schedule runs", () => {
    const t = readCode("src/app/api/admin/heartbeat-test/route.ts");
    expect(t).toMatch(/requireManagement\(\)/);
    expect(t).toMatch(/drainOutbox\(/);
    expect(t).toMatch(/drainGraphWakeups\(/);
    // ...and writes the same breadcrumb, so a successful tap turns the tile green.
    expect(t).toMatch(/kind: "cron-ping"/);
  });

  it("the card separates 'never provisioned' from 'it lapsed'", () => {
    const info = readCode("src/app/api/admin/deploy-info/route.ts");
    expect(info).toMatch(/state: "never"/);
    expect(info).toMatch(/state: live \? "live" : "stale"/);
    expect(info).toMatch(/nextStep/);
    const card = readCode("src/components/admin/DeployInfoCard.tsx");
    expect(card).toMatch(/Run the drain now/);
    expect(card).toMatch(/heartbeat-test/);
  });
});
