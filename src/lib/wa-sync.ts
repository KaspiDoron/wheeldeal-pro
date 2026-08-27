// Webhook-independent inbound sync (reliability core).
//
// The webhook is the fast path, but it is LOSSY: if the Evolution host was
// crashing, restarting or asleep when the shop replied, the event never reaches
// the app and the reply "exists in WhatsApp but not in the app". This module is
// the truth-reconciler: while a user is actively waiting on shops, we PULL the
// recent messages of their open threads straight from Evolution and process any
// inbound the webhook missed. Called opportunistically from /api/replies (the
// poll the app already runs every 15s), throttled per user.

import "server-only";
import { sbSelect, sbInsert } from "./runtime-config";
import { fetchMessagesRaw, fetchMediaBase64, sendFromUser, resolveChatJid } from "./evolution";
import { processVendorReply } from "./agent-loop";
import { noteInboundDropped } from "./wa/webhook-trace";
import { digitsOnly } from "./phone";
import { numberFilter, sameNumber, lidKey } from "./wa/phone-key";
import { rememberAlias, lidAliasForShop } from "./wa/lid-alias";
import { claimInboundStore, claimIsDeadTurn } from "./wa/inbound-claim";
import { boundedSet } from "./bounded-map";

const SYNC_MIN_GAP_MS = 12_000; // at most one real sync per user per 12s (snappy recovery)
const THREAD_WINDOW_H = 36; // only threads we messaged in the last 36h
const MAX_THREADS = 5;
// Hard latency budget: the sync runs INSIDE the user's poll request, so it
// must stay snappy - anything not reconciled this round is caught next poll.
const RUN_BUDGET_MS = 8_000;

declare global {
  // eslint-disable-next-line no-var
  var __wd_wa_sync__: Map<string, number> | undefined;
}
function lastSyncStore() {
  if (!globalThis.__wd_wa_sync__) globalThis.__wd_wa_sync__ = new Map();
  return globalThis.__wd_wa_sync__;
}

/**
 * Distinct users who sent an outbound WhatsApp message recently - the candidate
 * pool for the scheduler's app-closed inbound-recovery sweep. Cheap single scan.
 */
export async function recentActiveSenders(hours = 36, scan = 100): Promise<string[]> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = await sbSelect<{ raw: { sender?: string } | null }>(
    "whatsapp_messages",
    `select=raw&direction=eq.outbound&received_at=gte.${encodeURIComponent(
      since
    )}&order=received_at.desc&limit=${scan}`
  ).catch(() => []);
  const emails = new Set<string>();
  for (const r of rows) {
    const s = r.raw?.sender;
    if (typeof s === "string" && s.includes("@")) emails.add(s.toLowerCase());
  }
  return [...emails];
}

/**
 * Reconcile recent inbound replies for one user. Returns how many missed
 * messages were recovered (0 on the throttled fast path).
 */
