import { NextResponse } from "next/server";
import { verifyPaypalWebhook, tierForPaypalPlan } from "@/lib/paypal";
import {
  subscriberFor,
  suspendedSinceFor,
  markSubscriptionState,
  SUSPENDED_KIND,
  RESUMED_KIND,
  ACTIVATION_KIND,
} from "@/lib/billing/subscription-link";
import { effectForEvent, clearsSuspension } from "@/lib/billing/suspension";
import { setPlan, normalizePlan, type PlanId } from "@/lib/access";
import { getConfig, sbInsert, sbSelectStrict } from "@/lib/runtime-config";

// The plan ladder. A GRANT may only ever move an account UP it - see the grant
// branch for why that is a security property and not a nicety.
const PLAN_RANK: Record<PlanId, number> = { free: 0, pro: 1, ultra: 2 };

/**
 * What plan an account is on right now, read STRICTLY.
 *
 * "absent" (no such account) and "unknown" (we could not read) are different
 * answers and the caller must treat them differently: there is nothing to grant
 * to an account that does not exist, but an unreadable row means we cannot
 * prove a grant would raise rather than lower a plan - and this route refuses
 * to write a plan it cannot prove.
 */
async function currentPlanFor(email: string): Promise<PlanId | "absent" | "unknown"> {
  const read = await sbSelectStrict<{ plan: string | null }>(
    "app_users",
    `select=plan&email=eq.${encodeURIComponent(email)}&limit=1`
  ).catch(() => ({ error: "unavailable" as const }));
  if ("error" in read) return read.error === "missing" ? "absent" : "unknown";
  if (!read.rows.length) return "absent";
  return normalizePlan(read.rows[0]?.plan);
}

