import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// AUDIT F199: TEST_MODE x THE PAYPAL BUTTON PATH.
//
// `isTestUser` means two different things in two routes that render on the SAME
// upgrade card. /api/billing/checkout reads it as "grant the plan free, no
// charge" and answers `{ sandbox: true, applied: "ultra" }`. This route read it
// as "skip the warm-up gate" and then handed back a LIVE client id and the live
// fallback plan ids, so the PayPal button under the very same PlanCard took a
// flagged tester's real money while the Subscribe button above it said "Test
// mode - no charge".
//
// The refusal has to happen HERE, before a payment exists: withholding the plan
// ids is the only refusal that can happen before PayPal has taken anything (the
// route's own doctrine). So with TEST_MODE on, a flagged tester gets a config
// with no client id and no plan ids - PayPalProvider then renders children
// without loading the SDK and the button returns null - and `sandbox: true` says
// why. Everyone else is unaffected.
//
// Executed against the real route handler and the real `isTestUser`, over a
// Map-backed config store.

const config = new Map<string, string>();
const warmupCalls: string[] = [];

vi.mock("@/lib/runtime-config", () => ({
  getConfig: async (name: string) => config.get(name) ?? undefined,
}));
vi.mock("@/lib/session", () => ({
  getSession: async () => ({ email: "tester@example.com", role: "user", plan: "ultra" }),
}));
vi.mock("@/lib/usage", () => ({ killSwitchOn: async () => false }));
vi.mock("@/lib/warmup", () => ({
  warmupStatus: async (email: string) => {
    warmupCalls.push(email);
    return { warmed: true, remaining: 0, progress: null, terms: [] };
  },
}));

import { GET } from "./route";
import { PAYPAL_PLANS } from "@/lib/paypal-plans";

const TESTER = "tester@example.com";

const flagTester = (test: boolean) =>
  config.set("beta_allowlist", JSON.stringify([{ email: TESTER, plan: "free", ...(test ? { test: true } : {}) }]));

beforeEach(() => {
  config.clear();
  warmupCalls.length = 0;
  process.env.OWNER_EMAIL = "owner@example.com";
  delete process.env.BETA_ALLOWLIST;
  delete process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;
  config.set("PAYPAL_CLIENT_ID", "live-client-id");
  config.set("PAYPAL_ENV", "live");
});

describe("the PayPal button config and the TEST_MODE sandbox agree", () => {
  it("a flagged tester with TEST_MODE ON gets NO live purchase surface", async () => {
    config.set("TEST_MODE", "on");
    flagTester(true);

    const body = await (await GET()).json();
    expect(body.clientId).toBeNull();
    expect(body.planIds.pro).toBeNull();
    expect(body.planIds.ultra).toBeNull();
    expect(body.sandbox).toBe(true);
  });

  it("and the live plan ids never reach that browser at all", async () => {
    config.set("TEST_MODE", "on");
    config.set("PAYPAL_PLAN_PRO", "P-CONFIGURED-PRO");
    flagTester(true);

    const raw = JSON.stringify(await (await GET()).json());
    expect(raw).not.toContain("P-CONFIGURED-PRO");
    expect(raw).not.toContain(PAYPAL_PLANS.pro.fallbackPlanId);
    expect(raw).not.toContain(PAYPAL_PLANS.ultra.fallbackPlanId);
    expect(raw).not.toContain("live-client-id");
  });

  it("the warm-up carve-out for flagged testers is unchanged", async () => {
    config.set("TEST_MODE", "on");
    flagTester(true);

    await GET();
    expect(warmupCalls).toEqual([]);
  });

  it("with TEST_MODE OFF the same account buys for real", async () => {
    config.set("TEST_MODE", "off");
    flagTester(true);
    config.set("PAYPAL_PLAN_PRO", "P-CONFIGURED-PRO");

    const body = await (await GET()).json();
    expect(body.clientId).toBe("live-client-id");
    expect(body.planIds.pro).toBe("P-CONFIGURED-PRO");
    expect(body.planIds.ultra).toBe(PAYPAL_PLANS.ultra.fallbackPlanId);
    expect(body.sandbox).toBeFalsy();
    expect(warmupCalls).toEqual([TESTER]);
  });

  it("TEST_MODE on but the account is NOT flagged: a real buyer, real ids", async () => {
    config.set("TEST_MODE", "on");
    flagTester(false);

    const body = await (await GET()).json();
    expect(body.clientId).toBe("live-client-id");
    expect(body.planIds.pro).toBe(PAYPAL_PLANS.pro.fallbackPlanId);
    expect(body.sandbox).toBeFalsy();
  });
});
