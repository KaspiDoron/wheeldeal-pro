// Web Push (browser notifications that arrive even when the app is CLOSED).
// Free for every plan. Degrades gracefully: with no VAPID keys configured the
// whole feature is a silent no-op, so the app always builds and runs.
//
// Flow: the browser subscribes (service worker + PushManager) -> we store the
// subscription in push_subscriptions -> when a shop replies, the webhook path
// sends a push to that user's devices. Keys come from the Key Vault / env
// (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY), so no rebuild is needed to enable it.

import "server-only";
import webpush from "web-push";
import { createHash } from "crypto";
import { getConfig, setConfig, sbInsert, sbSelect, sbDelete } from "./runtime-config";
import { generateVapidPair, vapidPairMatches } from "./push-keys";
import { resolveSiteHost } from "./site";

interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

let configured: string | null = null; // cache the public key we set VAPID with

async function ensureVapid(): Promise<string | null> {
  const [pub, priv] = await Promise.all([
    getConfig("VAPID_PUBLIC_KEY"),
    getConfig("VAPID_PRIVATE_KEY"),
  ]);
  if (!pub || !priv) return null;
  // Key the cache on BOTH keys - a private-key-only rotation (public unchanged)
  // would otherwise keep stale VAPID details on a warm serverless instance.
  const fingerprint = `${pub}:${createHash("sha256").update(priv).digest("hex").slice(0, 8)}`;
  if (configured !== fingerprint) {
    const admins = (await getConfig("ADMIN_EMAILS")) || "";
    const subject = admins.split(",")[0]?.trim();
    // Fallback subject derives from the canonical site identity, so push
    // sender identity follows the brand domain without a redeploy.
    const host = await resolveSiteHost();
    webpush.setVapidDetails(subject ? `mailto:${subject}` : `mailto:hello@${host}`, pub, priv);
    configured = fingerprint;
  }
  return pub;
}

/**
 * AUTO-PROVISION (terminal-free owner): mint a VAPID pair on first use and
 * persist it in the encrypted Key Vault, so alerts work with zero setup.
 * Rules that keep it safe:
 *   - Exactly one key set (half-pasted manual config) -> null, NEVER clobber.
 *   - Only keys that PERSISTED count: ephemeral keys would strand every
 *     browser subscription on the next instance recycle, so a failed vault
 *     write rolls back and the feature stays hidden (the pre-fix behavior).
 *   - Two instances can race the first call; upserts are last-writer-wins per
 *     key, so after writing we re-read and PROVE the stored pair belong
 *     together (vapidPairMatches re-derives the public point from the private
 *     scalar). One retry, then give up to the graceful-hide path.
 */
async function provisionVapidKeys(): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pair = generateVapidPair();
    // Private first: a crash between the writes leaves a half-set pair, which
    // reads as "unconfigured" (safe) instead of a public key nobody can sign for.
    const wPriv = await setConfig("VAPID_PRIVATE_KEY", pair.privateKey);
    const wPub = wPriv.persistent ? await setConfig("VAPID_PUBLIC_KEY", pair.publicKey) : wPriv;
    if (!wPriv.persistent || !wPub.persistent) {
      await setConfig("VAPID_PRIVATE_KEY", "").catch(() => {});
      await setConfig("VAPID_PUBLIC_KEY", "").catch(() => {});
      return null; // vault unavailable - keep alerts hidden rather than strand subs
    }
    // Re-read what actually won (setConfig cleared the cache) and verify the
    // stored pair is internally consistent - ours or a concurrent winner's.
    const [pub, priv] = await Promise.all([
      getConfig("VAPID_PUBLIC_KEY"),
      getConfig("VAPID_PRIVATE_KEY"),
    ]);
    if (pub && priv && vapidPairMatches(pub, priv)) {
      await sbInsert("agent_events", [
        { kind: "vapid-autogen", detail: `web push keys auto-generated (pub ${pub.slice(0, 8)}...)` },
      ]).catch(() => {});
      return pub;
    }
  }
  return null;
}

/** The public key the browser needs to subscribe (null when push is off).
 * First signed-in call auto-provisions the keypair - see provisionVapidKeys. */
export async function vapidPublicKey(): Promise<string | null> {
  const [pub, priv] = await Promise.all([
    getConfig("VAPID_PUBLIC_KEY"),
    getConfig("VAPID_PRIVATE_KEY"),
  ]);
  if (pub && priv) return pub;
  if (pub || priv) return null; // half-configured: let the admin finish, never overwrite
  return provisionVapidKeys();
}

