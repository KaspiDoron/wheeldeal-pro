import "server-only";
import { waDigits } from "./phone-key";
import { resolveKnownThreadNumber } from "./known-thread";

// A SHOP IS RINGING A PHONE IN ANOTHER COUNTRY.
//
// This app messages rental shops on the traveller's own WhatsApp, in the shop's
// own language, from a number that answers within a minute. A shop that reads
// that as an engaged customer does the natural thing and calls. And until now
// the app did not subscribe to the CALL event at all, so the ring reached a
// traveller who is on airplane mode, out of local credit, in a meeting, asleep
// in another timezone, or simply unable to hold a rental negotiation in spoken
// Thai. What the shop experienced was a customer who stopped answering.
//
// Three things happen here, in this order of importance:
//   1. The traveller is told, immediately and without a budget check. A ringing
//      phone expires in seconds; by the time a rate-limit window opened, the
//      call would be over.
//   2. The shop gets ONE honest, warm text explaining that the traveller cannot
//      take calls and inviting them to write it here instead. Not a robot
//      apology - the reason a real traveller would give.
//   3. It is recorded, so Ops can see that a shop tried to call and what we
//      said back.
//
// PRIVACY KEYSTONE, unchanged: only a number this user's agent has actually
// messaged is treated as a shop. A call from the traveller's mother is not our
// business, must never raise a WheelDeal notification, and must certainly never
// be answered with a message about a motorbike.

export interface CallFrame {
  /** The caller's WhatsApp digits. */
  fromDigits: string;
  /** Video calls read differently in the UI and cost the traveller more data. */
  isVideo: boolean;
  /** Evolution's own status word, when it sends one ("offer", "terminate"...). */
  status: string | null;
}

/**
 * Read Evolution's CALL payload.
 *
 * The shape varies across Evolution builds (a bare object, an array, or one
 * nested under `data`), and the field naming for the caller varies with it, so
 * this is deliberately forgiving about structure and strict about the ONE thing
 * it must get right: whose number this is.
 */
export function parseCallFrame(data: unknown): CallFrame | null {
  const first = Array.isArray(data) ? data[0] : data;
  if (!first || typeof first !== "object") return null;
  const d = first as Record<string, unknown>;
  const raw =
    (typeof d.from === "string" && d.from) ||
    (typeof d.chatId === "string" && d.chatId) ||
    (typeof d.peerJid === "string" && d.peerJid) ||
    (typeof d.id === "string" && d.id.includes("@") ? d.id : "") ||
    "";
  const digits = waDigits(String(raw).split("@")[0] ?? "");
  if (!digits) return null;
  const status = typeof d.status === "string" ? d.status.toLowerCase() : null;
  return {
    fromDigits: digits,
    isVideo: d.isVideo === true || d.video === true,
    status,
  };
}

/**
 * Is this frame the START of a call?
 *
 * Evolution emits several frames per call - the offer, then terminate/timeout /
 * reject when it ends. Only the offer is news; the rest would double-notify a
 * traveller about a call they already know about, and would re-trigger the
 * reply to the shop.
 */
export function isRinging(frame: CallFrame): boolean {
  if (!frame.status) return true; // a build that sends no status only sends offers
  return frame.status === "offer" || frame.status === "ringing" || frame.status === "call";
}

/**
 * The message the shop gets. Deterministic, and deliberately so.
 *
 * This one is NOT composed by the model. It is sent unprompted, in the
 * traveller's name, to a person who is at that moment holding a ringing phone -
 * the least forgiving moment in the whole conversation for a hallucinated fact
 * or an accidental commitment. There is nothing to reason about here: the
 * content is fixed by the situation. Varying it costs nothing we need and risks
 * everything the rails exist to protect.
 *
 * The variants exist for anti-fingerprinting only, and every one of them says
 * exactly the same three things: sorry I missed it, I cannot take calls, please
 * write it here.
 */
const MISSED_CALL_REPLIES = [
  "Sorry, I missed your call - I can't take calls right now. Could you write it here instead?",
  "Sorry I couldn't pick up! I can't really do calls at the moment - happy to sort it out by message.",
  "Sorry, can't take a call right now. Can you send it here in a message?",
];

/** Pick a reply. `pick` is injectable so tests can pin it. */
export function missedCallReply(pick: () => number = Math.random): string {
  return MISSED_CALL_REPLIES[Math.floor(pick() * MISSED_CALL_REPLIES.length)] ?? MISSED_CALL_REPLIES[0];
}

export interface CallHandled {
  /** "not-ours" is the common case and is not a failure. */
  outcome: "answered" | "not-ours" | "ignored" | "no-user";
  fromDigits?: string;
  detail?: string;
}

/**
 * Handle one CALL webhook frame end to end.
 *
 * Never throws - a webhook that 500s on a call event would make Evolution
 * redeliver it, and a redelivered ring is a second notification about a call
 * that already ended.
 */
