// scheduler.worker - the persistent heartbeat that REPLACES every external
// cron (blueprint Module 6): a repeatable BullMQ job drains the parked outbox
// (business-hours / pacing queue) and due graph wakeups (strategic waits)
// every 20s, 24/7, whether or not any user has the app open. This is the
// production fix for "no external cron + dropped tick fetch".

import { Worker, type Job } from "bullmq";
import {
  drainOutbox,
  drainGraphWakeups,
  sendFromUser,
  reassertWebhook,
  rearmOpenWebhooks,
  sbSelect,
  recentActiveSenders,
  syncInboundReplies,
  pickSweepEmails,
  sweepCapForFleet,
  setDrainArmer,
} from "@wheeldeal/core";
import { logger } from "@wheeldeal/shared";
import { bullConnection } from "@wheeldeal/redis";
import {
  queue,
  SCHEDULER_QUEUE,
  OUTREACH_QUEUE,
  OUTREACH_DLQ,
  INCOMING_DLQ,
  type SchedulerJob,
} from "@wheeldeal/queues";

const DRAIN_EVERY_MS = 20_000;
const GC_EVERY_MS = 30 * 60_000; // 30m
const DLQ_SWEEP_EVERY_MS = 15 * 60_000; // 15m
const REARM_EVERY_MS = 30 * 60_000; // 30m - reassert webhooks (find+set, throttled ~1h/instance)
const RECOVERY_EVERY_MS = 60_000; // 1m - app-closed inbound-recovery sweep (<=3 senders/tick)
/**
 * FLOOR, not the value. The per-tick sweep width is computed from the live
 * fleet by `sweepCapForFleet` - which was written for exactly this and then
 * used only on the Render half, while this worker kept a hardcoded 3. At a
 * 50-user beta with ~20 shops each that is a ~68-minute worst case before a
 * webhook a provider dropped gets noticed; proportional it is ~20.
 */
const RECOVERY_PER_TICK_MIN = 3;
/** Only arm a precise drain for work due soon; the heartbeat covers the rest. */
const ARM_HORIZON_MS = 10 * 60_000;

/** Register the repeatable heartbeat jobs (idempotent - same repeat keys). */
export async function scheduleHeartbeat(): Promise<void> {
  const q = queue(SCHEDULER_QUEUE);
  await q.add("drain", { kind: "drain" } satisfies SchedulerJob, {
    repeat: { every: DRAIN_EVERY_MS },
    jobId: "heartbeat-drain",
    removeOnComplete: 20,
    removeOnFail: 50,
  });
  // GC (Module 6): budget keys all carry TTLs and slot counters self-heal in
  // <=6h, so there is nothing to DELETE - this is an OBSERVABILITY sweep only
  // (no SCAN on the shared 160MB instance). It logs queue + DLQ health.
  await q.add("gc", { kind: "gc" } satisfies SchedulerJob, {
    repeat: { every: GC_EVERY_MS },
    jobId: "heartbeat-gc",
    removeOnComplete: 10,
    removeOnFail: 20,
  });
  // DLQ depth alerting surface (no mutation).
  await q.add("dlq-sweep", { kind: "dlq-sweep" } satisfies SchedulerJob, {
    repeat: { every: DLQ_SWEEP_EVERY_MS },
    jobId: "heartbeat-dlq",
    removeOnComplete: 10,
    removeOnFail: 20,
  });
  // Webhook re-arm: reassert every open instance's webhook URL with the CURRENT
  // token (find+set only - never touches the session). This is what recovers
  // inbound after a SESSION_SECRET rotation without any manual Evolution edit.
  await q.add("webhook-rearm", { kind: "webhook-rearm" } satisfies SchedulerJob, {
    repeat: { every: REARM_EVERY_MS },
    jobId: "heartbeat-webhook-rearm",
    removeOnComplete: 10,
    removeOnFail: 20,
  });
  // Inbound-recovery sweep: pull recent shop replies for a few senders each
  // minute so a webhook that briefly missed an event (or a user with the app
  // closed) still recovers, without the app being open. wa-sync's own throttle
  // + isVendorThread scoping apply, so this can never over-read or spam.
  await q.add("inbound-recovery", { kind: "inbound-recovery" } satisfies SchedulerJob, {
    repeat: { every: RECOVERY_EVERY_MS },
    jobId: "heartbeat-inbound-recovery",
    removeOnComplete: 10,
    removeOnFail: 20,
  });
}

