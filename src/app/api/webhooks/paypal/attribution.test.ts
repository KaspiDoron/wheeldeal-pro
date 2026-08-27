import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// THE PAYPAL WEBHOOK, RUN - NOT READ.
//
// Wave 0 split attribution so a DOWNGRADE needs our own verified activation
// link and only a GRANT may bootstrap from the attacker-settable `custom_id`
// hint. Source pins asserted that split and stayed green while the hole was
// still open, because the hole was not in the split: `setPlan` OVERWRITES, so
// the GRANT branch could hand an Ultra account a Pro "grant" and that is a
// downgrade by another name. An attacker who can set custom_id (a raw PayPal
// checkout can) pointed their own real Pro subscription at a victim and dropped
// them a tier - through the branch the fix left open.
//
// These tests execute the handler with its collaborators stubbed and assert
// what it DOES to the account: which email, which tier, and whether setPlan is
// called at all. They fail on a revert to `grantEmail = linked || hintEmail`
// with an unconditional setPlan.

const PRO_PLAN = "P-PRO-PLAN-ID";
const ULTRA_PLAN = "P-ULTRA-PLAN-ID";

interface Scenario {
  /** Verified activation link for the subscription in the event, if any. */
  linked?: string | null;
  /** app_users rows keyed by email; absent = no such account. */
  plans?: Record<string, string>;
  /** Make the app_users read fail transiently. */
  planReadUnavailable?: boolean;
  /** What PayPal answers for fetchPaypalSubscription (renewals). */
  paypalPlanId?: string | null;
  setPlanOk?: boolean;
  /** Signature verification outcome (default: verified). */
  verified?: boolean;
  /** PAYPAL_WEBHOOK_ID: undefined keeps the default "WH-TEST"; null unsets it
   *  (the not-configured path). */
  webhookId?: string | null;
}

async function loadHook(s: Scenario = {}) {
  vi.resetModules();
  const calls: Array<{ email: string; plan: string }> = [];
  const events: Array<Record<string, unknown>> = [];
  const marks: Array<{ kind: string; email: string; subscriptionId: string }> = [];

  vi.doMock("@/lib/paypal", () => ({
    verifyPaypalWebhook: async () => s.verified ?? true,
    tierForPaypalPlan: async (planId: string | null) =>
      planId === PRO_PLAN ? "pro" : planId === ULTRA_PLAN ? "ultra" : null,
    fetchPaypalSubscription: async () =>
      s.paypalPlanId ? { id: "sub", status: "ACTIVE", planId: s.paypalPlanId } : null,
  }));
  vi.doMock("@/lib/billing/subscription-link", () => ({
    subscriberFor: async () => s.linked ?? null,
    suspendedSinceFor: async () => null,
    markSubscriptionState: async (
      kind: string,
      input: { email: string; subscriptionId: string }
    ) => {
      marks.push({ kind, ...input });
    },
    SUSPENDED_KIND: "subscription-suspended",
    RESUMED_KIND: "subscription-resumed",
  }));
  vi.doMock("@/lib/access", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return {
      ...actual,
      setPlan: async (email: string, plan: string) => {
        calls.push({ email, plan });
        return s.setPlanOk ?? true;
      },
    };
  });
  vi.doMock("@/lib/runtime-config", () => ({
    getConfig: async (k: string) =>
      k === "PAYPAL_WEBHOOK_ID"
        ? s.webhookId === undefined
          ? "WH-TEST"
          : (s.webhookId ?? undefined)
        : undefined,
    sbInsert: async (_t: string, rows: Array<Record<string, unknown>>) => {
      events.push(...rows);
      return true;
    },
    sbSelectStrict: async (_t: string, query: string) => {
      if (s.planReadUnavailable) return { error: "unavailable" as const };
      const email = decodeURIComponent(/email=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      const plan = (s.plans ?? {})[email];
      return { rows: plan ? [{ plan }] : [] };
    },
  }));

  const mod = await import("./route");
  return { POST: mod.POST, calls, events, marks };
}

