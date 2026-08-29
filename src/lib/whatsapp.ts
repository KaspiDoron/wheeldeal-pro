// Official Meta WhatsApp Cloud API integration.
//
// When WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID are configured AND the
// CLOUD_API_ENABLED master switch is on, outbound messages go through the Graph
// API to opted-in partner vendors. Otherwise we return a compliant
// click-to-chat (wa.me) deep link the user can send themselves - no scraping,
// no unsolicited bulk blasting.
//
// THE SWITCH IS THE POINT, AND IT USED NOT TO EXIST.
//
// The Part-12 handoff lane in `lib/waba/` is off at three independent levels -
// WABA_ENABLED, a dry-run that ships ON, and credential presence. This module
// is a SECOND, older official-API sender that none of them governed. It was off
// today for exactly one reason: two Key Vault fields happened to be blank. That
// is an accident, not a design. Anyone pasting a Cloud API token into Admin to
// "see if it works" would have switched a live second sender on across three
// routes - outreach, mass outreach and the Cloud webhook's auto-reply - with no
// dry run, no anti-ban lane budget (see wa/lane-split.test.ts), and no owner
// decision anywhere in the loop.
//
// THE SWITCH IS ALSO ITS OWN, not WABA_ENABLED (Wave 6). Sharing that flag
// re-created the original accident one door over: rehearsing the governed
// lead-handoff lane means turning WABA_ENABLED on with WABA_DRY_RUN on - and
// this module reads neither the dry-run nor the governor, so the "rehearsal"
// would have armed this sender FOR REAL across the same three routes. An
// ungoverned lane cannot borrow the governed lane's switch: CLOUD_API_ENABLED
// exists so that arming this sender is a separate, deliberate owner decision -
// and it stays off until this lane earns a governed adapter (see
// wa/transports/index.ts, which refuses to register "cloud" for the same
// reason).

import "server-only";
import { getConfig } from "./runtime-config";
import { digitsOnly } from "./phone";

/**
 * The master switch for THIS sender alone.
 *
 * ABSENT MEANS OFF, and an UNREADABLE vault means off too - both the undefined
 * `getConfig` normally returns and the exception it can throw resolve to the
 * empty string, which is not "on". A hiccup can therefore only ever CLOSE this
 * lane, which is the correct direction for a switch whose "on" state starts
 * sending from a rented business number.
 */
async function officialSendingEnabled(): Promise<boolean> {
  const v = (await getConfig("CLOUD_API_ENABLED").catch(() => undefined)) ?? "";
  const s = String(v).trim().toLowerCase();
  return s === "on" || s === "1" || s === "true" || s === "yes";
}

export interface SendResult {
  channel: "cloud-api" | "click-to-chat";
  ok: boolean;
  waLink?: string;
  messageId?: string;
  error?: string;
}

/**
 * True only when this sender can ACTUALLY send: credentials present AND the
 * master switch on. Callers branch on this to decide whether a Cloud send is
 * even attempted, so gating it here closes every call site at once - there is
 * no second place to forget.
 */
export async function whatsappConfigured(): Promise<boolean> {
  // Each read is individually caught. A throwing vault must answer "cannot
  // send", never propagate - the callers treat an exception as an error path
  // and some of them would surface it to a traveller as a failed send when the
  // honest answer is that this lane is simply closed.
  const [token, phoneId, on] = await Promise.all([
    getConfig("WHATSAPP_ACCESS_TOKEN").catch(() => undefined),
    getConfig("WHATSAPP_PHONE_NUMBER_ID").catch(() => undefined),
    officialSendingEnabled(),
  ]);
  return Boolean(token && phoneId && on);
}

/**
 * Whether credentials EXIST, regardless of the switch. Only for the admin
 * engine readout, which has to be able to say "credentials are in, the switch
 * is off" - a state that is invisible if the two facts are collapsed into one
 * boolean, and that is exactly the state this deployment is meant to sit in
 * until the official lane is funded.
 */
export async function whatsappCredentialsPresent(): Promise<boolean> {
  const [token, phoneId] = await Promise.all([
    getConfig("WHATSAPP_ACCESS_TOKEN").catch(() => undefined),
    getConfig("WHATSAPP_PHONE_NUMBER_ID").catch(() => undefined),
  ]);
  return Boolean(token && phoneId);
}

function clickToChat(to: string, message: string): SendResult {
  const num = digitsOnly(to);
  const waLink = `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
  return { channel: "click-to-chat", ok: true, waLink };
}

export async function sendWhatsApp(
  to: string,
  message: string
): Promise<SendResult> {
  const [token, phoneId, on] = await Promise.all([
    getConfig("WHATSAPP_ACCESS_TOKEN").catch(() => undefined),
    getConfig("WHATSAPP_PHONE_NUMBER_ID").catch(() => undefined),
    officialSendingEnabled(),
  ]);
  // BELT AND BRACES. `whatsappConfigured` already gates every caller, but this
  // is the function that puts a message on the wire, so the switch is checked
  // where the send happens as well as where it is decided. A future caller that
  // forgets the gate degrades to click-to-chat rather than starting a second
  // live sender.
  if (!token || !phoneId || !on) return clickToChat(to, message);

  // Hard 12s timeout: a stalled Graph API response must not hang the outreach
  // request for the full request-timeout ceiling. On abort fetch throws -> the catch
  // below returns an error result (transient on the drain path -> re-queued).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  (timer as { unref?: () => void }).unref?.();
  try {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${phoneId}/messages`,
      {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: digitsOnly(to),
          type: "text",
          text: { body: message },
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      return {
        channel: "cloud-api",
        ok: false,
        error: data?.error?.message ?? `Graph API ${res.status}`,
      };
    }
    return {
      channel: "cloud-api",
      ok: true,
      messageId: data?.messages?.[0]?.id,
    };
  } catch (e) {
    return {
      channel: "cloud-api",
      ok: false,
      error: e instanceof Error ? e.message : "network error",
    };
  }
}