export async function syncInboundReplies(email: string): Promise<number> {
  const store = lastSyncStore();
  const last = store.get(email) ?? 0;
  if (Date.now() - last < SYNC_MIN_GAP_MS) return 0;
  boundedSet(store, email, Date.now(), 5000);

  // The numbers this user recently messaged (their open shop threads).
  const since = new Date(Date.now() - THREAD_WINDOW_H * 3600_000).toISOString();
  const outbound = await sbSelect<{ to_number: string }>(
    "whatsapp_messages",
    `select=to_number&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      email
    )}&received_at=gte.${encodeURIComponent(since)}&order=received_at.desc&limit=60`
  ).catch(() => []);
  const allNumbers = [...new Set(outbound.map((o) => digitsOnly(o.to_number)))].filter(
    (n) => n.length >= 7
  );
  // ROTATE the window instead of always taking the newest MAX_THREADS: on a
  // large batch (ultra: 40 shops) the earlier shops were NEVER swept - the
  // same newest five were re-checked every pass while an older shop's missed
  // reply stayed missed. The minute index walks the whole list over time.
  const { rotateWindow } = await import("./wa/sweep");
  const numbers = rotateWindow(allNumbers, Math.floor(Date.now() / 60_000), MAX_THREADS);
  if (numbers.length === 0) return 0;

  let recovered = 0;
  const deadline = Date.now() + RUN_BUDGET_MS;
  for (const digits of numbers) {
    if (Date.now() > deadline) break; // stay snappy - next poll continues
    try {
      // SAME ingestion gate as the webhook: a finished drill (owner testing
      // against a friend's REAL number) must stop being pulled in here too -
      // this path used to keep ingesting the friend's private chats for the
      // whole 36h window after the webhook had already stopped.
      const { isVendorThread } = await import("./drill");
      const gate = await isVendorThread(digits, email);
      if (gate === null) {
        // Store unreachable: skip WITHOUT judging - the next sweep retries.
        void noteInboundDropped(email, digits, "vendor-gate-unavailable", { via: "sync" });
        continue;
      }
      if (!gate) {
        void noteInboundDropped(email, digits, "vendor-gate", { via: "sync" });
        continue;
      }
      // Resolve the EXACT chat JID (handles @lid privacy JIDs and format
      // variants). A hardcoded "<digits>@s.whatsapp.net" misses those, which is
      // what made the server-side filter fall through to an UNSCOPED whole-inbox
      // read - the root of personal chats being stapled onto shop threads.
      const jid = (await resolveChatJid(email, digits)) ?? `${digits}@s.whatsapp.net`;
      // A chat we reached from OUR outbound rows teaches the alias: this @lid
      // and this line are the same shop. The webhook path can then resolve a
      // future @lid frame instantly instead of dropping it.
      const chatLid = lidKey(jid);
      if (chatLid) rememberAlias(email, chatLid, digits);
      // LID-AWARE PULL: a privacy-migrated chat stores its records under the
      // @lid form, so a phone-jid pull can honestly find nothing while the
      // messages exist. When our OWN outbound anchor learned the chat's lid
      // (raw.lid, stamped at send time), pull under that form too. The
      // per-message assertion below still matches each candidate STRICTLY -
      // an @lid only ever by exact equality, so no privacy regression.
      const knownLid = chatLid || (await lidAliasForShop(email, digits));
      const candidateJids = [jid, ...(knownLid && !chatLid ? [`${knownLid}@lid`] : [])];
      let inbound: Awaited<ReturnType<typeof fetchMessagesRaw>> = [];
      let matchedJid = jid;
      for (const cand of candidateJids) {
        const msgs = await fetchMessagesRaw(email, cand, 10);
        inbound = msgs.filter(
          (m) =>
            !m.fromMe &&
            (m.text.trim() || m.hasImage) &&
            // PRIVACY (per-message origin assertion): the message MUST belong to
            // THIS exact chat. Even if any upstream read ever returned wider data,
            // a personal chat's message is dropped here - never stapled onto the
            // shop thread. @lid JIDs match only by exact equality (their numeric
            // part is not the phone number).
            (m.remoteJid === cand || sameNumber(m.remoteJid, digits)) &&
            // ignore ancient history - only the active window matters
            m.ts * 1000 > Date.now() - THREAD_WINDOW_H * 3600_000 &&
            // RACE GUARD: give the webhook a 10s head start on brand-new
            // messages. If both paths ingest the same message simultaneously,
            // the dedupe makes NEITHER process it - so the sync only touches
            // messages the webhook has clearly missed. 10s keeps recovery snappy
            // while still letting a working webhook win the race.
            m.ts * 1000 < Date.now() - 10_000
        );
        if (inbound.length > 0) {
          matchedJid = cand;
          break;
        }
      }
      if (inbound.length === 0) continue;
      void matchedJid;

      // Which of these already made it in via the webhook?
      const ids = inbound.map((m) => m.id);
      const seen = await sbSelect<{ wa_message_id: string }>(
        "whatsapp_messages",
        `select=wa_message_id&direction=eq.inbound&wa_message_id=in.(${ids
          .map((i) => `"${i}"`)
          .join(",")})&limit=${ids.length}`
      ).catch(() => []);
      const seenIds = new Set(seen.map((s) => s.wa_message_id));
      // ...and which were actually ANSWERED? Row existence was the whole skip
      // predicate here, so a message the webhook stored whose agent turn then
      // DIED (LLM outage, DB blip, lost turn) was skipped forever - stored,
      // silent, unrecoverable. The wa_processed lease is the durable record
      // of a DELIVERED turn (a failed turn releases it), so it is the honest
      // "done" signal. STRICT read: pre-migration ("missing") degrades to the
      // old stored-means-done behavior instead of re-answering everything.
      const { sbSelectStrict } = await import("./runtime-config");
      // BOTH claim spellings (H4): claims are receiver-scoped now
      // (email:msgId) with legacy bare-id rows still standing - a claim in
      // either spelling means this user's copy was answered.
      const { claimKey, quotedInList } = await import("./wa/inbound-claim");
      const claimSpellings = ids.flatMap((i) => {
        const scoped = claimKey(email, i);
        return scoped === i ? [i] : [i, scoped];
      });
      const answeredRes = await sbSelectStrict<{
        wa_message_id: string;
        created_at?: string | null;
        settled_at?: string | null;
      }>(
        "wa_processed",
        `select=wa_message_id,created_at,settled_at&wa_message_id=in.(${quotedInList(claimSpellings)})&limit=${claimSpellings.length}`
      );
      // Normalize back to the bare id so the skip test below matches. Only
      // OUR OWN scope prefix is stripped - a provider id that happens to
      // contain a colon is left exactly as it came.
      const scopePrefix = `${email.trim().toLowerCase()}:`;
      const answeredIds =
        "rows" in answeredRes
          ? new Set(
              answeredRes.rows
                // A CLAIM HELD BY A TURN THAT DIED IS NOT AN ANSWER.
                //
                // Every failed turn releases its claim, so a surviving one was
                // taken to mean "answered". An instance killed mid-turn
                // releases nothing, and this sweep - the ONLY recovery path -
                // then skipped that message forever. Past the lease, an
                // unsettled claim is a dead turn and the message is fair game
                // again. Conservative by construction: settled, young, or
                // unreadable all still count as answered, because a second
                // message in a real shop's chat is worse than a late one.
                .filter((r) => !claimIsDeadTurn(r))
                .map((r) =>
                  r.wa_message_id.startsWith(scopePrefix)
                    ? r.wa_message_id.slice(scopePrefix.length)
                    : r.wa_message_id
                )
            )
          : seenIds;

      // SELF-ECHO GUARD (mirrors the webhook's): if Evolution's stored record
      // lost the fromMe flag, a message the USER typed would come back here
      // labelled inbound - and the risk screen would then "flag the shop" for
      // the user's own words. Anything matching OUR recent outbound (agent or
      // human-manual) in this thread is skipped.
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const ours = await sbSelect<{ body: string; wa_message_id: string | null }>(
        "whatsapp_messages",
        `select=body,wa_message_id&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
          email
        )}&received_at=gte.${encodeURIComponent(
          new Date(Date.now() - 24 * 3600_000).toISOString()
        )}&order=received_at.desc&limit=30${numberFilter("to_number", digits)}`
      ).catch(() => []);
      const ourBodies = new Set(ours.map((o) => norm(o.body || "")).filter(Boolean));
      const ourIds = new Set(ours.map((o) => o.wa_message_id).filter(Boolean));

      for (const m of inbound) {
        // ANSWERED is the skip predicate, not STORED: a stored row whose turn
        // failed still deserves a retry (its reply claim was released).
        if (answeredIds.has(m.id)) continue;
        if (ourIds.has(m.id)) continue; // our own send, mislabelled inbound
        if (m.text.trim() && ourBodies.has(norm(m.text))) continue; // self-echo
        // Mirror the webhook's insert so the thread history stays coherent
        // (only for messages the webhook never stored).
        //
        // `seenIds` is a SNAPSHOT read taken before this loop, so it cannot see
        // a row the webhook stored while the sweep was running - and this sweep
        // is precisely the thing that runs concurrently with live webhooks.
        // The claim closes that window: it is the same conditional insert the
        // webhook itself takes, so whichever arrives second is told so instead
        // of writing a duplicate "[photo]" into the traveller's transcript.
        if (!seenIds.has(m.id) && (await claimInboundStore(m.id, email))) {
          await sbInsert("whatsapp_messages", [
            {
              wa_message_id: m.id,
              from_number: digits,
              to_number: "",
              body: m.text || (m.hasImage ? "[photo]" : ""),
              type: m.hasImage ? "image" : "text",
              direction: "inbound",
              // receiver = the user whose WhatsApp this sync ran for - without
              // it a recovered row would be invisible to every scoped read.
              raw: { channel: "evolution", recovered: true, receiver: email },
            },
          ]).catch(() => {});
        }

        const images: { mime: string; base64: string }[] = [];
        if (m.hasImage) {
          const media = await fetchMediaBase64(email, m.record);
          if (media) images.push(media);
        }
        // `recovered` counts only turns that RAN to completion. It used to be
        // incremented before processing, with the failure swallowed by a bare
        // catch - so a message stored-then-dropped was REPORTED as a recovery.
        try {
          await processVendorReply({
            fromDigits: digits,
            // The PHONE form of this chat. We arrived here from THIS user's own
            // outbound rows, so `digits` is the proven line; `m.remoteJid` may be
            // the privacy @lid address of the same chat, which the attribution
            // assertion downstream (rightly) refuses to trust on its own. Passing
            // the resolved line is what keeps an @lid-addressed shop from going
            // silent on the recovery path.
            remoteJid: `${digits}@s.whatsapp.net`,
            text: m.text,
            images,
            waMessageId: m.id,
            senderEmail: email,
            humanDelay: true,
            send: (to, message) => sendFromUser(email, to, message),
          });
          recovered += 1;
        } catch (e) {
          void noteInboundDropped(email, digits, "sync-turn-failed", {
            msgId: m.id,
            msg: e instanceof Error ? e.message.slice(0, 120) : "unknown",
          });
        }
      }
    } catch (e) {
      /* one broken thread must not kill the sync - but trace it (the pull
         failing silently is exactly what could hide a real shop reply). */
      void noteInboundDropped(email, digits, "sync-error", {
        msg: e instanceof Error ? e.message.slice(0, 120) : "unknown",
      });
    }
  }
  return recovered;
}
