import "server-only";

// THE CONSENTED BEHAVIOURAL RECORD - what the analytics cookie is actually FOR.
//
// A cookie banner that collects nothing is a compliance ornament. This is the
// other half: a small, bounded, first-party record of how the app is used,
// written only for people who said yes, into the table that erasure and export
// already walk.
//
// FOUR RULES, ALL ENFORCED HERE RATHER THAN TRUSTED TO CALLERS:
//
// 1. ONE TABLE, ALREADY REGISTERED. Rows go to `product_events`, which is in
//    privacy/user-tables.ts, so a DSAR export contains them and an erasure
//    deletes them without anybody remembering to add a case. A new analytics
//    table would have been a new way to outlive an erasure.
//
// 2. AN ALLOW-LIST OF EVENT NAMES, not a free-text field. The browser can post
//    anything; without a fixed vocabulary the table becomes whatever the
//    newest client happened to send, and the honest answer to "what do you
//    collect about me" stops being writable.
//
// 3. PROPS ARE SCALARS, BOUNDED, AND SCRUBBED. Depth 1, a handful of keys,
//    short strings. The one thing a web analytics beacon reliably leaks is
//    URLs with a search query or an id in them, so `path` is normalised
//    (query string dropped, numeric and hash-like segments masked) before it
//    is stored. What is collected is the SHAPE of the journey, never its
//    contents - and this is the module that makes that claim true.
//
// 4. THE EMAIL IS THE KEY, AND THE ANALYTICS ID IS JUST A COLUMN. `wd_aid`
//    stitches one visit together; it is never the identity. A row with no
//    email is not written at all - see collectEvents.

import { sbInsert } from "../runtime-config";

/**
 * Every event the browser may report, and nothing else.
 *
 * Keep this short. Each entry is a promise on the Cookie Policy page, and the
 * page is generated from this list, so an event added here without a purpose
 * worth writing down is an event that should not exist.
 */
export const ANALYTICS_EVENTS = {
  screen_view: "A screen was opened",
  search_started: "A search for nearby rental shops was started",
  search_results: "Search results were shown",
  outreach_started: "Agents were asked to contact shops",
  offer_opened: "A negotiated offer was opened",
  booking_opened: "The booking sheet was opened",
  upgrade_viewed: "The plan comparison was viewed",
} as const;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;

/** Most events a single page can honestly produce in one beacon. */
export const MAX_EVENTS_PER_BATCH = 20;
const MAX_PROP_KEYS = 8;
const MAX_STRING = 120;

export interface AnalyticsEventInput {
  name: string;
  at?: number;
  props?: Record<string, unknown>;
}

export function isAnalyticsEvent(name: unknown): name is AnalyticsEventName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(ANALYTICS_EVENTS, name);
}

/**
 * Strip a path down to its SHAPE.
 *
 * `/deals/7f3a-...?from=hotel&q=Kata%20Beach` becomes `/deals/:id`. The query
 * string goes entirely - it is where a search term, a hotel name or a booking
 * reference ends up, and none of those are things an analytics row should
 * carry. Numeric and id-shaped segments are masked for the same reason: a
 * booking id in an analytics table is a link back to a person's trip.
 */
export function normalizePath(raw: unknown): string {
  let path = String(raw ?? "").trim();
  if (!path) return "/";
  // Accept an absolute URL too - `location.href` is what a careless caller
  // reaches for first, and it carries the origin and the query with it.
  const q = path.search(/[?#]/);
  if (q >= 0) path = path.slice(0, q);
  path = path.replace(/^https?:\/\/[^/]+/i, "");
  if (!path.startsWith("/")) path = `/${path}`;
  const masked = path
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      // Anything long or digit-bearing is an identifier, not a route name.
      if (/^\d+$/.test(seg)) return ":id";
      if (seg.length > 24) return ":id";
      if (/[0-9a-f]{8}/i.test(seg)) return ":id";
      if (/%[0-9a-f]{2}/i.test(seg)) return ":id";
      return seg.slice(0, 32);
    })
    .join("/");
  return masked.slice(0, 120) || "/";
}

/**
 * Coerce client-supplied props into something safe to store: at most
 * MAX_PROP_KEYS scalar entries, strings truncated, nested objects dropped
 * rather than flattened (a nested object is how a whole session state ends up
 * in a column by accident).
 */
export function sanitizeProps(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_PROP_KEYS) break;
    if (!/^[a-z][a-z0-9_]{0,23}$/i.test(k)) continue;
    if (k === "path") {
      out.path = normalizePath(v);
      n++;
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
      n++;
    } else if (typeof v === "boolean") {
      out[k] = v;
      n++;
    } else if (typeof v === "string") {
      const s = v.trim().slice(0, MAX_STRING);
      if (s) {
        out[k] = s;
        n++;
      }
    }
    // Everything else - objects, arrays, null, functions - is dropped.
  }
  return out;
}

export interface CollectResult {
  /** Rows that passed validation and were offered to the store. */
  accepted: number;
  /** Rows refused as unknown event names. */
  rejected: number;
  /**
   * Did the insert actually land? `null` when there was nothing to write.
   * Reported honestly rather than assumed - a beacon that says "ok" over a
   * dead table is how an analytics surface reads zero for a week and nobody
   * can tell whether that is the truth or the plumbing.
   */
  stored: boolean | null;
}

/**
 * Write a validated batch. THE CONSENT CHECK IS NOT HERE - it belongs to the
 * route, which has the request context both gates need; this module refuses to
 * be the place where somebody could forget it, by requiring an email it can
 * only have been given after that check passed.
 */
export async function collectEvents(input: {
  email: string;
  analyticsId: string | null;
  events: AnalyticsEventInput[];
}): Promise<CollectResult> {
  const email = String(input.email ?? "").trim().toLowerCase();
  // No email, no row. An anonymous behavioural table would be a store this
  // product cannot honour an erasure request against, and "we cannot delete it
  // because we do not know it is yours" is not an answer worth building.
  if (!email) return { accepted: 0, rejected: 0, stored: null };

  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  let rejected = 0;
  for (const e of (input.events ?? []).slice(0, MAX_EVENTS_PER_BATCH)) {
    if (!isAnalyticsEvent(e?.name)) {
      rejected++;
      continue;
    }
    // A client clock can be wrong or hostile. Anything outside a day either
    // way is replaced with the server's clock rather than refused - the event
    // did happen, only its timestamp is untrustworthy.
    const at = Number(e.at);
    const when =
      Number.isFinite(at) && Math.abs(now - at) < 24 * 60 * 60 * 1000 ? at : now;
    rows.push({
      user_email: email,
      session_id: input.analyticsId ?? null,
      stage: e.name,
      kind: "web",
      props: { ...sanitizeProps(e.props), at: new Date(when).toISOString() },
    });
  }
  if (rows.length === 0) return { accepted: 0, rejected, stored: null };
  const stored = await sbInsert("product_events", rows).catch(() => false);
  return { accepted: rows.length, rejected, stored };
}
