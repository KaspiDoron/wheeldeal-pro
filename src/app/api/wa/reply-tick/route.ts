import { NextResponse } from "next/server";
import { webhookToken, sendFromUser } from "@/lib/evolution";
import { sbSelect, sbInsertClaim, sbDelete } from "@/lib/runtime-config";
import { REPLY_KIND_FILTER } from "@/lib/wa-guard";

// THE REPLY LANE'S OWN DISPATCHER.
//
// Ko Tao, 31 July. A shop quoted at 12:22; our answer landed at 12:39. The
// answer was composed on time - it just had nowhere to go.
//
// Every inbound webhook already kicked `/api/wa/tick`, which is the right
// idea, but that route is ONE GLOBAL RUNNER: it holds a `chain:<30s window>`
// claim and, while a cold introductions batch keeps the outbox non-empty, it
// re-claims a fresh window on every hop. A `hop=0` kick from ingest therefore
// hit "another runner" or "chain already live" one hundred percent of the
// time. The batch drained at ~12:46, the chain ended, the very next reply went
// out in three minutes. The reply lane was never slow; it was queued behind
// somebody else's lock.
//
// So replies get their own dispatcher, and it is deliberately NOT a variant of
// the chain:
//
//   - PER SENDER. One traveller's batch cannot gate another's reply, and a
//     20-second claim window collapses a burst of webhooks into one runner
//     without ever refusing a different user.
//   - REPLY ROWS ONLY (`replyOnly`), so the cold batch is not even in its
//     result set - no priority sort to lose, nothing to rank behind.
//   - IT WAITS. A reply is parked a human delay (~10-40s) into the future by
//     design; the whole value of an in-process wait is landing it on time
//     instead of on the next cron minute.
//
// Everything that keeps this safe is downstream and unchanged: guardOutbound's
// twelve gates, the atomic pacing claims, the per-recipient mutex that stops
// this lane and the cold lane arriving at one shop together, and the
// freshness re-gate that drops a draft the conversation has moved past.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CLAIM_WINDOW_MS = 20_000;
// Inside Cloud Run's --timeout 90 (the real ceiling - `maxDuration` above is
// a Vercel-only hint, inert on standalone Next), with room to return.
const IN_CALL_BUDGET_MS = 45_000;
const MAX_HOPS = 12; // ~9 min of autonomous reply progression per kick
const CHAIN_HORIZON_MS = 3 * 60_000; // a reply further out than this is not urgent

const slotFor = (sender: string, atMs: number) =>
  `reply:${sender}:${Math.floor(atMs / CLAIM_WINDOW_MS)}`;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const expected = await webhookToken();
  const { tokenMatches } = await import("@/lib/wa/webhook-token");
  if (!expected || !tokenMatches(url.searchParams.get("token"), expected)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const sender = (url.searchParams.get("sender") ?? "").trim();
  if (!sender) return NextResponse.json({ error: "sender required" }, { status: 400 });
  const hop = Math.max(0, Number(url.searchParams.get("hop")) || 0);

  const slot = slotFor(sender, Date.now());
  const claim = await sbInsertClaim("wa_send_claims", {
    sender_key: "__reply__",
    slot_key: slot,
  });
  // Only a DEFINITE loss stands down. An "error" (no claims table, a database
  // blip) runs anyway - unlike a send claim, this lock is not a safety gate,
  // it only stops a herd of webhooks spawning a herd of runners. The real
  // gates are guardOutbound and the pacing claims, and they run per message
  // whatever happens here; the worst case of an extra runner is a drain that
  // finds every row already claimed by lease and sends nothing.
  if (claim === "lost") {
    return NextResponse.json({ ok: true, ran: false, why: "another reply runner" });
  }

  const started = Date.now();
  let drained = 0;
  const drainOnce = async () => {
    try {
      const { drainOutbox } = await import("@/lib/wa-guard");
      drained += await drainOutbox(
        (k, to, text, lane) => sendFromUser(k, to, text, true, { lane }),
        { replyOnly: true, senderKey: sender, budgetMs: 40_000 }
      );
    } catch (e) {
      console.error("[wa:reply-tick]", e instanceof Error ? e.message : e);
    }
  };

  /** When is this sender's next FUTURE reply due? null when there is none. */
  const nextReplyDueMs = async (): Promise<number | null> => {
    const rows = await sbSelect<{ not_before: string }>(
      "wa_outbox",
      `select=not_before&sender_key=eq.${encodeURIComponent(sender)}` +
        REPLY_KIND_FILTER +
        `&not_before=gt.${encodeURIComponent(new Date().toISOString())}` +
        `&order=not_before.asc&limit=1`
    ).catch(() => []);
    const at = rows[0] ? Date.parse(rows[0].not_before) : NaN;
    return Number.isFinite(at) ? at - Date.now() : null;
  };

  await drainOnce();
  for (;;) {
    const due = await nextReplyDueMs();
    if (due === null) break;
    const remaining = IN_CALL_BUDGET_MS - (Date.now() - started);
    if (due >= remaining) break;
    await new Promise((r) => setTimeout(r, Math.max(0, due) + 400));
    await drainOnce();
  }

  const due = await nextReplyDueMs();
  const chaining = due !== null && due < CHAIN_HORIZON_MS && hop < MAX_HOPS;
  if (chaining) {
    // RELEASE BEFORE HANDING OFF. The chain route learned this the hard way:
    // a runner that returns still holding its window makes its own successor
    // lose. Our window may have rolled while we waited, so delete the key we
    // actually took - after which the successor's claim is free either way.
    await sbDelete(
      "wa_send_claims",
      `sender_key=eq.__reply__&slot_key=eq.${encodeURIComponent(slot)}`
    ).catch(() => {});
    const { selfKickOrigin } = await import("@/lib/request-origin");
    const { kickDispatcher } = await import("@/lib/wa/kick");
    const origin = await selfKickOrigin(req);
    // AND THE RELEASE ABOVE IS WHY THIS ONE MATTERS MOST.
    //
    // The claim is deleted BEFORE the hop is fired, deliberately - a runner
    // that returns still holding its window makes its own successor lose. But
    // that ordering means a hop which never leaves the instance is not merely a
    // missed beat: the window is already released and NOBODY is draining this
    // sender. The 350ms sleep was under a third of kick.ts's own settle floor,
    // derived for exactly this failure, so the release was being paid for with
    // a handoff that might not have happened.
    await kickDispatcher(
      `${origin}/api/wa/reply-tick?token=${encodeURIComponent(expected)}` +
        `&sender=${encodeURIComponent(sender)}&hop=${hop + 1}`
    );
  }
  return NextResponse.json({ ok: true, ran: true, drained, chained: chaining, hop });
}
