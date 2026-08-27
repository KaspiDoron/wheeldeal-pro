// WheelDeal gateway - the always-on webhook ingress of the GCP architecture.
//
// Blueprint Module 1: acknowledge every WhatsApp webhook in <200ms so the
// provider never retries into a duplicate storm, and hand ALL work to BullMQ.
// The only I/O on the hot path is Redis (idempotency SETNX + queue add).
// Everything heavy - DB writes, media, LLMs, the agent turn - happens in the
// workers, off the request path, with retries + DLQ.

import express from "express";
import { webhookAuthToken, noteWebhookAccepted, noteWebhook403 } from "@wheeldeal/core";
import { logger, env, installProcessGuards } from "@wheeldeal/shared";
import { claimInboundIds, redis } from "@wheeldeal/redis";
import { enqueueInbound } from "@wheeldeal/queues";
import { registerStreamRoute } from "./routes/stream";

// The gateway is top-level side-effecting (no main() to .catch), so this is the
// only thing standing between an escaped rejection and a silent process death.
installProcessGuards("gateway");

const app = express();
app.use(express.json({ limit: "8mb" })); // Evolution payloads carry base64 previews

/** Provider message ids inside a webhook body (dedup keys). */
function inboundMessageIds(body: any): string[] {
  const items = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
  return items
    .map((d: any) => String(d?.key?.id ?? ""))
    .filter((id: string) => id.length > 0);
}

// LIVENESS - "is this process alive". Deliberately dependency-free: it must
// never fail for a reason a restart cannot fix.
//
// This used to ping Redis and return 503 on failure, while being wired up as
// the health check. A Redis blip therefore made the orchestrator kill and
// restart a perfectly healthy gateway - the probe manufactured the outage it
// was supposed to detect. Dependency checks belong in readiness, below.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
});

// READINESS - "should traffic be routed here". Safe to fail: a load balancer
// pulls this instance out and puts it back when Redis returns.
app.get("/readyz", async (_req, res) => {
  try {
    await redis().ping();
    res.json({ ok: true, redis: true });
  } catch {
    res.status(503).json({ ok: false, redis: false });
  }
});

// The Evolution webhook - same path shape as the legacy Next route, so
// cutting over is ONLY a URL change in the Evolution dashboard.
app.post(["/api/webhooks/evolution", "/webhooks/evolution"], async (req, res) => {
  const started = Date.now();
  try {
    // Host-independent auth (OR11 I2.4): the old webhookToken() returned null
    // whenever getHosts() came back empty, which a vault outage causes falsely -
    // so a webhook with a VALID token was 403'd and its reply DROPPED. The token
    // is derived from SESSION_SECRET alone, so authenticity never needed hosts.
    const expected = webhookAuthToken();
    if (!expected || req.query.token !== expected) {
      // Throttled breadcrumb so a stale-token 403 storm is visible in-app.
      void noteWebhook403(
        "gateway/webhooks/evolution",
        typeof req.query.token === "string" ? req.query.token : null
      );
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const body = req.body;
    if (!body || typeof body !== "object") {
      res.json({ ok: true });
      return;
    }

    // Durable "last inbound accepted at" (throttled per instance).
    void noteWebhookAccepted(
      String(body?.instance ?? body?.instanceName ?? "") || undefined,
      String(body?.event ?? "") || undefined
    );

    // Ingress dedup (layer 1): all ids already seen -> ack, no enqueue.
    const ids = inboundMessageIds(body);
    const fresh = await claimInboundIds(ids);
    if (!fresh) {
      res.json({ ok: true, dedup: true });
      return;
    }

    // Enqueue (layer 2 dedup: jobId = first provider message id).
    await enqueueInbound(
      { channel: "evolution", receivedAtIso: new Date().toISOString(), raw: body },
      ids[0]
    );
    res.json({ ok: true });
  } catch (e) {
    // Never bounce a webhook for our own infra hiccup: ack + log. The provider
    // retry storm is worse than one investigated gap.
    logger.error({ err: (e as Error).message }, "webhook ingress error");
    res.json({ ok: true, degraded: true });
  } finally {
    const ms = Date.now() - started;
    if (ms > 200) logger.warn({ ms }, "webhook ack exceeded 200ms budget");
  }
});

// Realtime UI sync: SSE stream of session deltas (Module 2).
registerStreamRoute(app);

const port = Number(env("GATEWAY_PORT", "8080"));
const server = app.listen(port, () => {
  logger.info({ port }, "gateway listening");
});

// Graceful shutdown - finish in-flight acks, then close.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    logger.info({ sig }, "gateway shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
