import type { SessionShopRow } from "../graph/types";

// WHERE EVERY OTHER SHOP IN THIS HUNT STANDS.
//
// The cross-thread read gave a turn PRICES and nothing else: `validRivals`
// returns live, priced, comparable-currency quotes and drops everything else on
// the floor. So the agent answering shop B could not know that shop C had said
// no, that shop D was still silent, or that B was the last shop left in the
// hunt - and every one of those changes how hard a human would push.
//
//   - "four other shops have quoted, the cheapest at 200" -> push hard, walk away
//     is cheap.
//   - "every other shop said no or has none left" -> this is the only bike in
//     town, stop squeezing and secure it.
//   - "nobody else has replied yet" -> we have no leverage at all; do not bluff
//     one, because the rails will catch it and the shop would too.
//
// Three rules this block obeys, all of them load-bearing:
//
//   1. NO SHOP NAMES, EVER. Same disclosure rule as the rival card: handing one
//      shop a competitor's identity from the traveller's own number is how a
//      name ends up where it must not be. The brief carries states and prices.
//   2. NO NEW FACTS. Every field comes from the session rows the engine already
//      loads. This block cannot invent a price, and a number it prints is one
//      the rival card could print too.
//   3. BOUNDED. A hunt can hold forty shops and this runs inside a 9-second
//      composition budget on the free rungs. Lines and characters are both
//      capped, and the overflow is stated as a count rather than dropped
//      silently - "and 12 more" is a fact; omitting them is a lie by omission.

/** Most rows the brief will list individually before it summarises the rest. */
export const BRIEF_MAX_LINES = 8;
/** Hard character ceiling on the whole block, prompt-budget side. */
export const BRIEF_MAX_CHARS = 700;

const DEAD_PHASES = new Set(["dead", "closed", "closing"]);

export type ShopStandingKind =
  | "quoted"
  | "negotiating"
  | "presented"
  | "declined"
  | "out_of_stock"
  | "no_reply"
  | "talking";

export interface ShopStanding {
  kind: ShopStandingKind;
  pricePerDay?: number;
  currency?: string;
  /** A price we DIVIDED out of a package covering this many days. */
  quoteBasisDays?: number;
  rounds?: number;
  firmCount?: number;
}

/**
 * Where one shop stands, from the row the engine already built.
 *
 * Terminal states win over a price, because a shop that has walked away is not
 * a shop with a price - that is the whole reason a declined shop stops being
 * citable leverage.
 */
export function standingFor(r: SessionShopRow): ShopStanding {
  const priced = typeof r.pricePerDay === "number" && r.pricePerDay > 0;
  const price = priced
    ? { pricePerDay: r.pricePerDay, currency: r.currency, quoteBasisDays: r.quoteBasisDays }
    : {};
  if (r.declined || (r.phase && DEAD_PHASES.has(r.phase))) return { kind: "declined", ...price };
  if (r.outOfStock) return { kind: "out_of_stock", ...price };
  if (r.presented || r.phase === "presented" || r.phase === "complete") {
    return { kind: "presented", ...price, rounds: r.rounds, firmCount: r.firmCount };
  }
  if (priced) {
    return {
      kind: (r.rounds ?? 0) > 0 ? "negotiating" : "quoted",
      ...price,
      rounds: r.rounds,
      firmCount: r.firmCount,
    };
  }
  // No price yet. "Talking" and "silent" are genuinely different: one is a shop
  // we are mid-conversation with, the other is a message that may never be read.
  const talking = (r.rounds ?? 0) > 0 || (r.phase != null && r.phase !== "opening");
  return { kind: talking ? "talking" : "no_reply" };
}

function money(s: ShopStanding): string {
  if (typeof s.pricePerDay !== "number") return "";
  const cur = s.currency ? ` ${s.currency}` : "";
  const basis =
    typeof s.quoteBasisDays === "number" && s.quoteBasisDays > 1
      ? ` (their ${s.quoteBasisDays}-day package worked out per day - not a price they typed)`
      : "";
  return `${s.pricePerDay}${cur}/day${basis}`;
}

