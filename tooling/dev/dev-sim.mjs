// ONE COMMAND DEV MODE: the app, plus a town full of rental shops.
//
//   npm run dev:sim
//
// Starts the fake Evolution host (tooling/sim) and `next dev` together, streams
// both logs with a prefix, and shuts both down on Ctrl-C. Nothing here is
// reachable from the built app - it is a launcher, not a feature.
//
// Env passthrough: everything in .env.local, plus
//   SIM_MARKET  bali | thailand | philippines | vietnam | goa
//   SIM_LLM     1 to have a local Ollama model write the shops' messages
//   SIM_PORT    default 8788

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Load .env.local without a dependency - the sim needs the same secrets the
 *  app has (SESSION_SECRET derives the webhook token). */
function loadEnv() {
  const file = path.join(root, ".env.local");
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };
const simPort = env.SIM_PORT || "8788";
const simKey = env.SIM_KEY || "simkey";

if (!env.SUPABASE_URL) {
  console.log("\n  No SUPABASE_URL in .env.local - run ./tooling/dev/local-db.sh first.");
  console.log("  Without a database the funnel records nothing.\n");
}
const hosts = env.EVOLUTION_HOSTS || "";
if (!hosts.includes(`:${simPort}`)) {
  console.log(`\n  WARNING: .env.local EVOLUTION_HOSTS does not point at the simulator.`);
  console.log(`  Expected a line: EVOLUTION_HOSTS=http://127.0.0.1:${simPort}|${simKey}\n`);
}

const children = [];
function start(name, cmd, args, extraEnv, colour) {
  const child = spawn(cmd, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const write = (chunk, stream) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) stream.write(`${colour}${name}\x1b[0m ${line}\n`);
    }
  };
  child.stdout.on("data", (c) => write(c, process.stdout));
  child.stderr.on("data", (c) => write(c, process.stderr));
  child.on("exit", (code) => {
    console.log(`${colour}${name}\x1b[0m exited (${code})`);
    shutdown();
  });
  children.push(child);
  return child;
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start("[shops]", process.execPath, ["tooling/sim/evolution-sim.mjs"], { SIM_PORT: simPort, SIM_KEY: simKey }, "\x1b[35m");
start("[app]  ", "npm", ["run", "dev"], {}, "\x1b[36m");

// THE CRON THAT IS NOT THERE IN DEV.
//
// In production a one-minute cron hits /api/wa/ping, which drains the outbox
// and the engine's wakeups. Locally nothing does, so paced messages sit until a
// browser poll happens to pick them up - and a dev session then measures the
// latency of a page poll rather than of the product. This is that cron.
const tickToken = (() => {
  const secret = env.SESSION_SECRET;
  const salt = env.WEBHOOK_TOKEN_SALT;
  if (!secret || secret.length < 16) return null;
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(salt ? `wd-webhook:${secret}:${salt}` : `wd-webhook:${secret}`)
    .digest("hex")
    .slice(0, 32);
})();

if (tickToken) {
  const appUrl = (env.SIM_APP_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
  const tick = async () => {
    for (const path of ["/api/wa/ping", "/api/wa/reply-tick"]) {
      try {
        await fetch(`${appUrl}${path}?token=${tickToken}`, { cache: "no-store" });
      } catch {
        /* the app may still be compiling - the next tick will do */
      }
    }
  };
  setInterval(tick, 15_000).unref?.();
  setTimeout(tick, 8_000);
  console.log("  drain ticker  every 15s (stands in for the production cron)");
}

console.log(`
  WheelDeal dev mode
    app        http://localhost:3000
    shops      http://127.0.0.1:${simPort}/sim/threads
    reply SLA  http://127.0.0.1:${simPort}/sim/sla
    wire log   http://127.0.0.1:${simPort}/sim/events
`);
