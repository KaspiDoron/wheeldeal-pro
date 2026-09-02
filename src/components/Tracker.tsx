"use client";

import type { TrackerStage } from "@/lib/types";
import { TRACKER_ORDER } from "@/lib/client/stage-order";
import { useI18n } from "@/lib/i18n";

const FLOW: { key: TrackerStage; label: string }[] = [
  { key: "locating-contact", label: "Locating" },
  { key: "rfq-sent", label: "RFQ Sent" },
  { key: "awaiting-response", label: "Awaiting" },
  { key: "replied", label: "Replied" },
  { key: "negotiating", label: "Negotiating" },
  { key: "offer-received", label: "Offer" },
];

// Derived, not re-typed. The hand-written copy of this list already drifted
// once - it carried "replied" while page.tsx's advance table did not, so the
// Tracker could draw a rung the card could never reach.
const ORDER: TrackerStage[] = TRACKER_ORDER;

export function StageBadge({ stage }: { stage: TrackerStage }) {
  // THE BADGES NEVER ENTERED THE t() PIPELINE (owner report 3, item 10):
  // every stage chip on every card stayed English in a Hebrew app. The texts
  // live in i18n-extras.ts (they reach t() through a variable, so the
  // catalogue grep cannot see them here).
  const { t } = useI18n();
  const map: Record<TrackerStage, { text: string; cls: string }> = {
    queued: { text: "Queued", cls: "bg-card2 text-faint" },
    "locating-contact": { text: "Locating", cls: "bg-brandblue-soft text-brandblue" },
    found: { text: "Ready", cls: "bg-card2 text-soft" },
    "no-contact": { text: "No WhatsApp", cls: "bg-card2 text-faint" },
    // Delivering right now. Its own badge, because "in flight" is a real state
    // the shop is in for several seconds - not a gap to fall through.
    sending: { text: "Sending", cls: "bg-brandblue-soft text-brandblue" },
    "rfq-sent": { text: "RFQ sent", cls: "bg-brandblue-soft text-brandblue" },
    "awaiting-response": {
      text: "Awaiting reply",
      cls: "bg-brandyellow-soft text-warn",
    },
    // The shop answered and we are reading it. Blue, not red: nothing is being
    // haggled yet, and colouring it like negotiation is what made a greeting
    // look like a live price fight.
    replied: { text: "Replied", cls: "bg-brandblue-soft text-brandblue" },
    negotiating: { text: "Negotiating", cls: "bg-brandred-soft text-brandred" },
    "offer-received": { text: "Offer in", cls: "bg-savings-soft text-savings" },
    "counter-offer": { text: "Counter sent", cls: "bg-brandred-soft text-brandred" },
    "no-response": { text: "No response", cls: "bg-card2 text-faint" },
    // Amber, not red: they have nothing TODAY. A decline is a closed door; this
    // one reopens the moment they restock, and the agent has asked when.
    "out-of-stock": {
      text: "Out of stock",
      cls: "bg-brandyellow-soft text-warn",
    },
    declined: { text: "Declined", cls: "bg-brandred-soft text-brandred" },
  };
  const s = map[stage];
  const live =
    stage === "replied" ||
    stage === "negotiating" ||
    stage === "counter-offer" ||
    stage === "awaiting-response" ||
    stage === "locating-contact";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${s.cls}`}
    >
      {live && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-current opacity-70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {t(s.text)}
    </span>
  );
}

/**
 * Plain-language, reassuring line describing what the AI agent is doing right
 * now - so the user always knows what step we are on and feels in control while
 * the agent does the work. English strings; translate at the call site with t().
 */
export function stageCaption(stage: TrackerStage): { emoji: string; text: string } {
  switch (stage) {
    case "queued":
      return { emoji: "🕓", text: "Queued - your agent starts on this shop in a moment." };
    case "locating-contact":
      return { emoji: "🔎", text: "Your agent is finding this shop's WhatsApp number." };
    case "found":
      return { emoji: "🎯", text: "Shop found - ask for the price and your agent takes it from there." };
    case "no-contact":
      return { emoji: "📵", text: "No WhatsApp number found for this shop - a nearby shop may work better." };
    case "rfq-sent":
      return { emoji: "📨", text: "Your agent messaged the shop asking for the best price." };
    case "awaiting-response":
      return { emoji: "⏳", text: "Waiting for the shop to reply - your agent is watching for it." };
    case "replied":
      // HONEST, AND SPECIFICALLY NOT "pinning the exact price down" - the
      // caption the owner photographed over a shop that had said hello. At
      // this stage the ledger has an inbound and no actionable fact yet.
      return { emoji: "💬", text: "The shop answered - your agent is reading their reply." };
    case "negotiating":
      return { emoji: "🤝", text: "Your agent is haggling with the shop for a lower price." };
    case "offer-received":
      return { emoji: "✅", text: "Price is in - review the shop's offer below." };
    case "counter-offer":
      return { emoji: "🔁", text: "Your agent countered the shop's quote - pushing for a better price." };
    case "no-response":
      return { emoji: "💤", text: "No reply yet. Your agent will keep watching for one." };
    case "out-of-stock":
      return {
        emoji: "📭",
        text: "No vehicle available here right now - your agent asked when one is back.",
      };
    case "declined":
      return { emoji: "🚫", text: "This shop passed - other shops are still negotiating." };
    default:
      return { emoji: "🤖", text: "Your agent is on it." };
  }
}

/** Horizontal pipeline showing progress through the negotiation flow. */
export function Pipeline({ stage }: { stage: TrackerStage }) {
  const idx = ORDER.indexOf(stage);
  // Out of stock stops the pipeline like a decline does - the difference is
  // that it is temporary, which the badge and the caption both say.
  const failed =
    stage === "no-response" ||
    stage === "declined" ||
    stage === "no-contact" ||
    stage === "out-of-stock";
  return (
    <div className="flex items-center gap-1">
      {FLOW.map((step) => {
        const stepIdx = ORDER.indexOf(step.key);
        const done = idx >= stepIdx && !failed;
        const active = stage === step.key;
        return (
          <div key={step.key} className="flex flex-1 items-center gap-1">
            <div
              className={`h-1.5 flex-1 rounded-full transition-colors duration-500 ${
                done ? "bg-brandblue" : failed ? "bg-brandred/40" : "bg-line"
              } ${active ? "animate-pulse" : ""}`}
            />
          </div>
        );
      })}
    </div>
  );
}
