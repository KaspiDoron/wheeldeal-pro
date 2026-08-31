import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// W8 B14: ANY ADMIN COULD PROMOTE ANY EMAIL, AND DEMOTE EVERY OTHER ADMIN.
// ---------------------------------------------------------------------------
//
// `/api/admin/users` gated promote/demote on `requireManagement`, so the only
// protected account was the owner's. Admin is not a read-only role here - it
// opens the Key Vault - and the promotion is PERSISTENT (ADMIN_EMAILS_EXTRA in
// the vault), so one compromised admin session converts into durable privilege
// plus the removal of everyone who could revoke it.

describe("W8 B14: membership of management is the owner's decision", () => {
  const route = readCode("src/app/api/admin/users/route.ts");

  it("promote/demote is refused for a non-owner admin", () => {
    const block = route.slice(
      route.indexOf('if (action === "promote" || action === "demote")'),
      route.indexOf('} else if (status === "active"')
    );
    expect(block.length).toBeGreaterThan(50);
    expect(block).toMatch(/if \(session\.role !== "owner"\) \{/);
    expect(block).toMatch(/status: 403/);
    // ...and the refusal comes BEFORE the mutation, not after it.
    expect(block.indexOf('session.role !== "owner"')).toBeLessThan(block.indexOf("setAdmin("));
  });

  it("the owner is still un-demotable, belt and braces", () => {
    expect(route).toMatch(/The owner cannot be demoted\./);
  });

  it("blocking an ORDINARY USER stays open to any admin - only PRIVILEGE narrowed", () => {
    // REWRITTEN, INTENT PRESERVED. This asserted that the block branch carries
    // no owner check AT ALL, guarding against over-narrowing: blocking or
    // erasing a traveller is reversible and every admin needs to be able to do
    // it without waking the owner. That still holds and is still asserted.
    //
    // What changed is that blocking an ADMIN stopped being the same act. It was
    // a silent no-op (getSession ignored `status` for management), so nothing
    // was being narrowed by leaving it open; now that a blocked admin is
    // actually refused, it is a revocation of management - the same class as
    // demote, and an admin who could block their peers could clear the room.
    const block = route.slice(
      route.indexOf('} else if (status === "active"'),
      route.length
    );
    // Narrowed on the TARGET, not on the action.
    expect(block).toMatch(/targetIsManagement && session\.role !== "owner"/);
    // And no blanket owner-only gate on the branch itself.
    expect(block).not.toMatch(/if \(session\.role !== "owner"\) \{/);
  });

  it("the admin panel stops offering an action the API will refuse", () => {
    const page = readCode("src/app/admin/page.tsx");
    const idx = page.indexOf('action: u.role === "admin" ? "demote" : "promote"');
    expect(idx).toBeGreaterThan(-1);
    // The nearest enclosing render guard is the owner check.
    expect(page.slice(Math.max(0, idx - 400), idx)).toMatch(/\{isOwner && \(/);
  });
});

// ---------------------------------------------------------------------------
// W8 B25: A RETIRED PAYPAL PLAN KEPT ENTITLING ITS TIER FOREVER.
// ---------------------------------------------------------------------------

const cfg = vi.hoisted(() => ({ values: {} as Record<string, string | null> }));
vi.mock("./runtime-config", () => ({
  getConfig: vi.fn(async (k: string) => cfg.values[k] ?? null),
  sbInsert: vi.fn(async () => true),
  sbSelect: vi.fn(async () => []),
}));

beforeEach(() => {
  cfg.values = {};
});

describe("W8 B25: the configured plan id is the plan id", () => {
  it("REPRODUCTION: the hardcoded fallback used to entitle even after a swap", async () => {
    const { PAYPAL_PLANS } = await import("./paypal-plans");
    const { tierForPaypalPlan } = await import("./paypal");
    // The owner retires the built-in plan and configures a new one.
    cfg.values.PAYPAL_PLAN_PRO = "P-NEW-PRO-PLAN";
    cfg.values.PAYPAL_PLAN_ULTRA = "P-NEW-ULTRA-PLAN";
    // The new one entitles...
    expect(await tierForPaypalPlan("P-NEW-PRO-PLAN")).toBe("pro");
    expect(await tierForPaypalPlan("P-NEW-ULTRA-PLAN")).toBe("ultra");
    // ...and the retired one does NOT. This is the assertion that used to fail:
    // both ids were accepted unconditionally, so a subscription to a plan the
    // owner had swapped away from kept its tier with no way to stop it short of
    // a redeploy - in a product whose whole config story is "paste it in Admin".
    expect(await tierForPaypalPlan(PAYPAL_PLANS.pro.fallbackPlanId)).toBeNull();
    expect(await tierForPaypalPlan(PAYPAL_PLANS.ultra.fallbackPlanId)).toBeNull();
  });

  it("with NO configuration the built-in id is still honoured - it is a fallback", async () => {
    const { PAYPAL_PLANS } = await import("./paypal-plans");
    const { tierForPaypalPlan } = await import("./paypal");
    expect(await tierForPaypalPlan(PAYPAL_PLANS.pro.fallbackPlanId)).toBe("pro");
    expect(await tierForPaypalPlan(PAYPAL_PLANS.ultra.fallbackPlanId)).toBe("ultra");
  });

  it("it resolves EXACTLY the way the checkout button does", () => {
    // Two different resolutions of "which plan id is live" is how a traveller
    // ends up subscribing to one plan and being entitled by another.
    const cfgRoute = readCode("src/app/api/subscriptions/paypal-config/route.ts");
    expect(cfgRoute).toMatch(/proPlan \|\| PAYPAL_PLANS\.pro\.fallbackPlanId/);
    const pp = readCode("src/lib/paypal.ts");
    expect(pp).toMatch(/norm\(cfg\) \|\| spec\.fallbackPlanId/);
  });

  it("an unknown plan id entitles nothing", async () => {
    const { tierForPaypalPlan } = await import("./paypal");
    expect(await tierForPaypalPlan("P-SOMEONE-ELSES-PLAN")).toBeNull();
    expect(await tierForPaypalPlan(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W8 B13: "NOTHING IS QUEUED" IS A CLAIM; A FAILED READ IS NOT.
// ---------------------------------------------------------------------------

describe("W8 B13: degradation is in the response shape, not inferred from silence", () => {
  it("/api/queue distinguishes signed-out, unreadable and genuinely empty", () => {
    const q = readCode("src/app/api/queue/route.ts");
    expect(q).toMatch(/state: "signed-out"/);
    expect(q).toMatch(/state: "unavailable"/);
    expect(q).toMatch(/state: "ok"/);
    // The unreadable case must not masquerade as a successful empty read.
    expect(q).toMatch(/sbSelectStrict<OutboxRow>/);
    expect(q).toMatch(/status: 503/);
  });

  it("/api/activity ships queueState with every poll", () => {
    const a = readCode("src/app/api/activity/route.ts");
    expect(a).toMatch(/const queueState: "ok" \| "unavailable" =/);
    expect(a).toMatch(/queueState,/);
    // The queue read is the strict one; the feed reads may still degrade
    // (an under-full feed is visibly incomplete, an empty queue is not).
    expect(a).toMatch(/sbSelectStrict<\{/);
  });

  it("/api/thread says WHY a transcript is empty", () => {
    const th = readCode("src/app/api/thread/route.ts");
    expect(th).toMatch(/state: "not-started"/);
    expect(th).toMatch(/state: "ok"/);
  });

  it("/api/market/hint separates 'no region' from 'no floor'", () => {
    const m = readCode("src/app/api/market/hint/route.ts");
    expect(m).toMatch(/state: "no-region"/);
    expect(m).toMatch(/scooter \|\| car \? "ok" : "no-floor"/);
  });
});

// ---------------------------------------------------------------------------
// W8: items the sweep flagged that earlier waves had already closed.
// ---------------------------------------------------------------------------

describe("W8 verification: already fixed by wave 0", () => {
  it("B10 - the user erase names each table's OWN email column", () => {
    // W9: the per-route column map became the erasure registry; the same
    // per-table truths hold there, and the route walks it via eraseUserData.
    const registry = readCode("src/lib/privacy/user-tables.ts");
    expect(registry).toMatch(/table: "bookings", column: "user_email"/);
    expect(registry).toMatch(/table: "feedback", column: "reporter_email"/);
    expect(registry).toMatch(/table: "wa_sessions", column: "email"/);
    expect(readCode("src/app/api/admin/users/route.ts")).toMatch(/eraseUserData/);
  });

  it("B11 - a custom_id hint may bootstrap, never downgrade, never lower", () => {
    // REWRITTEN, INTENT PRESERVED. `grantEmail = linked || hintEmail || ""` was
    // pinned as the fix, and it was half of one: setPlan OVERWRITES, so a hint
    // that "granted" Pro to an Ultra account performed the downgrade this test
    // is named after. The hint may now only bootstrap an UNLINKED subscription,
    // and every grant is raise-only (see attribution.test.ts, which runs it).
    const hook = readCode("src/app/api/webhooks/paypal/route.ts");
    expect(hook).toMatch(/const grantEmail = linked \|\| \(hintUsable \? hintEmail : ""\);/);
    expect(hook).toMatch(/const downgradeEmail = linked \|\| "";/);
    expect(hook).toMatch(/PLAN_RANK\[tier\] <= PLAN_RANK\[before\]/);
  });

  it("B12 - forgot-password is throttled per target AND per ip", () => {
    const forgot = readCode("src/app/api/auth/forgot/route.ts");
    expect(forgot).toMatch(/rateLimit\("forgot", `\$\{ip\}:\$\{key\}`, 3, 3600\)/);
    expect(forgot).toMatch(/rateLimit\("forgot-ip", ip, 10, 3600\)/);
  });

  it("B26 - a SALE reads billing_agreement_id first, everything else reads id", () => {
    const hook = readCode("src/app/api/webhooks/paypal/route.ts");
    expect(hook).toMatch(
      /isSale\s*\?\s*resource\.billing_agreement_id \?\? resource\.id\s*:\s*resource\.id \?\? resource\.billing_agreement_id/
    );
  });
});
