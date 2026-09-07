"use client";

// THE ONE RULE FOR "DID THAT WRITE LAND?" (audit F017).
//
// The takeover switches used to read:
//
//   const d = await res.json();
//   if (d.ok !== undefined) setTakeover(mode === "takeover");
//
// which is the opposite of the honest-writes rule. /api/thread/takeover answers
// HTTP 200 `{ ok, takeover: mode }` where `ok` is setThreadTakeover's own
// boolean - false whenever the marker insert did not land (a 5xx, the 8s
// timeout, a pre-migration 400). `d.ok !== undefined` is TRUE for `{ok:false}`,
// so the panel switched to "You have the wheel - Will stays silent on this
// chat" over a thread that holds no marker row. The server's 30s in-process
// cache even agreed for half a minute; after it expired - or immediately on a
// second Cloud Run instance - isThreadTakenOver found nothing and the agent
// answered the shop in a thread the traveller had been told was hers.
//
// An acknowledgement is a 2xx response whose body says `ok: true`. Nothing
// else. Pure and exported on its own so it can be executed by a test - there is
// no React harness in this repo, and this is the part that has to be right.

/**
 * True only when the server CONFIRMED a durable write.
 *
 * @param resOk the HTTP response's `ok` (2xx). A 401/404/5xx is never success.
 * @param body  the parsed JSON body, whatever shape arrived (or `{}`).
 */
export function writeAck(resOk: boolean, body: unknown): boolean {
  if (!resOk) return false;
  const b = (body ?? {}) as { ok?: unknown };
  return b.ok === true;
}
