// TRANSPORT RESOLUTION - which wire carries this thread.
//
// Two-level authority, in this order:
//   1. THE THREAD'S OWN STAMP (negotiation_threads.fields.transport). A
//      conversation NEVER changes transport mid-thread: the shop is talking
//      to one identity, and swapping the sender under a live negotiation is
//      both a trust break and a Meta-policy signal. Immutable once set - the
//      stamp is written when a thread's first contact goes out.
//   2. THE GLOBAL MODE (TRANSPORT_MODE, owner-set, no redeploy):
//        "evolution"     - the traveller's own linked WhatsApp (default).
//        "waba-first"    - first contact via the company-number lead handoff
//                          whenever the WABA lane is ready for that shop.
//        "waba-fallback" - WABA only when the traveller's Evolution is not
//                          linked (the recommended rollout).
//      The mode governs FIRST-CONTACT routing only. The reply leg of a
//      handed-off thread is still the traveller's Evolution instance - the
//      handoff's whole point is that the shop messages the traveller.
//
// Kill switches are unaffected: KILL_SWITCH and WABA_KILL are enforced inside
// the send paths and the governor, not here - resolution says which adapter,
// never whether sending is currently allowed.

import type { Transport, TransportKind } from "../transport";
import { evolutionTransport } from "./evolution";
import { wabaTransport } from "./waba";

export type TransportMode = "evolution" | "waba-first" | "waba-fallback";

export function transportByKind(kind: TransportKind): Transport {
  // "cloud" (the legacy owner-number Cloud API sender in lib/whatsapp.ts) is
  // deliberately NOT an adapter: it is ungoverned by the WABA governor, and
  // making it selectable here would arm a second live company sender the
  // moment someone typos a mode. It stays reachable only through its own
  // explicit call sites until it earns a governed adapter.
  return kind === "waba" ? wabaTransport : evolutionTransport;
}

export function parseTransportMode(raw: unknown): TransportMode {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "waba-first" || v === "waba-fallback" ? v : "evolution";
}

/** The stored per-thread stamp, when one exists. Exported for tests. */
export function stampedKind(fields: unknown): TransportKind | undefined {
  const t = (fields as { transport?: unknown } | null)?.transport;
  return t === "evolution" || t === "waba" || t === "cloud" ? t : undefined;
}

/**
 * Resolve the transport for a (traveller, shop) thread.
 *
 * Never throws; every unreadable input degrades to the evolution default -
 * the transport that has carried every message to date, i.e. the status quo.
 */
export async function resolveTransport(
  senderKey: string,
  toDigits?: string
): Promise<{ transport: Transport; source: "thread-stamp" | "mode" | "default" }> {
  // 1. The thread's own stamp.
  if (senderKey && toDigits) {
    try {
      const { digitsOnly } = await import("../../phone");
      const { sbSelect } = await import("../../runtime-config");
      const key = `${senderKey}:${digitsOnly(toDigits)}`;
      const rows = await sbSelect<{ fields: Record<string, unknown> | null }>(
        "negotiation_threads",
        `select=fields&thread_key=eq.${encodeURIComponent(key)}&limit=1`
      );
      const kind = stampedKind(rows[0]?.fields);
      if (kind) return { transport: transportByKind(kind), source: "thread-stamp" };
    } catch {
      /* unreadable stamp -> fall through to the mode */
    }
  }

  // 2. The global mode. WABA modes only route when the lane is actually ready
  //    (config present and not killed) - a flipped flag with no WABA behind it
  //    must degrade to the working transport, never to dead air.
  try {
    const { getConfig } = await import("../../runtime-config");
    const mode = parseTransportMode(await getConfig("TRANSPORT_MODE"));
    if (mode === "waba-first" || mode === "waba-fallback") {
      const { wabaConfig, wabaBlockReason } = await import("../../waba/config");
      const c = await wabaConfig();
      const ready = !wabaBlockReason(c);
      if (mode === "waba-first" && ready) {
        return { transport: wabaTransport, source: "mode" };
      }
      if (mode === "waba-fallback" && ready) {
        const { evolutionConfigured, hasSessionRow } = await import("../../evolution");
        const linked = (await evolutionConfigured()) && (await hasSessionRow(senderKey));
        if (!linked) return { transport: wabaTransport, source: "mode" };
      }
    }
  } catch {
    /* unreadable mode -> the default below */
  }

  return { transport: evolutionTransport, source: "default" };
}