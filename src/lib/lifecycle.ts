// THE MONETIZATION AND LIFECYCLE VIEW - who converts, who is stuck, and where.
//
// The product had no answer to that question. `admin/analytics` reports volume
// (searches, messages, spend) and `admin/users` lists accounts; neither can say
// how many people reached the point of being able to pay, how long it took, or
// what stopped the rest. Shipping a gate without this would be shipping a
// decision we could not evaluate.
//
// TWO DESIGN RULES, BOTH LEARNED THE HARD WAY IN THIS REPO.
//
// 1. FAIL DARK, NEVER FAIL GREEN. Nine reads in admin/command each ended in
//    `.catch(() => [])`, so an unreachable database produced zero alerts and a
//    green Command Center - the owner's primary attention surface reporting
//    "nothing wrong" as its failure mode. Every read here returns `null` on an
//    unavailable database and the caller renders a dark tile. A funnel that
//    silently reads all-zeros during an outage is worse than no funnel: it
//    looks like a collapse in signups.
//
// 2. BOUNDED READS. `/api/activity` costs ~21 Supabase round trips per tick and
//    at fleet scale a live fan-out monitor becomes the load it monitors. This
//    module makes a fixed small number of reads regardless of user count, and
//    is called from an admin route a human opens - not a poller.

import "server-only";
import { sbSelectStrict } from "./runtime-config";
import { isRealHunt } from "./session-life";
import { ACTIVATION_KIND } from "./billing/subscription-link";

/** `null` means UNREADABLE - render dark, never as zero. */
export type Maybe<T> = T | null;

export interface FunnelStage {
  id: string;
  label: string;
  count: Maybe<number>;
  /**
   * Share of SIGNUPS, 0-1. Null when either side is dark.
   *
   * WAS "conversion from the previous stage", AND THE STAGES DO NOT NEST.
   * A traveller can run a search without linking WhatsApp, and every beta
   * invitee is granted a plan without paying - so dividing each row by the one
   * above it produced percentages like "Ran a search 175%" and "Paid 600%" on
   * the owner's live screen. A ratio over 100% is not a conversion rate, it is
   * a sign the denominator was wrong. Signups is the one population every row
   * is genuinely a subset of.
   */
  ofSignups: Maybe<number>;
}

export interface StallTerm {
  id: string;
  label: string;
  /** Non-warm users whose FIRST unmet term is this one. */
  stuck: number;
}

export interface LifecycleReport {
  generatedAt: number;
  stages: FunnelStage[];
  warm: {
    total: Maybe<number>;
    last7d: Maybe<number>;
    /** Hours from signup to unlock. The number that says if the gate is right. */
    medianHours: Maybe<number>;
    p90Hours: Maybe<number>;
  };
  /** Where the non-warm population is stuck, by first unmet term. */
  stalls: Maybe<StallTerm[]>;
  holdout: {
    size: Maybe<number>;
    converted: Maybe<number>;
    /** Gated arm, for the comparison the holdout exists to make. */
    gatedSize: Maybe<number>;
    gatedConverted: Maybe<number>;
  };
  /** Which reads came back unreadable, so the UI can name them. */
  degraded: string[];
}

type Row = Record<string, unknown>;

/**
 * One strict read, mapped to `null` on unavailable.
 *
 * "missing" is NOT dark: a table that has never been created on a fresh install
 * is vacuously empty, and treating that as an outage would make every new
 * deployment look broken.
 */
async function rows(
  table: string,
  query: string,
  degraded: string[],
  label: string
): Promise<Maybe<Row[]>> {
  const read = await sbSelectStrict<Row>(table, query);
  if ("error" in read) {
    if (read.error === "unavailable") {
      degraded.push(label);
      return null;
    }
    return [];
  }
  return read.rows;
}

const pct = (num: Maybe<number>, den: Maybe<number>): Maybe<number> =>
  num === null || den === null || den === 0 ? null : num / den;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i];
}

