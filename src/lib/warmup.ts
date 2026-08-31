// THE WARM-UP GATE - a paid plan cannot be BOUGHT until the account has done
// enough real work for us to know Premium fits.
//
// This replaces the cancelled 50% introductory quarter (plan C.0.2). A discount
// pays people to tolerate a warm-up; a gate makes them want to finish one. The
// paid tier becomes something earned rather than something on sale, and the
// user always sees exactly how far away it is.
//
// THE UNIT IS USAGE DEPTH, NOT CALENDAR DAYS, AND THAT DISTINCTION IS THE WHOLE
// FEATURE.
//
// The first draft of this (plan Part 11 F3) required seven days since linking.
// That is wrong for this product in a way that would not have shown up as a bug:
// our users are travellers, a large share search for a bike on the day they land
// and are done with the app inside 72 hours. A seven-day clock hides the paywall
// behind a window longer than the entire trip, so the modal buyer never sees a
// purchasable Premium at all - and the symptom is "conversion is low", not "the
// door is shut".
//
// So every term below is something a committed traveller can satisfy within an
// hour, and a tyre-kicker never satisfies at all.
//
// FAIL DIRECTION - deliberately the opposite of the safety reads.
//
// Everywhere else in this codebase an unreadable Supabase read DENIES, because
// the thing being guarded is someone's phone number. Here the thing being
// guarded is our own revenue quality, and the costs are asymmetric the other
// way: refusing a sale to someone who HAS earned it (and who may be on the only
// afternoon they will ever use this app) is far worse than admitting one buyer
// we were not certain about. So an unreadable predicate resolves to WARM.
//
// The stamp makes that exposure small: once `warmed_up_at` is written it is
// never recomputed, so the unreadable case can only ever affect users who have
// not yet crossed the line once.

import "server-only";
import { getConfig, sbSelectStrict, sbUpdate } from "./runtime-config";
import { nationalTail } from "./wa/phone-key";
import { isRealHunt } from "./session-life";

export interface WarmupTerm {
  /** Stable id - the admin dashboard groups stalled users by this. */
  id: "searches" | "engaged" | "replies" | "linked";
  label: string;
  have: number;
  need: number;
  done: boolean;
}

export interface WarmupStatus {
  warmed: boolean;
  /** Set once, never moved - the moment the predicate first passed. */
  warmedAt?: number;
  terms: WarmupTerm[];
  /** How many terms are still open. 0 means warm. */
  remaining: number;
  /** True when a term could not be read and we admitted on the doubt. */
  unreadable: boolean;
  /** Exempt from the gate entirely (test mode, owner). */
  exempt: boolean;
  /**
   * In the measurement holdout - allowed to buy without warming up.
   *
   * Reported to the SERVER so the funnel can segment on it. It must never reach
   * a user-facing string: a control group that knows it is a control group is
   * not a control group.
   */
  holdout: boolean;
}

// Thresholds are owner-tunable from Admin -> Keys so the gate can be loosened
// or tightened against real cohort data without a redeploy. These defaults are
// a starting position, not a claim: the number that says whether they are right
// is p90 time-to-warm on the monetization dashboard, and if that exceeds a
// typical trip the gate is too tight.
export const WARMUP_DEFAULTS = {
  WARMUP_MIN_SEARCHES: 1,
  WARMUP_MIN_ENGAGED: 3,
  WARMUP_MIN_REPLIES: 1,
} as const;

async function threshold(name: keyof typeof WARMUP_DEFAULTS): Promise<number> {
  const raw = Number(await getConfig(name));
  return Number.isFinite(raw) && raw >= 0 ? raw : WARMUP_DEFAULTS[name];
}

/**
 * The gate's LIVE thresholds, for surfaces that explain the gate.
 *
 * The monetization panel's stall buckets used to hard-code `< 3` and `< 1`
 * while the gate card on the same screen printed these owner-configured
 * values, so loosening the gate from Keys made the two halves of one screen
 * describe different rules. Anything that reports on the gate reads it here.
 */
export async function warmupThresholds(): Promise<{
  minSearches: number;
  minEngaged: number;
  minReplies: number;
}> {
  const [minSearches, minEngaged, minReplies] = await Promise.all([
    threshold("WARMUP_MIN_SEARCHES"),
    threshold("WARMUP_MIN_ENGAGED"),
    threshold("WARMUP_MIN_REPLIES"),
  ]);
  return { minSearches, minEngaged, minReplies };
}

/** Owner switch. "off" disables the gate and every plan is purchasable. */
export async function warmupGateOn(): Promise<boolean> {
  const v = ((await getConfig("WARMUP_GATE")) ?? "").trim().toLowerCase();
  // Unset means ON. A gate that quietly disengages because a config row is
  // missing is the same failure family as the kill switch that turned itself
  // off, and the fix is the same: absence must not mean disabled.
  return v !== "off" && v !== "0" && v !== "false";
}

