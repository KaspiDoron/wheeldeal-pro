// Market Floor Intelligence - the owner-visible table of the LOWEST realistic
// daily rental prices per area, split by vehicle bucket (scooter/motorbike cc
// bands + car body types). The bargaining agent asks ONCE for a target price
// anchored to this floor so it never proposes absurd lowballs (a 70 THB/day
// scooter does not exist) and never needs a second push.
//
// Smart storage: we do NOT save prices for every town on earth. Prices are
// keyed at two levels - a coarse AREA key (e.g. "koh samui, thailand") and a
// COUNTRY key ("thailand") as fallback - and rows are refreshed by real web
// research at most once every 3 weeks, lazily, the first time someone searches
// in that area (then re-used instantly on every later visit to that area).

import "server-only";
import { sbSelect, sbInsert, sbUpdate } from "./runtime-config";
import { chat, chatGrounded, extractJson } from "./ai";
import { currencyForRegion } from "./agents";
import type { StructuredRFQ } from "./types";

export interface FloorRow {
  id?: number;
  region_key: string;
  vehicle_key: string;
  currency: string;
  floor_per_day: number;
  typical_per_day: number | null;
  source: string; // "web" | "ai" | "owner"
  // F5: true only when the number came from a Google-Search-grounded lookup with
  // at least one citation. A benchmark is shown to users / cited to shops ONLY
  // when grounded - never an ungrounded model guess.
  grounded?: boolean;
  source_url?: string | null;
  updated_at?: string;
}

// Every vehicle variation we track. Scooters/motorbikes bucket by cc band;
// cars bucket by body type. This keeps the table small and universal.
export const VEHICLE_KEYS = [
  "scooter-110", // 100-115cc automatic (Click/Scoopy class)
  "scooter-125", // 125cc automatic
  "scooter-160", // 150-160cc automatic (NMax/PCX class)
  "motorbike-150", // small manual
  "motorbike-300", // 200-300cc manual
  "motorbike-500", // 400-500cc manual
  "motorbike-big", // 650cc+ manual
  "car-economy",
  "car-sedan",
  "car-suv",
  "car-van",
  "car-luxury",
] as const;

export function vehicleKeyFor(rfq: StructuredRFQ): string {
  if (rfq.vehicleClass === "car") {
    const t = rfq.carType && rfq.carType !== "any" ? rfq.carType : "economy";
    return `car-${t}`;
  }
  const cc = rfq.engineSizeCc ?? (rfq.vehicleClass === "scooter" ? 125 : 150);
  if (rfq.vehicleClass === "scooter") {
    return cc <= 115 ? "scooter-110" : cc <= 140 ? "scooter-125" : "scooter-160";
  }
  return cc <= 175 ? "motorbike-150" : cc <= 300 ? "motorbike-300" : cc <= 550 ? "motorbike-500" : "motorbike-big";
}

/** ["koh samui, thailand", "thailand"] - area first, country fallback. */
export function regionKeysFor(region?: string): string[] {
  if (!region) return [];
  const parts = region
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  const country = parts[parts.length - 1];
  // Area = first locality + country, so "Bophut, Koh Samui, Thailand" and
  // "Maenam, Koh Samui, Thailand" share the "koh samui, thailand" row.
  const locality = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  const area = locality === country ? country : `${locality}, ${country}`;
  return area === country ? [country] : [area, country];
}

const FRESH_MS = 21 * 24 * 3600_000; // web-research refresh cadence: every 3 weeks

/**
 * Lowest realistic daily price for this spec near this region.
 * Triggers a lazy AI refresh (once a week per area) when data is missing/stale.
 *
 * THE FLOOR HAS TO SPEAK THE THREAD'S CURRENCY (audit F095).
 *
 * `defaultFloor` used to re-derive its own currency with
 * `currencyForRegion(region) ?? "USD"`, and `currencyForRegion` matches nothing
 * in the labels the geocoder actually leaves behind - "My current location", a
 * raw "8.0000, 98.0000" pin. So a +66 shop's price of record was THB while its
 * floor came back USD, `floor.currency === cur` was false, and every
 * price-sanity net on that thread was skipped. Two optional inputs close it,
 * both of which the caller already has in hand:
 *
 *   `currency`      - the currency the thread ALREADY resolved (phone prefix
 *                     included). Used instead of re-deriving one, and when the
 *                     conversion table has no rate for it the answer is NULL:
 *                     an absent floor is honest, an invented one is not.
 *   `countryRegion` - the shop's country, added to the stored-row lookup as an
 *                     EXTRA set of keys. Not a swap: the area row for
 *                     "Ao Nang, Thailand" is still preferred over "thailand".
 */
