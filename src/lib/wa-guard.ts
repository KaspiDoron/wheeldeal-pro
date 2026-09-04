// Anti-Ban & AI Humanization Engine.
//
// WhatsApp's spam detection scores accounts on a few well-known vectors:
//   1. Velocity          - many first-contact messages in a short window
//   2. Content uniformity - identical/near-identical payloads (hash matching)
//   3. One-way blasts     - lots of outbound, few replies (no engagement)
//   4. Session anomalies  - sending at 3 AM recipient-time, instant sends with
//                           no "composing" presence, robotic fixed intervals
//   5. New-number bursts  - fresh numbers doing volume before earning trust
//
// This module addresses each vector with a database-driven policy layer:
//   - Dynamic reputation: `whatsapp_number_reputation` tracks a 0-100 Trust
//     Score per sender; the hourly cap SCALES with trust (replies earn trust,
//     pure outbound decays it). New numbers start on a warm-up budget.
//   - Engagement halt: no automated follow-up to a number until that number
//     has replied since our last outbound (two-way validation).
//   - Business hours: sends outside the recipient's local daytime window are
//     queued in `wa_outbox` and drained when the window opens.
//   - Content variance: every automated payload is passed through a semantic
//     variator so no two messages hash the same.
//   - All knobs live in `whatsapp_security_policies` - the owner tunes delays,
//     caps, scoring weights and hours from the DB without a redeploy.

import "server-only";
import {
  sbSelect,
  sbSelectStrict,
  sbInsert,
  sbUpdate,
  sbDelete,
  getConfig,
  pgTimestamp,
} from "./runtime-config";
import { parseFlag } from "./config-flags";
import type { SendResult } from "./wa/transport";
import { policyRowValue } from "./wa/policy-values";
import {
  resolveOffset,
  nextBusinessOpen,
  clampToBusinessHours,
  boundHold,
  recipientLocalHour,
} from "./wa/business-hours";
import {
  jitteredHold,
  pauseRecheckAt,
  HARD_MIN_GAP_SEC,
  RECIPIENT_LOCK_SEC,
} from "./wa/pacing";
import { clampRestampToWave } from "./wa/waves";
// THE APPEND-ONLY RISK LEDGER (Tier 3). Every hook below is best-effort and
// `noteRisk` cannot throw, so telemetry can never be the reason a send fails.
import { noteRisk } from "./wa/risk-events";
import { digitsOnly } from "./phone";
import { numberFilter, waDigits, lidKey, nationalTail, outboxKey, identityKey } from "./wa/phone-key";
import { outboxToKeyPatch } from "./wa/outbox-columns";
import {
  claimOutboxRow,
  releaseOutboxRow,
  completeOutboxRow,
  MAX_DUP_HOLDS,
  type OutboxMeta,
  type OutboxRow,
} from "./wa/outbox-lifecycle";
import { personaHumanize } from "./wa/persona";
// W4.7 - the greeting definition, shared with the orchestrator's validator.
import { stripLeadingGreeting } from "./copy/greeting";
import { stealthFactor } from "./wa/stealth";
import { stripWaFormatting } from "./text";
import { tableReady } from "./schema-probe";
import { PACING_PRESETS, normalizePacingMode } from "./wa/pacing-mode";
import {
  planCapacity,
  effectiveNewContactCap,
  warmupNewContactFactor,
  effectiveHourCap,
  warmupFactor,
  nextIntroSlotIso,
} from "./wa/capacity";

// ---------------------------------------------------------------------------
// Policies - DB-driven control panel with safe defaults
// ---------------------------------------------------------------------------

export interface SecurityPolicies {
  base_hour_cap: number;        // messages/hour at trust 0
  max_hour_cap: number;         // messages/hour at trust 100
  day_cap: number;              // absolute per-day ceiling
  min_gap_seconds: number;      // min seconds between two sends (jittered up)
  gap_jitter_seconds: number;   // random extra gap 0..N
  reply_gap_seconds: number;    // per-engaged-shop min gap for REPLIES (tighter 3-7s lane)
  warmup_days: number;          // days a new number stays on half budget
  business_hour_start: number;  // recipient local hour (0-23)
  business_hour_end: number;    // recipient local hour (0-23)
  trust_reply_gain: number;     // trust points per inbound reply
  trust_send_decay: number;     // trust points lost per outbound with no reply
  engagement_halt: boolean;     // require a reply before the next auto message
  presence_min_ms: number;      // composing simulation floor
  presence_max_ms: number;      // composing simulation ceiling
  idle_pause_hours: number;     // hours without app activity before the user's
                                // WA session goes quiet (presence unavailable)
  // ---- Anti-Ban v2 knobs ----
  max_new_contacts_per_day: number; // cold first-contacts/day (biggest signal)
  min_reply_rate: number;           // below this (with enough samples) new
                                    // cold outreach is frozen
  min_reply_samples: number;        // sends needed before reply-rate matters
  risk_pause_threshold: number;     // ban-risk score (0-100) that auto-pauses
  risk_pause_minutes: number;       // how long an auto-pause lasts
  burst_window_seconds: number;     // rolling window for burst detection
  burst_max_in_window: number;      // max sends in that window before a rest
  burst_cooldown_minutes: number;   // enforced rest after a burst
  require_number_on_whatsapp: boolean; // validate the number exists on WA first
  daily_cap_jitter_pct: number;     // ± random daily-cap wobble (anti-pattern)
  ignore_business_hours: boolean;   // 24/7 dial: lift the recipient business-hours CLOCK gate for COLD intros (the whole clamp is cold-only - replies are exempt by the isNewContact gate). PACING_MODE=fast turns this on.
  fast_dispatch: boolean;           // owner directive: new users must dispatch their whole intro batch within ~10 min. Lifts BOTH the clock gate AND the Google "closed now" park for COLD intros, so a search fires immediately regardless of shop hours (the message waits unread until the shop opens). Config FAST_DISPATCH; DEFAULT ON.
}

const DEFAULTS: SecurityPolicies = {
  base_hour_cap: 4,
  max_hour_cap: 14,
  // Daily ceiling: a hard backstop against a runaway loop, NOT the per-session
  // limit. Cold introductions are separately bounded by the plan's newContacts
  // budget (24/window on ultra); the bulk of a busy day is REPLIES to shops that
  // messaged first (safe). 220 comfortably covers a full session of intros +
  // multi-round negotiation + a follow-up session, while still capping the
  // absolute worst case. The reply-rate breaker + risk pause are the real
  // behavioural guards.
  day_cap: 220,
  // Fast, human-jittered spacing: 12-28s between sends. A full ultra budget of
  // 24 conversations clears in ~6-9 min; free (10) in ~3 min; pro (20) in
  // ~6 min. Perfectly-regular intervals are a bot signature, so the jitter is
  // as important as the floor. This is the single strongest ban lever - raise
  // both numbers (DB override) if a number ever shows soft-restriction signs.
  min_gap_seconds: 12,
  gap_jitter_seconds: 16,
  // REPLY lane: replies to an ALREADY-ENGAGED shop (a two-way conversation the
  // shop started - low ban-risk) pace at ~5s per shop instead of the 12s cold
  // min-gap, so the back-and-forth feels responsive (the "3-7s response lane").
  // Cold first-contacts keep min_gap_seconds - velocity to NEW numbers is the
  // real ban vector, and the atomic fleet ceiling + stop-loss still apply.
  // Owner-tunable via a whatsapp_security_policies row `reply_gap_seconds`.
  reply_gap_seconds: 5,
  warmup_days: 7,
  // Wide default window (8-21): real rental shops open early and close late.
  // Google "open now" (shopOpenNow) is the primary truth when the client has
  // it; this clock window only gates sends when openNow is unknown.
  business_hour_start: 8,
  business_hour_end: 21,
  trust_reply_gain: 6,
  trust_send_decay: 1,
  engagement_halt: true,
  presence_min_ms: 2500,
  presence_max_ms: 8000,
  idle_pause_hours: 6,
  // OFF BY DEFAULT, AND THAT IS THE DESIGN, NOT AN OVERSIGHT.
  //
  // A fixed 15-a-day cold ceiling is the OLD capacity model. wa/capacity.ts
  // opens by explaining why it was replaced: crushed by the warm-up ramp it
  // gave a fresh number about two shops for a whole day and then parked
  // everything "until tomorrow morning" - the "I can only message a few shops
  // before it all postpones" report. The rolling per-plan window replaced it
  // precisely so capacity refreshes continuously instead of hitting a daily
  // wall.
  //
  // The knob was dead when that default was written, so 15 cost nothing. Wave
  // D wired it up - correctly, a control rendered on a safety panel must do
  // something - and in doing so silently reinstated the very model this
  // codebase had already decided against, binding every plan above free to a
  // ceiling far below its own window.
  //
  // 0 means "no extra ceiling": the plan window, the warm-up ramp and the two
  // unanswered meters remain the operative limits, as designed. The knob stays
  // live for an owner who wants to clamp the fleet during an incident, which is
  // what an absolute daily ceiling is genuinely good for.
  max_new_contacts_per_day: 0,
  min_reply_rate: 0.15,
  min_reply_samples: 8,
  risk_pause_threshold: 70,
  risk_pause_minutes: 240,
  // Burst guard aligned to the first-session blast: a new user firing their full
  // ultra budget of 24/window must NOT trip a freeze after the 5th send (the
  // old 5/600s -> 30-min cooldown was the single hardest blocker of the owner's
  // "let them use their whole limit fast" goal). The min-gap already prevents
  // robotic rapid-fire; this only catches a pathological flood well above any
  // plan budget.
  burst_window_seconds: 600,
  burst_max_in_window: 45,
  burst_cooldown_minutes: 30,
  require_number_on_whatsapp: true,
  daily_cap_jitter_pct: 20,
  // Default OFF: cold intros still respect the recipient's business hours at
  // night. PACING_MODE=fast (or a DB override) flips this to send the whole
  // 40-intro burst NOW regardless of hour - the owner's explicit 24/7 dial.
  ignore_business_hours: false,
  // DEFAULT OFF, as of the owner's speed-vs-safety decision.
  //
  // It shipped ON, to dispatch the whole intro batch within ~10 minutes at any
  // hour. That is the single largest behavioural risk on the cold lane:
  // unsolicited first-contact traffic at 03:00 local is the pattern WhatsApp
  // meters for restrictions, and it buys the traveller nothing - a message sent
  // to a closed shop at 3am is READ at 9am either way. The only thing the night
  // send changes is our risk profile.
  //
  // Cold introductions now wait for the recipient's business hours. Agent
  // REPLIES skip this clamp entirely - since owner report 3 the whole block is
  // gated on `isNewContact`, closing the gap where a reply re-guarded more
  // than 30 minutes after the shop's last inbound parked until morning
  // (reciprocal traffic is the side WhatsApp does not meter).
  //
  // Set FAST_DISPATCH=on in Admin -> Keys to restore 24/7 cold dispatch.
  fast_dispatch: false,
};

declare global {
  // eslint-disable-next-line no-var
  var __wd_wa_policies__: { at: number; value: SecurityPolicies } | undefined;
  // The LAST-GOOD policy set, no TTL: what the owner's dials actually resolved
  // to the last time storage answered. Survives as long as the instance does.
  // eslint-disable-next-line no-var
  var __wd_wa_policies_lastgood__: SecurityPolicies | undefined;
  // The last successfully READ pacing-mode string, so a config blip holds the
  // owner's chosen mode instead of silently reverting to "balanced".
  // eslint-disable-next-line no-var
  var __wd_wa_pacing_raw__: string | null | undefined;
}

export async function getPolicies(): Promise<SecurityPolicies> {
  const cached = globalThis.__wd_wa_policies__;
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const [rowsRes, modeRaw, fastRaw] = await Promise.all([
    sbSelectStrict<{ key: string; value: string }>(
      "whatsapp_security_policies",
      // Ordered + generous limit: with the old bare limit=50, junk rows could
      // non-deterministically push a real override past the cut.
      "select=key,value&order=key.asc&limit=200"
    ),
    // A read that THROWS holds the last mode the owner was known to have set;
    // a read that succeeds (even as "unset") updates that memory. Without the
    // distinction, one config blip on a "cautious" fleet silently re-armed
    // balanced pacing - the policy layer failing OPEN toward looser defaults.
    getConfig("PACING_MODE").then(
      (v) => {
        globalThis.__wd_wa_pacing_raw__ = v ?? null;
        return v;
      },
      () => globalThis.__wd_wa_pacing_raw__
    ),
    getConfig("FAST_DISPATCH").catch(() => undefined),
  ]);
  // THE FAIL DIRECTION OF THE WHOLE POLICY LAYER (owner report 3, 3.4 #5).
  // sbSelect used to collapse an outage to [] - indistinguishable from "the
  // owner set no overrides" - so every dial (a cautious preset, a lowered day
  // cap, a longer warm-up) evaporated for exactly the 60s cache window,
  // repeatedly, whenever Supabase wobbled. Now:
  //   unavailable + last-good  -> serve the last policies that actually
  //                               resolved (the owner's dials, remembered);
  //   unavailable + no memory  -> the CAUTIOUS preset. A fresh instance that
  //                               cannot read the owner's dials must err
  //                               toward safety, not toward the mid-band.
  //   "missing" (never migrated) -> vacuously no overrides: honest defaults.
  if (!("rows" in rowsRes) && rowsRes.error === "unavailable") {
    const lastGood = globalThis.__wd_wa_policies_lastgood__;
    const value: SecurityPolicies = lastGood ?? {
      ...DEFAULTS,
      ...(PACING_PRESETS.cautious as Partial<SecurityPolicies>),
      ignore_business_hours: false,
      fast_dispatch: false,
    };
    // Cache briefly so a broken store is not hammered; NOT stored as
    // last-good - this value is a stance, not a reading.
    globalThis.__wd_wa_policies__ = { at: Date.now(), value };
    return value;
  }
  const rows = "rows" in rowsRes ? rowsRes.rows : [];
  // Layer order: hard DEFAULTS -> owner speed/safety preset -> explicit DB rows.
  const mode = normalizePacingMode(modeRaw);
  // FAST_DISPATCH defaults OFF (owner's speed-vs-safety decision) - one shared
  // flag dialect, and an UNREADABLE spelling keeps the default rather than
  // silently flipping. That direction matters more now than it did: a config
  // read that fails must not hand cold outreach a 24/7 licence.
  const fastDispatch = parseFlag(fastRaw, DEFAULTS.fast_dispatch);
  const merged: SecurityPolicies = {
    ...DEFAULTS,
    ...(PACING_PRESETS[mode] as Partial<SecurityPolicies>),
    // FAST is the owner's "send the whole burst NOW, any hour" dial - lift the
    // recipient business-hours clamp for cold intros (replies already skip it).
    // fast_dispatch (default ON) additionally lifts the Google "closed now" park
    // so a new user's whole batch fires within ~10 min regardless of shop hours.
    ignore_business_hours: mode === "fast" || fastDispatch,
    fast_dispatch: fastDispatch,
  };
  for (const r of rows) {
    const k = r.key as keyof SecurityPolicies;
    if (!(k in DEFAULTS)) continue;
    // The policy-values contract owns coercion: flags accept both dialects
    // (the old `=== "true"` turned a row spelled "on" into FALSE, silently
    // re-arming the business-hours park against the owner's own dial), and
    // numbers outside their sane range are ignored rather than applied.
    (merged as unknown as Record<string, unknown>)[k] = policyRowValue(
      r.key,
      r.value,
      (merged as unknown as Record<string, boolean | number>)[k]
    );
  }
  // Cross-field sanity: an inverted or degenerate hours window would turn
  // every hour of the day into "closed". Fall back to the shipped window.
  if (merged.business_hour_start >= merged.business_hour_end) {
    merged.business_hour_start = DEFAULTS.business_hour_start;
    merged.business_hour_end = DEFAULTS.business_hour_end;
  }
  globalThis.__wd_wa_policies__ = { at: Date.now(), value: merged };
  globalThis.__wd_wa_policies_lastgood__ = merged;
  return merged;
}

/** Remove a policy override row so the code default applies again. */
export async function deletePolicy(key: string): Promise<void> {
  await sbDelete(
    "whatsapp_security_policies",
    `key=eq.${encodeURIComponent(key)}`
  );
  globalThis.__wd_wa_policies__ = undefined;
}

/**
 * Write an anti-ban knob, and RECORD THAT IT MOVED.
 *
 * This used to be a bare upsert with no version, no author, no previous value
 * and no undo - while negotiation policy next door is versioned, golden-replay
 * gated and one-click rollbackable. The rigour was on the decision whose worst
 * case is a bad haggle, and absent from the decision whose worst case is a
 * traveller losing their personal WhatsApp (plan Part 5.9).
 *
 * `author` is optional so the signature stays compatible with every existing
 * caller; an unattributed change still records, because a change with no name
 * on it is still infinitely more useful than no record at all.
 */
export async function setPolicy(
  key: string,
  value: string,
  author?: string | null,
  note?: string
): Promise<void> {
  // Read the CURRENT value before overwriting it. Without `from`, the audit row
  // says what the knob became and not what it was, which is the half that makes
  // a revert possible and a before/after comparison meaningful.
  const rows = await sbSelect<{ id: number; value: string }>(
    "whatsapp_security_policies",
    `select=id,value&key=eq.${encodeURIComponent(key)}&limit=1`
  );
  const previous = rows[0]?.value ?? null;
  if (rows[0]?.id) {
    await sbUpdate("whatsapp_security_policies", `id=eq.${rows[0].id}`, { value });
  } else {
    await sbInsert("whatsapp_security_policies", [{ key, value }]);
  }
  globalThis.__wd_wa_policies__ = undefined;
  if (previous !== value) {
    const { recordPolicyChange, isSafetyPolicy } = await import("./wa/policy-versions");
    if (isSafetyPolicy(key)) {
      await recordPolicyChange({ key, from: previous, to: value }, author ?? null, note);
    }
  }
}

// ---------------------------------------------------------------------------
// Reputation - dynamic trust per sender (keyed by user email = one WA number)
// ---------------------------------------------------------------------------

export interface Reputation {
  id?: number;
  sender_key: string;
  trust_score: number;
  sent_total: number;
  replies_total: number;
  last_send_at: string | null;
  created_at?: string;
  blocks_total?: number;
  fails_total?: number;
  reads_total?: number;
  delivered_total?: number;
  new_contacts_today?: number;
  new_contacts_date?: string | null;
  last_reply_at?: string | null;
  paused_until?: string | null;
  /** Cold-intro lane held after a WhatsApp error ack on a first contact. */
  cold_hold_until?: string | null;
  /** Numbers that are not on WhatsApp. A listing-quality fact, NOT a block. */
  invalid_numbers_total?: number;
  /** Receipt liveness: distinguishes "idle" from "the receipt pipeline died". */
  last_delivery_receipt_at?: string | null;
  last_read_receipt_at?: string | null;
  risk_score?: number;
}

const REP_COLS =
  "id,sender_key,trust_score,sent_total,replies_total,last_send_at,created_at," +
  "blocks_total,fails_total,reads_total,delivered_total,new_contacts_today," +
  "new_contacts_date,last_reply_at,paused_until,cold_hold_until,risk_score," +
  "invalid_numbers_total,last_delivery_receipt_at,last_read_receipt_at";

/**
 * STRICT reputation read for the guard: null means the truth is UNKNOWN
 * (transient DB failure) - the caller must fail CLOSED for automated sends.
 * The permissive getReputation() below silently returns a FRESH default on
 * failure, which would read a paused/burned number as brand-new and healthy.
 */
async function getReputationStrict(senderKey: string): Promise<Reputation | null> {
  const res = await sbSelectStrict<Reputation>(
    "whatsapp_number_reputation",
    `select=${REP_COLS}&sender_key=eq.${encodeURIComponent(senderKey)}&limit=1`
  );
  if ("error" in res) {
    // Missing table = un-migrated/demo: today's permissive path is correct.
    return res.error === "missing" ? getReputation(senderKey) : null;
  }
  if (res.rows[0]) return res.rows[0];
  // Genuinely empty: a brand-new sender - create the warm-up row.
  return getReputation(senderKey);
}

async function getReputation(senderKey: string): Promise<Reputation> {
  const rows = await sbSelect<Reputation>(
    "whatsapp_number_reputation",
    `select=${REP_COLS}&sender_key=eq.${encodeURIComponent(senderKey)}&limit=1`
  );
  if (rows[0]) return rows[0];
  const fresh: Reputation = {
    sender_key: senderKey,
    trust_score: 20, // new numbers start low and EARN volume
    sent_total: 0,
    replies_total: 0,
    last_send_at: null,
  };
  await sbInsert("whatsapp_number_reputation", [
    { ...fresh, created_at: new Date().toISOString() },
  ]);
  return fresh;
}

/** Account age in days (0 for a brand-new number). */
function ageDaysOf(rep: Reputation): number {
  return rep.created_at ? (Date.now() - Date.parse(rep.created_at)) / 86_400_000 : 0;
}

/**
 * Warm-up ramp for the SEND RATE (85% floor). Note: the ramp that matters for
 * ban risk is the NEW-CONTACT one below - the rate one only trims headroom.
 * The old comment here called this "the single biggest protection for a NEW
 * linked number", which was false twice over: the contact cap ignored age
 * entirely, and this factor bottomed at 0.85. See wa/capacity.ts.
 */
function warmupMultiplier(rep: Reputation, p: SecurityPolicies): number {
  return warmupFactor(ageDaysOf(rep), p.warmup_days);
}

/** Resolve a sender's plan (email = one WA number) for plan-tiered capacity. */
async function planForSender(senderKey: string): Promise<string> {
  try {
    const { getUser } = await import("./access");
    const u = await getUser(senderKey);
    return u?.plan ?? "free";
  } catch {
    return "free";
  }
}

/** Deterministic-per-day ±jitter so a fixed cap is not itself a pattern. */
function dailyCapJitter(senderKey: string, p: SecurityPolicies): number {
  const day = new Date().toISOString().slice(0, 10);
  let h = 0;
  const s = senderKey + day;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const frac = (h % 1000) / 1000; // 0..1 stable for the day
  const span = p.daily_cap_jitter_pct / 100;
  return 1 - span + frac * span * 2; // 1-span .. 1+span
}

/**
 * Hourly budget scales with trust, the warm-up ramp AND the plan (velocity
 * vector). A busy plan (Pro/Ultra) gets more headroom so replies + a paced
 * batch flow; a low-trust number still sits near the conservative base. The
 * 50-120s min-gap independently caps the true rate well below this.
 */
export function dynamicHourCap(rep: Reputation, p: SecurityPolicies, plan?: string): number {
  const t = Math.max(0, Math.min(100, rep.trust_score));
  const base = p.base_hour_cap + ((p.max_hour_cap - p.base_hour_cap) * t) / 100;
  return effectiveHourCap(plan ?? "free", base, ageDaysOf(rep), p.warmup_days);
}

/** New-shop introductions allowed per rolling window (plan x warm-up ramp).
 *  Day 0 starts at ~50% of the plan budget and earns to 100% over
 *  warmup_days, ACCELERATED by an observed reply rate - but only once there
 *  are enough samples for the rate to mean anything (the zero-send
 *  benefit-of-the-doubt 1.0 must not unlock the full budget on day 0). */
function newContactCap(rep: Reputation, p: SecurityPolicies, plan?: string): number {
  const measuredReplyRate =
    (rep.sent_total || 0) >= p.min_reply_samples ? replyRate(rep) : null;
  return effectiveNewContactCap(plan ?? "free", ageDaysOf(rep), p.warmup_days, measuredReplyRate);
}

/**
 * The lowest the warm-up ramp may push the DAILY ceiling.
 *
 * The ramp exists to keep a day-0 number quiet, and the cold-intro budget is
 * where that is actually enforced (5 new shops in a 6h window on free). This
 * ceiling covers ALL sends including replies, so ramping it to zero would mean
 * refusing to answer a shop that wrote to us - which looks broken to the
 * traveller AND hurts the reply ratio that keeps the number safe. 40/day is far
 * above the 10-20 a warm-up guide budgets for outbound, and far below the ~220
 * an aged number gets.
 */
const WARMUP_DAY_FLOOR = 40;

/** Lifetime reply rate (0..1) - the strongest health signal. */
function replyRate(rep: Reputation): number {
  const sent = rep.sent_total || 0;
  if (sent === 0) return 1;
  return Math.min(1, (rep.replies_total || 0) / sent);
}

export interface RiskBreakdown {
  score: number; // 0..100
  reasons: string[];
}

/**
 * Ban-risk score from real behaviour. High score => the number looks like an
 * automated spammer to WhatsApp's heuristics and must be throttled/paused.
 */
export function computeRisk(
  rep: Reputation,
  p: SecurityPolicies,
  recent?: {
    /** recipient_blocked events in the last 7 days (wa_risk_events). null =
     *  the ledger was unreadable; undefined = the caller did not measure. */
    blocks7d?: number | null;
  }
): RiskBreakdown {
  const reasons: string[] = [];
  let risk = 0;

  // 1. Low reply rate is THE dominant spam signal.
  if ((rep.sent_total || 0) >= p.min_reply_samples) {
    const rr = replyRate(rep);
    if (rr < p.min_reply_rate) {
      const add = Math.round(((p.min_reply_rate - rr) / p.min_reply_rate) * 45);
      risk += add;
      reasons.push(`low reply rate ${(rr * 100).toFixed(0)}% (+${add})`);
    }
  }
  // 2. Blocks/reports from recipients are catastrophic - measured over the
  //    LAST 7 DAYS, not a lifetime (owner report 3, 3.4 #9). blocks_total
  //    never decays, so two blocks from a bad batch last season scored +24
  //    forever - a number could never earn its way back, and a permanently
  //    elevated score both crowds out FRESH signals (the pause threshold was
  //    partly pre-spent) and trains the owner to ignore it. The windowed
  //    count comes from the append-only wa_risk_events ledger; the ABSOLUTE
  //    FLOOR stands - even one block inside the window scores +12, because a
  //    single real report is a person saying stop. When the ledger was
  //    unreadable (null) or unmeasured (undefined), the lifetime counter
  //    remains the CONSERVATIVE fallback: blindness must never lower a risk
  //    score.
  const blocks = typeof recent?.blocks7d === "number" ? recent.blocks7d : rep.blocks_total || 0;
  if (blocks > 0) {
    const add = Math.min(30, blocks * 12);
    risk += add;
    reasons.push(`${blocks} block/report in 7d (+${add})`);
  }
  // 3. Failed sends (invalid/non-WA numbers) look like list-blasting.
  if ((rep.fails_total || 0) >= 3) {
    const add = Math.min(15, (rep.fails_total || 0) * 3);
    risk += add;
    reasons.push(`${rep.fails_total} failed sends (+${add})`);
  }
  // 4. Delivered but never read => nobody engages (bot pattern).
  if ((rep.delivered_total || 0) >= 8) {
    const readRate = (rep.reads_total || 0) / (rep.delivered_total || 1);
    if (readRate < 0.3) {
      risk += 12;
      reasons.push(`low read rate ${(readRate * 100).toFixed(0)}% (+12)`);
    }
  }
  // 5. A brand-new number doing anything is inherently riskier.
  if (ageDaysOf(rep) < 1 && (rep.sent_total || 0) > 3) {
    risk += 10;
    reasons.push("new number sending on day 1 (+10)");
  }

  return { score: Math.max(0, Math.min(100, risk)), reasons };
}

/**
 * ONE ROW PER SHOP, WHATEVER SPELLING ARRIVED.
 *
 * This looked up `to_number=eq.<exact>`, and the two sides of a conversation do
 * not agree on that string: our send carries discovery's spelling, the shop's
 * reply carries WhatsApp's. So a reply routinely created a SECOND row rather
 * than updating the one the introduction wrote - and every reply-clearing rule
 * downstream was writing to a row nobody would ever read.
 *
 * `nationalTail` is the same tolerance the read-side `numberFilter` already
 * uses: country code and trunk prefix stripped, last 9 subscriber digits. Two
 * spellings of one shop always agree on it.
 *
 * The exact-match read stays as a FALLBACK so rows written before the tail
 * column existed are still found and adopted rather than duplicated.
 */
