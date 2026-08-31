// What a held lead says when its agency finally opens the window.
//
// The free-form lane has NO content restrictions - no template, no review, no
// category - which is exactly where the informal register the owner asked for
// becomes available. "Hey, got someone looking for a scooter for 4 days, can
// you message them?" is entirely sendable here, and since the service-window
// flush carries most of the traffic, most of what we send can be written this
// way. The template is only ever the first contact with a given agency in a day.
//
// It is worth being precise about what this does and does not buy, because the
// distinction was researched and the answer is uncomfortable. It does NOT make
// the account look like a person: an API-connected number renders in the
// recipient's client with business-account treatment we do not control, the
// display name is a Meta-certified string that cannot be cycled, and attempting
// concealment on a rented WABA is how the reseller terminates us. What it does
// buy is TONE - a short, human, specific message instead of a form letter - and
// tone is the part that was actually moving reply rate all along.

import type { Lead } from "./leads";

export interface HeldRender {
  vehicle: string;
  dates: string;
  language?: string;
  freeformText: string;
  agencyName?: string;
}

/**
 * Default renderer for a held lead.
 *
 * Deliberately plain and specific rather than clever: a named vehicle and real
 * dates are what make a message answerable, and Part 5.12 found that an
 * unanswerable opener is read as reseller fishing - the exact message people
 * block rather than reply to. That finding does not stop applying because the
 * sender changed - and this function used to VIOLATE it: no vehicle, no dates,
 * no link, just "we have a customer looking to rent". The specifics come from
 * the lead's own anchor row (raw.rfq via thread_key), and the tap target is
 * the lead's link - the same one the template's button carries, so the flush
 * is exactly as actionable as the paid lane.
 */
export async function renderHeldHandoff(lead: Lead): Promise<HeldRender> {
  const shop = lead.agency_name?.trim();
  const hello = shop ? `Hi ${shop} - ` : "Hi - ";
  let vehicle = "vehicle";
  let dates = "";
  // THE HOLD'S OWN PAYLOAD FIRST. A held lead never sent anything, so the
  // anchor read below usually finds nothing for it - but the dispatcher now
  // captures the real composed opener on the hold itself (rung 4's payload),
  // and the flush should say exactly what the traveller's agent composed
  // rather than reconstructing a vaguer version. The link still rides along.
  const stored = lead.fallback?.text?.trim();
  if (stored) {
    const r = lead.fallback?.rfq as { vehicleClass?: string; engineSizeCc?: number; durationDays?: number } | null | undefined;
    if (r?.vehicleClass) vehicle = `${r.engineSizeCc ? `${r.engineSizeCc}cc ` : ""}${r.vehicleClass}`;
    if (typeof r?.durationDays === "number" && r.durationDays > 0) {
      dates = `${r.durationDays} ${r.durationDays === 1 ? "day" : "days"}`;
    }
    let link = "";
    try {
      const { wabaConfig } = await import("./config");
      const c = await wabaConfig();
      if (lead.link_token && c.linkBase) link = ` Their request: ${c.linkBase}/${lead.link_token}`;
    } catch {
      /* no link - the stored opener still stands on its own */
    }
    return {
      vehicle,
      dates,
      agencyName: lead.agency_name ?? undefined,
      freeformText: `${stored}${link}`,
    };
  }
  try {
    const key = lead.thread_key ?? "";
    const idx = key.lastIndexOf(":");
    if (idx > 0) {
      const email = key.slice(0, idx);
      const digits = key.slice(idx + 1);
      const { sbSelect } = await import("../runtime-config");
      const rows = await sbSelect<{
        raw: { rfq?: { vehicleClass?: string; engineSizeCc?: number; durationDays?: number } } | null;
      }>(
        "whatsapp_messages",
        `select=raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
          digits
        )}&raw->>sender=eq.${encodeURIComponent(email)}&order=received_at.desc&limit=5`
      );
      const rfq = rows.find((r) => r.raw?.rfq)?.raw?.rfq;
      if (rfq?.vehicleClass) {
        vehicle = `${rfq.engineSizeCc ? `${rfq.engineSizeCc}cc ` : ""}${rfq.vehicleClass}`;
      }
      if (typeof rfq?.durationDays === "number" && rfq.durationDays > 0) {
        dates = `${rfq.durationDays} ${rfq.durationDays === 1 ? "day" : "days"}`;
      }
    }
  } catch {
    /* the generic line still goes out - better vague than silent */
  }
  let link = "";
  try {
    const { wabaConfig } = await import("./config");
    const c = await wabaConfig();
    if (lead.link_token && c.linkBase) link = ` Their request: ${c.linkBase}/${lead.link_token}`;
  } catch {
    /* no link - the message still names the vehicle and dates */
  }
  return {
    vehicle,
    dates,
    agencyName: lead.agency_name ?? undefined,
    freeformText:
      `${hello}we have a customer looking to rent a ${vehicle}` +
      `${dates ? ` for ${dates}` : ""}. ` +
      `Could you message them directly to share your prices?${link} Thanks!`,
  };
}

