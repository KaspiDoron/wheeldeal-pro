// THE ACCOUNT FENCE FOR AN IN-FLIGHT NEGOTIATION TURN (audit F050).
//
// Erasure severs the WhatsApp link first, so the webhook stops delivering -
// but a turn that was ALREADY running kept going: a 72s wall, LLM calls in the
// middle, and rows written at the end (the inbound copy, vendor_replies,
// offers, the outbound send, events, wakeups) all keyed to an email whose
// account the walker had just deleted. The same held for a blocked account:
// the block only ever gated cookies, never the agent answering shops on the
// person's behalf. This is the one read a turn makes about the account it is
// acting for, at the two points where writes begin.
//
// Three refusals, one fail-open:
//   "erased"  - a POSITIVE "the row is gone" answer (sbSelectStrict separates
//               gone from unreadable), so nothing may be written for them.
//   "blocked" - the owner revoked the account; the agent says nothing more.
//   "revoked" - sessions_valid_from moved AFTER this turn began. Erasure
//               writes that horizon before its table walk, so a turn that
//               straddles an erase sees it here and stands down before it
//               re-creates what the walk is deleting. (A password change or
//               "sign out everywhere" landing mid-turn costs one delayed reply
//               - the claim is released and the recovery sweep retakes it.)
//   null      - the account is live, OR the store could not answer. An outage
//               must not mute every shop reply in the fleet.

import "server-only";
import { sbSelectStrict } from "../runtime-config";

export type TurnFence = "erased" | "blocked" | "revoked";

/** Same skew allowance as getSession: a horizon in the future is corruption, ignored. */
const HORIZON_SKEW_MS = 5 * 60_000;

export async function accountTurnFence(
  email: string | null | undefined,
  startedAtMs: number
): Promise<TurnFence | null> {
  const key = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  const read = await sbSelectStrict<{ status: string | null; sessions_valid_from: string | null }>(
    "app_users",
    `select=status,sessions_valid_from&email=eq.${encodeURIComponent(key)}&limit=1`
  ).catch(() => ({ error: "unavailable" as const }));
  if ("error" in read) return null;
  const row = read.rows[0];
  if (!row) return "erased";
  if (row.status === "blocked") return "blocked";
  const horizon = row.sessions_valid_from ? Date.parse(row.sessions_valid_from) : NaN;
  if (
    Number.isFinite(horizon) &&
    horizon > startedAtMs &&
    horizon <= Date.now() + HORIZON_SKEW_MS
  ) {
    return "revoked";
  }
  return null;
}
