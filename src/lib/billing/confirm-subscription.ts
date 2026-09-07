import "server-only";

// THE RETURN PATH HAD NO WAY TO GRANT ANYTHING.
//
// Two checkout flows exist. The BUTTON flow hands the browser a subscription id
// and /api/subscriptions/paypal-success verifies it server-side and grants. The
// REDIRECT flow - the primary one, the one `createPaypalCheckout` builds - sends
// the traveller to PayPal and back to `/?billing=success&plan=pro`, where
// /api/billing/confirm correctly refuses to grant on the client's say-so and
// waits for the webhook.
//
// Which is right, and also a single point of failure. If PAYPAL_WEBHOOK_ID is
// unset or wrong, if the webhook is misconfigured in the PayPal dashboard, if
// the delivery is simply lost - a traveller who has been charged sits on the
// free tier with a "activating shortly" message that never resolves, and the
// only recovery is the owner noticing.
//
// The fallback is not to start trusting the browser. It is to do on the redirect
// exactly what the button flow does: take the id PayPal appended to the return
// URL, ask PAYPAL - server side, with the secret - what that subscription is,
// and grant only what PayPal says. The client's `plan` parameter stays a hint
// that is logged and never believed, so a Pro subscription cannot be redeemed
// as Ultra by editing a query string.
//
// ONE FUNCTION, because two copies of "how a subscription becomes a plan" is
// how one of them ends up subtly more permissive than the other.

import { isPaidPlan } from "../paypal-plans";

export type ConfirmOutcome =
  | { ok: true; plan: "pro" | "ultra"; subscriptionId: string }
  | { ok: false; status: number; error: string };

/**
 * Verify a subscription id with PayPal and, if it entitles, apply the tier.
 *
 * `intendedPlan` is whatever the client believed it was buying. It is recorded
 * in the audit row and has no influence on the outcome.
 */
export async function confirmPaypalSubscription(input: {
  email: string;
  subscriptionId: string;
  intendedPlan?: string | null;
  /** Where the id came from - "button" or "redirect". Audit only. */
  source: string;
}): Promise<ConfirmOutcome> {
  const subscriptionId = String(input.subscriptionId ?? "").trim();
  if (!subscriptionId) {
    return { ok: false, status: 400, error: "Missing subscription." };
  }

  const { fetchPaypalSubscription, subscriptionEntitles, tierForPaypalPlan } = await import(
    "../paypal"
  );
  const sub = await fetchPaypalSubscription(subscriptionId);
  if (!sub) {
    return {
      ok: false,
      status: 502,
      error:
        "We could not verify that subscription with PayPal. Nothing was charged twice - try again in a moment.",
    };
  }
  if (!subscriptionEntitles(sub.status)) {
    return {
      ok: false,
      status: 409,
      error: `PayPal reports this subscription as ${sub.status.toLowerCase()}.`,
    };
  }

  // THE TIER COMES FROM PAYPAL'S PLAN ID, matched against the plan ids the owner
  // configured - never from anything the client said it was bought for.
  const tier = await tierForPaypalPlan(sub.planId);
  if (!isPaidPlan(tier)) {
    return { ok: false, status: 409, error: "That subscription is not one of our plans." };
  }

  // ONE SUBSCRIPTION, ONE ACCOUNT. The id reaches us over a channel the caller
  // controls, so a second account claiming an already-attributed subscription is
  // refused rather than granted. The real buyer returns on the redirect within
  // seconds and claims it first; nobody else can guess the id.
  const { subscriberFor } = await import("./subscription-link");
  const owner = await subscriberFor(subscriptionId).catch(() => null);
  const email = String(input.email ?? "").trim().toLowerCase();
  if (owner && owner !== email) {
    return { ok: false, status: 409, error: "That subscription belongs to another account." };
  }

  const { setPlan } = await import("../access");
  // A GRANT THAT DID NOT PERSIST IS NOT A GRANT. setPlan returned void and
  // swallowed mirror()'s boolean, so a failed write to app_users looked exactly
  // like success: the traveller was charged, told "You are on Ultra", and the
  // account stayed free with no record anywhere of the discrepancy. Report it,
  // so the caller can say something true and the owner has an event to find.
  const granted = await setPlan(email, tier);

  const { sbInsert } = await import("../runtime-config");
  const { ACTIVATION_KIND } = await import("./subscription-link");
  await sbInsert("agent_events", [
    {
      kind: ACTIVATION_KIND,
      user_email: email,
      vendor_id: "",
      vendor_name: "",
      detail: JSON.stringify({
        subscriptionId: sub.id,
        planId: sub.planId,
        tier,
        status: sub.status,
        nextBillingAt: sub.nextBillingAt,
        intendedPlan: input.intendedPlan ?? null,
        source: input.source,
        granted,
      }).slice(0, 800),
    },
  ]).catch(() => {});

  // A PLAN SWITCH USED TO LEAVE THE OLD SUBSCRIPTION RUNNING.
  //
  // PayPal subscriptions do not replace one another. Approving a second one
  // creates a SECOND live billing agreement, so a traveller who switched Pro ->
  // Ultra was charged for both, every month, and the UpgradeSheet told them
  // "a new subscription replaces the old one" - which PayPal had never agreed
  // to. The only escape offered was the manage link in a receipt email, and
  // cancelling from there cancels whichever one they happen to click, which is
  // as likely to be the NEW one - dropping a paying customer to free.
  //
  // So the switch cancels its predecessor, here, where we already know both
  // ids. Everything about this is deliberately conservative:
  //
  //   - it runs AFTER the grant, so a cancel that fails can never leave someone
  //     paying with no plan;
  //   - only ids from THIS account's own activation trail are ever cancelled;
  //   - the outcome is recorded either way, because a failed cancel means a
  //     traveller is being double-billed and the owner has to be able to find
  //     that;
  //   - a failure does not fail the request. The plan is live and the payment
  //     is real; refusing the whole thing over a cleanup step would be the
  //     worse trade.
  //
  // AND IT IS BOUNDED, AND IT WRITES ITS RECORD FIRST (audit F043).
  //
  // The loop awaited two TIMEOUT-FREE PayPal calls per prior activation on the
  // traveller's own return-from-checkout request, so a stalled PayPal turned an
  // upgrade that had ALREADY been granted into a request Cloud Run killed at
  // 90s - and the superseded row, the one record that names a double-billed
  // traveller, was written after the cancel and so never written at all.
  //
  // Detaching the loop does not save that record either: after-work is raced
  // against a budget and the container's CPU is throttled the instant the
  // response flushes, which abandons the in-flight cancel AND its insert
  // together. So the row is written FIRST with an explicit pending outcome and
  // updated in place when PayPal answers - and the whole cleanup runs under one
  // budget, on top of the per-call ceiling paypal.ts now carries.
  if (granted) {
    const { finishBeforeResponse } = await import("../after");
    await finishBeforeResponse(
      "paypal-supersede",
      () => supersedePriorSubscriptions(email, sub.id),
      SUPERSEDE_BUDGET_MS
    );
  }

  // The subscription IS real and verified - that part is settled and the event
  // above records it, so a later retry (webhook, another redirect) can finish
  // the job. What failed is our own write, and the traveller must not be told
  // their plan is live when it is not.
  if (!granted) {
    return {
      ok: false,
      status: 503,
      error:
        "Your payment went through, but we could not apply the plan just now. It will be applied automatically - no need to pay again.",
    };
  }

  return { ok: true, plan: tier, subscriptionId: sub.id };
}

