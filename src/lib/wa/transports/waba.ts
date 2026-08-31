// THE WABA TRANSPORT ADAPTER - the company business number, behind the same
// Transport contract as the traveller's Evolution instance.
//
// What this adapter IS: the reply leg. Once a shop is inside the 24h service
// window (it replied to a lead, or messaged us first), free-form text goes out
// on the official number through the governed wabaSend - honest SendResult
// mapping included, so the engine's ambiguous/claim rules hold unchanged.
//
// What this adapter is NOT: a cold outreach lane. `coldFirstContact: false`
// is the STRUCTURAL statement of Meta's rules - a first contact on the
// business number is a template with shop opt-in, a wholly different machine
// (waba/dispatch.ts admitLead -> dispatchHandoff), and the guard layer refuses
// to route a cold intro here because the CAPABILITY says no, not because a
// string comparison somewhere remembered to.

import type { SendOpts, SendResult, Transport, TransportCapabilities } from "../transport";

export const WABA_CAPABILITIES: TransportCapabilities = {
  presence: false, // no typing mimicry on the Cloud API - and none needed
  readReceipts: false,
  coldFirstContact: false, // cold = template lane + opt-in, never sendText
  serviceWindowHours: 24,
  media: true,
  historyFetch: false,
  identity: "company-number",
};

export const wabaTransport: Transport = {
  kind: "waba",
  capabilities: WABA_CAPABILITIES,

  // senderKey is the traveller whose negotiation this is; the wire identity
  // is the ONE company number, so it does not vary per sender. _opts is
  // accepted for signature parity - lanes/jitter are Evolution's anti-ban
  // concepts and have no meaning on the governed official number.
  async sendText(_senderKey, to, text, _opts?: SendOpts): Promise<SendResult> {
    const { wabaSend } = await import("../../waba/send");
    const r = await wabaSend({ lane: "freeform", to, text });
    return {
      ok: r.ok,
      error: r.error,
      messageId: r.messageId,
      // A dry-run "send" left nothing on the wire: truthful as unconfirmed so
      // no surface renders a delivery checkmark for a rehearsal.
      unconfirmed: r.dryRun || undefined,
      // 131049 (per-user marketing cap) is a rate refusal in SendResult terms:
      // the caller must hold, never blind-retry into burned quality rating.
      rateLimited: r.recipientCapped || undefined,
    };
  },
};
