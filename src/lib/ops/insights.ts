// The sellable artefact (Wave 9, owner problem #10): a DE-IDENTIFIED rollup
// over deal_memory's (region, vehicle, price, tactic) shape.
//
// Three properties make it defensible, and each is enforced here rather than
// promised:
//   1. The source rows carry no user or shop identifier (deal_memory's shape).
//   2. Only rows stamped insights_ok=true participate - the stamp is written
//      from the person's commercial_insights consent at deal-close time, so a
//      legacy or non-consented row can never enter the commercial artefact
//      (it still serves the in-product prior; that is the product working,
//      not a data sale).
//   3. K-ANONYMITY FLOOR: a group under K_ANONYMITY_FLOOR deals is suppressed
//      whole. A "median price for scooters in <tiny village>" computed from
//      two deals is functionally those two travellers' private outcomes.
//
// Materialisation is ON DEMAND from the owner-only route (admin/ops/insights)
// rather than on a schedule - deliberately, recorded here: there is no buyer
// integration yet, so a cron would only spend rows to keep a JSON nobody
// reads warm. When a delivery pipeline exists, schedule THIS function.

import "server-only";
import { sbSelectDark } from "../runtime-config";

export const K_ANONYMITY_FLOOR = 20;

interface DealRow {
  region_key: string;
  vehicle_key: string;
  currency: string;
  price_per_day: number;
  list_price: number | null;
  duration_days: number | null;
  tactic: string | null;
}

export interface InsightGroup {
  regionKey: string;
  vehicleKey: string;
  currency: string;
  deals: number;
  medianPricePerDay: number;
  p25PricePerDay: number;
  p75PricePerDay: number;
  typicalDiscountPct: number | null;
  topTactics: { tactic: string; share: number }[];
}

export interface InsightsRollup {
  builtAt: string;
  kFloor: number;
  groups: InsightGroup[];
  /** Groups withheld by the k-floor - counted, never named (naming a tiny
   *  group's key is half the leak the floor exists to stop). */
  suppressedGroups: number;
  consentedRows: number;
  /** null = the store could not be read; an empty rollup is not claimed. */
  unreadable: boolean;
}

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];

/** Build the rollup from consented rows only, k-floor enforced per group. */
export async function buildInsightsRollup(limit = 20_000): Promise<InsightsRollup> {
  const rows = await sbSelectDark<DealRow>(
    "deal_memory",
    `select=region_key,vehicle_key,currency,price_per_day,list_price,duration_days,tactic&insights_ok=is.true&order=created_at.desc&limit=${limit}`
  );
  if (rows === null) {
    return {
      builtAt: new Date().toISOString(),
      kFloor: K_ANONYMITY_FLOOR,
      groups: [],
      suppressedGroups: 0,
      consentedRows: 0,
      unreadable: true,
    };
  }

  const byGroup = new Map<string, DealRow[]>();
  for (const r of rows) {
    if (!(r.price_per_day > 0)) continue;
    const key = `${r.region_key}|${r.vehicle_key}|${r.currency}`;
    byGroup.set(key, [...(byGroup.get(key) ?? []), r]);
  }

  const groups: InsightGroup[] = [];
  let suppressed = 0;
  for (const [key, deals] of byGroup) {
    if (deals.length < K_ANONYMITY_FLOOR) {
      suppressed++;
      continue;
    }
    const [regionKey, vehicleKey, currency] = key.split("|");
    const prices = deals.map((d) => d.price_per_day).sort((a, b) => a - b);
    const discounts = deals
      .filter((d) => d.list_price && d.list_price > 0)
      .map((d) => 1 - d.price_per_day / (d.list_price as number))
      .filter((d) => d >= 0 && d < 0.9);
    const tacticCount = new Map<string, number>();
    for (const d of deals) {
      if (d.tactic) tacticCount.set(d.tactic, (tacticCount.get(d.tactic) ?? 0) + 1);
    }
    groups.push({
      regionKey,
      vehicleKey,
      currency,
      deals: deals.length,
      medianPricePerDay: pct(prices, 50),
      p25PricePerDay: pct(prices, 25),
      p75PricePerDay: pct(prices, 75),
      typicalDiscountPct: discounts.length
        ? Math.round((discounts.reduce((a, b) => a + b, 0) / discounts.length) * 100)
        : null,
      topTactics: [...tacticCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tactic, n]) => ({ tactic, share: Math.round((n / deals.length) * 100) / 100 })),
    });
  }
  groups.sort((a, b) => b.deals - a.deals);

  return {
    builtAt: new Date().toISOString(),
    kFloor: K_ANONYMITY_FLOOR,
    groups,
    suppressedGroups: suppressed,
    consentedRows: rows.length,
    unreadable: false,
  };
}
