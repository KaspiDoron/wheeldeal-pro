// Plan entitlements - the single source of truth for what each plan can do.
// Isomorphic on purpose (no server-only imports): the same map drives server
// route gates and the pricing page, so a feature can
// never be "unlocked in the UI but blocked by the API" or vice versa.

import type { PlanId } from "./access";

export type Feature =
  | "compare"                // side-by-side offer comparison
  | "mass-bargain"           // ask every shop at once
  | "future-scheduling"      // pick-up on any future date (free = today only)
  | "priority-processing"    // paid sends drain ahead of free in the queue
  | "no-ads"
  | "local-language"         // agents haggle in the shop's own language
  | "fast-responder-filter"  // filter shops by reply speed
  | "predictive-pricing"     // Will's market price radar on results
  | "judge-insights"         // per-move judge grades in "Why this move?"
  | "trips-history"          // re-open + re-engage earlier search sessions
  | "vip-concurrency";       // larger share of the hourly send budget

export const ENTITLEMENTS: Record<PlanId, ReadonlySet<Feature>> = {
  free: new Set<Feature>(["compare"]),
  pro: new Set<Feature>([
    "compare",
    "mass-bargain",
    "future-scheduling",
    "priority-processing",
    "no-ads",
    "trips-history",
  ]),
  ultra: new Set<Feature>([
    "compare",
    "mass-bargain",
    "future-scheduling",
    "priority-processing",
    "no-ads",
    "trips-history",
    "local-language",
    "fast-responder-filter",
    "predictive-pricing",
    "judge-insights",
    "vip-concurrency",
  ]),
};

/** Lowest plan that includes a feature - drives lock chips and upgrade CTAs. */
export const FEATURE_META: Record<
  Feature,
  { label: string; blurb: string; icon: string; plan: "free" | "pro" | "ultra" }
> = {
  compare: {
    label: "Compare offers",
    blurb: "Top offers side by side - price, deposit, delivery.",
    icon: "compare",
    plan: "free",
  },
  "mass-bargain": {
    label: "Mass bargain",
    blurb: "Your agents ask every shop at once instead of one by one.",
    icon: "bolt",
    plan: "pro",
  },
  "future-scheduling": {
    label: "Book ahead",
    blurb: "Schedule pick-ups on any future date, not just today.",
    icon: "calendar",
    plan: "pro",
  },
  "priority-processing": {
    label: "Priority processing",
    blurb: "Your messages jump the send queue ahead of free searches.",
    icon: "send",
    plan: "pro",
  },
  "no-ads": {
    label: "No ads",
    blurb: "A clean, focused workspace with zero sponsored banners.",
    icon: "spark",
    plan: "pro",
  },
  "local-language": {
    label: "Local-language haggling",
    blurb: "Agents negotiate in the shop's own language - the strongest lever.",
    icon: "chat",
    plan: "ultra",
  },
  "fast-responder-filter": {
    label: "Fast-responder filter",
    blurb: "See only shops that historically answer within minutes.",
    icon: "clock",
    plan: "ultra",
  },
  "predictive-pricing": {
    label: "Price radar",
    blurb: "Will shows the real market floor for your vehicle before you commit.",
    icon: "sparkles",
    plan: "ultra",
  },
  "judge-insights": {
    label: "Judge insights",
    blurb: "See how Will's quality judges scored every negotiation move.",
    icon: "star",
    plan: "ultra",
  },
  "trips-history": {
    label: "Trip history",
    blurb: "Re-open and re-engage any earlier search - free keeps just your latest hunt.",
    icon: "clock",
    plan: "pro",
  },
  "vip-concurrency": {
    label: "VIP capacity",
    blurb: "Up to 24 new shops every 3 hours - the widest safe reach, refreshing fastest.",
    icon: "shieldCheck",
    plan: "ultra",
  },
};

/** Can this plan use this feature? Undefined/unknown plans mean free. */
export function can(plan: PlanId | string | undefined | null, f: Feature): boolean {
  const p: PlanId = plan === "pro" || plan === "ultra" ? plan : "free";
  return ENTITLEMENTS[p].has(f);
}

/** The plan a locked feature should upsell toward. */
export function planFor(f: Feature): "pro" | "ultra" {
  const p = FEATURE_META[f].plan;
  return p === "free" ? "pro" : p;
}

// ---------------------------------------------------------------------------
// LOCAL LANGUAGE - one predicate, one place (W-11)
// ---------------------------------------------------------------------------

/**
 * May this request haggle in the shop's own language?
 *
 * ONE RULE, ONE SPELLING. The entitlement was enforced everywhere - the plan's
 * "any account can POST {localLang:true}" did not survive checking - but it was
 * enforced in THREE DIFFERENT DIALECTS:
 *
 *   can(session.plan, "local-language")   outreach, mass (x3), graph nodes+engine
 *   isUltra                               bargain-draft
 *   ctx.plan === "ultra"                  agent-loop (the reply composer)
 *
 * The third is the dangerous one. It is a hardcoded tier literal, and the day
 * `can()` learns a new tier - a grandfathered plan, an annual SKU, a trial -
 * every surface follows except the one that actually writes the message to the
 * shop. The gate would still be "working" everywhere it is tested, and quietly
 * wrong on the send path. That is how one rule stops being one rule.
 *
 * `enabled` is the owner's fleet-wide kill switch (`LOCAL_LANGUAGE` in the Key
 * Vault). It is the LAST word and can only ever subtract: an owner who turns
 * this off must not be overridden by a plan.
 */
export function localLanguageAllowed(args: {
  requested: unknown;
  plan: string | null | undefined;
  /** The owner switch, already resolved. Defaults to on when unset. */
  enabled?: boolean;
}): boolean {
  if (args.enabled === false) return false;
  return Boolean(args.requested) && can(args.plan as PlanId, "local-language");
}
