// SPTE self-improvement loop (the owner's "experience & continuous learning"):
// every successful deal is banked in deal_memory, so a future session in the
// same region + vehicle starts from a REAL prior (median achieved price,
// typical discount) instead of cold. This is what makes the app get better at
// bargaining a given market over time, at zero LLM cost.

import "server-only";
import { sbSelect, sbInsert } from "../runtime-config";
import { vehicleKeyFor } from "../market";
import type { StructuredRFQ } from "../types";

interface DealMemoryRow {
  price_per_day: number;
  list_price: number | null;
  duration_days: number | null;
}

/** Bank a won deal so future sessions learn from it. Called on deal close.
 *
 * W9: `userEmail` decides the `insights_ok` stamp - whether this row may feed
 * COMMERCIAL aggregate datasets - from the person's `commercial_insights`
 * consent at the moment of writing. The row itself stays user-free (that is
 * deal_memory's whole shape); the stamp is how a consent decision survives
 * into a store that cannot be filtered by person afterwards. The in-product
 * prior (dealPrior) reads every row regardless: bargaining with the market's
 * own history is the product working, not a data sale. */
export async function rememberDeal(args: {
  regionKey: string;
  rfq: StructuredRFQ;
  currency: string;
  pricePerDay: number;
  listPrice?: number;
  tactic?: string;
  userEmail?: string;
}): Promise<void> {
  let insightsOk = false;
  if (args.userEmail) {
    try {
      const { consentFor } = await import("../consent");
      insightsOk = await consentFor(args.userEmail, "commercial_insights");
    } catch {
      insightsOk = false; // consent you cannot read is consent you do not have
    }
  }
  const row = {
    region_key: args.regionKey,
    vehicle_key: vehicleKeyFor(args.rfq),
    currency: args.currency,
    price_per_day: Math.round(args.pricePerDay),
    list_price: args.listPrice ? Math.round(args.listPrice) : null,
    duration_days: args.rfq.durationDays,
    tactic: args.tactic ?? null,
    source: "deal",
  };
  const landed = await sbInsert("deal_memory", [{ ...row, insights_ok: insightsOk }]).catch(
    () => false
  );
  // Pre-migration fallback: a database without the column 400s the whole
  // insert, and losing the learning row to a pending migration would be the
  // worse trade. The legacy shape has no stamp, so it can never feed the
  // commercial rollup (which reads insights_ok=is.true only) - the fail
  // direction protects the person, not the dataset.
  if (!landed) await sbInsert("deal_memory", [row]).catch(() => {});
}

/**
 * Read the prior for a (region, vehicle): the median price travellers actually
 * achieved and the typical discount off the shop's first quote. Fed into the
 * single-pass prompt as grounded context - never invented. Returns null with a
 * small sample so a thin prior never over-anchors.
 */
export async function dealPrior(
  regionKey: string,
  rfq: StructuredRFQ
): Promise<{ medianAchieved: number; typicalDiscountPct: number; sampleSize: number } | null> {
  const rows = await sbSelect<DealMemoryRow>(
    "deal_memory",
    `select=price_per_day,list_price,duration_days&region_key=eq.${encodeURIComponent(
      regionKey
    )}&vehicle_key=eq.${encodeURIComponent(vehicleKeyFor(rfq))}&order=created_at.desc&limit=40`
  ).catch(() => []);
  if (rows.length < 3) return null; // too thin to trust

  const prices = rows.map((r) => r.price_per_day).filter((n) => n > 0).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];

  const discounts = rows
    .filter((r) => r.list_price && r.list_price > 0 && r.price_per_day > 0)
    .map((r) => 1 - r.price_per_day / (r.list_price as number))
    .filter((d) => d >= 0 && d < 0.9);
  const typicalDiscountPct = discounts.length
    ? Math.round((discounts.reduce((a, b) => a + b, 0) / discounts.length) * 100)
    : 0;

  return { medianAchieved: median, typicalDiscountPct, sampleSize: rows.length };
}
