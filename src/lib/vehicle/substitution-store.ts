import "server-only";
import type { AlternativeOffer } from "./substitution";

// WHERE A PENDING SUBSTITUTION CHOICE LIVES.
//
// On the thread's own `fields` blob, beside every other durable thread fact,
// because that is what the engine already reads on every turn through
// loadState - so a paused thread stays paused for the inbound reply, the
// scheduled wakeup and a user action alike, with no fourth place to keep in
// sync and no migration.
//
// Every write here is a read-modify-write on one JSONB key. The reads are
// immediate and the writes touch a single field, which is the same discipline
// the accessory verdicts use for the same reason.

interface ThreadRow {
  thread_key: string;
  fields: (Record<string, unknown> & { alternativeOffer?: AlternativeOffer | null }) | null;
}

// THE COLUMN THIS ASKED FOR HAS NEVER EXISTED.
//
// `negotiation_threads` is keyed by `thread_key` (schema.sql: "thread_key text
// primary key") - there is no `id`. PostgREST answers `select=id` on such a
// table with 400/42703, sbSelect collapses every failure to [], so this
// returned null on EVERY call since it was written: persistAlternativeOffer has
// never stored a single offer, and resolveAlternativeOffer has never found one.
//
// That was the first of TWO breaks in "M12 is BROKEN". The second sat one hop
// downstream: /api/replies returned `alternativeOffer`, but the page merge
// skipped every row without a price and its offer literal never listed the
// field - so even a stored offer could not reach the card. Both are fixed:
// the column here, and the facts pass + literal in the page merge (see
// lib/client/reply-facts.ts, which carries the choice through price or no
// price). If this feature ever goes quiet again, check BOTH hops.
//
// sbSelectStrict, not sbSelect: turning a schema error into "no such thread" is
// what let this survive a full audit round.
async function loadThread(
  email: string,
  vendorId: string
): Promise<{ row: ThreadRow | null } | { error: "missing" | "unavailable" }> {
  const { sbSelectStrict } = await import("../runtime-config");
  const read = await sbSelectStrict<ThreadRow>(
    "negotiation_threads",
    `select=thread_key,fields&user_email=eq.${encodeURIComponent(
      email
    )}&vendor_id=eq.${encodeURIComponent(vendorId)}&order=updated_at.desc&limit=1`
  );
  if ("error" in read) return read;
  return { row: read.rows[0] ?? null };
}

const byKey = (threadKey: string) => `thread_key=eq.${encodeURIComponent(threadKey)}`;

/** Park a choice for the traveller. Never overwrites one they have not seen. */
export async function persistAlternativeOffer(args: {
  email: string;
  vendorId: string;
  threadKey?: string;
  offer: AlternativeOffer;
}): Promise<boolean> {
  try {
    const found = await loadThread(args.email, args.vendorId);
    // Unreadable is NOT "no thread". Returning false there is correct - we did
    // not park the offer - but it must not be mistaken for "already asked".
    if ("error" in found) return false;
    const row = found.row;
    if (!row) return false;
    // ASK ONCE. A shop that repeats itself, or a webhook redelivery, must not
    // replace a choice the traveller is already looking at - the price on the
    // card would change under their thumb.
    if (row.fields?.alternativeOffer) return false;
    const { sbUpdate } = await import("../runtime-config");
    await sbUpdate("negotiation_threads", byKey(row.thread_key), {
      fields: { ...(row.fields ?? {}), alternativeOffer: args.offer },
    });
    return true;
  } catch {
    return false;
  }
}

/** The traveller decided. Clear the pause either way. */
export async function resolveAlternativeOffer(args: {
  email: string;
  vendorId: string;
  accept: boolean;
}): Promise<{ ok: boolean; offer: AlternativeOffer | null }> {
  try {
    const found = await loadThread(args.email, args.vendorId);
    if ("error" in found) return { ok: false, offer: null };
    const row = found.row;
    const offer = row?.fields?.alternativeOffer ?? null;
    if (!row || !offer) return { ok: false, offer: null };
    const { sbUpdate } = await import("../runtime-config");
    const next: Record<string, unknown> = { ...(row.fields ?? {}), alternativeOffer: null };
    if (args.accept) {
      // ACCEPTING RETARGETS THE THREAD, it does not disable the gate. The
      // vehicle the traveller agreed to becomes the one this thread is about,
      // so a THIRD substitution is caught exactly the same way.
      if (typeof offer.engineSizeCc === "number" && offer.engineSizeCc > 0) {
        next.acceptedVehicleCc = offer.engineSizeCc;
      }
      next.acceptedVehicle = offer.vehicle;
      // The identity gate reads this: the traveller settled the vehicle
      // question themselves, which is stronger evidence than any message.
      next.vehicleConfirmation = { status: "confirmed", evidence: `traveller accepted ${offer.vehicle}` };
    } else {
      // DECLINED IS A DECLINE. The thread returns to the state it would have
      // been in without the choice - closed - rather than sitting open on a
      // vehicle nobody wants.
      next.declined = true;
    }
    await sbUpdate("negotiation_threads", byKey(row.thread_key), { fields: next });
    return { ok: true, offer };
  } catch {
    return { ok: false, offer: null };
  }
}
