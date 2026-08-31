// THE BUSINESS-NUMBER HANDOFF - the flag, and nothing else yet.
//
// Plan Part 12. WheelDeal's own official WhatsApp Business number sends the
// first message to a rental agency; the agency then messages the traveller
// directly; our ingest detects that inbound and the AI agents take over from
// the traveller's own number.
//
// THIS SHIPS OFF, AND THAT IS A HARD REQUIREMENT, NOT A DEFAULT.
//
// The owner's instruction is explicit: the existing engine - where the
// traveller's own number makes first contact - stays the live path. The
// official route is built, wired and testable under the hood, and is activated
// by pasting credentials into Admin -> Keys and flipping one switch. So:
//
//   With WABA_ENABLED unset or "off", not one code path changes behaviour, no
//   new table is read, and no new request leaves the process. A fresh clone
//   with no configuration behaves exactly as it does today.
//
// That invariant is pinned by a test, because it is the one a future edit is
// most likely to break by "simplifying" a branch.
//
// WHY AN ADAPTER BOUNDARY RATHER THAN A DIRECT INTEGRATION.
//
// The owner has no registered legal entity, so access is bought through a
// reseller and the WABA is RENTED: it sits under the provider's verified
// portfolio, and the provider can suspend it. Two consequences shape this
// module. Quality rating stops being a metric and becomes an existential asset,
// which is why the governor treats it as a budget. And the migration path to a
// directly-owned account has to stay open from day one - which is what this
// boundary is for. Every reseller proxies the Cloud API underneath, so the Meta
// dialect is the reference implementation and a reseller is a variation on it.

import "server-only";
import { getConfig } from "../runtime-config";

export type WabaProvider = "meta" | "reseller";

export interface WabaConfig {
  enabled: boolean;
  provider: WabaProvider;
  baseUrl: string;
  apiKey: string;
  senderId: string;
  templateFirstContact: string;
  templateReengage: string;
  /**
   * The approved template's LANGUAGE code, exactly as Meta lists it (`en`,
   * `en_US`, `th`).
   *
   * It was hardcoded "en" at the send site, so an owner whose template was
   * approved as en_US had no way to correct it without a redeploy - and every
   * single template send answered error 132001. Unset keeps that old value, so
   * this key is purely additive.
   */
  templateLanguage: string;
  linkBase: string;
  /** Renders and logs the exact wire text, sends nothing. Ships ON. */
  dryRun: boolean;
}

/** Why the official path is not currently usable, in words the console shows. */
export type WabaBlockReason =
  | "flag-off"
  | "missing-credentials"
  | "missing-template"
  | "missing-link-base"
  | null;

const truthy = (v: string | undefined | null) => {
  const s = (v ?? "").trim().toLowerCase();
  return s === "on" || s === "1" || s === "true" || s === "yes";
};

export async function wabaConfig(): Promise<WabaConfig> {
  const [
    enabled,
    provider,
    baseUrl,
    apiKey,
    senderId,
    templateFirstContact,
    templateReengage,
    templateLanguage,
    linkBase,
    dryRun,
  ] = await Promise.all([
    getConfig("WABA_ENABLED"),
    getConfig("WABA_PROVIDER"),
    getConfig("WABA_BASE_URL"),
    getConfig("WABA_API_KEY"),
    getConfig("WABA_SENDER_ID"),
    getConfig("WABA_TEMPLATE_FIRST_CONTACT"),
    getConfig("WABA_TEMPLATE_REENGAGE"),
    getConfig("WABA_TEMPLATE_LANGUAGE"),
    getConfig("WABA_LINK_BASE"),
    getConfig("WABA_DRY_RUN"),
  ]);

  return {
    // Absent means OFF. This is the opposite of the warm-up gate's default, and
    // deliberately so: an unset gate should still qualify buyers, but an unset
    // messaging integration must never start sending on a rented account.
    enabled: truthy(enabled),
    provider: (provider ?? "").trim().toLowerCase() === "reseller" ? "reseller" : "meta",
    baseUrl: (baseUrl ?? "").trim().replace(/\/+$/, ""),
    apiKey: (apiKey ?? "").trim(),
    senderId: (senderId ?? "").trim(),
    templateFirstContact: (templateFirstContact ?? "").trim(),
    templateReengage: (templateReengage ?? "").trim(),
    templateLanguage: (templateLanguage ?? "").trim() || "en",
    linkBase: (linkBase ?? "").trim().replace(/\/+$/, ""),
    // DRY RUN SHIPS ON, and stays on until someone deliberately turns it off.
    // The whole pipeline is buildable and testable without spending a single
    // point of quality rating on a rented account, and the first live send
    // should be a decision rather than a side effect of pasting a key.
    dryRun: dryRun === null || dryRun === undefined || dryRun === "" ? true : truthy(dryRun),
  };
}

/**
 * Why the official path cannot run right now, or null if it can.
 *
 * CREDENTIAL ABSENCE IS EQUIVALENT TO THE FLAG BEING OFF, and says so. A
 * half-configured integration that silently half-sends is worse than one that
 * refuses: on a rented WABA, a malformed first contact costs quality rating we
 * cannot buy back.
 */
export function wabaBlockReason(c: WabaConfig): WabaBlockReason {
  if (!c.enabled) return "flag-off";
  if (!c.baseUrl || !c.apiKey || !c.senderId) return "missing-credentials";
  if (!c.templateFirstContact) return "missing-template";
  // The link base is the approved button target. Sending a template whose button
  // points nowhere wastes the one contact per agency per day that the governor
  // allows, so it is a hard prerequisite rather than a warning.
  if (!c.linkBase) return "missing-link-base";
  return null;
}

/** The one question every caller asks: may the official path act at all? */
export async function wabaReady(): Promise<boolean> {
  const c = await wabaConfig();
  return wabaBlockReason(c) === null;
}

export const WABA_BLOCK_LABELS: Record<NonNullable<WabaBlockReason>, string> = {
  "flag-off": "Switched off - set WABA_ENABLED to on once credentials are in.",
  "missing-credentials": "Credentials incomplete - base URL, API key and sender id are all required.",
  "missing-template": "No approved first-contact template selected.",
  "missing-link-base": "No handoff link base set - the template button would point nowhere.",
};