function lineFor(s: ShopStanding): string {
  const firm =
    (s.firmCount ?? 0) >= 2
      ? ", and has said last price twice"
      : (s.firmCount ?? 0) === 1
        ? ", said last price once"
        : "";
  switch (s.kind) {
    case "declined":
      return s.pricePerDay
        ? `- said no (had quoted ${money(s)})`
        : "- said no";
    case "out_of_stock":
      return s.pricePerDay
        ? `- has none available for these dates (had quoted ${money(s)})`
        : "- has none available for these dates";
    case "presented":
      return `- quoted ${money(s)} and their deal is already with the traveller`;
    case "negotiating":
      return `- quoted ${money(s)}, ${s.rounds} round${s.rounds === 1 ? "" : "s"} in${firm}`;
    case "quoted":
      return `- quoted ${money(s)}${firm}`;
    case "talking":
      return "- replying, but no price yet";
    default:
      return "- contacted, no reply yet";
  }
}

/** Cheapest live quote first; then live-unpriced; then the shops that are out. */
const RANK: Record<ShopStandingKind, number> = {
  presented: 0,
  negotiating: 1,
  quoted: 1,
  talking: 2,
  no_reply: 3,
  out_of_stock: 4,
  declined: 5,
};

export interface SessionBriefInput {
  rows: SessionShopRow[];
  /** The shop we are answering - never described to itself. */
  excludeVendorId?: string;
  maxLines?: number;
  maxChars?: number;
}

/**
 * The block, or "" when there is nothing worth saying.
 *
 * Empty on a hunt with no other shops, because a heading over no rows tells the
 * model nothing and still costs it attention.
 */
export function buildSessionBrief(input: SessionBriefInput): string {
  const maxLines = input.maxLines ?? BRIEF_MAX_LINES;
  const maxChars = input.maxChars ?? BRIEF_MAX_CHARS;
  const others = input.rows.filter(
    (r) => r.vendorId && !r.isThisShop && r.vendorId !== input.excludeVendorId
  );
  if (!others.length) return "";

  const standings = others.map(standingFor);
  const sorted = standings.slice().sort((a, b) => {
    if (RANK[a.kind] !== RANK[b.kind]) return RANK[a.kind] - RANK[b.kind];
    const ap = a.pricePerDay ?? Number.POSITIVE_INFINITY;
    const bp = b.pricePerDay ?? Number.POSITIVE_INFINITY;
    return ap - bp;
  });

  // The strategic shape, stated once so the model does not have to count rows.
  const isLive = (s: ShopStanding) => s.kind !== "declined" && s.kind !== "out_of_stock";
  const live = standings.filter(isLive).length;
  // Only a LIVE price counts as "quoted": a number from a shop that has since
  // said no is history, not an option, and the line for that shop says so.
  const withPrice = standings.filter(
    (s) => isLive(s) && typeof s.pricePerDay === "number"
  ).length;
  const out = standings.length - live;
  const headline =
    `OTHER SHOPS IN THIS SEARCH (${standings.length}; names withheld on purpose): ` +
    `${withPrice} have quoted, ${live - withPrice} still live without a price, ${out} out.`;
  // The one strategic fact worth spelling out, because it inverts the tactic.
  const lastOne =
    live === 0
      ? " EVERY other shop is out - this is the only shop left, so secure it warmly rather than squeezing it."
      : "";

  const lines: string[] = [];
  let used = headline.length + lastOne.length;
  let listed = 0;
  for (const s of sorted) {
    if (listed >= maxLines) break;
    const line = lineFor(s);
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    listed += 1;
  }
  const rest = sorted.length - listed;
  const tail = rest > 0 ? `\n- and ${rest} more` : "";
  return `${headline}${lastOne}\n${lines.join("\n")}${tail}\n`;
}