async function upsertRecipient(
  senderKey: string,
  toNumber: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  const tail = nationalTail(toNumber);
  const sender = encodeURIComponent(senderKey);

  let existing: { id: number } | undefined;
  if (tail) {
    const byTail = await sbSelect<{ id: number }>(
      "wa_recipient_state",
      `select=id&sender_key=eq.${sender}&to_tail=eq.${encodeURIComponent(tail)}&limit=1`
    );
    existing = byTail[0];
  }
  if (!existing) {
    const byExact = await sbSelect<{ id: number }>(
      "wa_recipient_state",
      `select=id&sender_key=eq.${sender}&to_number=eq.${encodeURIComponent(toNumber)}&limit=1`
    );
    existing = byExact[0];
  }

  // The write's own verdict is RETURNED (audit F013): sbUpdate/sbInsert answer
  // false rather than throwing, so a caller that discards this cannot tell a
  // landed stamp from a lost one - and the opt-out veto reads only what landed.
  if (existing?.id) {
    // Backfill the tail on the legacy row we just adopted, so the next write
    // finds it by tail and the duplicate never appears.
    return sbUpdate("wa_recipient_state", `id=eq.${existing.id}`, {
      ...(tail ? { to_tail: tail } : {}),
      ...patch,
    });
  }
  return sbInsert("wa_recipient_state", [
    { sender_key: senderKey, to_number: toNumber, ...(tail ? { to_tail: tail } : {}), ...patch },
  ]);
}

/**
 * PROCESS-LOCAL opted-out set (audit F013). The durable stamp is what every
 * instance reads; this is what THIS instance reads when the stamp did not
 * land (a PATCH 5xx, an 8s timedFetch abort). guardOutbound's veto consults it
 * beside the row read, so the turn that detected the stop - and everything the
 * drain or the reply tick sends from this instance afterwards - is refused
 * even with nothing durable to read. Keyed on the SHOP (identityKey), not the
 * spelling, so the outbox row's national number and the JID agree. Bounded,
 * because opt-outs are rare but a worker lives for weeks.
 */
const OPTED_OUT_LOCAL_CAP = 5000;

declare global {
  // eslint-disable-next-line no-var
  var __wd_opted_out_local__: Map<string, number> | undefined;
}

function optedOutLocal(): Map<string, number> {
  if (!globalThis.__wd_opted_out_local__) globalThis.__wd_opted_out_local__ = new Map();
  return globalThis.__wd_opted_out_local__;
}

function optedOutKey(senderKey: string, toNumber: string): string {
  return `${senderKey}|${identityKey(toNumber) || digitsOnly(toNumber)}`;
}

/** Has THIS instance seen this shop tell this sender to stop? */
export function optedOutLocally(senderKey: string, toNumber: string): boolean {
  return optedOutLocal().has(optedOutKey(senderKey, toNumber));
}

/**
 * The shop said "stop messaging me", and stop is FOREVER.
 *
 * Called from the inbound path when the deterministic opt-out detection fires
 * (lib/inbound-risk `detectOptOutIntent`). The stamp is what guardOutbound's
 * opt-out veto reads - once written, every future send to this number from
 * this sender is refused, manual sends and later hunts included. Write-once by
 * intent: re-stamping only moves a timestamp nobody compares.
 *
 * Degrades loudly: against a pre-migration database (no `opted_out_at` column)
 * the upsert fails, but the `wa-opt-out` event still records that the shop
 * asked - and the guard's column probe keeps its veto consistent with what the
 * database can actually answer.
 */
export async function markRecipientOptedOut(
  senderKey: string,
  toNumber: string,
  vendorName?: string
): Promise<boolean> {
  // 1. THIS instance refuses from memory, from this instant, whatever the
  //    store says - the half that closes the turn the stop arrived in.
  const local = optedOutLocal();
  local.set(optedOutKey(senderKey, toNumber), Date.now());
  if (local.size > OPTED_OUT_LOCAL_CAP) {
    const oldest = local.keys().next().value;
    if (oldest !== undefined) local.delete(oldest);
  }
  // 2. The durable stamp - what every OTHER instance's veto reads. ONE attempt
  //    here: this sits ahead of composition on the reply path.
  let persisted = false;
  try {
    persisted = await upsertRecipient(senderKey, toNumber, { opted_out_at: new Date().toISOString() });
  } catch {
    persisted = false;
  }
  // 3. The breadcrumb says what the veto can actually read (audit F013): a
  //    lost write used to leave an event asserting a refusal nothing enforced.
  const number = `+${digitsOnly(toNumber)}`;
  const event = (detail: string) =>
    sbInsert("agent_events", [
      {
        kind: "wa-opt-out",
        vendor_name: vendorName || digitsOnly(toNumber),
        user_email: senderKey,
        detail,
      },
    ]).catch(() => {});
  await event(
    persisted
      ? `${number} asked not to be messaged again - every future send to this number is refused.`
      : `${number} asked not to be messaged again - the opt-out stamp was NOT PERSISTED (the store refused the write); this instance refuses sends from memory and retries the stamp once.`
  );
  // 4. One deferred retry, OFF the reply path - never awaited by the caller,
  //    a short backoff, and its own breadcrumb when it lands so the trail
  //    stops at the truth.
  if (!persisted) {
    void (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const landed = await upsertRecipient(senderKey, toNumber, {
        opted_out_at: new Date().toISOString(),
      }).catch(() => false);
      if (landed) {
        await event(`${number} - the opt-out stamp persisted on retry; every future send to this number is refused.`);
      }
    })();
  }
  return persisted;
}

/**
 * Stamp a conversation milestone WITHOUT overwriting it.
 *
 * `first_intro_at` and `first_reply_at` are the denominator the introduction
 * budget should always have used - WhatsApp meters introductions that never got
 * an answer, not introductions sent. They are write-once by definition: the
 * second reply does not move the first, and re-stamping would silently reset
 * the age of an open thread.
 */
async function stampRecipientFirst(
  senderKey: string,
  toNumber: string,
  field: "first_intro_at" | "first_reply_at"
): Promise<void> {
  try {
    const tail = nationalTail(toNumber);
    const sender = encodeURIComponent(senderKey);
    const where = tail
      ? `sender_key=eq.${sender}&to_tail=eq.${encodeURIComponent(tail)}`
      : `sender_key=eq.${sender}&to_number=eq.${encodeURIComponent(toNumber)}`;
    const rows = await sbSelect<{ id: number; first_intro_at: string | null; first_reply_at: string | null }>(
      "wa_recipient_state",
      `select=id,first_intro_at,first_reply_at&${where}&limit=1`
    );
    const row = rows[0];
    if (row?.[field]) return; // already stamped - never move it
    await upsertRecipient(senderKey, toNumber, { [field]: new Date().toISOString() });
  } catch {
    /* a milestone is telemetry - it can never block a send or an ingest */
  }
}

/**
 * recipient_blocked events in the trailing 7 days, from the append-only
 * ledger. Returns null when the ledger cannot answer (unreadable OR never
 * migrated) - computeRisk then falls back to the lifetime counter, the
 * conservative direction.
 */
async function blocksInWindow(senderKey: string, days = 7): Promise<number | null> {
  const res = await sbSelectStrict<{ id: number }>(
    "wa_risk_events",
    `select=id&sender_key=eq.${encodeURIComponent(senderKey)}` +
      `&kind=eq.recipient_blocked&at=gte.${encodeURIComponent(
        new Date(Date.now() - days * 24 * 3600_000).toISOString()
      )}&limit=50`
  );
  return "rows" in res ? res.rows.length : null;
}

/** Persist reputation and recompute the ban-risk score (auto-pause on spike). */
/** The counters `wa_rep_bump` knows how to increment atomically. */
export type RepBumps = Partial<
  Record<
    | "sent_total"
    | "replies_total"
    | "blocks_total"
    | "fails_total"
    | "reads_total"
    | "delivered_total"
    | "invalid_numbers_total"
    | "new_contacts_today",
    number
  >
>;

// The atomic counter path degraded, and NOT for the expected missing-function
// reason. Throttled hard: this sits on the send path, and an event per send
// would bury the signal it exists to raise.
const REP_BUMP_DEGRADED_THROTTLE_MS = 15 * 60_000;
const repBumpDegradedAt = new Map<string, number>();

function noteRepBumpDegraded(senderKey: string): void {
  const last = repBumpDegradedAt.get(senderKey) ?? 0;
  const now = Date.now();
  if (now - last < REP_BUMP_DEGRADED_THROTTLE_MS) return;
  repBumpDegradedAt.set(senderKey, now);
  void sbInsert("agent_events", [
    {
      kind: "wa-rep-bump-degraded",
      detail: `${senderKey}: wa_rep_bump exists but refused the write - the safety counters fell back to the racy absolute path and will UNDERCOUNT under concurrency. Check the Supabase logs for the function's error (a non-integer value in p_set aborts the whole statement).`,
    },
  ]).catch(() => {});
}

/**
 * @param bumps  Counter DELTAS, applied in the database.
 *
 * THE GAUGE WAS READ-MODIFY-WRITE. Every safety counter used to be computed in
 * the app - read `sent_total`, add one, PATCH the absolute value back - so two
 * writers for the same sender both read N and both wrote N+1, and one increment
 * vanished. An inbound reply landing while an outbound send completes is not an
 * exotic race; it is what a 50-user beta produces continuously.
 *
 * These counters are the numerator and denominator of `computeRisk`, which
 * auto-pauses a number at the risk threshold, and of the delivery-rate breaker.
 * A gauge that silently under-counts is worse than no gauge, because it reads
 * healthy.
 *
 * `patch` keeps its meaning for last-write-wins fields - timestamps, and
 * `trust_score`, which is a smoothed score with its own decay rather than a
 * count: a lost trust update shifts one window's cap slightly and the next
 * event corrects it, where a lost COUNT is permanent.
 */
async function saveReputation(
  senderKey: string,
  patch: Partial<Reputation>,
  bumps?: RepBumps
): Promise<void> {
  const current = await getReputation(senderKey);
  // The risk calculation must see where the counters are GOING, not where they
  // were - otherwise the send that crosses the threshold is judged on the state
  // before it happened, and the pause arrives one event late.
  const projected: Reputation = { ...current, ...patch };
  for (const [k, d] of Object.entries(bumps ?? {})) {
    const key = k as keyof Reputation;
    projected[key] = ((Number(current[key]) || 0) + Number(d)) as never;
  }
  // A day roll resets the introduction counter rather than accumulating onto
  // yesterday's - the same rule wa_rep_bump applies server-side.
  if (
    bumps?.new_contacts_today !== undefined &&
    patch.new_contacts_date !== undefined &&
    patch.new_contacts_date !== current.new_contacts_date
  ) {
    projected.new_contacts_today = bumps.new_contacts_today;
  }
  const rep = projected;
  const p = await getPolicies();
  const risk = computeRisk(rep, p, { blocks7d: await blocksInWindow(senderKey) });
  const update: Record<string, unknown> = { ...patch, risk_score: risk.score };
  // Auto-pause a number that has crossed the danger line. The pause blocks all
  // automated sending and the owner is alerted from the command center.
  if (risk.score >= p.risk_pause_threshold) {
    const until = new Date(Date.now() + p.risk_pause_minutes * 60_000).toISOString();
    const already = rep.paused_until && Date.parse(rep.paused_until) > Date.now();
    if (!already) {
      update.paused_until = until;
      try {
        await sbInsert("agent_events", [
          {
            kind: "wa-ban-risk",
            detail: `${senderKey} auto-paused ${p.risk_pause_minutes}min - risk ${risk.score}: ${risk.reasons.join("; ")}`,
          },
        ]);
      } catch {
        /* best-effort */
      }
    }
  }
  if (bumps && Object.keys(bumps).length) {
    const { sbRpc } = await import("./runtime-config");
    const res = await sbRpc("wa_rep_bump", {
      p_sender: senderKey,
      p_bumps: bumps,
      p_set: update,
    });
    if (res.ok) return;
    // A 404 is a database where the owner has not re-run schema.sql yet. Fall
    // through to the old absolute write so an un-migrated deployment keeps
    // behaving exactly as it did - racy, but never silently dropping the
    // count. Any other failure falls through too: one lost increment beats a
    // write that does not happen at all.
    //
    // ...BUT THE TWO ARE NOT THE SAME NEWS, and until now nothing told them
    // apart - `sbRpc` returned a `missing` discriminator that its only caller
    // ignored. `missing` (404) is an expected, self-healing state that ends the
    // moment the owner runs the migration. Anything else means the atomic
    // function EXISTS and REFUSED, and OR8.1 already found one of those: a
    // fractional `trust_score` aborting the statement in Postgres, which
    // dropped M3 back to the racy read-modify-write permanently with no symptom
    // anywhere. The counters simply drifted low, biasing the risk gauge toward
    // "healthy" on exactly the numbers closest to a ban.
    //
    // Behaviour is unchanged - the write still falls through - but a non-404
    // refusal now leaves a throttled trace, so a silently degraded safety
    // counter becomes something the owner can see.
    if (!res.missing) noteRepBumpDegraded(senderKey);
    const absolute: Record<string, unknown> = { ...update };
    for (const [k, d] of Object.entries(bumps)) {
      absolute[k] = (Number((await getReputation(senderKey))[k as keyof Reputation]) || 0) + Number(d);
    }
    if (
      bumps.new_contacts_today !== undefined &&
      patch.new_contacts_date !== undefined &&
      patch.new_contacts_date !== current.new_contacts_date
    ) {
      absolute.new_contacts_today = bumps.new_contacts_today;
    }
    await sbUpdate(
      "whatsapp_number_reputation",
      `sender_key=eq.${encodeURIComponent(senderKey)}`,
      absolute
    );
    return;
  }
  await sbUpdate(
    "whatsapp_number_reputation",
    `sender_key=eq.${encodeURIComponent(senderKey)}`,
    update
  );
}

/** Inbound reply: builds trust, records engagement, clears delivered-not-read. */
export async function recordInboundEngagement(
  senderKey: string,
  fromNumber?: string
): Promise<void> {
  try {
    const p = await getPolicies();
    const rep = await getReputation(senderKey);
    await saveReputation(
      senderKey,
      {
        trust_score: Math.min(100, rep.trust_score + p.trust_reply_gain),
        last_reply_at: new Date().toISOString(),
      },
      { replies_total: 1 }
    );
    if (fromNumber) {
      await upsertRecipient(senderKey, fromNumber, {
        last_reply_at: new Date().toISOString(),
        read: true,
        delivered: true,
      });
      // THE MOMENT AN OPEN THREAD CLOSES. This is what makes "unanswered" a
      // fact instead of a derivation, and it is the quantity WhatsApp actually
      // meters - introductions that never got a reply, not introductions sent.
      //
      // It only works because upsertRecipient is now tail-keyed: the shop's
      // reply carries WhatsApp's spelling of the number while our introduction
      // carried discovery's, so before that fix this stamp would have landed on
      // a different row than the one holding first_intro_at.
      await stampRecipientFirst(senderKey, fromNumber, "first_reply_at");
      // The other half of the metered ratio. On the documented mechanism a reply
      // CLEARS the unanswered count, so this event is what turns the ledger from
      // a tally of sends into a tally of exposure.
      await noteRisk({ senderKey, kind: "intro_answered", toKey: nationalTail(fromNumber) });
    }
  } catch {
    /* reputation is best-effort - never block the reply pipeline */
  }
}

/** Read receipt (blue tick) from Evolution messages.update - engagement proof. */
export async function recordReadReceipt(
  senderKey: string,
  toNumber: string
): Promise<void> {
  try {
    // (M3 removed the read-modify-write that used this row; the counter is a
    // delta now, so the SELECT - and getReputation's lazy INSERT on a miss -
    // were pure cost on the highest-frequency events in the system.)
    // NO SYNTHESIZED DELIVERIES.
    //
    // This used to raise delivered_total to `max(delivered, reads + 1)`, on the
    // reasoning that a read implies a delivery. The effect ran the opposite way
    // from what that intends: when a READ arrives with no DELIVERY event -
    // exactly the case where the delivery webhook is broken - delivered_total
    // was INVENTED, which inflates delivRate at the engagement breaker and
    // makes it fire LESS often. A meter that heals itself on paper is how the
    // breaker stayed unarmed through both restrictions.
    //
    // Deliveries are now only ever counted from real delivery events, and
    // last_read_receipt_at gives the dashboard a way to tell "no receipts
    // because idle" from "no receipts because the pipeline is dead".
    await saveReputation(
      senderKey,
      { last_read_receipt_at: new Date().toISOString() },
      { reads_total: 1 }
    );
    await upsertRecipient(senderKey, toNumber, {
      read: true,
      delivered: true,
      last_read_at: new Date().toISOString(),
    });
    await noteRisk({ senderKey, kind: "read_receipt", toKey: nationalTail(toNumber) });
  } catch {
    /* best-effort */
  }
}

/** Delivery ack (double grey tick) - message reached the device. */
export async function recordDelivery(
  senderKey: string,
  toNumber: string
): Promise<void> {
  try {
    // (M3 removed the read-modify-write that used this row; the counter is a
    // delta now, so the SELECT - and getReputation's lazy INSERT on a miss -
    // were pure cost on the highest-frequency events in the system.)
    await saveReputation(
      senderKey,
      { last_delivery_receipt_at: new Date().toISOString() },
      { delivered_total: 1 }
    );
    await upsertRecipient(senderKey, toNumber, { delivered: true });
    // Meter integrity. `delivered_total` is a scalar with NO timestamp, so a
    // zero conflates "the receipt webhook is dead" with "this account is idle" -
    // and the engagement breaker only arms once delivered_total >= 8, which is
    // how it stayed unarmed through both restrictions. An event with a time on
    // it is what lets the dashboard tell those two apart.
    await noteRisk({ senderKey, kind: "delivery_receipt", toKey: nationalTail(toNumber) });
  } catch {
    /* best-effort */
  }
}

/**
 * WHATSAPP REFUSED AN OUTBOUND MESSAGE, AND IT HAS BEEN TELLING US ALL ALONG.
 *
 * The new-chat restriction surfaces as an Evolution `messages.update` carrying
 * `status: "ERROR"` on a `fromMe` key. The ingest only ever looked for READ and
 * DELIVERY and returned, so the single ground-truth signal that this number is
 * being refused was dropped on the floor - every prior round concluded we had
 * no restriction detector and would have to build one.
 *
 * The lane distinction is the whole diagnostic. An error on a FIRST CONTACT
 * while replies to established threads still deliver is the precise fingerprint
 * of the scoped restriction ("you may reply, you may not start new chats").
 * Errors spread evenly across both lanes are an infrastructure fault instead.
 *
 * LIMITATION, recorded rather than hidden: Evolution drops
 * `messageStubParameters`, so we can see THAT an outbound errored, not that the
 * cause was specifically a 463. The lane split is what carries the meaning.
 */
export async function recordSendError(
  senderKey: string,
  toNumber: string,
  opts: { firstContact: boolean; status: string }
): Promise<void> {
  try {
    await sbInsert("agent_events", [
      {
        kind: opts.firstContact ? "wa-send-error-cold" : "wa-send-error-reply",
        detail:
          `${senderKey} -> ${toNumber}: WhatsApp returned ${opts.status} on an ` +
          `outbound ${opts.firstContact ? "FIRST CONTACT" : "reply in an established thread"}.` +
          (opts.firstContact
            ? " Cold introductions are held; replies continue."
            : ""),
      },
    ]);
    await upsertRecipient(senderKey, toNumber, {
      last_error_at: new Date().toISOString(),
    }).catch(() => {});

    // Only the cold lane pauses. Halting replies would starve the one activity
    // that clears the unanswered-thread counter, which is what the restriction
    // meters in the first place.
    if (opts.firstContact) {
      await sbUpdate(
        "whatsapp_number_reputation",
        `sender_key=eq.${encodeURIComponent(senderKey)}`,
        { cold_hold_until: new Date(Date.now() + 6 * 3600_000).toISOString() }
      ).catch(() => {});
    }

    // SUSPECTED, not confirmed, and the distinction is load-bearing. One cold
    // error is a data point; a restriction is a LANE ASYMMETRY - cold failing
    // while replies keep succeeding - which only the aggregate can see. Writing
    // "confirmed" here would put a verdict in the ledger that no single event
    // supports, and this dashboard exists to stop exactly that kind of claim.
    // A reply-lane error is recorded too, as the control arm: errors spread
    // evenly across both lanes are an infrastructure fault, not enforcement.
    await noteRisk({
      senderKey,
      kind: opts.firstContact ? "restriction_suspected" : "send_failed",
      toKey: nationalTail(toNumber),
      detail: { status: opts.status, lane: opts.firstContact ? "cold" : "reply" },
    });
  } catch {
    /* telemetry can never break the webhook */
  }
}

/**
 * Has this recipient ever written to us? Distinguishes a cold first contact
 * from a reply inside an established thread - the lane split `recordSendError`
 * depends on.
 */
export async function hasInboundFrom(
  senderKey: string,
  toNumber: string
): Promise<boolean> {
  try {
    // TAIL-TOLERANT, like every other read of this table. This was the last
    // exact-match holdout: the table is WRITTEN tail-keyed by upsertRecipient
    // (the shop's reply carries WhatsApp's spelling of the number, our send
    // carried discovery's), so `to_number=eq.` routinely missed the row the
    // reply actually landed on - and an established thread's send error was
    // then escalated as a cold-lane "restriction suspected".
    const rows = await sbSelect<{ id: number }>(
      "wa_recipient_state",
      `select=id&sender_key=eq.${encodeURIComponent(senderKey)}` +
        `&last_reply_at=not.is.null&limit=1${numberFilter("to_number", toNumber)}`
    );
    return Boolean(rows[0]?.id);
  } catch {
    // Unknown lane. Treat as ESTABLISHED so an unreadable database cannot
    // manufacture a cold-lane hold out of nothing.
    return true;
  }
}

/** A send failed (invalid/non-WA number, or recipient blocked us). */
export async function recordSendFailure(
  senderKey: string,
  toNumber: string,
  kind: "fail" | "block" | "invalid" = "fail"
): Promise<void> {
  try {
    // (M3 removed the read-modify-write that used this row; the counter is a
    // delta now, so the SELECT - and getReputation's lazy INSERT on a miss -
    // were pure cost on the highest-frequency events in the system.)
    if (kind === "block") {
      // A REAL block: a human decided they do not want to hear from this
      // traveller. This is the only failure that belongs in blocks_total,
      // because it is the only one that reflects on the sender.
      await saveReputation(senderKey, {}, { blocks_total: 1 });
      await upsertRecipient(senderKey, toNumber, { blocked: true });
    } else if (kind === "invalid") {
      // The number is not on WhatsApp. That is a fact about a stale scraped
      // listing, not about the sender, and counting it as a block let three
      // dead numbers in one batch auto-pause a healthy account.
      await saveReputation(senderKey, {}, { invalid_numbers_total: 1 });
    } else {
      await saveReputation(senderKey, {}, { fails_total: 1 });
    }
    // Three separate kinds, matching the three separate meanings. Folding them
    // back into one is exactly the miscount this branch was split to fix.
    await noteRisk({
      senderKey,
      kind: kind === "block" ? "recipient_blocked" : kind === "invalid" ? "recipient_invalid" : "send_failed",
      toKey: nationalTail(toNumber),
    });
  } catch {
    /* best-effort */
  }
}

async function recordOutboundSend(senderKey: string, toNumber?: string): Promise<void> {
  try {
    const p = await getPolicies();
    const rep = await getReputation(senderKey);
    const today = new Date().toISOString().slice(0, 10);
    // Was this a brand-new cold contact (no prior recipient state)?
    let newContact = false;
    if (toNumber) {
      // TAIL-KEYED, like every other read of this table now. The exact-match
      // form counted a shop as BRAND NEW whenever the reply had been stored
      // under WhatsApp's spelling rather than discovery's - so a thread that
      // was already running could burn a fresh new-contact slot.
      const tail = nationalTail(toNumber);
      const sender = encodeURIComponent(senderKey);
      const prior = await sbSelect<{ id: number }>(
        "wa_recipient_state",
        tail
          ? `select=id&sender_key=eq.${sender}&to_tail=eq.${encodeURIComponent(tail)}&limit=1`
          : `select=id&sender_key=eq.${sender}&to_number=eq.${encodeURIComponent(toNumber)}&limit=1`
      );
      newContact = prior.length === 0;
      await upsertRecipient(senderKey, toNumber, { last_sent_at: new Date().toISOString() });
      // The first send to a shop IS the introduction. Stamped write-once, so it
      // anchors how long this thread has been open regardless of how many
      // follow-ups happen later.
      if (newContact) await stampRecipientFirst(senderKey, toNumber, "first_intro_at");
    }
    await saveReputation(
      senderKey,
      {
        trust_score: Math.max(0, rep.trust_score - p.trust_send_decay),
        last_send_at: new Date().toISOString(),
        // Carried in the last-write-wins half BECAUSE the day roll is what
        // tells the atomic bump to restart the introduction counter instead of
        // adding to yesterday's. `isNewDay` is now derived from this
        // comparison on both sides rather than computed once in the app.
        new_contacts_date: today,
      },
      // ALWAYS PRESENT, even as a 0. The day-roll reset in wa_rep_bump keys on
      // this column being bumped at all: with the key absent, a send on a new
      // day would stamp today's DATE beside yesterday's COUNT, which reads as
      // a full day's introductions already spent. Zero is a real delta here.
      { sent_total: 1, new_contacts_today: newContact ? 1 : 0 }
    );
    // Only a genuine first contact is an introduction. This is the numerator of
    // the quantity Meta actually meters, and until now it existed nowhere as
    // data - only as a re-derivation over an unindexed JSON convention that any
    // of thirteen outbound-writing call sites could silently break.
    if (newContact && toNumber) {
      await noteRisk({ senderKey, kind: "intro_sent", toKey: nationalTail(toNumber) });
    }
  } catch {
    /* best-effort */
  }
}

/** Owner control: lift an auto-pause on a number. */
export async function clearPause(senderKey: string): Promise<void> {
  await sbUpdate(
    "whatsapp_number_reputation",
    `sender_key=eq.${encodeURIComponent(senderKey)}`,
    { paused_until: null, risk_score: 0 }
  );
}

// ---------------------------------------------------------------------------
// Recipient business hours - extracted to wa/business-hours (pure, exported,
// tested; the clamp is flag-aware there so no pacing hold can roll across the
// night while fast dispatch is on).
// ---------------------------------------------------------------------------

export { recipientLocalHour };

/**
 * Count the DISTINCT new-shop introductions (outbound RFQ opening messages)
 * this sender made inside the trailing rolling window, oldest-first. Migration
 * free: an RFQ IS a first-contact and whatsapp_messages.received_at is durable,
 * so no schema change is needed to make the budget rolling.
 */
export async function introductionsInWindow(
  senderKey: string,
  windowHours: number
): Promise<{
  count: number;
  oldestAsc: string[];
  entries: { toNumber: string; atMs: number }[];
  /** True when the count could not be read and the cap must be treated as SPENT. */
  unreadable?: boolean;
}> {
  const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();
  // THIS BUDGET USED TO FAIL OPEN, which is the worst direction for it.
  //
  // The permissive sbSelect collapses every failure - a 500, a timeout, a DNS
  // blip - to []. `count` is derived from that array, so a Supabase wobble read
  // as "zero introductions used" and the introduction budget opened COMPLETELY,
  // on a traveller's personal number, at exactly the moment the rest of the
  // system was least healthy. Nothing anywhere would have said a word until the
  // restriction arrived.
  //
  // Unreadable now means AT CAP. The cost of being wrong that way is a batch
  // that waits a couple of minutes; the cost of being wrong the other way is
  // someone's WhatsApp account.
  const read = await sbSelectStrict<{ to_number: string; received_at: string }>(
    "whatsapp_messages",
    `select=to_number,received_at&direction=eq.outbound&raw->>kind=eq.rfq&to_number=not.in.(session,takeover,cancel)&raw->>sender=eq.${encodeURIComponent(
      senderKey
    )}&received_at=gte.${encodeURIComponent(sinceIso)}&order=received_at.asc&limit=200`
  );
  if ("error" in read && read.error === "unavailable") {
    return { count: Number.POSITIVE_INFINITY, oldestAsc: [], entries: [], unreadable: true };
  }
  // `error: "missing"` is a table that has never existed - a fresh install has
  // genuinely sent nothing, so that stays fail-open.
  const rows = "rows" in read ? read.rows : [];
  const firstSeen = new Map<string, string>();
  for (const r of rows) if (!firstSeen.has(r.to_number)) firstSeen.set(r.to_number, r.received_at);
  const oldestAsc = [...firstSeen.values()].sort();
  // entries carry the distinct recipients so the Module-6 Redis mirror can seed
  // REAL members (member = to_number) and dedup future recordIntro calls.
  const entries = [...firstSeen.entries()].map(([toNumber, iso]) => ({
    toNumber,
    atMs: Date.parse(iso) || Date.now(),
  }));
  return { count: firstSeen.size, oldestAsc, entries };
}

