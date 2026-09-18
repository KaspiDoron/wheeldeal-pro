// A FAKE EVOLUTION API HOST - dev only.
//
// WHY THIS SHAPE. The app cannot be exercised end to end without WhatsApp, and
// every other way of faking WhatsApp means putting a seam inside production
// code ("if simulating, skip the send") - a seam that then has to be trusted in
// the one place where being wrong is a banned phone number. This instead
// impersonates the THING THE APP TALKS TO. The app makes its real HTTP calls,
// through its real pacing, claims, outbox, presence and webhook auth, and gets
// realistic answers back. Nothing in src/ knows this exists.
//
// It also plays the other side of the conversation: 10-40 rental shops with
// their own prices, floors, languages and tempers (shops.mjs), which reply on
// a delay by POSTing genuine Evolution webhook payloads back into
// /api/webhooks/evolution.
//
// And it is the SLA stopwatch: the moment a shop's message leaves here is
// recorded, and the moment our answer to that shop arrives is matched to it -
// measured OUTSIDE the app, so the number cannot be flattered by our own
// instrumentation.
//
//   node tooling/sim/evolution-sim.mjs
//
// Env: SIM_PORT (8788), SIM_KEY (simkey), SIM_MARKET (bali), SIM_APP_URL
// (http://127.0.0.1:3000), SIM_LLM (1 = phrase replies with Ollama),
// SIM_OLLAMA_URL (http://127.0.0.1:11434), SIM_OLLAMA_MODEL (qwen3:14b),
// SESSION_SECRET (to derive the webhook token when the app has not registered
// one yet), WEBHOOK_TOKEN_SALT.

import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { personaFor, decide, compose, readRivalPrice } from "./shops.mjs";

const PORT = Number(process.env.SIM_PORT || 8788);
const KEY = process.env.SIM_KEY || "simkey";
const MARKET = process.env.SIM_MARKET || "bali";
const APP_URL = (process.env.SIM_APP_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const USE_LLM = process.env.SIM_LLM === "1";
const OLLAMA_URL = (process.env.SIM_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.SIM_OLLAMA_MODEL || "qwen3:14b";

// A 1x1 transparent PNG stands in for a price-board photo. The reading path
// gets real bytes and real base64; what it sees in them is its own business.
const BOARD_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Same derivation as src/lib/wa/webhook-token.ts, so the sim can reach the
 *  webhook before the app has registered a URL with us. */
function deriveWebhookToken() {
  const secret = process.env.SESSION_SECRET;
  const salt = process.env.WEBHOOK_TOKEN_SALT;
  if (!secret || secret.length < 16) {
    return createHash("sha256").update("wd-webhook:dev-only").digest("hex").slice(0, 32);
  }
  const salted = salt ? `wd-webhook:${secret}:${salt}` : `wd-webhook:${secret}`;
  return createHash("sha256").update(salted).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

/** instanceName -> { webhookUrl, events, state, createdAt } */
const instances = new Map();
/** `${instance}|${digits}` -> thread */
const threads = new Map();
/** The wire log, newest last. Capped so a long session cannot eat memory. */
const wire = [];
/** Reply-latency samples: { shop, name, ms, at, inboundText, replyText } */
const slaSamples = [];
let paused = false;

function log(entry) {
  wire.push({ at: Date.now(), ...entry });
  if (wire.length > 3000) wire.splice(0, wire.length - 3000);
  const when = new Date().toISOString().slice(11, 19);
  const arrow = entry.dir === "out" ? "->" : "<-";
  if (entry.dir) {
    const ms = entry.latencyMs != null ? ` (${(entry.latencyMs / 1000).toFixed(1)}s)` : "";
    console.log(`${when} ${arrow} ${entry.shopName ?? entry.shop ?? ""}: ${String(entry.text ?? "").slice(0, 90)}${ms}`);
  } else if (entry.note) {
    console.log(`${when} .. ${entry.note}`);
  }
}

function threadFor(instance, digits) {
  const key = `${instance}|${digits}`;
  let t = threads.get(key);
  if (!t) {
    t = {
      instance,
      digits,
      persona: personaFor(digits, { market: MARKET }),
      rounds: 0,
      lastQuote: null,
      messages: [],
      pendingInboundAt: null,
      answeredQuestion: false,
    };
    threads.set(key, t);
  }
  return t;
}

// ---------------------------------------------------------------------------
// THE SHOP SIDE
// ---------------------------------------------------------------------------

/**
 * THE SIMULATOR MUST NEVER TOUCH A REAL DEPLOYMENT.
 *
 * The app registers its webhook at APP_DOMAIN, which defaults to the LIVE site.
 * On a dev box with no override that is exactly what it hands us - so invented
 * shop messages would be posted at the production server (it refuses them, but
 * only because the local token does not match; that is luck, not a design).
 * Anything that is not loopback is refused here, loudly, and the local app is
 * used instead.
 */
function localWebhookUrl(candidate) {
  const fallback = `${APP_URL}/api/webhooks/evolution?token=${deriveWebhookToken()}`;
  if (!candidate) return fallback;
  try {
    const u = new URL(candidate);
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) return candidate;
    log({
      note:
        `REFUSED a non-local webhook target (${u.host}) - delivering to ${APP_URL} instead. ` +
        `Set APP_DOMAIN=${APP_URL} in .env.local so the app registers a local URL.`,
    });
    return fallback;
  } catch {
    return fallback;
  }
}

async function postWebhook(instance, payload) {
  const inst = instances.get(instance);
  const url = localWebhookUrl(inst?.webhookUrl);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) log({ note: `webhook ${res.status} for ${payload.event}` });
    return res.ok;
  } catch (e) {
    log({ note: `webhook failed: ${String(e?.message ?? e).slice(0, 120)}` });
    return false;
  }
}

