import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";

// Live service health (item #12): one call probes EVERY measurable service in
// parallel and returns a uniform bar-friendly shape. The keys page refreshes
// this automatically every 10 minutes.
//
// status: "ok" (green) | "degraded" (amber) | "down" (red) | "off" (grey -
// not configured, which is fine: everything degrades gracefully).

interface ServiceHealth {
  id: string;
  label: string;
  status: "ok" | "degraded" | "down" | "off";
  latencyMs: number | null;
  detail: string;
}

const timed = async <T>(fn: () => Promise<T>, ms = 8000): Promise<{ out: T | null; ms: number; timedOut: boolean }> => {
  const t0 = Date.now();
  try {
    const out = await Promise.race<T | null>([
      fn(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
    return { out, ms: Date.now() - t0, timedOut: out === null && Date.now() - t0 >= ms };
  } catch {
    return { out: null, ms: Date.now() - t0, timedOut: false };
  }
};

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // ?probes=cached: skip the LIVE service sweep (a real AI completion, five
  // billed Google Maps calls, an SMTP AUTH, a PayPal OAuth and a per-host
  // Evolution ping) and return only the DB-derived vitals. The Engine tab polls
  // this every 10 min while open, so firing the billed sweep on that cadence was
  // a standing money + Supabase-egress leak. The dedicated Health panel (and the
  // "run live checks" button) call this with no param for the full sweep.
  const cachedOnly = new URL(req.url).searchParams.get("probes") === "cached";

  const checks: Promise<ServiceHealth>[] = cachedOnly ? [] : [
    // Supabase - the durable store everything leans on.
    (async (): Promise<ServiceHealth> => {
      const { supabaseDiagnostics } = await import("@/lib/runtime-config");
      const r = await timed(() => supabaseDiagnostics());
      const d = r.out;
      if (!d) return { id: "supabase", label: "Supabase (database)", status: "down", latencyMs: r.ms, detail: "Diagnostics timed out." };
      if (!d.configured) return { id: "supabase", label: "Supabase (database)", status: "off", latencyMs: null, detail: "Not configured - demo mode." };
      const ok = d.reachable && d.appConfigOk;
      return {
        id: "supabase",
        label: "Supabase (database)",
        status: ok ? "ok" : d.reachable ? "degraded" : "down",
        latencyMs: r.ms,
        detail: d.detail || (ok ? "Connected." : "Connection failed."),
      };
    })(),

    // Google Maps - vendors, geocoding, photos.
    (async (): Promise<ServiceHealth> => {
      const { runMapsDiagnostics } = await import("@/lib/google");
      const r = await timed(() => runMapsDiagnostics());
      const d = r.out;
      if (!d) return { id: "maps", label: "Google Maps", status: "down", latencyMs: r.ms, detail: "Diagnostics timed out." };
      if (!d.keyConfigured) return { id: "maps", label: "Google Maps", status: "off", latencyMs: null, detail: "No key - demo shop list." };
      const parts = [d.placesNew.ok, d.placesLegacy.ok, d.geocoding.ok];
      const okCount = parts.filter(Boolean).length;
      return {
        id: "maps",
        label: "Google Maps",
        status: okCount === parts.length ? "ok" : okCount > 0 ? "degraded" : "down",
        latencyMs: r.ms,
        detail:
          okCount === parts.length
            ? "Places + Geocoding healthy."
            : `${okCount}/${parts.length} APIs answering - check the key restrictions.`,
      };
    })(),

    // AI brain - one real round-trip through the provider failover chain.
    (async (): Promise<ServiceHealth> => {
      const { aiEnabled, chat } = await import("@/lib/ai");
      if (!(await aiEnabled())) {
        return { id: "ai", label: "AI providers", status: "off", latencyMs: null, detail: "No AI key - deterministic agents." };
      }
      const r = await timed(() => chat([{ role: "user", content: "Reply with exactly: pong" }], { budgetMs: 9000 }), 10000);
      const ok = typeof r.out === "string" && r.out.length > 0;
      return {
        id: "ai",
        label: "AI providers",
        status: ok ? (r.ms > 6000 ? "degraded" : "ok") : "down",
        latencyMs: r.ms,
        detail: ok ? "Live completion round-trip succeeded." : "No provider answered - check keys/quotas.",
      };
    })(),

    // Evolution WhatsApp host pool.
    (async (): Promise<ServiceHealth> => {
      const { evolutionConfigured, pingAllHosts } = await import("@/lib/evolution");
      if (!(await evolutionConfigured())) {
        return { id: "whatsapp", label: "WhatsApp hosts", status: "off", latencyMs: null, detail: "No Evolution host configured." };
      }
      const r = await timed(() => pingAllHosts());
      const hosts = r.out ?? [];
      const up = hosts.filter((h) => h.ok).length;
      return {
        id: "whatsapp",
        label: "WhatsApp hosts",
        status: hosts.length === 0 ? "down" : up === hosts.length ? "ok" : up > 0 ? "degraded" : "down",
        latencyMs: r.ms,
        detail: hosts.length ? `${up}/${hosts.length} hosts awake.` : "No hosts reachable.",
      };
    })(),

    // REDIS - the hot-state tier, and the difference between an ATOMIC daily
    // cap and one that --max-instances 20 multiplies by twenty. It appeared on
    // no screen in this app until Wave 7, which meant "the caps are enforcing
    // nothing" and "everything is fine" were the same picture.
    (async (): Promise<ServiceHealth> => {
      const { redisDiagnostics } = await import("@/lib/rival-cache");
      const r = await timed(() => redisDiagnostics(), 5000);
      const d = r.out;
      if (!d) {
        return { id: "redis", label: "Redis (atomic caps + hot state)", status: "down", latencyMs: r.ms, detail: "PING timed out." };
      }
      return {
        id: "redis",
        label: "Redis (atomic caps + hot state)",
        // NOT configured is "off" and genuinely fine - it is the documented
        // degraded mode. Configured and silent is "down", because that is the
        // state where the caps quietly stop being atomic.
        status: !d.configured ? "off" : d.ok ? "ok" : "down",
        latencyMs: d.latencyMs,
        detail: d.detail,
      };
    })(),

    // Email (verification codes + feedback) - a LIVE credential check, not a
    // "is the string present" check. The old probe called
    // emailVerificationAvailable(), which only asks whether a value exists, so
    // a revoked Gmail App Password reported HEALTHY on the path that delivers
    // signup codes. The label now says which kind of check it was.
    (async (): Promise<ServiceHealth> => {
      const { emailLiveProbe, summariseEmailProbes } = await import("@/lib/email");
      const r = await timed(() => emailLiveProbe(), 12_000);
      if (!r.out) {
        return {
          id: "email",
          label: "Email (live credential check)",
          status: "down",
          latencyMs: r.ms,
          detail: "The live check timed out - that is unknown, not healthy.",
        };
      }
      const s = summariseEmailProbes(r.out);
      return {
        id: "email",
        label: s.kind === "live" ? "Email (live credential check)" : "Email (configuration check only)",
        status: s.status,
        latencyMs: s.kind === "live" ? r.ms : null,
        detail: s.detail,
      };
    })(),

    // OpenStreetMap Nominatim - the KEYLESS geocoder that carries place search
    // and reverse geocoding whenever Google is unset, over quota or
    // restricted. Its own source comment says it blocks datacenter IPs, which
    // is what a scaled deployment is, and nothing had ever probed it.
    (async (): Promise<ServiceHealth> => {
      const { probeNominatim } = await import("@/lib/google");
      const r = await timed(() => probeNominatim());
      const d = r.out;
      if (!d) {
        return { id: "geocode-fallback", label: "OpenStreetMap (keyless geocoder)", status: "down", latencyMs: r.ms, detail: "Probe timed out." };
      }
      return {
        id: "geocode-fallback",
        label: "OpenStreetMap (keyless geocoder)",
        // Degraded rather than down: with a healthy Google key this is a
        // backstop, and calling the backstop "down" would drag the overall
        // bar red over something the traveller never sees.
        status: d.ok ? "ok" : "degraded",
        latencyMs: r.ms,
        detail: d.detail,
      };
    })(),

    // PayPal billing.
    (async (): Promise<ServiceHealth> => {
      const { getConfig } = await import("@/lib/runtime-config");
      const [id, secret, env] = await Promise.all([
        getConfig("PAYPAL_CLIENT_ID"),
        getConfig("PAYPAL_CLIENT_SECRET"),
        getConfig("PAYPAL_ENV"),
      ]);
      if (!id || !secret) {
        return { id: "billing", label: "PayPal (billing)", status: "off", latencyMs: null, detail: "Not configured - plans stay free." };
      }
      const base =
        (env ?? "live").trim().toLowerCase() === "sandbox"
          ? "https://api-m.sandbox.paypal.com"
          : "https://api-m.paypal.com";
      const r = await timed(async () => {
        const basic = Buffer.from(`${id.trim()}:${secret.trim()}`).toString("base64");
        const res = await fetch(`${base}/v1/oauth2/token`, {
          method: "POST",
          headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=client_credentials",
          cache: "no-store",
        });
        return res.ok;
      });
      return {
        id: "billing",
        label: "PayPal (billing)",
        status: r.out === true ? "ok" : "down",
        latencyMs: r.ms,
        detail: r.out === true ? "Credentials valid." : "API rejected the credentials - test in Keys.",
      };
    })(),
  ];

  const services = await Promise.all(checks);

  // Suppression/degradation counters (last 24h): the observability layer for
  // the send pipeline - a spike here is the first sign something is being
  // held back (cancellations firing, claims contended, fail-closed holds,
  // structurally illegal phase jumps).
  const { sbSelect, sbCountDark, lostTelemetryWrites } = await import("@/lib/runtime-config");
  const sinceIso = new Date(Date.now() - 24 * 3600_000).toISOString();
  const guardKinds = [
    "cancelled-send-blocked",
    "takeover-send-blocked",
    // A surface tried to rewrite a live thread's rental terms and was
    // overruled (the '5 days' contamination sensor). Written since W4.1,
    // read by NOTHING until owner report 6 - the exact bug it was built to
    // catch shipped to the field unseen while its sensor fired.
    "rfq-drift-blocked",
    "rfq-drift",
    // CONTENTION, which is the system pacing itself and is expected...
    "claim-lost",
    // ...and its opposite, which used to share the counter above: a fail-closed
    // refusal because the claim table could not be read. One is busy, the other
    // is broken, and reading a single number could not tell the owner which.
    "claim-error",
    // A message binned for being older than the drain's age ceiling. Zero is
    // normal; a spike means a backlog stalled long enough to go off.
    "wa-send-expired",
    "bargain-blocked",
    "phase-anomaly",
    "ambiguous-inbound",
    "wa-send-dropped",
    // THE GUARD'S OWN TERMINAL REFUSALS. `send-dropped` is what
    // recordSendDropped() writes when a message is refused for good -
    // duplicate-suppressed, rfq-dedup, engagement-halt - and it is a DIFFERENT
    // kind from "wa-send-dropped" (which the drain writes when a send is
    // attempted and fails). One letter of difference, and the consequence was
    // that the three most terminal drops in the system appeared on no admin
    // surface at all: they never touch wa_outbox either, so the queue view
    // cannot show them and this counter did not count them.
    "send-dropped",
    // A draft binned for being answered by events. Rare and important: it means
    // the shop moved on before we spoke, and the thread was handed a fresh turn.
    "wa-send-stale",
    // Which brain answered. A wakeup turn silently running the old engine is
    // exactly the failure that survived a full deploy-and-verify cycle.
    "engine-graph-turn",
    // I3 (owner report 6): the media pipeline's own failure classes. The
    // "reading was never stored" agreement photos and the empty catalog
    // bubbles each had a sensor already firing - none of them reached an
    // admin number, so the owner's screenshots were the monitoring.
    "vision-parse-failed",
    "vision-truncated",
    "vision-sanity-nulled",
    "vision-unavailable",
    "media-fetch-failed",
    "media-unreadable",
    // An inbound that never became a turn, with its reason - the difference
    // between "the shop went quiet" and "we dropped their message".
    "inbound-dropped",
    // EVERY AI rung refused (spent minute, spent day, dead keys). Non-zero
    // means the fleet is negotiating from deterministic templates right now -
    // the "agents got stupid" state that previously had no number anywhere.
    "ai-chain-exhausted",
    // The drain ran out of wall clock and left due rows for the next
    // invocation. A steady non-zero means the cadence or the fleet size needs
    // attention - previously this state was a Cloud Run kill instead.
    "drain-budget-stop",
    // wa_send_claims is missing, so every atomic pacing guarantee is inert.
    // Any non-zero here is a launch blocker: run supabase/schema.sql.
    "claims-table-missing",
  ];
  // ONE BUDGET SHARED BY TWELVE COUNTERS IS ELEVEN COUNTERS THAT CAN BE STARVED.
  //
  // This was a single `kind=in.(...)` read with `limit=500`. Every kind drew
  // from the same 500 rows, so on a busy day one chatty kind - `claim-lost`
  // during a pacing-heavy hour is exactly that - could fill the budget and
  // every other counter would silently read ZERO. The numbers that say whether
  // sends are being dropped would look their most reassuring precisely when the
  // system was busiest.
  //
  // Ask each kind for its own count. PostgREST returns it in the Content-Range
  // header with head=true, so this is twelve tiny HEAD-shaped requests rather
  // than one large row transfer - cheaper than what it replaces, and each
  // number is now independent of the others' volume.
  // AND A ZERO THAT MEANS "WE COULD NOT ASK" IS THE WORST NUMBER ON THE PAGE.
  //
  // These used to carry `.catch(() => 0)`, which was dead: `sbCount` returns 0
  // on every failure by its own documented design, so the catch could never run
  // and the zero it "provided" was the same zero the reader already gives. The
  // note that stood here said the honest version needed a count-with-degraded
  // reader. `sbCountDark` is that reader: a number, or null for unknown. So the
  // twelve counters that say whether sends are being DROPPED no longer read
  // their most reassuring value at the exact moment nothing can be read.
  const counts = await Promise.all(
    guardKinds.map((k) =>
      sbCountDark(
        "agent_events",
        `kind=eq.${encodeURIComponent(k)}&created_at=gte.${encodeURIComponent(sinceIso)}`
      )
    )
  );
  const guardCounters: Record<string, number | null> = {};
  guardKinds.forEach((k, i) => {
    guardCounters[k] = counts[i];
  });
  const guardCountersUnreadable = counts.some((n) => n === null);

  // WEBHOOK SILENCE DETECTOR: the launch-blocker signature is "we sent messages
  // recently, ≥1 session is open, but NO inbound arrived and NO webhook was
  // accepted in the last 30 min" - i.e. Evolution is 403ing our webhook (stale
  // token / lost registration). Surfaced so the Command tab can shout, instead
  // of the failure being invisible like it was in the live incident.
  const now = Date.now();
  const iso30 = new Date(now - 30 * 60_000).toISOString();
  const iso60 = new Date(now - 60 * 60_000).toISOString();
  const [outbound60, inbound30, webhookOk30, openSessions, lastPing, queued, turns60, pushes24] =
    await Promise.all([
    sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.outbound&received_at=gte.${encodeURIComponent(iso60)}&limit=1`
    ).catch(() => []),
    sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.inbound&received_at=gte.${encodeURIComponent(iso30)}&limit=1`
    ).catch(() => []),
    sbSelect<{ id: number; created_at: string; detail: string | null }>(
      "agent_events",
      `select=id,created_at,detail&kind=eq.webhook-ok&created_at=gte.${encodeURIComponent(
        iso30
      )}&order=created_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ email: string }>(
      "wa_sessions",
      `select=email&status=eq.open&limit=1`
    ).catch(() => []),
    // THE WATCHDOG'S WATCHDOG. Nothing drains the outbox or fires a scheduled
    // follow-up unless something pings, and for a long time nothing did - the
    // scheduler was never provisioned and the failure was completely silent
    // because every surface only ever showed what HAD happened. The last ping's
    // age is the one number that says whether the machinery is alive at all.
    sbSelect<{ created_at: string }>(
      "agent_events",
      "select=created_at&kind=eq.cron-ping&order=created_at.desc&limit=1"
    ).catch(() => []),
    // QUEUE DEPTH: how many sends are waiting, and how long the oldest has been.
    sbSelect<{ not_before: string }>(
      "wa_outbox",
      "select=not_before&order=not_before.asc&limit=500"
    ).catch(() => []),
    // Per-turn stamps: latency percentiles and which provider actually answered.
    sbSelect<{ detail: string }>(
      "agent_events",
      `select=detail&kind=eq.engine-v3-turn&created_at=gte.${encodeURIComponent(
        iso60
      )}&order=created_at.desc&limit=500`
    ).catch(() => []),
    // Push breadcrumbs - a notification that was composed but never delivered
    // leaves a trail nobody was reading.
    sbSelect<{ kind: string }>(
      "agent_events",
      `select=kind&kind=in.(push-sent,push-failed,push-skipped)&created_at=gte.${encodeURIComponent(
        new Date(now - 24 * 3600_000).toISOString()
      )}&limit=2000`
    ).catch(() => []),
  ]);
  const webhookSilent =
    outbound60.length > 0 &&
    inbound30.length === 0 &&
    webhookOk30.length === 0 &&
    openSessions.length > 0;

  // RETENTION HEARTBEAT (W9). prune_old_rows writes one 'retention-ran'
  // agent_events row per run, because the schedule itself is unobservable from
  // here: pg_cron degrades to a NOTICE nobody reads when the extension is
  // missing, so a deployment can have ZERO retention and no surface saying so.
  // Read through sbSelectDark - "never ran" and "could not ask" are different
  // answers and the tile must say which.
  const { sbSelectDark } = await import("@/lib/runtime-config");
  const retentionRows = await sbSelectDark<{ created_at: string }>(
    "agent_events",
    "select=created_at&kind=eq.retention-ran&order=created_at.desc&limit=1"
  );
  const retentionLastRanAt = retentionRows?.[0]?.created_at ?? null;
  const retention = {
    lastRanAt: retentionLastRanAt,
    unreadable: retentionRows === null,
    // Nightly job: anything past 48h means the schedule is broken or absent.
    stale: Boolean(
      retentionLastRanAt && now - Date.parse(retentionLastRanAt) > 48 * 3600_000
    ),
  };

  // ONE SCARY NUMBER IS TWO DIFFERENT FACTS.
  //
  // `inbound-dropped` counts the privacy gate refusing the traveller's OWN
  // personal chats - which on a personal WhatsApp number must fire constantly,
  // and is the product working - in the SAME integer as a shop reply that never
  // became a turn. The owner reading "79 in 24h" cannot tell hygiene from loss,
  // and the reason has been sitting in `detail` the whole time. Split it
  // through the SAME taxonomy the per-user safety verdict already uses
  // (wa/safety-signals BENIGN_DROP_REASONS), and report the magnitude the trace
  // throttle collapsed (`alsoSuppressed`) rather than only rows - a row can
  // stand for N events, so rows alone UNDERSTATE chatter and overstate loss.
  const { summarizeInboundDrops, DROP_SCAN_LIMIT } = await import("@/lib/wa/drop-summary");
  const dropRows = await sbSelectDark<{ detail: string | null }>(
    "agent_events",
    `select=detail&kind=eq.inbound-dropped&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&order=created_at.desc&limit=${DROP_SCAN_LIMIT}`
  );
  const inboundDrops = summarizeInboundDrops(dropRows, DROP_SCAN_LIMIT);

  // ---- the numbers the owner needs to see WITHOUT reading a log ------------
  const { pulse, queueDepth, turnLatency, providerErrors, pushBreadcrumbs } = await import(
    "@/lib/ops/vitals"
  );

  return NextResponse.json({
    retention,
    services,
    guardCounters,
    // A null anywhere in guardCounters means that counter is UNKNOWN, not zero.
    // Flagged separately so a client can label the whole block at a glance
    // rather than having to notice one dash among twelve numbers.
    guardCountersUnreadable,
    // The `inbound-dropped` counter above, split benign-by-design vs
    // needing-attention with a per-reason histogram. `unreadable: true` means
    // we could not ask - never a confident zero.
    inboundDrops,
    webhookSilent,
    webhookLastAcceptedAt: webhookOk30[0]?.created_at ?? null,
    // I4: THE PANELS' OWN BLIND SPOT. Every telemetry write is best-effort by
    // design, so a Supabase blip silences all of them at once - and a silent
    // panel reads exactly like a quiet system. A non-zero count here means the
    // numbers on this page are UNDER-reported, not reassuring. Per-instance
    // and in-memory, so it resets on a redeploy - a live signal, not a ledger.
    lostTelemetryWrites: lostTelemetryWrites(),
    // The cron watchdog. "never" and "stale" are different failures with
    // different fixes, and the tile says which - see lib/ops/vitals.
    heartbeat: pulse(lastPing[0]?.created_at ?? null, now),
    queue: queueDepth(queued, now),
    turnLatencyMs: turnLatency(turns60),
    providerErrors: providerErrors(turns60),
    push24h: pushBreadcrumbs(pushes24),
    // A ROTATED SESSION_SECRET IS INVISIBLE WITHOUT THIS.
    //
    // SESSION_SECRET is both the cookie signing key and the Key Vault's
    // encryption key, so rotating it makes every stored integration key
    // undecryptable - and loadOverrides simply dropped those rows. The owner
    // saw a fully healthy app with every integration blank and nothing
    // anywhere saying why. `count` is how many rows failed to decrypt on the
    // last real vault read; anything above zero means set
    // SESSION_SECRET_PREVIOUS to the old value (it now has a delivery path in
    // .github/workflows/deploy-gcp.yml) and the vault re-reads itself.
    vaultDecrypt: (await import("@/lib/runtime-config")).vaultDecryptHealth(),
    checkedAt: new Date().toISOString(),
  });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
