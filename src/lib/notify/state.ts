// The facts `worthAnInterruption` judges against, read from what the search has
// already produced. Derived per push rather than stored - the same discipline
// as everywhere else here, so there is no counter to keep in sync and nothing
// that can drift from what the traveller actually saw.

import "server-only";
import type { NotifyState } from "./significance";
import { huntState } from "./liveness";

/** How far back "already interrupted enough for one search" looks. */
export const NOTIFY_WINDOW_SEC = 3600;

const EMPTY: NotifyState = { anyReplyYet: false, sentInWindow: 0, huntLive: false };

export async function notifyState(
  email: string,
  nowMs = Date.now(),
  /**
   * The shop this event is about. Supplying it adds ONE fact: what that shop
   * quoted last time. Without it a shop moving 250 -> 200 while another sits
   * at 180 is invisible - not the session best, so not news - and that move is
   * the only evidence the traveller has that the negotiation is working.
   */
  vendorId?: string
): Promise<NotifyState> {
  if (!email) return EMPTY;
  const { sbSelect } = await import("../runtime-config");
  const since = new Date(nowMs - NOTIFY_WINDOW_SEC * 1000).toISOString();
  const who = encodeURIComponent(email);

  // THE HUNT ITSELF, FIRST. Its liveness feeds the gate (a hunt that is over
  // has nothing push-worthy left in it), and its start time floors every fact
  // below - `bestPricePerDay` and `anyReplyYet` were ALL-TIME reads, so last
  // week's hunt suppressed this week's "first price of the search" and the
  // first-reply branch could never fire twice in a lifetime.
  const hunt = await huntState(email, nowMs);
  // No floor when the hunt is unreadable: the old all-time behavior is the
  // open direction, and an empty floor string interpolates as no filter.
  const floor = hunt.startedIso ? `&created_at=gte.${encodeURIComponent(hunt.startedIso)}` : "";

  const [sent, best, anyReply] = await Promise.all([
    sbSelect<{ id: number }>(
      "agent_events",
      `select=id&kind=eq.push-sent&user_email=eq.${who}&created_at=gte.${encodeURIComponent(
        since
      )}&limit=20`
    ).catch(() => [] as { id: number }[]),
    sbSelect<{ price_per_day: number | null; currency: string | null }>(
      "vendor_replies",
      `select=price_per_day,currency&user_email=eq.${who}&found=is.true&price_per_day=not.is.null${floor}&order=price_per_day.asc&limit=1`
    ).catch(() => [] as { price_per_day: number | null; currency: string | null }[]),
    sbSelect<{ id: number }>(
      "vendor_replies",
      `select=id&user_email=eq.${who}${floor}&limit=1`
    ).catch(() => [] as { id: number }[]),
  ]);

  // THIS shop's previous quote - the row BEFORE the one that just landed, so
  // the comparison is against what the traveller had already been told. Two
  // rows, newest first; index 1 is the previous one. Floored like the rest:
  // what this shop quoted in LAST week's hunt is not "its previous quote".
  let vendorPreviousPricePerDay: number | undefined;
  if (vendorId) {
    const mine = await sbSelect<{ price_per_day: number | null }>(
      "vendor_replies",
      `select=price_per_day&user_email=eq.${who}&vendor_id=eq.${encodeURIComponent(
        vendorId
      )}&price_per_day=not.is.null${floor}&order=created_at.desc&limit=2`
    ).catch(() => [] as { price_per_day: number | null }[]);
    vendorPreviousPricePerDay = mine[1]?.price_per_day ?? undefined;
  }

  return {
    sentInWindow: sent.length,
    bestPricePerDay: best[0]?.price_per_day ?? undefined,
    bestCurrency: best[0]?.currency ?? undefined,
    anyReplyYet: anyReply.length > 0,
    vendorPreviousPricePerDay,
    huntLive: hunt.live,
  };
}

/** Record that we spent one of the traveller's interruptions, and on what. */
export async function markPushSent(email: string, reason: string): Promise<void> {
  if (!email) return;
  const { sbInsert } = await import("../runtime-config");
  await sbInsert("agent_events", [
    { kind: "push-sent", user_email: email, vendor_id: "", vendor_name: "", detail: reason.slice(0, 200) },
  ]).catch(() => {});
}

/**
 * Record that the significance gate DECLINED to interrupt, and why. This is the
 * kind `ops/vitals.pushBreadcrumbs` and the health panel count - both read
 * `push-skipped` and, until this writer existed, nothing ever wrote it, so the
 * gate's whole decision layer was invisible (a structural zero rendering as
 * "nothing was ever suppressed").
 */
export async function markPushSkipped(email: string, reason: string): Promise<void> {
  if (!email) return;
  const { sbInsert } = await import("../runtime-config");
  await sbInsert("agent_events", [
    { kind: "push-skipped", user_email: email, vendor_id: "", vendor_name: "", detail: reason.slice(0, 200) },
  ]).catch(() => {});
}