/**
 * THE TWO-METER BUDGET, and why there are two.
 *
 * WhatsApp meters introductions that never got a reply. What is NOT known - and
 * could not be established across six research rounds, because both sides were
 * arguing from a type definition nobody can observe on the pinned stack - is
 * whether a reply RETURNS a spent slot or whether the count simply accumulates
 * over a cycle.
 *
 * So the budget is built to be correct under BOTH models rather than betting on
 * one:
 *
 *   Meter A - unanswered introductions in a rolling 7-day window. Correct under
 *             the refund model, and never LOOSER than a plain sent-count under
 *             the accumulator model, because unanswered is a subset of sent.
 *   Meter B - cumulative messages this calendar month to shops that never
 *             replied. Correct under the accumulator model, harmless under the
 *             refund model.
 *
 * Admission is the MINIMUM. Whichever model is true, one of them binds.
 *
 * The window on Meter A is load-bearing, not decoration. An unwindowed
 * "unanswered ever" cap SATURATES: non-repliers never clear, so at q=0.35 and
 * 24 intros/day the open pool grows ~15/day and by day three the traveller is
 * pinned at zero capacity forever - strictly worse than the sent-count it
 * replaces. Seven days is also principled rather than invented: it matches the
 * tctoken lifetime WhatsApp itself uses for established-chat tokens.
 */
export const UNANSWERED_WINDOW_DAYS = 7;

export interface UnansweredMeters {
  /** Open unanswered introductions inside the rolling window. */
  openInWindow: number;
  /** Messages this calendar month to shops that never replied. */
  monthlyToNonRepliers: number;
  /** True when either read failed - the caller must fail CLOSED. */
  unreadable: boolean;
  /**
   * `first_intro_at` of the OLDEST still-unanswered introduction in the window,
   * or null when there is none / the read failed.
   *
   * This is the only honest anchor for a hold caused by Meter A. The
   * introductions budget's own `nextFreeAt` is derived from when SENT
   * introductions age out of the plan window - a different clock entirely. When
   * Meter A is what is binding, that number is not merely imprecise, it is
   * about the wrong thing, and it used to produce a wait of "about an hour"
   * for a state that does not change for up to seven days.
   */
  oldestOpenAt: string | null;
}

/**
 * Both meters, read conservatively.
 *
 * Every unreadable input contributes its CONSERVATIVE value - never infinity
 * (which would freeze a healthy account on one blip) and never zero (which is
 * how the old sent-count budget opened itself during a Supabase wobble). The
 * caller decides what to do with `unreadable`; the numbers themselves stay
 * honest.
 */
