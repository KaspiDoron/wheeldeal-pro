// WheelDeal workers - one Node process hosting all five BullMQ workers
// (1GB-VM memory plan: a single ~200MB process, not five). Each worker is a
// separate BullMQ consumer with its own concurrency; graceful shutdown drains
// in-flight jobs before exit so a deploy never drops a half-processed reply.

import { logger, installProcessGuards } from "@wheeldeal/shared";
import { startIncomingWorker } from "./incoming.worker";
import { startOutboundWorker } from "./outbound.worker";
import { startVisionWorker } from "./vision.worker";
import { startOutreachWorker } from "./outreach.worker";
import { startSchedulerWorker, scheduleHeartbeat } from "./scheduler.worker";
import { rearmOpenWebhooks } from "@wheeldeal/core";

async function main() {
  // Install BEFORE any worker starts, so a rejection thrown during boot is
  // reported rather than killing the process anonymously.
  installProcessGuards("workers");
  const workers = [
    startIncomingWorker(),
    startOutboundWorker(),
    startVisionWorker(),
    startOutreachWorker(),
    startSchedulerWorker(),
  ];
  await scheduleHeartbeat();
  // Immediate one-shot webhook re-arm on boot so a deploy (e.g. after a secret
  // rotation) pushes the current-token URL to Evolution right away, rather than
  // waiting for the first 30m repeatable tick. Best-effort; never blocks boot.
  rearmOpenWebhooks()
    .then((r) => logger.info(r, "boot webhook re-arm"))
    .catch((e) => logger.warn({ err: (e as Error).message }, "boot webhook re-arm failed"));
  logger.info({ workers: workers.length }, "workers up (heartbeat drain every 20s)");

  let shuttingDown = false;
  // Hard ceiling on the drain. `close()` waits for in-flight jobs, and a job
  // wedged on a slow upstream could block exit indefinitely - the orchestrator
  // would then SIGKILL us anyway, just later and less cleanly.
  const DRAIN_DEADLINE_MS = 15_000;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ sig }, "workers shutting down (draining in-flight jobs)");
      const forced = setTimeout(() => {
        logger.warn({ sig, ms: DRAIN_DEADLINE_MS }, "drain deadline hit - exiting anyway");
        process.exit(0);
      }, DRAIN_DEADLINE_MS);
      forced.unref();
      try {
        await Promise.allSettled(workers.map((w) => w.close()));
      } catch {
        /* allSettled cannot reject; belt and braces for a throwing close() */
      }
      clearTimeout(forced);
      process.exit(0);
    });
  }
}

main().catch((e) => {
  logger.error({ err: (e as Error).message }, "workers failed to start");
  process.exit(1);
});
