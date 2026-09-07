import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { PAYPAL_PLANS, type PaypalPublicConfig } from "@/lib/paypal-plans";

// What the browser needs to render a PayPal subscribe button, and nothing else.
//
// The client id is public by construction - it ships inside the PayPal SDK URL
// in every integration. The SECRET never appears here, never appears in any
// NEXT_PUBLIC_ variable, and is read only by server routes that talk to PayPal
// directly.
//
// Served from the runtime config rather than a build-time env so the owner can
// paste a client id or swap a billing plan in Admin -> Keys and have it apply
// without a redeploy - the same rule every other integration in this app
// follows. `NEXT_PUBLIC_PAYPAL_CLIENT_ID` is honoured as the fallback for a
// deployment that prefers to bake it in.
export const dynamic = "force-dynamic";

export async function GET() {
  // Signed in only: this is a purchase surface, not a public config dump.
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // THE BUTTON PATH HAD NO GATES AT ALL.
  //
  // /api/billing/checkout enforces two things in front of the money: the
  // owner's payments kill switch, and the warm-up gate. The PayPal button is a
  // SECOND way to start a subscription and it went through neither - the client
  // asked for plan ids, got them, and the traveller could subscribe.
  //
  // The gate has to sit HERE rather than on paypal-success. By the time that
  // route runs PayPal has already taken the money; refusing then would mean
  // charging someone and withholding the plan, which is worse than either
  // failure alone. Withholding the plan IDS is the only refusal that happens
  // before a payment exists.
  //
  // Both checks fail CLOSED, and both are the same predicates the checkout
  // route uses - one definition of "may this person buy", not two that drift.
  const { killSwitchOn } = await import("@/lib/usage");
  if (await killSwitchOn()) {
    return NextResponse.json(
      { error: "Payments are temporarily paused by the owner." },
      { status: 503 }
    );
  }
  // Flagged testers ride the sandbox and are never gated - otherwise a beta
  // tester could not exercise the paid tiers at all. Same carve-out, same
  // ordering, as the checkout route.
  //
  // AND THE SAME CARVE-OUT DECIDES WHAT THIS ROUTE HANDS BACK (audit F199).
  // `isTestUser` meant "grant the plan free, no charge" in /api/billing/checkout
  // and only "skip the warm-up gate" here, so the PayPal button rendered under
  // the very same PlanCard handed a flagged tester a LIVE client id and the live
  // plan ids and took real money, while the Subscribe button above it answered
  // "Test mode - no charge". One predicate, resolved once, now decides both.
  const { isTestUser } = await import("@/lib/allowlist");
  const sandbox = await isTestUser(session.email).catch(() => false);
  if (!sandbox) {
    const { warmupStatus } = await import("@/lib/warmup");
    const warm = await warmupStatus(session.email);
    if (!warm.warmed) {
      return NextResponse.json(
        {
          error: "Unlock upgrading by using the app a little more first.",
          warmup: warm,
        },
        { status: 403 }
      );
    }
  }

  const { getConfig } = await import("@/lib/runtime-config");
  const [clientId, env, proPlan, ultraPlan] = await Promise.all([
    getConfig("PAYPAL_CLIENT_ID"),
    getConfig("PAYPAL_ENV"),
    getConfig(PAYPAL_PLANS.pro.configKey),
    getConfig(PAYPAL_PLANS.ultra.configKey),
  ]);

  // A SANDBOXED TESTER GETS NO PURCHASE SURFACE AT ALL. PayPalProvider renders
  // its children without loading the SDK when there is no client id, and the
  // button returns null without a plan id - so the only way left to "buy" while
  // TEST_MODE is on is the sheet's own Subscribe button, which is the free
  // grant. Refusing here rather than at paypal-success is deliberate: by then
  // PayPal has taken the money, and withholding the tier afterwards is worse
  // than either failure alone.
  const body: PaypalPublicConfig = {
    clientId: sandbox
      ? null
      : (clientId || process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || "").trim() || null,
    planIds: {
      pro: sandbox ? null : (proPlan || PAYPAL_PLANS.pro.fallbackPlanId).trim() || null,
      ultra: sandbox ? null : (ultraPlan || PAYPAL_PLANS.ultra.fallbackPlanId).trim() || null,
    },
    env: (env || "live").trim().toLowerCase(),
    sandbox,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
}