export async function handleCallEvent(args: {
  email: string | null;
  data: unknown;
  /** Injected in tests. */
  now?: number;
}): Promise<CallHandled> {
  const { email, data } = args;
  if (!email) return { outcome: "no-user" };
  const frame = parseCallFrame(data);
  if (!frame) return { outcome: "ignored", detail: "unreadable call frame" };
  if (!isRinging(frame)) return { outcome: "ignored", detail: `status ${frame.status}` };

  // THE PRIVACY GATE. Only a number this user's agent has messaged is a shop.
  const known = await resolveKnownThreadNumber(email, frame.fromDigits).catch(() => null);
  if (!known) return { outcome: "not-ours", fromDigits: frame.fromDigits };

  // ONE reply per shop per hour, whatever the shop does with the redial button.
  // A shop that rings four times is not four conversations, and four identical
  // messages from one number in a minute is the exact velocity pattern the
  // anti-ban work exists to avoid.
  let claimed = true;
  try {
    const { sbInsertClaim } = await import("../runtime-config");
    const hour = Math.floor((args.now ?? Date.now()) / 3_600_000);
    const res = await sbInsertClaim("wa_send_claims", {
      sender_key: email,
      slot_key: `call:${known}:${hour}`,
    });
    // "error" means the claims table is unavailable. Fail OPEN here, unlike a
    // send: the worst case is one extra polite message, and the alternative is
    // going silent on a shop that just called.
    if (res === "lost") claimed = false;
  } catch {
    /* claims unavailable - proceed */
  }

  // 1) TELL THE TRAVELLER FIRST. Even if the reply below fails, and even if we
  //    already replied this hour: the ring is happening now.
  try {
    const { worthAnInterruption } = await import("../notify/significance");
    const { notifyState, markPushSent } = await import("../notify/state");
    const g = worthAnInterruption({ kind: "call" }, await notifyState(email));
    if (g.notify) {
      const { sendPushToUser } = await import("../push");
      await sendPushToUser(email, {
        title: frame.isVideo ? "A shop is video-calling you 📹" : "A shop is calling you 📞",
        body: "Open the thread to see who it is - we've told them you'll answer by message.",
        url: `/?from=${encodeURIComponent(known)}`,
        // Its own tag: a call must never be collapsed away by a reply push.
        tag: `call:${known}`,
      });
      await markPushSent(email, `call: ${g.reason}`);
    }
  } catch {
    /* a notification never blocks the reply below */
  }

  if (!claimed) return { outcome: "ignored", fromDigits: known, detail: "already answered a call this hour" };

  // 2) ANSWER THE SHOP, through the ordinary guarded path - same pacing, same
  //    mutex, same outbox. A call is urgent to the traveller; it is not a
  //    licence to bypass the anti-ban machinery.
  //
  //    AND THEN ACTUALLY SEND (owner report 3, 3.4 severity #1). guardOutbound
  //    only DECIDES - every other allow-site performs the transport call
  //    itself. This one reported "sent" on a verdict and stopped, so the shop
  //    holding a ringing phone never received the one message this whole
  //    module exists to deliver. Same shape as agent-loop's inline path:
  //    atomic claim -> sendFromUser (reply lane, fast) -> release on failure
  //    -> durable outbound row on success.
  let detail = "queued";
  try {
    const { guardOutbound, claimForSend, releaseSendClaim, afterSend } = await import("../wa-guard");
    const verdict = await guardOutbound({
      senderKey: email,
      toDigits: known,
      text: missedCallReply(),
      auto: true,
      queueIfBlocked: true,
      meta: { kind: "auto-answer", reason: "missed call" },
    });
    if (!verdict.allow) {
      detail = `held: ${verdict.reason ?? "guard"}`;
    } else {
      const claim = await claimForSend(email, known, verdict.text, true, true);
      if (!claim.ok) {
        detail = claim.kind === "duplicate" ? "held: duplicate in flight" : "held: pacing slot";
      } else {
        const { sendFromUser } = await import("../evolution");
        const result = await sendFromUser(email, known, verdict.text, true, { lane: "reply" });
        if (!result.ok) {
          // Ambiguous (status-0): may have landed - keep the claim so a retry
          // cannot duplicate a delivered reply.
          if (!result.ambiguous) await releaseSendClaim(email, known, verdict.text).catch(() => {});
          detail = `send-failed: ${result.error ?? "unknown"}`;
        } else {
          await afterSend(email, known).catch(() => {});
          const { sbInsert } = await import("../runtime-config");
          await sbInsert("whatsapp_messages", [
            {
              wa_message_id: (result as { messageId?: string }).messageId ?? null,
              to_number: known,
              body: verdict.text,
              type: "text",
              direction: "outbound",
              raw: { sender: email, kind: "auto-answer", reason: "missed call", auto: true },
            },
          ]).catch(() => {});
          detail = "sent";
        }
      }
    }
  } catch (e) {
    detail = `failed: ${(e as Error)?.message ?? "unknown"}`;
  }

  // 3) LEAVE A TRACE. A shop trying to phone is a fact about the negotiation,
  //    and Ops had no way to know it ever happened.
  try {
    const { sbInsert } = await import("../runtime-config");
    await sbInsert("agent_events", [
      {
        kind: "inbound-call",
        user_email: email,
        vendor_name: known,
        detail: JSON.stringify({ video: frame.isVideo, reply: detail }),
      },
    ]);
  } catch {
    /* telemetry is never the reason a webhook fails */
  }

  return { outcome: "answered", fromDigits: known, detail };
}
