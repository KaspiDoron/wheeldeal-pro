// Response-time analytics: how fast each rental shop replies to our FIRST
// message. We record one sample per shop (the first reply after our RFQ) and
// tag the fastest quartile as "fast responders" - an Ultra-tier insight.

import "server-only";
import { createHash } from "crypto";
import { sbSelect, sbInsert, supabaseConfigured } from "./runtime-config";
import { digitsOnly } from "./phone";
import { numberFilter } from "./wa/phone-key";

/**
 * W9: the stored key is md5(digits), not the bare number. response_times was
 * the one table holding raw shop phone numbers with no owner and (until W9's
 * retention pass) no expiry - a global, growing phone book. The ranking only
 * ever needs EQUALITY between a sample and a probe, and a deterministic hash
 * gives exactly that: the writer hashes the shop's number, the reader hashes
 * its probe, retention.sql migrates legacy plain rows with the SQL md5() of
 * the same string. Not cryptographic anonymity (the phone space is small);
 * it removes the plain numbers from the table, which is the point.
 */
export function responsePhoneKey(phoneRaw: string): string {
  return createHash("md5").update(digitsOnly(phoneRaw)).digest("hex");
}

/**
 * On a shop's FIRST reply, record how long it took since our first outbound
 * message to them. Idempotent: only the first sample per phone is kept.
 */
export async function recordResponseTime(phoneRaw: string): Promise<void> {
  if (!supabaseConfigured()) return;
  const phone = digitsOnly(phoneRaw);
  if (phone.length < 7) return;
  const key = responsePhoneKey(phone);

  // Already have a sample for this shop? Keep the first reply only. (Legacy
  // rows may still hold the plain digits until retention migrates them.)
  const existing = await sbSelect(
    "response_times",
    `select=id&phone=in.(${encodeURIComponent(key)},${encodeURIComponent(phone)})&limit=1`
  );
  if (existing.length) return;

  // Our first outbound message to this shop = the RFQ that started the clock.
  const out = await sbSelect<{ received_at: string }>(
    "whatsapp_messages",
    `select=received_at&direction=eq.outbound&order=received_at.asc&limit=1${numberFilter(
      "to_number",
      phone
    )}`
  );
  const started = out[0]?.received_at ? Date.parse(out[0].received_at) : NaN;
  if (!Number.isFinite(started)) return;

  const ms = Date.now() - started;
  if (ms < 0 || ms > 7 * 24 * 3600_000) return; // ignore nonsense/very stale
  await sbInsert("response_times", [{ phone: key, ms }]);
}

// Cache the fast-responder set: recomputing on every search would be wasteful.
declare global {
  // eslint-disable-next-line no-var
  var __wd_fast_resp__: { data: Set<string>; exp: number } | undefined;
}

/**
 * PHONE KEYS (responsePhoneKey hashes) of the fastest-replying quartile of
 * shops - probe membership with `set.has(responsePhoneKey(number))`. Needs a
 * minimum sample of shops before the ranking is meaningful.
 */
export async function fastResponderPhones(): Promise<Set<string>> {
  const cache = globalThis.__wd_fast_resp__;
  if (cache && cache.exp > Date.now()) return cache.data;

  let result = new Set<string>();
  if (supabaseConfigured()) {
    const rows = await sbSelect<{ phone: string; ms: number }>(
      "response_times",
      "select=phone,ms&limit=20000"
    );
    // Best (fastest) sample per shop, normalizing legacy plain-digit rows to
    // the hashed key so both generations rank together.
    const best = new Map<string, number>();
    for (const r of rows) {
      const p = /^[0-9a-f]{32}$/.test(r.phone) ? r.phone : responsePhoneKey(r.phone);
      const prev = best.get(p);
      if (prev === undefined || r.ms < prev) best.set(p, r.ms);
    }
    const ranked = [...best.entries()].sort((a, b) => a[1] - b[1]);
    if (ranked.length >= 4) {
      const cut = Math.max(1, Math.ceil(ranked.length / 4)); // top 25%
      result = new Set(ranked.slice(0, cut).map(([p]) => p));
    }
  }
  globalThis.__wd_fast_resp__ = { data: result, exp: Date.now() + 5 * 60_000 };
  return result;
}
