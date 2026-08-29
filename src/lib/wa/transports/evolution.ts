// THE EVOLUTION TRANSPORT ADAPTER - the traveller's own linked WhatsApp,
// wrapped VERBATIM behind the Transport contract.
//
// Zero wire-behaviour change is the whole design: every anti-ban mechanic
// (presence mimicry, Poisson jitter, the three-tier send budgets, fingerprint)
// lives INSIDE sendFromUser and stays there - the adapter delegates, it never
// re-implements. What the adapter adds is a NAME and a capabilities record,
// so the engine and the guard can hold a `Transport` without importing
// Evolution, and a second transport (the company-number WABA lane) can
// register without touching either.

import type { SendOpts, SendResult, Transport, TransportCapabilities } from "../transport";

export const EVOLUTION_CAPABILITIES: TransportCapabilities = {
  presence: true, // typing/paused mimicry, baked into sendText's own path
  readReceipts: true,
  coldFirstContact: true, // the traveller's own number may open a chat (budgeted)
  serviceWindowHours: null, // no Meta service window on a personal number
  media: true,
  historyFetch: true, // wa-sync recovery sweep
  identity: "per-traveller",
};

export const evolutionTransport: Transport = {
  kind: "evolution",
  capabilities: EVOLUTION_CAPABILITIES,

  async sendText(senderKey, to, text, opts?: SendOpts): Promise<SendResult> {
    const { sendFromUser } = await import("../../evolution");
    return sendFromUser(senderKey, to, text, opts?.fast ?? false, {
      skipJitter: opts?.skipJitter,
      lane: opts?.lane,
    });
  },

  async markRead(senderKey, messageKey) {
    const { markMessageAsRead } = await import("../../evolution");
    await markMessageAsRead(
      senderKey,
      messageKey as { remoteJid?: string; fromMe?: boolean; id?: string } | null
    );
  },

  async fetchMedia(senderKey, frame) {
    const { fetchMediaBase64 } = await import("../../evolution");
    const img = await fetchMediaBase64(senderKey, frame);
    return img ? { mime: img.mime, base64: img.base64 } : null;
  },

  async fetchProfilePicture(senderKey, digits) {
    const { fetchProfilePicture } = await import("../../evolution");
    const pic = await fetchProfilePicture(senderKey, digits);
    return (pic as { url?: string | null } | null)?.url ?? null;
  },

  async resolveChatId(senderKey, digits) {
    const { resolveChatJid } = await import("../../evolution");
    return resolveChatJid(senderKey, digits);
  },

  async connectionState(senderKey) {
    const { connectionState } = await import("../../evolution");
    const s = await connectionState(senderKey);
    return s === "open" || s === "connecting" || s === "close" ? s : "unknown";
  },
};
