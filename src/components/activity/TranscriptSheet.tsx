"use client";

// Full WhatsApp-style transcript of one shop thread (both directions, oldest
// first). Read-only in Phase 3; the human-takeover controls plug in here.

import { useEffect, useRef, useState } from "react";
import { Modal } from "../Modal";
import { LoadingDots } from "../LoadingDots";
import { useI18n } from "@/lib/i18n";
import { MessageBubble, type ThreadMsg } from "../MessageBubble";
import { reconcileMessages, useFollowNewMessages } from "../useTranscriptScroll";
import { writeAck } from "@/lib/client/write-ack";

type Msg = ThreadMsg;

export function TranscriptSheet({
  vendorId,
  vendorName,
  since,
  onClose,
}: {
  vendorId: string;
  vendorName: string;
  since?: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [delivery, setDelivery] = useState<{
    sent: boolean;
    delivered: boolean;
    read: boolean;
    replied: boolean;
    lastReadAt: string | null;
  } | null>(null);
  const [takeover, setTakeover] = useState<boolean | null>(null);
  // A POLL THAT FAILS MUST NOT ERASE THE CONVERSATION.
  //
  // Both failure paths used to blank the transcript: the catch called
  // setMessages([]), and a well-formed error body (no `messages` array)
  // reconciled the list down to nothing. Either way one bad tick on a hotel
  // wifi turned a live negotiation into an empty sheet - and the next tick
  // silently refilled it, so the reader could not tell what had happened.
  // Last-good stays on screen; the chip says it is not live.
  const [stale, setStale] = useState(false);
  const [switching, setSwitching] = useState(false);
  // Said out loud when the takeover write did not persist (audit F017).
  const [takeoverNote, setTakeoverNote] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // POLL, like ThreadDashboard does. Fetching once meant a sheet left open
  // while a shop was actively replying quietly went stale - the reader had no
  // way to tell an idle thread from a frozen view.
  useEffect(() => {
    let alive = true;
    // THE GUARD ITS SIBLING ALREADY HAD. ThreadDashboard documents this at
    // length - two polls in flight at once on a slow connection, and the OLDER
    // response can land last, rewinding the transcript to a state the traveller
    // already scrolled past. The fix was never applied here, so the shop's
    // newest message would appear and then disappear again.
    let inFlight: AbortController | null = null;
    const load = () => {
      inFlight?.abort();
      const ctl = new AbortController();
      inFlight = ctl;
      const q = new URLSearchParams({ vendorId, full: "1" });
      if (since) q.set("since", String(since));
      // Cache-bust: an intermediary caching this GET is what froze the
      // transcript on its first snapshot before.
      q.set("t", String(Date.now()));
      fetch(`/api/thread?${q.toString()}`, { cache: "no-store", signal: ctl.signal })
        .then((r) => r.json())
        .then((d) => {
          if (!alive || ctl.signal.aborted) return;
          if (!Array.isArray(d.messages)) {
            // A response we cannot read is a failed poll, not an empty thread.
            // Only the FIRST load may legitimately render "no messages yet".
            setMessages((prev) => (prev === null ? [] : prev));
            setStale(true);
            return;
          }
          setMessages((prev) => reconcileMessages(prev, d.messages));
          setDelivery(d.delivery ?? null);
          setStale(false);
        })
        // An abort is this component replacing its own request, never a
        // failure - blanking the transcript for it would be the bug it fixes.
        .catch((e) => {
          if (!alive || (e as { name?: string })?.name === "AbortError") return;
          setMessages((prev) => (prev === null ? [] : prev)); // keep last-good
          setStale(true);
        });
    };
    load();
    const id = setInterval(() => !document.hidden && load(), 5000);
    fetch(`/api/thread/takeover?vendorId=${encodeURIComponent(vendorId)}`)
      .then((r) => r.json())
      .then((d) => alive && setTakeover(Boolean(d.takeover)))
      .catch(() => {});
    return () => {
      alive = false;
      clearInterval(id);
      inFlight?.abort();
    };
  }, [vendorId, since]);

  async function switchTakeover(mode: "takeover" | "handback") {
    setSwitching(true);
    setTakeoverNote(null);
    try {
      const res = await fetch("/api/thread/takeover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, mode }),
      });
      const d = await res.json().catch(() => ({}));
      // ONLY A CONFIRMED WRITE FLIPS THE SWITCH (audit F017) - see
      // lib/client/write-ack. `{ ok: false }` is the route being honest about a
      // marker that never landed, not a success.
      if (writeAck(res.ok, d)) setTakeover(mode === "takeover");
      else setTakeoverNote(t("Could not save your choice - try again."));
    } catch {
      setTakeoverNote(t("Could not save your choice - try again."));
    } finally {
      setSwitching(false);
    }
  }

  // Only while the reader is already at the bottom - see useTranscriptScroll.
  useFollowNewMessages(scrollerRef, endRef, messages);

  return (
    <Modal onClose={onClose}>
      <div className="mb-2 flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="text-[16px] font-extrabold text-strong">{vendorName}</h2>
          <p className="text-[11px] text-faint">{t("The full conversation, exactly as sent")}</p>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label={t("Close")}>
          ✕
        </button>
      </div>

      {/* Delivery status (WhatsApp ticks): sent -> delivered -> read -> replied. */}
      {delivery && (delivery.sent || delivery.delivered || delivery.replied) && (
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold">
          {(() => {
            const readTime = delivery.lastReadAt
              ? new Date(delivery.lastReadAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : "";
            if (delivery.replied)
              return <span className="text-savings">✓✓ {t("Read - the shop replied")}</span>;
            if (delivery.read)
              return <span className="text-brandblue">✓✓ {t("Read")}{readTime ? ` · ${readTime}` : ""}</span>;
            if (delivery.delivered)
              return <span className="text-soft">✓✓ {t("Delivered")}</span>;
            return <span className="text-faint">✓ {t("Sent")}</span>;
          })()}
        </div>
      )}

      {takeover !== null && (
        <div
          className={`mb-2 flex items-center justify-between gap-2 rounded-2xl p-2.5 ${
            takeover ? "bg-savings-soft" : "bg-card2"
          }`}
        >
          <div className="min-w-0 text-[11px] font-bold leading-snug text-soft">
            {takeover
              ? t("You have the wheel - Will stays silent on this chat until you hand it back.")
              : t("Will is handling this chat. Take over any time - he'll stand down instantly.")}
            {takeoverNote && (
              <span className="mt-1 block font-extrabold text-warn">{takeoverNote}</span>
            )}
          </div>
          <button
            onClick={() => switchTakeover(takeover ? "handback" : "takeover")}
            disabled={switching}
            className={`btn btn-sm shrink-0 rounded-xl px-3 py-1.5 text-[11px] font-extrabold disabled:opacity-50 ${
              takeover ? "btn-primary" : "btn-ghost border border-line"
            }`}
          >
            {takeover ? t("Hand back to Will") : t("Take over")}
          </button>
        </div>
      )}

      <div
        ref={scrollerRef}
        className="no-scrollbar max-h-[55vh] space-y-2 overflow-y-auto rounded-2xl bg-card2 p-3"
      >
        {stale && messages !== null && (
          // Honest, not alarming: the conversation below is real, it is simply
          // the last version that arrived.
          <p className="rounded-xl bg-card px-2.5 py-1.5 text-center text-[11px] font-bold text-faint">
            {t("Showing the last update - reconnecting…")}
          </p>
        )}
        {messages === null && <LoadingDots label={t("Loading the conversation")} />}
        {messages !== null && messages.length === 0 && (
          <p className="py-4 text-center text-[12px] text-faint">
            {t("No messages in this thread yet.")}
          </p>
        )}
        {messages?.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
        <div ref={endRef} />
      </div>

      <p className="mt-2 text-center text-[10px] text-faint">
        {t("Blue = your agent · Grey = the shop. Continue any time from your own WhatsApp.")}
      </p>
    </Modal>
  );
}
