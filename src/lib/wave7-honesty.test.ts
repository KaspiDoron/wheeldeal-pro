import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// WAVE 7 - MANAGEMENT HONESTY. Two families of defect, one doctrine:
//
//   HONEST WRITES: no admin control may paint a state the store did not
//   confirm. The route threads the write's boolean back; the client repaints
//   from the response's READ-BACK, never from the request.
//
//   FAIL DARK: no admin surface may render a confident empty/green state over
//   a dead database. Unknown is a red card with a retry, never "🎉 Nothing
//   needs review".

let configReadThrows = false;
const config: Record<string, string | null> = {};
let setConfigOk = true;

vi.mock("./runtime-config", () => ({
  getConfig: async (k: string) => {
    if (configReadThrows) throw new Error("vault down");
    return config[k] ?? null;
  },
  getConfigFresh: async (k: string) => ({ value: config[k] ?? null }),
  setConfig: async (k: string, v: string) => {
    if (!setConfigOk) return { ok: false, persistent: false, error: "write failed" };
    config[k] = v;
    return { ok: true, persistent: true };
  },
  sbSelect: async () => [],
}));

beforeEach(() => {
  configReadThrows = false;
  setConfigOk = true;
  for (const k of Object.keys(config)) delete config[k];
});

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the learning kill switch fails in the KILL direction", () => {
  it("an unreadable vault means OFF, like every other kill switch", async () => {
    // It was the ONE switch in the system that failed open - a "kill switch"
    // that stops working during exactly the outages a kill switch is for.
    const { opsLearningEnabled } = await import("./ops/learning");
    configReadThrows = true;
    expect(await opsLearningEnabled()).toBe(false);
  });

  it("a readable vault keeps the default-on semantics", async () => {
    const { opsLearningEnabled } = await import("./ops/learning");
    expect(await opsLearningEnabled()).toBe(true);
    config.OPS_LEARNING = "off";
    expect(await opsLearningEnabled()).toBe(false);
  });

  it("the toggle route echoes the STORED value, and a failed write is a 502", () => {
    const route = readCode("src/app/api/admin/ops/policy/route.ts");
    expect(route).toMatch(/const stored = await opsLearningEnabled\(\)/);
    expect(route).toMatch(/learningEnabled: stored/);
    expect(route).not.toMatch(/learningEnabled: Boolean\(body\.on\)/);
    expect(route).toMatch(/status: 502/);
  });
});

describe("one flag dialect everywhere", () => {
  it("TEST_MODE accepts 'yes' and 'enabled' like the shared parser promises", async () => {
    const { testModeOn } = await import("./allowlist");
    for (const v of ["on", "1", "true", "yes", "enabled"]) {
      config.TEST_MODE = v;
      expect(await testModeOn(), `"${v}" must mean on`).toBe(true);
    }
    config.TEST_MODE = "off";
    expect(await testModeOn()).toBe(false);
  });

  it("SCALE_MODE and the public config route go through parseFlag too", () => {
    expect(readCode("src/lib/usage.ts")).toMatch(/parseFlag\(await getConfig\("SCALE_MODE"\), false\)/);
    const pub = readCode("src/app/api/config/public/route.ts");
    expect(pub).toMatch(/parseFlag/);
    expect(pub).not.toMatch(/\["on", "1", "true"\]\.includes/);
  });
});

describe("no behaviour flag renders as four dots", () => {
  it("every flag/threshold in the vault catalogue is secret: false", () => {
    // RAW read: readCode strips //-comments, which eats the https:// inside
    // APP_DOMAIN's own label and truncates its row mid-string.
    const cfg = readFileSync(join(process.cwd(), "src/lib/config.ts"), "utf8");
    for (const name of [
      "TEST_MODE", "SCALE_MODE", "PACING_MODE", "HUMAN_TAKEOVER", "FAST_DISPATCH",
      "CANCEL_GUARD", "WARMUP_GATE", "WILL_ACTIONS", "WABA_ENABLED", "WABA_DRY_RUN",
      "WABA_KILL", "TRANSPORT_MODE", "CLOUD_API_ENABLED", "APP_DOMAIN", "OPERATOR_NAME",
    ]) {
      const row = cfg.slice(cfg.indexOf(`{ name: "${name}"`), cfg.indexOf("\n", cfg.indexOf(`{ name: "${name}"`)));
      expect(row, `${name} must carry secret: false`).toMatch(/secret: false/);
    }
  });

  it("the vault editor types a SETTING in the clear and offers on/off taps", () => {
    const page = readFileSync(join(process.cwd(), "src/app/admin/page.tsx"), "utf8");
    expect(page).toMatch(/type=\{k\.secret === false \? "text" : "password"\}/);
    expect(page).toMatch(/k\.secret === false && \/'\(on\|off\)'\/\.test\(k\.label\)/);
    // The write response carries secret + docUrl so replacing the row keeps them.
    const cfg = readCode("src/lib/config.ts");
    expect(cfg).toMatch(/docUrl: DOC_URLS\[name\],\s*secret: meta\.secret !== false,/);
  });
});

