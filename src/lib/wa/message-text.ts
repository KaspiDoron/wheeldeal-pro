// ONE READER FOR WHAT A WHATSAPP MESSAGE SAYS.
//
// THERE WERE TWO, AND THE LIVE PATH USED THE WEAKER ONE.
//
// `waMessageText` (this file, formerly private to evolution.ts) is the complete
// extractor: it peels every envelope WhatsApp wraps a payload in and reads
// every text-bearing subtype. It was wired ONLY to `fetchMessages` /
// `fetchMessagesRaw` - the wa-sync recovery sweep.
//
// The LIVE webhook path - `processEvolutionWebhook`, shared verbatim by the
// Next route and the BullMQ incoming worker, i.e. the code that handles every
// real shop reply as it arrives - had its own private `unwrap` + `extractText`
// that knew eight frame shapes and one envelope.
//
// So the recovery sweep could read a message the live path had already thrown
// away. A shop sent a sticker ("I'M SORRY", with "sorry tomorrow we closed and
// open again on 20th" beside it) and the agent saw nothing. Reactions, button
// and list replies, template replies, view-once media and edited messages were
// all silently dropped the same way.
//
// Both paths now share this file. The rule is: a message that arrived is never
// nothing. If we cannot read words, we say what kind of thing it was, so the
// agent knows a turn happened and the transcript is honest.

/** Every wrapper WhatsApp can nest a real payload inside. */
function innerEnvelope(message: Record<string, any>): Record<string, any> | null {
  return (
    message.ephemeralMessage?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2?.message ??
    message.viewOnceMessageV2Extension?.message ??
    message.editedMessage?.message?.protocolMessage?.editedMessage ??
    message.documentWithCaptionMessage?.message ??
    // A MESSAGE THE SHOP SENT FROM ANOTHER DEVICE IS STILL THE SHOP TALKING.
    //
    // WhatsApp wraps a message composed on a linked companion device in
    // `deviceSentMessage`, and this list never peeled it - so every detector
    // downstream (`hasImageMessage`, the text branches, `waMediaKind`) saw an
    // envelope with no known subtype inside and the turn was read as empty. A
    // shop owner replying from their laptop was invisible.
    message.deviceSentMessage?.message ??
    null
  );
}

/**
 * A frame we could LABEL but not decode - "[photo]", "[location]" and friends.
 *
 * Exported because two callers need to tell "the shop wrote words" apart from
 * "we know something arrived": `wa/ingest` builds richer text for a location
 * pin, a contact card and a document ONLY when there is no real caption, and
 * `wa/coalesce` must not spend a reply on a turn whose whole content is a
 * bracket label. Both were testing the string for emptiness, and this function
 * never returns empty - that is its entire point - so both were dead.
 */
export const WA_PLACEHOLDER_RX =
  /^\[(photo|video|video note|voice note|document|sticker|location|live location|album|contact|poll|order|catalog)\]$/i;

export function waPlaceholderOnly(text: string | null | undefined): boolean {
  return WA_PLACEHOLDER_RX.test(String(text ?? "").trim());
}

/**
 * WAS THIS FORWARDED FROM SOMEONE ELSE?
 *
 * `contextInfo.isForwarded` appeared ZERO times in this codebase, and the
 * consequence is a number-integrity failure of the same class as the
 * ungrounded-price rail: a shop that FORWARDS a competitor's price board is
 * read as having posted that price itself, and it can then enter the rival
 * table as leverage - a price presented as one shop's when it is another's.
 *
 * `forwardingScore >= 5` is WhatsApp's own "forwarded many times" threshold;
 * either signal means the content did not originate with this shop.
 */
export function waForwarded(message: any): { forwarded: boolean; score: number } {
  const m = waUnwrap(message);
  let forwarded = false;
  let score = 0;
  for (const node of Object.values(m ?? {})) {
    const ctx = (node as { contextInfo?: { isForwarded?: boolean; forwardingScore?: number } } | null)
      ?.contextInfo;
    if (!ctx) continue;
    if (ctx.isForwarded === true) forwarded = true;
    const n = Number(ctx.forwardingScore);
    if (Number.isFinite(n) && n > score) score = n;
  }
  return { forwarded: forwarded || score > 0, score };
}

/**
 * Peel every envelope and return the payload that actually carries the content.
 *
 * The live path's old `unwrap` peeled ONLY `ephemeralMessage`, and it fed every
 * media detector - so a view-once photo or an edited message was not merely
 * unreadable, it was undetectable: `hasImageMessage` said false and the vision
 * job never ran.
 */