export async function floorPriceFor(
  region: string | undefined,
  rfq: StructuredRFQ,
  opts: { currency?: string; countryRegion?: string } = {}
): Promise<{ floor: number; typical: number | null; currency: string } | null> {
  // Region keys first (most specific), then the shop-country keys, de-duped.
  const keys = [...new Set([...regionKeysFor(region), ...regionKeysFor(opts.countryRegion)])];
  if (!keys.length) return null;
  const vkey = vehicleKeyFor(rfq);

  const rows = await sbSelect<FloorRow>(
    "market_floor_prices",
    `select=region_key,vehicle_key,currency,floor_per_day,typical_per_day,updated_at&vehicle_key=eq.${encodeURIComponent(
      vkey
    )}&region_key=in.(${keys.map((k) => `"${k}"`).join(",")})&limit=6`
  );
  // Prefer the most specific (area) row, in key order.
  const row = keys.map((k) => rows.find((r) => r.region_key === k)).find(Boolean);

  const stale =
    !row ||
    (row.updated_at ? Date.now() - Date.parse(row.updated_at) > FRESH_MS : false);
  if (stale) {
    // Fire-and-forget: next search gets fresh numbers; this one still gets the
    // old row (or the deterministic default below) with zero added latency.
    refreshRegionFloors(keys[0]).catch(() => {});
  }
  if (row && row.floor_per_day > 0) {
    return { floor: row.floor_per_day, typical: row.typical_per_day, currency: row.currency };
  }
  return defaultFloor(region, vkey, opts);
}

export interface GroundedBenchmark {
  pricePerDay: number;
  currency: string;
  sourceUrl: string;
  grounded: true;
}

/**
 * A CITABLE market benchmark for a spec near a region - returned ONLY when the
 * stored row is web-grounded with a source URL (F5 anti-hallucination). Callers
 * (the card band, the composer leverage line) must never show an ungrounded
 * number as if it were a real market rate. Returns null when no grounded row
 * exists yet (a lazy refresh is still kicked so the NEXT search has one).
 */
export async function groundedBenchmarkFor(
  region: string | undefined,
  rfq: StructuredRFQ
): Promise<GroundedBenchmark | null> {
  const keys = regionKeysFor(region);
  if (!keys.length) return null;
  const vkey = vehicleKeyFor(rfq);
  const rows = await sbSelect<FloorRow>(
    "market_floor_prices",
    `select=region_key,currency,floor_per_day,grounded,source_url,updated_at&vehicle_key=eq.${encodeURIComponent(
      vkey
    )}&region_key=in.(${keys.map((k) => `"${k}"`).join(",")})&grounded=eq.true&limit=4`
  ).catch(() => []);
  const row =
    rows.find((r) => r.region_key === keys[0]) ?? rows.find((r) => r.region_key === keys[1]);
  if (row && row.grounded && row.source_url && row.floor_per_day > 0) {
    return {
      pricePerDay: row.floor_per_day,
      currency: row.currency,
      sourceUrl: row.source_url,
      grounded: true,
    };
  }
  // No grounded benchmark yet - kick a lazy refresh for next time, return null.
  refreshRegionFloors(keys[0]).catch(() => {});
  return null;
}

// Researched per-country seed: the LOWEST realistic walk-in price for a 125cc
// automatic scooter, per day, in LOCAL currency (low season, multi-day, cash).
// Keys match the lowercase country name regionKeysFor() extracts from labels.
// These seed the hints and the agent's sanity floor before the weekly AI
// research replaces them with area-accurate rows.
const COUNTRY_SCOOTER_FLOOR: Record<string, { cur: string; perDay: number }> = {
  thailand: { cur: "THB", perDay: 150 },
  indonesia: { cur: "IDR", perDay: 50000 },
  vietnam: { cur: "VND", perDay: 100000 },
  // PRODUCTION FIX: 350 sat ABOVE real live quotes (two shops at 300/day in the
  // Camiguin/Moalboal drills) - a floor above the quote flips priceAtOrBelowFloor
  // true and makes the d-bargain edge illegal, muting ALL bargaining ("Bargained
  // ₱0"). 150 is the real low-season walk-in floor for a 125cc in the provinces.
  philippines: { cur: "PHP", perDay: 150 },
  malaysia: { cur: "MYR", perDay: 25 },
  india: { cur: "INR", perDay: 400 },
  "sri lanka": { cur: "LKR", perDay: 2500 },
  nepal: { cur: "NPR", perDay: 1000 },
  taiwan: { cur: "TWD", perDay: 400 },
  japan: { cur: "JPY", perDay: 4000 },
  "south korea": { cur: "KRW", perDay: 30000 },
  singapore: { cur: "SGD", perDay: 50 },
  greece: { cur: "EUR", perDay: 15 },
  spain: { cur: "EUR", perDay: 18 },
  portugal: { cur: "EUR", perDay: 15 },
  italy: { cur: "EUR", perDay: 20 },
  france: { cur: "EUR", perDay: 25 },
  croatia: { cur: "EUR", perDay: 20 },
  cyprus: { cur: "EUR", perDay: 15 },
  malta: { cur: "EUR", perDay: 18 },
  turkey: { cur: "TRY", perDay: 400 },
  israel: { cur: "ILS", perDay: 120 },
  mexico: { cur: "MXN", perDay: 350 },
  brazil: { cur: "BRL", perDay: 80 },
  morocco: { cur: "MAD", perDay: 150 },
  egypt: { cur: "EGP", perDay: 250 },
  "south africa": { cur: "ZAR", perDay: 250 },
  australia: { cur: "AUD", perDay: 40 },
  "new zealand": { cur: "NZD", perDay: 40 },
  "united states": { cur: "USD", perDay: 35 },
  usa: { cur: "USD", perDay: 35 },
  "united arab emirates": { cur: "AED", perDay: 100 },
};