describe("admin writes are verified, not painted", () => {
  it("the kill switch's 502 and fleet warning reach a pixel", () => {
    const page = readFileSync(join(process.cwd(), "src/app/admin/page.tsx"), "utf8");
    expect(page).toMatch(/setKillSwitchMsg\(data\.error \?\?/);
    expect(page).toMatch(/\{killSwitchMsg && \(/);
  });

  it("TEST_MODE re-reads the effective value instead of assuming the flip", () => {
    const page = readFileSync(join(process.cwd(), "src/app/admin/page.tsx"), "utf8");
    const fn = page.slice(page.indexOf("async function toggleTestMode"), page.indexOf("async function save()"));
    expect(fn).toMatch(/fetch\("\/api\/config\/public"\)/);
    expect(fn).toMatch(/setTestMode\(Boolean\(p\.testMode\)\)/);
    expect(fn).not.toMatch(/setTestMode\(\(v\) => !v\)/);
  });

  it("a role change that did not persist answers 500, like the status branch", async () => {
    const { setAdmin } = await import("./session");
    setConfigOk = false;
    expect(await setAdmin("colleague@example.com", true)).toBe(false);
    setConfigOk = true;
    expect(await setAdmin("colleague@example.com", true)).toBe(true);
    const route = readCode("src/app/api/admin/users/route.ts");
    expect(route).toMatch(/const roleWrote = await setAdmin/);
    expect(route).toMatch(/The role change did not persist/);
  });

  it("an ops review that was not stored says so instead of 'the agents learn from this'", () => {
    const route = readCode("src/app/api/admin/ops/review/route.ts");
    expect(route).toMatch(/let reviewWrote = false/);
    expect(route).toMatch(/The review was NOT stored/);
  });

  it("policy saves and rollbacks propagate the vault write's boolean", () => {
    const policy = readCode("src/lib/policy.ts");
    expect(policy).toMatch(/behavior is unchanged/);
    // The rollback distinguishes the SPEC write (ok:false) from bookkeeping
    // (a problem string on ok:true) - both directions are honest.
    expect(policy).toMatch(/version history did not update/);
    expect(policy).toMatch(/active-revision stamp did not update/);
  });
});

describe("the Ops Center fails dark, not green", () => {
  it("the review queue and conversations routes ride sbSelectDark with degraded", () => {
    const review = readCode("src/app/api/admin/ops/review/route.ts");
    expect(review).toMatch(/sbSelectDark<Record<string, unknown>>/);
    expect(review).toMatch(/degraded: rows === null \? \["review queue"\] : \[\]/);
    const conv = readCode("src/app/api/admin/ops/conversations/route.ts");
    expect(conv).toMatch(/sbSelectDark<ThreadRow>/);
    expect(conv).toMatch(/degraded\.push\("threads"\)/);
    expect(conv).toMatch(/hasMore/);
  });

  it("conversations search and filters run in the QUERY, not over a window", () => {
    const conv = readCode("src/app/api/admin/ops/conversations/route.ts");
    expect(conv).toMatch(/or=\(vendor_name\.ilike\./);
    // flagged/bookmarked drive from agent_reviews FIRST, so the thread window
    // can never hide a mark.
    expect(conv).toMatch(/onlyFlagged \? "status=in\.\(open,flagged,auto_flagged\)" : "bookmark=is\.true"/);
    expect(conv).toMatch(/offset=\$\{offset\}/);
  });

  it("the transcript is dark too, and the panel renders what could not be read", () => {
    const transcript = readCode("src/app/api/admin/ops/transcript/route.ts");
    expect(transcript).not.toMatch(/sbSelect</);
    expect(transcript).toMatch(/degraded\.push\("outbound messages"\)/);
    const panel = readCode("src/components/ops/ConversationPanel.tsx");
    expect(panel).toMatch(/data\.degraded/);
  });

  it("the inbox and threads panels render a retry card, never a party emoji, on failure", () => {
    const ops = readCode("src/components/ops/OpsCenter.tsx");
    expect(ops).toMatch(/could not be read - that is unknown, not empty/);
    expect((ops.match(/↻ Retry/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the policy panel's spinner is no longer permanent", () => {
    const panel = readCode("src/components/ops/PolicyPanel.tsx");
    expect(panel).toMatch(/setLoadErr\(true\)/);
    expect(panel).toMatch(/↻ Retry/);
  });
});

describe("the owner's wishlist pieces exist", () => {
  it("message-path finally has a UI consumer: the Delivery trail", () => {
    const panel = readCode("src/components/ops/ConversationPanel.tsx");
    expect(panel).toMatch(/\/api\/admin\/ops\/message-path\?sender=/);
    expect(panel).toMatch(/Delivery trail/);
  });

  it("verification status and the transport chip render per conversation", () => {
    const panel = readCode("src/components/ops/ConversationPanel.tsx");
    expect(panel).toMatch(/o\.verified === true \? "✓" : "\?"/);
    expect(panel).toMatch(/transport && \(/);
  });

  it("the detect sweep is debounced across tab remounts", () => {
    const ops = readCode("src/components/ops/OpsCenter.tsx");
    expect(ops).toMatch(/wd_ops_detect_at/);
  });
});
