import "server-only";

// THE TRAFFIC LOG WRITER. One function, and every column it writes has been
// forced through a closed vocabulary first.
//
// The rows come from a browser, over a route anyone can call. So nothing a
// caller sends is stored as sent: placement, market and category collapse to
// their vocabularies (an unknown value becomes the neutral bucket, never an
// echo), the session must be 8 hex characters, the partner must be one the
// owner configured, and the sub-id is REBUILT here from those parts rather than
// accepted. The only free text is `term`, and it has its own rule below.

import { sbInsert } from "@/lib/runtime-config";
import { PLACEMENTS, categoryOf, marketOf, placementOf } from "./subid";

export const TRAFFIC_EVENT_KINDS = ["unit_loaded", "unit_empty", "serp_view", "link_click"] as const;
export type TrafficEventKind = (typeof TRAFFIC_EVENT_KINDS)[number];

export interface TrafficEventInput {
  kind: unknown;
  placement: unknown;
  market: unknown;
  category: unknown;
  session: unknown;
  partner: unknown;
  term?: unknown;
  /** True only when the visitor arrived carrying Google's own click token. */
  termFromUnit?: boolean;
}

export interface TrafficEventRow {
  day: string;
  kind: TrafficEventKind;
  placement: string;
  market: string;
  category: string;
  partner: string;
  sub_id: string;
  session: string;
  term: string | null;
}

/**
 * Validate and shape a row, or explain the refusal.
 *
 * `term` IS STORED ONLY WHEN GOOGLE ISSUED IT. A `serp_view` that arrives with
 * Google's click token carries a term Google generated from a public article -
 * a fact about the page, not about the person. A query somebody TYPED into
 * /search is free text from a human and can be anything, including a name or a
 * phone number, so it is never stored - the row records that a search happened
 * and drops what it was.
 */
export function shapeTrafficEvent(
  input: TrafficEventInput,
  knownPartners: readonly string[],
  now: Date = new Date()
): { row: TrafficEventRow } | { refused: string } {
  const kind = String(input.kind ?? "");
  if (!(TRAFFIC_EVENT_KINDS as readonly string[]).includes(kind)) return { refused: "unknown kind" };
  const session = String(input.session ?? "");
  if (!/^[0-9a-f]{8}$/.test(session)) return { refused: "bad session" };
  const partner = String(input.partner ?? "");
  if (!knownPartners.includes(partner)) return { refused: "unknown partner" };

  const placement = placementOf(String(input.placement ?? ""));
  const market = marketOf(String(input.market ?? ""));
  const category = categoryOf(String(input.category ?? ""));

  let term: string | null = null;
  if (kind === "serp_view" && input.termFromUnit === true && typeof input.term === "string") {
    const cleaned = input.term.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    // An address or a long digit run is not a term Google generated from an
    // article about scooters, whatever token came with it.
    if (cleaned && cleaned.length <= 120 && !/@|\d{6,}/.test(cleaned)) term = cleaned;
  }

  return {
    row: {
      day: now.toISOString().slice(0, 10),
      kind: kind as TrafficEventKind,
      placement,
      market,
      category,
      partner,
      sub_id: `p${PLACEMENTS[placement].code}-m${market}-c${category}-${session}`,
      session,
      term,
    },
  };
}

export async function writeTrafficEvent(row: TrafficEventRow): Promise<boolean> {
  return sbInsert("traffic_events", [{ ...row }]).catch(() => false);
}