export function waUnwrap(data: any): Record<string, any> {
  let node: Record<string, any> = data?.message ?? data ?? {};
  // Bounded: WhatsApp nests a handful deep at most, and an unbounded loop on
  // attacker-shaped input is not a risk worth taking.
  for (let i = 0; i < 6; i += 1) {
    const inner = innerEnvelope(node);
    if (!inner) break;
    node = inner;
  }
  return node ?? {};
}

/** A WhatsApp Business catalog/product card, decoded from the payload. */
export interface WaProductCard {
  title: string;
  description: string | null;
  /** ISO currency code the shop's catalog uses (e.g. "THB"), when present. */
  currency: string | null;
  /** Price in MAJOR units - Baileys ships priceAmount1000 (thousandths). */
  price: number | null;
  retailerId: string | null;
}

/**
 * The structured product card inside a `productMessage`, or null.
 *
 * THE FIELD CASE (owner report 6): a Krabi shop answered "which bikes do you
 * have?" with three catalog cards - "Yamaha Fazzio Hybrid 125cc, THB 350.00"
 * among them - and every card reached the app as an EMPTY row: no text branch
 * knew the subtype, so the transcript showed five blank bubbles and the agent
 * asked "do you have a 125cc?" AFTER the 125cc card had arrived. The payload
 * is fully structured (title/description/currencyCode/priceAmount1000), so
 * decoding it is payload STRUCTURE, not meaning - doctrine-clean deterministic
 * code. What the numbers MEAN for the negotiation stays with the model.
 */
export function waProductCard(message: any): WaProductCard | null {
  const m = waUnwrap(message);
  const p = m.productMessage?.product;
  if (!p || typeof p !== "object") return null;
  const price1000 = Number(p.priceAmount1000);
  return {
    title: String(p.title ?? "").trim() || "(untitled product)",
    description: String(p.description ?? "").trim() || null,
    currency: p.currencyCode ? String(p.currencyCode).toUpperCase() : null,
    price: Number.isFinite(price1000) && price1000 > 0 ? price1000 / 1000 : null,
    retailerId: p.retailerId != null ? String(p.retailerId) : null,
  };
}

/** Compact money rendering for transcriptions: 350, not 350.000000. */
function productMoney(price: number): string {
  return Number.isInteger(price) ? String(price) : String(Math.round(price * 100) / 100);
}

/** The one-line structural transcription of a product card. */
export function waProductLine(card: WaProductCard): string {
  const price =
    card.price != null
      ? ` - ${card.currency ? `${card.currency} ` : ""}${productMoney(card.price)}`
      : "";
  const desc = card.description ? ` (${card.description.slice(0, 140)})` : "";
  return `[product card] ${card.title}${price}${desc}`;
}

/**
 * What an inbound message QUOTED, when it replied to an earlier message.
 *
 * Nothing in the codebase read contextInfo.quotedMessage (only lid-alias reads
 * contextInfo.participant for identity), so "^ This one is 125 cc" reached the
 * engine with no referent at all. The quoted payload runs through the same
 * extractor recursively - which also covers quoted product cards.
 */
export function waQuotedText(message: any): string | null {
  const m = waUnwrap(message);
  for (const key of Object.keys(m)) {
    const sub = (m as Record<string, any>)[key];
    const quoted = sub?.contextInfo?.quotedMessage;
    if (quoted && typeof quoted === "object") {
      const t = waMessageText({ message: quoted }).trim();
      return t ? t.slice(0, 300) : null;
    }
  }
  return null;
}

/**
 * Readable text for ANY Evolution/Baileys message, or a short placeholder for
 * media that carries no caption.
 *
 * A placeholder is deliberate, not a fallback: a photo-heavy price chat is a
 * real conversation, and a sticker is a real turn even though it has no words.
 */
