import "server-only";

// THE CURRENCY-OF-RECORD CHAIN, in its own SERVER module.
//
// It cannot live in `currency.ts`: that module is imported by client
// components (the deals page renders money), and this chain reaches
// `agents.ts`, which is `server-only`. Putting it there pulled the whole agent
// ecosystem into the browser bundle and the build refused it - correctly.

/**
 * THE ONE CURRENCY-OF-RECORD CHAIN, for every path that needs one.
 *
 * The chain was written once, inline, in the inbound reply path - and the tick
 * path, the user-action path, the LLM extractor and three API routes each kept
 * their own `currencyForRegion(region) || "USD"`. `currencyForRegion` returns
 * null for every label the geocoder actually produces ("Ao Nang", "Krabi",
 * "Canggu", "Da Nang", "Siargao", a raw "8.0000, 98.0000"), so those paths
 * resolved USD - and the tick path then OVERWROTE the thread's correct stored
 * currency with it, put it in the composer's prompt, and sent it to the shop.
 *
 * Order, strongest evidence first:
 *   1. what the thread already RESOLVED and stored (a decision, not a guess)
 *   2. the traveller's region label, when it names a country
 *   3. the SHOP'S PHONE PREFIX - the most reliable signal, and the one no
 *      caller consulted
 *   4. undefined. NEVER "USD": an unknown currency renders as a bare number
 *      with a chip, which is honest; a wrong symbol is the trust-killer the
 *      owner reported.
 */
export async function resolveLocalCurrency(args: {
  stored?: string | null;
  region?: string | null;
  shopDigits?: string | null;
}): Promise<string | undefined> {
  const stored = (args.stored ?? "").trim().toUpperCase();
  if (stored) return stored;
  const { currencyForRegion } = await import("./agents");
  const fromRegion = currencyForRegion(args.region || undefined);
  if (fromRegion) return fromRegion;
  if (args.shopDigits) {
    const { countryForShop } = await import("./copy/region");
    const fromShop = currencyForRegion(countryForShop(args.shopDigits) || undefined);
    if (fromShop) return fromShop;
  }
  return undefined;
}