/** Persist a browser push subscription for a user (idempotent on endpoint). */
export async function saveSubscription(email: string, sub: PushSub): Promise<boolean> {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  // De-dupe: drop any existing row for this endpoint first, then insert.
  await sbDelete("push_subscriptions", `endpoint=eq.${encodeURIComponent(sub.endpoint)}`).catch(() => {});
  return sbInsert("push_subscriptions", [
    { user_email: email, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  ]);
}

/** How many device subscriptions this user has (the server truth for "alerts
 * on" - a real toggle reflects THIS, not a localStorage flag). */
export async function subscriptionCount(email: string): Promise<number> {
  return (await subscriptionEndpoints(email)).length;
}

/**
 * The endpoints this account has registered.
 *
 * The toggle only ever got a COUNT, which is an account-wide fact - so a
 * traveller who had enabled alerts on a laptop was told "Alerts on" while the
 * phone in their hand held no subscription at all and could never receive
 * anything. The client needs the endpoints to answer the only question that
 * matters to it: is THIS device one of them?
 */
export async function subscriptionEndpoints(email: string): Promise<string[]> {
  const rows = await sbSelect<{ endpoint: string }>(
    "push_subscriptions",
    `select=endpoint&user_email=eq.${encodeURIComponent(email)}&limit=50`
  ).catch(() => []);
  return rows.map((r) => r.endpoint).filter(Boolean);
}

/** Turn alerts OFF: remove this user's subscriptions (all, or one endpoint). */
export async function removeSubscriptions(email: string, endpoint?: string): Promise<number> {
  const filter = endpoint
    ? `endpoint=eq.${encodeURIComponent(endpoint)}`
    : `user_email=eq.${encodeURIComponent(email)}`;
  const before = endpoint ? 1 : await subscriptionCount(email);
  await sbDelete("push_subscriptions", filter).catch(() => {});
  return before;
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * BURST-COLLAPSED push (spam-notification fix): a shop that fires 3 WhatsApp
 * messages in a minute must produce ONE notification, not three. The collapse
 * window is DURABLE (serverless instances share nothing in memory): a
 * `push-collapse` marker row per (user, collapseKey) suppresses further
 * collapsible pushes inside the window. `important` pushes (a price landed, a
 * risk flag) bypass the suppression but still stamp the marker, so the noise
 * that follows a high-value push is swallowed too. Fail-open: if the marker
 * store is unreadable the push still goes out - a lost dedupe beats a lost
 * notification.
 */
export async function sendPushCollapsed(
  email: string,
  collapseKey: string,
  payload: { title: string; body: string; url?: string; tag?: string },
  opts: { windowSec?: number; important?: boolean } = {}
): Promise<void> {
  if (!email) return;
  const windowSec = opts.windowSec ?? 180;
  const key = `${email}|${collapseKey}`.slice(0, 120);
  try {
    if (!opts.important) {
      const { sbSelect } = await import("./runtime-config");
      const since = new Date(Date.now() - windowSec * 1000).toISOString();
      const recent = await sbSelect<{ id: number }>(
        "agent_events",
        `select=id&kind=eq.push-collapse&vendor_name=eq.${encodeURIComponent(
          key
        )}&created_at=gte.${encodeURIComponent(since)}&limit=1`
      );
      if (recent.length > 0) return; // collapsed - a push for this shop just went out
    }
    const { sbInsert } = await import("./runtime-config");
    await sbInsert("agent_events", [
      { kind: "push-collapse", vendor_name: key, detail: payload.title.slice(0, 80) },
    ]).catch(() => {});
  } catch {
    /* fail-open: send the push anyway */
  }
  await sendPushToUser(email, payload);
}

/**
 * Send a push to all of a user's subscribed devices. Best-effort: prunes dead
 * subscriptions (410 Gone / 404) and never throws. No-op when VAPID is unset.
 */
export async function sendPushToUser(
  email: string,
  payload: { title: string; body: string; url?: string; tag?: string }
): Promise<PushOutcome> {
  const out: PushOutcome = { attempted: 0, delivered: 0, pruned: 0, results: [] };
  if (!email) return out;
  const pub = await ensureVapid();
  if (!pub) {
    out.reason = "vapid-unconfigured";
    return out;
  }
  const subs = await sbSelect<SubRow>(
    "push_subscriptions",
    `select=endpoint,p256dh,auth&user_email=eq.${encodeURIComponent(email)}&limit=20`
  ).catch(() => [] as SubRow[]);
  if (!subs.length) {
    out.reason = "no-subscriptions";
    return out;
  }
  const data = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/",
    // COLLAPSE PER SHOP. Three replies from one shop while the phone is in a
    // pocket should land as one live notification, not three - the SW uses
    // this as the notification tag.
    tag: payload.tag,
  });
  out.attempted = subs.length;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          data
        );
        out.delivered += 1;
        out.results.push({ endpoint: s.endpoint, ok: true });
      } catch (e: any) {
        const code = e?.statusCode;
        // A DEAD ROW IS DEAD, whichever way the push service says so.
        //
        // Only 404/410 were pruned. After a VAPID key rotation the service
        // answers 400/401/403 instead - "these keys do not match this
        // subscription" - and those rows lived forever, so every later send
        // burned an attempt on a subscription that could never receive
        // anything, and the UI counted them as "alerts on".
        if (code === 400 || code === 401 || code === 403 || code === 404 || code === 410) {
          await sbDelete(
            "push_subscriptions",
            `endpoint=eq.${encodeURIComponent(s.endpoint)}`
          ).catch(() => {});
          out.pruned += 1;
        }
        out.results.push({
          endpoint: s.endpoint,
          ok: false,
          status: typeof code === "number" ? code : undefined,
          error: String(e?.body || e?.message || "push failed").slice(0, 200),
        });
      }
    })
  );
  // THE FAILURE THAT WAS INVISIBLE. ops/vitals.pushBreadcrumbs and the health
  // panel both count `push-failed`, and nothing ever wrote it - so the push
  // failure rate was a structural 0% while every registered endpoint could be
  // rejecting ("Alerts on", zero pushes). A send where NO device received the
  // notification is a traveller who was not told something: one durable row,
  // carrying the first rejection so the doctor can say why. Partial delivery
  // (some endpoints ok) is not a failure - the phone buzzed.
  if (out.attempted > 0 && out.delivered === 0) {
    const firstErr = out.results.find((r) => !r.ok);
    void sbInsert("agent_events", [
      {
        kind: "push-failed",
        user_email: email,
        vendor_id: "",
        vendor_name: "",
        detail: JSON.stringify({
          attempted: out.attempted,
          status: firstErr?.status ?? null,
          error: firstErr?.error ?? null,
        }).slice(0, 300),
      },
    ]).catch(() => {});
  }
  return out;
}

