// PayPal subscription plan identity - the ONE place the plan ids and button
// styling live, shared by the client button and the server verifier.
//
// The ids are not secrets (they travel to the browser in every PayPal
// integration by design), but they are configuration: an owner must be able to
// swap a billing plan from Admin -> Keys without a redeploy, exactly like every
// other integration in this app. So the runtime resolves them and these are the
// fallback, not the source of truth.

export type PaidPlanId = "pro" | "ultra";

export interface PaypalPlanStyle {
  shape: "pill" | "rect";
  color: "blue" | "gold" | "silver" | "white" | "black";
  layout: "vertical" | "horizontal";
  label: "subscribe" | "paypal" | "checkout" | "buynow" | "pay" | "installment";
}

export interface PaypalPlanSpec {
  plan: PaidPlanId;
  /** Config key the owner can override in Admin -> Keys. */
  configKey: string;
  fallbackPlanId: string;
  style: PaypalPlanStyle;
}

export const PAYPAL_PLANS: Record<PaidPlanId, PaypalPlanSpec> = {
  pro: {
    plan: "pro",
    configKey: "PAYPAL_PLAN_PRO",
    fallbackPlanId: "P-4DM55206VD221810RNJTCFVA",
    style: { shape: "pill", color: "blue", layout: "vertical", label: "subscribe" },
  },
  ultra: {
    plan: "ultra",
    configKey: "PAYPAL_PLAN_ULTRA",
    fallbackPlanId: "P-13V7509211655291CNJTCHDA",
    style: { shape: "pill", color: "gold", layout: "vertical", label: "subscribe" },
  },
};

export function isPaidPlan(v: unknown): v is PaidPlanId {
  return v === "pro" || v === "ultra";
}

/** What the browser is told: never a secret, only what the SDK needs. */
export interface PaypalPublicConfig {
  /** Null when PayPal is unconfigured - the UI then shows the manual path. */
  clientId: string | null;
  /** Resolved plan id per tier, or null when that tier has no billing plan. */
  planIds: Record<PaidPlanId, string | null>;
  /** "live" | "sandbox" - drives nothing client-side but is worth showing in Admin. */
  env: string;
  /**
   * True when the signed-in account is a flagged tester riding TEST_MODE: the
   * client id and every plan id are withheld, because the same account is being
   * granted its tier free by /api/billing/checkout and must not also be handed a
   * live PayPal button (audit F199). Absent means an ordinary, real buyer.
   */
  sandbox?: boolean;
}