/**
 * Ceiling for the whole supersede cleanup. Deliberately shorter than the
 * per-call PayPal timeout budget: a stalled provider costs the traveller this
 * much and no more, and every prior the loop did not reach keeps its pending
 * row rather than disappearing from the ledger.
 */
const SUPERSEDE_BUDGET_MS = 8_000;

/**
 * Cancel the subscriptions this account's new one replaces, recording the
 * outcome of each - including "we do not know yet".
 *
 * Only ids from THIS account's own activation trail are ever cancelled, and the
 * cancel is issued only for a subscription PayPal still reports as entitling.
 */
async function supersedePriorSubscriptions(email: string, newId: string): Promise<void> {
  const { activationsFor, SUPERSEDED_KIND } = await import("./subscription-link");
  const { sbInsert, sbInsertReturning, sbUpdateReturning } = await import("../runtime-config");
  const prior = (await activationsFor(email)).filter((id) => id !== newId);
  if (prior.length === 0) return;

  const detailFor = (oldId: string, outcome: Record<string, unknown>) =>
    JSON.stringify({ subscriptionId: oldId, replacedBy: newId, ...outcome }).slice(0, 800);
  const rowFor = (oldId: string, outcome: Record<string, unknown>) => ({
    kind: SUPERSEDED_KIND,
    user_email: email,
    vendor_id: "",
    vendor_name: "",
    detail: detailFor(oldId, outcome),
  });

  // ONE INSERT, BEFORE THE FIRST CALL THAT MIGHT NEVER ANSWER. `cancelled: null`
  // is an honest unknown, not a failure - and it is what the owner finds if the
  // budget runs out mid-cleanup.
  const pending = await sbInsertReturning<{ id?: number | string }>(
    "agent_events",
    prior.map((oldId) => rowFor(oldId, { cancelled: null, outcome: "pending" }))
  ).catch(() => [] as { id?: number | string }[]);

  const { cancelPaypalSubscription, fetchPaypalSubscription, subscriptionEntitles } =
    await import("../paypal");
  const deadline = Date.now() + SUPERSEDE_BUDGET_MS;
  for (let i = 0; i < prior.length; i++) {
    // Out of budget: the remaining priors keep their pending rows, which is the
    // truthful state - we asked for nothing and know nothing.
    if (Date.now() >= deadline) break;
    const oldId = prior[i];
    // Only cancel what is actually still live - a cancelled or expired
    // subscription needs no action, and asking first keeps the trail free of
    // no-op cancels.
    const old = await fetchPaypalSubscription(oldId).catch(() => null);
    let outcome: Record<string, unknown>;
    if (!old || !subscriptionEntitles(old.status)) {
      outcome = {
        cancelled: false,
        outcome: old ? "already-inactive" : "unreadable",
        status: old?.status ?? null,
      };
    } else {
      const cancelled = await cancelPaypalSubscription(
        oldId,
        "Replaced by a new WheelDeal plan"
      );
      outcome = { cancelled, outcome: cancelled ? "cancelled" : "cancel-failed" };
    }
    const rowId = pending[i]?.id;
    if (rowId === undefined || rowId === null) {
      // The pending insert did not land (or the store gave nothing back): write
      // the outcome on its own rather than losing it.
      await sbInsert("agent_events", [rowFor(oldId, outcome)]).catch(() => {});
      continue;
    }
    // A failed patch leaves the pending row standing - unknown, never a
    // confident "cancelled".
    await sbUpdateReturning(
      "agent_events",
      `id=eq.${encodeURIComponent(String(rowId))}`,
      { detail: detailFor(oldId, outcome) }
    ).catch(() => []);
  }
}
