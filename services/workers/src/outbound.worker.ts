// outbound.worker - consumes outbound_queue (blueprint Module 6).
//
// FENCED: this worker used to send DIRECTLY (guardOutbound -> sendFromUser),
// which made it the ONE send path in the system with no atomic idempotency
// claim (guardOutbound's checks are read-then-act), no TRUTH-RULE outbound
// row after the send (so every shop reply to a worker-sent message would die
// as `no-rfq-thread`), no ambiguous status-0 handling, and a BullMQ
// throw-to-retry that re-POSTs a message that may already have landed - the
// exact duplicate class OR11/H2.2 eliminated from every other path.
//
// Until Module 6 rebuilds it on the full outbox lifecycle, an outbound job
// PARKS into wa_outbox (deduped - one pending row per shop) and the PROVEN
// drain delivers it: claims, pacing, the sent-row-before-delete ordering,
// ambiguous handling and the funnel stamp all come from the one send path
// that has them. The queue's interface is unchanged, so Module 6 stays
// additive; only the second, unsafe wire path is gone.

import { Worker, type Job } from "bullmq";
import { parkOutboxOnce } from "@wheeldeal/core";
import { logger } from "@wheeldeal/shared";
import { bullConnection } from "@wheeldeal/redis";
import { OUTBOUND_QUEUE, type OutboundJob } from "@wheeldeal/queues";

export function startOutboundWorker(): Worker<OutboundJob> {
  const worker = new Worker<OutboundJob>(
    OUTBOUND_QUEUE,
    async (job: Job<OutboundJob>) => {
      const { senderKey, toNumber, text, kind, meta } = job.data;
      await parkOutboxOnce({
        senderKey,
        toNumber,
        body: text,
        notBeforeMs: Date.now(),
        meta: { ...meta, kind, sender: senderKey, reason: "outbound-queue" },
      });
      logger.info({ toNumber, kind }, "outbound parked for the lifecycle drain");
    },
    { connection: bullConnection(), concurrency: 2 }
  );
  return worker;
}