/**
 * WHAT ACTUALLY HAPPENED, per device.
 *
 * The old signature was `Promise<void>` and every failure was swallowed, so
 * "Alerts on" could be true while every registered endpoint was rejecting -
 * the exact field failure ("Alerts on", zero pushes). Callers that care (the
 * test-send button, the doctor) can now say something true.
 */
export interface PushOutcome {
  attempted: number;
  delivered: number;
  pruned: number;
  /** Set when nothing was even attempted, and why. */
  reason?: "vapid-unconfigured" | "no-subscriptions";
  results: Array<{ endpoint: string; ok: boolean; status?: number; error?: string }>;
}

export interface PushDiagnostics {
  /** "ok" = both keys present AND the public key derives from the private one. */
  vapid: "ok" | "mismatched" | "half-configured" | "missing";
  devices: number;
  /** Endpoint HOSTS only - the token part identifies a device, so it never leaves. */
  services: string[];
  lastIngestPushAt: string | null;
  /** The last ingest push's own verdict (attempted/delivered/pruned/reason). */
  lastIngestPushDetail: string | null;
  lastCollapseAt: string | null;
}

/**
 * WHY IS NOBODY GETTING ALERTS? - answerable from a phone.
 *
 * A half-pasted or rotated VAPID pair is invisible from every UI: the toggle
 * still says "on" (rows exist), sends still return 2xx-shaped promises, and
 * nothing arrives. The doctor needs the three facts that separate those cases -
 * are the keys internally consistent, does this account hold any device, and
 * did a push actually leave recently.
 */
export async function pushDiagnostics(email: string): Promise<PushDiagnostics> {
  const [pub, priv] = await Promise.all([
    getConfig("VAPID_PUBLIC_KEY"),
    getConfig("VAPID_PRIVATE_KEY"),
  ]);
  const vapid: PushDiagnostics["vapid"] = !pub && !priv
    ? "missing"
    : !pub || !priv
      ? "half-configured"
      : vapidPairMatches(pub, priv)
        ? "ok"
        : "mismatched";
  const endpoints = email ? await subscriptionEndpoints(email) : [];
  const services = Array.from(
    new Set(
      endpoints.map((e) => {
        try {
          return new URL(e).host;
        } catch {
          return "unparseable";
        }
      })
    )
  );
  const enc = encodeURIComponent(email);
  const [sent, collapse] = await Promise.all([
    sbSelect<{ created_at: string; detail: string | null }>(
      "agent_events",
      `select=created_at,detail&kind=eq.push-ingest&user_email=eq.${enc}&order=created_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ created_at: string }>(
      "agent_events",
      `select=created_at&kind=eq.push-collapse&order=created_at.desc&limit=1`
    ).catch(() => []),
  ]);
  return {
    vapid,
    devices: endpoints.length,
    services,
    lastIngestPushAt: sent[0]?.created_at ?? null,
    lastIngestPushDetail: sent[0]?.detail ?? null,
    lastCollapseAt: collapse[0]?.created_at ?? null,
  };
}