// The credibility clamp lives in graph/math.ts (pure - the engine imports it
// statically so test mocks of THIS module can never hide it); re-exported here
// for the market-domain callers (agent-loop).
export { credibleFloor } from "./graph/math";

// How each TWO-WHEELER bucket prices relative to a 125cc scooter (=1.0). Rough
// but consistent worldwide - real area rows from the AI refresh override these.
//
// CARS DELIBERATELY ARE NOT IN HERE. They used to be, as the local scooter
// floor times a constant, and that is not a car price in any market: in
// Thailand it produced ~540 THB/day for an economy car against a real walk-in
// floor closer to 800. A car is a different market with different fixed costs,
// not a big scooter. Cars anchor on their own baseline below. Lives in
// vehicle/class-profile so the classes stay one table rather than five.
import { SCOOTER_RELATIVE, scalesFromScooter } from "./vehicle/class-profile";

// Conservative built-in floors (per day, LOCAL currency) so the agent is sane
// even before the AI has researched an area. Deliberately on the low-but-real
// side; the AI refresh replaces them with area-accurate numbers.
function defaultFloor(
  region: string | undefined,
  vkey: string,
  opts: { currency?: string; countryRegion?: string } = {}
): { floor: number; typical: number | null; currency: string } | null {
  // Country-researched seed first - the most accurate zero-AI answer we have,
  // but ONLY for the buckets it can honestly scale to. A car is not a big
  // scooter, so a car bucket falls through to its own baseline below rather
  // than to the local scooter floor times a constant.
  //
  // The shop-country key is consulted after the region's own, so a label with
  // no country token ("My current location") still reaches its country's seed.
  const ratio = SCOOTER_RELATIVE[vkey];
  const countryKeys = [
    regionKeysFor(region).pop(),
    regionKeysFor(opts.countryRegion).pop(),
  ].filter((k): k is string => Boolean(k));
  const seed = countryKeys.map((k) => COUNTRY_SCOOTER_FLOOR[k]).find(Boolean);
  if (seed && scalesFromScooter(vkey) && ratio) {
    const floor = Math.round(seed.perDay * ratio);
    return { floor, typical: Math.round(floor * 1.6), currency: seed.cur };
  }
  // The currency the CALLER already resolved wins - it consulted the shop's
  // phone prefix, which this module cannot see. Only when no caller supplied
  // one does the old region-only derivation (and its USD last resort) apply.
  const cur = opts.currency || currencyForRegion(region) || currencyForRegion(opts.countryRegion) || "USD";
  // Fallback: USD baseline converted by rough purchasing-power multipliers.
  // Lowest realistic walk-in day rate, in USD, per bucket. The CAR rows are
  // researched car prices rather than a multiple of a scooter: an economy car
  // does not rent for three and a half scooters anywhere, and the old ratio put
  // the Thai economy-car floor around 540 THB against a real floor closer to
  // 900. A floor below the real market is not harmless - it is the number the
  // agent negotiates toward and the number the app calls "market rate".
  const usd: Record<string, number> = {
    "scooter-110": 4, "scooter-125": 5, "scooter-160": 7,
    "motorbike-150": 6, "motorbike-300": 12, "motorbike-500": 20, "motorbike-big": 30,
    "car-economy": 25, "car-sedan": 32, "car-suv": 42, "car-van": 50, "car-luxury": 90,
  };
  // Every currency the country seed table can produce needs a rate here, or a
  // car search in that country gets NO floor at all now that cars no longer
  // borrow the scooter seed.
  const fx: Record<string, number> = {
    USD: 1, EUR: 0.95, GBP: 0.8, THB: 36, IDR: 16000, VND: 25000, INR: 84,
    JPY: 150, PHP: 58, MYR: 4.6, TRY: 34, MXN: 18, ILS: 3.7,
    LKR: 300, NPR: 135, TWD: 32, KRW: 1350, SGD: 1.35, BRL: 5.5,
    MAD: 10, EGP: 48, ZAR: 18, AUD: 1.5, NZD: 1.65, AED: 3.67, CNY: 7.2,
  };
  const base = usd[vkey];
  if (!base || !fx[cur]) return null;
  const floor = Math.round(base * fx[cur]);
  return { floor, typical: Math.round(floor * 1.5), currency: cur };
}

