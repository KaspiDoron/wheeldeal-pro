import { NextResponse } from "next/server";
import { webhookToken, sendFromUser } from "@/lib/evolution";
import { sbSelect, sbInsertClaim, sbDelete } from "@/lib/runtime-config";

// SELF-CHAINING QUEUE DRIVER - the fix for "I locked my phone and nothing
// sent for an hour". When no background worker is running: the
// queue only moved when someone's app polled or the external pinger fired.
// This route keeps a staggered batch progressing on its own:
//
//   1. drain whatever is due
//   2. if the NEXT row is due within this invocation's time budget, wait for
//      it in-process and drain again (covers one 45-75s stagger step)
//   3. if more work is due soon, fire ONE fire-and-forget call to itself
//      (hop-bounded) so the chain continues in a fresh invocation
//
// Safety: token-gated (same derived token as the webhook/ping), a global
// 30s claim slot means at most ONE chain runner exists at a time no matter
// how many kicks arrive, and the hop counter hard-bounds a runaway chain.
// The activity polls + external ping cron remain independent backstops.

const MAX_HOPS = 40; // ~30-40 min of autonomous progression per kick
// Stay well inside Cloud Run's --timeout 90 (the REAL ceiling; `export const
// maxDuration` is a Vercel-only hint that does nothing on standalone Next -
// deploy-gcp.yml says so and this comment used to claim the inert guard).
const IN_CALL_BUDGET_MS = 45_000;
const CHAIN_HORIZON_MS = 10 * 60_000; // chain only for work due soon

