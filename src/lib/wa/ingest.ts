// Evolution webhook INGESTION - the runtime-agnostic core of the inbound
// pipeline, extracted from the Next.js route so it has exactly two callers:
//   1. the legacy Next route (src/app/api/webhooks/evolution/route.ts), and
//   2. the BullMQ incoming.worker (services/workers), where the gateway acks
//      the webhook in <200ms and this function runs OFF the request path with
//      retries + DLQ semantics.
// Token verification stays with the callers (each transport authenticates its
// own ingress); everything from event parsing to processVendorReply + the
// opportunistic drains lives here, byte-identical to the route it came from.

import { sbInsert, sbSelect, sbSelectStrict } from "@/lib/runtime-config";
import { processVendorReply } from "@/lib/agent-loop";
import {
  emailForInstance,
  resolveInstanceEmail,
  sendFromUser,
} from "@/lib/evolution";
import { noteInboundDropped } from "@/lib/wa/webhook-trace";

// PRIVACY HARD RULE: WheelDeal must NEVER read a user's personal chats. A
// message is stored/processed ONLY if it comes from a number THIS USER's agent
// first messaged as a rental-shop thread - scoped to the receiving instance's
// owner, so one user's test thread can never open another user's (or the
// owner's own) private chats to ingestion. Drill/test threads (the owner
// rehearsing against a friend's number) count for 12 HOURS only: when the
// drill is over, the friend's private messages stop being ingested.
// Shared with wa-sync so BOTH ingestion paths enforce the same gate (a
// second copy is how the drill window got skipped on the recovery path).
import { isVendorThread } from "@/lib/drill";
import { digitsOnly } from "@/lib/phone";
import { waDigits, numberFilter, waIdKind, lidKey } from "@/lib/wa/phone-key";
import {
  waMessageText,
  waUnwrap,
  waMediaKind,
  waProductCard,
  waQuotedText,
} from "@/lib/wa/message-text";
import { resolveChatIdentity } from "@/lib/wa/lid-alias";
import { claimInboundStore } from "@/lib/wa/inbound-claim";
import { kickDispatcher } from "@/lib/wa/kick";
import { finishBeforeResponse } from "@/lib/after";
import { parseInboundCoords, describeShopLocation, distanceNote } from "@/lib/wa/inbound-location";

// The region of the last outbound to this shop - primes the voice transcriber
// for the local accent (best-effort; undefined just means no language hint).
// Scoped to the receiving user: another user's region must never prime it.
async function regionForThread(fromDigits: string, ownerEmail: string): Promise<string | undefined> {
  const rows = await sbSelect<{ raw: { region?: string } | null }>(
    "whatsapp_messages",
    `select=raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      ownerEmail
    )}&order=received_at.desc&limit=1${numberFilter("to_number", fromDigits)}`
  ).catch(() => []);
  const r = rows[0]?.raw?.region;
  return typeof r === "string" && r ? r : undefined;
}

/**
 * When this user was last handed a pairing code, or null.
 *
 * This is the discriminator for a 401 close. Evolution emits 401 both for a
 * genuine logout (the link is gone) and as a normal beat of the pairing-code
 * handshake (the socket is about to restart with real credentials). Without
 * this stamp we would either miss every real ban or pause every number the
 * instant it links - and the second failure is the worse one.
 */
async function pairingStampFor(email: string): Promise<string | null> {
  try {
    const rows = await sbSelect<{
      pairing_code_issued_at: string | null;
      updated_at: string | null;
    }>(
      "wa_sessions",
      `select=pairing_code_issued_at,updated_at&email=eq.${encodeURIComponent(
        email.trim().toLowerCase()
      )}&limit=1`
    );
    return rows[0]?.pairing_code_issued_at ?? rows[0]?.updated_at ?? null;
  } catch {
    // Unreadable stamp: assume NOT pairing, so a genuine logout is still
    // caught. The cost of being wrong here is a session marked closed during a
    // handshake, which the next `open` event immediately repairs.
    return null;
  }
}

// THE LIVE PATH USED THE WEAKER OF THIS REPO'S TWO EXTRACTORS.
//
// `unwrap` peeled ONE envelope (ephemeralMessage) and `extractText` read FIVE
// subtypes. The complete reader already existed - it was private to
// evolution.ts and wired only to the wa-sync RECOVERY sweep - so the sweep
// could read a message the live webhook had already thrown away.
//
// Concretely, everything below arrived and became nothing: stickers (a shop
// sent "I'M SORRY" beside "sorry tomorrow we closed and open again on 20th"),
// reactions, button / list / template replies, view-once media, and edited
// messages. And because `unwrap` fed the media DETECTORS too, a view-once
// photo was not merely unreadable - `hasImageMessage` said false and the
// vision job never ran at all.
//
// Both paths now share src/lib/wa/message-text.ts. This is a deletion.
const unwrap = waUnwrap;
const extractText = waMessageText;

// WhatsApp voice notes arrive as audioMessage (audio/ogg; codecs=opus), also
// wrapped in ephemeralMessage on disappearing chats.
function hasAudioMessage(data: any): boolean {
  return Boolean(unwrap(data)?.audioMessage);
}
function hasImageMessage(data: any): boolean {
  return Boolean(unwrap(data)?.imageMessage);
}
// A VIDEO WITH NO CAPTION USED TO BE NOTHING AT ALL.
//
// extractText already reads videoMessage.caption, but nothing detected the
// video itself - so "here is the scooter running", sent with no words, stored
// as an empty-bodied row, hit the no-text-no-media check below and was dropped
// with no reply and no placeholder in the transcript. To the traveller the shop
// had sent something and the agent had ignored it; to the agent nothing had
// happened. Same class as the price-list photo, and a shop filming the bike is
// usually a shop that wants to do business.
function hasVideoMessage(data: any): boolean {
  return Boolean(unwrap(data)?.videoMessage);
}
/** The video's own mimetype, for the media stamp + the native-read gate. */
function videoMessage(data: any): { mimetype?: string } | null {
  const v = unwrap(data)?.videoMessage;
  return v ? { mimetype: v.mimetype } : null;
}
// Beyond image/audio: documents (PDF rate cards), location pins and contact
// cards used to be silently dropped - now every one becomes either engine
// input or an honest user-facing note.
function documentMessage(data: any): { mimetype?: string; fileName?: string } | null {
  const d = unwrap(data)?.documentMessage;
  return d ? { mimetype: d.mimetype, fileName: d.fileName } : null;
}
function locationMessage(data: any): { lat?: number; lng?: number; name?: string } | null {
  const l = unwrap(data)?.locationMessage;
  return l
    ? { lat: Number(l.degreesLatitude), lng: Number(l.degreesLongitude), name: l.name || l.address }
    : null;
}
function contactMessage(data: any): { name?: string; digits?: string } | null {
  const c = unwrap(data)?.contactMessage ?? unwrap(data)?.contactsArrayMessage?.contacts?.[0];
  if (!c) return null;
  const digits = String(c.vcard ?? "").match(/waid=(\d{6,})|TEL[^:]*:\+?([\d\s-]{6,})/i);
  return {
    name: c.displayName ?? undefined,
    digits: digitsOnly(digits?.[1] ?? digits?.[2]) || undefined,
  };
}

// Media downloads fail transiently (host mid-restart, expired media). A
// price-list photo silently lost = a lost offer, so retry with backoff.
async function fetchMediaWithRetry(
  email: string,
  data: any
): Promise<{ mime: string; base64: string } | null> {
  const { fetchMediaBase64 } = await import("@/lib/evolution");
  const delays = [0, 2000, 5000];
  for (const wait of delays) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const media = await fetchMediaBase64(email, data);
      if (media) return media;
    } catch {
      /* retry */
    }
  }
  return null;
}

/** A request to run the image turn through the isolated vision pipeline
 * (Module 3): the caller-injected enqueue creates a BullMQ Flow whose CHILD
 * does the heavy download + OCR at strict concurrency and whose PARENT
 * continuation composes the reply (or the never-silent clarify). */
export interface VisionFlowRequest {
  waMessageId: string;
  fromDigits: string;
  remoteJid: string;
  senderEmail: string;
  caption: string;
  /** The single provider message frame (carries the media keys). */
  raw: unknown;
}