/**
 * Web-grounded research (every 3 weeks per area): find the honest LOWEST and
 * typical daily rental price for every vehicle bucket in one area, in the local
 * currency, by SEARCHING THE WEB, and upsert the rows. Anchored to the cheapest
 * real vehicles - a 110cc automatic scooter and a small 4-seat economy car.
 * Prefers Gemini's Google-Search grounding (real listings); falls back to an
 * ungrounded model estimate when no Gemini key is set. Owner edits always win.
 */
export async function refreshRegionFloors(regionKey: string): Promise<boolean> {
  const cur = currencyForRegion(regionKey) ?? "USD";
  const system =
    "You are a vehicle-rental market analyst. SEARCH THE WEB for current rental " +
    "listings and prices in the given area, then report the LOWEST realistic " +
    "daily price a local shop actually accepts (low season, multi-day, cash) and " +
    `the TYPICAL walk-in daily price, in ${cur}, for each vehicle key. Anchor the ` +
    "cheapest tiers on the smallest real vehicles: 'scooter-110' = a 110cc " +
    "automatic scooter (Honda Click / Scoopy class), 'car-economy' = a small " +
    "4-seat economy hatchback. Never quote fantasy lows a shop would laugh at. " +
    'Reply ONLY as JSON: { "prices": [ { "key": string, "floor": number, ' +
    '"typical": number } ] } covering exactly these keys: ' +
    VEHICLE_KEYS.join(", ") + ".";
  const userMsg = `Area: ${regionKey}. Currency: ${cur}. Search the web for today's real rental prices there.`;

  // 1) Real web grounding (Gemini + Google Search). 2) Ungrounded estimate.
  let text: string | null = null;
  let source = "web";
  let isGrounded = false;
  let sourceUrl: string | null = null;
  const grounded = await chatGrounded(system, userMsg);
  // F5: only trust the grounded path when it actually returned CITATIONS. A
  // grounded call that came back with no sources is not a verified benchmark -
  // treat it like the ungrounded fallback so it can never be shown/cited.
  if (grounded?.text && Array.isArray(grounded.sources) && grounded.sources.length > 0) {
    text = grounded.text;
    isGrounded = true;
    sourceUrl = grounded.sources[0] ?? null;
  } else {
    text =
      grounded?.text ??
      (await chat([
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ]));
    source = "ai";
  }
  if (!text) return false;
  const parsed = extractJson<{ prices: { key: string; floor: number; typical: number }[] }>(text);
  if (!parsed?.prices?.length) return false;

  const existing = await sbSelect<FloorRow>(
    "market_floor_prices",
    `select=id,vehicle_key,source&region_key=eq.${encodeURIComponent(regionKey)}&limit=50`
  );
  for (const p of parsed.prices) {
    if (!VEHICLE_KEYS.includes(p.key as (typeof VEHICLE_KEYS)[number])) continue;
    if (!(p.floor > 0)) continue;
    const prior = existing.find((e) => e.vehicle_key === p.key);
    if (prior?.source === "owner") continue; // owner overrides always win
    const values = {
      region_key: regionKey,
      vehicle_key: p.key,
      currency: cur,
      floor_per_day: Math.round(p.floor),
      typical_per_day: p.typical > 0 ? Math.round(p.typical) : null,
      source,
      grounded: isGrounded,
      source_url: sourceUrl,
      updated_at: new Date().toISOString(),
    };
    if (prior?.id) {
      await sbUpdate("market_floor_prices", `id=eq.${prior.id}`, values);
    } else {
      await sbInsert("market_floor_prices", [values]);
    }
  }
  return true;
}

/** Owner table view: all researched areas + rows. */
export async function listFloors(): Promise<FloorRow[]> {
  return sbSelect<FloorRow>(
    "market_floor_prices",
    "select=id,region_key,vehicle_key,currency,floor_per_day,typical_per_day,source,updated_at&order=region_key.asc,vehicle_key.asc&limit=500"
  );
}

/** Owner edit: set a floor by hand (survives AI refreshes). */
export async function ownerSetFloor(
  id: number,
  floor: number,
  typical?: number | null
): Promise<void> {
  await sbUpdate("market_floor_prices", `id=eq.${id}`, {
    floor_per_day: Math.round(floor),
    ...(typical !== undefined ? { typical_per_day: typical } : {}),
    source: "owner",
    updated_at: new Date().toISOString(),
  });
}
