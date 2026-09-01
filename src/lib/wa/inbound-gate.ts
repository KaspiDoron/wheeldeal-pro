// BOUNDED CONCURRENCY FOR WEBHOOK AI TURNS (owner report 4, scale #7).
//
// With --concurrency 32 one Cloud Run instance can be handed 32 webhooks at
// once, and each inbound turn runs the whole LLM chain (extraction -> engine ->
// validator -> localization). 32 concurrent chains on a 1GB/1-CPU instance is
// how memory spikes and everyone's reply slows together. This gate caps the
// number of heavy turns IN FLIGHT per instance; the rest queue for a slot
// rather than piling on. It is a smoother, not a limiter: nothing is dropped,
// and a waiter that would exceed the caller's patience simply proceeds
// ungated (better a slightly-heavy moment than a lost reply).
//
// In-process by design - it protects THIS instance's RAM/CPU, which is a
// per-instance resource. The full cross-fleet offload is the BullMQ workers
// upgrade path; this is the serverless-path floor.

const MAX_INFLIGHT = 4;
/**
 * A waiter never blocks longer than this before proceeding ungated.
 *
 * SIZED TO THE WORK - AND TO THE REQUEST CEILING. A full inbound turn is
 * 15-45s (comprehension 7s + the SPTE pass 9s + up to 10s of human pause +
 * guard/send round trips), and the old 8s patience meant the 5th concurrent
 * turn waited 8s for a slot that could not possibly free, then ran ungated
 * anyway - the gate bought pure latency and zero protection, by
 * construction. The honest maximum is bounded above by Cloud Run's
 * `--timeout 90` (the real ceiling; maxDuration is inert on standalone
 * Next): wait + turn must stay under it. That queues a waiter behind the TAIL
 * of a median turn (~15-25s) - real smoothing - while the proceed-ungated
 * escape stays as the never-eat-a-reply floor for genuinely long waits.
 *
 * THE ARITHMETIC ABOVE WAS DERIVED AGAINST A 45s TURN AND THEN SILENTLY WENT
 * OVER THE CEILING. 20s was correct when the turn wall was 45s (20 + 45 = 65).
 * Commit ee10961 raised TURN_WALL_MS to 72_000 and this constant was never
 * re-derived: 20 + 72 = 92 against a 90s request timeout. The gate and the turn
 * are SEQUENTIAL - withInboundSlot wraps processVendorReply and the turn clock
 * starts after acquire() returns - so the sum is real, not a worst case that
 * cannot happen.
 *
 * What a kill costs is why this matters: the inbound claim is a TEN-MINUTE
 * lease, and after it lapses the recovery sweep reaches ~3 senders a minute, so
 * a 25-sender fleet needs another ~9 minutes to come back round. A reply killed
 * 2s over the ceiling is stranded for roughly nineteen minutes, against a
 * product that promises a first reply in 15-25 seconds.
 *
 * 12s restores the margin (12 + 72 = 84, leaving ~6s for auth, parse, the
 * response write and the opportunistic drain) WITHOUT touching the turn clock -
 * which is the point. Five downstream budgets are derived from the turn wall
 * (the localize floor, the human pause, the vision budget and its per-call
 * split, the re-read rescue); moving the wall to buy the same margin would
 * shrink every one of them, and on a contended photo turn it would take the
 * human thinking pause to zero on a fleet of the travellers' own personal
 * WhatsApp numbers. The gate is the half that can move for free.
 */
const MAX_WAIT_MS = 12_000;

let inflight = 0;
const waiters: Array<() => void> = [];

/** Exposed for tests + the KPI card. */
export function inboundInflight(): { inflight: number; queued: number } {
  return { inflight, queued: waiters.length };
}

/** Test hook. */
export function resetInboundGate(): void {
  inflight = 0;
  waiters.length = 0;
}

/**
 * Run `work` with at most MAX_INFLIGHT concurrent heavy turns per instance.
 * Acquires a slot (waiting up to MAX_WAIT_MS), always releases it - and never
 * changes what `work` returns or throws. A gate must never eat a reply.
 */
export async function withInboundSlot<T>(work: () => Promise<T>): Promise<T> {
  const acquired = await acquire();
  try {
    return await work();
  } finally {
    if (acquired) release();
  }
}

async function acquire(): Promise<boolean> {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return true;
  }
  // Wait for a slot, but bounded: a reply that waits forever is worse than one
  // heavy moment. If the timer wins, proceed WITHOUT holding a slot (so we do
  // not later release one we never took, and never wedge the counter).
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = waiters.indexOf(grant);
      if (i >= 0) waiters.splice(i, 1);
      resolve(false);
    }, MAX_WAIT_MS);
    const grant = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inflight++;
      resolve(true);
    };
    waiters.push(grant);
  });
}

function release(): void {
  inflight = Math.max(0, inflight - 1);
  const next = waiters.shift();
  if (next) next();
}