function messageFrame(thread, msg) {
  const id = randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
  const base = {
    key: { remoteJid: `${thread.digits}@s.whatsapp.net`, fromMe: false, id },
    pushName: thread.persona.name,
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  if (msg.media === "image") {
    return {
      ...base,
      message: {
        imageMessage: {
          mimetype: "image/png",
          caption: msg.caption ?? "",
          url: "https://sim.local/board.png",
          fileLength: "812",
        },
      },
    };
  }
  if (msg.media === "audio") {
    return {
      ...base,
      message: {
        audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 7, ptt: true, url: "https://sim.local/voice.ogg" },
      },
    };
  }
  return { ...base, message: { conversation: msg.text } };
}

/** Send one shop message into the app, and start the stopwatch for the reply. */
async function shopSends(thread, msg) {
  if (paused) return;
  const frame = messageFrame(thread, msg);
  thread.messages.push({ dir: "in", text: msg.text ?? `[${msg.media}]`, at: Date.now() });
  // The stopwatch starts on the FIRST message of a burst: that is the moment
  // the shop began waiting for an answer.
  if (thread.pendingInboundAt == null) thread.pendingInboundAt = Date.now();
  log({
    dir: "in",
    shop: thread.digits,
    shopName: thread.persona.name,
    text: msg.text ?? `[${msg.media}]`,
    lang: thread.persona.language,
  });
  await postWebhook(thread.instance, {
    event: "messages.upsert",
    instance: thread.instance,
    data: frame,
    destination: APP_URL,
    date_time: new Date().toISOString(),
    sender: `${thread.digits}@s.whatsapp.net`,
    server_url: `http://127.0.0.1:${PORT}`,
    apikey: KEY,
  });
}