export function startSchedulerWorker(): Worker<SchedulerJob> {
  const worker = new Worker<SchedulerJob>(
    SCHEDULER_QUEUE,
    async (job: Job<SchedulerJob>) => {
      if (job.data.kind === "drain") {
        // Same senders as the legacy drains: each user's own linked WhatsApp.
        //
        // LANE AND SPEED, both of which this worker was dropping. `sendFromUser`
        // defaults to the INTRO lane (the tighter cold cap) and to the slow
        // presence simulation, so every agent reply drained from here was
        // metered against the cold-introduction budget - starving a traveller's
        // own batch of its replies - and paid 4-12s of typing theatre it does
        // not need. That is the same defect RC-2 fixed at the route sites; this
        // worker was outside the sweep that found them, which is exactly how a
        // defect survives its own fix.
        //
        // The drain already knows which lane each row belongs to and passes it
        // as the fourth argument. Accepting it is the whole change.
        await drainOutbox((senderKey, to, text, lane) =>
          sendFromUser(senderKey, to, text, true, { lane })
        ).catch((e) => logger.warn({ err: (e as Error).message }, "outbox drain error"));
        await drainGraphWakeups((senderKey, to, text) =>
          sendFromUser(senderKey, to, text, true, { lane: "reply" })
        ).catch((e) => logger.warn({ err: (e as Error).message }, "wakeup drain error"));
      } else if (job.data.kind === "gc") {
        // Observability sweep - all budget keys carry TTLs, nothing to delete.
        const counts = await queue(OUTREACH_QUEUE)
          .getJobCounts("waiting", "active", "delayed", "failed")
          .catch(() => ({}));
        logger.info({ outreach: counts }, "heartbeat gc - queue health");
      } else if (job.data.kind === "dlq-sweep") {
        const [outreach, incoming] = await Promise.all([
          queue(OUTREACH_DLQ).getJobCounts("waiting").catch(() => ({})),
          queue(INCOMING_DLQ).getJobCounts("waiting").catch(() => ({})),
        ]);
        const depth =
          Number((outreach as { waiting?: number }).waiting ?? 0) +
          Number((incoming as { waiting?: number }).waiting ?? 0);
        if (depth > 0) logger.warn({ outreach, incoming }, "DLQ depth > 0 - inspect Bull Board");
        else logger.info({ outreach, incoming }, "heartbeat dlq-sweep - clean");
      } else if (job.data.kind === "webhook-rearm") {
        const res = await rearmOpenWebhooks().catch((e) => {
          logger.warn({ err: (e as Error).message }, "webhook re-arm error");
          return null;
        });
        if (res) logger.info(res, "heartbeat webhook-rearm");
      } else if (job.data.kind === "inbound-recovery") {
        try {
          const senders = await recentActiveSenders();
          const minute = Math.floor(Date.now() / 60_000);
          const width = Math.max(RECOVERY_PER_TICK_MIN, sweepCapForFleet(senders.length));
          const picked = pickSweepEmails(senders, minute, width);
          let recovered = 0;
          for (const email of picked) {
            recovered += await syncInboundReplies(email).catch(() => 0);
          }
          if (recovered > 0) logger.info({ picked: picked.length, recovered }, "inbound-recovery sweep");
        } catch (e) {
          logger.warn({ err: (e as Error).message }, "inbound-recovery error");
        }
      }
    },
    { connection: bullConnection(), concurrency: 1 } // one drainer - no herd
  );
  // PARK -> DRAIN AT THE EXACT DUE TIME. The heartbeat is a 20s backstop, so a
  // reply parked 6-15s out actually landed anywhere up to a heartbeat later -
  // the composer's delay was a floor, not the latency. Arming a delayed job at
  // not_before removes that tail entirely. The jobId collapses everything due
  // in the same second to ONE job, so 40 shops answering at once cannot fan out
  // into 40 drains (concurrency is 1 regardless, but the queue stays small).
  setDrainArmer((atMs) => {
    const delay = Math.max(0, atMs - Date.now());
    if (delay > ARM_HORIZON_MS) return; // far-future rows are the heartbeat's job
    queue(SCHEDULER_QUEUE)
      .add("drain", { kind: "drain" } satisfies SchedulerJob, {
        delay,
        jobId: `drain-at-${Math.floor(atMs / 1000)}`,
        removeOnComplete: 50,
        removeOnFail: 50,
      })
      .catch((e) => logger.warn({ err: (e as Error).message }, "drain arm failed"));
  });
  return worker;
}
