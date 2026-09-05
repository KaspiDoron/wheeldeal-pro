import "server-only";
import { hotStateClient } from "./rival-cache";

// ROUTE-LEVEL RATE LIMITING FOR SESSIONLESS ENDPOINTS.
//
// checkDailyLimit (usage.ts) is the only limiter the app had, and it is keyed
// per USER per day - it cannot see an unauthenticated caller at all. So every
// route that does real work WITHOUT a session (password reset, feedback
// submission, the Google-reviews proxy) was structurally unlimited: an open
// LLM faucet, an unbounded storage write, a billed-quota drain, and a
// password-reset flood that could lock a known account out and spam its inbox.
//
// This is a small IP-keyed fixed-window limiter for exactly those routes. When
// REDIS_URL is set it is atomic and fleet-wide (the same hot-state client the
// daily caps reserve through); without Redis it degrades to a per-instance
// window - weaker across a 20-instance fleet, but still turns "unlimited" into
// "20x the window", which is the difference between a nuisance and an outage.
// A limiter that can only ever REFUSE more is safe to add: a false refusal
// costs one retry, and it never grants access it should not.

interface Window {
  reset: number; // epoch ms when the window rolls over
  n: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wd_ratelimit__: Map<string, Window> | undefined;
}

function store(): Map<string, Window> {
  return (globalThis.__wd_ratelimit__ ??= new Map());
}

/**
 * The one bucket every caller we cannot identify shares.
 *
 * FAIL CLOSED, NOT OPEN. The old code answered "unknown" for a caller with no
 * usable header, which reads the same but was reached from the WRONG side: it
 * was the fallback after trusting attacker-written values. Now it is the answer
 * whenever the platform's own value is absent or unparseable, and everyone who
 * lands here shares a single window - a limiter that over-refuses costs one
 * retry; one that under-refuses is the bug this file exists to prevent.
 */
export const SHARED_BUCKET = "unattributable";

/**
 * How many proxy hops sit BETWEEN the real client and this process, each of
 * which appends its own address AFTER the client's. See clientIp.
 *
 * Cloud Run + a Cloud Run domain mapping (what this app deploys onto - see
 * .github/workflows/deploy-gcp.yml and docs/LAUNCH-wheeldeal.pro.md, where the
 * apex A/AAAA records point straight at Google) is ZERO: the Google front end
 * appends the client address and nothing follows it. Put a global external
 * Application Load Balancer, Cloudflare or any other proxy in front and each
 * one appends its own address too - set TRUSTED_PROXY_HOPS to how many, or the
 * app keys its limits on that proxy's constant address (one shared bucket:
 * over-strict, never exploitable).
 */
function trustedHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 8) : 0;
}

const IPV4_RX = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A dotted IPv4 literal with every octet in range, or null. */
function parseIpv4(v: string): string | null {
  if (!IPV4_RX.test(v)) return null;
  const octets = v.split(".").map(Number);
  return octets.every((o) => o <= 255) ? octets.join(".") : null;
}

/**
 * An IPv6 literal as its eight 16-bit groups, or null when it is not one.
 * Handles `::` compression and a dotted IPv4 tail (`::ffff:1.2.3.4`).
 */
function parseIpv6(v: string): number[] | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(v) || !v.includes(":")) return null;
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece.includes(".")) {
        // A dotted IPv4 tail is only legal as the LAST piece, and it fills two groups.
        if (i !== pieces.length - 1) return null;
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        const [a, b, c, d] = v4.split(".").map(Number);
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 2) {
    // `::` must stand for at least one zero group.
    if (head.length + tail.length > 7) return null;
    return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/**
 * An IPv4/IPv6 literal reduced to its RATE KEY: the port and `[...]` bracket
 * form removed, IPv4 kept as-is, and IPv6 collapsed to its /64 routing prefix.
 *
 * The host half of an IPv6 address is the caller's to choose: an ordinary
 * routed /64 lets one client source every request from a different /128, and
 * keyed on the full address that was 2^64 fresh windows for every IP-keyed cap
 * in the app (audit F185). A /64 is the smallest block a provider routes to a
 * single subscriber, so keying on it cannot merge two unrelated people - and
 * over-merging on an unusually shared prefix only ever refuses more, the safe
 * direction. IPv4-in-IPv6 (`::ffff:a.b.c.d` mapped, `::a.b.c.d` compatible,
 * dotted or hex) is unwrapped to the IPv4 branch FIRST: truncating those would
 * fold the whole IPv4 space into one prefix and lock every real user into a
 * single shared window.
 */
function normalizeIp(raw: string | undefined): string | null {
  let v = String(raw ?? "").trim();
  if (!v) return null;
  // "[2001:db8::1]:443" / "1.2.3.4:5678" - the port is noise for a rate key and
  // keeping it would let one client occupy many buckets.
  if (v.startsWith("[")) v = v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined);
  else if ((v.match(/:/g) ?? []).length === 1) v = v.split(":")[0];
  const v4 = parseIpv4(v);
  if (v4) return v4;
  const g = parseIpv6(v);
  if (!g) return null;
  const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  const leadingZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d, excluding
  // :: and ::1 themselves) carry an IPv4 caller - key them as that caller.
  if (leadingZero && g[5] === 0xffff) return embeddedV4();
  if (leadingZero && g[5] === 0 && (g[6] !== 0 || g[7] > 1)) return embeddedV4();
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/**
 * The caller's IP, read from the ONE position this platform actually guarantees.
 *
 * HOP 0 IS A VALUE THE ATTACKER WRITES. Google's front end (Cloud Run, and any
 * Google load balancer in front of it) does not replace X-Forwarded-For - it
 * APPENDS the address it observed to whatever the caller already sent. So a
 * request carrying `X-Forwarded-For: 1.2.3.4` arrives as `1.2.3.4, <real ip>`,
 * and the leftmost entry - the one this function used to return - is chosen by
 * the client. Rotating it per request bypassed every IP-keyed limit in the app,
 * including the forgot-password throttle whose entire job is to stop a known
 * account being locked out and its inbox flooded.
 *
 * The trustworthy position is therefore the RIGHT-hand end: the last entry was
 * written by infrastructure we run behind, and nothing a client sends can move
 * it. `TRUSTED_PROXY_HOPS` shifts left by the number of extra proxies that
 * appended after it (0 here - see above); anything that cannot be resolved to a
 * real address becomes the shared bucket rather than a free pass.
 *
 * The x-real-ip / cf-connecting-ip / fly-client-ip fallbacks are GONE on
 * purpose: nothing in this deployment writes them, so they were pure
 * attacker-controlled input wearing a trustworthy name.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return SHARED_BUCKET;
  const hops = xff
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const idx = hops.length - 1 - trustedHops();
  if (idx < 0) return SHARED_BUCKET;
  return normalizeIp(hops[idx]) ?? SHARED_BUCKET;
}

export interface RateVerdict {
  ok: boolean;
  /** Seconds until the window rolls over (only meaningful when !ok). */
  retryAfter: number;
}

