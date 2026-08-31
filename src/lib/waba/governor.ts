// THE GOVERNOR - four budgets, one admission, and it fails closed in every
// direction. Plan Part 12.2.1.
//
// `admitLead` in leads.ts answers "which lane may this agency use". This module
// answers the question above it: "may we send AT ALL right now". They are
// separate because they fail differently - a lane decision is per-agency and
// recoverable, while these four are fleet-wide and a mistake degrades an asset
// every user shares at once.
//
//   B1 per-agency template cooldown  - in leads.ts (it is a lane concern)
//   B2 portfolio tier budget         - unique recipients contacted per 24h
//   B3 quality-rating governor       - the early warning before a restriction
//   B4 spend ceiling                 - a runaway loop on per-message pricing is
//                                      a financial incident, not a bug
//
// admit = min(B2, B3, B4), the same shape as `newContactBudget`'s Math.min in
// wa-guard, deliberately, so the two governors read alike.
//
// WHY B2 IS MUCH WEAKER THAN IT LOOKS, and why that matters.
//
// The messaging tier caps UNIQUE RECIPIENTS contacted OUTSIDE a service window
// per rolling 24h - not messages, and not window traffic. Our recipients are
// agencies, a small shared set that a district exhausts in the tens. So the tier
// is rarely the binding constraint; B1 and B3 are. An earlier reading of this
// plan counted travellers rather than agencies and concluded the official
// platform allowed "about 6 searches a day company-wide", which was wrong by
// two orders of magnitude and nearly killed the design on paper.

import "server-only";
import { getConfig, sbSelectStrict } from "../runtime-config";

export type QualityRating = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";

export interface GovernorVerdict {
  allowed: boolean;
  /** Which budget bound. Rendered verbatim in the console. */
  binding: "tier" | "quality" | "spend" | "kill-switch" | null;
  headroom: {
    tierRemaining: number | null;
    spendRemainingUsd: number | null;
    quality: QualityRating;
  };
  /** True when a budget could not be read and we refused on the doubt. */
  unreadable: boolean;
  reason: string;
}

export const TIER_DEFAULT_UNIQUE_PER_DAY = 250; // unverified starting tier

