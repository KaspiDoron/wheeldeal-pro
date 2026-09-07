"use client";

// Full-screen per-agency situational-awareness panel (Module 5). One shop, all
// live data in one place: identity + map metadata, photos, the offer, the
// negotiation state, the FULL WhatsApp transcript with per-message delivery
// ticks + human-takeover controls, the queue/ETA, and the action bar. Opened
// from a VendorCard or the activity feed. Full-screen portal (PhotoGallery
// pattern), mobile-first, safe-area aware.

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { LoadingDots } from "./LoadingDots";
import { PhotoGallery } from "./PhotoGallery";
import { ShopPhoto } from "./ShopPhoto";
import { StageBadge, Pipeline, stageCaption } from "./Tracker";
import { MessageBubble, type ThreadMsg } from "./MessageBubble";
import { reconcileMessages, useFollowNewMessages } from "./useTranscriptScroll";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { agentBusyLabel } from "@/lib/client/agent-busy";
import { writeAck } from "@/lib/client/write-ack";
import { depositSummary } from "@/lib/deposit";
import { moneyLocal } from "@/lib/currency";

type Msg = ThreadMsg;
interface Delivery {
  sent: boolean;
  delivered: boolean;
  read: boolean;
  blocked: boolean;
  replied: boolean;
  lastReadAt: string | null;
  lastReplyAt: string | null;
}