export function waMessageText(message: any): string {
  if (!message || typeof message !== "object") return "";
  const m = waUnwrap(message);

  // Structured commerce frames first - they carry real content, not captions.
  const card = waProductCard(message);
  if (card) return waProductLine(card);
  if (m.orderMessage) {
    const o = m.orderMessage;
    const count = Number(o.itemCount) > 0 ? `${o.itemCount} item${Number(o.itemCount) === 1 ? "" : "s"}` : "items";
    const total1000 = Number(o.totalAmount1000);
    const total =
      Number.isFinite(total1000) && total1000 > 0
        ? ` - ${o.totalCurrencyCode ? `${String(o.totalCurrencyCode).toUpperCase()} ` : ""}${productMoney(total1000 / 1000)} total`
        : "";
    return `[order] ${count}${total}`;
  }

  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    // Interactive replies. A shop tapping a button is answering us; treating
    // that as silence is how a thread looked abandoned when it was not.
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.templateButtonReplyMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    m.reactionMessage?.text ??
    // Outbound-style interactive frames a business account can SEND us:
    // list menus, button prompts, template bodies, native-flow cards.
    m.interactiveMessage?.body?.text ??
    m.interactiveMessage?.header?.title ??
    m.templateMessage?.hydratedTemplate?.hydratedContentText ??
    m.templateMessage?.hydratedFourRowTemplate?.hydratedContentText ??
    m.listMessage?.description ??
    m.listMessage?.title ??
    m.buttonsMessage?.contentText ??
    // A SHOP TAPPING A BUTTON IN ITS OWN BUSINESS FLOW IS ANSWERING US.
    //
    // `interactiveResponseMessage` / `nativeFlowResponseMessage` is what a
    // WhatsApp Business flow reply arrives as - a shop selecting "125cc - 300"
    // from its own menu - and nothing in this file knew the subtype, so the
    // reply was read as silence and the thread looked abandoned while the shop
    // had just quoted us. Same class as the button/list replies above, which
    // this file already fixed once.
    m.interactiveResponseMessage?.body?.text ??
    nativeFlowText(m.interactiveResponseMessage?.nativeFlowResponseMessage) ??
    "";
  if (String(text).trim()) return String(text);

  // A POLL IS A PRICE QUESTION IN DISGUISE ("which do you want: 125cc 300 /
  // 150cc 400"). `waMediaKind` has labelled polls since it shipped and no text
  // branch ever decoded one, so the turn carried the bare "[poll]" label - and
  // `wa/coalesce` strips bare labels, so it carried NOTHING. The name and the
  // options are plain structured fields.
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
  if (poll) {
    const name = String(poll.name ?? "").trim();
    const opts = Array.isArray(poll.options)
      ? poll.options
          .map((o: { optionName?: string }) => String(o?.optionName ?? "").trim())
          .filter(Boolean)
      : [];
    if (name || opts.length) {
      return `[poll] ${name}${opts.length ? `: ${opts.join(" / ")}` : ""}`.trim();
    }
  }

  if (m.imageMessage) return "[photo]";
  if (m.videoMessage) return "[video]";
  // A round video note is a video. It arrives as its own subtype and was
  // matched by nothing here, so the turn was read as empty.
  if (m.ptvMessage) return "[video note]";
  if (m.audioMessage) return "[voice note]";
  if (m.documentMessage) return "[document]";
  if (m.stickerMessage) return "[sticker]";
  if (m.locationMessage) return "[location]";
  // A live location is a shop saying "I am on my way with the bike" - the one
  // frame where a pin is time-sensitive - and it matched nothing.
  if (m.liveLocationMessage) return "[live location]";
  if (m.albumMessage) return "[album]";
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) return "[poll]";
  if (m.contactMessage || m.contactsArrayMessage) return "[contact]";
  return "";
}

/**
 * The text a WhatsApp Business native-flow reply carries.
 *
 * `paramsJson` is a JSON string the flow itself defines, so this reads the two
 * shapes Baileys actually ships and refuses to guess beyond them. A malformed
 * blob returns null rather than throwing: an undecodable reply still gets the
 * "[interactive]" label from `waMediaKind`, which is honest, where a throw
 * would lose the whole turn.
 */
function nativeFlowText(nf: unknown): string | null {
  const node = nf as { name?: string; paramsJson?: string } | null | undefined;
  const raw = String(node?.paramsJson ?? "").trim();
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const parts = [p.title, p.description, p.selectedDisplayText, p.body, p.id]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    return parts.length ? parts.join(" - ") : null;
  } catch {
    return null;
  }
}

/**
 * The frame kind, for traces and for the "we saw something we cannot read"
 * path. Returns null when the payload is a plain text message.
 */
export function waMediaKind(message: any): string | null {
  const m = waUnwrap(message);
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  if (m.locationMessage) return "location";
  if (m.contactMessage || m.contactsArrayMessage) return "contact";
  if (m.reactionMessage) return "reaction";
  if (
    m.pollCreationMessage ||
    m.pollCreationMessageV2 ||
    m.pollCreationMessageV3 ||
    m.pollUpdateMessage
  ) {
    // Only the UNVERSIONED key matched, and WhatsApp has been shipping V2/V3
    // for years - so a poll from a modern client was an unknown frame.
    return "poll";
  }
  if (m.ptvMessage) return "ptv";
  if (m.liveLocationMessage) return "location";
  if (m.albumMessage) return "album";
  // Commerce/interactive frames: real turns, previously invisible (dropped as
  // "empty-media" with an empty stored row - the blank-bubble bug).
  if (m.productMessage) return "product";
  if (m.orderMessage) return "order";
  if (m.catalogMessage) return "catalog";
  if (
    m.interactiveMessage ||
    m.templateMessage ||
    m.listMessage ||
    m.buttonsMessage ||
    m.interactiveResponseMessage
  ) {
    return "interactive";
  }
  return null;
}
