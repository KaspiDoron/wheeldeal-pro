import { rankHostsForNumber, type RegionalHost } from "./host-region";

// WHICH EVOLUTION HOST A USER'S SESSION BELONGS ON - the decision, without the IO.
//
// Extracted from `resolveHost` (evolution.ts), which needs Supabase, the key
// vault and live health probes to reach. That placement had a measurable cost:
// this decision has produced THREE separate defects, and every test written
// about it was a regex over the source, so none of them could have caught any
// of the three.
//
//   1. `if (hosts.length === 1) return hosts[0];` sat above every check, so the
//      capacity refusal never ran on a single-host deployment - the exact
//      arrangement it was written for.
//   2. `underCap.length ? underCap : pickFrom` placed the user anyway once
//      every host was full, which is the moment a cap exists for.
//   3. The single-host branch exempted an already-placed user and the
//      multi-host branch did not, so one transient probe failure on a full
//      fleet returned null for a LINKED user - on the send path.
//
// All three are shape errors in a decision tree. They are cheap to see when the
// tree is a pure function and invisible when it is spread through a closure.

/**
 * WHICH HOST TO TALK TO A USER ON, when we are not placing them.
 *
 * THE PEER OF `placeHost`, AND THE REASON THE CAP IS SAFE. `placeHost` answers
 * "may this user JOIN the fleet" and returns null for a real capacity refusal.
 * That null is catastrophic on any other question: `resolveHost` fronts
 * `evo()`, which fronts fifteen endpoints - sending, media download,
 * connection state, mark-read - and a null there surfaces as
 * `{ok:false, status:0}`, which the send path deliberately treats as an
 * AMBIGUOUS transport failure. So a capacity refusal on a serve call is not a
 * refusal, it is a fleet-wide outage wearing the costume of a network blip.
 *
 * Hence: capacity governs who JOINS, never who may be spoken to. This function
 * always returns a host when one is configured. It is pure and lives beside the
 * placement rule for the same reason that one was extracted - a decision tree
 * inside a closure that needs Supabase, the key vault and live health probes is
 * a decision tree nothing can test, and this file's header already records
 * three defects that shape produced.
 */
export function serveHost<H extends RegionalHost = RegionalHost>(input: {
  hosts: H[];
  /** The host this user is already on, from wa_sessions - the best answer. */
  stored?: string | null;
  /** Paired users per host url, for the least-loaded fallback. */
  counts: Record<string, number>;
}): H | null {
  const { hosts, stored, counts } = input;
  if (hosts.length === 0) return null;
  // The stored host is the truth whenever we have it: it is where this user's
  // socket and device registration actually are, cap and health irrelevant.
  if (stored) {
    const own = hosts.find((h) => h.url === stored);
    if (own) return own;
  }
  // One host is the only answer that can be right.
  if (hosts.length === 1) return hosts[0];
  // Otherwise the least-loaded, which is where a new session would have gone.
  return [...hosts].sort((a, b) => (counts[a.url] ?? 0) - (counts[b.url] ?? 0))[0] ?? null;
}

export interface PlacementInput<H extends RegionalHost = RegionalHost> {
  /** Every configured host, in EVOLUTION_HOSTS order. */
  hosts: H[];
  /** The host this user is already on, from wa_sessions. */
  stored?: string | null;
  /** Paired users per host url. */
  counts: Record<string, number>;
  /** EVOLUTION_MAX_PER_HOST. */
  cap: number;
  /**
   * Hosts that answered their health probe. Undefined means "not probed",
   * which is the single-host case - there is nothing to fail over to.
   */
  healthy?: H[];
  /** The number being linked, when known. Drives geographic affinity. */
  digits?: string;
  /** Owner/sticky preference score, higher first. Optional. */
  pref?: (h: H) => number;
}

/**
 * The placement, or null for "at capacity" - which the caller must report as
 * capacity rather than as a missing configuration.
 */
export function placeHost<H extends RegionalHost>(input: PlacementInput<H>): H | null {
  const { hosts, stored, counts, cap } = input;
  if (hosts.length === 0) return null;

  // AN OCCUPANT IS NOT AN APPLICANT. The cap governs PLACEMENT; someone already
  // on a host consumes no new slot and creates no new device registration, so
  // refusing them protects nothing and costs them their hunt.
  if (hosts.length === 1) {
    if (stored === hosts[0].url) return hosts[0];
    return (counts[hosts[0].url] ?? 0) < cap ? hosts[0] : null;
  }

  const healthy = input.healthy ?? hosts;
  // Keep the user on their existing host while it is healthy.
  if (stored) {
    const h = healthy.find((x) => x.url === stored);
    if (h) return h;
  }

  const pickFrom = healthy.length ? healthy : hosts;
  const underCap = pickFrom.filter((h) => (counts[h.url] ?? 0) < cap);
  if (!underCap.length) {
    // The same exemption as the single-host branch. Its absence here was a real
    // eviction: a stored user is kept above only while their host passes the
    // probe, so one transient failure on a full fleet sent a LINKED user down
    // this path and returned null for every send they had queued.
    return (stored ? hosts.find((h) => h.url === stored) : undefined) ?? null;
  }

  // GEO FIRST, THEN LOAD. With no declared regions anywhere every host is
  // neutral and the ranking IS the old least-loaded ordering, term for term.
  return (
    rankHostsForNumber(underCap, input.digits ?? "", (h) => counts[h.url] ?? 0, input.pref)[0] ??
    null
  );
}