/**
 * Template-variable labels from a structured RFQ the caller already holds.
 *
 * Same derivation as renderHeldHandoff's anchor read, for the dispatch call
 * sites (outreach + mass) that have the rfq in hand. Every value must satisfy
 * the templateVariables contract: usable when the rfq is vague, and never a
 * bare phone number.
 */
export function rfqLabels(rfq: unknown): { vehicle: string; dates: string } {
  const r = (rfq ?? {}) as {
    vehicleClass?: string;
    engineSizeCc?: number;
    durationDays?: number;
    startDate?: string;
  };
  const vehicle = r.vehicleClass
    ? `${r.engineSizeCc ? `${r.engineSizeCc}cc ` : ""}${r.vehicleClass}`
    : "vehicle";
  const days =
    typeof r.durationDays === "number" && r.durationDays > 0
      ? `${r.durationDays} ${r.durationDays === 1 ? "day" : "days"}`
      : "";
  const dates = r.startDate
    ? `from ${r.startDate}${days ? ` for ${days}` : ""}`
    : days || "their dates";
  return { vehicle, dates };
}

/**
 * What the agency's chat with the traveller opens pre-filled.
 *
 * Authored by us on purpose. When that message lands on the traveller's phone it
 * carries a phrase our ingest can recognise, which is what covers the common
 * case of an agency replying from a staff mobile rather than the number we
 * templated - tail matching alone would miss it entirely.
 */
export function prefilledOpener(agencyName?: string | null): string {
  const who = agencyName?.trim();
  return who
    ? `Hi, this is ${who} - you were looking to rent a vehicle?`
    : "Hi, you were looking to rent a vehicle?";
}

/**
 * The other half of the authored-opener contract: does an inbound text READ AS
 * our prefilled opener, and which agency does it claim to be?
 *
 * This is what covers the staff-mobile case: the agency taps the link on the
 * shop phone but replies from a personal device, so the number-tail
 * authorisation (waba/expectation) finds no lead. The phrase we authored is
 * then the only evidence that this stranger is the shop we asked to call - and
 * because WE wrote it, matching it is a contract, not a heuristic.
 *
 * Deliberately strict: the core phrase must be present, the message must be
 * SHORT (a staff intro, not an essay quoting our words), and a claimed agency
 * name is extracted only from the exact authored shape. The consumer
 * (wabaExpectsOpener) still requires a live dispatched lead - the phrase alone
 * authorises nothing.
 */
export function openerMatch(text: string | null | undefined): {
  match: boolean;
  agencyName?: string;
} {
  const t = (text ?? "").trim();
  if (!t || t.length > 200) return { match: false };
  if (!/you were looking to rent a vehicle\?/i.test(t)) return { match: false };
  const named = /this is\s+(.{1,60}?)\s*[-,]\s*you were looking to rent a vehicle\?/i.exec(t);
  const name = named?.[1]?.trim();
  return { match: true, ...(name ? { agencyName: name } : {}) };
}