/** React to one of our outbound messages, after this shop's own think time. */
async function scheduleShopReply(thread, ourText) {
  const persona = thread.persona;
  if (persona.silent) {
    log({ note: `${persona.name} stays silent (by design)` });
    return;
  }
  const rivalPrice = readRivalPrice(ourText);
  const decision = decide(persona, thread, { rivalPrice });
  if (decision.price != null) thread.lastQuote = decision.price;
  if (decision.action === "question") thread.answeredQuestion = false;
  else thread.answeredQuestion = true;
  thread.rounds += 1;

  const msgs = await compose(persona, decision, {
    useLlm: USE_LLM,
    ollamaUrl: USE_LLM ? OLLAMA_URL : null,
    model: OLLAMA_MODEL,
  });

  const wait = persona.replyDelayMs + Math.round(Math.random() * 2000);
  setTimeout(async () => {
    for (const [i, m] of msgs.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, 600 + Math.random() * 1200));
      await shopSends(thread, m);
    }
  }, wait);
  log({
    note: `${persona.name} will answer in ${(wait / 1000).toFixed(1)}s (${decision.action}${
      decision.price != null ? ` @ ${decision.price} ${persona.currency}` : ""
    }${rivalPrice ? `, saw rival ${rivalPrice}` : ""})`,
  });
}