const event = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/webhooks/paypal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const activated = (customId: string, planId = PRO_PLAN, id = "I-ATTACKER") =>
  event({
    id: "WH-EVT-1",
    event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
    resource: { id, plan_id: planId, custom_id: customId },
  });

describe("OR11 T2 - the signature gate actually protects plan grants (EXECUTED)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a FORGED webhook (id set, signature invalid) is rejected 401 and grants NOTHING", () => {
    return (async () => {
      // The existing suite stubbed verification to always pass; this proves the
      // gate itself. A raw POST with a valid-looking Ultra activation but a bad
      // signature must not touch the account.
      const { POST, calls } = await loadHook({
        verified: false,
        linked: "victim@example.com",
        plans: { "victim@example.com": "free" },
      });
      const res = await POST(activated("victim@example.com|ultra", ULTRA_PLAN));
      expect(res.status).toBe(401);
      expect(calls).toEqual([]); // no setPlan - a forged event cannot grant Ultra
    })();
  });

  it("NOT CONFIGURED is not OK: no webhook id -> 503 (retry) and grants NOTHING", async () => {
    // Answering 200 here would burn PayPal's one retry channel on a deploy that
    // cannot verify anything; 503 makes it retry into a configured deploy. Either
    // way, an unverifiable event never moves a plan.
    const { POST, calls, events } = await loadHook({
      webhookId: null,
      linked: "buyer@example.com",
      plans: { "buyer@example.com": "free" },
    });
    const res = await POST(activated("buyer@example.com|ultra", ULTRA_PLAN));
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
    // ...and the knock is recorded so the owner can see what could not verify.
    expect(events.some((e) => String(e.type).startsWith("pp_unconfigured_"))).toBe(true);
  });

  it("a VALID signature (id set, verified) is allowed through to the grant logic", async () => {
    const { POST, calls } = await loadHook({
      verified: true,
      linked: "buyer@example.com",
      plans: { "buyer@example.com": "free" },
    });
    const res = await POST(activated("buyer@example.com|ultra", ULTRA_PLAN));
    expect(res.status).toBe(200);
    // A verified activation for a linked buyer DOES grant - the gate is not
    // rejecting everything, which is what makes the two refusals above meaningful.
    expect(calls).toContainEqual({ email: "buyer@example.com", plan: "ultra" });
  });
});