export async function lifecycleReport(): Promise<LifecycleReport> {
  const degraded: string[] = [];
  const now = Date.now();
  const weekAgo = new Date(now - 7 * 864e5).toISOString();

  // Five bounded reads. Each answers one stage of the funnel; none of them
  // fans out per user.
  const [users, linked, searches, engaged, activations] = await Promise.all([
    rows(
      "app_users",
      "select=email,plan,added_at,warmed_up_at&limit=5000",
      degraded,
      "signups"
    ),
    rows("wa_sessions", "select=email,status&limit=5000", degraded, "whatsapp links"),
    // `searches`, not `search_sessions`. The latter is declared in schema.sql
    // and has never been written by anything - so this stage of the funnel
    // reported a flat zero for every cohort, which is also exactly what the
    // warm-up gate saw when it decided nobody was allowed to buy a plan.
    // `source` comes back so a bare request build does not count as a hunt.
    rows(
      "searches",
      "select=user_email,source&limit=20000",
      degraded,
      "searches"
    ),
    rows(
      "wa_recipient_state",
      "select=sender_key,first_reply_at&first_intro_at=not.is.null&limit=20000",
      degraded,
      "shop engagement"
    ),
    // VERIFIED PAYMENTS. `subscription-activated` is written by
    // /api/subscriptions/paypal-success AFTER asking PayPal, server-side with
    // the secret, what the subscription really is - so it is the one record in
    // this system that means MONEY CHANGED HANDS, and it names the traveller.
    rows(
      "agent_events",
      // ACTIVATION_KIND, not a duplicated literal: the writer
      // (/api/subscriptions/paypal-success) and this reader must never be able
      // to drift apart on the one string that decides what counts as revenue.
      `select=user_email&kind=eq.${ACTIVATION_KIND}&limit=5000`,
      degraded,
      "verified payments"
    ),
  ]);
  // "PAID" USED TO MEAN "HAS A PAID PLAN COLUMN", WHICH IS NOT THE SAME THING.
  //
  // The old count read app_users.plan, whose comment argued that the column is
  // what grants entitlements - true, and irrelevant to a revenue funnel. Every
  // beta invitee is PINNED to their invited plan at login (allowlist ->
  // setPlan) without paying anything, so on the owner's live screen this row
  // read "Paid 6" against zero actual customers. A monetization panel that
  // invents six paying users is worse than one that shows none.
  //
  // Split, so both facts are visible and neither is a lie: PAID counts
  // verified PayPal activations; COMPED counts plan grants with no payment
  // behind them (invites and testers), which is genuinely useful - it is the
  // size of the free-riding cohort.

  const linkedSet = new Set(
    (linked ?? [])
      .filter((r) => r.status === "open" || r.status === "connected")
      .map((r) => String(r.email ?? "").toLowerCase())
  );
  // Same discriminator the gate and the restore use: opening the request panel
  // is not running a hunt, and counting it here would report a funnel stage
  // people had not actually reached.
  const searchers = new Set(
    (searches ?? [])
      .filter((r) => isRealHunt(r.source as string | null))
      .map((r) => String(r.user_email ?? "").toLowerCase())
  );

  const reachedBy = new Map<string, number>();
  const repliedBy = new Map<string, number>();
  for (const r of engaged ?? []) {
    const k = String(r.sender_key ?? "").toLowerCase();
    if (!k) continue;
    reachedBy.set(k, (reachedBy.get(k) ?? 0) + 1);
    if (r.first_reply_at) repliedBy.set(k, (repliedBy.get(k) ?? 0) + 1);
  }

  const signups = users === null ? null : users.length;
  const nLinked = linked === null ? null : linkedSet.size;
  const nSearched = searches === null ? null : searchers.size;
  const nReached = engaged === null ? null : reachedBy.size;
  const nReplied = engaged === null ? null : repliedBy.size;
  const nWarm = users === null ? null : users.filter((u) => u.warmed_up_at).length;
  // Distinct travellers with at least one VERIFIED activation. An unreadable
  // read stays null (dark), never zero - the same fail-dark rule every other
  // row here follows.
  const nPaid =
    activations === null
      ? null
      : new Set(
          (activations ?? [])
            .map((r) => String(r.user_email ?? "").trim().toLowerCase())
            .filter(Boolean)
        ).size;
  // Plan grants WITHOUT a verified payment: invites and TEST_MODE testers.
  const paidEmails = new Set(
    (activations ?? [])
      .map((r) => String(r.user_email ?? "").trim().toLowerCase())
      .filter(Boolean)
  );
  const nComped =
    users === null || activations === null
      ? null
      : users.filter(
          (u) =>
            (u.plan === "pro" || u.plan === "business" || u.plan === "ultra") &&
            !paidEmails.has(String(u.email ?? "").trim().toLowerCase())
        ).length;

  // EVERY ROW AS A SHARE OF SIGNUPS. The stages do not nest (see FunnelStage),
  // so a from-the-row-above ratio produced >100% percentages that read as
  // impossible conversion rates.
  const stages: FunnelStage[] = [
    { id: "signup", label: "Signed up", count: signups, ofSignups: null },
    { id: "linked", label: "Linked WhatsApp", count: nLinked, ofSignups: pct(nLinked, signups) },
    { id: "searched", label: "Ran a search", count: nSearched, ofSignups: pct(nSearched, signups) },
    { id: "reached", label: "Reached a shop", count: nReached, ofSignups: pct(nReached, signups) },
    { id: "replied", label: "Got a reply", count: nReplied, ofSignups: pct(nReplied, signups) },
    { id: "warm", label: "Warmed up", count: nWarm, ofSignups: pct(nWarm, signups) },
    { id: "paid", label: "Paid (verified)", count: nPaid, ofSignups: pct(nPaid, signups) },
    { id: "comped", label: "Comped (invite/tester)", count: nComped, ofSignups: pct(nComped, signups) },
  ];

  // TIME TO WARM - the single number that says whether the thresholds are set
  // correctly. Measured in HOURS, not days, because the product's whole
  // lifecycle is often shorter than a day: a days axis would round most of the
  // distribution to zero and hide exactly the variation we need to see. If p90
  // exceeds a typical trip, the gate is too tight and should be loosened from
  // this screen.
  let medianHours: Maybe<number> = null;
  let p90Hours: Maybe<number> = null;
  let warmLast7d: Maybe<number> = null;
  if (users !== null) {
    const durations: number[] = [];
    let recent = 0;
    for (const u of users) {
      const at = u.warmed_up_at ? Date.parse(String(u.warmed_up_at)) : NaN;
      if (!Number.isFinite(at)) continue;
      if (String(u.warmed_up_at) >= weekAgo) recent += 1;
      const from = u.added_at ? Date.parse(String(u.added_at)) : NaN;
      if (Number.isFinite(from) && at >= from) durations.push((at - from) / 3600_000);
    }
    warmLast7d = recent;
    if (durations.length) {
      durations.sort((a, b) => a - b);
      medianHours = Math.round(quantile(durations, 0.5) * 10) / 10;
      p90Hours = Math.round(quantile(durations, 0.9) * 10) / 10;
    }
  }

  // WHERE THE NON-WARM POPULATION IS STUCK, by FIRST unmet term.
  //
  // First-unmet rather than any-unmet, because a user missing three terms is
  // blocked by one of them - the earliest - and counting them in all three
  // buckets would make every bucket look equally broken and point at nothing.
  // This is the chart that changes what you work on next: mass failure on
  // "linked" is an onboarding problem, mass failure on "reached" means the
  // threshold is wrong.
  let stalls: Maybe<StallTerm[]> = null;
  if (users !== null && linked !== null && searches !== null && engaged !== null) {
    const buckets: Record<string, number> = { linked: 0, searches: 0, engaged: 0, replies: 0 };
    for (const u of users) {
      if (u.warmed_up_at) continue;
      const e = String(u.email ?? "").toLowerCase();
      if (!linkedSet.has(e)) buckets.linked += 1;
      else if (!searchers.has(e)) buckets.searches += 1;
      else if ((reachedBy.get(e) ?? 0) < 3) buckets.engaged += 1;
      else if ((repliedBy.get(e) ?? 0) < 1) buckets.replies += 1;
    }
    stalls = [
      { id: "linked", label: "Has not connected WhatsApp", stuck: buckets.linked },
      { id: "searches", label: "Connected, never searched", stuck: buckets.searches },
      { id: "engaged", label: "Searched, too few shops reached", stuck: buckets.engaged },
      { id: "replies", label: "Reached shops, none replied yet", stuck: buckets.replies },
    ];
  }

  // THE HOLDOUT COMPARISON. Membership is recomputed from the same deterministic
  // bucket the gate uses, so the arms are exactly the populations that were
  // treated differently - no separate membership table to drift out of sync.
  let holdout: LifecycleReport["holdout"] = {
    size: null,
    converted: null,
    gatedSize: null,
    gatedConverted: null,
  };
  if (users !== null) {
    const { cohortDecision, WARMUP_HOLDOUT } = await import("./cohort");
    let hSize = 0;
    let hPaid = 0;
    let gSize = 0;
    let gPaid = 0;
    for (const u of users) {
      const email = String(u.email ?? "");
      if (!email) continue;
      const isPaid = u.plan === "pro" || u.plan === "business" || u.plan === "ultra";
      const d = await cohortDecision(WARMUP_HOLDOUT, email);
      if (d.member) {
        hSize += 1;
        if (isPaid) hPaid += 1;
      } else {
        gSize += 1;
        if (isPaid) gPaid += 1;
      }
    }
    holdout = { size: hSize, converted: hPaid, gatedSize: gSize, gatedConverted: gPaid };
  }

  return {
    generatedAt: now,
    stages,
    warm: { total: nWarm, last7d: warmLast7d, medianHours, p90Hours },
    stalls,
    holdout,
    degraded,
  };
}