// PayPal webhook: signature-verified subscription lifecycle -> plan grants.
// Configure in PayPal -> Developer Dashboard -> Apps & Credentials -> your app
// -> Webhooks, with the URL https://<your-domain>/api/webhooks/paypal and the
// events BILLING.SUBSCRIPTION.ACTIVATED / .CANCELLED / .EXPIRED / .SUSPENDED /
// .RE-ACTIVATED (+ PAYMENT.SALE.COMPLETED for renewals). Paste the resulting
// Webhook ID as PAYPAL_WEBHOOK_ID. Without it every call is rejected as
// unverified, so a plan is NEVER granted from an unsigned request.
export async function POST(req: Request) {
  const raw = await req.text();
  const webhookId = await getConfig("PAYPAL_WEBHOOK_ID");

  // Fail closed: if the webhook id is set, an unverifiable call is rejected.
  const verified = webhookId ? await verifyPaypalWebhook(req.headers, raw) : false;
  if (webhookId && !verified) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  // NOT CONFIGURED IS NOT "OK". Answering 200 here told PayPal the event was
  // delivered, so the one retry channel the billing system has was consumed
  // by a deploy that could not verify anything - the event was gone for good.
  // 503 makes PayPal retry (with backoff, for days) into a deploy where the
  // doctor HAS registered the id. The event is still recorded first, so the
  // owner can see what has been knocking.
  if (!webhookId) {
    let evtType = "unparseable";
    let evtId = "";
    try {
      const b = JSON.parse(raw) as { event_type?: string; id?: string };
      evtType = String(b?.event_type ?? "unknown");
      evtId = String(b?.id ?? "");
    } catch {
      /* recorded as unparseable */
    }
    await sbInsert("billing_events", [
      { provider_event_id: evtId || null, type: `pp_unconfigured_${evtType}`, verified: false },
    ]).catch(() => {});
    return NextResponse.json(
      { error: "PAYPAL_WEBHOOK_ID is not configured - retry after setup" },
      { status: 503 }
    );
  }

  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const event = String(body?.event_type ?? "");
  const resource = body?.resource ?? {};
  // custom_id (subscription events) / custom (sale events) MAY carry
  // "email|plan" - a checkout created elsewhere can set it. Subscriptions
  // created by our own button do not, so it is a hint, not the answer.
  //
  // Only the EMAIL half is read at all. The plan half used to be a fallback for
  // `tier`, which meant a subscription to a plan we never sold - one the
  // attacker created in their own PayPal account for a cent - could name its
  // own tier and be redeemed as Ultra. The tier now comes from PayPal's plan id
  // (or from asking PayPal about the subscription) and from nowhere else.
  const customId = String(resource.custom_id ?? resource.custom ?? "");
  const hintEmail = String(customId.split("|")[0] ?? "").trim().toLowerCase();

  // Capture the funding source when PayPal reports it (V2-6 wallet adoption):
  // card / apple_pay / google_pay / paypal_balance. Best-effort - the field
  // location varies by event type, so read the common shapes.
  const fundingSource =
    resource?.payment_source && typeof resource.payment_source === "object"
      ? Object.keys(resource.payment_source)[0]
      : (resource?.subscriber?.payment_source
          ? Object.keys(resource.subscriber.payment_source)[0]
          : undefined);
  await sbInsert("billing_events", [
    {
      provider_event_id: String(body?.id ?? ""),
      type: `pp_${event}`,
      verified,
      ...(fundingSource ? { funding_source: fundingSource } : {}),
    },
  ]).catch(() => {});

  const activates = [
    "BILLING.SUBSCRIPTION.ACTIVATED",
    "BILLING.SUBSCRIPTION.RE-ACTIVATED",
    "PAYMENT.SALE.COMPLETED",
  ].includes(event);

  // WHO does this subscription belong to?
  //
  // A PAYMENT.SALE.COMPLETED resource's `id` is the SALE id, not the
  // subscription - the subscription is `billing_agreement_id`. Reading `id`
  // first made every renewal unattributable. So a sale reads the agreement id
  // first; every other event reads the subscription `id` first.
  const isSale = event === "PAYMENT.SALE.COMPLETED";
  const subscriptionId = String(
    (isSale
      ? resource.billing_agreement_id ?? resource.id
      : resource.id ?? resource.billing_agreement_id) ?? ""
  ).trim();

  // The TRUSTED attribution is our own verified activation record
  // (`subscriberFor`), which is written ONLY by the server-side confirm flow
  // for a subscription an authenticated traveller actually claimed. `custom_id`
  // is attacker-settable: a raw PayPal checkout can carry "victim@|pro".
  //
  //   - DOWNGRADES trust the verified link ONLY. Without one we do not act - the
  //     reconcile sweep still catches a genuinely-lapsed subscriber.
  //   - GRANTS may bootstrap from the hint for a subscription NOBODY has claimed
  //     yet (the redirect checkout, where the traveller may never return to the
  //     app and the webhook is the only thing that can apply what they paid
  //     for). A hint can never RE-POINT a subscription that is already linked,
  //     and - see the grant branch - it can never LOWER a plan either.
  //
  // WHY THE SECOND HALF OF THAT MATTERS. Splitting the two channels was not
  // enough on its own: `setPlan` OVERWRITES, so the same grant that lifts a free
  // account to Pro drops an Ultra account to Pro. An attacker whose own real
  // Pro subscription carried "victim@|pro" therefore reached, through the GRANT
  // branch, exactly the downgrade the DOWNGRADE branch refuses them - which is
  // why a grant is now a raise-only operation for every caller.
  const linked = subscriptionId ? await subscriberFor(subscriptionId) : null;
  // A hint is only ever an email address; anything else is not attribution.
  const hintUsable = !linked && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(hintEmail);
  const grantEmail = linked || (hintUsable ? hintEmail : "");
  const hintDriven = !linked && Boolean(grantEmail);
  const downgradeEmail = linked || "";

  // WHICH tier? PayPal's plan id is the authority, matched against the plan ids
  // the owner configured - never the caller's custom_id (see above).
  const planId = String(resource.plan_id ?? "");
  let tier = planId ? await tierForPaypalPlan(planId) : null;

  // A renewal (PAYMENT.SALE.COMPLETED) names the subscription but not the plan,
  // so ask PayPal directly rather than letting a paying traveller's renewal be
  // a no-op if their tier had been cleared.
  if (!tier && activates && subscriptionId) {
    const { fetchPaypalSubscription } = await import("@/lib/paypal");
    const sub = await fetchPaypalSubscription(subscriptionId).catch(() => null);
    if (sub?.planId) tier = await tierForPaypalPlan(sub.planId);
  }

  // Only grant from a VERIFIED event (the sole trusted grant path).
  if (verified && grantEmail && activates && tier) {
    const email = grantEmail;
    // A GRANT MAY ONLY EVER RAISE. Read the account first and compare on the
    // plan ladder: over-granting a tier somebody did not buy costs the owner
    // money and nobody else anything, while LOWERING a tier on the strength of
    // an attacker-settable hint is the account takeover this whole route is
    // written around. When the hint names an account that already has a
    // subscription of its own, this is the rule that saves it - the attacker's
    // Pro event simply does not move an Ultra subscriber.
    //
    // A deliberate downgrade still works, from the two places that have real
    // evidence for it: the in-app confirm flow (session-authenticated, PayPal
    // consulted server-side) and the CANCELLED/EXPIRED branch below.
    const before = await currentPlanFor(email);
    if (before === "unknown") {
      // We cannot prove this is a raise. Refuse, and let PayPal redeliver into
      // a moment when the database answers - the same fail-closed trade the
      // rest of this route makes.
      console.error(`[paypal] plan unreadable for ${email}; asking PayPal to retry`);
      return NextResponse.json({ error: "plan unreadable" }, { status: 503 });
    }
    if (before === "absent") {
      // Nothing to grant to, and a retry cannot conjure an account: record it so
      // the owner can find a payment that has no home (a mistyped checkout, or a
      // hint aimed at nobody) instead of making PayPal retry for days.
      await sbInsert("billing_events", [
        {
          provider_event_id: String(body?.id ?? "") || null,
          type: `pp_grant_no_account_${tier}`,
          verified: true,
        },
      ]).catch(() => {});
      return NextResponse.json({ ok: true });
    }
    if (PLAN_RANK[tier] <= PLAN_RANK[before]) {
      // Not a raise - leave the account exactly as it is. Recorded because a
      // refused grant is also how an attempted hint attack looks from here.
      await sbInsert("billing_events", [
        {
          provider_event_id: String(body?.id ?? "") || null,
          type: `pp_grant_not_raised_${tier}${hintDriven ? "_hint" : ""}`,
          verified: true,
        },
      ]).catch(() => {});
    } else {
      // A WEBHOOK IS THE LAST LINE - NOBODY IS WATCHING IT. There is no traveller
      // on the other end of this request to notice that the grant did not land,
      // so a failed write has to leave a trace the owner can actually find.
      // PayPal retries a non-2xx delivery, which is the recovery we want here.
      const granted = await setPlan(email, tier).catch(() => false);
      if (!granted) {
        await sbInsert("billing_events", [
          { type: `plan_grant_failed_${tier}`, verified: true, provider_event_id: String(body?.id ?? "") || null },
        ]).catch(() => {});
        console.error(`[paypal] setPlan failed for ${email} -> ${tier}; asking PayPal to retry`);
        return NextResponse.json({ error: "grant failed" }, { status: 503 });
      }
      // THE MONEY TRAIL HAS TO NAME THE PAYER.
      //
      // This branch is the redirect checkout where the traveller never returns
      // to the app, so the webhook is the ONLY thing that applies what they
      // paid for. It wrote `setPlan` and a billing_events row - and
      // billing_events has no user_email column at all (schema.sql), so a
      // genuine paying customer left no attributable record anywhere and the
      // monetization panel counted them as COMPED. Write the same
      // subscription-activated row the returning-traveller path writes; it is
      // the one record in this system that means money changed hands AND names
      // the person, and both the funnel and the reconcile sweep read it.
      //
      // `verified` distinguishes it honestly: this grant was authenticated as
      // a PayPal webhook and its tier came from PayPal's own plan id, but a
      // hint-driven one was attributed from a custom_id rather than a link the
      // traveller proved.
      await sbInsert("agent_events", [
        {
          kind: ACTIVATION_KIND,
          user_email: email,
          vendor_id: "",
          vendor_name: "",
          detail: JSON.stringify({
            subscriptionId: subscriptionId || null,
            planId: planId || null,
            tier,
            source: "paypal-webhook",
            hintDriven,
            eventId: String(body?.id ?? "") || null,
          }).slice(0, 800),
        },
      ]).catch(() => {});
      // A hint-driven grant is worth seeing on its own: it is the one plan
      // change in this app with no verified link behind it.
      if (hintDriven) {
        await sbInsert("billing_events", [
          {
            provider_event_id: String(body?.id ?? "") || null,
            type: `pp_hint_grant_${tier}`,
            verified: true,
          },
        ]).catch(() => {});
      }
    }
    // Payment recovered - end any open grace window so a LATER suspension
    // starts its own clock instead of inheriting an expired one.
    //
    // LINKED SUBSCRIPTIONS ONLY. This writes the traveller's email against a
    // subscription id; doing it from a hint would let an attacker file their own
    // subscription under a victim's name in our own evidence trail - the exact
    // durable link the hint path is forbidden to create.
    if (linked && subscriptionId && clearsSuspension(event)) {
      await markSubscriptionState(RESUMED_KIND, { email, subscriptionId });
    }
  } else if (verified && downgradeEmail) {
    const email = downgradeEmail;
    // A SUSPENSION IS NOT A CANCELLATION. PayPal suspends for a recoverable
    // payment failure and retries over about a week, sending RE-ACTIVATED when
    // the money lands - so treating it like a cancellation dropped a paying
    // traveller's agents mid-hunt and handed them back two days later with no
    // explanation of either event. A cancellation is a decision and takes
    // effect at once; a suspension gets the window.
    const suspendedSince = subscriptionId
      ? await suspendedSinceFor(subscriptionId).catch(() => null)
      : null;
    const effect = effectForEvent(event, { suspendedSince, now: Date.now() });
    if (effect === "downgrade") {
      const downgraded = await setPlan(email, "free").catch(() => false);
      if (!downgraded) {
        console.error(`[paypal] downgrade to free failed for ${email}; asking PayPal to retry`);
        return NextResponse.json({ error: "downgrade failed" }, { status: 503 });
      }
    } else if (effect === "grace" && subscriptionId && !suspendedSince) {
      // First sight: start the clock, keep the tier. A repeat SUSPENDED event
      // must not restart it, which is why the record is only written when there
      // is not one already.
      await markSubscriptionState(SUSPENDED_KIND, { email, subscriptionId });
    }
  } else if (verified && (activates || subscriptionId)) {
    // A VERIFIED event we could not pin to a TRUSTED account. This now also
    // covers a downgrade whose only attribution was an unverified custom_id
    // hint (deliberately refused above) - money or a cancellation may be moving
    // with nobody safely attributed, so the reconcile sweep and the owner need
    // to be able to find these. The shrug leaves a durable, queryable trace
    // instead of dissolving into the generic pp_* row above, and instead of
    // acting on a hint we do not trust.
    await sbInsert("billing_events", [
      {
        provider_event_id: String(body?.id ?? "") || null,
        type: `pp_unattributed_${event || "unknown"}`,
        verified: true,
      },
    ]).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}

export const maxDuration = 60;
