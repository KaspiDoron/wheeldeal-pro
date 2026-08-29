// The owner's side of the ladder: read the cases, write the decisions.
//
// THE QUEUE IS DERIVED FROM EVIDENCE, not from the proposal event. The event
// is written fire-and-forget (`store.ts`), so a queue built on it would silently
// lose a person every time the insert failed - and losing a person here means
// either a bypass nobody ever sees or, worse, a traveller stuck behind a pause
// with no case for the owner to clear. Re-running `assessIntegrity` over the
// stored signals at read time cannot lose anyone, and it also means the queue
// reflects decay: a case leaves on its own when its evidence expires.

import "server-only";
import { assessIntegrity, liveSignals, type IntegritySignal } from "./signals";
import {
  BLOCK_KIND,
  DECISION_EVENT,
  caseStateFor,
  decodeDecision,
  encodeDecision,
  latestDecisionFor,
  latestSignalAt,
  type DecisionAction,
  type IntegrityDecision,
  type ProposalCase,
} from "./adjudication";

const SIGNAL_KIND = "integrity";
/** Plenty for a queue of people who tripped an integrity rung; bounded on purpose. */
const SCAN_LIMIT = 200;

interface CooldownRow {
  email: string;
  reason: string | null;
  until: string;
}

function parseSignals(reason: string | null | undefined): IntegritySignal[] {
  if (!reason) return [];
  try {
    const j = JSON.parse(reason) as { signals?: IntegritySignal[] };
    return Array.isArray(j?.signals) ? j.signals : [];
  } catch {
    return [];
  }
}

/** PostgREST `in.(...)` over values that can contain `+` and other reserved bytes. */
function inList(values: string[]): string {
  return values.map((v) => `"${encodeURIComponent(v)}"`).join(",");
}

/**
 * Every traveller with live integrity signals, with the owner's decision (if
 * any) and whatever restriction is actually in force. Never throws - an Ops
 * panel that explodes on a Supabase blip is worse than one that shows nothing.
 */
export async function integrityQueue(nowMs: number): Promise<ProposalCase[]> {
  const { sbSelect } = await import("../runtime-config");

  const signalRows = await sbSelect<CooldownRow>(
    "user_cooldowns",
    `select=email,reason,until&kind=eq.${SIGNAL_KIND}&order=until.desc&limit=${SCAN_LIMIT}`
  ).catch(() => [] as CooldownRow[]);

  const live = signalRows
    .map((r) => ({ email: String(r.email ?? "").toLowerCase(), signals: liveSignals(parseSignals(r.reason), nowMs) }))
    .filter((r) => r.email && r.signals.length > 0);
  if (live.length === 0) return [];

  const emails = live.map((r) => r.email);
  const list = inList(emails);

  const [users, decisionRows, blockRows] = await Promise.all([
    sbSelect<{ email: string; plan: string | null; status: string | null }>(
      "app_users",
      `select=email,plan,status&email=in.(${list})&limit=${SCAN_LIMIT}`
    ).catch(() => [] as { email: string; plan: string | null; status: string | null }[]),
    sbSelect<{ user_email: string | null; detail: string | null; created_at: string }>(
      "agent_events",
      `select=user_email,detail,created_at&kind=eq.${DECISION_EVENT}&user_email=in.(${list})&order=created_at.desc&limit=${SCAN_LIMIT}`
    ).catch(() => [] as { user_email: string | null; detail: string | null; created_at: string }[]),
    sbSelect<{ email: string; until: string }>(
      "user_cooldowns",
      `select=email,until&kind=eq.${BLOCK_KIND}&email=in.(${list})&limit=${SCAN_LIMIT}`
    ).catch(() => [] as { email: string; until: string }[]),
  ]);

  const planOf = new Map(users.map((u) => [String(u.email).toLowerCase(), String(u.plan ?? "free")]));
  const blockedAccount = new Set(
    users.filter((u) => u.status === "blocked").map((u) => String(u.email).toLowerCase())
  );
  const decisions = decisionRows
    .map(decodeDecision)
    .filter((d): d is IntegrityDecision => d !== null);
  const restrictedUntil = new Map(
    blockRows.map((r) => [String(r.email).toLowerCase(), Date.parse(r.until)])
  );

  return live.map(({ email, signals }) => {
    const plan = planOf.get(email) ?? "free";
    const verdict = assessIntegrity(signals, nowMs, plan);
    const newest = latestSignalAt(signals);
    const decision = latestDecisionFor(decisions, email);
    const until = restrictedUntil.get(email) ?? 0;
    return {
      email,
      plan,
      step: verdict.step,
      score: verdict.score,
      evidence: verdict.evidence,
      signalCount: signals.length,
      latestSignalAt: newest,
      state: caseStateFor(newest, decision),
      decision,
      restrictedMinutes: until > nowMs ? Math.ceil((until - nowMs) / 60_000) : 0,
      accountBlocked: blockedAccount.has(email),
    } satisfies ProposalCase;
  });
}

/**
 * Apply the owner's decision.
 *
 * The decision row is written FIRST and awaited, because it is the record the
 * queue reads to close the case; the enforcement that follows is derived from
 * it. An approval is a timed sending restriction (`BLOCK_KIND`), optionally
 * escalated to the account-level restriction that already exists in
 * `lib/access` and is already honoured at login. A rejection enforces nothing -
 * it just tells the queue the owner has seen this evidence.
 */
export async function decideCase(opts: {
  email: string;
  action: DecisionAction;
  minutes: number;
  restrictAccount: boolean;
  note: string;
  by: string;
}): Promise<boolean> {
  const email = opts.email.trim().toLowerCase();
  const { sbInsert } = await import("../runtime-config");
  // The decision EVENT is the durable record the queue reads back - a case
  // whose event never stored is a case still open, whatever else happened, so
  // its boolean is the function's answer (sbInsert returns false, not throw).
  const recorded = await sbInsert("agent_events", [
    {
      kind: DECISION_EVENT,
      user_email: email,
      vendor_id: "",
      vendor_name: "",
      detail: encodeDecision({
        action: opts.action,
        minutes: opts.action === "approve" ? opts.minutes : 0,
        restrictAccount: opts.action === "approve" && opts.restrictAccount,
        note: opts.note,
        by: opts.by,
      }),
    },
  ]);

  const { setCooldown, clearCooldown } = await import("../cooldown");
  const { setUserStatus } = await import("../access");

  if (opts.action === "approve") {
    await setCooldown(
      email,
      BLOCK_KIND,
      opts.minutes,
      `owner review: ${String(opts.note ?? "").slice(0, 200)}`
    );
    if (opts.restrictAccount) await setUserStatus(email, "blocked");
    return recorded;
  }

  // Reject and lift both END any restriction in force. "Reject" is the owner
  // saying the evidence is not what it looked like, and a traveller who was
  // paused by the rung itself should not have to wait out the decay for that.
  await clearCooldown(email, BLOCK_KIND);
  await setUserStatus(email, "active").catch(() => {});
  if (opts.action === "lift") await clearSignals(email);
  return recorded;
}

/**
 * Drop the evidence entirely. Used when the owner lifts a case: the traveller
 * starts clean, rather than climbing straight back up the ladder on signals
 * their exoneration was about.
 */
export async function clearSignals(email: string): Promise<void> {
  const { sbDelete } = await import("../runtime-config");
  await sbDelete(
    "user_cooldowns",
    `email=eq.${encodeURIComponent(email.trim().toLowerCase())}&kind=eq.${SIGNAL_KIND}`
  ).catch(() => {});
}
