// WHAT A GUIDE IS ABOUT, in the two dimensions traffic is reported by.
//
// Derived from the guide's own slug and category rather than hand-tagged per
// article: a tag somebody has to remember to add is a tag the twenty-first
// guide ships without, and an untagged guide reports as `xx / other` - which
// is honest, and shows up in the admin table as a row worth fixing.

import type { SubIdCategory, SubIdMarket } from "./subid";

const MARKET_WORDS: [RegExp, SubIdMarket][] = [
  [/thailand|thai\b|bangkok|phuket|chiang/, "th"],
  [/vietnam|hanoi|saigon|da-?nang/, "vn"],
  [/bali|indonesia|lombok/, "id"],
  [/philippines|cebu|siargao|palawan/, "ph"],
  [/malaysia|langkawi|penang/, "my"],
  [/cambodia|siem-?reap/, "kh"],
  [/sri-?lanka/, "lk"],
  [/greece|greek/, "gr"],
];

const MARKET_NAMES: Partial<Record<SubIdMarket, string>> = {
  th: "Thailand", vn: "Vietnam", id: "Bali", ph: "Philippines", my: "Malaysia",
  kh: "Cambodia", lk: "Sri Lanka", gr: "Greece",
};

export function guideTargeting(slug: string): { market: SubIdMarket; category: SubIdCategory } {
  const s = String(slug ?? "").toLowerCase();
  const market = MARKET_WORDS.find(([re]) => re.test(s))?.[1] ?? "xx";
  let category: SubIdCategory = "travel";
  if (/insurance/.test(s)) category = "insurance";
  else if (/licen[cs]e|permit/.test(s)) category = "licence";
  else if (/motorbike|motorcycle/.test(s)) category = "motorbike";
  else if (/scooter|helmet|riding/.test(s)) category = "scooter";
  else if (/\bcar\b|car-/.test(s)) category = "car";
  return { market, category };
}

/**
 * Search terms for a LINK partner's placement - never for Google's unit.
 *
 * Google's related-search unit generates its own terms from the page, and
 * supplying them (`terms`) is a Restricted Access Feature this account does not
 * hold; passing them anyway is a policy strike. A feed partner that hosts its
 * own results page is a different contract: it takes a keyword, and these are
 * the keywords - built by rule from what the guide is about, so a term can
 * never promise something the article is not about.
 */
export function linkTermsFor(market: SubIdMarket, category: SubIdCategory): string[] {
  const place = MARKET_NAMES[market];
  const where = place ? ` ${place}` : " abroad";
  const vehicle = category === "car" ? "car" : category === "motorbike" ? "motorbike" : "scooter";
  const terms = [`${vehicle} rental${where}`, `travel insurance${place ? ` for ${place}` : " for riders"}`];
  terms.push(category === "licence" ? "international driving permit online" : `${vehicle} rental insurance`);
  return terms;
}
