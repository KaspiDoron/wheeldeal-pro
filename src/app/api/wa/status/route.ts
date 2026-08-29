import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  connectionState,
  evolutionConfigured,
  isLinkedForUi,
  touchActivity,
  markOpen,
} from "@/lib/evolution";
import { deriveConnectionPhase } from "@/lib/wa/connection-state";

// Current state of the user's personal WhatsApp session.
//
// A transient drop (Render sleeping/restarting) is NOT treated as "disconnected"
// - if the user has paired before, we report connected+reconnecting so the UI
// stays calm and the send path auto-resumes from saved credentials.
export const dynamic = "force-dynamic";

// How long the live-socket probe may hold the response. Past this we answer
// from the durable pairing record - which is the only thing the "is it linked?"
// gate actually needs - and let the probe finish in the background.
const SOCKET_PROBE_MS = 4_000;

// This answer changes the moment the traveller links or unlinks, and a stale
// "connected:false" replayed from a cache is indistinguishable from a real
// disconnection. Never cache it, anywhere.
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "Sign in first." }, { status: 401, headers: NO_STORE });

  const available = await evolutionConfigured();
  if (!available)
    return NextResponse.json({ available: false, connected: false }, { headers: NO_STORE });

  // PAIRING HOT PATH: while the connect screen polls every ~2s the user has no
  // outbox to drain, and firing two full drains per poll turned a cheap status
  // read into the most expensive request in the app right when latency matters
  // most. The client sets ?pairing=1 for those polls.
  //
  // `drain=0` is the same request from the other direction: any caller whose
  // ABORT IS SHORTER THAN OUR DRAIN BUDGET must be able to say so. The two
  // drains below are bounded at 8s EACH and run before the response, so the
  // worst case was 4s (socket probe) + 16s = ~20s - while every client that
  // asks this question aborts at 8s. Under any backlog the read could not
  // succeed AT ALL, and the failure was not neutral: /login read the timeout as
  // "no need to link" and sent brand-new accounts straight past WhatsApp
  // linking, which is the one thing signup exists to set up.
  const params = new URL(req.url).searchParams;
  const pairing = params.get("pairing") === "1" || params.get("drain") === "0";

  // ANSWER FAST, EVEN WHEN EVOLUTION IS ASLEEP.
  //
  // connectionState probes the Evolution host TWICE (connectionState, then the
  // instance list), each bounded at 12s - so a cold Render host could hold this
  // response ~25s. That is what stranded the UI: the Profile pill sat on
  // "CHECKING..." and the Find-deals gate recorded the failed read as
  // "confirmed unlinked" and drew the blur lock over a linked account.
  //
  // The two questions have very different costs, so ask them in parallel and
  // bound the expensive one. `paired` is a Supabase read and answers in
  // milliseconds; it is also the ONLY input the "is this linked?" gate needs.
  // The socket probe merely refines live-vs-reconnecting, so when it is slow we
  // publish the durable answer instead of making the traveller wait for it.
  // fresh: the status page is the surface that must show LIVE socket truth -
  // the short open-verdict cache exists for the send path, not for here.
  const socketProbe = connectionState(session.email, { fresh: true }).catch(() => null);
  const [storedPaired, state] = await Promise.all([
    isLinkedForUi(session.email).catch(() => false),
    Promise.race([
      socketProbe,
      new Promise<null>((r) => setTimeout(() => r(null), SOCKET_PROBE_MS)),
    ]),
  ]);
  // A late socket answer is still worth having: let it settle markOpen in the
  // background so the NEXT read is exact.
  void socketProbe;
  // "paired" = the user GENUINELY linked before (durable status "open"), not
  // merely "a session row exists" - a not-yet-linked "connecting" row must NOT
  // read as connected (that made first-time pairing report linked on the first
  // 3s poll and clear the code before the user entered it). isLinkedForUi still
  // fails SAFE on a DB blip, so a transient host outage reports
  // connected+reconnecting, never a hard "disconnected" that re-links a paired user.
  const paired = state === "open" ? true : storedPaired;

  // Persist "open" durably whenever we observe a live socket, so the send path
  // never later mistakes a transient drop for "never connected".
  if (state === "open") markOpen(session.email).catch(() => {});

  // App-activity heartbeat: the session stays "awake" only while the app is
  // actually being used; idle sessions are quieted by pauseIdleSessions.
  touchActivity(session.email).catch(() => {});

  // Opportunistic anti-ban outbox drain: the app polling status while open is
  // our free "worker tick" for business-hours / pacing-queued messages.
  if (!pairing) {
    try {
      // ONE DRAIN OWNER PER CYCLE (E2/L2) - shared claim with /api/replies
      // and /api/activity, so the three sibling polls stop draining the same
      // queue back-to-back inside one traveller's cycle.
      const { claimDrainSlot } = await import("@/lib/wa/drain-owner");
      if (claimDrainSlot(session.email)) {
      const { drainOutbox } = await import("@/lib/wa-guard");
      const { sendFromUser } = await import("@/lib/evolution");
      // AWAITED, not fire-and-forget - the same Cloud Run truth the activity
      // route documents: CPU is throttled to ~0 once the response is flushed,
      // so a `void` drain here was suspended mid-send and the row it had just
      // claimed sat until something else picked it up. Bounded so a slow host
      // can never hold this poll open.
      //
      // fast=true - see the note on the ingest drain: the presence simulation
      // costs 4-12s per row and none of the anti-ban floors depend on it.
      // 3s, matching /api/replies and /api/activity - this was the 8s the
      // other two were explicitly lowered FROM, applied twice per poll, so a
      // status poll could hold a Cloud Run concurrency slot for 16s.
      const DRAIN_BUDGET_MS = 3_000;
      const bounded = <T,>(p: Promise<T>) =>
        Promise.race([p, new Promise((r) => setTimeout(r, DRAIN_BUDGET_MS))]);
      // SCOPED. The third of three sibling polls that drained GLOBALLY inside
      // one traveller's request - /api/replies was fixed, /api/activity is
      // fixed in this same change, and leaving this one unscoped would keep the
      // whole users-x-users cost alive through a different door.
      await bounded(
        drainOutbox(
          (senderKey, to, text, lane) => sendFromUser(senderKey, to, text, true, { lane }),
          { senderKey: session.email }
        ).catch(() => {})
      );
      const { drainGraphWakeups } = await import("@/lib/graph/engine");
      await bounded(
        drainGraphWakeups(
          (senderKey, to, text) => sendFromUser(senderKey, to, text, true, { lane: "reply" }),
          { userEmail: session.email }
        ).catch(() => {})
      );
      }
    } catch {
      /* best-effort */
    }
  }

  // THE ROTATION SIGNAL (owner report 3, first-code-rejected). Baileys rotates
  // the pairing code server-side and the QRCODE_UPDATED webhook stamps
  // `pairing_code_issued_at` - but this poll never carried the stamp, so the
  // client kept a dead code on screen until its LOCAL 55s countdown lapsed.
  // With the stamp in the poll, WaConnect re-issues the moment the server
  // rotates, and "Incorrect code" on the first attempt stops happening.
  let pairingIssuedAt: string | null = null;
  if (pairing) {
    const { sbSelect } = await import("@/lib/runtime-config");
    const row = await sbSelect<{ pairing_code_issued_at: string | null }>(
      "wa_sessions",
      `select=pairing_code_issued_at&email=eq.${encodeURIComponent(
        session.email.toLowerCase()
      )}&limit=1`
    ).catch(() => [] as { pairing_code_issued_at: string | null }[]);
    pairingIssuedAt = row[0]?.pairing_code_issued_at ?? null;
  }

  return NextResponse.json({
    available: true,
    state: state ?? "disconnected",
    // Linked from the user's perspective if live-open OR paired-and-reconnecting.
    connected: state === "open" || paired,
    live: state === "open",
    reconnecting: paired && state !== "open",
    ...(pairing ? { pairingIssuedAt } : {}),
    // Server-side phase for callers with no credential context (e.g. the
    // Profile pill). The connect screen re-derives with the same pure function,
    // adding what only it knows: whether a code is on screen and its remaining
    // life. One definition, two levels of detail.
    phase: deriveConnectionPhase({ state, paired }),
  }, { headers: NO_STORE });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