export async function unansweredMeters(senderKey: string): Promise<UnansweredMeters> {
  const sender = encodeURIComponent(senderKey);
  const windowStart = new Date(
    Date.now() - UNANSWERED_WINDOW_DAYS * 24 * 3600_000
  ).toISOString();
  const monthStart = new Date(new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z").toISOString();

  // METER A - open threads whose introduction is inside the window.
  const openRead = await sbSelectStrict<{ id: number; first_intro_at: string | null }>(
    "wa_recipient_state",
    `select=id,first_intro_at&sender_key=eq.${sender}&first_reply_at=is.null` +
      `&first_intro_at=gte.${encodeURIComponent(windowStart)}` +
      `&order=first_intro_at.asc&limit=500`
  );

  // METER B - this month's outbound to shops that have never written back.
  // Derived from the recipient ledger rather than a JSON scan of
  // whatsapp_messages, so it survives the 13 call sites that write outbound
  // rows without the convention this used to depend on.
  const monthRead = await sbSelectStrict<{ id: number }>(
    "wa_recipient_state",
    `select=id&sender_key=eq.${sender}&first_reply_at=is.null` +
      `&last_sent_at=gte.${encodeURIComponent(monthStart)}&limit=1000`
  );

  const openUnreadable = "error" in openRead && openRead.error === "unavailable";
  const monthUnreadable = "error" in monthRead && monthRead.error === "unavailable";

  return {
    openInWindow: "rows" in openRead ? openRead.rows.length : 0,
    monthlyToNonRepliers: "rows" in monthRead ? monthRead.rows.length : 0,
    unreadable: openUnreadable || monthUnreadable,
    oldestOpenAt: "rows" in openRead ? openRead.rows[0]?.first_intro_at ?? null : null,
  };
}

/** Owner alert thresholds on the monthly accumulator. */
export const MONTHLY_NON_REPLIER_WARN = 400;
export const MONTHLY_NON_REPLIER_ALERT = 700;

export interface IntroBudget {
  remaining: number;
  cap: number;
  windowHours: number;
  /** ISO instant the next introduction slot frees (now, if already free). */
  nextFreeAt: string;
  /**
   * The count could not be READ, so `remaining` is 0 defensively rather than
   * because the budget is spent. Callers should say "checking", not "you have
   * used your allowance" - and should re-check in minutes.
   */
  unreadable?: boolean;
  /** Meter A: open unanswered introductions inside the rolling window. */
  openUnanswered?: number;
  /** Meter B: this month's messages to shops that never replied. */
  monthlyToNonRepliers?: number;
  /**
   * WHICH of the four ceilings is at zero, when `remaining` is 0.
   *
   * Admission is the minimum of four terms and until now the caller could not
   * tell them apart, so every one of them was announced with the same sentence:
   * "introductions full - refreshes soon". For the plan window that is true -
   * capacity really does roll back in as sent introductions age out. For Meter
   * A it is FALSE, and falsely reassuring: a free traveller with five shops
   * that have not written back is not waiting on a clock, they are waiting on
   * a shop, and nothing "refreshes" for up to seven days. They watched five of
   * twelve shops get messaged, were told the rest were coming shortly, and the
   * rest were binned six hours later by the outbox ceiling.
   *
   * Naming the binding meter is what lets every surface say the true sentence.
   */
  bind?: IntroBudgetBind;
}

/**
 * The four ceilings, in the order `newContactBudget` minimises them.
 *
 * - `window`    the plan's rolling introductions budget (free 10/6h ...). Real
 *               capacity, really refreshing - the only one "refreshes soon"
 *               was ever true about.
 * - `unanswered` Meter A: too many introductions still unanswered. Clears when
 *               a shop REPLIES, or when the oldest leaves the 7-day window.
 * - `monthly`   Meter B: this month's cumulative messages to shops that never
 *               replied. Clears at the turn of the month.
 * - `daily`     the owner's `max_new_contacts_per_day` ceiling. Clears as
 *               24h-old introductions age out.
 */
export type IntroBudgetBind = "window" | "unanswered" | "monthly" | "daily";

/**
 * How many NEW shops this sender can still introduce in the current ROLLING
 * window, and when the next slot frees. Plan-tiered and continuously
 * refreshing (free 10/6h, pro 15/4h, ultra 24/3h) - never a hard "everything
 * waits until tomorrow" wall. Exported so the mass-bargain route can tell the
 * user the truth AT CLICK TIME.
 */
// PER-INSTANCE SHORT-TTL CACHE (OR11 E2.2). newContactBudget scans the intro
// ledger (introductionsInWindow / unansweredMeters - up to ~1,700 rows) and was
// recomputed on EVERY 6s activity poll to render two chips, plus once per send
// decision. The atomic per-send fleet-gap slot claim is the real velocity ceiling,
// so this budget is advisory/display and tolerates a few seconds of staleness;
// 12s (2x the poll) means the poll always hits the cache after the first read.
// The click-time mass route passes { fresh: true } to keep its exact "truth at
// click time" contract. Per-instance like safetySignalCache - each Cloud Run
// instance keeps its own, which is the same currency every health read accepts.
const newContactBudgetCache = new Map<string, { at: number; budget: IntroBudget }>();
const NEW_CONTACT_BUDGET_TTL_MS = 12_000;

export async function newContactBudget(
  senderKey: string,
  plan?: string,
  opts?: { fresh?: boolean }
): Promise<IntroBudget> {
  const resolvedPlan = plan ?? (await planForSender(senderKey));
  const key = `${senderKey.toLowerCase()}::${resolvedPlan}`;
  if (!opts?.fresh) {
    const hit = newContactBudgetCache.get(key);
    if (hit && Date.now() - hit.at < NEW_CONTACT_BUDGET_TTL_MS) return hit.budget;
  }
  const budget = await computeNewContactBudget(senderKey, resolvedPlan);
  newContactBudgetCache.set(key, { at: Date.now(), budget });
  return budget;
}

async function computeNewContactBudget(senderKey: string, resolvedPlan: string): Promise<IntroBudget> {
  const p = await getPolicies();
  const rep = await getReputation(senderKey);
  const windowHours = planCapacity(resolvedPlan).windowHours;
  const cap = newContactCap(rep, p, resolvedPlan);
  let count = 0;
  let oldestAsc: string[] = [];
  let unreadable = false;
  try {
    const win = await introductionsInWindow(senderKey, windowHours);
    count = win.count;
    oldestAsc = win.oldestAsc;
    unreadable = Boolean(win.unreadable);
  } catch {
    // Degrade to the legacy UTC-day counter if the window read THREW. A read
    // that merely came back unavailable is handled above and arrives here as
    // count = Infinity, which spends the budget rather than opening it.
    const today = new Date().toISOString().slice(0, 10);
    count = rep.new_contacts_date === today ? rep.new_contacts_today || 0 : 0;
  }
  // ADMISSION IS THE MINIMUM OF THREE, and the third is the one that actually
  // tracks risk. `cap - count` bounds introductions SENT in the plan window;
  // the meters bound introductions still UNANSWERED, which is what WhatsApp
  // meters. A traveller whose shops all replied has spent nothing risk-bearing
  // and should keep going; one with 20 open silent threads should not.
  const meters = await unansweredMeters(senderKey).catch(() => null);
  const openHeadroom = meters
    ? Math.max(0, cap - meters.openInWindow)
    : Number.POSITIVE_INFINITY;
  const monthHeadroom = meters
    ? Math.max(0, MONTHLY_NON_REPLIER_ALERT - meters.monthlyToNonRepliers)
    : Number.POSITIVE_INFINITY;

  // ...AND A FOURTH THE OWNER CONTROLS DIRECTLY.
  //
  // `max_new_contacts_per_day` was declared on SecurityPolicies, defaulted,
  // validated by policy-values and rendered in the WA-security admin panel -
  // and read by NO send path. An owner watching a wobbling number during the
  // beta would lower it, watch the field save, and change nothing. A dead
  // control on a safety panel is worse than no control: it spends the one
  // moment somebody is paying attention.
  //
  // 0 or unset means "no extra ceiling" so existing deployments are unchanged;
  // any positive value binds against introductions sent in the last 24h.
  const dailyIntroCap = Number(p.max_new_contacts_per_day) || 0;
  let dayHeadroom = Number.POSITIVE_INFINITY;
  if (dailyIntroCap > 0) {
    const day = await introductionsInWindow(senderKey, 24).catch(() => null);
    // Unreadable follows the same fail-CLOSED rule the rest of this budget
    // uses: an unknown count is treated as spent, not as zero.
    dayHeadroom =
      !day || day.unreadable ? 0 : Math.max(0, dailyIntroCap - day.count);
  }

  const windowHeadroom = Math.max(0, cap - count);
  const remaining = Math.min(windowHeadroom, openHeadroom, monthHeadroom, dayHeadroom);
  // WHICH ceiling is at zero. Evaluated in the order the plan intends them to
  // bite: the plan window is the ordinary, self-healing one, so it is claimed
  // first when it is genuinely also zero - the traveller does not need to hear
  // about a seven-day meter when their own batch refreshes in twenty minutes.
  let bind: IntroBudgetBind | undefined;
  if (remaining <= 0) {
    bind =
      windowHeadroom <= 0
        ? "window"
        : openHeadroom <= 0
          ? "unanswered"
          : monthHeadroom <= 0
            ? "monthly"
            : "daily";
  }
  let nextFreeAt = nextIntroSlotIso(oldestAsc, windowHours, cap, Date.now());
  // METER A HAS ITS OWN CLOCK, so it must not borrow the plan window's.
  //
  // `nextIntroSlotIso` answers "when does a SENT introduction age out of the
  // plan window", which for a Meter-A hold is an answer to a question nobody
  // asked - and it is short, so the row re-parked roughly hourly and was binned
  // by the 6h outbox ceiling while the app kept promising it was coming. The
  // honest instant is when the oldest STILL-UNANSWERED introduction leaves the
  // 7-day window; a reply arriving sooner is what usually clears it, and a
  // reply kicks the queue on its own.
  if (bind === "unanswered" && meters?.oldestOpenAt) {
    const ages = Date.parse(meters.oldestOpenAt) + UNANSWERED_WINDOW_DAYS * 24 * 3600_000;
    if (Number.isFinite(ages)) nextFreeAt = new Date(ages).toISOString();
  }
  // Guard the fallback/edge case: budget spent but no window timestamps to
  // anchor to (the legacy-counter degrade path, or a count with no oldestAsc).
  // Without this, nextFreeAt is "now" while remaining is 0, so an over-budget
  // hold re-attempts every drain (a spin) instead of backing off a real gap.
  if (remaining <= 0 && Date.parse(nextFreeAt) <= Date.now() + 1000) {
    nextFreeAt = new Date(Date.now() + Math.min(windowHours, 1) * 3600_000).toISOString();
  }
  // An unreadable count re-checks in MINUTES, not an hour. The budget is not
  // actually spent - we simply cannot see it - so the right behaviour is to
  // hold briefly and look again, rather than to park the batch as if the user
  // had used their whole window.
  if (unreadable || meters?.unreadable) {
    nextFreeAt = new Date(Date.now() + 3 * 60_000).toISOString();
  }
  return {
    remaining,
    cap,
    windowHours,
    nextFreeAt,
    unreadable: unreadable || Boolean(meters?.unreadable),
    openUnanswered: meters?.openInWindow,
    monthlyToNonRepliers: meters?.monthlyToNonRepliers,
    bind,
  };
}

/**
 * The sentence that goes on the parked row, for whichever ceiling is binding.
 *
 * ONE function, because there are two places that park an over-budget
 * introduction - the guard (the drain path) and /api/outreach/mass (click
 * time) - and they must never disagree about why. `queue-reason.ts` classifies
 * these strings for the UI, so the wording here is load-bearing.
 */
export function introHoldReason(bind: IntroBudgetBind | undefined): string {
  switch (bind) {
    case "unanswered":
      // NOT "refreshes soon". This clears when a shop writes back - or, at the
      // outside, when the oldest silent introduction is seven days old.
      return "waiting on replies - a new shop opens as soon as one of the shops already messaged answers";
    case "monthly":
      return "monthly ceiling on shops that never replied - protecting your number";
    case "daily":
      return "daily new-shop ceiling reached - refreshes as today's introductions age out";
    default:
      return "introductions full - refreshes soon";
  }
}

/**
 * The CONSERVATIVE effective hourly send cap for this sender right now (trust +
 * warm-up adjusted), used by the batch stagger so it stamps not_before values
 * the drain will actually honor - no optimistic time that jumps an hour later.
 * We take 80% of the base (the drain applies a +/-20% daily jitter) and floor at
 * 1, so a staggered batch stays UNDER the drain's real cap in every window.
 */
export async function effectiveHourlyCap(senderKey: string, plan?: string): Promise<number> {
  const p = await getPolicies();
  const rep = await getReputation(senderKey);
  const resolvedPlan = plan ?? (await planForSender(senderKey));
  const base = dynamicHourCap(rep, p, resolvedPlan);
  const cap = Math.floor(base * 0.8);
  // Large caps (aged, high-trust numbers) lose ~1 to trust decay across a full
  // hour-group of sends, which would trip the drain's recomputed cap on the
  // tail item. Give them 1 extra slot of headroom. Small caps decay negligibly.
  const trimmed = Math.max(1, cap >= 6 ? cap - 1 : cap);
  // NEVER stamp the stagger below the plan's conversation budget: a within-budget
  // batch must fit inside ONE window, never split an hour out (the "18:24 then
  // jumped to 19:20" bug). The budget is the intended first-session burst; the
  // min-gap + reply-rate breaker are what actually keep the send rate safe.
  // FLOORED AT THE RAMPED BUDGET, NOT THE RAW ONE.
  //
  // This floored at `planCapacity(plan).newContacts` - the plan's FULL budget,
  // with no warm-up applied - while the cap the drain actually enforces goes
  // through `dynamicHourCap` -> `effectiveHourCap`, which owner report 8 wave D
  // made genuinely ramped. So the two disagreed on exactly the numbers a new
  // link cares about: a day-0 ultra batch was staggered as though 24 sends an
  // hour were available while the drain would honour about half that. The tail
  // of the batch is then stamped for a slot that will be refused, re-parked,
  // and stamped again - the "18:24 then jumped to 19:20" bouncing this
  // function's own comment below says it exists to PREVENT. It was correct
  // until the ramp underneath it started moving.
  //
  // Same ramp, same inputs, so the stagger and the drain now agree by
  // construction rather than by coincidence.
  const rampedBudget = Math.max(
    1,
    Math.round(planCapacity(resolvedPlan).newContacts * warmupMultiplier(rep, p))
  );
  return Math.max(trimmed, rampedBudget);
}

/**
 * The instant the next introduction slot frees, clamped into the recipient's
 * business hours when the timezone is known. Exported for over-budget enqueues
 * - a rolling-window anchor at most windowHours away, never "tomorrow".
 */
export async function introHoldIso(
  senderKey: string,
  toDigits: string,
  region?: string,
  plan?: string
): Promise<string> {
  const p = await getPolicies();
  const { nextFreeAt } = await newContactBudget(senderKey, plan);
  return clampToBusinessHours(nextFreeAt, toDigits, p, region);
}

/**
 * Cold-outreach engagement over the trailing 7 days: how many DISTINCT shops
 * this sender introduced, and how many of them engaged (replied OR read).
 * Windowed on purpose - the lifetime replies_total/sent_total ratio latches
 * (see the breaker comment in guardOutbound). Null when unreadable: the
 * breaker then stands down - the risk pause and stop-loss still protect the
 * number, and a guard must not freeze outreach on its own blindness.
 */
const BREAKER_WINDOW_HOURS = 7 * 24;
export async function coldEngagementWindow(
  senderKey: string
): Promise<{ intros: number; engaged: number } | null> {
  try {
    const sinceIso = new Date(Date.now() - BREAKER_WINDOW_HOURS * 3600_000).toISOString();
    const win = await introductionsInWindow(senderKey, BREAKER_WINDOW_HOURS);
    // UNREADABLE IS NOT ZERO INTROS, and here that distinction flips the other
    // way from the budget. introductionsInWindow used to THROW on a failed
    // read and this catch turned it into null - "the breaker stands down
    // instead of freezing on blindness". Now it returns a value, so the null
    // has to be produced explicitly or a blind read would look like a healthy
    // window with no introductions in it.
    //
    // Standing down is right HERE because the breaker's job is to halt a batch
    // that is going unanswered; halting on no evidence would freeze cold
    // outreach on a database wobble. The budget above fails the opposite way
    // for the opposite reason - it grants permission, so silence must deny.
    if (win.unreadable) return null;
    const entries = win.entries;
    if (entries.length === 0) return { intros: 0, engaged: 0 };
    const introDigits = new Set(entries.map((e) => digitsOnly(e.toNumber)).filter(Boolean));
    const engaged = new Set<string>();
    const inbound = await sbSelect<{ from_number: string }>(
      "whatsapp_messages",
      `select=from_number&direction=eq.inbound&raw->>receiver=eq.${encodeURIComponent(
        senderKey
      )}&received_at=gte.${encodeURIComponent(sinceIso)}&limit=300`
    );
    for (const r of inbound) {
      const d = digitsOnly(r.from_number ?? "");
      if (introDigits.has(d)) engaged.add(d);
    }
    // Read receipts count: a shop that READ us engaged with the number even
    // if it never typed - and reads are recorded through message-update
    // events, so they survive an inbound-text ingest defect.
    const state = await sbSelect<{ to_number: string; read: boolean | null; last_reply_at: string | null }>(
      "wa_recipient_state",
      `select=to_number,read,last_reply_at&sender_key=eq.${encodeURIComponent(senderKey)}&limit=500`
    );
    for (const r of state) {
      if (!r.read && !r.last_reply_at) continue;
      const d = digitsOnly(r.to_number ?? "");
      if (introDigits.has(d)) engaged.add(d);
    }
    return { intros: introDigits.size, engaged: engaged.size };
  } catch {
    return null;
  }
}

/**
 * A terminal refusal must leave a durable, attributable trace. Six shops once
 * rendered as "REMOVED BY YOU" precisely because their refusals (engagement
 * halt, dedup, tombstone) wrote nothing anywhere a client could read - the
 * poll's cancellation list became the only available "explanation".
 */
async function recordSendDropped(
  senderKey: string,
  toDigits: string,
  reason: string,
  meta?: Record<string, unknown>
): Promise<void> {
  const digits = digitsOnly(toDigits);
  await sbInsert("agent_events", [
    {
      kind: "send-dropped",
      vendor_id: typeof meta?.vendorId === "string" ? (meta.vendorId as string) : "",
      vendor_name: digits,
      ...(senderKey ? { user_email: senderKey } : {}),
      detail: JSON.stringify({ reason, digits }),
    },
  ]).catch(() => {});
}

/**
 * An agent_events write that carries the message-path join key (`to_number`)
 * and survives databases where that column does not exist yet: attempted WITH
 * it first, retried without - an un-migrated database loses the join, never
 * the event (the same degradation contract as wa/hold-events).
 *
 * This exists because the send lane's fates - expired, stale, claim lost/error
 * - used to write events the message-path view could not match: no user_email,
 * no to_number, a vendor_name that might be a shop's display name. A trail
 * that shows "queued" and then nothing is the hole the trail was built to
 * close.
 */
async function insertPathEvent(
  ev: Record<string, unknown> & { to_number?: string }
): Promise<void> {
  const ok = await sbInsert("agent_events", [ev]).catch(() => false);
  if (!ok && "to_number" in ev) {
    const { to_number: _dropped, ...rest } = ev;
    await sbInsert("agent_events", [rest]).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Content variance - unique payload signature every time
// ---------------------------------------------------------------------------

/**
 * THE GREETING SWAP - FIRST OUTBOUND ONLY (W4.7).
 *
 * This used to fire on every send, and it is the direct cause of owner report
 * 5 item 3: it matched a leading greeting and substituted a DIFFERENT random
 * one, so one thread showed "Hi", "Hi there!" and "Hey there!" in three
 * consecutive messages. It never REMOVED a greeting, and it had no idea where
 * in a thread it was. It also mangled "Hi again!" - the leading "Hi " matched
 * and a whole greeting was substituted for it, producing "Hey there! again!" on
 * EVERY momentum/recheck send.
 *
 * It is still worth having on the message that opens a thread (forty cold
 * openers must not share one greeting), so it now runs there and nowhere else.
 */
// B2 fix: the old `^hi!?\s` only consumed "Hi " so it swapped INSIDE
// "Hi there!" -> "Hey there! there!". Match the whole leading greeting phrase.
// W4.7: "(?!again)" so an "X again!" opener is never re-rolled into a doubled
// artifact - a first outbound has no "again" to keep anyway.
const GREETING_SWAP_RX = /^(?:hi|hey|hello)(?:\s+there)?!?[,\s]+(?!again\b)/i;
const GREETING_SWAP_POOL = ["Hi! ", "Hey! ", "Hello! ", "Hi there! ", "Hey there! "];

/** Sign-off variance - safe at ANY thread position, so it always runs. */
const SIGNOFF_SWAPS: [RegExp, string[]][] = [
  [/\bthanks!?$/i, ["Thanks!", "Thank you!", "Thanks a lot!", "Thanks 🙏", "Ta!"]],
];

/**
 * Semantic variance for AUTOMATED messages: swap greetings/sign-offs, vary
 * contractions and spacing so the payload hash is unique per send while the
 * meaning stays identical. (LLM-composed messages are already unique - this
 * is the guarantee for deterministic/template fallbacks.)
 *
 * `rand` is injectable (B2/B4): guardOutbound seeds it from the message identity
 * so a parked row that is re-guarded produces the SAME text - the enqueue-time
 * humanization is never re-rolled, which is what kept two concurrent drainers'
 * idempotency hashes stable.
 */
export function humanizeVariant(
  text: string,
  rand: () => number = Math.random,
  /**
   * W4.7 - THREAD POSITION. The greeting pool is only drawn from on the message
   * that OPENS a thread. Default false: a caller that does not know where it is
   * never re-greets, which is the safe direction (a missing greeting reads as a
   * person mid-chat; a fourth one reads as a bot).
   */
  opts?: { firstOutbound?: boolean }
): string {
  let out = text;
  if (opts?.firstOutbound === true && GREETING_SWAP_RX.test(out)) {
    const pick = GREETING_SWAP_POOL[Math.floor(rand() * GREETING_SWAP_POOL.length)];
    out = out.replace(GREETING_SWAP_RX, pick);
  }
  for (const [rx, pool] of SIGNOFF_SWAPS) {
    if (rx.test(out)) {
      const pick = pool[Math.floor(rand() * pool.length)];
      out = out.replace(rx, pick);
    }
  }
  // Contraction jitter (one direction only, keeps grammar safe).
  if (rand() < 0.5) out = out.replace(/\bI am\b/g, "I'm");
  if (rand() < 0.4) out = out.replace(/\bwhat is\b/gi, (m) => (m[0] === "W" ? "What's" : "what's"));
  if (rand() < 0.3) out = out.replace(/\bokay\b/gi, "ok");
  // Punctuation/spacing jitter - invisible to a human, new hash every time.
  if (rand() < 0.35) out = out.replace(/\. /g, ".  ");
  if (rand() < 0.3 && !/[?!]$/.test(out)) out = out.replace(/\.$/, "");
  // (Removed) the "typo *word" self-correction: it literally emitted a leading
  // asterisk into the sent message ("good *good day", "qiuck *quick question") -
  // it read as corrupted markdown, not a human touch. The contraction/spacing/
  // punctuation jitter above plus personaHumanize already guarantee a unique
  // payload hash per send, so nothing of value is lost.
  return out;
}

/**
 * THE ONE SEEDED HUMANIZE PASS, callable wherever a message is COMMITTED.
 *
 * The full anti-fingerprinting chain (personaHumanize -> humanizeVariant ->
 * stripWaFormatting) used to run only inside guardOutbound's inline path. But
 * the drain re-guards every parked row with `alreadyHumanized: true` - a
 * correct idempotency contract built on a false premise, because the two
 * paths that PARK most rows (parkOutboxOnce's composed replies and the mass
 * route's stagger slots) never humanized at all. So the dominant share of
 * automated traffic went out with the raw composer text: uniform greetings,
 * corporate sign-offs, identical punctuation - the exact hash-uniformity the
 * engine exists to break.
 *
 * Seeded from the message identity (sender + shop + text), exactly like the
 * inline path: the same input always yields the same output, so a re-park, a
 * retry, or two concurrent writers produce byte-identical bodies and the
 * idempotency slot hash stays stable. The number spelling is normalised
 * before seeding so every call site agrees on the seed for one shop.
 */
export function humanizeForOutbound(
  senderKey: string,
  toDigits: string,
  text: string,
  /**
   * W4.7 - IS THIS THE FIRST THING WE HAVE EVER SAID TO THIS SHOP?
   *
   * Derived server-side by `guardOutbound` (see `hasMessagedShopBefore`), so no
   * caller can forget it. When false - the overwhelmingly common case, since
   * every reply, nudge and follow-up is mid-thread - a leading greeting is
   * REMOVED and none is rolled in. When true the opener keeps its greeting and
   * the greeting pool varies it, which is what stops forty cold openers sharing
   * one first word.
   *
   * Defaults to false on purpose: the failure this closes is a repeated
   * greeting, so an unknown position must never manufacture one.
   */
  opts?: { firstOutbound?: boolean }
): string {
  const digits = waDigits(toDigits) || toDigits;
  const firstOutbound = opts?.firstOutbound === true;
  // POSITION FIRST, THEN VARIANCE. Stripping before the seed is computed keeps
  // the humanize pass deterministic for a given (sender, shop, text, position)
  // - a re-park of the same composed turn still produces a byte-identical body,
  // so the idempotency slot hash stays stable.
  const positioned = firstOutbound ? text : stripLeadingGreeting(text);
  const rand = (() => {
    let h = 2166136261 >>> 0;
    const seed = `${senderKey}|${digits}|${positioned}`;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return () => {
      // mulberry32 step - deterministic, well-distributed.
      h = (h + 0x6d2b79f5) >>> 0;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();
  return stripWaFormatting(
    humanizeVariant(personaHumanize(positioned, rand), rand, { firstOutbound })
  );
}

/**
 * HAVE WE EVER SENT THIS SHOP A MESSAGE? (W4.7)
 *
 * The information the greeting rule needs already existed and nothing read it:
 * `wa_recipient_state.last_sent_at` is stamped by `recordOutboundSend` after
 * every delivery, on the ONE row per (sender, shop) the whole guard keys on.
 * Read tail-tolerantly (`numberFilter`), like every other read of this table,
 * because our send carries discovery's spelling of the number and the shop's
 * reply carries WhatsApp's.
 *
 * Deliberately derived here rather than passed in: eight call sites reach
 * `guardOutbound` and a rule that depends on all of them remembering a flag is
 * a rule that is off somewhere. `null` means the answer could not be read - the
 * caller decides, and both callers choose "not the first", because the failure
 * being closed is a REPEATED greeting.
 *
 * W4.7b - THE OWNER'S SCREENSHOT, STILL LIVE UNTIL THIS COMMIT. The last line
 * used to be `return Boolean(row.last_sent_at)`, so "a recipient row EXISTS but
 * last_sent_at is NULL" answered a confident "we have NEVER messaged this
 * shop". A null timestamp is not evidence of absence of a message - it is the
 * ordinary state of a row written by any of the other writers of this table:
 *
 *   - the shop wrote FIRST (ingest stamps first_reply_at / last_reply_at),
 *   - a send failed and was stamped (blocked / last_error_at),
 *   - the shop asked us to stop (opted_out_at),
 *   - recordOutboundSend's upsert lost its best-effort try/catch after the
 *     message itself was already on the wire.
 *
 * In every one of those a thread EXISTS, and the old answer flipped
 * `firstOutbound` back to true MID-THREAD: the message kept its greeting AND
 * got re-rolled through GREETING_SWAP_POOL, which is precisely why the owner's
 * thread read "Hi", then "Hi there!", then "Hey there!".
 *
 * So the question this answers is now the honest one - IS THERE ALREADY A
 * THREAD WITH THIS SHOP - and the evidence is:
 *
 *   row exists            -> true. The row IS the relationship; nothing creates
 *                            one before a first send (recordOutboundSend runs
 *                            AFTER delivery, on `afterSend`), so its presence
 *                            can only mean contact in one direction or another.
 *   no row + an outbound  -> true. The ledger is the durable half; the recipient
 *     in the ledger          upsert is best-effort and swallows its own errors.
 *   no row + no outbound  -> false. The only shape that actually proves "we have
 *                            never written to this shop".
 *   either read failed    -> null. Unknown, and guardOutbound resolves unknown
 *                            toward NOT greeting.
 *
 * The direction is deliberate and asymmetric: a missed greeting on a genuine
 * first contact is a wording nit, a re-greeting mid-thread is the bot tell the
 * owner reported.
 */
export async function hasMessagedShopBefore(
  senderKey: string,
  toNumber: string
): Promise<boolean | null> {
  const digits = waDigits(toNumber) || toNumber;
  if (!senderKey || !digits) return null;
  const sender = encodeURIComponent(senderKey);
  // `id` only - it is in the base schema.sql table, so this read cannot 400 on
  // a database that has not taken the later migrations (which is how a column
  // probe would turn every thread into "unknown" at once). Tail-tolerant
  // (`numberFilter`), like every other read of this table, because our send
  // carries discovery's spelling of the number and the shop's reply carries
  // WhatsApp's.
  const res = await sbSelectStrict<{ id: number }>(
    "wa_recipient_state",
    `select=id&sender_key=eq.${sender}&limit=1${numberFilter("to_number", digits)}`
  );
  if (!("rows" in res)) return null;
  if (res.rows[0]) return true;
  // NO ROW IS NOT PROOF EITHER. The recipient upsert is best-effort inside a
  // try/catch, so a send can reach the shop and leave no row behind; the
  // outbound message row is the durable record of the same event. Only reached
  // on the genuinely-cold path, so it costs one extra read per NEW shop, never
  // per reply.
  //
  // A BELT, NOT A SECOND PROOF: `raw->>sender` is a convention, and not all of
  // the outbound-writing call sites keep it (that is why the unanswered meters
  // were moved off this table onto the recipient ledger). So this read can miss
  // a real send - it can never invent one - which keeps the fail direction the
  // same as the rest of the function: it only ever moves the answer toward NOT
  // greeting, and the sender scope is what stops one traveller's thread with a
  // popular shop from silencing another traveller's genuine first hello.
  const prior = await sbSelectStrict<{ id: number }>(
    "whatsapp_messages",
    `select=id&direction=eq.outbound&raw->>sender=eq.${sender}` +
      `&limit=1${numberFilter("to_number", digits)}`
  );
  if (!("rows" in prior)) return null;
  return prior.rows.length > 0;
}

/**
 * Graduated ban-recovery: after a REAL WhatsApp restriction (a 401/logout or a
 * detected soft-ban), pause the number for a long rest, then it resumes under
 * the warm-up ramp. Called from the connection lifecycle handler.
 */
export async function enterBanRecovery(
  senderKey: string,
  hours = 24
): Promise<void> {
  try {
    const until = new Date(Date.now() + hours * 3600_000).toISOString();
    await sbUpdate(
      "whatsapp_number_reputation",
      `sender_key=eq.${encodeURIComponent(senderKey)}`,
      { paused_until: until, trust_score: 10 }
    );
    await sbInsert("agent_events", [
      {
        kind: "wa-ban-risk",
        detail: `${senderKey} entered ban-recovery: paused ${hours}h after a WhatsApp restriction/logout. Sending resumes slowly under warm-up.`,
      },
    ]);
    // The event that has to be in the ledger for any of this to be reviewable
    // later. `until` rides along because ban recovery restores the FULL plan
    // budget the moment it lapses - so the pair (entered, lapsed) is the only
    // way to see a number going straight back to the behaviour that got it
    // restricted.
    await noteRisk({
      senderKey,
      kind: "ban_recovery_entered",
      detail: { hours, until },
    });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Send-side STOP-LOSS (fast circuit breaker)
// ---------------------------------------------------------------------------
// computeRisk() is a SLOW, cumulative gauge (a failed send adds only ~+3, capped
// at +15), so a number that gets restricted mid-batch - the exact "your account
// is limited right now" state - would keep getting hammered shop after shop long
// before the cumulative risk crosses the pause threshold. This is the FAST trip:
// N consecutive HARD send failures inside a short window immediately enters
// ban-recovery, which sets paused_until, so guardOutbound then parks EVERY
// automated send for the whole account until the window clears. It is the honest,
// genuinely-protective core - not a promise of zero bans, but a guarantee the
// system stops digging the moment WhatsApp pushes back.
//
// SCOPE (be honest about it): the streak is in-memory per-process. That is the
// RIGHT scope for the long-lived workers process, where a failure burst happens
// inside one drain and the DURABLE effect it triggers (paused_until in
// whatsapp_number_reputation) is what every other instance then honors. On the
// SERVERLESS path it under-fires: the mass route parks all-but-slot-0 and the
// drain sends <=1 rfq/sender/invocation across ephemeral instances, so a single
// process rarely sees 3 hard failures in the window. The durable computeRisk
// gauge (recordSendFailure -> blocks_total/fails_total -> risk auto-pause) is the
// cross-instance safety net there; this breaker is the FAST trip that reliably
// protects the workers deployment. A "soft"/"ok" outcome resets the streak so
// isolated blips (one dead number in a good batch) never trip it.
const STOP_LOSS_MAX_FAILS = 3; // consecutive hard failures that trip the breaker
const STOP_LOSS_WINDOW_MS = 180_000; // ...within this window (older streak resets)
const STOP_LOSS_PAUSE_HOURS = 12; // automated queue halted this long once tripped

declare global {
  // eslint-disable-next-line no-var
  var __wd_send_streak__: Map<string, { n: number; first: number }> | undefined;
}
function sendStreak(): Map<string, { n: number; first: number }> {
  if (!globalThis.__wd_send_streak__) globalThis.__wd_send_streak__ = new Map();
  return globalThis.__wd_send_streak__;
}

/**
 * Record the outcome of one outbound send for the stop-loss breaker.
 *   "ok"   - delivered/accepted: clears the streak.
 *   "soft" - a failure that is NOT an account-restriction signal (e.g. one
 *            invalid/non-WhatsApp number): clears the streak (an isolated bad
 *            number in a healthy batch must not trip the breaker).
 *   "hard" - an account-level restriction signal ONLY - an HTTP 429 rate limit,
 *            or WhatsApp restriction/ban text in the response body (see
 *            isHardSendFailure in wa/send-classify). NOT an Evolution 401/403
 *            apikey rejection: that is our config, not the number (OR11 H2.1).
 *            Increments the streak; on reaching STOP_LOSS_MAX_FAILS within the
 *            window it trips enterBanRecovery.
 * Returns { tripped } so callers can log/stop the current drain immediately.
 * Never throws - the send path must not break on the breaker.
 */
export async function noteSendOutcome(
  senderKey: string,
  outcome: "ok" | "soft" | "hard"
): Promise<{ tripped: boolean }> {
  try {
    if (outcome !== "hard") {
      sendStreak().delete(senderKey);
      return { tripped: false };
    }
    const now = Date.now();
    const rec = sendStreak().get(senderKey);
    if (!rec || now - rec.first > STOP_LOSS_WINDOW_MS) {
      sendStreak().set(senderKey, { n: 1, first: now });
      return { tripped: false };
    }
    rec.n += 1;
    if (rec.n >= STOP_LOSS_MAX_FAILS) {
      sendStreak().delete(senderKey);
      await enterBanRecovery(senderKey, STOP_LOSS_PAUSE_HOURS);
      try {
        await sbInsert("agent_events", [
          {
            kind: "wa-stop-loss",
            vendor_name: senderKey,
            detail:
              `STOP-LOSS: ${STOP_LOSS_MAX_FAILS} consecutive hard send failures in ` +
              `<${Math.round(STOP_LOSS_WINDOW_MS / 1000)}s - automated queue halted ` +
              `${STOP_LOSS_PAUSE_HOURS}h. The WhatsApp account is likely restricted; ` +
              `open the WhatsApp app to confirm and do NOT force sends during a restriction.`,
          },
        ]);
      } catch {
        /* logging is best-effort */
      }
      return { tripped: true };
    }
    return { tripped: false };
  } catch {
    return { tripped: false };
  }
}

// ---------------------------------------------------------------------------
// The gate - every automated outbound passes through here
// ---------------------------------------------------------------------------

export interface GuardVerdict {
  allow: boolean;
  reason?: string;
  queuedUntil?: string; // set when the message was parked in wa_outbox (re-queued)
  /**
   * WHICH ROW IT IS PARKED IN.
   *
   * Ops could tell the owner a message was "queued" and nothing else - the
   * chip is written once into the turn detail at compose time, agent_events
   * is append-only, and nothing ever joined back to wa_outbox. So a turn sent
   * at 12:43 still read `queued` an hour later, and "where is it held" had no
   * answer anywhere in the system. This is the exact join key.
   */
  outboxRowId?: number;
  terminal?: boolean;   // set when the message must be DROPPED for good (cancelled,
                        // duplicate, rfq-dedup, takeover). The drain uses this to
                        // tell "safely re-queued" and "deliberately dropped" apart
                        // from "rejected but NOT re-parked" - the last of which
                        // must never silently lose an already-claimed outbox row.
  text: string;         // the (possibly varied) payload to actually send
}

/**
 * Decide whether an outbound WhatsApp message may go out RIGHT NOW.
 * `auto` marks agent-generated messages (strictest rules); user-typed custom
 * messages skip the engagement halt but still respect volume caps.
 */
export async function guardOutbound(rawOpts: {
  senderKey: string; // user email (one connected WA number per user)
  toDigits: string;
  text: string;
  auto: boolean;
  queueIfBlocked?: boolean; // park in wa_outbox instead of rejecting
  region?: string;          // geocoded shop region - best timezone source
  shopOpenNow?: boolean;    // Google "open now" truth - overrides the clock
  meta?: Record<string, unknown>; // thread context for queued sends
  plan?: string;            // plan-tiered capacity (falls back to meta.plan)
  // B4: text pulled from wa_outbox was ALREADY humanized once at enqueue. The
  // drain must NOT re-run the unseeded persona/variance pass on it - doing so
  // mutates the text on every drainer, which changes its idempotency slot hash
  // and lets two concurrent drainers both send. When true, only the idempotent
  // stripWaFormatting runs - plus, since W4.7b, the equally idempotent
  // greeting strip when the thread is DEMONSTRABLY already open (see the
  // `repositioned` note below): the variance is what must not be re-rolled,
  // and a greeting frozen into a row at park time is not variance.
  alreadyHumanized?: boolean;
  /**
   * W4.7 - a caller's OPINION on whether this is the first outbound to this
   * shop. Only consulted when the database cannot answer: the position is
   * derived server-side (`hasMessagedShopBefore`) precisely so no caller has to
   * be trusted with it.
   */
  firstOutbound?: boolean;
  /**
   * The wa_outbox row this send IS. Set by the drain, which now claims a row by
   * LEASE rather than deleting it, so the row still exists: a re-queue must
   * re-time THAT row, not insert a second pending message for the same shop.
   */
  outboxRowId?: number;
}): Promise<GuardVerdict> {
  // ONE canonical routing key for this whole call. Callers hand us whatever
  // spelling they hold - a JID with a device suffix, a "+63 966 …" from Google,
  // bare digits - and every row this function writes (the outbox row, the
  // recipient state, the sent message) becomes the anchor a later inbound reply
  // is matched against. Normalising HERE means one shop is one key everywhere
  // downstream, instead of three spellings that never meet.
  const opts = { ...rawOpts, toDigits: waDigits(rawOpts.toDigits) || rawOpts.toDigits };
  const region = opts.region ?? (typeof opts.meta?.region === "string" ? (opts.meta.region as string) : undefined);
  const plan = opts.plan ?? (typeof opts.meta?.plan === "string" ? (opts.meta.plan as string) : undefined);
  const p = await getPolicies();
  // AUTO messages get the full anti-fingerprinting pass: strip corporate
  // sign-offs, casualise toward a fast-typing traveller's register + a sparing
  // warm emoji (personaHumanize), THEN the hash-uniqueness variance
  // (humanizeVariant). stripWaFormatting is the LAST step, so no markdown/`*`
  // artifact from ANY upstream stage (composer or variance) can reach the shop.
  // A human's own typed message is only formatting-scrubbed, never reworded.
  // B4: an already-humanized (parked) row is delivered verbatim - only the
  // idempotent formatting scrub runs, so its slot hash stays STABLE across the
  // concurrent drainers and exactly one delivery happens.
  // B2/B4: the humanization is SEEDED from the message identity (sender + shop +
  // the composed text), so the SAME input always yields the SAME output. This
  // restores the copy engine's determinism contract and, together with
  // humanize-once, guarantees two drainers hash a parked row identically.
  // The pass itself lives in `humanizeForOutbound` so the park paths
  // (parkOutboxOnce, the mass route's stagger slots) run the IDENTICAL chain
  // at enqueue - which is what makes the drain's `alreadyHumanized: true`
  // premise actually true.
  // W4.7: WHERE IN THE THREAD THIS MESSAGE IS, decided here and nowhere else.
  // A `null` (unreadable) falls back to the caller's hint and then to "not the
  // first", because the defect being closed is a repeated greeting: an extra
  // greeting is the bug, a missing one on a genuine opener is a wording nit.
  const priorSend = await hasMessagedShopBefore(opts.senderKey, opts.toDigits).catch(() => null);
  const firstOutbound = priorSend === null ? opts.firstOutbound === true : priorSend === false;
  // W4.7b: A PARKED ROW'S POSITION IS RE-DECIDED AT SEND TIME, NOT FROZEN AT
  // PARK TIME. `alreadyHumanized` correctly means "do not re-roll the variance"
  // (that is the idempotency-hash contract above) - but it was also silently
  // freezing the GREETING decision a caller made minutes or hours earlier. The
  // mass route computes its own `isNewIntro` from a 500-row `knownNumbers` set
  // matched by exact string, so a traveller with more recipient rows than that,
  // or a shop whose stored spelling differs from this hunt's discovery result,
  // parked a fresh "Hi there!" into a thread that was already open - and the
  // drain never re-asked. Now it does, but only on POSITIVE evidence
  // (`priorSend === true`, i.e. a thread demonstrably exists) and only with the
  // deterministic strip, never a re-humanize:
  //   - deterministic + idempotent, so re-guarding the same row yields the same
  //     bytes and the idempotency slot hash stays stable for the claim,
  //   - positive-evidence-only, so an unreadable database cannot rewrite a
  //     parked body (it is left verbatim, exactly as before),
  //   - never ADDS a greeting: a parked opener that turns out to be first stays
  //     as it was composed.
  const repositioned =
    opts.alreadyHumanized && priorSend === true ? stripLeadingGreeting(opts.text) : opts.text;
  const text = opts.auto
    ? opts.alreadyHumanized
      ? stripWaFormatting(repositioned)
      : humanizeForOutbound(opts.senderKey, opts.toDigits, opts.text, { firstOutbound })
    : opts.text;
  const now = Date.now();
  // STRICT read: a null means the DB is unreachable RIGHT NOW. The guard must
  // never treat that as "fresh healthy number" - see the sync-retry hold
  // below the queue helper. Manual sends keep the permissive default (a human
  // pressing Send must not be blocked by our own outage).
  const repStrict = await getReputationStrict(opts.senderKey);
  const rep =
    repStrict ??
    ({ sender_key: opts.senderKey, trust_score: 20, sent_total: 0, replies_total: 0, last_send_at: null } as Reputation);

  // DISPATCH FACTS SURVIVE THE QUEUE. The mass route knows Google's "open
  // now" and the batch's 15-minute deadline at click time; the drain used to
  // re-guard parked rows blind to both, so a sibling of an immediate send
  // could be re-parked on facts dispatch had already refuted. Both now ride
  // the row's meta and are honored on every path.
  const shopOpenNow =
    typeof opts.shopOpenNow === "boolean"
      ? opts.shopOpenNow
      : typeof opts.meta?.openNow === "boolean"
        ? (opts.meta.openNow as boolean)
        : undefined;
  const batchDeadlineMs = Number(opts.meta?.batchDeadline);
  // A pacing-class hold on a fast-dispatch batch may defer INSIDE the batch
  // window, never past it - the 15-minute promise belongs to the batch, and
  // a per-message rule must not silently re-author it. Safety holds (pause,
  // ban recovery, fail-closed sync retries, breakers, burst rests, the
  // min-gap floor) are deliberately NOT routed through this.
  const boundToBatch = (iso: string): string => {
    if (!p.fast_dispatch) return iso;
    if (!Number.isFinite(batchDeadlineMs) || batchDeadlineMs <= now) return iso;
    const at = Date.parse(iso);
    if (!Number.isFinite(at) || at <= batchDeadlineMs) return iso;
    const floor = now + HARD_MIN_GAP_SEC * 1000;
    return new Date(Math.max(Math.min(at, batchDeadlineMs), floor)).toISOString();
  };

  /**
   * @param rescheduled  This hold is a NEW deliberate schedule, not a bounce.
   *   `firstDueAt` is the drain's "this row was due and did not go" stamp, and
   *   the 6h freshness ceiling charges every later re-park against it. That is
   *   right for a row losing claims in a loop. It is wrong for a row the guard
   *   has just told to wait twelve hours for a shop to reply: the row is
   *   serving a wait we gave it, and outbox-policy's own doctrine says such a
   *   wait must not be charged - which is why a cold introduction parked at
   *   22:00 for a 09:00 opening is not binned the second it becomes eligible.
   *   Clearing the stamp restarts the freshness clock on the new schedule. The
   *   absolute `created_at` wall still bounds it, so this can defer a row, never
   *   immortalise one.
   */
  const queue = async (
    notBefore: string,
    reason: string,
    rescheduled?: boolean
  ): Promise<GuardVerdict> => {
    // THE DURABLE HOLD TRAIL (owner report 3, items 4+8): the reason used to
    // live only on the mutable outbox row - overwritten per re-park, deleted
    // on send. Append-only + throttled, so "why did this sit for six hours"
    // has a history the message-path view can read back. Never the send path:
    // fire-and-forget, and the helper swallows every failure.
    {
      const { recordHoldEvent } = await import("./wa/hold-events");
      void recordHoldEvent({
        senderKey: opts.senderKey,
        toNumber: opts.toDigits,
        reason,
        until: notBefore,
        outboxRowId: opts.outboxRowId,
        decisionId:
          typeof opts.meta?.decisionId === "string" ? (opts.meta.decisionId as string) : undefined,
        msgKind: typeof opts.meta?.kind === "string" ? (opts.meta.kind as string) : undefined,
      });
    }
    if (opts.queueIfBlocked !== false) {
      // ALREADY A ROW: this send came off the queue and is only being re-timed.
      // Patching it keeps one row per message, so the shop stays continuously
      // visible and no insert can fail in a way that loses the message.
      if (opts.outboxRowId) {
        const { releaseOutboxRow } = await import("./wa/outbox-lifecycle");
        const held = await releaseOutboxRow(opts.outboxRowId, notBefore, {
          ...(opts.meta ?? {}),
          reason,
          ...(rescheduled ? { firstDueAt: null } : {}),
        });
        return held
          ? { allow: false, reason: `${reason} - queued`, queuedUntil: notBefore, text, outboxRowId: opts.outboxRowId }
          : { allow: false, reason, text };
      }
      const parked = await sbInsert("wa_outbox", [
        {
          sender_key: opts.senderKey,
          to_number: opts.toDigits,
          // SEATBELT: `to_key` is newer than some databases this code can
          // reach. Naming it unconditionally 400s the whole insert there, and
          // this park is what every NON-drain caller of the guard depends on -
          // they would be handed {allow:false} with no row and no queuedUntil,
          // i.e. told "queued" with nothing queued. See wa/outbox-columns.
          ...(await outboxToKeyPatch(opts.toDigits)),
          body: text,
          not_before: notBefore,
          // Keep the human reason with the row so the queue viewer explains why.
          meta: { ...(opts.meta ?? {}), reason },
        },
      ]);
      // B4: the partial unique index (sender_key,to_number) rejects a SECOND
      // pending automated row for the same shop. A failed insert is therefore
      // ambiguous: DB outage, OR a pending row for this shop already exists (a
      // genuine duplicate we WANT to suppress). Disambiguate: if a pending
      // automated row is already there, this send is effectively queued - report
      // success against that row instead of creating a duplicate.
      if (!parked) {
        const kind = typeof opts.meta?.kind === "string" ? (opts.meta.kind as string) : "";
        if (kind !== "custom" && kind !== "human-manual") {
          const existing = await sbSelect<{ not_before: string }>(
            "wa_outbox",
            `select=not_before&sender_key=eq.${encodeURIComponent(opts.senderKey)}` +
              `&to_number=eq.${encodeURIComponent(opts.toDigits)}` +
              `&order=not_before.asc&limit=1`
          ).catch(() => []);
          if (existing[0]) {
            return { allow: false, reason: `${reason} - already queued`, queuedUntil: existing[0].not_before, text };
          }
        }
      }
      // Only claim queuedUntil when the row ACTUALLY persisted. If the insert
      // failed (DB blip / the 8s fetch timeout), returning queuedUntil would
      // make the drain's needsRepark believe the row is safely parked and DROP
      // the claimed (already-deleted) row - silent data loss. Omitting it makes
      // needsRepark re-park via the drain's own belt (a second insert attempt);
      // the idempotency preflight + msg claim slot prevent a double-send if the
      // first insert actually landed but its response timed out.
      if (parked) {
        // Read the id back so Ops can point at the exact row. One extra query,
        // only on the path that is already parking a message, and a failure to
        // find it costs a join and nothing else - never the send.
        const mine = await sbSelect<{ id: number }>(
          "wa_outbox",
          `select=id&sender_key=eq.${encodeURIComponent(opts.senderKey)}` +
            `&to_number=eq.${encodeURIComponent(opts.toDigits)}&order=id.desc&limit=1`
        ).catch(() => [] as { id: number }[]);
        return {
          allow: false,
          reason: `${reason} - queued`,
          queuedUntil: notBefore,
          text,
          outboxRowId: mine[0]?.id,
        };
      }
      return { allow: false, reason, text };
    }
    return { allow: false, reason, text };
  };

  // KIND-BASED reply test for the gates that run BEFORE the recipient row is
  // read (isNewContact does not exist yet up here). Same rule as the drain's
  // isReplyRow and REPLY_KIND_FILTER: an automated send whose kind is not a
  // cold intro or a human message is a reply-lane send. Used to make every
  // fail-closed hold LANE-PROPORTIONAL (owner report 4, item 3): the safety
  // posture is identical - nothing sends while the state is unknown - but a
  // reply re-checks in 1-2 minutes where a cold intro waits 5-10, because the
  // drain's own re-park backoff already treats the lanes 15x apart and these
  // holds disagreeing with it was pure added latency on an engaged shop.
  const kindStr = String(opts.meta?.kind ?? "");
  const replyKind =
    opts.auto === true && kindStr !== "rfq" && kindStr !== "custom" && kindStr !== "human-manual";
  const syncRetryHold = () =>
    replyKind ? jitteredHold(now, 1, 1) : jitteredHold(now, 5, 5);

  // -3. FAIL CLOSED ON UNKNOWN SAFETY STATE. If the reputation row (pause
  //     state, trust, caps history) is unreadable, an automated send holds
  //     briefly instead of assuming "brand-new healthy number" - a Supabase
  //     blip must never disable the anti-ban engine.
  if (opts.auto && repStrict === null) {
    return await queue(syncRetryHold(), "sync-retry");
  }

  // -2. CANCELLATION TOMBSTONE + HUMAN TAKEOVER - the two absolute vetoes.
  //     Every automated path (outbox drain, wakeup re-composition, retries)
  //     converges here, so enforcing the user's "remove"/"I've got this chat"
  //     at this choke point is what makes them PERMANENT. Distinctions:
  //       cancelled === true  -> refuse outright (never queued, never retried;
  //                              the drain drops non-queued rejections)
  //       cancelled === null  -> the tombstone table is unreadable RIGHT NOW:
  //                              the truth is unknown, so fail CLOSED - hold
  //                              briefly and let a later drain re-check. A
  //                              missing (un-migrated) table reads as false.
  if (opts.auto) {
    // THE ONE TOMBSTONE EXEMPTION: the deal-close closing message. Confirming
    // a deal tombstones EVERY shop in the same request that parks the closing
    // message - so without this carve-out the tombstone swallowed the very
    // message that tells the shop the deal is on (the traveller booked; the
    // shop never heard). A tombstone means "nothing AUTOMATED chases this
    // shop"; the closing message is the traveller's own explicit action,
    // parked only for pacing. Takeover below still applies - if the human is
    // typing themselves, even the closing message stays ours to not send.
    const isDealClose =
      (opts.meta as { kind?: string } | null | undefined)?.kind === "deal-close";
    const { isCancelled, recordSuppressedSend } = await import("./wa/cancellations");
    if (!isDealClose) {
      const cancelled = await isCancelled(opts.senderKey, opts.toDigits);
      if (cancelled === true) {
        void recordSuppressedSend(opts.senderKey, opts.toDigits, "cancelled-send-blocked");
        return {
          allow: false,
          terminal: true,
          reason: "cancelled-by-user - you removed the messages to this shop",
          text,
        };
      }
      if (cancelled === null) {
        return await queue(syncRetryHold(), "sync-retry");
      }
    }
    {
      const { isThreadTakenOver } = await import("./session-flags");
      let takeover: boolean | null;
      try {
        takeover = await isThreadTakenOver(opts.senderKey, opts.toDigits);
      } catch {
        takeover = null; // unreadable -> fail closed below
      }
      if (takeover === true) {
        void recordSuppressedSend(opts.senderKey, opts.toDigits, "takeover-send-blocked");
        return {
          allow: false,
          terminal: true,
          reason: "human takeover - you are chatting with this shop yourself",
          text,
        };
      }
      if (takeover === null) {
        // UNKNOWN takeover state (store unreadable): takeover is an absolute
        // veto, so an automated send fails CLOSED - hold and re-check later
        // rather than risk posting into a thread the human took over. Mirrors
        // the cancellation null-path above. (This block runs only for auto.)
        return await queue(syncRetryHold(), "sync-retry");
      }
    }
  }

  // -1. IDEMPOTENCY / DEDUP PRE-FLIGHT. Never send the EXACT same text to the
  //     same shop twice in a short window - this is the hard stop against a
  //     message loop (the "agent sent the same message again" bug). Compares
  //     the normalized body against this sender's recent outbound to this
  //     number.
  //
  //     DELIBERATELY PERMISSIVE, AND CHECKED. An audit flagged this read (and
  //     the rfq-dedup below it) as fail-open: sbSelect answers [] on an outage,
  //     so isDup is false and the send proceeds. That is true in isolation and
  //     wrong in context, which is why it stays as it is:
  //
  //       - For opts.auto - the only path where a loop can run unattended - an
  //         outage is already caught THREE times above, at -3 (repStrict, which
  //         getReputationStrict returns null for on `unavailable` and ONLY on
  //         `unavailable`), at -2 (cancelled === null) and at -2 again
  //         (takeover === null). All three hold and re-check. An automated send
  //         cannot reach this line while Supabase is unreadable.
  //       - For a manual send there is a human who just pressed the button.
  //         Refusing it because a dedup read blipped is the worse direction:
  //         the failure it would prevent is one possibly-repeated message, and
  //         the failure it would cause is a person unable to talk to a shop.
  //
  //     Converting this to a strict read would add a fourth hold on a path that
  //     already holds, and a first refusal on a path that should not.
  {
    const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
    const recentOut = await sbSelect<{ body: string | null }>(
      "whatsapp_messages",
      `select=body&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        opts.senderKey
      )}&received_at=gte.${encodeURIComponent(
        new Date(now - 6 * 3600_000).toISOString()
      )}&order=received_at.desc&limit=8${numberFilter("to_number", opts.toDigits)}`
    );
    const isDup = recentOut.some(
      (m) => (m.body ?? "").replace(/\s+/g, " ").trim().toLowerCase() === normalized
    );
    if (isDup) {
      void recordSendDropped(opts.senderKey, opts.toDigits, "duplicate message suppressed (idempotency)", opts.meta);
      return { allow: false, terminal: true, reason: "duplicate message suppressed (idempotency)", text };
    }
  }

  // -0.5. ONE RFQ PER SHOP PER DAY. A fresh opening question into a thread
  //       where we ALREADY asked recently ("do you have a 125cc scooter...?"
  //       twice in one morning) screams bot - the text differs, the question
  //       is the same. Auto RFQs to a number that already received an RFQ from
  //       this sender in the last 24h are dropped (never queued); the existing
  //       conversation is the place to continue.
  if (opts.auto && opts.meta?.kind === "rfq") {
    const priorRfq = await sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        opts.senderKey
      )}&raw->>kind=eq.rfq&received_at=gte.${encodeURIComponent(
        new Date(now - 24 * 3600_000).toISOString()
      )}&limit=1${numberFilter("to_number", opts.toDigits)}`
    );
    if (priorRfq.length > 0) {
      void recordSendDropped(opts.senderKey, opts.toDigits, "rfq-dedup - this shop was already asked in the last 24h", opts.meta);
      return {
        allow: false,
        terminal: true,
        reason: "rfq-dedup - this shop was already asked in the last 24h",
        text,
      };
    }
  }

  // IS THIS A COLD CONTACT? THE ONE QUESTION THAT DECIDED EVERYTHING, ASKED WRONG.
  //
  // `isNewContact` is the whole lane switch. It gates the introductions budget
  // (whose hold is clamped to business hours - a hold measured in HOURS), the
  // reply-rate breaker, the delivery-rate breaker, the hourly cap, and via
  // `isReply` both the burst lane and the min-gap keying. Getting it wrong in
  // the "new" direction does not slow a reply down slightly; it governs a
  // reply to a shop that just messaged us under the rules written for cold
  // outreach to a stranger, and the shop waits hours for an answer we already
  // composed. That is exactly the reported symptom: fast for some shops,
  // silent for hours for others, while the Ops panel shows the reply ready.
  //
  // Two independent defects, and the second is the one that bit hardest.
  //
  // 1. THE NUMBER WAS MATCHED EXACTLY. This table is WRITTEN tail-keyed by
  //    `upsertRecipient` for the reason spelled out above: the shop's reply
  //    carries WhatsApp's spelling of the number while our introduction carried
  //    discovery's. Reading it with `to_number=eq.` is the same bug this file
  //    already solved everywhere else - `numberFilter` is the tolerant,
  //    tail-aware primitive, and it was simply not used here.
  //
  // 2. THE READ FAILED OPEN. `sbSelect` collapses every failure to `[]`, and
  //    `[] -> length === 0 -> isNewContact = true`. So an unreadable table, a
  //    brownout, a timeout - each one silently reclassified every reply in the
  //    fleet as a cold introduction. "I could not find a prior message" and "I
  //    could not read the table" are opposite facts and they arrived as the
  //    same empty array.
  //
  // So this is now a THREE-state answer, and the unknown case leans WARM.
  // That direction is deliberate and it is the safe one: WhatsApp's ban
  // signals are about unsolicited outreach to people who never replied, not
  // about answering someone who wrote to you first. Treating an unknown
  // recipient as warm risks sending one reciprocal message slightly too
  // quickly; treating it as cold risks the product not working at all.
  // The read doubles as the opt-out lookup. `opted_out_at` is newer than some
  // databases this code can reach (the park.ts to_key seatbelt, same class):
  // naming an unknown column would 400 the WHOLE select and silently degrade
  // contactState to "unknown" on every pre-migration install, so the column
  // only joins the select once the probe has seen it. Ordered so an opted-out
  // row always surfaces first when a shop is stored under two spellings.
  const hasOptOutCol = (await tableReady("wa_recipient_state", "opted_out_at")) === "ready";
  const priorRecipient = await sbSelectStrict<{ id: number; opted_out_at?: string | null }>(
    "wa_recipient_state",
    `select=id${hasOptOutCol ? ",opted_out_at&order=opted_out_at.desc.nullslast" : ""}` +
      `&sender_key=eq.${encodeURIComponent(opts.senderKey)}` +
      `&limit=1${numberFilter("to_number", opts.toDigits)}`
  );
  const contactState: "new" | "known" | "unknown" =
    "rows" in priorRecipient
      ? priorRecipient.rows.length > 0
        ? "known"
        : "new"
      : priorRecipient.error === "missing"
        ? // The table has never existed (fresh install). Vacuously empty is an
          // honest "new" - failing warm here would let a brand-new deployment
          // blast cold intros with no pacing at all.
          "new"
        : "unknown";
  const isNewContact = contactState === "new";

  // 0.-1 THE SHOP SAID STOP, AND STOP IS FOREVER.
  //
  //      A recipient who reports or blocks a number is WhatsApp's single
  //      strongest ban signal, and the message before a block is almost always
  //      some spelling of "stop writing to me". Once the inbound path stamps
  //      `opted_out_at` (lib/inbound-risk detectOptOutIntent ->
  //      markRecipientOptedOut), this veto refuses EVERY future send - and
  //      unlike the tombstone/takeover vetoes above it deliberately binds
  //      MANUAL sends and later hunts too: the shop's request was about being
  //      contacted at all, not about which button produced the message.
  //      Terminal, never queued, never retried; the drop leaves a durable
  //      trace. An unreadable row proceeds (the auto path is already held at
  //      -3 during an outage; refusing a manual send on a read blip is the
  //      wrong direction for a boundary we may not even have on record).
  //      The process-local set (audit F013) is consulted BESIDE the row read:
  //      when the stamp did not land, this instance still refuses the turn
  //      the stop arrived in and everything it drains afterwards.
  if (
    ("rows" in priorRecipient && priorRecipient.rows.some((r) => r.opted_out_at)) ||
    optedOutLocally(opts.senderKey, opts.toDigits)
  ) {
    void recordSendDropped(
      opts.senderKey,
      opts.toDigits,
      "opted-out - this shop asked not to be messaged again",
      opts.meta
    );
    return {
      allow: false,
      terminal: true,
      reason: "opted-out - this shop asked not to be messaged again",
      text,
    };
  }

  //      ...AND STOP IS FLEET-WIDE (owner decision). The per-sender stamp above
  //      only protects the traveller the shop said it to; the fleet store is
  //      what stops a DIFFERENT traveller cold-introducing the same shop the
  //      next day - a Meta policy signal and an anti-ban risk under Evolution,
  //      and structurally mandatory under a single company number. Checked for
  //      COLD contacts only: a shop mid-conversation with THIS traveller has
  //      its own per-sender state, and an unreadable store proceeds (the
  //      per-sender veto above still stands).
  if (isNewContact) {
    const { shopSuppression } = await import("./wa/suppression");
    const sup = await shopSuppression(opts.toDigits).catch(
      () => ({ suppressed: false }) as { suppressed: boolean }
    );
    if (sup.suppressed) {
      void recordSendDropped(
        opts.senderKey,
        opts.toDigits,
        "suppressed - this shop asked WheelDeal not to contact it",
        opts.meta
      );
      return {
        allow: false,
        terminal: true,
        reason: "suppressed - this shop asked WheelDeal not to contact it",
        text,
      };
    }
  }

  // 0.0 THE OWNER'S KILL SWITCH, ENFORCED WHERE SENDS ACTUALLY HAPPEN.
  //
  //     KILL_SWITCH was checked in six API routes - vendors, geocode, outreach,
  //     mass outreach, recheck, checkout - and in NONE of the paths that
  //     actually put a message on WhatsApp. So flipping it stopped new searches
  //     while every already-queued introduction and every agent reply kept
  //     going out: the one control the owner has for "stop, something is
  //     wrong" did not stop the thing most worth stopping.
  //
  //     Automated sends PARK rather than fail, so nothing is lost - the queue
  //     drains by itself once the switch goes back off. A human's own typed
  //     message is deliberately still allowed: the switch halts the agents, and
  //     a person deciding to message a shop themselves is not the agents.
  //
  //     killSwitchOn() now fails CLOSED on an unreadable vault (see usage.ts),
  //     which is why this parks with a short re-check rather than a long hold.
  if (opts.auto) {
    const { killSwitchOn } = await import("./usage");
    if (await killSwitchOn()) {
      return await queue(jitteredHold(now, 6, 4), "paused by the operator (kill switch)");
    }
  }

  // 0. GLOBAL ACCOUNT PAUSE - a number the risk engine (or a real WhatsApp
  //    restriction) has quarantined sends nothing until the pause expires.
  //    This is the graduated ban-recovery guard from the research.
  //
  //    REPLY CARVE-OUT (owner report 4, item 3): the pause still BINDS every
  //    send - nothing goes out while it is on - but a parked REPLY re-checks
  //    on a bounded 10-15min cadence instead of inheriting the pause's whole
  //    horizon. The risk engine clears pauses early when the signal subsides,
  //    and a reply stamped for the original 4h wall sat parked long after the
  //    pause had lifted. A genuine BAN-RECOVERY pause (many hours out) keeps
  //    holding replies at its own horizon until it enters its final stretch -
  //    that one is account-level and the recovery schedule IS the treatment.
  // 0.a THE LINK IS DEAD - STOP TOUCHING THE TRANSPORT.
  //
  //     THE WORST DEFECT THIS FILE EVER HAD, and it lived in the gap between
  //     two modules that were each individually correct.
  //
  //     When WhatsApp closes a session with 401 - which is the ordinary shape
  //     of a restriction, and also of "log out from linked devices" - ingest
  //     calls `markClosed` and writes `wa_sessions.status = "close"`. Good. But
  //     NO send path ever read that column. So the guard kept allowing queued
  //     rows, `sendFromUser` kept calling `ensureConnected`, and
  //     `ensureConnected` fires `POST /instance/create` + `GET /instance/connect`
  //     unconditionally - a FRESH DEVICE REGISTRATION against the number
  //     WhatsApp had just severed. The drain classified the failure as
  //     "reconnecting" (transient) and re-parked every 45-120s for 24 hours.
  //
  //     `ANTI-BAN.md`'s runbook opens with "do NOT send anything from the
  //     restricted number during the countdown - every attempt during a
  //     restriction is a fresh strike", and evolution.ts calls this exact loop
  //     "a known restriction vector". The code did the opposite, automatically,
  //     overnight, to a traveller's personal number.
  //
  //     WHY THE GATE IS HERE AND NOT A `banRisk` FLAG. The tempting fix is to
  //     make a non-pairing 401 set `banRisk: true` and enter a 24h recovery.
  //     That would be wrong: the identical code is what a user deliberately
  //     unlinking produces, and punishing that with a day-long pause invents a
  //     restriction that does not exist. The honest statement is narrower -
  //     "there is no live link, so there is nothing to send through" - and it
  //     is true for BOTH causes. A re-pair flips the row back to open and the
  //     queue resumes by itself.
  //
  //     Parks rather than drops: the traveller's messages are not lost, they
  //     wait for the link. Manual sends get a plain refusal to show.
  //     Fails OPEN on an unreadable row - an outage must not freeze a healthy
  //     number, and every other gate below still applies.
  {
    const link = await sbSelectStrict<{ status: string | null }>(
      "wa_sessions",
      `select=status&email=eq.${encodeURIComponent(opts.senderKey)}&limit=1`
    ).catch(() => ({ error: "unavailable" }) as const);
    if ("rows" in link && link.rows[0]?.status === "close") {
      if (opts.auto) {
        // RESCHEDULED, because this is a wait we gave the row and not a bounce.
        // Without the flag `firstDueAt` survives every 30-40 minute re-park and
        // the 6h outbox freshness ceiling bins the whole queue about six hours
        // into a disconnection - while the traveller is asleep and has not yet
        // had a chance to re-pair. The comment below promised their messages
        // were waiting for the link; this is what makes that true. The 24h
        // absolute wall still bounds them.
        return await queue(
          jitteredHold(now, 30, 10),
          "whatsapp link is disconnected - waiting for a re-pair (not sending, so the number is not struck again)",
          true
        );
      }
      return {
        allow: false,
        reason: "Your WhatsApp link is disconnected - reconnect it and this will send.",
        text,
      };
    }
  }

  if (rep.paused_until && Date.parse(rep.paused_until) > now) {
    if (opts.auto) {
      // A BAN-RECOVERY PAUSE STILL BINDS REPLIES - but it re-checks, it does
      // not sleep for four hours. The lane split lives in `pauseRecheckAt`
      // (wa/pacing) as a pure function, because as an inline ternary here the
      // only thing that could test it was a regex - and inverting the
      // condition passed the whole suite.
      const until = pauseRecheckAt({
        nowMs: now,
        pausedUntilIso: rep.paused_until,
        isNewContact,
      });
      return await queue(until, "number paused (ban-risk recovery)");
    }
    return { allow: false, reason: "This number is paused for safety recovery.", text };
  }

  // 0.05 COLD-LANE HOLD - WhatsApp returned an error ack on a FIRST CONTACT
  //      (see recordSendError). That is the observable fingerprint of the
  //      scoped new-chat restriction, so we stop opening new conversations.
  //
  //      Deliberately NOT a global pause: replies to shops that already wrote
  //      back keep flowing. A reply is the one thing that clears the
  //      unanswered-thread counter this restriction meters, so halting the
  //      reply lane would deepen the exact condition being punished.
  if (
    opts.auto &&
    opts.meta?.kind === "rfq" &&
    rep.cold_hold_until &&
    Date.parse(rep.cold_hold_until) > now
  ) {
    return await queue(
      rep.cold_hold_until,
      "waiting on replies before opening more conversations"
    );
  }

  // 0.1 USER SESSION PAUSE - "Will, hold everything". Automated sends queue
  //     for an hour with an honest reason; the user's own explicit sends
  //     (custom messages) still go through - the pause binds the AGENTS.
  if (opts.auto) {
    const { isSessionPaused } = await import("./session-flags");
    let paused: boolean | null;
    try {
      paused = await isSessionPaused(opts.senderKey);
    } catch {
      paused = null; // unreadable -> fail closed below
    }
    if (paused === true) {
      // SHORT hold, jittered so a batch paused together does not RELEASE
      // together. It used to be 60-75 min, which made the pause the single
      // slowest thing in the app: a traveller who resumed still watched
      // "sends in ~64 min" because the parked rows kept their hour. Resume now
      // releases them outright (wa/resume-queue), and this hold is only the
      // backstop for a resume that happened somewhere this instance cannot see
      // - so it re-checks in minutes, not in an hour. A still-paused row simply
      // re-parks; nothing is sent while the hold is on.
      return await queue(jitteredHold(now, 6, 4), "paused by you");
    }
    if (paused === null) {
      // UNKNOWN pause state (store unreadable): "hold everything" is absolute,
      // so an automated send fails CLOSED - brief sync-retry hold, not a send.
      return await queue(syncRetryHold(), "sync-retry");
    }
  }

  // 1. TWO-WAY ENGAGEMENT HALT. Never send a second AUTOMATED message to a
  //    number until it has engaged - a reply OR at least a read receipt (blue
  //    tick). Delivered-but-ignored contacts are the #1 spam signal, so we do
  //    NOT keep pushing them.
  //    A fresh RFQ is EXEMPT: an RFQ only ever originates from an explicit
  //    user action (a search batch or an "Ask for price" tap), and the same
  //    doctrine that lets a user action clear a cancellation tombstone
  //    applies - the user re-initiating IS the signal. The 24h rfq-dedup
  //    above still blocks a repeat ask; this halt is for the AGENT's own
  //    follow-ups. (Before this exemption, re-selecting a shop from an
  //    earlier silent batch was terminally dropped with no trace - the shop
  //    then surfaced as "removed by you".)
  const freshUserRfq = opts.meta?.kind === "rfq";
  if (opts.auto && p.engagement_halt && !isNewContact && !freshUserRfq) {
    // Scoped to THIS sender: another user's thread with the same shop must
    // never trip (or clear) this user's engagement halt.
    const lastOut = await sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        opts.senderKey
      )}&order=received_at.desc&limit=1${numberFilter("to_number", opts.toDigits)}`
    );
    if (lastOut[0]) {
      const inboundSince = await sbSelect<{ id: number }>(
        "whatsapp_messages",
        // PRIVACY + correctness: only replies THIS user's WhatsApp received
        // count as engagement (another user's thread with the same shop must
        // never clear this user's halt). Legacy unstamped rows fall back to
        // the durable wa_recipient_state check below.
        // Number matching is TOLERANT here or the halt reads a real reply as
        // silence: the shop's inbound row carries WhatsApp's spelling while
        // `toDigits` carries discovery's, and an exact match between them made
        // an engaged shop look ignored - which TERMINALLY dropped our answer.
        `select=id&direction=eq.inbound&raw->>receiver=eq.${encodeURIComponent(
          opts.senderKey
        )}&received_at=gte.${encodeURIComponent(
          lastOut[0].received_at
        )}&limit=1${numberFilter("from_number", opts.toDigits)}`
      );
      // ...AND THE SECOND PROBE HAD THE SAME SPELLING BUG THE FIRST ONE FIXED.
      //
      // The `lastInbound` read directly above already goes through
      // `numberFilter` for exactly the reason its comment gives. This one, four
      // lines later and feeding the SAME terminal branch, still matched
      // `to_number` exactly - so a shop stored under discovery's spelling read
      // as "never replied, never read" and helped condemn a composed answer.
      const stateRead = await sbSelectStrict<{ read: boolean; last_reply_at: string | null }>(
        "wa_recipient_state",
        `select=read,last_reply_at&sender_key=eq.${encodeURIComponent(opts.senderKey)}` +
          `&limit=1${numberFilter("to_number", opts.toDigits)}`
      );
      // AN UNREADABLE PROBE MUST NOT DELETE A COMPOSED REPLY.
      //
      // Both probes ran through the permissive reader, so a Supabase blip
      // answered `[]` - "this shop never replied" - and the branch below is
      // TERMINAL: drainOutbox calls completeOutboxRow, which DELETEs the row.
      // No lease, no re-park, no retry. The agent's answer to a shop that had
      // genuinely quoted was destroyed by a few seconds of database trouble,
      // and the traveller saw a shop that made an offer and was never answered.
      //
      // Terminal is the right verdict for "the shop has not replied". It is the
      // wrong verdict for "I could not find out". Unknown re-parks instead, so
      // the next drain asks again.
      // No `terminal`, no `queuedUntil`: that is exactly the shape `needsRepark`
      // (wa/outbox-policy.ts:20-25) reads as "non-terminal reject that did not
      // re-queue", and the drain re-parks it on its own proportional backoff -
      // 20-40s for a reply, minutes for a cold intro. Inventing a timestamp here
      // would duplicate a decision that already has one owner.
      if ("error" in stateRead && stateRead.error === "unavailable") {
        return {
          allow: false,
          reason: "checking whether the shop replied - will retry shortly",
          text,
        };
      }
      const state = "rows" in stateRead ? stateRead.rows : [];
      // A READ RECEIPT IS NOT ENGAGEMENT - it is the opposite.
      //
      // `state[0]?.read` used to satisfy this test, so a blue tick unlocked a
      // second automated message. But a read receipt means the shop opened the
      // chat and chose NOT to answer. On the axis that meters unanswered new
      // chats, that thread is still unanswered, and following up on someone who
      // deliberately declined to reply is a stronger spam signal than following
      // up on someone who never saw the message at all.
      //
      // It also made the UI copy false: we told travellers "one conversation
      // per shop per day" while a blue tick quietly authorised another. Only a
      // real inbound reply counts now - either a stamped message row, or
      // last_reply_at for legacy rows that predate the receiver stamp.
      const engaged = inboundSince.length > 0 || Boolean(state[0]?.last_reply_at);
      if (!engaged) {
        // INVARIANT: A REPLY CANNOT BE UNANSWERED SPAM. A row stamped
        // `composedAgainst` a real inbound was, by construction, composed as an
        // ANSWER to something this shop said - so when this probe reads "never
        // replied", the probe is wrong (a number spelling both filters still
        // missed, replication lag, a blipped read), not the thread. Falling
        // through to terminal would DELETE a composed answer to a shop that
        // demonstrably engaged - the same incident class the unreadable-probe
        // branch above exists to prevent. Bounded re-park instead: the next
        // drain re-asks, and the row's own expiry bounds the loop. Proactive
        // follow-ups on silent threads carry no stamp and stay terminally
        // halted below - unanswered-thread pressure is exactly what this gate
        // meters.
        const stamped = (
          opts.meta as { composedAgainst?: { inboundId?: string; inboundAt?: string } } | undefined
        )?.composedAgainst;
        if (stamped && (stamped.inboundId || stamped.inboundAt)) {
          return await queue(
            jitteredHold(now, 1, 1),
            "engagement probe disagrees with the reply's own inbound receipt - rechecking"
          );
        }
        // TERMINAL drop, not a re-park. A 2nd automated message to a shop that
        // has not REPLIED is the #1 spam signal, so we do not send it - and
        // we must not leave it perpetually re-parking in the queue either (that
        // is what kept a duplicate follow-up visible forever and burned drain
        // cycles). If the shop later engages, a fresh turn composes a new
        // message that passes this halt. The drop leaves a durable trace -
        // this branch used to write NOTHING, making it indistinguishable from
        // a user removal after the fact.
        void recordSendDropped(opts.senderKey, opts.toDigits, "engagement-halt: the shop has not replied yet", opts.meta);
        return {
          allow: false,
          terminal: true,
          reason: "engagement-halt: the shop has not replied yet",
          text,
        };
      }
    }
  }

  // 2. RECIPIENT BUSINESS HOURS - never message a shop at 3 AM local time.
  //    Priority of truth:
  //      a) Google "open now" (opts.shopOpenNow) - the SAME signal the card
  //         shows the user, so the app never says "open" then queues as "closed".
  //      b) The recipient's local clock, timezone resolved from the region
  //         string first, then the phone prefix.
  //      c) If the timezone is genuinely unknown, DO NOT queue - a false
  //         "closed" on an open shop is the worse bug (issue #21).
  // COLD INTROS ONLY (owner report 3, reply-latency stall). This block used to
  // key on `opts.auto` alone, so a REPLY re-guarded more than 30 minutes after
  // the shop's last inbound - a parked row draining, a shop that stepped away
  // for lunch - parked until 08:00 local, while the config comment promised
  // "active replies already skip it". A reply continues a thread the shop
  // opened; answering it late at night is what humans do, and it is the one
  // send class WhatsApp does not meter. `isNewContact` fails WARM on an
  // unreadable read (W-14), so an outage lands replies in the exempt lane.
  if (opts.auto && isNewContact && shopOpenNow !== true) {
    // ACTIVE-CONVERSATION OVERRIDE: if this shop wrote to THIS user within the
    // last 30 minutes, they are demonstrably at the phone RIGHT NOW - queuing
    // a reply "until the shop opens" would be absurd (and was: a deal-close on
    // a live chat once queued for "opening hours" on a wrong-timezone number).
    // Tolerant number matching here too: this probe decides whether a shop that
    // is demonstrably at the phone right now gets an answer, or gets told to
    // wait until "opening hours". Matching `from_number` exactly meant the
    // override silently never fired for any shop whose WhatsApp spelling
    // differed from discovery's - the exact population this override exists for.
    const recentInbound = await sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.inbound&raw->>receiver=eq.${encodeURIComponent(
        opts.senderKey
      )}&received_at=gte.${encodeURIComponent(
        new Date(now - 30 * 60_000).toISOString()
      )}&limit=1${numberFilter("from_number", opts.toDigits)}`
    ).catch(() => []);
    const activelyChatting = recentInbound.length > 0;
    const { off, known } = resolveOffset(opts.toDigits, region);
    // FAST DISPATCH (owner directive): a new user's whole batch must go out
    // within ~10 min, so cold intros are NOT deferred to shop-open - even when
    // Google reports the shop closed right now. The message simply waits unread
    // until they open. This lifts the Google-closed park below (the clock gate
    // is lifted separately via ignore_business_hours).
    if (!activelyChatting && shopOpenNow === false && !p.fast_dispatch) {
      // Google says closed. If it is DAYTIME at the shop (lunch break, late
      // opening), retry within the hour instead of parking until tomorrow
      // morning - the old behavior turned a 13:00 opening into a 22h wait.
      const localH = (new Date().getUTCHours() + new Date().getUTCMinutes() / 60 + off + 24) % 24;
      const daytime = known && localH >= p.business_hour_start && localH < p.business_hour_end;
      const until = daytime
        ? new Date(Date.now() + (45 + Math.random() * 30) * 60_000).toISOString()
        : nextBusinessOpen(opts.toDigits, p, region);
      return await queue(until, "shop is closed now");
    }
    // The CLOCK-window gate (not the Google "closed now" gate above) is what the
    // 24/7 dial lifts: ignore_business_hours (PACING_MODE=fast) skips ONLY this,
    // so a fast-mode burst goes out at any hour, while a shop Google reports
    // DEFINITELY closed right now still parks above - a definitively-closed shop
    // won't reply, and blasting it hurts reply-rate (a real ban signal).
    if (known && !activelyChatting && !p.ignore_business_hours) {
      const localHour =
        (new Date().getUTCHours() + new Date().getUTCMinutes() / 60 + off + 24) % 24;
      const inWindow = localHour >= p.business_hour_start && localHour < p.business_hour_end;
      if (!inWindow) {
        return await queue(
          boundToBatch(nextBusinessOpen(opts.toDigits, p, region)),
          "outside recipient business hours"
        );
      }
    }
    // unknown timezone => allow (never false-queue an open shop)
  }

  // 3. COLD-OUTREACH GOVERNOR (only for brand-new first contacts - the highest
  //    ban-risk action). Combines: daily new-contact cap, reply-rate circuit
  //    breaker, and delivery-rate circuit breaker (double-tick < threshold).
  if (opts.auto && isNewContact) {
    // ROLLING-WINDOW introductions budget (plan-tiered, continuously
    // refreshing: free 10/6h, pro 15/4h, ultra 24/3h). When it is spent, hold
    // to when the next slot frees - at most windowHours away, clamped into the
    // shop's business hours - NEVER a hard "tomorrow morning" wall. Capacity
    // comes back gradually as the oldest introduction ages out of the window.
    const budget = await newContactBudget(opts.senderKey, plan).catch(() => null);
    const windowHours = Math.max(1, planCapacity(plan).windowHours);
    if (budget && budget.remaining <= 0) {
      // Bounded by the plan's own window - a budget wait is a pace, never a
      // wall (and the clamp stands down entirely under fast dispatch).
      // The plan window bounds a PLAN-WINDOW hold. Meter A and Meter B do not
      // clear on that clock at all, so bounding their hold by it is what
      // produced the hourly re-park - and the 6h outbox ceiling then binned a
      // shop the traveller had picked. Give the slow ceilings a slow recheck.
      const holdHours = budget.bind === "window" || !budget.bind ? windowHours : 12;
      // ...AND A CEILING IS NOT A SCHEDULE. `boundHold` only ever caps a hold,
      // and `newContactBudget` re-anchors `nextFreeAt` for the `unanswered`
      // bind ALONE - the monthly and daily ceilings fall through to its
      // now+1h fallback. So raising holdHours to 12 did nothing for them: they
      // kept re-parking hourly, ~24 full guard passes a day per row, while
      // `rescheduled` simultaneously stopped the 6h ceiling from ever clearing
      // the queue. A slow ceiling has to be a FLOOR under the wait as well as a
      // cap over it, or the row spins against a state that does not move.
      const slowFloor =
        budget.bind === "monthly" || budget.bind === "daily"
          ? new Date(now + holdHours * 3600_000).toISOString()
          : budget.nextFreeAt;
      const anchor =
        Date.parse(slowFloor) > Date.parse(budget.nextFreeAt) ? slowFloor : budget.nextFreeAt;
      const until = boundHold(
        clampToBusinessHours(anchor, opts.toDigits, p, region),
        now,
        holdHours
      );
      // A SLOW CEILING IS A SCHEDULE, NOT A BOUNCE. Meter A does not clear on
      // any clock the row can wait out inside the 6h freshness ceiling, so
      // charging the row for that wait binned shops the traveller had picked -
      // silently, while the app was still telling them the shops were coming.
      return await queue(until, introHoldReason(budget.bind), budget.bind !== "window");
    }
    // Reply-rate breaker: if enough recent history exists and almost nobody
    // engages, freeze cold outreach - that pattern is what actually trips
    // WhatsApp's filters. HOLD (queue), never DROP: on the drain path the row
    // was already claimed, so a bare !allow would silently LOSE the message.
    //
    // WINDOWED, ENGAGEMENT-BASED - deliberately not the lifetime ratio it
    // used to be. replies_total/sent_total latches: the denominator grows
    // with every send while the numerator depends on inbound ingest actually
    // recording replies, so one ingest defect froze every future batch
    // permanently - and the unconditional business-hours clamp then rolled
    // the 2-4h hold to the NEXT MORNING (the 05:38 incident). The window
    // measures the last 7 days, a READ receipt counts as engagement (reads
    // are recorded even when a reply's text is dropped), the freeze
    // self-expires inside the plan window, and it never crosses the night
    // under fast dispatch.
    const win = await coldEngagementWindow(opts.senderKey);
    if (win && win.intros >= p.min_reply_samples) {
      const rate = win.engaged / Math.max(1, win.intros);
      if (rate < p.min_reply_rate) {
        const until = boundHold(
          clampToBusinessHours(
            new Date(now + (2 + Math.random() * 2) * 3600_000).toISOString(),
            opts.toDigits,
            p,
            region
          ),
          now,
          windowHours
        );
        return await queue(
          until,
          `reply-rate circuit breaker (${(rate * 100).toFixed(0)}% < ${(p.min_reply_rate * 100).toFixed(0)}%) - cold outreach frozen to protect the number`
        );
      }
    }
    // Delivery-rate breaker (research: double-tick threshold ~60%). Delivery
    // receipts flow through message-update events, not text ingest, so the
    // lifetime counters stay live here - but the hold is bounded and no
    // longer rolls across the night.
    if ((rep.delivered_total || 0) >= 8) {
      const delivRate = (rep.delivered_total || 0) / Math.max(1, rep.sent_total || 0);
      if (delivRate < 0.6) {
        const until = boundHold(
          clampToBusinessHours(
            new Date(now + (2 + Math.random() * 2) * 3600_000).toISOString(),
            opts.toDigits,
            p,
            region
          ),
          now,
          windowHours
        );
        return await queue(
          until,
          `delivery-rate breaker (${(delivRate * 100).toFixed(0)}% delivered) - number may be soft-restricted`
        );
      }
    }
  }

  // 4. DYNAMIC VOLUME CAPS (velocity vector) - trust-scaled, warm-up ramped,
  //    with a per-day random wobble so a fixed cap is not itself a pattern.
  const jitter = dailyCapJitter(opts.senderKey, p);
  // The hourly cap must NEVER fall below the plan's conversation budget - the
  // downward daily-wobble (0.8x) would otherwise drop a new ultra number's cap
  // to ~32 and split its own 40-intro burst an hour out. Floor it at the budget
  // so the full first-session batch always fits inside one hour.
  const hourCap = Math.max(
    planCapacity(plan).newContacts,
    Math.round(dynamicHourCap(rep, p, plan) * jitter)
  );
  // THE DAY CEILING RAMPS TOO - but it can never gag a reply.
  //
  // Only the INTRO budget was age-scaled, so a number linked this morning was
  // allowed the same ~176-264 sends/day as a six-month-old one. The 2026
  // warm-up consensus for a fresh number is 10-20 messages on day one, and the
  // reply lane is exempt from the hourly cap entirely - so the daily ceiling
  // was the only thing standing between a day-0 tester and a hundred messages.
  //
  // The ramp bites on the ceiling; the FLOOR keeps the lane that matters open.
  // Reciprocal traffic is what WhatsApp rewards, and refusing to answer a shop
  // that just wrote to us would both look broken and hurt the reply ratio that
  // protects the number - so a warmed-down ceiling still leaves room for a
  // full day of real conversation. Cold introductions are separately capped by
  // `newContactBudget`, which is where the hard day-one limit actually lives.
  const warmMeasuredRate =
    (rep.sent_total || 0) >= p.min_reply_samples ? replyRate(rep) : null;
  const warmDay = warmupNewContactFactor(ageDaysOf(rep), p.warmup_days, warmMeasuredRate);
  // THE FLOOR IS ON THE RAMP, NOT ON THE OWNER'S NUMBER.
  //
  // This was `Math.max(WARMUP_DAY_FLOOR, round(day_cap * jitter * warmDay))`,
  // which raises ANY owner-set `day_cap` below 40 back up to 40. Since the
  // ramped default (220) never approaches the floor anyway, the floor's only
  // observable effect was to neutralise the owner's own clamp: follow the WA
  // security panel's own advice, set day_cap to 30 while watching a wobbling
  // number, and the effective ceiling is 40 - HIGHER than what was typed. A
  // dial that saves and does nothing is exactly what wave D existed to stop.
  //
  // Clamping the MULTIPLIER instead keeps what the floor was for - a warmed-down
  // number must still be able to answer a full day of real conversation, because
  // reciprocal traffic is what protects it - while leaving `day_cap` meaning
  // what the owner set. A number whose owner has clamped it to 10 gets 10.
  const rampFloor = p.day_cap > 0 ? Math.min(1, WARMUP_DAY_FLOOR / p.day_cap) : 1;
  const dayCap = Math.max(1, Math.round(p.day_cap * jitter * Math.max(warmDay, rampFloor)));
  // STRICT read: an unreadable send history must hold automated sends (fail
  // closed), never count as "0 sent today" (fail open = unlimited sends the
  // moment the DB blips - the exact outage-mode failure the guard exists for).
  const sentRes = await sbSelectStrict<{
    received_at: string;
    to_number: string;
    kind?: string | null;
  }>(
    "whatsapp_messages",
    // `kind` is the outbox row's own meta.kind, spread into `raw` at send time
    // (see the insert at the end of drainOutbox). It is what separates a COLD
    // first-contact ("rfq") from an engaged reply, and the burst guard below
    // needs that separation - without it a cold batch's velocity parks a
    // counter-reply for half an hour.
    `select=received_at,to_number,kind:raw->>kind&direction=eq.outbound&to_number=not.in.(session,takeover,cancel)&raw->>sender=eq.${encodeURIComponent(
      opts.senderKey
    )}&received_at=gte.${encodeURIComponent(
      new Date(now - 24 * 3600_000).toISOString()
    )}&order=received_at.desc&limit=300`
  );
  if ("error" in sentRes && sentRes.error === "unavailable" && opts.auto) {
    return await queue(syncRetryHold(), "sync-retry");
  }
  const sentRows = "rows" in sentRes ? sentRes.rows : [];
  // Count messages ALREADY PARKED in the outbox for this sender toward the
  // HOURLY window (only) when they are actually due within the next hour, so
  // concurrent auto-replies do not all read the same pre-send count and blow
  // past the hourly cap. A batch parked for later must NOT wedge today's
  // replies into the same hold (the cascade that stamped ten messages with one
  // identical ETA). NOTE: parked rows are deliberately NOT counted toward the
  // DAILY cap below - a large legitimately-staggered batch would otherwise trip
  // its OWN daily ceiling (1 sent + 38 parked >= 39) and get almost entirely
  // deferred; concurrency for the daily total is already serialized by the send
  // claims, so the daily cap is a pure ceiling on ACTUAL sends.
  const pendingForSender = await sbSelect<{ id: number; not_before: string }>(
    "wa_outbox",
    `select=id,not_before&sender_key=eq.${encodeURIComponent(opts.senderKey)}&limit=300`
  ).catch(() => []);
  // Count ONLY genuinely-imminent parked rows (due within one min-gap) toward
  // the hourly cap - that is the concurrency case this guard is for (N replies
  // all due NOW each reading the same pre-send count). Counting the whole next
  // HOUR made a deliberately-staggered batch trip its OWN cap: every future
  // sibling was counted, so `sent + pendingDueSoon` hit the cap on the first
  // drain and the drain re-stamped the rest an hour out - the "it said 17:34
  // then jumped to 18:34" bug. A future-scheduled row is not concurrent.
  const dueWindow = new Date(now + Math.max(1, p.min_gap_seconds) * 1000).toISOString();
  const pendingDueSoon = pendingForSender.filter((r) => r.not_before <= dueWindow).length;
  const hourAgo = new Date(now - 3600_000).toISOString();
  const lastHour = sentRows.filter((r) => r.received_at >= hourAgo).length + pendingDueSoon;
  // The hourly cap governs COLD OUTREACH velocity (new first-contacts) - that is
  // the ban vector. A REPLY to an already-engaged shop (one that messaged us) is
  // the safest send there is, and must NOT be throttled just because the user's
  // 40-intro burst already filled this hour - otherwise an engaged shop waits
  // ~an hour for its counter-reply, killing negotiation momentum. Replies stay
  // bounded by the burst window, the min-gap, stealth pacing and the daily cap.
  if (isNewContact && lastHour >= hourCap) {
    // STABLE hold: anchor to when the rolling hour actually frees (the oldest
    // send in the window ages out at oldest+1h), NOT a fresh now+15-35min that
    // every drain re-stamps forward ("came back an hour later, everything
    // moved another 30 min"). sentRows is DESC, so the last in-window row is
    // the oldest.
    const inHour = sentRows.filter((r) => r.received_at >= hourAgo);
    const oldestInHour = inHour.length ? Date.parse(inHour[inHour.length - 1].received_at) : now;
    const freeAt = Math.max(now + 90_000, oldestInHour + 3600_000);
    const jitterMs = Math.floor(Math.random() * 3 * 60_000);
    return await queue(
      new Date(freeAt + jitterMs).toISOString(),
      `hourly cap reached (${hourCap}/h at trust ${rep.trust_score})`
    );
  }
  if (sentRows.length >= dayCap) {
    // QUEUE, never DROP: on the drain path the row was already claimed
    // (deleted), so a bare !allow would silently lose it (the "sent a few then
    // the rest vanished" bug). Anchor the hold to when the rolling 24h window
    // actually frees - the oldest send ages out at oldest+24h.
    //
    // THE CLAMP IS COLD-LANE ONLY (owner report 4, item 3). This was the one
    // remaining `clampToBusinessHours` on a path a REPLY could reach, and the
    // module that owns the clamp names it as the cause of the "answer landed
    // at 05:38 next morning" incident. A capped COLD batch resuming inside
    // the shop's morning is politeness; a capped REPLY snapped to 08:00 is a
    // dead negotiation - the shop already wrote to us, so the reply resumes
    // the moment capacity frees, exactly like gate #2 already exempts replies
    // from business hours.
    const oldest = sentRows.length
      ? Date.parse(sentRows[sentRows.length - 1].received_at)
      : now;
    const freeAt = Math.max(now + 5 * 60_000, oldest + 24 * 3600_000);
    const freeIso = new Date(freeAt).toISOString();
    const until = isNewContact
      ? clampToBusinessHours(freeIso, opts.toDigits, p, region)
      : freeIso;
    return await queue(until, `daily cap reached (${dayCap}/day) - resumes as capacity frees`);
  }

  // PREDICTIVE STEALTH: how risky does this number look RIGHT NOW? Below the
  // hard pause, a rising score stretches the min-gap and tightens burst - a
  // graduated, self-clearing slowdown that reacts to real feedback before a ban.
  const stealth = stealthFactor(computeRisk(rep, p).score, p.risk_pause_threshold);

  // 5. BURST COOLDOWN - even within caps, N sends in a short window is a robotic
  //    burst. After a burst, enforce a longer rest before the next send.
  //
  //    TWO LANES, TWO BUDGETS. This used to be one counter over every outbound
  //    row, and it was the only real coupling left between cold outreach and
  //    engaged conversation: a 40-intro batch is BUILT to fill a 600s window,
  //    so the moment it did, the next counter-reply inherited a 30-MINUTE
  //    cooldown it had done nothing to earn. That is the Ko Tao shape - shop
  //    quotes at 12:22, our answer lands at 12:39.
  //
  //    A reply to a number that messaged US is not the vector this guard
  //    exists for (unsolicited first contact is), so it is counted on its own
  //    lane, against its own ceiling, and cooled in SECONDS. What still bounds
  //    it: the daily cap above (all sends), the per-recipient min-gap below,
  //    the fleet gap and the recipient mutex in wa/pacing. Nothing was traded
  //    away here - the reply lane simply stopped paying the cold lane's fine.
  const isReply = opts.auto && !isNewContact;
  const burstWindowAgo = new Date(now - p.burst_window_seconds * 1000).toISOString();
  const burstRows = sentRows.filter((r) => r.received_at >= burstWindowAgo);
  const inBurst = burstRows.length;
  // Burst tolerance scales with the plan's hourly headroom; stealth tightens it
  // when the number is in the danger zone. Fresh/low-trust numbers keep the floor.
  const burstMax = Math.max(
    3,
    Math.round(Math.max(p.burst_max_in_window, Math.ceil(hourCap * 0.7)) / stealth)
  );
  if (opts.auto && isReply) {
    // Replies only. A row with no recorded kind predates this field; treat it
    // as cold (the conservative read - it keeps such a row OUT of the reply
    // budget rather than silently inflating it).
    const replyBurst = burstRows.filter((r) => r.kind && r.kind !== "rfq").length;
    // A pathological-loop backstop, not a pacer: at the plan's conversation
    // budget every live thread could legitimately answer twice inside one
    // window. Below this ceiling the fleet gap is what actually paces replies.
    const replyMax = Math.max(burstMax, planCapacity(plan).newContacts * 2);
    if (replyBurst >= replyMax) {
      const newestReply = burstRows.find((r) => r.kind && r.kind !== "rfq");
      const anchor = newestReply ? Date.parse(newestReply.received_at) : now;
      const cool = (45 + Math.random() * 45) * 1000;
      return await queue(
        new Date(Math.max(now, anchor) + cool).toISOString(),
        `reply burst cooldown (${replyBurst} in ${p.burst_window_seconds}s)`
      );
    }
  } else if (opts.auto && inBurst >= burstMax) {
    const newest = sentRows[0] ? Date.parse(sentRows[0].received_at) : now;
    const until = new Date(newest + p.burst_cooldown_minutes * 60_000).toISOString();
    return await queue(until, `burst cooldown (${inBurst} in ${p.burst_window_seconds}s)`);
  }

  // 6. ANTI-ROBOTIC MINIMUM GAP with jitter (never two sends back-to-back). The
  //    gap is stretched by the stealth factor when the number looks risky, so a
  //    wobbling number instantly paces slower without a hard freeze.
  //    REPLY LANE: a counter-reply to an already-engaged shop paces against the
  //    last send TO THAT SHOP - not the sender-global last send - so 40 live
  //    threads never queue behind one another (the "one shop at a time" bug).
  //    A human juggling many chats answers several within a minute; only the
  //    SAME shop is min-gap paced. Cold intros keep the strict per-sender gap.
  let lastSendRefMs = 0;
  if (isReply) {
    const toDig = digitsOnly(opts.toDigits);
    for (const r of sentRows) {
      if (digitsOnly(r.to_number) !== toDig) continue;
      const t = Date.parse(r.received_at);
      if (Number.isFinite(t) && t > lastSendRefMs) lastSendRefMs = t;
    }
  } else if (rep.last_send_at) {
    const t = Date.parse(rep.last_send_at);
    if (Number.isFinite(t)) lastSendRefMs = t;
  }
  if (lastSendRefMs > 0) {
    // THE REPLY LANE PAYS THE REPLY GAP, NOT THE COLD ONE.
    //
    // `reply_gap_seconds` (5) exists, is configured, and is honoured by
    // `claimForSend` further down - but this gate used the cold constant for
    // every lane, so answering a shop we had messaged 20 seconds earlier could
    // sit on a 12-28s hold for no anti-ban reason at all. Unsolicited first
    // contact is the vector this gap defends against; a reply to a number that
    // just wrote to us is the reciprocal traffic WhatsApp actually rewards, and
    // making it slow hurts the reply ratio that protects the number.
    const gapBase = isReply ? p.reply_gap_seconds : p.min_gap_seconds;
    const gapJitter = isReply ? Math.min(p.gap_jitter_seconds, 4) : p.gap_jitter_seconds;
    const gapNeeded = (gapBase + Math.random() * gapJitter) * 1000 * stealth;
    const since = now - lastSendRefMs;
    if (opts.auto && since < gapNeeded) {
      const reason = stealth > 1.3 ? "easing off to keep your number safe" : "human pacing gap";
      return await queue(new Date(now + (gapNeeded - since)).toISOString(), reason);
    }
  }

  return { allow: true, text };
}

/** Book-keeping after a successful send (trust decay, new-contact count). */
export async function afterSend(senderKey: string, toNumber?: string): Promise<void> {
  await recordOutboundSend(senderKey, toNumber);
}

// ---------------------------------------------------------------------------
// Outbox drain - serverless-friendly queue (no cron needed)
// ---------------------------------------------------------------------------

// The row shape lives with the lifecycle that owns it (wa/outbox-lifecycle) -
// one definition, so a surface reading a row and the drain writing one cannot
// drift apart on what a queued message is.

/**
 * Send every due queued message. Called opportunistically from the inbound
 * webhook and the WA status poll, so the queue drains while the app is alive
 * without a dedicated worker.
 */
/**
 * Is this parked draft still an answer to the conversation as it stands - and
 * if not, drop it AND make sure something else speaks.
 *
 * Returns true when the row was consumed (dropped + re-triggered), false when
 * the caller should carry on and send it.
 *
 * Every read here fails OPEN. A draft that cannot be judged is sent, because
 * the alternative - deleting a correct message because one query blipped -
 * trades a visible failure for an invisible one, and the re-trigger would need
 * the same database that just failed.
 */
async function staleDraftDropped(
  row: { id: number; sender_key: string; to_number: string; meta: unknown },
  rowKind: string | undefined
): Promise<boolean> {
  // Cold introductions answer nothing, and a user's own typed message is theirs
  // to send. Only auto REPLIES can go stale. The deal-close closing message is
  // exempt too: "the deal is on" stays true whatever the shop said in between,
  // and the recompose a stale-drop schedules would never re-say it (the
  // session is already closed) - dropping it here loses the booking handoff.
  if (
    rowKind === "rfq" ||
    rowKind === "custom" ||
    rowKind === "human-manual" ||
    rowKind === "deal-close"
  )
    return false;
  const meta = (row.meta ?? {}) as { composedAgainst?: import("./wa/freshness").ComposedAgainst };
  const composedAgainst = meta.composedAgainst;
  if (!composedAgainst) return false; // parked before this shipped - not our business

  try {
    // ONE ASKER, SHARED WITH THE INLINE SEND PATH (wa/freshness-live.ts). The
    // drain and the in-request send must never disagree about what "stale"
    // means, or a draft refused here would go straight out there.
    const { threadMovedOn } = await import("./wa/freshness-live");
    const verdict = await threadMovedOn({
      senderKey: row.sender_key,
      toNumber: row.to_number,
      composedAgainst,
      kind: rowKind,
    });
    if (!verdict.stale) return false;

    // The row is gone. Say so loudly - a silent drop is how a thread dies.
    await completeOutboxRow(row.id);
    await insertPathEvent({
      kind: "wa-send-stale",
      user_email: row.sender_key,
      to_number: row.to_number,
      vendor_name: String((row.meta as { vendorName?: string } | null)?.vendorName ?? row.to_number),
      detail: `${verdict.reason}: ${verdict.detail ?? ""}`.slice(0, 300),
    });

    // ...and make sure the shop still hears from us. The newer inbound may have
    // had no turn of its own; this schedules one, and the wakeup drain applies
    // its own per-thread claim so a turn already in flight is not duplicated.
    const { threadKeyFor } = await import("./graph/state");
    const threadKey = threadKeyFor(row.sender_key, row.to_number);
    const base = {
      kind: "tick",
      thread_key: threadKey,
      not_before: new Date(Date.now() + 2_000).toISOString(),
      payload: { reason: "stale-draft-recompose" },
    };
    const ok = await sbInsert("graph_wakeups", [{ ...base, user_email: row.sender_key }]).catch(
      () => false
    );
    if (!ok) await sbInsert("graph_wakeups", [base]).catch(() => {});
    return true;
  } catch {
    return false; // unreadable => send, never delete on a blip
  }
}

/**
 * What counts as an ENGAGED REPLY, as a complete PostgREST fragment
 * (leading `&` included - it is an `or=` group, not a column predicate).
 *
 * One definition, shared by the drain's reply select and the reply
 * dispatcher's "when is the next one due?" probe, so the lane can never
 * disagree with itself about what it is carrying.
 *
 * A ROW WITH NO `kind` WAS INVISIBLE TO THE ENTIRE FAST LANE.
 *
 * This was `meta->>kind=not.in.(rfq,custom,human-manual)`. When `meta` carries
 * no `kind` at all, `meta->>kind` is SQL NULL, and `NOT (NULL IN (...))` is
 * NULL - not true. PostgREST keeps only rows where the predicate is TRUE, so
 * every kind-less row was excluded from the reply select AND from the reply
 * dispatcher's next-due probe.
 *
 * Meanwhile the drain's own `isReplyRow` treats an undefined kind as a REPLY.
 * So the two halves of the lane disagreed about the same row: the dispatcher
 * could not see it, and the drain, when it eventually picked it up on the
 * general pass, called it a reply. The row was not lost - it just never moved
 * on the fast lane, only on whatever slow sweep happened along. Any park that
 * forgets to stamp `meta.kind` silently loses its 2-minute SLA.
 *
 * Spelling it as an explicit `or` makes the NULL case a decision rather than an
 * accident, and matches `isReplyRow`: no kind means reply.
 */
export const REPLY_KIND_FILTER =
  "&or=(meta->>kind.is.null,meta->>kind.not.in.(rfq,custom,human-manual))";

export type DrainOptions = {
  /**
   * Carry ONLY engaged replies. The reply dispatcher sets this so a cold batch
   * - however large, however stalled - is not even in its result set.
   */
  replyOnly?: boolean;
  /** Restrict to one user's rows (the reply dispatcher is per-sender). */
  senderKey?: string;
  /**
   * WALL-CLOCK CEILING for the whole invocation, ms (W-beta30).
   *
   * The candidate loop had no elapsed-time check at all - only SLEEPS were
   * bounded (waitAllowanceMs). One loaded invocation can therefore run far
   * past its caller's own deadline: a worst-case send is ~29s (two 12s
   * evoFetch shapes + reconnect + presence + jitter), so 8 reply sends plus
   * per-sender colds is 60-180s against Cloud Run's `--timeout 90` and Cloud
   * Scheduler's 60s attempt deadline. The kill leaves every claimed row
   * invisible for CLAIM_LEASE_MS (3 min) and its in-flight send ambiguous -
   * and at 30-user load the same overload recurs on the next invocation.
   *
   * With a budget the loop simply stops taking new candidates and the
   * existing re-park machinery reports the remainder honestly.
   */
  budgetMs?: number;
};

export async function drainOutbox(
  send: (
    senderKey: string,
    to: string,
    text: string,
    // WHICH BUDGET THIS ROW DRAWS FROM. The drain already knows - `isCold`
    // reads meta.kind - and used to throw the fact away, so every send was
    // metered against one shared pool and a full batch starved its own
    // replies. Passing it is the whole fix.
    lane?: "intro" | "reply"
  ) => Promise<SendResult>,
  opts?: DrainOptions
): Promise<number> {
  const due = new Date().toISOString();
  // `created_at` is the only honest measure of a message's age (see
  // wa/outbox-policy) - and it is newer than some databases this code can
  // reach, so it is asked for only when the cached schema probe says it is
  // there. Naming a missing column would 400 BOTH selects and take the whole
  // drain down, which is a far worse failure than a weaker staleness ceiling.
  const hasCreatedAt = (await tableReady("wa_outbox", "created_at")) === "ready";
  const cols = `select=id,sender_key,to_number,body,not_before,meta${
    hasCreatedAt ? ",created_at" : ""
  }`;
  const senderFilter = opts?.senderKey
    ? `&sender_key=eq.${encodeURIComponent(opts.senderKey)}`
    : "";
  // TWO SELECTS, AND THE REPLY ONE IS NOT OPTIONAL.
  //
  // There has always been a priority sort below, and its comment has always
  // promised that an engaged shop never waits behind a cold batch. But the sort
  // ran on rows that had already survived a GLOBAL `not_before.asc LIMIT 48`
  // across every user - so once a stalled batch left more than 48 overdue
  // introductions, a fresh reply due seconds ago was not in the list at all and
  // the sort never saw it. A ranking cannot rescue what the query dropped.
  //
  // Asking for replies in their own query makes the promise structural: they
  // are in the pool whatever the cold queue is doing.
  const replyQuery =
    `${cols}&not_before=lte.${pgTimestamp(due)}${REPLY_KIND_FILTER}` +
    `${senderFilter}&order=not_before.asc&limit=24`;
  const [replyRows, anyRows] = await Promise.all([
    sbSelect<OutboxRow>("wa_outbox", replyQuery).catch(() => [] as OutboxRow[]),
    // The reply lane runs on its OWN dispatcher (api/wa/reply-tick) and must not
    // touch the cold batch: that is the whole point of a second lane. Only the
    // general drain asks for everything.
    opts?.replyOnly
      ? Promise.resolve([] as OutboxRow[])
      : sbSelect<OutboxRow>(
          "wa_outbox",
          `${cols}&not_before=lte.${pgTimestamp(due)}${senderFilter}&order=not_before.asc&limit=48`
        ),
  ]);
  const byId = new Map<number, OutboxRow>();
  for (const r of [...replyRows, ...anyRows]) byId.set(r.id, r);
  const dueRows = [...byId.values()];
  // PRIORITY: an engaged shop waiting on our reply must never sit behind a cold
  // introductions batch due at the same moment (the "our agents never message
  // back" report). The rule lives in outbox-policy so it is unit-pinned.
  //
  // ...and PLAN breaks the tie inside a kind. Priority processing has been on
  // the Pro and Ultra plan cards since they shipped and was never built: the
  // sort knew about message kind and nothing else, so a paying traveller's
  // reply sat behind a free user's reply that happened to be due a second
  // earlier. It is deliberately a tie-break and not a queue-jump - a paid cold
  // introduction still waits behind anyone's live reply, because an engaged
  // shop is the more urgent thing in the system whoever is paying.
  const { compareOutboxRows, outboxExpired, OUTBOX_MAX_AGE_MS } = await import("./wa/outbox-policy");
  const keyOf = (row: OutboxRow) => {
    const meta = row.meta as { kind?: string; plan?: string } | null;
    return { kind: meta?.kind ?? null, plan: meta?.plan ?? null, notBefore: row.not_before };
  };
  const candidates = [...dueRows].sort((a, b) => compareOutboxRows(keyOf(a), keyOf(b))).slice(0, 30);
  const { claimSendSlots, releaseMessageClaim, gcSendClaims } = await import("./wa/pacing");
  const p = await getPolicies();
  let sent = 0;
  // Per-invocation drain budgets. COLD INTROS (rfq) stay strictly paced per
  // sender (2/invocation) - new-number velocity is the ban vector. REPLIES to
  // engaged shops drain CONCURRENTLY: at most one per shop per invocation (never
  // double-send a shop) up to an overall paced ceiling, so many live threads
  // advance together instead of one-at-a-time. The tick self-chains, so any
  // overflow drains within ~a minute rather than in a burst.
  const isCold = (row: OutboxRow) => (row.meta as { kind?: string } | null)?.kind === "rfq";
  const rfqBySender = new Map<string, number>();
  const replySentToRecipient = new Set<string>();
  // Modest per-invocation reply budgets: the ATOMIC fleet gap slot (in
  // claimSendSlots) is the real velocity ceiling now, so a high budget here just
  // churns doomed claims. Frequent invocations (polls + the self-chaining tick)
  // supply the throughput; each drains a few and the fleet gap paces the total.
  //
  // PER SENDER, like the cold lane's rfqBySender - the old single global
  // counter meant one busy traveller consumed the whole fleet's reply
  // allowance in the cron drain, and everyone else's replies waited a full
  // cadence for a queueing artefact. A small global ceiling still bounds the
  // invocation's total work.
  const replyBySender = new Map<string, number>();
  const REPLY_PER_SENDER = 3;
  // GLOBAL REPLY CEILING, SCALED TO THE FLEET (W-beta30).
  //
  // A flat 8 per invocation was a queueing artefact at fleet scale, not a
  // safety limit: the real velocity ceiling is the ATOMIC per-sender fleet
  // gap in claimSendSlots, and that is per-sender by construction. So with
  // 30 senders each holding one due reply, a flat 8 forced ceil(30/8) = 4
  // drain cycles - the last traveller's reply waiting 2.5-5 minutes for a
  // number the pacing layer would have let through immediately.
  //
  // Scale it with the number of DISTINCT senders that actually have work
  // (3 each, matching REPLY_PER_SENDER), capped so one invocation still
  // cannot run unbounded. The per-sender lanes and the wall-clock budget
  // above are what keep this honest.
  const dueReplySenders = new Set(
    candidates.filter((c) => !isCold(c)).map((c) => c.sender_key)
  ).size;
  let replyGlobalBudget = Math.max(8, Math.min(24, dueReplySenders * REPLY_PER_SENDER));
  // The wait-not-repark allowance (see the claim block below): how much of
  // this invocation may be spent SLEEPING to a lane's bucket edge instead of
  // re-parking. Bounded so a burst of contended replies cannot hold the
  // request slot indefinitely; per-loss the ceiling is one lane window.
  const REPLY_WAIT_CEILING_MS = 8_000;
  let waitAllowanceMs = 15_000;
  // The invocation's own deadline (see DrainOptions.budgetMs). Default 45s:
  // comfortably inside Cloud Run's 90s kill and Cloud Scheduler's 60s attempt
  // deadline, with room for the response itself.
  const drainDeadline = Date.now() + Math.max(5_000, opts?.budgetMs ?? 45_000);
  let stoppedForBudget = 0;
  for (const cand of candidates) {
    // STOP TAKING WORK, do not abandon work in flight. Rows not reached stay
    // unclaimed and due, so the next invocation (or the self-chaining tick)
    // picks them up immediately - which is strictly better than being killed
    // mid-send and leaving them leased-and-invisible for three minutes.
    if (Date.now() > drainDeadline) {
      stoppedForBudget += 1;
      continue;
    }
    // TOO OLD TO SEND. `not_before <= now` is a floor, not a ceiling: a row
    // overdue by three days passed it exactly as well as one overdue by three
    // seconds. That was survivable while nothing drained automatically. With a
    // scheduler calling this every minute it is not - and the freshness gate
    // cannot save us, because NEVER_STALE exempts cold introductions, so an
    // ancient "do you have one for tomorrow?" is judged fresh and goes out.
    const candMeta = (cand.meta ?? {}) as OutboxMeta;
    // The wave this row belongs to (stamped at enqueue), needed by EVERY
    // re-stamp on this row - including the over-budget one below, which runs
    // before the claim and therefore before `release()` exists.
    const waveEndsAt = Number(candMeta.waveEndsAt) || null;
    const firstDueAt = Number(candMeta.firstDueAt) || null;
    if (
      outboxExpired(
        { createdAt: cand.created_at, firstDueAt, notBefore: cand.not_before },
        Date.now()
      )
    ) {
      await completeOutboxRow(cand.id);
      await insertPathEvent({
        kind: "wa-send-expired",
        user_email: cand.sender_key,
        to_number: cand.to_number,
        vendor_id: String((cand.meta as { vendorId?: string } | null)?.vendorId ?? ""),
        vendor_name: String(
          (cand.meta as { vendorName?: string } | null)?.vendorName ?? cand.to_number
        ),
        detail: `Binned a message to +${cand.to_number} (sender ${cand.sender_key}) composed ${cand.created_at ?? cand.not_before} and stuck in the queue since ${
          firstDueAt ? new Date(firstDueAt).toISOString() : cand.not_before
        } - older than the ${Math.round(OUTBOX_MAX_AGE_MS / 3600_000)}h ceiling. Sending it now would answer a question the traveller has moved on from.`,
      });
      continue;
    }
    // STAMPED ONCE, HERE, BEFORE ANY BRANCH CAN RE-PARK THE ROW. Every path
    // below rewrites `not_before`, so this is the last moment at which "when
    // did this row first get a real chance to go?" is still knowable.
    const dueSince = firstDueAt ?? Date.now();
    const cold = isCold(cand);
    // Keyed on the SHOP, not the spelling (audit F036) - the same canonical key
    // the recipient mutex claims on, so a reply row under the JID spelling and
    // a row under Google's national spelling count as one recipient here too.
    const rcptKey = `${cand.sender_key}|${outboxKey(cand.to_number)}`;
    const overCap = cold
      ? (rfqBySender.get(cand.sender_key) ?? 0) >= 2
      : replyGlobalBudget <= 0 ||
        (replyBySender.get(cand.sender_key) ?? 0) >= REPLY_PER_SENDER ||
        replySentToRecipient.has(rcptKey);
    if (overCap) {
      // SMOOTH the remainder so the NEXT drain doesn't instantly fire it either
      // (a slow-motion burst). Cold intros are held 2-4 min - velocity to new
      // numbers is the ban risk. A REPLY is over budget for two reasons only:
      // this invocation's ceiling is spent, or this shop already got a message
      // - and both clear in seconds now that the recipient mutex and the fleet
      // gap are the real pacers. It used to wait 30-90s here for a queueing
      // artefact, on top of everything else, which is how a "reply in seconds"
      // target quietly became minutes.
      //
      // THE WAVE CLAMP BELONGS HERE MOST OF ALL. This branch handles "the
      // rest" of every cold wave - the drain sends two intros per sender per
      // invocation and re-parks everything else through exactly this line - and
      // it was the one re-stamp that skipped `clampRestampToWave`, which was
      // wired only into the post-claim `release()`. So the burst that waves
      // exist to contain bled straight across its own silence, wave after
      // wave, while the clamp guarded a path that handles a handful of rows.
      const overCapReason = cold
        ? "batch-spacing - your agent opens shops a few at a time"
        : "human pacing gap";
      await sbUpdate("wa_outbox", `id=eq.${cand.id}`, {
        not_before: new Date(
          clampRestampToWave(
            cold
              ? Date.parse(jitteredHold(Date.now(), 2, 2))
              : Date.now() + (RECIPIENT_LOCK_SEC + 2 + Math.random() * 6) * 1000,
            waveEndsAt
          )
        ).toISOString(),
        meta: { ...candMeta, firstDueAt: dueSince, reason: overCapReason },
      }).catch(() => {});
      // THE DOMINANT HOLD IN THE WHOLE SYSTEM, AND IT LEFT NO TRAIL. hold-events
      // promises "every queue() verdict appends a wa-hold event" and
      // message-path.ts is built to read that history back - but this re-park
      // and the duplicate-claim one below are the drain's own, made with a
      // direct write, so neither wrote anything at all. The message-path view
      // showed a row that had been re-parked forty times as a row nothing had
      // ever happened to.
      {
        const { recordHoldEvent } = await import("./wa/hold-events");
        void recordHoldEvent({
          senderKey: cand.sender_key,
          toNumber: cand.to_number,
          reason: overCapReason,
          outboxRowId: cand.id,
          decisionId:
            typeof candMeta.decisionId === "string" ? (candMeta.decisionId as string) : undefined,
          msgKind: typeof candMeta.kind === "string" ? candMeta.kind : undefined,
        });
      }
      continue;
    }
    // ATOMIC CLAIM BY LEASE. This used to be a delete-with-return, which won
    // the race correctly but made the row - and therefore the shop - cease to
    // exist for the whole send. Every surface derives shop state from the outbox
    // and the sent-messages table, so during that window the shop had no state
    // at all and disappeared from the queue and the status panel.
    //
    // A conditional update wins the race exactly as well (the loser
    // re-evaluates `not_before<=now` against the winner's committed row and
    // matches nothing) while leaving the row in place, marked `sending`. It also
    // gives a crashed drainer's message a way back: the lease lapses and the row
    // is simply due again, which the delete made impossible.
    const claimedAt = Date.now();
    if (!(await claimOutboxRow(cand.id, { ...candMeta, firstDueAt: dueSince }, claimedAt)))
      continue;
    const row: OutboxRow = { ...cand, meta: { ...candMeta, firstDueAt: dueSince, claimedAt } };
    /** Hand this row back to the queue at a new time, with an honest reason. */
    // WAVE-AWARE RE-STAMP - the drain-side half of Part 11 F1.
    //
    // The enqueue-time `not_before` sets a wave's floor, but THIS is the
    // authoritative pacer: the drain sends a couple of cold rows per invocation
    // and re-parks the rest minutes later. A wave of 8 needs several invocations
    // to clear, so unclamped re-stamps bleed a burst across its own silence and
    // into the next wave - turning the schedule back into a continuous trickle
    // with extra steps, which is exactly what waves exist to prevent.
    //
    // A cold row may therefore be delayed WITHIN its burst, and may pile up at
    // the wave boundary, but can never be pushed into the quiet gap. Rows with
    // no wave metadata (every row enqueued before waves were switched on) are
    // returned unchanged, so the legacy path is untouched.
    //
    // DELIBERATELY NOT APPLIED to `guardOutbound`'s own re-park (its `queue()`
    // helper, which patches the row when a drained send is re-timed). That path
    // carries SAFETY holds too - pause, ban recovery, fail-closed sync retries,
    // breakers, the min-gap floor - and this clamp only ever moves a time
    // EARLIER. Clamping a safety hold to a wave boundary would release a paused
    // account sooner, which is the opposite of what the hold is for. Pacing
    // re-times on that path are already bounded by `boundToBatch`.
    const release = async (delayMs: number, patch: Record<string, unknown>) => {
      const notBefore = new Date(
        clampRestampToWave(Date.now() + Math.max(0, delayMs), waveEndsAt)
      ).toISOString();
      const held = await releaseOutboxRow(row.id, notBefore, {
        ...candMeta,
        firstDueAt: dueSince,
        ...patch,
      } as OutboxMeta);
      // EVERY re-park appends to the durable hold trail, including the drain's
      // own. `guardOutbound`'s queue() has always done this; the drain's
      // re-parks went through a direct write and wrote nothing, so the two
      // holds that dominate a real queue - over budget, and a live duplicate
      // claim - were the two the message-path view could never show.
      const reason = typeof patch.reason === "string" ? patch.reason : "re-parked";
      const { recordHoldEvent } = await import("./wa/hold-events");
      void recordHoldEvent({
        senderKey: row.sender_key,
        toNumber: row.to_number,
        reason,
        until: notBefore,
        outboxRowId: row.id,
        decisionId:
          typeof candMeta.decisionId === "string" ? (candMeta.decisionId as string) : undefined,
        msgKind: typeof candMeta.kind === "string" ? candMeta.kind : undefined,
      });
      return held;
    };
    // Re-check the gate (caps/hours may have changed while queued). Preserve the
    // row's ORIGINAL auto-ness: a user-typed `custom` message that the caps
    // parked is NOT an agent send, so it must not be re-evaluated as auto and
    // dropped by an auto-only veto (the engagement halt is terminal now - a
    // hardcoded auto:true here silently deleted the user's own queued message).
    const rowKind = (row.meta as { kind?: string } | null)?.kind;
    const verdict = await guardOutbound({
      senderKey: row.sender_key,
      toDigits: row.to_number,
      text: row.body,
      auto: rowKind !== "custom",
      queueIfBlocked: true,
      meta: row.meta ?? undefined,
      // The row still EXISTS (claimed by lease, not deleted), so the guard must
      // re-time THIS row rather than insert a second one for the same shop.
      outboxRowId: row.id,
      // B4: row.body was humanized once when it was parked - do NOT re-vary it.
      alreadyHumanized: true,
    });
    if (!verdict.allow) {
      // The gate either RE-QUEUED the row (verdict.queuedUntil set - it patched
      // this row in place) or DELIBERATELY dropped it (verdict.terminal -
      // cancelled / duplicate / rfq-dedup / takeover, where re-sending would be
      // wrong). If it did NEITHER, release the claim so a non-terminal reject
      // can never strand a real send inside a lease.
      const { needsRepark } = await import("./wa/outbox-policy");
      if (verdict.terminal) await completeOutboxRow(row.id);
      else if (needsRepark(verdict)) {
        // A TRANSIENT READ IS NOT A FIVE-MINUTE PROBLEM. This is the fail-closed
        // path: a reputation row, tombstone table or session flag that could not
        // be read, so the guard refused without re-queueing. Under the database
        // load a 40-shop batch generates that is a routine blip, and parking an
        // engaged reply 5-10 minutes for it is the cleanest explanation for the
        // 17- and 21-minute outliers in the field. Cold intros keep the long
        // hold; a reply retries in seconds and fails closed again if the read is
        // genuinely broken.
        const backoff = isCold(cand)
          ? Date.parse(jitteredHold(Date.now(), 5, 5)) - Date.now()
          : (20 + Math.random() * 20) * 1000; // ~20-40s
        await release(backoff, { reason: "sync-retry" });
      }
      continue;
    }
    // Last-instant cancellation re-check (the user may have tapped Remove
    // between the guard verdict and this send). The deal-close closing message
    // is exempt - close-deal tombstones the shop in the same breath it parks
    // this row, and the tombstone must never swallow the booking handoff.
    try {
      const { isCancelled } = await import("./wa/cancellations");
      if (
        rowKind !== "deal-close" &&
        (await isCancelled(row.sender_key, row.to_number)) === true
      ) {
        await completeOutboxRow(row.id); // the user removed it - it is gone for good
        continue;
      }
      // ...AND THE OTHER ABSOLUTE VETO, WHICH THIS PATH NEVER RE-ASKED.
      //
      // A parked row can sit for minutes. If the traveller started typing in
      // that shop's chat themselves in the meantime, the guard's compose-time
      // verdict is stale and the agent talks straight over a human - the one
      // thing takeover exists to prevent. Cancellation got a last-instant
      // re-check here; takeover, which is exactly as absolute, did not.
      //
      // Held, not killed: a takeover is a pause, not a removal, so the row
      // waits for handback instead of being completed away.
      if (rowKind !== "deal-close") {
        const { isThreadTakenOver } = await import("./session-flags");
        const takenOver = await isThreadTakenOver(row.sender_key, row.to_number);
        // FAIL CLOSED on null: an unreadable store must not license a send
        // over a human (the tri-state exists for precisely this call site).
        if (takenOver !== false) {
          await release(120_000, { reason: "human-takeover" });
          continue;
        }
      }
    } catch {
      /* the guard already enforced the readable cases */
      await release(60_000, { reason: "sync-retry" });
      continue;
    }

    // IS THIS STILL TRUE? - the one semantic question the send path never asked.
    //
    // Everything above this line is anti-ban, cancellation and pacing. None of
    // it reads the conversation, so a draft written at 12:23 went out at 12:39
    // unchanged, after the shop had said something at 12:38 that made it wrong.
    // A message is a promise made at compose time and kept at send time, and
    // between those two moments the thread can move.
    //
    // DROP AND RECOMPOSE, NEVER DROP AND HOPE. Deleting the row alone would
    // assume the newer inbound ran a turn of its own - and it may not have
    // (guard refusal, takeover flip, LLM outage, vision offload, coalescing).
    // So a stale drop always schedules a fresh turn against the latest inbound.
    if (await staleDraftDropped(row, rowKind)) continue;

    // ATOMIC SEND SLOTS: the guard's time-based checks are read-then-act and
    // N concurrent drainers all pass them together. The claim row is the
    // lock: exactly ONE invocation per min-gap window per sender sends, and
    // exactly one delivery per unique message ever happens.
    // THE LANE TEST AND THE FILTER IT CLAIMS TO MATCH MUST AGREE ABOUT
    // `human-manual`. REPLY_KIND_FILTER excludes it (rfq, custom, human-manual)
    // and so does `replyKind` inside guardOutbound - this test omitted it, so a
    // message the USER typed by hand was paced on the reply lane (5s per-shop
    // gap, per-recipient claim, reply fleet gap) instead of the strict
    // per-sender velocity lane the other two put it on. One row, three
    // different opinions about which budget it draws from.
    const isReplyRow = rowKind !== "rfq" && rowKind !== "custom" && rowKind !== "human-manual";
    const claimArgs = {
      senderKey: row.sender_key,
      toDigits: row.to_number,
      text: verdict.text,
      auto: true,
      // REPLY lane paces per engaged shop at the tighter reply_gap (~5s); a cold
      // intro (rfq) keeps the strict 12s per-sender velocity lane.
      gapSeconds: isReplyRow ? p.reply_gap_seconds : p.min_gap_seconds,
      // A reply/follow-up to an already-engaged shop paces PER-RECIPIENT, so 40
      // live threads do not serialize through one per-sender window. A cold
      // intro (rfq) keeps the strict per-sender velocity lane. The fleet gap is
      // the atomic ceiling that keeps the fleet a trickle, not a burst.
      perRecipient: isReplyRow,
      fleetGapSeconds: isReplyRow ? replyFleetGapSeconds(p) : undefined,
    };
    let claim = await claimSendSlots(claimArgs);
    // WAIT, DON'T RE-PARK (the fairness fix that killed the penalty stack).
    //
    // The lanes a reply loses are measured in SECONDS - the 5s per-shop gap,
    // the 6s fleet slot, the 8s recipient mutex - and every loss used to cost
    // a 10-14s re-park PLUS the wait for the next drain invocation to pick the
    // row back up. claimSendSlots now says exactly when the refusing lane
    // frees (retryAtMs); when that edge is seconds away and this invocation's
    // wait allowance still has room, sleeping to it and re-claiming ONCE beats
    // re-running the entire guard pipeline later. Bounded twice: per-loss by
    // REPLY_WAIT_CEILING_MS, per-invocation by the shared wait allowance, so
    // one contended lane cannot stall the rest of the batch for long. Cold
    // intros never wait - velocity to new numbers is the ban vector, and their
    // minute-scale holds are the point.
    if (
      !claim.ok &&
      claim.kind === "pacing" &&
      isReplyRow &&
      typeof claim.retryAtMs === "number"
    ) {
      // A SEND CROSSES THREE LANES, so one wait can only ever clear one of
      // them. The loop used to sleep once and give up, which meant losing the
      // gap lane and then the fleet lane - the ordinary case with several shops
      // answering at once - re-parked the row anyway, having spent the wait.
      // Still bounded exactly as before, per-loss and per-invocation; the only
      // change is that a wait which SUCCEEDS may be followed by another.
      const MAX_WAITS = 3;
      for (let attempt = 0; attempt < MAX_WAITS; attempt++) {
        if (claim.ok || claim.kind !== "pacing" || typeof claim.retryAtMs !== "number") break;
        const waitMs = claim.retryAtMs - Date.now();
        if (!(waitMs > 0) || waitMs > REPLY_WAIT_CEILING_MS || waitMs > waitAllowanceMs) break;
        waitAllowanceMs -= waitMs;
        await new Promise((res) => setTimeout(res, waitMs + 120 + Math.random() * 380));
        claim = await claimSendSlots(claimArgs);
      }
    }
    if (!claim.ok) {
      if (claim.kind === "duplicate") {
        // Another invocation holds this message's idempotency slot. Usually it
        // is mid-delivery and will retire the row itself - but it may also have
        // DIED holding the slot, so waiting forever is not an option. Hold this
        // row briefly and count the holds; a bounded number of them, then an
        // honest give-up rather than a row that retries until the heat death.
        const holds = Number((cand.meta as OutboxMeta | null)?.dupHolds ?? 0) + 1;
        if (holds >= MAX_DUP_HOLDS) {
          await completeOutboxRow(row.id);
          await sbInsert("agent_events", [
            {
              kind: "wa-send-dropped",
              // Join columns as COLUMNS - same fix as the give-up dropEvent
              // below; without them this event was invisible to messagePath.
              user_email: row.sender_key,
              to_number: row.to_number,
              vendor_id: String((row.meta as { vendorId?: string } | null)?.vendorId ?? ""),
              vendor_name: String(
                (row.meta as { vendorName?: string } | null)?.vendorName ?? row.to_number
              ),
              detail: `Stopped retrying +${row.to_number} (sender ${row.sender_key}) - an identical message held the send slot ${MAX_DUP_HOLDS} times, so it has almost certainly already gone out.`,
            },
          ]).catch(() => {});
        } else {
          // Lane-proportional: a reply's rival claim is mid-delivery on a
          // seconds-scale lane, so 30s is plenty to let it retire the row; the
          // cold 2min hold stays - intro velocity is the ban vector.
          await release(isReplyRow ? 30_000 : 120_000, { dupHolds: holds, reason: "human pacing gap" });
        }
        continue;
      }
      // PENALTY PROPORTIONAL TO THE LANE THAT REFUSED.
      //
      // The lanes a reply loses are measured in SECONDS - a 5s per-shop gap, a
      // 6s fleet slot, an 8s recipient mutex - and the penalty for losing one
      // was a flat 1-3 MINUTES. Two losses in a row and a reply that was ready
      // at 12:23 leaves at 12:29. Waiting out the window that refused you is
      // the whole cost; anything beyond it is invented latency.
      //
      // Cold intros keep the minute-scale hold: velocity to new numbers is the
      // ban vector, and their lane is 12s+ anyway.
      const lostLane = isCold(cand)
        ? Date.parse(jitteredHold(Date.now(), 1, 2)) - Date.now()
        : (RECIPIENT_LOCK_SEC + 2 + Math.random() * 4) * 1000; // ~10-14s
      await release(lostLane, {
        reason: claim.kind === "pacing" ? "human pacing gap" : "sync-retry",
      });
      // TWO OPPOSITE CAUSES WROTE THE SAME COUNTER.
      //
      // `claim.kind === "pacing"` means another sender legitimately holds the
      // lane: the system working, the row re-parked for seconds and retried.
      // Anything else is a FAIL-CLOSED refusal - the claim table could not be
      // read, so we declined to send rather than risk a double. That is the
      // send lane being down.
      //
      // Both landed on `claim-lost`, so the one number the owner reads on the
      // dashboard meant either "busy" or "broken" and there was no way to tell
      // which. A contention counter that can also mean an outage is not a
      // signal, and it is the input the adaptive pacing wants to read.
      await insertPathEvent({
        kind: claim.kind === "pacing" ? "claim-lost" : "claim-error",
        user_email: row.sender_key,
        to_number: row.to_number,
        vendor_name: `+${row.to_number}`,
        detail: `send slot ${claim.kind} for ${row.sender_key} -> +${row.to_number}`,
      });
      continue;
    }
    // A THROW from send() (e.g. the transport rejected) must not abandon the
    // rest of the batch or lose this already-claimed row - treat it as a
    // transient failure so the branch below re-queues it. With the evoFetch
    // hard timeout in place, a slow host now returns {ok:false} rather than
    // hanging, but this keeps any other throw safe too.
    let r: {
      ok: boolean;
      error?: string;
      rateLimited?: boolean;
      budgetUnreadable?: boolean;
      /** The limiter's own wait. Present only on a cap refusal. */
      retryAfterSeconds?: number;
      unconfirmed?: boolean;
      messageId?: string;
      chatJid?: string;
      /** Status-0 timeout - may have landed. Keep the idempotency claim so the
       * echo is recognised and the retry cannot double-send (OR11 H2.2). */
      ambiguous?: boolean;
    };
    try {
      r = await send(row.sender_key, row.to_number, verdict.text, isCold(row) ? "intro" : "reply");
    } catch (e) {
      r = { ok: false, error: e instanceof Error ? e.message : "send threw" };
    }
    if (r.ok) {
      sent++;
      if (cold) {
        rfqBySender.set(row.sender_key, (rfqBySender.get(row.sender_key) ?? 0) + 1);
      } else {
        replySentToRecipient.add(rcptKey);
        replyBySender.set(row.sender_key, (replyBySender.get(row.sender_key) ?? 0) + 1);
        replyGlobalBudget--;
      }
      await afterSend(row.sender_key, row.to_number);
      await sbInsert("whatsapp_messages", [
        {
          // STORE THE PROVIDER MESSAGE ID. Without it the webhook's fromMe
          // echo-check ("did WE send this?") could never match by id and fell
          // back to a 10-minute body comparison - so our own humanized send,
          // echoed back late or with varied text, was misfiled as a HUMAN
          // TAKEOVER. That wrote an rfq-less outbound row on top of the thread
          // and every later shop reply died as "no-rfq-thread".
          wa_message_id: r.messageId ?? null,
          to_number: row.to_number,
          body: verdict.text,
          type: "text",
          direction: "outbound",
          // confirmed=false means Evolution accepted the request (2xx) but did
          // not return a delivery receipt - recorded honestly so the UI can show
          // it as "sent, unverified" rather than a confirmed delivery.
          raw: {
            ...(row.meta ?? {}),
            sender: row.sender_key,
            ok: true,
            auto: true,
            queued: true,
            // Which wire carried it (design piece 4): the drain only ever
            // sends via the traveller's Evolution instance; the WABA lane
            // stamps 'waba' on its own rows. One key, one vocabulary.
            transport: "evolution",
            confirmed: r.unconfirmed ? false : true,
            // The chat's privacy identity when the provider reported one. An
            // outbound anchor carrying raw.lid is what lets the shop's FIRST
            // @lid reply resolve (wa/lid-alias reads BOTH directions) - the
            // old inbound-only alias trail needed a previously-successful
            // ingest, a chicken-and-egg that dropped the opening reply of
            // every privacy-migrated thread.
            ...(lidKey(r.chatJid) ? { lid: lidKey(r.chatJid) } : {}),
          },
        },
      ]);
      // ORDER MATTERS, and it is the whole point of this lifecycle: the SENT row
      // is written FIRST, and only then is the queued row retired. The shop is
      // briefly in both tables (every surface prefers "sent"), and never in
      // neither - which is what made it disappear mid-send.
      await completeOutboxRow(row.id);
      // FUNNEL LEDGER: a drained RFQ reaching the shop IS the contact (the
      // TRUTH RULE - the outbound row above is the evidence); a drained bargain
      // is the negotiation moving. Keyed on the row's own meta.kind so a
      // mid-thread answer or follow-up stamps nothing. Best-effort, deduped
      // inside advanceThreadStage.
      {
        const mk = (row.meta as { kind?: string } | null)?.kind;
        if (mk === "rfq" || mk === "bargain") {
          const { advanceThreadStage } = await import("./funnel/stages");
          await advanceThreadStage(
            {
              userEmail: row.sender_key,
              toNumber: row.to_number,
              vendorId: String((row.meta as { vendorId?: string } | null)?.vendorId ?? "") || undefined,
              vendorName: String((row.meta as { vendorName?: string } | null)?.vendorName ?? "") || undefined,
              transport: "evolution",
            },
            mk === "rfq" ? "contacted" : "negotiating",
            mk === "rfq" ? "queued RFQ delivered to the shop" : "queued bargain delivered to the shop"
          ).catch(() => {});
        }
      }
      // THE NUMBER THE PROMISE IS MADE OF: inbound -> wire, wall clock. The
      // turn-latency stamp measures compose time plus the PLANNED delay, which
      // is the latency we intended - not the latency that happened. Every hold,
      // re-park and lost claim between compose and this send is invisible to
      // it. A reply row carries what it was an answer to (composedAgainst), so
      // the true end-to-end sample is one subtraction away. Fire-and-forget: a
      // metric never delays the next row.
      if (!cold) {
        const inboundAtIso = (
          row.meta as { composedAgainst?: { inboundAt?: string } } | null
        )?.composedAgainst?.inboundAt;
        const inboundAtMs = inboundAtIso ? Date.parse(inboundAtIso) : NaN;
        if (Number.isFinite(inboundAtMs) && Date.now() > inboundAtMs) {
          void sbInsert("agent_events", [
            {
              kind: "reply-latency",
              user_email: row.sender_key,
              vendor_name: row.to_number,
              detail: JSON.stringify({ inboundToWireMs: Date.now() - inboundAtMs }),
            },
          ]).catch(() => {});
        }
      }
      if (r.unconfirmed) {
        await sbInsert("agent_events", [
          {
            kind: "wa-send-unconfirmed",
            // Join columns as COLUMNS - without user_email/to_number this event
            // was invisible to messagePath and every per-user surface (the
            // wa-send-dropped lesson).
            user_email: row.sender_key,
            to_number: row.to_number,
            vendor_id: String((row.meta as { vendorId?: string } | null)?.vendorId ?? ""),
            vendor_name: String((row.meta as { vendorName?: string } | null)?.vendorName ?? row.to_number),
            detail: `Sent to +${row.to_number} (sender ${row.sender_key}) but WhatsApp returned no delivery receipt - shown as unverified.`,
          },
        ]).catch(() => {});
      }
    } else {
      // Release the idempotency claim so the retry below is not treated as a
      // duplicate of the failed attempt - but ONLY when the send DEFINITIVELY
      // did not land. An AMBIGUOUS status-0 timeout (r.ambiguous) may have
      // reached WhatsApp, so releasing the claim would (a) leave the fromMe
      // echo of a delivered message with no record - all three echo checks miss
      // it and our own message is convicted as a HUMAN TAKEOVER, killing the
      // thread and purging the queue - and (b) let the retry re-POST a possible
      // duplicate (a velocity ban signal). Keeping the claim makes the echo
      // recognisable AND routes the retry into the duplicate-hold path, which
      // is exactly the "landed-but-timed-out" protection gcSendClaims already
      // documents (OR11 H2.2).
      if (!r.ambiguous) {
        await releaseMessageClaim(row.sender_key, row.to_number, verdict.text).catch(() => {});
      }
      // CLASSIFY the failure. A TRANSIENT infra failure (the Evolution host is
      // waking/restarting/timed-out - the "wd-evolution health check failed"
      // case) is NOT the recipient's fault and must NOT burn the retry cap or
      // creep the ETA 10/20/30/40/50 min into the future (that is exactly what
      // made a whole batch stall after one send and then silently vanish).
      // Only RECIPIENT-level failures (not on WhatsApp, invalid, blocked) count
      // toward the give-up cap.
      const { isRecipientSendFailure, transientRetryDecision, recipientRetryDecision } =
        await import("./wa/send-classify");
      const recipientFail = isRecipientSendFailure(r.error);
      const transient = !recipientFail; // reconnecting / timeout / 5xx / empty / unknown host error
      // EVERY failed attempt leaves a durable trace (owner report 3, item 8).
      // wa-send-dropped fires only at give-up and wa-send-unconfirmed only on
      // a 2xx-without-receipt - the ATTEMPTS in between were invisible, which
      // is exactly the "where is my message stuck" hole. Throttled per
      // (sender, shop, error) by the same helper the holds use.
      {
        const { recordHoldEvent } = await import("./wa/hold-events");
        void recordHoldEvent({
          senderKey: row.sender_key,
          toNumber: row.to_number,
          reason: `send-attempt-failed: ${String(r.error ?? "unknown").slice(0, 160)}`,
          outboxRowId: row.id,
          decisionId:
            typeof (row.meta as { decisionId?: string } | null)?.decisionId === "string"
              ? ((row.meta as { decisionId?: string }).decisionId as string)
              : undefined,
          msgKind: r.rateLimited
            ? "rate-limited"
            : r.budgetUnreadable
              ? "budget-unreadable"
              : transient
                ? "transient"
                : "recipient",
        });
      }
      const dropEvent = async (detail: string) => {
        await sbInsert("agent_events", [
          {
            kind: "wa-send-dropped",
            // Join columns as COLUMNS (same fix as wa-send-unconfirmed above).
            user_email: row.sender_key,
            to_number: row.to_number,
            vendor_id: String((row.meta as { vendorId?: string } | null)?.vendorId ?? ""),
            vendor_name: String((row.meta as { vendorName?: string } | null)?.vendorName ?? row.to_number),
            detail,
          },
        ]).catch(() => {});
        // FUNNEL LEDGER: a dropped RFQ is a shop the funnel never reached.
        // Only the RFQ - a dropped mid-thread message is that message's
        // problem - and the ledger itself additionally refuses `unreachable`
        // once the shop has ever replied, so this can never mislabel a live
        // thread even on a stale meta.kind.
        if ((row.meta as { kind?: string } | null)?.kind === "rfq") {
          const { advanceThreadStage } = await import("./funnel/stages");
          await advanceThreadStage(
            { userEmail: row.sender_key, toNumber: row.to_number, transport: "evolution" },
            "unreachable",
            "gave up delivering the RFQ"
          ).catch(() => {});
        }
      };

      // A CAP IS NOT A FAULT, AND IT MUST BE TESTED FIRST.
      //
      // A rate-limit refusal is neither a recipient failure nor a host failure,
      // so `transient = !recipientFail` swept it into the infrastructure
      // branch: the row was re-parked by the 45-120s transient bounce and the
      // owner was told "reconnecting - resumes automatically", i.e. that
      // Evolution was unreachable. It was not. The budget simply said no, and
      // the owner would have spent a day chasing a host that was fine.
      //
      // The limiter knows exactly how long to wait, so use its number rather
      // than a backoff invented here, and say the true thing.
      if (r.rateLimited) {
        const waitSec = Math.max(60, Math.min(6 * 3600, r.retryAfterSeconds ?? 900));
        const resumesAt = new Date(Date.now() + waitSec * 1000);
        await release(waitSec * 1000, {
          // NOT `transientAttempts`: a cap refusal must never count toward the
          // give-up budget for an unreachable host. Nothing was wrong with the
          // send, and 24h of being at cap is normal, not a dead host.
          reason: `held - daily message allowance reached, resumes ${resumesAt
            .toISOString()
            .slice(11, 16)}`,
        });
        continue;
      }

      // A BUDGET WE COULD NOT READ IS NOT A BUDGET WE SPENT.
      //
      // `checkRateLimit` fails CLOSED when the send-history read is
      // unavailable: nothing is wrong with the number and nothing is at cap -
      // the count simply cannot be trusted right now, so the send waits. That
      // refusal used to arrive here stamped `rateLimited` (the send path
      // hardcoded it), so a Supabase outage was reported to the owner as
      // "daily message allowance reached" - a number they could check and
      // disprove, pointing them away from the actual fault. It is a sync
      // retry, and it says so.
      if (r.budgetUnreadable) {
        const waitSec = Math.max(30, Math.min(600, r.retryAfterSeconds ?? 120));
        await release(waitSec * 1000, {
          reason: "sync-retry - send budget unreadable, holding rather than risking your number",
        });
        continue;
      }

      if (transient) {
        // Retry SOON with no per-failure attempt burn - the batch resumes within
        // ~a minute of the host recovering. Bounded lifetime lives in the pure
        // decision helper so a PERMANENTLY dead host cannot loop forever.
        const meta = (row.meta ?? {}) as { firstQueuedAt?: number; transientAttempts?: number };
        const firstQueuedAt = Number(meta.firstQueuedAt) || Date.now();
        const decision = transientRetryDecision(
          firstQueuedAt,
          Number(meta.transientAttempts ?? 0),
          Date.now(),
          Math.random(),
        );
        if (decision.drop) {
          await completeOutboxRow(row.id);
          await dropEvent(
            `Gave up reaching +${row.to_number} - the WhatsApp host was unreachable for over 24h (sender ${row.sender_key}).`,
          );
        } else {
          // The row never left the table, so there is no insert that can fail
          // and silently lose the message - releasing it IS the re-queue.
          await release(decision.delayMs, {
            firstQueuedAt,
            transientAttempts: decision.attempts,
            reason: "reconnecting - resumes automatically",
          });
        }
      } else {
        const decision = recipientRetryDecision(
          Number((row.meta as { attempts?: number } | null)?.attempts ?? 0),
        );
        if (decision.drop) {
          await completeOutboxRow(row.id);
          await dropEvent(
            `Could not reach +${row.to_number} after 5 attempts (sender ${row.sender_key}) - the shop's number may be unreachable on WhatsApp.`,
          );
        } else {
          // Recipient-level retry backoff, capped so it never creeps past
          // ~20 min even at the last attempt.
          await release(decision.delayMs, {
            attempts: decision.attempts,
            reason: `couldn't reach this shop - retry ${decision.attempts}/5`,
          });
        }
      }
    }
  }
  // Housekeeping: stale claim rows expire after 24h (cheap ranged delete).
  // GC RUNS ON EVERY DRAIN, INCLUDING THE QUIET ONES.
  //
  // This was gated on `candidates.length > 0`, so the claims table was only
  // ever collected while there was something to send - and a quiet period is
  // exactly when nothing else exercises the table and the expired rows have
  // most time to pile up. The GC is two ranged deletes with no rows to transfer;
  // running it on an empty drain costs nothing and closes the window where the
  // only thing keeping the table bounded is the traffic that fills it.
  await gcSendClaims();
  // A budget stop is a real operational fact, not a silent truncation: it says
  // this invocation was offered more work than its deadline allowed, which is
  // the signal that the drain cadence (or the fleet size) needs attention.
  if (stoppedForBudget > 0) {
    void sbInsert("agent_events", [
      {
        kind: "drain-budget-stop",
        detail: JSON.stringify({
          skipped: stoppedForBudget,
          sent,
          replyOnly: Boolean(opts?.replyOnly),
          budgetMs: opts?.budgetMs ?? 45_000,
        }),
      },
    ]).catch(() => {});
  }
  return sent;
}

/**
 * Claim the atomic send slots for a DIRECT send (routes that bypass
 * drainOutbox). Policies stay internal to this module - callers only learn
 * the outcome. See src/lib/wa/pacing.ts for semantics.
 */
export async function claimForSend(
  senderKey: string,
  toDigits: string,
  text: string,
  auto: boolean,
  perRecipient = false
): Promise<import("./wa/pacing").ClaimOutcome> {
  const p = await getPolicies();
  const { claimSendSlots } = await import("./wa/pacing");
  return claimSendSlots({
    senderKey,
    toDigits,
    text,
    auto,
    // Engaged replies (perRecipient) use the tighter reply lane; cold keep 12s.
    gapSeconds: perRecipient ? p.reply_gap_seconds : p.min_gap_seconds,
    perRecipient,
    fleetGapSeconds: perRecipient ? replyFleetGapSeconds(p) : undefined,
  });
}

/**
 * The atomic fleet-wide gap for the REPLY lane: a smaller gap than the cold
 * per-sender min-gap (so engaged shops trickle out fast), floored so one number
 * can never emit a machine-gun burst - a person juggling many chats replies
 * quickly but not dozens-per-second.
 */
function replyFleetGapSeconds(p: SecurityPolicies): number {
  return Math.max(5, Math.round((p.min_gap_seconds || 12) / 2));
}

/** Release a message claim after a failed direct send (retry-friendly). */
export async function releaseSendClaim(
  senderKey: string,
  toDigits: string,
  text: string
): Promise<void> {
  const { releaseMessageClaim } = await import("./wa/pacing");
  await releaseMessageClaim(senderKey, toDigits, text);
}

// ---------------------------------------------------------------------------
// Read-only safety surface for the UI (item: anti-ban VISIBILITY).
// Zero behaviour change - this only REPORTS what the guard above is doing, so
// the app can stop saying "connected" while sending is actually paused.
// ---------------------------------------------------------------------------

export interface SenderSafety {
  /**
   * `unknown` is not a health verdict - it is the ABSENCE of one. Every other
   * state is a claim about the traveller's number; this one is a claim about
   * us. It exists because the two inputs that produce "healthy" (an empty
   * queue, a readable reputation row) are indistinguishable from an unreadable
   * database when read through the permissive reader, so a Supabase outage used
   * to render as a green "All good" pill on the traveller's screen while
   * nothing at all was being sent.
   */
  state: "healthy" | "pacing" | "paused" | "recovering" | "disconnected" | "attention" | "unknown";
  /** RAW internal reason - admin surfaces only, never shown to travellers. */
  reason?: string;
  /** Calm, outcome-language explanation safe for the traveller UI. */
  publicReason?: string;
  pausedUntil?: string;
  trustScore: number;
  riskScore: number;
  queued: number;
  queueReasons: string[];
  /** Traveller-safe translations of queueReasons (same order, deduped). */
  publicQueueReasons: string[];
  /** The raw inputs the verdict was computed from (admin/doctor surfaces). */
  signals?: import("./wa/safety-signals").SafetySignals;
}

// The signal collection runs on every activity poll, so it is cached briefly
// per sender (the same 20-30s currency every other health read accepts).
const safetySignalCache = new Map<
  string,
  { at: number; sig: import("./wa/safety-signals").SafetySignals }
>();

/** The IMPURE half of the health verdict: gather the signals that actually
 * fail in production. Every read degrades to null/0, and the pure classifier
 * only flags on positive evidence - a DB blip cannot paint a number red. */
async function collectSafetySignals(
  senderKey: string
): Promise<import("./wa/safety-signals").SafetySignals> {
  const cached = safetySignalCache.get(senderKey);
  if (cached && Date.now() - cached.at < 20_000) return cached.sig;
  const enc = encodeURIComponent(senderKey);
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { isLoudDrop } = await import("./wa/safety-signals");
  const { instanceNameFor } = await import("./evolution");
  const [sess, hookOk, lastIn, lastOut, drops] = await Promise.all([
    sbSelect<{ status: string | null }>(
      "wa_sessions",
      `select=status&email=eq.${enc}&limit=1`
    ).catch(() => []),
    sbSelect<{ created_at: string }>(
      "agent_events",
      `select=created_at&kind=eq.webhook-ok&vendor_name=eq.${encodeURIComponent(
        instanceNameFor(senderKey)
      )}&order=created_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&direction=eq.inbound&raw->>receiver=eq.${enc}&order=received_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&direction=eq.outbound&raw->>sender=eq.${enc}&order=received_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ kind: string; detail: string | null }>(
      "agent_events",
      `select=kind,detail&kind=in.("inbound-dropped","send-dropped")&user_email=eq.${enc}&created_at=gte.${encodeURIComponent(
        dayAgo
      )}&limit=60`
    ).catch(() => []),
  ]);
  let inboundDropped24h = 0;
  let sendDropped24h = 0;
  for (const d of drops) {
    let reason = "";
    try {
      reason = String(JSON.parse(d.detail ?? "{}").reason ?? "");
    } catch {}
    if (d.kind === "send-dropped") sendDropped24h += 1;
    else if (isLoudDrop(reason)) inboundDropped24h += 1;
  }
  const sig = {
    connection: sess[0]?.status ?? null,
    lastWebhookOkAt: hookOk[0]?.created_at ?? null,
    lastInboundAt: lastIn[0]?.received_at ?? null,
    lastOutboundAt: lastOut[0]?.received_at ?? null,
    inboundDropped24h,
    sendDropped24h,
  };
  if (safetySignalCache.size > 2000) safetySignalCache.clear();
  safetySignalCache.set(senderKey, { at: Date.now(), sig });
  return sig;
}

export async function senderSafety(senderKey: string): Promise<SenderSafety> {
  const [rep, outboxRead, signals] = await Promise.all([
    // STRICT on both inputs that can manufacture a green verdict. getReputation
    // (permissive) INSERTS a fresh trust-20 row when its read comes back empty,
    // so an outage produced a brand-new-healthy-number reputation out of thin
    // air; getReputationStrict answers null on `unavailable` and only then.
    getReputationStrict(senderKey).catch(() => null),
    sbSelectStrict<{ meta: { reason?: string } | null }>(
      "wa_outbox",
      `select=meta&sender_key=eq.${encodeURIComponent(senderKey)}&limit=50`
    ),
    collectSafetySignals(senderKey).catch(() => null),
  ]);
  // A missing (un-migrated) outbox table is genuinely empty; an unreachable one
  // is not. Only the second can turn "no rows" into a lie.
  const outboxUnreadable = "error" in outboxRead && outboxRead.error === "unavailable";
  const outbox = "rows" in outboxRead ? outboxRead.rows : [];

  const queued = outbox.length;
  const queueReasons = [
    ...new Set(outbox.map((r) => r.meta?.reason).filter((x): x is string => Boolean(x))),
  ].slice(0, 4);

  const trustScore = rep?.trust_score ?? 20;
  const riskScore = rep?.risk_score ?? 0;
  const pausedUntil =
    rep?.paused_until && Date.parse(rep.paused_until) > Date.now()
      ? rep.paused_until
      : undefined;

  // Traveller-safe translations: outcome language only (what happens and
  // when), never the mechanism ("ban risk", cap math, trust scores). The raw
  // reasons stay on the object for admin surfaces.
  const { queueReasonLabel } = await import("./queue-reason");
  const publicQueueReasons = [...new Set(queueReasons.map((r) => queueReasonLabel(r)))];

  if (pausedUntil) {
    // Ban recovery drops trust to 10 (enterBanRecovery); a plain risk pause
    // keeps whatever trust the number had.
    const recovering = trustScore <= 10;
    return {
      state: recovering ? "recovering" : "paused",
      reason: recovering
        ? "recovering after a ban-risk signal - all automated sends are held while your number cools down"
        : "sending paused automatically to protect your number from ban risk",
      publicReason:
        "Sending is taking a short break and resumes automatically - your queued messages are safe.",
      pausedUntil,
      trustScore,
      riskScore,
      queued,
      queueReasons,
      publicQueueReasons,
      signals: signals ?? undefined,
    };
  }
  // The verdict layer that used to not exist: a dead connection or real drop
  // events outrank "the queue is empty". During the incident the queue was
  // CANCELLED empty while every reply bounced - and the banner showed green
  // precisely because nothing was queued.
  if (signals) {
    const { classifySafety } = await import("./wa/safety-signals");
    const flag = classifySafety(signals, Date.now());
    if (flag) {
      return {
        state: flag.state,
        reason: flag.reason,
        publicReason: flag.publicReason,
        trustScore,
        riskScore,
        queued,
        queueReasons,
        publicQueueReasons,
        signals,
      };
    }
  }
  // NOTHING BELOW THIS LINE CAN BE TRUSTED IF WE COULD NOT READ.
  //
  // Placed AFTER the pause check and the signal classifier on purpose: those
  // two run on positive evidence (a stored pause instant, an observed drop or
  // dead connection), and positive evidence about a real problem outranks our
  // own blindness. What must never survive an outage is the pair of INFERENCES
  // below - "queue is empty, therefore healthy" and "queue is non-empty,
  // therefore pacing" - because both read an empty array as a fact.
  if (outboxUnreadable || rep === null) {
    return {
      state: "unknown",
      reason: outboxUnreadable
        ? "queue state unreadable - cannot confirm what is or is not sending"
        : "reputation row unreadable - cannot confirm this number's standing",
      publicReason:
        "We can't check your messaging status right now. Nothing is lost - this refreshes on its own in a moment.",
      trustScore,
      riskScore,
      queued: 0,
      queueReasons: [],
      publicQueueReasons: [],
      signals: signals ?? undefined,
    };
  }
  if (queued > 0) {
    return {
      state: "pacing",
      reason:
        queueReasons[0] ??
        "messages are queued and will send at a safe, human pace",
      publicReason:
        "Your agent is sending messages at a natural, human pace - each one goes out automatically.",
      trustScore,
      riskScore,
      queued,
      queueReasons,
      publicQueueReasons,
      signals: signals ?? undefined,
    };
  }
  return {
    state: "healthy",
    trustScore,
    riskScore,
    queued,
    queueReasons,
    publicQueueReasons,
    signals: signals ?? undefined,
  };
}

/**
 * THE WARM-UP HAS TO BE ABOUT THE NUMBER, NOT THE ACCOUNT.
 *
 * Every reputation fact - age, trust, send/reply counters, the risk score built
 * on top of them - keys on `sender_key`, which is the user's EMAIL. And
 * `created_at` is precisely what the new-contact ramp reads as "how old is this
 * number". So the sequence a beta tester is most likely to perform -
 *
 *     link my personal number -> hunt for a week -> "I'll use a burner
 *     instead" -> unlink -> link a brand-new number
 *
 * - handed the brand-new number a fully-warmed budget on its first day:
 * age >= warmup_days, trust earned by a different SIM, and an unanswered
 * meter already showing healthy. Nothing in the tree reset this row; I grepped
 * for it. A fresh number blasting a full allowance at strangers on day one is
 * the single most bannable pattern WhatsApp meters.
 *
 * Called at link time. Only the last four digits are stored - enough to detect
 * a swap, not enough to be a second copy of someone's phone number.
 *
 * Deliberately conservative on the unknown paths: no tail (the pairing-code
 * flow can run without one) or an unreadable row leaves the reputation alone.
 * Wrongly resetting costs a tester some warm-up progress; wrongly KEEPING it
 * costs them their WhatsApp account.
 */
export async function noteLinkedNumber(senderKey: string, phone: string | null | undefined): Promise<
  "unchanged" | "reset" | "stamped" | "skipped"
> {
  const tail = String(phone ?? "").replace(/\D/g, "").slice(-4);
  if (!senderKey || tail.length < 4) return "skipped";
  const enc = encodeURIComponent(senderKey);
  const res = await sbSelectStrict<{ phone_tail: string | null }>(
    "whatsapp_number_reputation",
    `select=phone_tail&sender_key=eq.${enc}&limit=1`
  ).catch(() => ({ error: "unavailable" }) as const);
  if ("error" in res) return "skipped"; // unreadable - never guess
  // "NO ROW" AND "ROW WITH NO TAIL" ARE DIFFERENT FACTS, AND CONFLATING THEM
  // DISABLED THE DETECTOR ON ITS FIRST RUN.
  //
  // This read `res.rows[0]?.phone_tail ?? null`, so an ABSENT ROW and a row
  // whose tail we had simply never learned both arrived as `prior === null` and
  // both took the stamp branch below - which is a PATCH. On a first link the
  // reputation row does not exist yet (it is created lazily by getReputation on
  // the first guarded send), so that PATCH matched zero rows and stored
  // nothing, while returning "stamped" as though it had. The next link of a
  // genuinely DIFFERENT number then saw `prior === null` all over again and
  // took the no-reset branch: a burner inherits the previous number's age,
  // trust and counters on its first day - precisely the failure this function
  // was written to prevent.
  const row = res.rows[0];
  const prior = row?.phone_tail ?? null;
  if (prior === tail) return "unchanged";
  if (!row) {
    // No row at all. CREATE it carrying the tail, in the same shape
    // getReputation would have created it, so the number is bound to a
    // reputation from the moment it is linked rather than from its first send.
    await sbInsert("whatsapp_number_reputation", [
      {
        sender_key: senderKey,
        phone_tail: tail,
        trust_score: 20,
        sent_total: 0,
        replies_total: 0,
        last_send_at: null,
        created_at: new Date().toISOString(),
      },
    ]).catch(() => {});
    return "stamped";
  }
  if (!prior) {
    // The row exists and we are learning its number for the first time: stamp
    // WITHOUT resetting. The row's age belongs to this number - we simply did
    // not know which number it was until now.
    await sbUpdate("whatsapp_number_reputation", `sender_key=eq.${enc}`, {
      phone_tail: tail,
    }).catch(() => {});
    return "stamped";
  }
  // A genuinely different number. Restart the warm-up from zero.
  //
  // EVERY counter that describes the OLD number goes, not just two of them.
  // Zeroing `sent_total` while leaving `delivered_total` and `reads_total`
  // standing does not merely lose information, it corrupts the ratios built
  // from them: computeRisk arms its read-rate test at `delivered_total >= 8`,
  // so a fresh number could inherit an already-armed engagement test whose
  // denominator describes a number it has never been. The same is true of
  // fails/blocks feeding the risk score, and of the day's introduction count.
  await sbUpdate("whatsapp_number_reputation", `sender_key=eq.${enc}`, {
    phone_tail: tail,
    trust_score: 20,
    sent_total: 0,
    replies_total: 0,
    delivered_total: 0,
    reads_total: 0,
    blocks_total: 0,
    fails_total: 0,
    invalid_numbers_total: 0,
    new_contacts_today: 0,
    new_contacts_date: null,
    risk_score: 0,
    last_send_at: null,
    last_reply_at: null,
    last_delivery_receipt_at: null,
    last_read_receipt_at: null,
    // Holds belong to the number that earned them. A new number starts clean;
    // if it misbehaves the guard will pause it again on its own evidence.
    paused_until: null,
    cold_hold_until: null,
    created_at: new Date().toISOString(),
  }).catch(() => {});
  return "reset";
}