/**
 * Process one Evolution webhook payload end-to-end: receipts, connection
 * lifecycle, privacy-gated message ingestion, takeover detection, media +
 * voice handling, the agent turn (processVendorReply) and the opportunistic
 * drains. Never throws for business reasons - only genuinely transient
 * infrastructure errors propagate (so a queue caller can retry with backoff).
 *
 * opts.origin + opts.token: when set (the Next route), the self-chaining
 * /api/wa/tick kick fires as before. The worker passes neither - it IS the
 * persistent process, so the in-request tick chain is unnecessary there.
 *
 * opts.enqueueVisionFlow: injected ONLY by the worker runtime (dependency
 * inversion - this file must never import BullMQ into the Next bundle). When
 * present, image turns are OFFLOADED to the vision Flow instead of running
 * the download + LLM OCR inline in this turn.
 */
export async function processEvolutionWebhook(
  payload: unknown,
  opts: {
    origin?: string;
    token?: string;
    enqueueVisionFlow?: (req: VisionFlowRequest) => Promise<void>;
  } = {}
): Promise<{ retryable: boolean }> {
  const body: any = payload ?? null;
  // Set when a message could not be ingested because OUR OWN storage was
  // unreachable (not because it was judged not-ours). The webhook route
  // answers non-2xx so the provider REDELIVERS - failing loud instead of
  // eating a possibly-genuine shop reply on our own outage.
  let retryable = false;
  // Every user whose thread moved in THIS webhook batch. Their reply
  // dispatcher is kicked at the end - per sender, so one traveller's cold
  // batch can never gate another's answer.
  const touchedSenders = new Set<string>();
  // Read receipts (anti-ban A1) collected across the batch and fired once,
  // concurrently, AFTER the try below - so N messages pay the "just glanced"
  // delay in parallel, never serially in front of the reply. Declared out here
  // so the post-loop firing block can see it.
  const readReceipts: Array<{ email: string; key: { remoteJid: string; fromMe: boolean; id: string } }> = [];
  // E1 (owner report 6): "shop replied" pushes, deferred like the receipts.
  // The push gate + delivery used to run INSIDE the message loop, before the
  // agent turn - up to 8s of notify-state reads and push-service round trips
  // paid on the reply's critical path. Each message arms a closure here; they
  // all fire together after the replies have been composed and parked.
  const deferredPushes: Array<() => Promise<void>> = [];
  if (!body) return { retryable };

  try {
    const event = String(body.event ?? "").toLowerCase().replace(/_/g, ".");
    const instance = String(body.instance ?? body.instanceName ?? "");

    // BAILEYS JUST REPLACED THE CODE ON THE TRAVELLER'S SCREEN (W-5).
    //
    // The app was counting down its own fixed 55 seconds over a credential it
    // does not own and cannot see rotate - the event was never subscribed to.
    // So the countdown read "30 seconds left" while Evolution had already
    // retired the code; the traveller typed it, WhatsApp refused, and "Try
    // again" - which re-polls and gets the current one - worked. That is the
    // reported first-attempt failure, and this is the missing signal.
    //
    // Re-stamping is the whole handler: `connectInstance` measures the window
    // from `pairing_code_issued_at`, so a rotation restarts the clock and the
    // next poll reports the life of the code actually on screen.
    if (event.includes("qrcode.updated")) {
      try {
        const who = await resolveInstanceEmail(instance);
        // An unresolvable instance here is not "not ours" - it may be an
        // outage - and a missed stamp only costs accuracy, so ask again.
        if (!who.ok) return { retryable: true };
        if (who.email) {
          const { notePairingRotation } = await import("@/lib/evolution");
          await notePairingRotation(who.email);
        }
      } catch {
        /* the countdown is a hint, never a gate */
      }
      return { retryable };
    }

    // Delivery / read receipts (blue tick) feed the Anti-Ban risk engine:
    // a healthy number gets read and replied to; delivered-but-never-read is a
    // strong spam signal, so we track it and let the guard react.
    if (event.includes("messages.update")) {
      try {
        // A receipt whose receiver cannot be resolved is not "not ours" - it may
        // be an outage. Ask again rather than discarding read/delivery/ERROR
        // signals the guard uses to decide whether a number is in trouble.
        const who = await resolveInstanceEmail(instance);
        if (!who.ok) return { retryable: true };
        const email = who.email;
        if (email) {
          const items = Array.isArray(body.data) ? body.data : [body.data];
          const { recordReadReceipt, recordDelivery, recordSendError, hasInboundFrom } =
            await import("@/lib/wa-guard");
          for (const d of items.slice(0, 20)) {
            const jid = String(d?.key?.remoteJid ?? "");
            if (!d?.key?.fromMe || !jid.endsWith("@s.whatsapp.net")) continue;
            const to = jid.split("@")[0];
            const status = String(d?.update?.status ?? d?.status ?? "").toUpperCase();
            if (status.includes("READ") || status === "4" || status === "5") {
              await recordReadReceipt(email, to);
            } else if (status.includes("DELIVERY") || status === "3") {
              await recordDelivery(email, to);
            } else if (status.includes("ERROR") || status === "0") {
              // THE RESTRICTION SIGNAL. This branch did not exist: the loop read
              // READ and DELIVERY and returned, so the only ground-truth
              // evidence that WhatsApp is refusing this number's outbound was
              // discarded on arrival.
              const established = await hasInboundFrom(email, to);
              await recordSendError(email, to, {
                firstContact: !established,
                status: status || "ERROR",
              });
            }
          }
        }
      } catch {
        /* receipts are best-effort */
      }
      return { retryable };
    }

    // A SHOP IS RINGING THE TRAVELLER'S PHONE.
    //
    // The CALL event was never subscribed to, so this arrived nowhere: the ring
    // reached a traveller who may be on airplane mode, out of local credit, or
    // simply unable to negotiate a rental in spoken Thai - and what the shop
    // experienced was a customer who had stopped answering. Handled in its own
    // module because the privacy gate, the push and the reply all matter and
    // none of them belong inline in this dispatcher.
    //
    // AWAITED, like every other side effect here: Cloud Run freezes the CPU the
    // instant the response flushes, and a detached push about a ringing phone
    // would be the definition of too late.
    if (event.includes("call")) {
      try {
        // An inbound CALL is a shop trying to reach the traveller right now; an
        // unresolvable receiver here is worth a redelivery rather than silence.
        const who = await resolveInstanceEmail(instance);
        if (!who.ok) return { retryable: true };
        const email = who.email;
        const { handleCallEvent } = await import("./call-intercept");
        await finishBeforeResponse("inbound-call", () => handleCallEvent({ email, data: body.data }));
      } catch {
        /* a call we could not read is not a reason to fail the webhook */
      }
      return { retryable };
    }

    // Connection lifecycle. IMPORTANT: a 401 "close" is ALSO emitted as a
    // normal part of the pairing-code handshake (restartRequired), so we must
    // NOT treat every 401 as a ban - that would pause a number the instant it
    // links. Only a genuine loggedOut/conflict reason enters ban-recovery; an
    // "open" refreshes the durable state so the app flips to connected.
    if (event.includes("connection.update")) {
      try {
        const data = Array.isArray(body.data) ? body.data[0] : body.data;
        const state = String(data?.state ?? data?.connection ?? "").toLowerCase();
        // A connection transition is how a BAN becomes visible. Losing one to a
        // database blip leaves the app reporting a linked, healthy session for a
        // number WhatsApp has already severed - the exact lie Tier 0.3 existed
        // to end. Ask again.
        const who = await resolveInstanceEmail(instance);
        if (!who.ok) return { retryable: true };
        const email = who.email;
        if (state === "open" && email) {
          const { markOpen } = await import("@/lib/evolution");
          markOpen(email).catch(() => {});
        } else if (state === "close" && email) {
          // THE CAUSE IS A NUMBER, NOT A WORD. The old predicate regex-matched
          // `statusReason` against "logged out"/"banned"/... while Evolution
          // sends 401/403/411/440, so `String(401)` matched nothing and this
          // branch had never once fired in production.
          const { classifyDisconnect, disconnectReasonFrom } = await import(
            "./disconnect-reason"
          );
          const pairingIssuedAt = await pairingStampFor(email);
          const verdict = classifyDisconnect(disconnectReasonFrom(data), {
            pairingIssuedAt,
          });

          if (!verdict.sessionDead) {
            // Transient close, or a 401 inside the pairing handshake. Leave the
            // session alone - tearing it down here is what produced "my
            // WhatsApp disconnected by itself" and an endless re-pair loop.
            return { retryable };
          }

          const { markClosed } = await import("@/lib/evolution");
          await markClosed(email, `${verdict.code ?? "?"} ${verdict.label}`);

          // AXIS 2 GOES IN THE LEDGER, and it is the axis pacing cannot touch.
          // Unofficial-client detection fires on accounts doing reply-only work
          // and its penalty is a full ban rather than a scoped restriction, so
          // it can never be inferred from send volume - the disconnect code is
          // the only evidence we ever get, and until now it was written to a
          // status string and overwritten by the next one.
          const { noteRisk, sessionKindForCode } = await import("./risk-events");
          await noteRisk({
            senderKey: email,
            kind: sessionKindForCode(verdict.code),
            detail: { code: verdict.code ?? null, label: verdict.label, banRisk: verdict.banRisk },
          });

          if (verdict.banRisk) {
            const { enterBanRecovery } = await import("@/lib/wa-guard");
            await enterBanRecovery(email, 24);
          }
          // THE AGENT IS BLOCKED, and only they can unblock it.
          //
          // Every push this app sent described PROGRESS - a reply, a price, a
          // deal. So the one state that genuinely needs a human, where the
          // link has dropped and nothing will send or arrive until they
          // re-pair, was the one state that produced silence. A hunt could sit
          // dead for hours behind a phone showing "Alerts on".
          await finishBeforeResponse("wa-disconnected-push", async () => {
            try {
              const { worthAnInterruption } = await import("@/lib/notify/significance");
              const { notifyState, markPushSent } = await import("@/lib/notify/state");
              const g = worthAnInterruption({ kind: "agent-blocked" }, await notifyState(email));
              if (!g.notify) return;
              const { sendPushToUser } = await import("@/lib/push");
              await sendPushToUser(email, {
                title: "WhatsApp disconnected 🔌",
                body: "Your agents are paused until you reconnect - open the app and scan the code to pick the hunt back up.",
                url: "/profile",
                // Its own lane: a connection problem must never be collapsed
                // away by an ordinary reply push.
                tag: "wa:disconnected",
              });
              await markPushSent(email, `agent-blocked: ${g.reason}`);
            } catch {
              /* a notification never blocks the webhook */
            }
          });
        }
      } catch {
        /* best-effort */
      }
      return { retryable };
    }

    if (!event.includes("messages.upsert")) return { retryable };

    const items = Array.isArray(body.data) ? body.data : [body.data];

    // Bounded per invocation, but the bound ADVANCES across redeliveries - it is
    // NOT a positional slice. The old `items.slice(0, 25)` capped by array index
    // and set retryable, so on a >25 batch the webhook 503'd, the provider
    // redelivered the SAME batch, and the slice re-took items 0..24 (now claimed,
    // so cheap-skipped) while items 25+ were never in the window: the tail was
    // dropped FOREVER and the webhook 503-looped. Instead we iterate the WHOLE
    // batch and cap the number of items that do REAL work (a won store claim)
    // per invocation. Already-claimed items cost only a claim check and do not
    // count, so each redelivery skips the handled head cheaply and advances onto
    // the next unclaimed window until the batch is fully drained (OR11 I2.2).
    const HEAVY_PER_INVOCATION = 25;
    let heavyProcessed = 0;
    for (const data of items) {
      // Per-item isolation (audit DEFECT 5): a throw handling ONE message in a
      // multi-message webhook batch must not drop its siblings - the route always
      // returns 200, so Evolution never redelivers them. Contain each item.
      try {
      // WORK BUDGET REACHED - stop and let the rest redeliver (OR11 I2.2). The
      // already-handled head will be cheap-skipped by its store claims next
      // time, so this advances the window rather than re-truncating it.
      if (heavyProcessed >= HEAVY_PER_INVOCATION) {
        retryable = true;
        void noteInboundDropped(undefined, "batch", "batch-truncated", {
          via: "webhook",
          total: items.length,
          kept: heavyProcessed,
          redelivery: "requested",
        });
        break;
      }
      if (!data?.key) continue;
      const remoteJid = String(data.key.remoteJid ?? "");
      const jidKind = waIdKind(remoteJid);
      // Groups, status broadcasts and anything unnameable are never a shop -
      // but a silent `continue` here was the one drop the message-path view
      // could not explain (owner report 4/W2.2). Traced, throttled by the
      // helper, so "the shop replied and nothing happened" can be told apart
      // from "that was a group post" in one query.
      if (jidKind !== "phone" && jidKind !== "lid") {
        void noteInboundDropped(undefined, waDigits(remoteJid) || remoteJid.slice(0, 24), "non-chat-jid", {
          via: "webhook",
          jidKind,
        });
        continue;
      }

      // Resolve the RECEIVING user FIRST - every store/read below is scoped to
      // them, and a privacy-JID alias is only evidence inside ONE inbox. An
      // unresolvable instance is never ingested (a receiver-less row would be
      // unscopeable forever).
      // UNKNOWN IS NOT "NOT OURS". Read permissively, a Supabase timeout and an
      // unknown instance both answered null - and null meant `continue`, which
      // with `retryable` still false let the route answer 200. Evolution treats
      // 200 as delivered and never sends it again, so a few seconds of database
      // trouble destroyed every shop reply that arrived during it, permanently,
      // and blamed Evolution in the only trace it left.
      const who = await resolveInstanceEmail(instance);
      if (!who.ok) {
        retryable = true;
        void noteInboundDropped(undefined, waDigits(remoteJid), "receiver-unresolvable", {
          instance,
          via: "webhook",
        });
        continue;
      }
      const email = who.email;
      if (!email) {
        await sbInsert("agent_events", [
          {
            kind: "webhook-orphan",
            vendor_id: "",
            vendor_name: waDigits(remoteJid) || remoteJid,
            detail: `Inbound from ${remoteJid} on unknown Evolution instance "${instance}" - dropped (privacy: cannot attribute a receiver).`,
          },
        ]).catch(() => {});
        continue;
      }
      touchedSenders.add(email);

      // ONE identity for this chat. A phone JID resolves to its digits (waDigits,
      // NOT a raw split: a multi-device JID carries a device suffix "…:12", and
      // splitting on "@" alone kept it, producing a routing key that matched NO
      // outbound anchor). A privacy @lid chat carries no phone of its own and is
      // resolved only from evidence - see wa/lid-alias. No evidence => dropped,
      // never guessed.
      const identity = await resolveChatIdentity(email, remoteJid, data).catch(
        () => "unavailable" as const
      );
      // UNRESOLVABLE-BECAUSE-OUTAGE is not the same as UNRESOLVABLE-BY-EVIDENCE
      // (OR11 I2.3). An @lid chat's phone lives ONLY in our thread rows, so a DB
      // wobble during that lookup used to drop a genuine shop reply for good
      // (200, never redelivered). Fail loud instead: request a redelivery, and
      // do NOT consume the work budget on it.
      if (identity === "unavailable") {
        retryable = true;
        void noteInboundDropped(email, lidKey(remoteJid) || remoteJid, "identity-unavailable", {
          via: "webhook",
          jid: remoteJid.slice(0, 48),
          lid: lidKey(remoteJid),
        });
        continue;
      }
      const from = identity?.phone ?? "";
      if (!from) {
        // The trace carries the LID as a structured field (not only as the
        // digits slot) so the WA doctor can match it - an @lid drop used to
        // be invisible to the very tool built to find it.
        void noteInboundDropped(email, lidKey(remoteJid) || remoteJid, "unresolved-identity", {
          via: "webhook",
          jid: remoteJid.slice(0, 48),
          lid: lidKey(remoteJid),
        });
        continue;
      }
      const chatLid = identity?.lid ?? "";
      // Downstream asserts the origin chat against the number we attribute to.
      // For a resolved @lid chat that assertion is satisfied by the RESOLVED
      // line, with the privacy id carried alongside for the trace.
      const originJid = jidKind === "phone" ? remoteJid : `${from}@s.whatsapp.net`;

      // Not a rental-shop thread THIS user opened? Drop it - never stored,
      // never read. (Applies to fromMe too: private chats stay sacred, and a
      // finished drill stops ingesting the friend's messages after 12h.)
      // STRICT: null means the thread store was unreachable - the truth is
      // UNKNOWN, and eating a possibly-genuine shop reply on our own outage
      // used to be a permanent loss (the route answered 200, so the provider
      // never redelivered). Fail loud instead: mark the whole delivery
      // retryable and let the webhook answer non-2xx.
      const gate = await isVendorThread(from, email);
      if (gate === null) {
        retryable = true;
        void noteInboundDropped(email, from, "vendor-gate-unavailable", { via: "webhook" });
        continue;
      }
      if (!gate) {
        // Formerly a fully silent drop. Leave a throttled trace so a genuine
        // shop reply lost to a missing RFQ anchor is diagnosable (WA doctor).
        void noteInboundDropped(email, from, "vendor-gate", { via: "webhook" });
        continue;
      }

      // ---- HUMAN TAKEOVER DETECTION ------------------------------------------
      // A fromMe message in a shop thread is either (a) our own bot send
      // echoing back, or (b) THE USER typing in WhatsApp themselves. Case (b)
      // used to be invisible - the agent kept talking over the user. Now it
      // stores the message and stands the agents down for this thread.
      if (data.key.fromMe) {
        try {
          const { getConfig } = await import("@/lib/runtime-config");
          const { parseFlag } = await import("@/lib/config-flags");
          if (!parseFlag(await getConfig("HUMAN_TAKEOVER"), true)) continue;
          const text = extractText(data);
          if (!text.trim()) continue; // media-only self message - out of scope
          const msgId = String(data.key.id ?? "");
          const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
          // Echo check 1: a bot send is already recorded with this provider id.
          // TOLERANT number matching on BOTH echo checks. With an exact
          // `to_number=eq.` a shop stored under a national spelling never
          // matched, so our OWN send echoed back was misread as a human
          // takeover: the agent stood down permanently and wrote an rfq-less
          // row on top of the thread. Same variants the resolver uses.
          //
          // AND AN UNREADABLE ECHO CHECK MUST NOT CONVICT. Both probes below
          // ran through the permissive reader, so a Supabase blip answered `[]`
          // - "no record of us sending this" - and the app concluded the
          // TRAVELLER had typed it. The consequences are not cosmetic: an
          // rfq-less `human-manual` row is written on top of the thread,
          // `setThreadTakeover` fires, EVERY pending wa_outbox row for that shop
          // is deleted along with its graph_wakeups tick, and the traveller is
          // pushed "You've got the wheel". The agent never speaks to that shop
          // again until they hand it back by hand.
          //
          // Standing an agent down is destructive and irreversible-by-itself, so
          // it must rest on POSITIVE evidence that a human typed - never on the
          // absence of evidence that we did. Unknown is treated as our own echo.
          const numFilter = numberFilter("to_number", from);
          const byIdRead = msgId
            ? await sbSelectStrict(
                "whatsapp_messages",
                `select=id&direction=eq.outbound&wa_message_id=eq.${encodeURIComponent(
                  msgId
                )}&limit=1${numFilter}`
              )
            : { rows: [] as unknown[] };
          if ("error" in byIdRead) {
            if (byIdRead.error === "unavailable") {
              void noteInboundDropped(email, from, "echo-check-unreadable", { via: "webhook" });
              continue;
            }
          } else if (byIdRead.rows.length > 0) continue;
          // Echo check 2 (H2): the DURABLE SEND INTENT. Checks 1 and 3 read
          // the outbound ROW - which is written only after the network send
          // returns - and WhatsApp's fromMe echo can arrive in that gap, so a
          // fast echo of our own message carried no record and was convicted
          // as a human takeover (agents stood down, queue purged, "You've got
          // the wheel" pushed - for a message WE sent). The send CLAIM
          // (wa_send_claims, msg:<digits>:<hash>) is written BEFORE the wire
          // by every app send path and uses this exact normalization, so it
          // is the positive evidence that survives the race. Matched by hash
          // across number spellings - the claim may carry the international
          // spelling while the echo arrives with the national one.
          try {
            const { messageSlotKey } = await import("@/lib/wa/pacing");
            const slot = messageSlotKey(from, text);
            const hash = slot.split(":")[2] ?? "";
            const claimRead = hash
              ? await sbSelectStrict(
                  "wa_send_claims",
                  `select=slot_key&sender_key=eq.${encodeURIComponent(
                    email
                  )}&slot_key=like.msg:*:${encodeURIComponent(hash)}&limit=1`
                )
              : { rows: [] as unknown[] };
            if ("rows" in claimRead && claimRead.rows.length > 0) continue;
          } catch {
            /* the intent probe is extra evidence - the checks below still run */
          }
          // Echo check 3: same body already stored as OUR outbound recently
          // (every bot/app send is inserted at send time).
          const recentRead = await sbSelectStrict<{ body: string | null }>(
            "whatsapp_messages",
            `select=body&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
              email
            )}&received_at=gte.${encodeURIComponent(
              new Date(Date.now() - 10 * 60_000).toISOString()
            )}&order=received_at.desc&limit=10${numFilter}`
          );
          if ("error" in recentRead) {
            if (recentRead.error === "unavailable") {
              void noteInboundDropped(email, from, "echo-check-unreadable", { via: "webhook" });
              continue;
            }
          }
          const recentOut = "rows" in recentRead ? recentRead.rows : [];
          const isEcho = recentOut.some(
            (m) => (m.body ?? "").replace(/\s+/g, " ").trim().toLowerCase() === normalized
          );
          if (isEcho) continue;
          // A real human message: record it in the thread + stand down.
          await sbInsert("whatsapp_messages", [
            {
              wa_message_id: msgId || null,
              from_number: instance,
              to_number: from,
              body: text,
              type: "text",
              direction: "outbound",
              raw: {
                sender: email,
                kind: "human-manual",
                channel: "evolution",
                ...(chatLid ? { lid: chatLid } : {}),
              },
            },
          ]);
          const { setThreadTakeover } = await import("@/lib/session-flags");
          const already = await (await import("@/lib/session-flags")).isThreadTakenOver(email, from);
          if (!already) {
            await setThreadTakeover(email, from, true);
            // The human is at the wheel NOW - kill anything already scheduled
            // for this thread so the agent cannot talk over them: pending
            // outbox rows AND strategic-wait wakeups. (The guard also refuses
            // takeover sends as a belt; this removes the queue itself.)
            const { sbDelete } = await import("@/lib/runtime-config");
            await sbDelete(
              "wa_outbox",
              `sender_key=eq.${encodeURIComponent(email)}${numberFilter("to_number", from)}`
            ).catch(() => {});
            await sbDelete(
              "graph_wakeups",
              `kind=eq.tick&thread_key=eq.${encodeURIComponent(`${email}:${from}`)}`
            ).catch(() => {});
            // Through the ONE door, and recorded. A takeover always passes -
            // it is a handover, exempt from the budget - but going around the
            // gate is how a ceiling stops being a ceiling.
            const { worthAnInterruption } = await import("@/lib/notify/significance");
            const { notifyState, markPushSent } = await import("@/lib/notify/state");
            const g = worthAnInterruption({ kind: "takeover" }, await notifyState(email));
            if (g.notify) {
              const { sendPushToUser } = await import("@/lib/push");
              await sendPushToUser(email, {
                title: "You've got the wheel 🤝",
                body: "You messaged this shop yourself - Will is standing down on that chat until you hand it back (open the conversation in the app).",
                url: "/",
              }).catch(() => {});
              await markPushSent(email, `takeover: ${g.reason}`);
            }
          }
        } catch {
          /* takeover detection is best-effort - never break the webhook */
        }
        continue;
      }

      const text = extractText(data);
      const msgId = String(data.key.id ?? "");
      const hasImage = hasImageMessage(data);
      const hasAudio = hasAudioMessage(data);
      const hasVideo = hasVideoMessage(data);
      const doc = documentMessage(data);
      const loc = locationMessage(data);
      const contact = contactMessage(data);

      // Location pins / contact cards become plain text the engine can use. A
      // pin (or a Maps link/coords pasted as chat text) is enriched with the
      // distance to the traveller's stay - so the agent can reason about
      // delivery feasibility - WHEN the traveller consented to share their
      // location (getUserStay masks coords without consent; we only ever surface
      // a rough distance, never their pin).
      let syntheticText = text;
      const pinLoc =
        loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
          ? { lat: loc.lat as number, lng: loc.lng as number, name: loc.name }
          : null;
      const textCoords = syntheticText ? parseInboundCoords(syntheticText) : null;
      if (pinLoc || textCoords) {
        const { getUserStay } = await import("@/lib/access");
        const s = await getUserStay(email).catch(() => null);
        const stayCoords = s ? { lat: s.lat, lng: s.lng } : null;
        if (!syntheticText && pinLoc) {
          syntheticText = describeShopLocation(pinLoc, stayCoords);
        } else if (syntheticText && textCoords) {
          const note = distanceNote(textCoords, stayCoords);
          if (note) syntheticText = `${syntheticText}${note}`;
        }
      }
      if (!syntheticText && contact && (contact.name || contact.digits)) {
        syntheticText = `(the shop shared a contact${contact.name ? `: ${contact.name}` : ""}${contact.digits ? ` +${contact.digits}` : ""})`;
      }

      // COMMERCE + QUOTE CONTEXT (owner report 6). A catalog product card is a
      // fully structured price statement - waMessageText already transcribes it
      // into `text` above; the structured block is stamped into raw below so
      // the UI can render a real card. A reply that QUOTES an earlier message
      // ("^ This one is 125 cc" quoting the Fazzio card) gets its referent
      // appended: the model needs to know what "this one" points at. The
      // deterministic price rails deliberately SKIP "(quoting: ...)" segments -
      // quoting a number is not stating it.
      const productCard = waProductCard(data);
      const quotedText = waQuotedText(data);
      if (quotedText && syntheticText) {
        syntheticText = `${syntheticText}\n(quoting: ${quotedText})`;
      }

      // IDEMPOTENT STORE. Evolution redelivers (and the recovery sync pulls the
      // same message), and this insert used to be unconditional - so ONE photo
      // became two "[photo]" rows a minute apart in the transcript. Claim the
      // provider message id first; only the winner writes the row. Redis/BullMQ
      // dedupe layers only exist on the worker path, so on the serverless path
      // this claim is the ONLY thing standing between a retry and a duplicate.
      if (msgId && !(await claimInboundStore(msgId, email))) {
        // A lost claim means another worker already stored this exact frame -
        // normal on redelivery, but traced so a dedup bug can never eat
        // messages invisibly again.
        void noteInboundDropped(email, from, "store-claim-lost", { via: "webhook", msgId });
        continue;
      }
      // A WON claim (or a rare id-less frame) is real work this invocation - it
      // counts toward the advancing per-invocation budget (OR11 I2.2). Placed
      // AFTER every cheap `continue` above (groups, echoes, lost claims), so
      // only genuinely-new messages consume the budget.
      heavyProcessed += 1;
      const stored = await sbInsert("whatsapp_messages", [
        {
          wa_message_id: msgId,
          from_number: from,
          to_number: instance,
          body:
            syntheticText ||
            (hasImage
              ? "[photo]"
              : hasAudio
              ? "[voice note]"
              : hasVideo
              ? "[video]"
              : doc
              ? `[document: ${doc.fileName ?? "file"}]`
              : // A frame we recognize but cannot read still stores its KIND -
                // an empty body here was the blank-bubble bug: the placeholder
                // used to be computed only AFTER this insert.
                (() => {
                  const kind = waMediaKind(data);
                  return kind ? `[${kind}]` : "";
                })()),
          type: hasImage
            ? "image"
            : hasAudio
            ? "audio"
            : hasVideo
            ? "video"
            : doc
            ? "document"
            : pinLoc
            ? "location"
            : contact
            ? "contact"
            : "text",
          direction: "inbound",
          // receiver = the ONE user whose WhatsApp got this message. Every
          // read surface filters on it - the privacy isolation keystone.
          raw: {
            instance,
            receiver: email,
            pushName: data.pushName ?? null,
            channel: "evolution",
            // The privacy identifier this chat is addressed by, when it is one.
            // Persisting it here (existing JSONB, no migration) is what lets a
            // later @lid frame with no phone field resolve to the same shop
            // after a process restart.
            ...(chatLid ? { lid: chatLid } : {}),
            // What the shop actually SENT, so "Full conversation" can show it
            // instead of the string "[photo]". Bytes are never stored here -
            // only the provider KEY, which /api/wa/media redeems on demand.
            // VIDEO INCLUDED (owner report 4): without the key a video's bytes
            // were never redeemable, so it could never be watched natively nor
            // replayed from the audit copy - the stamp is what makes the frames
            // below more than a "[video]" placeholder.
            ...(hasImage || hasAudio || doc || hasVideo
              ? {
                  media: {
                    key: data.key ?? null,
                    kind: hasImage ? "image" : hasAudio ? "audio" : hasVideo ? "video" : "document",
                    mime: doc?.mimetype ?? videoMessage(data)?.mimetype ?? null,
                    fileName: doc?.fileName ?? null,
                  },
                }
              : {}),
            // A dropped pin is the shop's own address - it belongs in the
            // transcript as a map link, not as prose the traveller cannot tap.
            ...(pinLoc ? { location: { lat: pinLoc.lat, lng: pinLoc.lng, name: pinLoc.name ?? null } } : {}),
            ...(contact && (contact.name || contact.digits)
              ? { contact: { name: contact.name ?? null, digits: contact.digits ?? null } }
              : {}),
            // The decoded catalog card (title/price/currency), so the UI can
            // render a real product card and the engine's later turns can read
            // the exact tier - historical cards were unrecoverable because
            // nothing of the frame survived this whitelist.
            ...(productCard ? { product: productCard } : {}),
            // What this message replied to, for the transcript's quote block
            // and the model's referent.
            ...(quotedText ? { quoted: { text: quotedText } } : {}),
          },
        },
      ]);
      if (!stored) {
        // The claim was taken but the row never landed: release the claim so
        // a redelivery can store it, mark the delivery retryable, and trace.
        // Before this check, a failed insert left the message permanently
        // absent while the claim made every retry a silent no-op.
        if (msgId) {
          const { releaseInboundStore } = await import("@/lib/wa/inbound-claim");
          await releaseInboundStore(msgId, email).catch(() => {});
        }
        retryable = true;
        void noteInboundDropped(email, from, "store-failed", { via: "webhook", msgId });
        continue;
      }
      // Response-time analytics: record how fast this shop replied to our RFQ.
      const { recordResponseTime } = await import("@/lib/stats");
      recordResponseTime(from).catch(() => {});

      // BLUE TICK ON A HUMAN'S CLOCK (owner report 4, anti-ban A1). A real
      // linked device reads the message before it answers; ours never did,
      // presenting a never-reads-then-replies pattern to every shop. Collected
      // here and fired ONCE, concurrently, after the batch loop (below) with a
      // 2-7s "just glanced" delay each - so a multi-message batch pays that
      // delay in parallel, never serially in front of the reply.
      if (email && msgId && data.key) {
        readReceipts.push({ email, key: { remoteJid: originJid || remoteJid, fromMe: false, id: msgId } });
      }

      // A SHARED CONTACT IS A LEAD, NOT JUST PROSE (owner report 4). The card's
      // digits are already stored on the row (raw.contact); this durable event
      // is what a UI chip can render as a one-tap "ask this shop too". A
      // SUGGESTION only - no thread is opened, no message sent: contacting a
      // number the traveller never chose is exactly what the outreach consent
      // flow exists to prevent.
      if (email && contact?.digits) {
        void sbInsert("agent_events", [
          {
            kind: "contact-suggested",
            user_email: email,
            vendor_name: from,
            detail: JSON.stringify({
              name: contact.name ?? null,
              digits: contact.digits,
              sharedBy: from,
            }),
          },
        ]).catch(() => {});
      }

      // NOTIFY AT INGEST, BUT ONLY WHEN IT IS WORTH IT.
      //
      // Two true things pull against each other here, and this is where they
      // are reconciled.
      //
      // The first: the agent turn is the WRONG place to decide alone. It fires
      // at the end of a successful turn, so every path that never reaches that
      // line - a parked reply, a vision offload, a takeover, a guard refusal,
      // an LLM outage - produced no notification at all. That is most of why
      // the field test showed "Alerts on" and a silent phone. The message is
      // already stored right here, and that fact depends on nothing
      // downstream.
      //
      // The second: `worthAnInterruption` exists precisely because "a shop
      // replied" is not news. This site used to push UNCONDITIONALLY, which
      // undid the policy it was written beside - fifteen shops, fifteen
      // buzzes, most of them auto-greetings.
      //
      // So: the same gate, fed by the PURE detectors already available at
      // ingest - no LLM, no extraction, nothing that can fail or stall. If it
      // carries a price, terms, or nothing at all, the gate knows which and
      // decides. The agent turn still upgrades a price later under the same
      // collapse tag, replacing this on the lock screen rather than adding a
      // second buzz.
      if (email) {
        deferredPushes.push(async () => {
          try {
            const body = syntheticText || "";
            const { extractQuotedPrices } = await import("@/lib/wa/price-extract");
            const { classifyActs } = await import("@/lib/wa/dialogue-acts");
            const quoted = body ? extractQuotedPrices(body).offer?.pricePerDay : undefined;
            const acts = classifyActs({ text: body, hadImage: hasImage, pricePerDay: quoted ?? null });
            const { classifyReply, worthAnInterruption } = await import("@/lib/notify/significance");
            const { notifyState, markPushSent } = await import("@/lib/notify/state");
            const state = await notifyState(email);
            const event = classifyReply({
              pricePerDay: quoted,
              anyReplyYet: state.anyReplyYet,
              // The shop stating what it wants held is a fact the traveller
              // acts on - find an ATM, decide about the passport. A photo we
              // have not read yet is not: the agent turn will push if it
              // turns out to carry a price.
              termsLanded: acts.shared.includes("deposit"),
            });
            const verdict = worthAnInterruption(event, state);
            const { sbInsert } = await import("@/lib/runtime-config");
            if (!verdict.notify) {
              // STILL A BREADCRUMB. The doctor's question is "did the last
              // reply push, and if not why" - and "we decided not to" is an
              // answer, where silence is not.
              await sbInsert("agent_events", [
                {
                  kind: "push-ingest",
                  user_email: email,
                  detail: JSON.stringify({
                    attempted: 0,
                    delivered: 0,
                    skipped: `${event.kind}: ${verdict.reason}`,
                  }).slice(0, 200),
                },
              ]).catch(() => {});
              return;
            }
            const { sendPushToUser } = await import("@/lib/push");
            const shop = data.pushName || `+${from}`;
            const outcome = await sendPushToUser(email, {
              title: `${shop} replied`,
              body: hasImage
                ? "Sent a photo - your agent is reading it now."
                : hasAudio
                  ? "Sent a voice note - your agent is listening."
                  : body.slice(0, 120) || "Tap to see the message.",
              // The shop is identified by its number here (the vendor id lives
              // on the turn, not the raw inbound), and the app resolves it the
              // same way the thread does.
              url: `/?from=${encodeURIComponent(from)}`,
              tag: `shop:${from}`,
            });
            // SPEND THE BUDGET. This site used to skip `markPushSent` on the
            // grounds that the agent turn's upgrade shares the collapse tag -
            // but a push that reaches the phone IS an interruption, and not
            // counting it made the 4-per-hour ceiling advisory.
            await markPushSent(email, `${event.kind}: ${verdict.reason}`);
            // A SEPARATE KIND from `push-sent`, deliberately: that one is the
            // budget ledger, this one is the DELIVERY breadcrumb, so the
            // doctor can answer "did the push actually reach a device, and
            // what did the push service say". Both are written now.
            await sbInsert("agent_events", [
              {
                kind: "push-ingest",
                user_email: email,
                detail: JSON.stringify({
                  attempted: outcome.attempted,
                  delivered: outcome.delivered,
                  pruned: outcome.pruned,
                  reason: outcome.reason ?? null,
                  statuses: outcome.results.filter((r) => !r.ok).map((r) => r.status ?? 0),
                }).slice(0, 200),
              },
            ]).catch(() => {});
          } catch {
            /* a notification never blocks ingest */
          }
        });
      }

      // A real inbound proves the socket is live: persist "open" durably.
      {
        const { markOpen } = await import("@/lib/evolution");
        markOpen(email).catch(() => {});
      }

      // A machine-readable document rides the vision rung. PDFs INCLUDED
      // (owner report 4): Gemini inline_data accepts application/pdf, so a
      // shop's PDF rate card is read exactly like a price-board photo (the
      // Groq rung filters itself to image parts and degrades gracefully).
      // Only genuinely unreadable formats (docx, xlsx, zip) keep the honest
      // "stored, not machine-readable" note below.
      const docIsImage = Boolean(
        doc?.mimetype && (/^image\//i.test(doc.mimetype) || /^application\/pdf\b/i.test(doc.mimetype))
      );
      // NOT A PUSH. A document we cannot read is real and worth showing, and it
      // is not worth a buzz: the traveller has nothing to decide and the app
      // says so the moment they look. See lib/notify/significance - the whole
      // reason alerts felt like spam was events like this one earning one.
      if (doc && !docIsImage && email) {
        await sbInsert("agent_events", [
          {
            kind: "media-unreadable",
            vendor_id: "",
            vendor_name: from,
            detail: `Document "${doc.fileName ?? "file"}" (${doc.mimetype ?? "?"}) from +${from} - stored, not machine-readable (email ${email}).`,
          },
        ]).catch(() => {});
      }

      // A shop that sends ONLY a price-list photo or a voice note (no caption)
      // is the common case - read the media, don't skip it. A frame with NO
      // text and NO media (sticker/reaction/system) is a real nothing-to-do
      // drop, but leave a throttled trace so it is never mistaken for silence.
      //
      // A CAPTIONLESS VIDEO IS NOT NOTHING. It used to land here and be
      // discarded: no reply, no placeholder in the transcript, so the traveller
      // saw the shop send something and the agent ignore it. We cannot read the
      // video, but we can say that it arrived and ask for the part we need in
      // words - which is what a person would do.
      if (!syntheticText && hasVideo) syntheticText = "[video]";

      // NEITHER IS A STICKER, A REACTION, OR A POLL.
      //
      // Same argument as the captionless video, and the owner hit it for real:
      // a shop sent an "I'M SORRY" sticker alongside "sorry tomorrow we closed
      // and open again on 20th", and the sticker frame reached here as empty
      // text with no media flag and was dropped. To the traveller the shop had
      // sent two things and the agent acknowledged one.
      //
      // We cannot read a sticker's meaning, and we do not pretend to. We record
      // that a frame of that kind arrived, which is enough for the engine to
      // know the shop is present and responsive, and enough for the transcript
      // to stop lying about what was said.
      if (!syntheticText) {
        const kind = waMediaKind(data);
        if (kind) syntheticText = `[${kind}]`;
      }

      if (!syntheticText && !hasImage && !hasAudio && !docIsImage) {
        // Name WHAT was dropped: the frame's top-level keys are the difference
        // between "a catalog subtype we must support" and genuine noise. The
        // old bare trace is why catalog blindness survived three field reports.
        void noteInboundDropped(email, from, "empty-media", {
          via: "webhook",
          frame: Object.keys(unwrap(data)).slice(0, 5),
        });
        continue;
      }

      // Price-list photo (or image-typed document)?
      //
      // WORKER RUNTIME (Module 3): offload the whole image turn to the vision
      // Flow - the CHILD downloads + OCRs at strict concurrency 2 (RAM-spike
      // isolation on the 1GB VM) and the PARENT continuation composes the
      // reply, or the NEVER-SILENT clarify if the child failed. Nothing heavy
      // runs in this turn.
      if ((hasImage || docIsImage) && email && opts.enqueueVisionFlow) {
        await opts.enqueueVisionFlow({
          waMessageId: msgId,
          fromDigits: from,
          remoteJid: originJid,
          senderEmail: email,
          caption: syntheticText,
          raw: data,
        });
        continue; // the flow's continuation owns this turn from here
      }

      // INLINE PATH: download WITH RETRY so the vision agent can read
      // the prices - a transient media failure must not lose the offer.
      //
      // COALESCED (owner report 4): a five-photo album used to run five turns,
      // each seeing one fifth of the board. assembleImageBurst makes the LAST
      // frame of a burst run ONE turn holding every frame; earlier frames
      // stand down here (their rows are stored - only the duplicate turn is
      // skipped). Frames are then fitted to the vision request budget, and
      // every frame that does not fit leaves a trace - never a silent drop.
      const images: { mime: string; base64: string }[] = [];
      let mediaFetchFailed = false;
      let videoUnreadable = false;
      if ((hasImage || docIsImage) && email) {
        const { assembleImageBurst } = await import("@/lib/wa/image-burst");
        const verdict = await assembleImageBurst({
          email,
          fromDigits: from,
          ownMsgId: msgId,
          fetchOwn: () => fetchMediaWithRetry(email, data),
          fetchByKey: async (key) => {
            const { fetchMediaBase64 } = await import("@/lib/evolution");
            return fetchMediaBase64(email, { key }).catch(() => null);
          },
        });
        if (verdict.standDown) {
          // A newer sibling's invocation owns the whole burst - this frame's
          // row is already stored and will be in its call. Traced so a
          // coalesced frame is never mistaken for a dropped one.
          void noteInboundDropped(email, from, "image-coalesced", {
            via: "webhook",
            msgId,
            leader: verdict.leaderId,
          });
          continue;
        }
        // Audit copies BEFORE budgeting: WhatsApp expires media, and the copy
        // must exist for every frame we hold bytes for - including ones the
        // vision budget is about to exclude. Fire-and-forget by contract.
        {
          const { storeMediaAudit } = await import("@/lib/media/audit");
          for (const f of verdict.frames) void storeMediaAudit(f.waMessageId, f);
        }
        const { budgetFrames } = await import("@/lib/media/frame-budget");
        const budget = budgetFrames(verdict.frames);
        images.push(...budget.kept.map((f) => ({ mime: f.mime, base64: f.base64 })));
        for (const d of budget.dropped) {
          await sbInsert("agent_events", [
            d.reason === "frame-too-large"
              ? {
                  kind: "media-unreadable",
                  vendor_id: "",
                  vendor_name: from,
                  detail: `Photo from +${from} is too large to read (${Math.round(d.chars / 1_400_000) / 1}MB) - the agent asks for a smaller one (email ${email}).`,
                }
              : {
                  kind: "image-batch-truncated",
                  vendor_id: "",
                  vendor_name: from,
                  detail: `Burst from +${from}: frame ${d.index + 1} of ${verdict.burstSize} not sent to the reader (${d.reason}) - read the first ${budget.kept.length} (email ${email}).`,
                },
          ]).catch(() => {});
        }
        if (verdict.fetchFailures > 0 || verdict.ownFetchFailed) {
          // Honest, and in the app rather than on the lock screen - a photo we
          // could not download is not something the traveller can act on.
          // (lib/notify/significance.)
          await sbInsert("agent_events", [
            {
              kind: "media-fetch-failed",
              vendor_id: "",
              vendor_name: from,
              detail: `${verdict.ownFetchFailed ? "Photo" : "Burst photo"} from +${from} failed to download after 3 attempts (email ${email}).`,
            },
          ]).catch(() => {});
        }
        // NEVER-SILENT with the SHOP: when NOTHING readable survived (every
        // download failed or every frame was oversized), fall through to
        // processVendorReply with the photo-clarify so the agent warmly asks
        // for the price in text. The old `continue` left the vendor on read.
        mediaFetchFailed = images.length === 0;
      }

      // NATIVE VIDEO (owner report 4, owner decision): a shop filming the bike
      // or panning over the price wall is read by Gemini directly - video/mp4
      // and video/3gpp ride the same inline_data rung as photos (the Groq rung
      // filters itself to images). One video per request and only when no
      // photo frames are attached (photos carry the prices; the provider reads
      // one video at a time). Oversized or exotic formats degrade to the
      // honest "could not watch it" ask below - never silence.
      if (hasVideo && email && images.length === 0) {
        const media = await fetchMediaWithRetry(email, data);
        const mime = media?.mime || videoMessage(data)?.mimetype || "";
        const { MAX_REQUEST_B64_CHARS } = await import("@/lib/media/frame-budget");
        if (media && /^video\/(mp4|3gpp)\b/i.test(mime) && media.base64.length <= MAX_REQUEST_B64_CHARS) {
          images.push({ mime: mime.split(";")[0], base64: media.base64 });
          const { storeMediaAudit } = await import("@/lib/media/audit");
          if (msgId) void storeMediaAudit(msgId, { mime: mime.split(";")[0], base64: media.base64 });
        } else {
          videoUnreadable = true;
          await sbInsert("agent_events", [
            {
              kind: "media-unreadable",
              vendor_id: "",
              vendor_name: from,
              detail: media
                ? `Video from +${from} (${mime || "unknown format"}, ~${Math.round(media.base64.length / 1_400_000)}MB) is too large or not mp4/3gpp - agent asks for a photo instead (email ${email}).`
                : `Video from +${from} failed to download - agent asks for a photo instead (email ${email}).`,
            },
          ]).catch(() => {});
        }
      }

      // Voice note? Download + transcribe (heavy-accent primed) so the whole
      // pipeline treats it exactly like an inbound text.
      //
      // CAPTIONED VOICE NOTES TRANSCRIBE TOO (owner report 4). This was gated
      // on `!syntheticText`, so a voice note sent WITH a caption kept only the
      // caption - the spoken half (usually the actual price) never reached the
      // engine. Caption and transcript both feed the turn now.
      let transcript: { text: string; language?: string; source: string } | null = null;
      if (hasAudio && email) {
        try {
          const media = await fetchMediaWithRetry(email, data);
          if (media) {
            const { transcribeAudio } = await import("@/lib/graph/transcribe");
            const { threadLanguageMode } = await import("@/lib/wa/thread-language");
            const rfqRegion = await regionForThread(from, email);
            // The Whisper language hint fires only on threads the traveller
            // opened in the shop's language - transcribeAudio has carried the
            // flag since it shipped, and no caller ever passed it.
            const localLang = (await threadLanguageMode(email, from).catch(() => null)) === true;
            transcript = await transcribeAudio({
              mime: media.mime || "audio/ogg",
              base64: media.base64,
              region: rfqRegion,
              localLang,
            });
          }
        } catch {
          /* transcription is best-effort - engine sends a polite fallback */
        }
        // THE SPOKEN HALF IS THE MESSAGE (owner report 6 K1). syntheticText
        // was "[voice note]" by the time transcription finished, and nothing
        // ever replaced it - so the LIVE engine's shopMessage was the
        // placeholder while the transcript rode a side field only the
        // FAILOVER graph engine read (the classic fix-on-failover pattern):
        // the shop SPOKE a price and the primary engine never heard it. The
        // words go into the text itself, marked "(voice note)" - the same
        // convention the graph, the simulator and the golden cases use. A
        // real caption keeps its place at the head: the shop wrote it first.
        const spoken = (transcript?.text ?? "").trim();
        if (spoken) {
          const { isMediaPlaceholder } = await import("@/lib/wa/coalesce");
          syntheticText = isMediaPlaceholder(syntheticText)
            ? `(voice note) ${spoken}`
            : `${syntheticText}\n(voice note) ${spoken}`;
        }
        // STAMP THE TRANSCRIPT ON THE STORED ROW (owner report 3, item 8).
        // The transcript used to exist for exactly one turn - fed to the
        // engine, then gone - so "Full conversation", Ops and the message-path
        // view could only ever show "[voice note]". Read-merge-patch keeps
        // the existing raw (receiver scoping, media key, lid) intact.
        if (transcript?.text && msgId) {
          try {
            const { sbUpdate } = await import("@/lib/runtime-config");
            const { isMediaPlaceholder } = await import("@/lib/wa/coalesce");
            const rows = await sbSelect<{ id: number; body: string | null; raw: Record<string, unknown> | null }>(
              "whatsapp_messages",
              `select=id,body,raw&wa_message_id=eq.${encodeURIComponent(msgId)}&direction=eq.inbound&order=id.desc&limit=1`
            );
            if (rows[0]) {
              // AND THE BODY, when the body is only a placeholder we wrote:
              // the raw stamp alone fixed the surfaces that know to look for
              // it and left every body reader - most importantly the
              // COALESCER, which strips placeholder bodies as noise - still
              // holding "[voice note]". A spoken price survived exactly one
              // turn that way. A real caption is never overwritten.
              const body = (rows[0].body ?? "").trim();
              await sbUpdate("whatsapp_messages", `id=eq.${rows[0].id}`, {
                raw: { ...(rows[0].raw ?? {}), transcript },
                ...(isMediaPlaceholder(body) ? { body: syntheticText } : {}),
              });
            }
          } catch {
            /* the durable stamp is a bonus - never the turn */
          }
        }
      }

      // BOUNDED CONCURRENCY (scale #7): cap heavy AI turns in flight per
      // instance so a burst of simultaneous webhooks under --concurrency 32
      // cannot spike RAM/CPU and slow everyone's reply together. Never drops a
      // turn - a waiter proceeds ungated past its patience window.
      const { withInboundSlot } = await import("@/lib/wa/inbound-gate");
      await withInboundSlot(async () => processVendorReply({
        fromDigits: from,
        // The RESOLVED origin chat - asserted against `from` before attributing.
        // For a privacy @lid chat this is the line the alias resolved to, which
        // is the only identity we are willing to attribute a reply to.
        remoteJid: originJid,
        text: syntheticText,
        images,
        transcript,
        waMessageId: msgId,
        senderEmail: email ?? undefined,
        humanDelay: Boolean(email),
        // A photo we could not download (and no caption to extract from):
        // inject the never-silent clarify so the shop still gets a warm ask
        // for the price in text instead of silence. A video we could not
        // watch gets its own honest ask - "[video]" is the placeholder body a
        // captionless video carries, so the guard reads as "video and nothing
        // else to go on".
        preExtracted:
          // '[photo]'/'[image]' is what a CAPTIONLESS photo carries by the
          // time it gets here (the shared reader's placeholder) - so the old
          // `!syntheticText` guard made the never-silent clarify dead code on
          // the live path: a failed download ran a bare text turn over the
          // placeholder instead.
          mediaFetchFailed &&
          (!syntheticText || syntheticText === "[photo]" || syntheticText === "[image]")
            ? (await import("@/lib/agent-loop")).photoClarifyExtraction()
            : videoUnreadable && syntheticText === "[video]"
              ? (await import("@/lib/agent-loop")).videoClarifyExtraction()
              : undefined,
        // THE AGENT'S REPLY IS A REPLY. It was billed as a cold introduction.
        //
        // This is the send SPTE's inline `guardAndSend` uses for the actual
        // answer to a shop - the single most latency-sensitive call in the
        // product - and it passed neither argument. `sendFromUser` defaults the
        // missing lane to "intro" (evolution.ts), so every live reply was
        // metered against the TIGHTER cold-intro cap. Once a cold batch had
        // spent that cap, the shop's answer came back `rateLimited`, was parked
        // 30s out, and was labelled "reconnecting - reply resumes
        // automatically": the wrong reason, for a refusal that was ours.
        //
        // `fast` matters for the same call. Without it the reply pays the 4-12s
        // presence simulation, on the one path the drain below explicitly
        // refuses to pay it on. The guard, the pacing claims and the recipient
        // mutex all still run - they are what make a send look human; the
        // presence theatre here only delayed the message we are racing to land.
        send: async (to, message) => {
          if (!email) return { ok: false, error: "unknown instance" };
          return sendFromUser(email, to, message, true, { lane: "reply" });
        },
      }));
      } catch (e) {
        // One bad message in the batch must not drop its siblings (DEFECT 5) -
        // the webhook already 200s so Evolution never redelivers. Skip this
        // item, but NEVER silently: this catch swallowed a whole photo turn
        // (media download / vision throw) with zero trace, so the WA doctor
        // reported a healthy thread while the shop got no answer.
        void noteInboundDropped(
          undefined,
          String(data?.key?.remoteJid ?? "").split("@")[0],
          "ingest-error",
          { error: e instanceof Error ? e.message.slice(0, 120) : "unknown" }
        );
      }
    }
  } catch (e) {
    // Never fail the webhook - but never lose the fact either (I4): this
    // outer catch covers the whole BATCH, so an exception here means every
    // message in the delivery was dropped with, until now, zero trace. The
    // recovery sweep can re-answer them; it just needs the breadcrumb to
    // exist when the owner asks where a reply went.
    void noteInboundDropped(undefined, "", "batch-error", {
      error: e instanceof Error ? e.message.slice(0, 120) : "unknown",
      retryable: true,
    });
  }

  // BLUE TICKS (anti-ban A1), the whole batch at once. Each fires after its own
  // 2-7s "just glanced" delay, all in parallel, bounded so the receipts leave
  // the instance before Cloud Run freezes CPU - and never blocking the reply
  // path above, which has already parked its answers by now.
  // The deferred "shop replied" pushes (E1): fired only now, with every reply
  // already composed and parked - the buzz arrives a breath later, the answer
  // to the shop and the app's own update land seconds sooner.
  if (deferredPushes.length) {
    await finishBeforeResponse("ingest-push", async () => {
      await Promise.all(deferredPushes.map((p) => p().catch(() => {})));
    });
  }
  if (readReceipts.length) {
    await finishBeforeResponse(
      "read-receipts",
      async () => {
        const { markMessageAsRead, readReceiptDelayMs } = await import("@/lib/evolution");
        await Promise.all(
          readReceipts.map(async (r) => {
            await new Promise((res) => setTimeout(res, readReceiptDelayMs()));
            await markMessageAsRead(r.email, r.key);
          })
        );
      },
      9_000
    );
  }

  // Opportunistic queue drain: any webhook activity flushes due outbox
  // messages (business-hours / pacing queue) AND due graph wakeups (strategic
  // waits + judge jobs) without a dedicated worker.
  // fast=true: this is the webhook path, not a cron. The presence simulation it
  // skips costs 4-12s PER ROW and buys nothing - the guard, the pacing claims
  // and the recipient mutex are what make a send look human, and they all still
  // run. Paying it here just made the reply we are racing to deliver later.
  //
  // The drain already KNOWS which lane each row belongs to (`isCold(row)`), and
  // hands it to the sender as the fourth argument. Dropping it on the floor here
  // re-billed every drained reply as a cold introduction - the same defect as
  // the inline send above, in the same file, on the same webhook invocation.
  // SCOPED AND BOUNDED, like the three sibling poll routes (/api/replies,
  // /api/activity, /api/wa/status) already are - the webhook tail was the one
  // caller still draining FLEET-WIDE with no time budget. A burst of 7 inbound
  // webhooks meant 7 unscoped drains, each able to run OTHER users' sends and up
  // to 24 other users' multi-agent LLM wakeup composes, ahead of the reply we
  // are racing to deliver - the head-of-line block behind the owner's "7 shops
  // at once stalls everything". Scope each drain to a sender this batch actually
  // touched (replyOnly - the cold lane is driven by the tick kick below), and
  // bound both under a 3s race so a slow host delays only its own thread.
  const DRAIN_BUDGET_MS = 3_000;
  const boundedDrain = <T,>(p: Promise<T>) =>
    Promise.race([p, new Promise((r) => setTimeout(r, DRAIN_BUDGET_MS))]);
  for (const sender of touchedSenders) {
    try {
      const { drainOutbox } = await import("@/lib/wa-guard");
      await boundedDrain(
        drainOutbox((senderKey, to, text, lane) => sendFromUser(senderKey, to, text, true, { lane }), {
          replyOnly: true,
          senderKey: sender,
        }).catch(() => 0)
      );
    } catch {
      /* best-effort */
    }
    try {
      const { drainGraphWakeups } = await import("@/lib/graph/engine");
      await boundedDrain(
        drainGraphWakeups((senderKey, to, text, lane) => sendFromUser(senderKey, to, text, true, { lane }), {
          userEmail: sender,
        }).catch(() => 0)
      );
    } catch {
      /* best-effort */
    }
  }

  // FAST COUNTER-REPLY: the agent's reply we just composed is parked ~10-40s in
  // the future, so the drain above (rows due NOW) cannot send it, and waiting
  // for the next 60s cron would blow the ceiling.
  //
  // This used to kick `/api/wa/tick` alone, and in the field that kick was
  // refused every single time: the tick is ONE GLOBAL runner, and a cold
  // introductions batch keeps a chain alive continuously, so every inbound got
  // "another runner" / "chain already live". The reply lane now has its own
  // per-sender dispatcher that no cold batch can hold - the tick kick stays as
  // the batch's own driver.
  // AWAITED, NOT FIRE-AND-FORGET. This is the same Cloud Run lesson the
  // activity route already learned the hard way: CPU is throttled to ~0 the
  // instant the HTTP response is flushed, so an un-awaited fetch() has no
  // guarantee of even completing its TCP handshake before the instance
  // freezes. The dispatcher lane below is EVERYTHING for reply latency - it is
  // what makes a counter-reply land in seconds instead of whenever the owner
  // next opens the app - and it was being started by exactly that kind of
  // ghost call. `tick`/`reply-tick` themselves already pause 350ms before
  // returning for the same reason; the kick that starts them never did.
  //
  // Awaiting costs the webhook only the time to hand the request off (the
  // dispatchers do their real work in their own invocation and return
  // quickly), and the whole block is bounded so a hung dispatcher can never
  // hold Evolution's webhook open.
  if (opts.origin && opts.token) {
    const origin = opts.origin;
    const token = encodeURIComponent(opts.token);
    const kicks = [
      ...[...touchedSenders].map(
        (sender) =>
          `${origin}/api/wa/reply-tick?token=${token}&sender=${encodeURIComponent(sender)}&hop=0`
      ),
      `${origin}/api/wa/tick?token=${token}&hop=0`,
    ];
    await Promise.all(kicks.map((url) => kickDispatcher(url)));
  }
  // Quiet sessions whose users have not used the app for a while - the link
  // survives, but the device stops looking permanently active on WhatsApp.
  try {
    const { pauseIdleSessions } = await import("@/lib/evolution");
    pauseIdleSessions().catch(() => {});
  } catch {
    /* best-effort */
  }

  return { retryable };
}