async function num(key: string, fallback: number): Promise<number> {
  const raw = Number(await getConfig(key));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Read template-lane lead rows from the last 24h, EXCLUDING dry runs.
 *
 * A rehearsal is not a send: the platform never saw it, so it must not spend
 * tier or dollars here - rehearsing against 200 agencies used to consume the
 * entire day's real budget. `dry_run=not.is.true` keeps rows where the column
 * is false OR null; null (pre-column rows) counts as real, which errs toward
 * throttling - the safe direction on a rented asset. On an un-migrated DB the
 * filter itself fails the read, so the query RETRIES without it (createLead's
 * pattern) rather than holding the whole lane closed on a pending ALTER.
 */
async function templateLeads24h(
  select: string,
  now: number
): Promise<{ rows: Record<string, unknown>[]; unreadable: boolean }> {
  const since = new Date(now - 24 * 3600_000).toISOString();
  const base = `select=${select}&lane=eq.template&sent_at=gte.${encodeURIComponent(since)}&limit=5000`;
  const read = await sbSelectStrict<Record<string, unknown>>(
    "waba_leads",
    `${base}&dry_run=not.is.true`
  );
  if (!("error" in read)) return { rows: read.rows, unreadable: false };
  const legacy = await sbSelectStrict<Record<string, unknown>>("waba_leads", base);
  if (!("error" in legacy)) return { rows: legacy.rows, unreadable: false };
  return { rows: [], unreadable: legacy.error === "unavailable" };
}

/**
 * Unique agencies templated in the last 24h.
 *
 * Counts DISTINCT agency tails on template-lane leads only. Free-form sends
 * inside a window do not count against the tier, so including them would make
 * the governor throttle on traffic the platform does not meter - the exact
 * mistake that produced the "6 searches a day" conclusion.
 */
async function uniqueRecipients24h(
  now: number
): Promise<{ count: number; unreadable: boolean }> {
  const read = await templateLeads24h("agency_tail", now);
  return {
    count: new Set(read.rows.map((r) => r.agency_tail as string)).size,
    unreadable: read.unreadable,
  };
}

/** Templates sent today, for the spend estimate. */
async function templatesToday(now: number): Promise<{ n: number; unreadable: boolean }> {
  const read = await templateLeads24h("id", now);
  return { n: read.rows.length, unreadable: read.unreadable };
}

/**
 * The quality rating, as last reported by the provider.
 *
 * On a RENTED WABA this is not a metric, it is an existential asset: the
 * provider's portfolio hosts our number and a complaint spike ends the account
 * with someone else's decision. So RED stops sending entirely rather than
 * throttling, and UNKNOWN is treated as a reason to be careful rather than as
 * permission.
 */
export async function qualityRating(): Promise<QualityRating> {
  const raw = ((await getConfig("WABA_QUALITY_RATING")) ?? "").trim().toUpperCase();
  return raw === "GREEN" || raw === "YELLOW" || raw === "RED" ? raw : "UNKNOWN";
}

export async function governorVerdict(now = Date.now()): Promise<GovernorVerdict> {
  // The manual stop, checked first and honoured absolutely. Its absence means
  // running - unlike the send flag, because this one exists to be flipped in an
  // incident and a config wobble must not silently re-arm sending.
  const kill = ((await getConfig("WABA_KILL")) ?? "").trim().toLowerCase();
  if (kill === "on" || kill === "1" || kill === "true") {
    return {
      allowed: false,
      binding: "kill-switch",
      headroom: { tierRemaining: null, spendRemainingUsd: null, quality: "UNKNOWN" },
      unreadable: false,
      reason: "Sending is stopped by the owner switch.",
    };
  }

  const [tierCap, spendCap, perTemplateUsd, quality] = await Promise.all([
    num("WABA_TIER_UNIQUE_PER_DAY", TIER_DEFAULT_UNIQUE_PER_DAY),
    num("WABA_DAILY_SPEND_CEILING_USD", 0),
    num("WABA_TEMPLATE_COST_USD", 0.05),
    qualityRating(),
  ]);

  const [unique, templates] = await Promise.all([uniqueRecipients24h(now), templatesToday(now)]);
  const unreadable = unique.unreadable || templates.unreadable;

  // FAIL CLOSED. Opposite direction from the warm-up gate and for the opposite
  // reason: there the cost of a wrong refusal was a lost sale, here the cost of
  // a wrong send is quality rating on an account we rent and cannot replace.
  if (unreadable) {
    return {
      allowed: false,
      binding: null,
      headroom: { tierRemaining: null, spendRemainingUsd: null, quality },
      unreadable: true,
      reason: "Could not read the sending budgets - holding until they are readable.",
    };
  }

  if (quality === "RED") {
    return {
      allowed: false,
      binding: "quality",
      headroom: { tierRemaining: tierCap - unique.count, spendRemainingUsd: null, quality },
      unreadable: false,
      reason: "Quality rating is RED - first contact is paused until it recovers.",
    };
  }

  const tierRemaining = tierCap - unique.count;
  if (tierRemaining <= 0) {
    return {
      allowed: false,
      binding: "tier",
      headroom: { tierRemaining: 0, spendRemainingUsd: null, quality },
      unreadable: false,
      reason: "Daily unique-recipient tier reached.",
    };
  }

  // Spend is only bounded when a ceiling is set. An unset ceiling is not
  // "unlimited by accident" - it is the owner not having chosen one yet, and
  // the console says so rather than silently reporting infinite headroom.
  let spendRemainingUsd: number | null = null;
  if (spendCap > 0) {
    spendRemainingUsd = spendCap - templates.n * perTemplateUsd;
    if (spendRemainingUsd <= 0) {
      return {
        allowed: false,
        binding: "spend",
        headroom: { tierRemaining, spendRemainingUsd: 0, quality },
        unreadable: false,
        reason: "Daily spend ceiling reached.",
      };
    }
  }

  return {
    allowed: true,
    binding: null,
    headroom: { tierRemaining, spendRemainingUsd, quality },
    unreadable: false,
    // YELLOW is allowed to send but is worth saying out loud: it is the early
    // warning, and the owner should see it before it becomes RED.
    reason: quality === "YELLOW" ? "Sending, but quality is YELLOW - watch it." : "OK",
  };
}
