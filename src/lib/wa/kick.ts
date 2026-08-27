// STARTING A DISPATCHER FROM INSIDE A REQUEST THAT IS ABOUT TO END.
//
// The reply lane is driven by an HTTP call the webhook makes to ourselves:
// inbound arrives -> ingest parks a reply -> ingest kicks /api/wa/reply-tick,
// which claims the sender and drains it within seconds. That kick was a bare
// `fetch(url).catch(() => {})` with nothing awaited and nothing after it.
//
// On Cloud Run (deployed here with the default CPU allocation, i.e. NOT
// --no-cpu-throttling) the container's CPU drops to ~0 the moment the response
// is flushed. An un-awaited fetch that has not yet finished its DNS/TCP/TLS
// handshake simply stops existing. The codebase already knows this - the
// activity route awaits its drain and says why, and tick/reply-tick both sleep
// 350ms before returning "to give the outgoing request a moment to actually
// leave this instance". The one call that starts the whole lane never got the
// same treatment, so in the field the fast lane frequently never ran at all
// and a reply waited for whatever poked the server next.
//
// Awaiting the FULL response is not the answer either: a dispatcher deliberately
// works in-process for up to ~45s, and Evolution's webhook must not be held
// open that long. What we actually need is for the request to LEAVE - after
// that the dispatcher runs in its own invocation with its own CPU allocation.
//
// So: start the call, then wait only long enough for it to be on the wire.

/** How long to stay in-request after firing a kick. Long enough for a local
 *  round trip to be established, short enough to be invisible to the caller. */
export const KICK_SETTLE_MS = 1200;

/**
 * Fire a self-directed dispatcher call and stay alive until it is genuinely
 * on the wire (or answered, whichever comes first).
 *
 * Never throws and never rejects: a failed kick must not fail the webhook that
 * made it - the message is already stored, and the drain has other triggers.
 */
export async function kickDispatcher(url: string, settleMs = KICK_SETTLE_MS): Promise<void> {
  let settled = false;
  // `cache: "no-store"` IS LOAD-BEARING (OR11 H2.3). Next 14 patches fetch to
  // cache GETs in its Data Cache by default, keyed on the URL. Every kick is a
  // GET to a fixed self URL (only the token/hop vary), so the SECOND kick of a
  // given shape could be answered from cache in microseconds - the dispatcher
  // never runs, and the reply lane silently stops firing until the next poll.
  // no-store forces the request onto the wire every time, which is the entire
  // point of a kick.
  const call = fetch(url, { cache: "no-store" })
    .then(() => {
      settled = true;
    })
    .catch(() => {
      settled = true;
    });
  // Whichever happens first: the dispatcher answers (it returns quickly when it
  // stands down, e.g. another runner holds the claim), or the settle window
  // expires with the request already sent and the dispatcher working.
  await Promise.race([call, new Promise<void>((r) => setTimeout(r, settleMs))]);
  // Keep the rejection handled even when the race was won by the timer.
  void settled;
}
