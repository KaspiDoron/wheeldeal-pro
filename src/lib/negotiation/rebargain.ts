// THE SIBLING RE-BARGAIN - the swarm behaviour that was promised in a docstring
// and implemented nowhere.
//
// THE OWNER'S REPORT (5 #9): "some of the more expensive didn't get a message of
// 'I have a lower price of X, can you give me a better price?' ... We are not
// bargaining enough."
//
// THE MECHANISM THAT WAS MISSING. The rival card is only reachable on a turn
// that is HAPPENING - an inbound reply or a scheduled wakeup in that particular
// thread. So a shop that quoted 300 at 10:00 could only ever hear about the 200
// that landed at 10:20 if something re-entered ITS thread afterwards. Nothing
// did. `materialDrop` - "the session's lowest price just improved" - has been
// computed on every turn since the engine shipped, its docstring says the
// caller "enqueues bounded re-bargain wakeups for sibling threads", and its
// three consumers are a telemetry field, an admin chip and the distiller. The
// `propagateDelta` this file implements existed only in blueprint prose.
//
// So the expensive shops simply never heard the number. Not because a rule
// suppressed it - because no turn ever happened in which it could be said.
//
// WHY THIS IS A PURE PLANNER. The dangerous version of this feature is a fan-out
// that fires on every quote and turns twelve threads into a broadcast engine on
// the traveller's personal WhatsApp number. Every bound that stops that is a
// decision, and decisions belong somewhere they can be read in one screen and
// tested without a database. The caller does the IO; this decides who, and how
// many, and never how to phrase it.
//
// THE BOUNDS, each for a reason a live failure taught:
//   - only shops whose quote is MATERIALLY above the new low. Nudging a shop
//     that is 2% dearer spends a turn to win nothing;
//   - never the shop that just quoted (it IS the new low, and arguing with it
//     is the F5 "bargaining against our own floor" failure);
//   - never a shop that has said "last price" twice - the firm ladder is the
//     app's promise not to badger, and the swarm does not get an exemption;
//   - never a dead, closed or closing thread, and never a shop that has
//     WITHDRAWN (declined, or out of stock for these dates) - a decline
//     leaves the phase where it was, so the two facts are read directly;
//   - at most `MAX_FANOUT` shops per drop, dearest first - the shops with the
//     most to gain, and a hard ceiling on messages per event;
//   - one re-entry per drop, staggered, so wa-guard's per-recipient pacing is
//     not asked to absorb a burst it would only queue anyway.

import type { SessionShopRow } from "../graph/types";

/** Never more than this many shops re-entered on a single price drop. */
export const MAX_FANOUT = 4;
/** A quote must be at least this much above the new low to be worth re-opening. */
export const MATERIAL_GAP = 0.08;
/** The first sibling wakes this many minutes out... */
export const FIRST_DELAY_MIN = 2;
/** ...and each subsequent one this many minutes after the previous. Staggered
 *  so a drop never presents wa-guard with a simultaneous burst. */
export const STAGGER_MIN = 3;

const DEAD_PHASES = new Set(["dead", "closed", "closing"]);

export interface RebargainTarget {
  vendorId: string;
  vendorName: string;
  toNumber: string;
  /** What this shop is currently asking. */
  pricePerDay: number;
  /** Minutes from now this thread should re-enter. */
  delayMinutes: number;
}

export interface RebargainInput {
  /** The session as the blackboard read it. */
  rows: SessionShopRow[];
  /** The shop that just quoted - never its own re-bargain. */
  excludeVendorId: string;
  /** The new session low that triggered this. */
  newLowPerDay: number;
  /** The currency the session compares in; a cross-currency nudge is invented
   *  leverage, exactly as in session-rivals. */
  currency: string;
  /** Vendors already taken off the table. */
  excludeVendorIds?: Iterable<string>;
}

/**
 * Which sibling threads are worth re-entering, and when.
 *
 * Returns [] whenever the drop is not worth acting on, which is the common
 * case - a first quote in an empty session has no sibling to tell, and a shop
 * that shaved 2% off has not changed anyone's position.
 */
export function planSiblingRebargain(input: RebargainInput): RebargainTarget[] {
  const low = Number(input.newLowPerDay);
  if (!Number.isFinite(low) || low <= 0) return [];
  const barred = new Set(input.excludeVendorIds ?? []);
  barred.add(input.excludeVendorId);

  const candidates = input.rows
    .filter((r) => {
      if (!r.vendorId || barred.has(r.vendorId)) return false;
      if (r.isThisShop) return false;
      if (!r.toNumber) return false; // no live thread to re-enter
      if (r.phase && DEAD_PHASES.has(r.phase)) return false;
      // A SHOP THAT SAID NO IS NOT RE-ENTERED - and `phase` is not how it says
      // so. The bar above catches a thread the engine has WOUND UP; it does not
      // catch the shop that answers "sorry, we have stopped renting" or "no
      // bikes for those dates" and then goes quiet. Those write
      // `fields.declined` / `fields.shopUnavailable` - which sessionTable
      // carries onto every row - while the phase stays wherever the
      // negotiation had got to, because `derivePhase` never returns
      // dead/closed/closing for a decline. So the swarm scheduled a
      // rival-leverage re-entry into the thread of a shop that had explicitly
      // refused to rent. session-rivals applies exactly this rule, and the two
      // paths must not disagree about which shops are still in the hunt.
      if (r.declined === true || r.outOfStock === true) return false;
      // THE FIRM LADDER IS NOT WAIVED FOR THE SWARM. A shop that has said
      // "last price" twice has answered, and this app's whole promise is that
      // it stops asking. A cheaper rival is new information, but it is not a
      // licence to re-open a conversation the shop closed.
      if ((r.firmCount ?? 0) >= 2) return false;
      if (!r.currency || r.currency !== input.currency) return false;
      const price = r.pricePerDay;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return false;
      // Materially dearer, or there is nothing to say.
      return price > low * (1 + MATERIAL_GAP);
    })
    // Dearest first: the shops with the largest gap have the most room to move
    // and are the ones the traveller most wants pushed.
    .sort((a, b) => (b.pricePerDay ?? 0) - (a.pricePerDay ?? 0))
    .slice(0, MAX_FANOUT);

  return candidates.map((r, i) => ({
    vendorId: r.vendorId,
    vendorName: r.vendorName || r.vendorId,
    toNumber: r.toNumber!,
    pricePerDay: r.pricePerDay!,
    delayMinutes: FIRST_DELAY_MIN + i * STAGGER_MIN,
  }));
}