// ---------------------------------------------------------------------------
// THE EVOLUTION API SURFACE
// ---------------------------------------------------------------------------

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function instanceOf(path, prefix) {
  const rest = path.slice(prefix.length);
  return decodeURIComponent(rest.replace(/^\//, "").split("/")[0] ?? "");
}

function ensureInstance(name) {
  if (!instances.has(name)) instances.set(name, { state: "open", createdAt: Date.now(), webhookUrl: null });
  return instances.get(name);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    });
    return res.end();
  }

  // ---- the simulator's own control surface (not part of Evolution) --------
  if (path === "/sim/health") return json(res, { ok: true, market: MARKET, shops: threads.size, paused });
  if (path === "/sim/events") {
    const since = Number(url.searchParams.get("since") || 0);
    return json(res, { now: Date.now(), events: wire.filter((e) => e.at > since).slice(-500) });
  }
  if (path === "/sim/sla") {
    const ms = slaSamples.map((s) => s.ms).sort((a, b) => a - b);
    const pct = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)] : null);
    return json(res, {
      samples: ms.length,
      p50Ms: pct(50),
      p95Ms: pct(95),
      maxMs: ms.length ? ms[ms.length - 1] : null,
      within10s: ms.filter((m) => m <= 10000).length,
      breaches: slaSamples.filter((s) => s.ms > 10000).slice(-20),
      recent: slaSamples.slice(-40),
    });
  }
  if (path === "/sim/threads") {
    return json(res, {
      threads: [...threads.values()].map((t) => ({
        shop: t.digits,
        name: t.persona.name,
        language: t.persona.language,
        currency: t.persona.currency,
        opening: t.persona.opening,
        floor: t.persona.floor,
        lastQuote: t.lastQuote,
        rounds: t.rounds,
        silent: t.persona.silent,
        outOfStock: t.persona.outOfStock,
        messages: t.messages.slice(-12),
      })),
    });
  }
  if (path === "/sim/pause" && method === "POST") {
    paused = !paused;
    return json(res, { paused });
  }
  if (path === "/sim/reset" && method === "POST") {
    threads.clear();
    wire.length = 0;
    slaSamples.length = 0;
    return json(res, { ok: true });
  }

  // ---- everything below impersonates Evolution API v2 ---------------------
  const presentedKey = req.headers["apikey"] ?? req.headers["authorization"];
  if (!presentedKey) return json(res, { status: 401, error: "Unauthorized" }, 401);

  // instance lifecycle
  if (path === "/instance/create" && method === "POST") {
    const body = await readBody(req);
    const name = String(body.instanceName ?? "");
    const inst = ensureInstance(name);
    if (body.webhook?.url) inst.webhookUrl = body.webhook.url;
    log({ note: `instance created: ${name}${inst.webhookUrl ? " (webhook registered)" : ""}` });
    // A real link takes a moment; then the socket opens and the app hears it.
    setTimeout(() => {
      postWebhook(name, {
        event: "connection.update",
        instance: name,
        data: { state: "open", statusReason: 200 },
      });
    }, 400);
    return json(res, {
      instance: { instanceName: name, status: "created", state: "open" },
      hash: { apikey: KEY },
      webhook: inst.webhookUrl ? { url: inst.webhookUrl } : {},
    });
  }

  if (path.startsWith("/instance/connect")) {
    const name = instanceOf(path, "/instance/connect");
    if (name) {
      ensureInstance(name);
      setTimeout(() => {
        postWebhook(name, { event: "connection.update", instance: name, data: { state: "open" } });
      }, 300);
    }
    // A pairing code shaped like WhatsApp's, so the UI renders normally.
    return json(res, {
      pairingCode: "SIM1-2345",
      code: "2@simulatedpairingcode",
      count: 1,
      instance: { instanceName: name, state: "open" },
    });
  }

  if (path.startsWith("/instance/connectionState")) {
    const name = instanceOf(path, "/instance/connectionState");
    ensureInstance(name);
    return json(res, { instance: { instanceName: name, state: "open" } });
  }

  if (path === "/instance/fetchInstances") {
    return json(
      res,
      [...instances.entries()].map(([name, i]) => ({
        instance: { instanceName: name, state: i.state, connectionStatus: i.state, status: i.state },
        name,
        connectionStatus: i.state,
      }))
    );
  }

  if (path.startsWith("/instance/delete") || path.startsWith("/instance/logout")) {
    const name = instanceOf(path, path.startsWith("/instance/delete") ? "/instance/delete" : "/instance/logout");
    instances.delete(name);
    for (const k of [...threads.keys()]) if (k.startsWith(`${name}|`)) threads.delete(k);
    log({ note: `instance removed: ${name}` });
    return json(res, { status: "SUCCESS", error: false, response: { message: "Instance deleted" } });
  }

  if (path.startsWith("/instance/setPresence")) return json(res, { status: "SUCCESS" });

  // webhook registration - this is how the app tells us where to deliver
  if (path.startsWith("/webhook/set")) {
    const name = instanceOf(path, "/webhook/set");
    const body = await readBody(req);
    const inst = ensureInstance(name);
    inst.webhookUrl = body?.webhook?.url ?? body?.url ?? inst.webhookUrl;
    inst.events = body?.webhook?.events ?? body?.events ?? [];
    log({ note: `webhook set for ${name}` });
    return json(res, { webhook: { url: inst.webhookUrl, events: inst.events, enabled: true } });
  }
  if (path.startsWith("/webhook/find")) {
    const name = instanceOf(path, "/webhook/find");
    const inst = instances.get(name);
    return json(res, { enabled: Boolean(inst?.webhookUrl), url: inst?.webhookUrl ?? "", events: inst?.events ?? [] });
  }
  if (path.startsWith("/settings/set") || path.startsWith("/proxy/set")) {
    return json(res, { status: "SUCCESS" });
  }

  // ---- THE ONE THAT MATTERS: our agent speaking to a shop -----------------
  if (path.startsWith("/message/sendText")) {
    const name = instanceOf(path, "/message/sendText");
    const body = await readBody(req);
    const digits = String(body.number ?? "").replace(/\D/g, "");
    const text = String(body.text ?? body?.textMessage?.text ?? "");
    // A "message" that is only digits is almost certainly not a message. Show
    // the raw body so it can be identified rather than guessed at - and do not
    // let it stop the reply stopwatch below, which would flatter the latency.
    const looksLikeAMessage = !/^\d{6,}$/.test(text.trim());
    if (!looksLikeAMessage) {
      log({ note: `non-message sendText body: ${JSON.stringify(body).slice(0, 220)}` });
    }
    ensureInstance(name);
    const thread = threadFor(name, digits);

    // Stop the clock if this shop was waiting for an answer.
    let latencyMs = null;
    if (thread.pendingInboundAt != null) {
      latencyMs = Date.now() - thread.pendingInboundAt;
      thread.pendingInboundAt = null;
      slaSamples.push({
        shop: digits,
        name: thread.persona.name,
        ms: latencyMs,
        at: Date.now(),
        replyText: text.slice(0, 160),
      });
      if (slaSamples.length > 500) slaSamples.shift();
    }

    thread.messages.push({ dir: "out", text, at: Date.now() });
    log({ dir: "out", shop: digits, shopName: thread.persona.name, text, latencyMs });

    const id = randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
    // Answer like Evolution: a receipt, immediately.
    json(res, {
      key: { remoteJid: `${digits}@s.whatsapp.net`, fromMe: true, id },
      message: { extendedTextMessage: { text } },
      messageTimestamp: String(Math.floor(Date.now() / 1000)),
      status: "PENDING",
    });

    // A delivery receipt, as a real host would send.
    setTimeout(() => {
      postWebhook(name, {
        event: "messages.update",
        instance: name,
        data: { key: { remoteJid: `${digits}@s.whatsapp.net`, fromMe: true, id }, status: "DELIVERY_ACK" },
      });
    }, 250);

    await scheduleShopReply(thread, text);
    return;
  }

  if (path.startsWith("/chat/sendPresence") || path.startsWith("/chat/markMessageAsRead")) {
    return json(res, { status: "SUCCESS" });
  }
  if (path.startsWith("/chat/whatsappNumbers")) {
    const body = await readBody(req);
    const numbers = Array.isArray(body?.numbers) ? body.numbers : [];
    return json(
      res,
      numbers.map((n) => ({ exists: true, jid: `${String(n).replace(/\D/g, "")}@s.whatsapp.net`, number: String(n) }))
    );
  }
  if (path.startsWith("/chat/findMessages")) {
    const name = instanceOf(path, "/chat/findMessages");
    const body = await readBody(req);
    const want = String(body?.where?.key?.remoteJid ?? "").replace(/\D/g, "");
    const t = want ? threads.get(`${name}|${want}`) : null;
    const msgs = (t?.messages ?? []).slice(-10).map((m) => ({
      key: { remoteJid: `${t.digits}@s.whatsapp.net`, fromMe: m.dir === "out", id: randomUUID().slice(0, 20) },
      message: { conversation: m.text },
      messageTimestamp: Math.floor(m.at / 1000),
      pushName: t.persona.name,
    }));
    return json(res, { messages: { records: msgs, total: msgs.length } });
  }
  if (path.startsWith("/chat/findChats")) {
    const name = instanceOf(path, "/chat/findChats");
    const chats = [...threads.values()]
      .filter((t) => t.instance === name)
      .map((t) => ({ id: `${t.digits}@s.whatsapp.net`, name: t.persona.name, remoteJid: `${t.digits}@s.whatsapp.net` }));
    return json(res, chats);
  }
  if (path.startsWith("/chat/getBase64FromMediaMessage")) {
    return json(res, { base64: BOARD_PNG, mimetype: "image/png" });
  }
  if (path.startsWith("/chat/fetchProfilePictureUrl")) {
    return json(res, { wuid: "sim", profilePictureUrl: null });
  }
  if (path.startsWith("/chat/fetchProfile") || path.startsWith("/chat/findContacts")) {
    return json(res, []);
  }

  log({ note: `unhandled ${method} ${path}` });
  return json(res, { status: "SUCCESS", note: "simulated" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  WheelDeal shop simulator`);
  console.log(`  fake Evolution host : http://127.0.0.1:${PORT}`);
  console.log(`  app                 : ${APP_URL}`);
  console.log(`  market              : ${MARKET}`);
  console.log(`  shop wording        : ${USE_LLM ? `${OLLAMA_MODEL} via Ollama` : "templates (set SIM_LLM=1 for a local model)"}`);
  console.log(`\n  Put this in .env.local:`);
  console.log(`    EVOLUTION_HOSTS=http://127.0.0.1:${PORT}|${KEY}\n`);
});