describe("ATTACK: custom_id cannot move another account's plan - in either direction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a hint naming an ULTRA victim cannot pull them down to Pro through the GRANT branch", async () => {
    // The attacker's own, real, signature-verified Pro subscription - carrying
    // the victim's email in custom_id. Nothing links it to the victim.
    const { POST, calls, events } = await loadHook({
      linked: null,
      plans: { "victim@example.com": "business" }, // stored form of ultra
    });
    const res = await POST(activated("victim@example.com|pro"));
    expect(res.status).toBe(200);
    // The whole point: no write at all. A `setPlan(victim, "pro")` here IS the
    // downgrade, whichever branch issued it.
    expect(calls).toEqual([]);
    expect(events.some((e) => String(e.type).startsWith("pp_grant_not_raised_pro"))).toBe(true);
  });

  it("...and the same event cannot downgrade through the CANCELLED branch either", async () => {
    const { POST, calls } = await loadHook({ linked: null, plans: { "victim@example.com": "business" } });
    const res = await POST(
      event({
        id: "WH-EVT-2",
        event_type: "BILLING.SUBSCRIPTION.CANCELLED",
        resource: { id: "I-ATTACKER", custom_id: "victim@example.com|pro" },
      })
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("a hint cannot name its own tier - the plan id is the only source", async () => {
    // A subscription to a plan we never sold (the attacker's own $0.01 PayPal
    // plan), with "ultra" written into custom_id. The tier fallback that used
    // to read that hint made it a free upgrade.
    const { POST, calls } = await loadHook({
      linked: null,
      plans: { "attacker@example.com": "free" },
      paypalPlanId: "P-NOT-OURS",
    });
    const res = await POST(activated("attacker@example.com|ultra", "P-NOT-OURS"));
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("a hint never files the attacker's subscription under the victim's name", async () => {
    // markSubscriptionState writes email + subscriptionId into our own evidence
    // trail. From a hint that would be a durable link an attacker chose.
    const { POST, marks } = await loadHook({ linked: null, plans: { "victim@example.com": "free" } });
    await POST(activated("victim@example.com|pro"));
    expect(marks).toEqual([]);
  });
});

describe("the paying traveller is still served", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a hint still bootstraps a subscription nobody has claimed (the redirect checkout)", async () => {
    const { POST, calls, events } = await loadHook({
      linked: null,
      plans: { "buyer@example.com": "free" },
    });
    const res = await POST(activated("buyer@example.com|pro"));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ email: "buyer@example.com", plan: "pro" }]);
    // Hint-driven grants are the one plan change with no verified link behind
    // them, so the owner gets a row naming them as such.
    expect(events.some((e) => e.type === "pp_hint_grant_pro")).toBe(true);
  });

  it("a linked upgrade Pro -> Ultra still applies", async () => {
    const { POST, calls } = await loadHook({
      linked: "buyer@example.com",
      plans: { "buyer@example.com": "pro" },
    });
    await POST(activated("", ULTRA_PLAN, "I-REAL"));
    expect(calls).toEqual([{ email: "buyer@example.com", plan: "ultra" }]);
  });

  it("a linked cancellation still downgrades to free", async () => {
    const { POST, calls } = await loadHook({
      linked: "buyer@example.com",
      plans: { "buyer@example.com": "business" },
    });
    await POST(
      event({
        id: "WH-EVT-3",
        event_type: "BILLING.SUBSCRIPTION.CANCELLED",
        resource: { id: "I-REAL" },
      })
    );
    expect(calls).toEqual([{ email: "buyer@example.com", plan: "free" }]);
  });

  it("a renewal on a linked subscription with no plan_id asks PayPal, then keeps the tier", async () => {
    const { POST, calls } = await loadHook({
      linked: "buyer@example.com",
      plans: { "buyer@example.com": "free" },
      paypalPlanId: ULTRA_PLAN,
    });
    await POST(
      event({
        id: "WH-EVT-4",
        event_type: "PAYMENT.SALE.COMPLETED",
        resource: { id: "SALE-1", billing_agreement_id: "I-REAL" },
      })
    );
    expect(calls).toEqual([{ email: "buyer@example.com", plan: "ultra" }]);
  });
});

describe("fail closed when the account cannot be read", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an unreadable app_users row means 503 (PayPal retries), never a blind write", async () => {
    const { POST, calls } = await loadHook({
      linked: "buyer@example.com",
      planReadUnavailable: true,
    });
    const res = await POST(activated("", PRO_PLAN, "I-REAL"));
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("a hint aimed at no account is recorded and acked - PayPal is not asked to retry forever", async () => {
    const { POST, calls, events } = await loadHook({ linked: null, plans: {} });
    const res = await POST(activated("nobody@example.com|pro"));
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect(events.some((e) => e.type === "pp_grant_no_account_pro")).toBe(true);
  });

  it("a failed grant write still asks PayPal to retry", async () => {
    const { POST, events } = await loadHook({
      linked: "buyer@example.com",
      plans: { "buyer@example.com": "free" },
      setPlanOk: false,
    });
    const res = await POST(activated("", PRO_PLAN, "I-REAL"));
    expect(res.status).toBe(503);
    expect(events.some((e) => e.type === "plan_grant_failed_pro")).toBe(true);
  });
});