export async function GET(req: Request) {
  const url = new URL(req.url);
  const expected = await webhookToken();
  const { tokenMatches } = await import("@/lib/wa/webhook-token");
  if (!expected || !tokenMatches(url.searchParams.get("token"), expected)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const hop = Math.max(0, Number(url.searchParams.get("hop")) || 0);

  // ONE runner at a time: whoever wins this 30s slot drives; everyone else
  // exits immediately (kicks are cheap and frequent by design).
  let claim = await sbInsertClaim("wa_send_claims", {
    sender_key: "__chain__",
    slot_key: `chain:${Math.floor(Date.now() / 30_000)}`,
  });
  if (claim === "lost" && hop > 0) {
    // A chained hop may land inside its parent's 30s window - wait for the
    // next window and try once more so the chain survives the handoff.
    const nextWindow = (Math.floor(Date.now() / 30_000) + 1) * 30_000;
    await new Promise((r) => setTimeout(r, Math.max(0, nextWindow - Date.now()) + 250));
    claim = await sbInsertClaim("wa_send_claims", {
      sender_key: "__chain__",
      slot_key: `chain:${Math.floor(Date.now() / 30_000)}`,
    });
  }
  if (claim === "lost") return NextResponse.json({ ok: true, ran: false, why: "another runner" });
  if (claim === "won" && hop === 0) {
    // A FRESH kick must not stack a second chain onto one that is already
    // mid-flight (a runner can span 2+ 30s windows): if the PREVIOUS window
    // slot is taken, a runner was active seconds ago - stand down.
    const prev = await sbInsertClaim("wa_send_claims", {
      sender_key: "__chain__",
      slot_key: `chain:${Math.floor(Date.now() / 30_000) - 1}`,
    });
    if (prev === "lost") {
      // RELEASE WHAT WE JUST TOOK. This branch used to return holding the
      // CURRENT window's chain slot, which it had won a few lines above. The
      // live runner's next hop then lost that slot, slept 30s waiting for the
      // window to roll, and - if another kick had leaked it again by then -
      // gave up entirely. Inbound volume was actively killing the drain: the
      // more shops replied, the more likely the chain died.
      await sbDelete(
        "wa_send_claims",
        `sender_key=eq.__chain__&slot_key=eq.${encodeURIComponent(
          `chain:${Math.floor(Date.now() / 30_000)}`
        )}`
      ).catch(() => {});
      return NextResponse.json({ ok: true, ran: false, why: "chain already live" });
    }
  }

  const started = Date.now();
  let drained = 0;
  const drainOnce = async () => {
    try {
      const { drainOutbox } = await import("@/lib/wa-guard");
      // fast=true: skip the long typing simulation - these rows already served
      // their stagger, and the guard (not presence cosmetics) enforces gaps.
      // Keeps a 5-row drain safely inside the 60s invocation ceiling.
      // 40s: the tick self-chains, so leaving rows for the next hop is
      // cheaper than being killed mid-send at Cloud Run's 90s ceiling and
      // stranding leased rows for the 3-minute claim lease.
      drained += await drainOutbox(
        (k, to, text, lane) => sendFromUser(k, to, text, true, { lane }),
        { budgetMs: 40_000 }
      );
      const { drainGraphWakeups } = await import("@/lib/graph/engine");
      drained += await drainGraphWakeups((k, to, text) => sendFromUser(k, to, text, true, { lane: "reply" }));
    } catch (e) {
      console.error("[wa:tick]", e instanceof Error ? e.message : e);
    }
  };
  /**
   * When is the next row we could USEFULLY wait for?
   *
   * This used to read the global minimum `not_before` with no lower bound, so a
   * single overdue cold-intro row - and a stalled batch leaves dozens - made
   * `due` permanently negative. The loop then took its "due right now" branch,
   * drained once, saw the same overdue row still sitting there (it was outside
   * the drain's 30-row slice, or held by the guard), concluded "not
   * progressing" and broke. Every hop did exactly one drain and handed off, so
   * the in-process wait that the fast-counter-reply path depends on never
   * happened while a batch was in flight.
   *
   * Asking only about the FUTURE fixes it: overdue work is the drain's problem,
   * not the wait's, and what we want to know here is when to wake up next.
   */
  const nextDueMs = async (): Promise<number | null> => {
    const rows = await sbSelect<{ not_before: string }>(
      "wa_outbox",
      `select=not_before&not_before=gt.${encodeURIComponent(
        new Date().toISOString()
      )}&order=not_before.asc&limit=1`
    ).catch(() => []);
    const at = rows[0] ? Date.parse(rows[0].not_before) : NaN;
    return Number.isFinite(at) ? at - Date.now() : null;
  };

  await drainOnce();
  // Ride out short waits inside THIS invocation - this is the whole point of
  // the chain, and the reason a reply parked 6-15s out can land on time.
  // `nextDueMs` now only ever reports FUTURE work, so there is no
  // "due right now but not progressing" state to detect: anything already due
  // was just drained, and anything the guard re-queued forward comes back as a
  // future time we can wait for.
  for (;;) {
    const due = await nextDueMs();
    if (due === null) break; // nothing scheduled ahead - chain ends
    const remaining = IN_CALL_BUDGET_MS - (Date.now() - started);
    if (due >= remaining) break; // too far out for this invocation - hand off
    await new Promise((r) => setTimeout(r, Math.max(0, due) + 500));
    await drainOnce();
  }

  // Continue the chain in a fresh invocation while near-term work remains.
  const due = await nextDueMs();
  if (due !== null && due < CHAIN_HORIZON_MS && hop < MAX_HOPS) {
    // The hop chain used to re-derive url.origin, so even a correctly-started
    // tick could not continue past hop 0 on Cloud Run.
    const { selfKickOrigin } = await import("@/lib/request-origin");
    const { kickDispatcher } = await import("@/lib/wa/kick");
    const origin = await selfKickOrigin(req);
    // 350ms WAS NOT A NUMBER, IT WAS A HOPE.
    //
    // This was a bare fetch plus a hand-rolled sleep, and the sleep was less
    // than a THIRD of the settle window kick.ts derived for exactly this
    // problem (KICK_SETTLE_MS = 1200). On Cloud Run the CPU drops to ~0 the
    // moment the response flushes, so an outgoing request that has not
    // finished its DNS/TCP/TLS handshake simply stops existing - and 350ms is
    // routinely short of that on a cold connection. The chain then ends
    // silently at whatever hop happened to lose the race, which is precisely
    // the "queue stuck" shape this chain exists to prevent.
    //
    // kickDispatcher races the settle window against the callee ANSWERING, so
    // the common case (the successor stands down immediately because another
    // runner holds the claim) still returns in milliseconds. One implementation
    // of "make sure this actually left", used by every site that needs it.
    await kickDispatcher(
      `${origin}/api/wa/tick?token=${encodeURIComponent(expected)}&hop=${hop + 1}`
    );
    return NextResponse.json({ ok: true, ran: true, drained, chained: true, hop });
  }
  return NextResponse.json({ ok: true, ran: true, drained, chained: false, hop });
}

export const maxDuration = 60;