/**
 * Distinct agencies this traveller actually reached, and how many wrote back.
 *
 * Read from the tail-canonicalised recipient ledger, NOT from a send count and
 * NOT from `response_times`. Both alternatives are wrong for this: a send count
 * rewards spraying rather than engaging, and `response_times` anchors its clock
 * to the global first-ever outbound, so a shop first contacted three weeks ago
 * that answers in two minutes records a three-week sample and never corrects.
 */
async function engagement(
  email: string
): Promise<{ engaged: number; replied: number; unreadable: boolean }> {
  const read = await sbSelectStrict<{ to_tail: string | null; to_number: string; first_reply_at: string | null }>(
    "wa_recipient_state",
    `select=to_tail,to_number,first_reply_at&sender_key=eq.${encodeURIComponent(
      email
    )}&first_intro_at=not.is.null&limit=500`
  );
  if ("error" in read) {
    // "missing" is a fresh install with no table - genuinely zero, not unknown.
    return { engaged: 0, replied: 0, unreadable: read.error === "unavailable" };
  }
  // One shop, one row - but legacy rows written before `to_tail` existed carry
  // only the raw number, so canonicalise on read too or the same shop counts
  // twice and the gate opens early.
  const seen = new Set<string>();
  const answered = new Set<string>();
  for (const r of read.rows) {
    const key = r.to_tail || nationalTail(r.to_number) || r.to_number;
    if (!key) continue;
    seen.add(key);
    if (r.first_reply_at) answered.add(key);
  }
  return { engaged: seen.size, replied: answered.size, unreadable: false };
}

/**
 * How many real hunts this traveller has run.
 *
 * THIS READ USED TO POINT AT A TABLE NOTHING WRITES, AND IT CLOSED THE PAYWALL
 * AGAINST EVERY USER.
 *
 * `search_sessions` is declared in schema.sql with `status` and `closed_at`
 * columns and has exactly two references in the entire repository - this
 * function and `lifecycleReport()`. Both are READS. Nothing has ever inserted a
 * row. Because the table EXISTS, `sbSelectStrict` returned `{rows: []}` rather
 * than `{error: "missing"}`, so this reported a confident `n: 0` with
 * `unreadable: false` - the one shape the fail-warm rule above cannot rescue.
 *
 * The consequence was total and silent: `completedSearches >= 1` was
 * permanently false, so `/api/billing/checkout` 403'd every non-tester with
 * "unlock it by using the app a little more first", `UpgradeSheet` rendered the
 * locked state forever, and a traveller who had run ten searches and collected
 * five replies still saw "Searches run 0/1". The product could not take money,
 * and the failure looked exactly like poor conversion.
 *
 * `searches` is the table that is really written (/api/vendors on every hunt),
 * filtered through the shared `isRealHunt` discriminator so a bare request
 * build - which /api/profile also records here - cannot buy someone a plan.
 */
async function searchCount(email: string): Promise<{ n: number; unreadable: boolean }> {
  const read = await sbSelectStrict<{ id: number; source: string | null }>(
    "searches",
    `select=id,source&user_email=eq.${encodeURIComponent(email)}&limit=100`
  );
  if ("error" in read) return { n: 0, unreadable: read.error === "unavailable" };
  return { n: read.rows.filter((r) => isRealHunt(r.source)).length, unreadable: false };
}

async function whatsappLinked(email: string): Promise<{ linked: boolean; unreadable: boolean }> {
  const read = await sbSelectStrict<{ status: string | null }>(
    "wa_sessions",
    `select=status&email=eq.${encodeURIComponent(email)}&limit=1`
  );
  if ("error" in read) return { linked: false, unreadable: read.error === "unavailable" };
  const status = read.rows[0]?.status ?? "";
  return { linked: status === "open" || status === "connected", unreadable: false };
}

/** The stamp, read on its own so a missing column cannot break user lookup. */
async function readStamp(email: string): Promise<number | undefined> {
  const read = await sbSelectStrict<{ warmed_up_at: string | null }>(
    "app_users",
    `select=warmed_up_at&email=eq.${encodeURIComponent(email)}&limit=1`
  );
  if ("error" in read) return undefined;
  const at = read.rows[0]?.warmed_up_at;
  return at ? Date.parse(at) : undefined;
}

/**
 * Write-once. A later threshold change must not un-warm somebody who already
 * crossed the line, and re-stamping would destroy time-to-warm as a measure.
 */
async function stamp(email: string, terms: WarmupTerm[]): Promise<void> {
  await sbUpdate(
    "app_users",
    `email=eq.${encodeURIComponent(email)}&warmed_up_at=is.null`,
    {
      warmed_up_at: new Date().toISOString(),
      // The predicate AS IT STOOD at unlock, so moving a threshold later does
      // not rewrite history on the cohort charts.
      warmup_snapshot: Object.fromEntries(terms.map((t) => [t.id, t.have])),
    }
  ).catch(() => false);
}