export interface ThreadDashboardProps {
  vendor: Vendor;
  rfq: StructuredRFQ | null;
  searchEpoch?: number;
  queueItem?: { etaFrom?: string; etaTo?: string; reason: string; due: boolean } | null;
  /**
   * Server truth (activity poll) about what the agent already has in flight
   * with THIS shop. Same prop, same meaning and same source as VendorCard's -
   * the lock was implemented on the card and this panel has its own Bargain
   * button, so the traveller could stack a second push simply by opening the
   * thread first. A guarantee that holds on one of two buttons is not one.
   */
  agentPending?: { count: number; sending: boolean; own?: boolean };
  whyDecisionId?: string;
  onClose: () => void;
  onBook: (v: Vendor) => void;
  onBargain: (v: Vendor) => void;
  onReviews: (v: Vendor) => void;
  onWhy?: (decisionId: string) => void;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function ThreadDashboard({
  vendor,
  rfq,
  searchEpoch,
  queueItem,
  agentPending,
  whyDecisionId,
  onClose,
  onBook,
  onBargain,
  onReviews,
  onWhy,
}: ThreadDashboardProps) {
  const { t } = useI18n();
  // The F9 lock, second half. See the prop's comment.
  const agentBusy = (agentPending?.count ?? 0) > 0;
  const [mounted, setMounted] = useState(false);
  const [messages, setMessages] = useState<Msg[] | null>(null);
  // The last poll failed - the transcript on screen is the last-good copy.
  const [stale, setStale] = useState(false);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [takeover, setTakeover] = useState<boolean | null>(null);
  const [switching, setSwitching] = useState(false);
  // Said out loud when the takeover write did not persist (audit F017), so the
  // traveller can tap again instead of trusting a switch that never landed.
  const [takeoverNote, setTakeoverNote] = useState<string | null>(null);
  const [gallery, setGallery] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    const release = lockBodyScroll();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      release();
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Transcript + delivery: poll every 5s (own state - never lifts into the
  // parent's vendor list). Takeover fetched once.
  useEffect(() => {
    if (!vendor.id) return;
    let alive = true;
    // OVERLAPPING POLLS ARRIVE OUT OF ORDER. The interval fires every 5s and
    // never cared whether the previous request had come back; on a slow
    // connection two are in flight at once and the OLDER response can land
    // last, rewinding the transcript to a state the traveller already scrolled
    // past. Each tick aborts the one before it, so the newest read always wins
    // and a stalled request cannot hold a socket for the life of the panel.
    let inFlight: AbortController | null = null;
    const load = () => {
      inFlight?.abort();
      const ctl = new AbortController();
      inFlight = ctl;
      const q = new URLSearchParams({ vendorId: vendor.id!, full: "1" });
      if (searchEpoch) q.set("since", String(searchEpoch));
      // Cache-bust: a Safari / Cloud Run intermediary caching this GET froze the
      // transcript on the first snapshot (the "app out of sync with WhatsApp"
      // report). no-store + a per-tick token guarantees a fresh read each poll.
      q.set("t", String(Date.now()));
      fetch(`/api/thread?${q.toString()}`, { cache: "no-store", signal: ctl.signal })
        .then((r) => r.json())
        .then((d) => {
          if (!alive || ctl.signal.aborted) return;
          // A FAILED POLL IS NOT AN EMPTY THREAD (D8). A well-formed error
          // payload ({error: ...}) used to reconcile to [] - one rate-limited
          // poll wiped a transcript the traveller was reading. Non-array
          // messages keep the last-good list and raise the stale chip; only
          // a real array is the truth.
          if (Array.isArray(d.messages)) {
            // Reconciled, so an unchanged transcript keeps its array identity
            // and the follow-scroll effect does not fire (useTranscriptScroll).
            setMessages((prev) => reconcileMessages(prev, d.messages));
            setStale(false);
          } else {
            setMessages((prev) => prev ?? []);
            setStale(true);
          }
          setDelivery(d.delivery ?? null);
          // Takeover rides the same poll now (D8): switching from your own
          // WhatsApp is reflected here within a tick, not at next mount.
          if (typeof d.takeover === "boolean") setTakeover(d.takeover);
        })
        // An abort is this component replacing its own request, never a
        // failure - and neither wipes the transcript: the last-good list
        // stays, marked stale, until a poll succeeds again.
        .catch((e) => {
          if (alive && (e as { name?: string })?.name !== "AbortError") {
            setMessages((prev) => prev ?? []);
            setStale(true);
          }
        });
    };
    load();
    const id = setInterval(() => !document.hidden && load(), 5000);
    fetch(`/api/thread/takeover?vendorId=${encodeURIComponent(vendor.id)}`)
      .then((r) => r.json())
      .then((d) => alive && setTakeover(Boolean(d.takeover)))
      .catch(() => {});
    return () => {
      alive = false;
      clearInterval(id);
      inFlight?.abort();
    };
  }, [vendor.id, searchEpoch]);

  // Follows the newest message only while the reader is already at the bottom.
  // The unconditional version snapped anyone reading history back down every
  // five seconds, which made reading history impossible.
  useFollowNewMessages(scrollerRef, endRef, messages);

  async function switchTakeover(mode: "takeover" | "handback") {
    setSwitching(true);
    setTakeoverNote(null);
    try {
      const res = await fetch("/api/thread/takeover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId: vendor.id, mode }),
      });
      const d = await res.json().catch(() => ({}));
      // ONLY A CONFIRMED WRITE FLIPS THE SWITCH (audit F017) - see
      // lib/client/write-ack. The route answers 200 { ok: false } when the
      // takeover marker did not land, and merely testing that an ok key was
      // PRESENT read that as success - so the panel promised silence over a
      // thread the agent was still answering.
      if (writeAck(res.ok, d)) setTakeover(mode === "takeover");
      else setTakeoverNote(t("Could not save your choice - try again."));
    } catch {
      setTakeoverNote(t("Could not save your choice - try again."));
    } finally {
      setSwitching(false);
    }
  }

  if (!mounted) return null;

  const o = vendor.offer;
  const cur = o?.currency ?? "USD";
  const mapsUrl = vendor.placeId
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(vendor.name)}&query_place_id=${vendor.placeId}`
    : null;
  const photos = vendor.photoUrls?.length ? vendor.photoUrls : vendor.photoUrl ? [vendor.photoUrl] : [];

  return createPortal(
    <div className="layer-panel fixed inset-0 flex flex-col bg-base pop-in">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 pt-safe">
        <div className="min-w-0 py-3">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[16px] font-extrabold text-strong">{vendor.name}</h2>
            <StageBadge stage={vendor.stage ?? "queued"} />
          </div>
          <p className="truncate text-[11px] text-faint">
            {stageCaption(vendor.stage ?? "queued").emoji} {t(stageCaption(vendor.stage ?? "queued").text)}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label={t("Close")}
          className="btn btn-sm shrink-0 rounded-xl bg-card px-3 text-strong lift"
        >
          ✕
        </button>
      </div>

      <div ref={scrollerRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {/* Meta row: rating, distance, open-now, address, Maps link */}
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
          {vendor.rating > 0 && (
            <button
              onClick={() => onReviews(vendor)}
              className="chip rounded-full bg-card2 px-2.5 py-1 text-soft"
            >
              ⭐ {vendor.rating.toFixed(1)} · {vendor.reviews} {t("reviews")}
            </button>
          )}
          {typeof vendor.distanceKm === "number" && (
            <span className="chip rounded-full bg-card2 px-2.5 py-1 text-soft">
              📍 {vendor.distanceKm.toFixed(1)} km
            </span>
          )}
          {vendor.openNow !== undefined && (
            <span
              className={`chip rounded-full px-2.5 py-1 ${
                vendor.openNow ? "bg-savings-soft text-savings" : "bg-card2 text-faint"
              }`}
            >
              {vendor.openNow ? t("Open now") : t("Closed")}
            </span>
          )}
          {mapsUrl && (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="chip rounded-full bg-brandblue-soft px-2.5 py-1 text-brandblue"
            >
              🗺 {t("Open in Google Maps")}
            </a>
          )}
        </div>
        {vendor.address && <p className="text-[11px] text-faint">{vendor.address}</p>}

        {/* Photos */}
        {photos.length > 0 && (
          <button
            onClick={() => setGallery(true)}
            className="relative block h-32 w-full overflow-hidden rounded-2xl border border-line"
          >
            <ShopPhoto src={photos[0]} className="h-full w-full" />
            {photos.length > 1 && (
              <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-extrabold text-white">
                🖼 {photos.length} {t("photos")}
              </span>
            )}
          </button>
        )}

        {/* Offer summary */}
        {o && (
          <div className="rounded-2xl border-2 border-line p-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-extrabold uppercase tracking-wide text-faint">
                {o.verified ? `✓ ${t("Verified")}` : t("Shop quote")}
              </span>
              <span className="text-[18px] font-extrabold text-strong">
                {cur} {o.pricePerDay}
                <span className="text-[11px] font-bold text-faint">/{t("day")}</span>
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] font-bold text-soft">
              {/* depositSummary, not the bare amount (D5): every alternative
                  the shop stated - "Passport or ฿4,000 cash" - never only the
                  cash figure, and never silence for a document-only deposit. */}
              {(() => {
                const d = depositSummary(
                  {
                    deposit: o.deposit,
                    depositType: o.depositType,
                    depositAmount: o.depositAmount,
                    depositCurrency: o.depositCurrency,
                    currency: o.currency,
                  },
                  moneyLocal
                );
                return d ? (
                  <span className="chip rounded-full bg-card2 px-2 py-0.5">
                    {t("Deposit")}: {d}
                  </span>
                ) : null;
              })()}
              {o.deliveryFee != null && (
                <span className="chip rounded-full bg-card2 px-2 py-0.5">
                  {o.deliveryFee > 0 ? `${t("Delivery")}: ${cur} ${o.deliveryFee}` : t("Free delivery")}
                </span>
              )}
              {o.includesInsurance && (
                <span className="chip rounded-full bg-savings-soft px-2 py-0.5 text-savings">
                  {t("Insurance included")}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Negotiation state */}
        <div className="rounded-2xl bg-card2 p-3">
          <Pipeline stage={vendor.stage ?? "queued"} />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold text-soft">
              {stageCaption(vendor.stage ?? "queued").emoji} {t(stageCaption(vendor.stage ?? "queued").text)}
            </p>
            {(whyDecisionId ?? "") && onWhy && (
              <button
                onClick={() => onWhy(whyDecisionId!)}
                className="btn btn-sm shrink-0 rounded-lg border border-line px-2 py-1 text-[10px] font-extrabold text-brandblue"
              >
                {t("Why?")}
              </button>
            )}
          </div>
        </div>

        {/* Queue / ETA (when a message is still waiting) */}
        {queueItem && (
          <div className="rounded-2xl bg-brandyellow-soft p-2.5 text-[11px] font-bold text-warn">
            🕘{" "}
            {queueItem.due
              ? t("sending at the next safe slot - paced to protect your number")
              : queueItem.etaFrom
                ? `${t("next message")} ~${clock(queueItem.etaFrom)}${
                    queueItem.etaTo && clock(queueItem.etaTo) !== clock(queueItem.etaFrom)
                      ? `-${clock(queueItem.etaTo)}`
                      : ""
                  }`
                : t(queueItem.reason)}
          </div>
        )}

        {/* Delivery status ticks */}
        {delivery && (delivery.sent || delivery.delivered || delivery.replied || delivery.blocked) && (
          <div className="flex items-center gap-1.5 text-[11px] font-bold">
            {delivery.blocked ? (
              <span className="text-brandred">⚠ {t("This number blocked messages")}</span>
            ) : delivery.replied ? (
              <span className="text-savings">✓✓ {t("Read - the shop replied")}</span>
            ) : delivery.read ? (
              <span className="text-brandblue">
                ✓✓ {t("Read")}
                {delivery.lastReadAt ? ` · ${clock(delivery.lastReadAt)}` : ""}
              </span>
            ) : delivery.delivered ? (
              <span className="text-soft">✓✓ {t("Delivered")}</span>
            ) : (
              <span className="text-faint">✓ {t("Sent")}</span>
            )}
          </div>
        )}

        {/* Human takeover */}
        {takeover !== null && (
          <div
            className={`flex items-center justify-between gap-2 rounded-2xl p-2.5 ${
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

        {/* FULL transcript (the biggest section) */}
        <div className="space-y-2 rounded-2xl bg-card2 p-3">
          <div className="text-[11px] font-extrabold text-strong">💬 {t("Full conversation")}</div>
          {/* The last poll failed: what's below is the last-good copy, said
              out loud instead of wiped (D8). Clears itself on the next
              successful poll - no action needed from the reader. */}
          {stale && (
            <p className="rounded-lg bg-brandyellow-soft px-2 py-1 text-[10px] font-bold text-warn">
              ⏳ {t("Connection hiccup - showing the conversation as of a moment ago.")}
            </p>
          )}
          {messages === null && <LoadingDots label={t("Loading the conversation")} />}
          {messages !== null && messages.length === 0 && (
            <p className="py-4 text-center text-[12px] text-faint">
              {t(
                stale
                  ? "Could not load this conversation just now - it retries by itself."
                  : "No messages in this thread yet."
              )}
            </p>
          )}
          {messages?.map((m) => (
            <MessageBubble key={m.id} m={m} />
          ))}
          <div ref={endRef} />
        </div>
      </div>

      {/* Sticky action bar */}
      <div className="flex gap-2 border-t border-line px-4 py-3 pb-safe">
        {o ? (
          <button onClick={() => onBook(vendor)} className="btn btn-primary flex-1 rounded-2xl py-2.5 text-sm font-extrabold">
            🔒 {t("Lock this deal")}
          </button>
        ) : null}
        <button
          onClick={() => {
            if (agentBusy) return;
            onBargain(vendor);
          }}
          disabled={agentBusy}
          aria-disabled={agentBusy}
          title={agentBusy ? t("Agents are currently negotiating with this shop") : undefined}
          className={`btn flex-1 rounded-2xl border-2 py-2.5 text-sm font-extrabold ${
            agentBusy
              ? "cursor-not-allowed border-line text-muted opacity-60"
              : "border-brandred text-brandred"
          }`}
        >
          {agentBusy ? agentBusyLabel(agentPending, t) : `🥊 ${t("Bargain")}`}
        </button>
      </div>

      {gallery && photos.length > 0 && (
        <PhotoGallery name={vendor.name} photos={photos} onClose={() => setGallery(false)} />
      )}
    </div>,
    document.body
  );
}
