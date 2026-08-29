import "server-only";
import { sbSelect, sbSelectStrict } from "./runtime-config";
import { classifyIngest, DRILL_INGEST_WINDOW_MS, REAL_THREAD_INGEST_WINDOW_MS, type GateRaw } from "./wa/thread-gate";
import { numberFilter } from "./wa/phone-key";

export { DRILL_INGEST_WINDOW_MS, REAL_THREAD_INGEST_WINDOW_MS };

// The SINGLE ingestion-gate predicate for inbound WhatsApp, shared by the
// Evolution webhook AND the pull-based recovery sync (wa-sync). Having two
// copies is how the drill window got enforced on one path and silently
// skipped on the other - a drilled friend's PRIVATE chats kept being pulled
// in for hours after the drill ended.
//
// A number is an ingestible thread for a user ONLY when THAT user's agent
// opened a real rental-shop conversation with it (an RFQ/agent send), and only
// while that conversation is still ACTIVE. Three hard rules make this hermetic:
//   1. RFQ ANCHOR: "ever sent them anything" is NOT enough - a mistyped number,
//      a stray custom message or a human-manual reply must not turn a personal
//      contact into a permanent ingestion target. There must be an rfq/agent
//      outbound in the thread.
//   2. RECENCY: even a real shop thread retires - inbound stops being ingested
//      once the negotiation window lapses, so a number messaged weeks ago can
//      never quietly re-open ingestion.
//   3. DRILL/TEST WINDOW: the owner rehearsing against a friend's REAL number
//      (Live Drill, or an anti-spoof test re-key) ingests for a SHORT window
//      only; when the rehearsal is over, the friend's private messages stop
//      being ingested on EVERY path.

/**
 * true = an ingestible shop thread; false = NOT ours (drop, with trace);
 * null = the thread store is unreachable RIGHT NOW - the truth is UNKNOWN.
 * A transient DB error used to collapse to [] -> false, and the webhook's
 * 200 meant the provider never redelivered: a genuine shop reply was
 * permanently eaten by OUR OWN outage. Callers must treat null as
 * "retry later", never as "not a shop".
 */
export async function isVendorThread(
  fromDigits: string,
  ownerEmail: string
): Promise<boolean | null> {
  // Look at the recent outbound history of THIS user to THIS number (not just
  // the single newest row: a human-manual reply could be newest while the
  // thread's real RFQ anchor is a few messages back). The pure gate logic lives
  // in wa/thread-gate.ts (unit-tested).
  //
  // NUMBER MATCHING IS TOLERANT (numberFilter), and that is load-bearing. This
  // predicate used to be an exact `to_number=eq.<digits>` while every other
  // layer matched through phone-key - so a thread whose outbound anchor was
  // written from a Google NATIONAL number ("09661952196") was invisible to the
  // inbound INTERNATIONAL one ("639661952196"). The gate answered "not a shop
  // thread" and the shop's reply was dropped before it was ever stored: the
  // agent went quiet, the traveller saw a ghosting shop, and no offer existed.
  const res = await sbSelectStrict<{ received_at: string; raw: GateRaw | null }>(
    "whatsapp_messages",
    `select=received_at,raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      ownerEmail
    )}&order=received_at.desc&limit=10${numberFilter("to_number", fromDigits)}`
  );
  // "missing" (no table) can only mean a fresh deployment with no history -
  // honestly not a thread; "unavailable" is OUR outage - unknown, fail loud.
  if (!("rows" in res)) return res.error === "missing" ? false : null;
  const verdict = classifyIngest(res.rows, Date.now());
  if (verdict !== false) return verdict;

  // THE HANDOFF EXCEPTION - reached ONLY after the gate above has already said
  // no, and only ever able to turn that no into a yes.
  //
  // The rules above are correct and stay exactly as they are. They assume the
  // traveller's own agent spoke first, which is true on every path except one:
  // under the business-number handoff (plan Part 12) OUR official number asks
  // the agency to message the traveller, so the first message in that thread is
  // inbound from a number they have never written to. There is no RFQ anchor to
  // find, and there was never going to be.
  //
  // The authorisation is the lead row we wrote when we dispatched that handoff -
  // scoped to one (traveller, agency) pair, expiring, and only for leads we
  // actually sent. With WABA_ENABLED off it short-circuits before any read, so
  // this is a no-op on the live path today.
  //
  // Placed HERE, after the verdict, rather than inside the predicate: the
  // original gate keeps its semantics untouched and this stays separately
  // auditable. Do not merge them.
  const { wabaExpectsInbound } = await import("./waba/expectation");
  const expected = await wabaExpectsInbound(fromDigits, ownerEmail);
  // null = could not read. Mirror the gate's own contract: unknown is retryable,
  // never "not a shop" - a genuine handoff reply eaten by our own outage is a
  // permanent loss, because the webhook's 200 stops the provider redelivering.
  if (expected === null) return null;
  if (expected) {
    // THE HANDOFF JUST COMPLETED: the agency messaged the traveller, the
    // engine takes over from here. The ledger columns for exactly this moment
    // (traveller_inbound_at, handed_off_at) existed and NOTHING wrote them -
    // every lead sat in template_sent/handoff_sent forever, so the console
    // could never say the handoff worked and the hold-timeout sweep saw live
    // conversations as stalled. Stamped by (traveller, agency) pair with the
    // terminal refusal in the filter (the advanceLead doctrine); thread_key
    // joins the lead to the conversation the engine now owns. Best-effort with
    // a schema-graceful retry - the authorisation verdict is already made.
    try {
      const { sbUpdate } = await import("./runtime-config");
      const { nationalTail } = await import("./wa/phone-key");
      const tail = nationalTail(fromDigits);
      const email = ownerEmail.trim().toLowerCase();
      const digits = fromDigits.replace(/\D+/g, "");
      const nowIso = new Date().toISOString();
      const filter =
        `user_email=eq.${encodeURIComponent(email)}&agency_tail=eq.${encodeURIComponent(tail)}` +
        `&state=in.(template_sent,handoff_sent)&handed_off_at=is.null`;
      const full = await sbUpdate("waba_leads", filter, {
        state: "handed_off",
        handed_off_at: nowIso,
        traveller_inbound_at: nowIso,
        thread_key: `${email}:${digits}`,
      });
      if (!full) {
        await sbUpdate("waba_leads", filter, {
          state: "handed_off",
          handed_off_at: nowIso,
          traveller_inbound_at: nowIso,
        }).catch(() => false);
      }
    } catch {
      /* the stamp is ledger truth, never the gate */
    }
  }
  return expected ? true : false;
}