export async function warmupStatus(email: string): Promise<WarmupStatus> {
  const allWarm = (reason: Partial<WarmupStatus> = {}): WarmupStatus => ({
    warmed: true,
    terms: [],
    remaining: 0,
    unreadable: false,
    exempt: false,
    holdout: false,
    ...reason,
  });

  if (!(await warmupGateOn())) return allWarm({ exempt: true });

  // Testers and the owner allowlist must never be gated, or beta testers cannot
  // test the paid tiers at all - which is the one thing they exist to do.
  try {
    const { isTestUser } = await import("./allowlist");
    if (await isTestUser(email)) return allWarm({ exempt: true });
  } catch {
    /* allowlist unavailable - fall through to the predicate */
  }

  // THE HOLDOUT. Without a population that can buy immediately, "the gate
  // improves conversion" is unfalsifiable forever - every number you read
  // afterwards is equally consistent with the gate helping, hurting, or doing
  // nothing. Ships at 0%; the owner turns it on to measure.
  //
  // `exempt` stays FALSE here on purpose. Exempt means "the gate does not apply
  // to this account" (testers, owner) and those rows must be excluded from the
  // funnel entirely. A holdout user is a real customer on the control arm and
  // has to stay in the denominator.
  const { inWarmupHoldout } = await import("./cohort");
  if (await inWarmupHoldout(email)) return allWarm({ holdout: true });

  const already = await readStamp(email);
  if (already) return allWarm({ warmedAt: already });

  const [minSearches, minEngaged, minReplies] = await Promise.all([
    threshold("WARMUP_MIN_SEARCHES"),
    threshold("WARMUP_MIN_ENGAGED"),
    threshold("WARMUP_MIN_REPLIES"),
  ]);
  const [searches, eng, link] = await Promise.all([
    searchCount(email),
    engagement(email),
    whatsappLinked(email),
  ]);

  const terms: WarmupTerm[] = [
    {
      id: "linked",
      label: "WhatsApp connected",
      have: link.linked ? 1 : 0,
      need: 1,
      done: link.linked,
    },
    {
      id: "searches",
      label: "Searches run",
      have: searches.n,
      need: minSearches,
      done: searches.n >= minSearches,
    },
    {
      id: "engaged",
      label: "Shops reached",
      have: eng.engaged,
      need: minEngaged,
      done: eng.engaged >= minEngaged,
    },
    {
      // A number nobody has ever answered is not a warmed-up number - it is a
      // number accumulating exactly the signal that gets accounts restricted.
      // This term is carried over from the days-based draft unchanged, because
      // its justification never depended on the clock.
      id: "replies",
      label: "Shops that replied",
      have: eng.replied,
      need: minReplies,
      done: eng.replied >= minReplies,
    },
  ];

  const unreadable = searches.unreadable || eng.unreadable || link.unreadable;
  const remaining = terms.filter((t) => !t.done).length;
  if (unreadable) {
    // Admit on the doubt - see the fail-direction note at the top. Do NOT stamp:
    // a guess must not become a permanent record.
    return { warmed: true, terms, remaining, unreadable: true, exempt: false, holdout: false };
  }

  const warmed = remaining === 0;
  if (warmed) await stamp(email, terms);
  return {
    warmed,
    warmedAt: warmed ? Date.now() : undefined,
    terms,
    remaining,
    unreadable: false,
    exempt: false,
    holdout: false,
  };
}

/**
 * The one-line progress phrase the upgrade surface shows.
 *
 * Rules the copy holds to: always show the distance (a gate with no visible
 * progress reads as a bug), never imply the user did something wrong, and never
 * say we are evaluating them. The subject is always the product getting ready.
 *
 * RETURNS A TEMPLATE AND A NUMBER, NOT A FINISHED SENTENCE. `t()` has no
 * interpolation, so a sentence built here by concatenating a count onto a
 * fragment would be untranslatable and would break under RTL, where the number
 * and the words do not sit in the same order. The client translates the whole
 * sentence - placeholder included - and substitutes afterwards. Every template
 * below is a literal catalogue entry.
 */
export interface WarmupProgress {
  template: string;
  n: number;
}

export function warmupProgressLine(status: WarmupStatus): WarmupProgress | null {
  if (status.warmed) return null;
  const open = status.terms.filter((t) => !t.done);
  if (!open.length) return null;
  // Linking is the one term that is a prerequisite rather than a quantity, so
  // it is always named first - otherwise the user is told to reach shops by an
  // app that cannot message anyone yet.
  const next = open.find((t) => t.id === "linked") ?? open[0];
  const gap = Math.max(0, next.need - next.have);
  switch (next.id) {
    case "linked":
      return { template: "Connect WhatsApp to get started.", n: 0 };
    case "replies":
      return gap === 1
        ? { template: "One shop reply away.", n: 1 }
        : { template: "{n} shop replies away.", n: gap };
    case "searches":
      return gap === 1
        ? { template: "One search away.", n: 1 }
        : { template: "{n} searches away.", n: gap };
    default:
      return gap === 1
        ? { template: "One more shop away.", n: 1 }
        : { template: "{n} more shops away.", n: gap };
  }
}
