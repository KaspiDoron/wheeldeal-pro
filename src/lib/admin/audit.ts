import "server-only";

// THE ADMIN AUDIT TRAIL - who looked at whose data, and when.
//
// The management console can read any table, pull up any person's consent
// history, export their entire file and erase their account. Every one of those
// is a legitimate operator action, and every one is also precisely what someone
// with a stolen admin cookie would do. Until this module existed the two were
// indistinguishable, because neither left a trace.
//
// "The owner is the only admin" does not answer it. The product adds runtime
// admins from the Key Vault, a demoted admin keeps a working cookie until the
// revocation horizon moves, and an audit trail's whole value is that it was
// already running before anyone knew to look.
//
// THREE RULES, all of them about not lying:
//
// 1. THE WRITE NEVER BLOCKS THE ACTION. An audit row that could fail an
//    erasure would mean a person's deletion request dying of bookkeeping. So
//    every writer here is best-effort and returns whether it landed.
//
// 2. A FAILED WRITE IS VISIBLE, not swallowed. `recordAdminAction` returns
//    false and the console renders `admin_audit` as unreadable rather than
//    showing an empty log - an audit surface that displays "no activity" over a
//    dead table is worse than no audit surface, because it is reassuring.
//
// 3. REFUSALS ARE AUDITED TOO. A denied attempt is the single most interesting
//    row in this table, and a trail that records only successes is a trail that
//    misses every probe that did not work.

import { sbInsert, sbSelectDark } from "../runtime-config";

/**
 * The vocabulary. An allow-listed union rather than free text, for the same
 * reason the analytics events are: a log whose action names are whatever the
 * newest caller typed cannot be filtered, counted, or explained to anyone.
 */
export const ADMIN_ACTIONS = {
  "subject.lookup": "Looked up a person's data file",
  "subject.export": "Exported a person's data",
  "subject.erase": "Erased a person's account and data",
  "subject.consent": "Read a person's consent history",
  "consent.export": "Exported the consent register",
  "consent.recampaign": "Started a re-consent campaign",
  "data.browse": "Browsed a data table",
  "user.status": "Changed an account's status",
  "user.role": "Changed an account's role",
} as const;

export type AdminAction = keyof typeof ADMIN_ACTIONS;

export type AdminOutcome = "ok" | "refused" | "failed";

export interface AdminAuditEntry {
  id?: number;
  actorEmail: string;
  actorRole: string;
  action: AdminAction;
  subjectEmail?: string | null;
  detail?: Record<string, unknown> | null;
  outcome?: AdminOutcome;
  at?: number;
}

/** Bounded, so one caller cannot write a megabyte of context per lookup. */
const MAX_DETAIL_KEYS = 12;
const MAX_DETAIL_STRING = 200;

function boundDetail(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_DETAIL_KEYS) break;
    if (typeof v === "string") out[k] = v.slice(0, MAX_DETAIL_STRING);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => String(x).slice(0, 80));
    else continue;
    n++;
  }
  return out;
}

/**
 * Write one row. Returns whether it landed - callers surface that rather than
 * assuming, and none of them fail their own action on a false.
 */
export async function recordAdminAction(entry: AdminAuditEntry): Promise<boolean> {
  const actor = String(entry.actorEmail ?? "").trim().toLowerCase();
  if (!actor || !entry.action) return false;
  return sbInsert("admin_audit", [
    {
      actor_email: actor,
      actor_role: String(entry.actorRole ?? "admin"),
      action: entry.action,
      subject_email: entry.subjectEmail
        ? String(entry.subjectEmail).trim().toLowerCase()
        : null,
      detail: boundDetail(entry.detail),
      outcome: entry.outcome ?? "ok",
    },
  ]).catch(() => false);
}

export interface AuditPage {
  entries: AdminAuditEntry[];
  /** Named when the table could not be READ. Distinct from an empty log, and
   *  the console renders the two completely differently. */
  degraded: string[];
}

interface AuditRow {
  id: number;
  actor_email: string;
  actor_role: string;
  action: string;
  subject_email: string | null;
  detail: Record<string, unknown> | null;
  outcome: string;
  created_at: string;
}

/**
 * Read the trail, newest first, optionally narrowed to one subject or actor.
 *
 * `sbSelectDark` rather than `sbSelect`: the difference between "nothing has
 * happened" and "we cannot see what happened" is the entire question an audit
 * log is asked, and the plain reader collapses both to an empty array.
 */
export async function readAdminAudit(opts?: {
  subjectEmail?: string | null;
  actorEmail?: string | null;
  action?: AdminAction | null;
  limit?: number;
}): Promise<AuditPage> {
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 100));
  const filters: string[] = [`order=created_at.desc`, `limit=${limit}`];
  if (opts?.subjectEmail) {
    filters.push(
      `subject_email=eq.${encodeURIComponent(String(opts.subjectEmail).trim().toLowerCase())}`
    );
  }
  if (opts?.actorEmail) {
    filters.push(
      `actor_email=eq.${encodeURIComponent(String(opts.actorEmail).trim().toLowerCase())}`
    );
  }
  if (opts?.action) filters.push(`action=eq.${encodeURIComponent(opts.action)}`);

  const rows = await sbSelectDark<AuditRow>(
    "admin_audit",
    `select=id,actor_email,actor_role,action,subject_email,detail,outcome,created_at&${filters.join("&")}`
  );
  if (rows === null) return { entries: [], degraded: ["admin_audit"] };

  return {
    entries: rows.map((r) => ({
      id: r.id,
      actorEmail: r.actor_email,
      actorRole: r.actor_role,
      action: r.action as AdminAction,
      subjectEmail: r.subject_email,
      detail: r.detail,
      outcome: (r.outcome as AdminOutcome) ?? "ok",
      at: Date.parse(r.created_at) || 0,
    })),
    degraded: [],
  };
}

/** A human label for an action, or the raw name for a row written by a newer
 *  deploy than the one rendering it. */
export function describeAction(action: string): string {
  return (ADMIN_ACTIONS as Record<string, string>)[action] ?? action;
}