/**
 * Count one hit against a fixed window. `max` hits are allowed per
 * `windowSec`; the (max+1)th in the same window is refused.
 *
 * `id` is the discriminator (usually clientIp(req), optionally combined with a
 * per-target key such as the email being reset, so one attacker cannot hide
 * behind a rotating IP while hammering a single victim).
 */
export async function rateLimit(
  bucket: string,
  id: string,
  max: number,
  windowSec: number
): Promise<RateVerdict> {
  const key = `rl:${bucket}:${id}`;

  // Fleet-wide path: INCR is atomic, so concurrent callers get distinct totals
  // and exactly one can be the one that crosses the line.
  try {
    const r = await hotStateClient();
    if (r) {
      const n = await r.incr(key);
      // Set the expiry only on the first hit so later traffic cannot push the
      // window forward and keep a caller throttled forever.
      if (n === 1) await r.expire(key, windowSec);
      // The window rolls over in at most `windowSec`; that is the honest upper
      // bound for the retry hint without a separate TTL round-trip.
      if (n > Math.max(1, max)) return { ok: false, retryAfter: windowSec };
      return { ok: true, retryAfter: 0 };
    }
  } catch {
    // A Redis hiccup degrades to the per-instance window, never to a refusal.
  }

  // Per-instance fallback.
  const now = Date.now();
  const s = store();
  const cur = s.get(key);
  if (!cur || cur.reset <= now) {
    s.set(key, { reset: now + windowSec * 1000, n: 1 });
    // Bounded sweep so the map cannot grow one entry per distinct IP forever.
    if (s.size > 10_000) {
      for (const [k, v] of s) if (v.reset <= now) s.delete(k);
    }
    return { ok: true, retryAfter: 0 };
  }
  cur.n += 1;
  if (cur.n > Math.max(1, max)) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((cur.reset - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

/**
 * READ a window without counting a hit: is the (max+1)th hit going to be
 * refused right now? For ceilings that must be COUNTED only on one outcome
 * (a verified wrong password) but CHECKED before the work that produces the
 * outcome - the login route's per-account guess ceiling (audit F184), where
 * counting before the verification would make the bucket an enumeration
 * oracle and a lockout weapon, and checking only after it would let a spent
 * ceiling still accept the correct guess.
 *
 * Same fail direction as rateLimit: a Redis hiccup falls back to the
 * per-instance window, never to a refusal.
 */
export async function rateLimitPeek(
  bucket: string,
  id: string,
  max: number,
  windowSec: number
): Promise<RateVerdict> {
  const key = `rl:${bucket}:${id}`;
  try {
    const r = await hotStateClient();
    if (r && typeof r.get === "function") {
      const n = Number((await r.get(key)) ?? 0);
      // The window rolls over in at most `windowSec` - the same honest upper
      // bound rateLimit reports on the fleet-wide path.
      if (Number.isFinite(n) && n >= Math.max(1, max)) return { ok: false, retryAfter: windowSec };
      return { ok: true, retryAfter: 0 };
    }
  } catch {
    /* per-instance fallback below */
  }
  const now = Date.now();
  const cur = store().get(key);
  if (!cur || cur.reset <= now) return { ok: true, retryAfter: 0 };
  if (cur.n >= Math.max(1, max)) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((cur.reset - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

/** Test seam - the per-instance window store is a module singleton. */
export function _resetRateLimit(): void {
  globalThis.__wd_ratelimit__ = new Map();
}
