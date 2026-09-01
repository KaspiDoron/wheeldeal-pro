"use client";

// ONE CHEAP POLL DRIVES THE EXPENSIVE ONES.
//
// The board's freshness used to BE its poll interval: /api/activity every 6s
// and /api/replies every 8s (15s and 20s under SCALE_MODE), each one issuing
// nine to fourteen selects. Polling those faster is not an option - they are
// already the app's dominant database cost - so a shop reply that was durable
// in the store within ~2 seconds could sit unseen for another twenty.
//
// This store polls /api/pulse instead: one indexed row per source, one integer
// back. When that integer moves, it wakes the heavy fetches immediately. The
// expensive intervals stay, relaxed, as a SAFETY FLOOR - they still carry the
// opportunistic outbox drain and the missed-webhook reconciler, which is why
// they do not go to zero.
//
// Module singleton for the same reason thread-peek-store is one: it is the same
// answer for every consumer, there is exactly one server truth behind it, and
// it must survive components mounting and unmounting.

import { PUBLIC_CONFIG_FALLBACK } from "./public-config";

export const PULSE_URL = "/api/pulse";

type Listener = (v: number) => void;
type HealthListener = (healthy: boolean) => void;

const listeners = new Set<Listener>();
const healthListeners = new Set<HealthListener>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: AbortController | null = null;
let lastV = 0;
let periodMs = PUBLIC_CONFIG_FALLBACK.poll.pulseMs;
/**
 * Consecutive answers that could not be trusted (HTTP failure, or the endpoint
 * itself reporting a source it could not read). While this is non-zero the
 * client must NOT conclude "nothing changed" - the heavy polls' own intervals
 * are the fallback, which is exactly why they were relaxed rather than removed.
 */
let blindStreak = 0;

/** Test seam - this is a module singleton. */
export function resetPulseStore(): void {
  stop();
  listeners.clear();
  healthListeners.clear();
  lastV = 0;
  blindStreak = 0;
  periodMs = PUBLIC_CONFIG_FALLBACK.poll.pulseMs;
}

/**
 * How many consecutive blind answers before the caller should stop trusting the
 * pulse. One transient failure is not a verdict; three in a row is.
 */
export const BLIND_LIMIT = 3;

/** True when the pulse can no longer be trusted to report a change. */
export function pulseBlind(): boolean {
  return blindStreak >= BLIND_LIMIT;
}

/**
 * Subscribe to the pulse's OWN health.
 *
 * This exists because the heavy poll intervals were relaxed on the assumption
 * that the pulse would wake them. If the pulse dies, that assumption makes
 * freshness WORSE than before it existed - so the caller has to hear about it
 * and tighten its own interval back up. Fires immediately with the current
 * verdict so a late subscriber is never left guessing.
 */
export function subscribePulseHealth(fn: HealthListener): () => void {
  healthListeners.add(fn);
  try {
    fn(!pulseBlind());
  } catch {
    /* a bad subscriber must not stop the store */
  }
  return () => {
    healthListeners.delete(fn);
  };
}

function noteBlind(blind: boolean) {
  const was = pulseBlind();
  blindStreak = blind ? blindStreak + 1 : 0;
  const now = pulseBlind();
  if (now === was) return;
  for (const fn of [...healthListeners]) {
    try {
      fn(!now);
    } catch {
      /* one bad subscriber must not stop the others */
    }
  }
}

export function setPulsePeriod(ms: number): void {
  const next = Math.max(1000, Math.floor(ms) || 0);
  if (next === periodMs) return;
  periodMs = next;
  if (timer) {
    stop();
    start();
  }
}

/**
 * Subscribe to "something changed for this user". The callback fires only on a
 * CHANGE, never on the first observation - a fresh subscriber must not trigger
 * a redundant heavy fetch, because whatever mounted it is already loading.
 */
export function subscribePulse(fn: Listener): () => void {
  listeners.add(fn);
  start();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stop();
  };
}

function start() {
  if (timer || typeof window === "undefined") return;
  timer = setInterval(() => void tick(), periodMs);
  document.addEventListener("visibilitychange", onVisibility);
  // A tab that has been hidden for minutes is stale by definition; do not wait
  // out a full period before finding out.
  void tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  inFlight?.abort();
  inFlight = null;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
}

function onVisibility() {
  if (!document.hidden) void tick();
}

async function tick(): Promise<void> {
  if (typeof document !== "undefined" && document.hidden) return;
  if (listeners.size === 0) return;
  // OVERLAP GUARD. On a slow connection the next interval must not overtake the
  // request in the air and land an older version over a newer one.
  if (inFlight) return;

  const ac = new AbortController();
  inFlight = ac;
  try {
    const res = await fetch(PULSE_URL, { cache: "no-store", signal: ac.signal });
    if (!res.ok) {
      noteBlind(true);
      return;
    }
    const data = (await res.json()) as { v?: number; degraded?: string[] };
    if (Array.isArray(data.degraded) && data.degraded.length > 0) {
      // A partial answer is not a version. Treating it as one would let a dead
      // table pin the board on a stale integer while everything looked fine.
      noteBlind(true);
      return;
    }
    noteBlind(false);
    const v = Number(data.v);
    if (!Number.isFinite(v) || v <= 0) return;
    if (lastV === 0) {
      // First observation establishes the baseline; it is not news.
      lastV = v;
      return;
    }
    if (v > lastV) {
      lastV = v;
      for (const fn of [...listeners]) {
        try {
          fn(v);
        } catch {
          /* one bad subscriber must not stop the others */
        }
      }
    }
  } catch {
    noteBlind(true);
  } finally {
    if (inFlight === ac) inFlight = null;
  }
}
