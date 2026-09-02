// Multi-message inbound coalescing - the fix for the "dropped price" data loss.
//
// A rental shop frequently answers in a BURST of separate WhatsApp messages
// ("Good day!" / "We have available Fazzio" / "Regular rate is 550, we can give
// you 400 per day"), each arriving as its own webhook. Extracting from a single
// frame binds a bare price to no vehicle (matchesSpec=false -> the offer is
// dropped, the UI stays on "No price yet"). Coalescing the whole UNREAD inbound
// buffer (everything the shop sent since OUR last outbound) into one
// chronological blob lets a single extraction see the vehicle AND its price.
//
// Pure + unit-tested: shared by the live ingestion path (agent-loop) and the
// strategic-wait tick path (engine) so both behave identically.

export interface CoalesceMsg {
  direction: "inbound" | "outbound";
  body: string | null;
  received_at: string; // ISO
}

/**
 * Concatenate the shop's unread inbound messages (strictly AFTER our last
 * outbound) chronologically. `currentText` is appended when the just-arrived
 * message's row is not yet visible to the read (concurrent webhooks). Capped to
 * the last few frames and a char budget so a chatty shop cannot inflate the
 * extraction prompt.
 */
// A pure media placeholder ("[photo]", "[voice note]") or the synthetic
// "(the shop sent a photo... couldn't be loaded)" carries no extractable text
// and must not crowd out real frames or bypass the crafted photo fallback.
const PLACEHOLDER = /^\[[^\]]{0,20}\]$|^\(the shop sent\b/i;

/**
 * IS THIS TEXT SOMETHING THE SHOP SAID, OR SOMETHING WE WROTE FOR THEM?
 *
 * Exported because the coalescer is no longer the only consumer, and a SECOND
 * copy of this judgement is what broke the never-silent photo fallback.
 *
 * The incident: ingest stamps `syntheticText = "[image]"` on every captionless
 * photo so the frame is never nothing. The fallback that fires when a photo's
 * bytes could not be downloaded was guarded on `!syntheticText` - "the shop
 * gave us no words to work with" - and that guard became false BY
 * CONSTRUCTION the moment the placeholder was stamped: a photo we could not
 * read produced no clarify, no reading, and a panel with nothing in it.
 *
 * "The shop said nothing" and "the body is empty" are different questions.
 * This answers the first one, in one place, for everybody who asks it.
 */
export function isMediaPlaceholder(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return t.length === 0 || PLACEHOLDER.test(t);
}

/** One inbound frame, with the two flags the provenance question needs. */
export interface ProvenanceMsg extends CoalesceMsg {
  /** `raw.forwarded` - the shop passed this on, it did not write it. */
  forwarded?: boolean;
  /** The frame carries media whose reading could produce a price. */
  hasMedia?: boolean;
}

/** A digit in any of the scripts the app reads (integrity/translation folds
 *  these on every other path; here we only need "is there a number at all"). */
const ANY_DIGIT = /[\d\u0660-\u0669\u06f0-\u06f9\u0966-\u096f\u0e50-\u0e59\u0ed0-\u0ed9\u17e0-\u17e9\u1040-\u1049]/;

/**
 * IS EVERY NUMBER IN THIS BURST SOMEBODY ELSE'S?
 *
 * A shop forwarding a competitor's price board - or a supplier's rate card -
 * is not quoting us. Nothing in this codebase read `contextInfo.isForwarded`,
 * so that board was extracted as the shop's OWN posted price, banked as an
 * `offers` row, and could then be cited at a third shop as this one's quote:
 * a number presented as one shop's when it is another's, which is the exact
 * class the ungrounded-price rail exists to prevent.
 *
 * Deliberately CONSERVATIVE, because the cost of a false positive is losing a
 * real offer. It answers true only when the window contains forwarded content
 * AND no unforwarded frame could have carried a price - no digits in the text
 * the shop typed itself, and no media of its own for the reader to price. So
 * the ordinary "here you go" + forwarded board still banks nothing (the shop's
 * own frame has no number), while "our rate is 300" + a forwarded board banks
 * the 300, because the shop did state a price itself.
 */
export function onlyForwardedContent(
  thread: ProvenanceMsg[],
  lastOutboundAt: string
): boolean {
  const unread = thread.filter(
    (m) => m.direction === "inbound" && (!lastOutboundAt || m.received_at > lastOutboundAt)
  );
  if (!unread.length) return false;
  if (!unread.some((m) => m.forwarded === true)) return false;
  return !unread.some(
    (m) =>
      m.forwarded !== true &&
      (m.hasMedia === true || ANY_DIGIT.test(String(m.body ?? "")))
  );
}

export function coalesceUnreadInbound(
  thread: CoalesceMsg[],
  lastOutboundAt: string,
  currentText?: string,
  opts: { maxFrames?: number; maxChars?: number } = {}
): string {
  const maxFrames = opts.maxFrames ?? 8;
  const maxChars = opts.maxChars ?? 1600;
  let unread = thread
    .filter(
      (m) => m.direction === "inbound" && (!lastOutboundAt || m.received_at > lastOutboundAt)
    )
    .map((m) => (m.body ?? "").trim())
    .filter((b) => !isMediaPlaceholder(b));
  const cur = (currentText ?? "").trim();
  if (!isMediaPlaceholder(cur) && !unread.includes(cur)) unread.push(cur);
  // Cap by frame count keeping the OLDEST frame (it usually names the vehicle -
  // "We have available Fazzio") PLUS the newest frames (they usually carry the
  // price). Dropping the oldest would re-create the exact matchesSpec=false drop
  // this exists to fix.
  if (unread.length > maxFrames) {
    unread = [unread[0], ...unread.slice(-(maxFrames - 1))];
  }
  let out = unread.join("\n");
  if (out.length > maxChars && unread.length > 0) {
    // Preserve the leading frame (vehicle) whole, then as much of the tail
    // (price) as the budget allows.
    const first = unread[0];
    const rest = unread.slice(1).join("\n");
    const budget = Math.max(0, maxChars - first.length - 2);
    out = budget > 0 ? `${first}\n${rest.slice(-budget)}` : first.slice(0, maxChars);
  }
  return out;
}
