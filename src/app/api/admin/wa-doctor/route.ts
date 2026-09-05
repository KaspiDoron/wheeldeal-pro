// WA DOCTOR (management-only): a one-tap incident tracer for the inbound
// pipeline. GET returns a full checklist for a user (and, optionally, a specific
// shop number): host health, live connection, the webhook URL Evolution ACTUALLY
// holds vs what we expect (token current/foreign/none), and - per number - the
// exact ingest-gate verdict WITH the reason, the RFQ-thread presence,
// takeover/pause holds, recent inbound, and the last silent-drop trace. POST
// {action:"rearm"} force-re-arms the webhook. This turns the next "shops replied
// but nothing happened" incident into one click instead of screenshot forensics.

import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { webhookDiagnostics, reassertWebhook, instanceNameFor } from "@/lib/evolution";
import { classifyIngestDetailed, type GateRaw } from "@/lib/wa/thread-gate";
import { threadNumberOr, sameNumber } from "@/lib/wa/phone-key";
import { resolveThreadContext } from "@/lib/wa/thread-context";
import { isThreadTakenOver, isSessionPaused } from "@/lib/session-flags";
import { digitsOnly } from "@/lib/phone";
import { trustedRequestOrigin } from "@/lib/request-origin";
import { pushDiagnostics } from "@/lib/push";
import { turnLatencyStats, replyLatencyStats } from "@/lib/wa/turn-latency";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const number = digitsOnly(url.searchParams.get("number") || "");
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const enc = encodeURIComponent(email);
  // Forwarded-aware AND allow-listed: this origin reaches webhookDiagnostics,
  // which is the same path that can RE-ARM a webhook URL. Owner-only or not, a
  // header must not be able to choose where the token gets registered. It still
  // works before APP_DOMAIN is saved as long as the host is one the owner
  // controls (site origin or TRUSTED_HOSTS); the canonicalizer prefers
  // APP_DOMAIN over it regardless.
  const reqOrigin = (await trustedRequestOrigin(req)) ?? undefined;
  const [diag, sessionRow, waOk, wa403, push, latencyRows, replyLatencyRows, claimsTable] =
    await Promise.all([
    webhookDiagnostics(email, reqOrigin).catch(() => null),
    sbSelect<{ status: string | null; host_url: string | null; updated_at: string | null }>(
      "wa_sessions",
      `select=status,host_url,updated_at&email=eq.${enc}&limit=1`
    ).catch(() => []),
    sbSelect<{ created_at: string }>(
      "agent_events",
      `select=created_at&kind=eq.webhook-ok&order=created_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ created_at: string }>(
      "agent_events",
      `select=created_at&kind=eq.webhook-403&order=created_at.desc&limit=1`
    ).catch(() => []),
    // "Shops replied but my phone never buzzed" is a DIFFERENT incident from
    // "shops replied and nothing happened", and until now the doctor could not
    // tell them apart - so a broken VAPID pair looked like a broken webhook.
    pushDiagnostics(email).catch(() => null),
    // How fast this user's agent ACTUALLY answers engaged shops. The composer's
    // pacing delay was always visible; the chain time before it never was, so
    // "replies feel slow" had no number attached to it.
    sbSelect<{ detail: string | null }>(
      "agent_events",
      `select=detail&kind=eq.turn-latency&user_email=eq.${enc}&order=created_at.desc&limit=50`
    ).catch(() => []),
    // ...and how fast replies ACTUALLY hit the wire (inbound -> delivered,
    // wall clock, stamped by the drain). turn-latency is the intended number;
    // this is the observed one - the difference is time spent held in the
    // queue, which the owner could previously only infer from screenshots.
    sbSelect<{ detail: string | null }>(
      "agent_events",
      `select=detail&kind=eq.reply-latency&user_email=eq.${enc}&order=created_at.desc&limit=50`
    ).catch(() => []),
    // The atomic pacing table. Before it existed the guard failed OPEN, so a
    // deployment that skipped the migration silently lost every concurrency
    // floor while every other check stayed green.
    sbSelect<{ slot_key: string }>("wa_send_claims", "select=slot_key&limit=1")
      .then(() => true)
      .catch(() => false),
  ]);

  const report: Record<string, unknown> = {
    email,
    instance: instanceNameFor(email),
    hosts: diag?.hosts ?? [],
    session: {
      status: sessionRow[0]?.status ?? null,
      hostUrl: sessionRow[0]?.host_url ?? null,
      updatedAt: sessionRow[0]?.updated_at ?? null,
    },
    liveState: diag?.liveState ?? null,
    webhook: {
      ...(diag?.webhook ?? { expectedUrl: null, registeredUrl: null, tokenState: "none", originMatch: null }),
      lastAcceptedAt: waOk[0]?.created_at ?? null,
      last403At: wa403[0]?.created_at ?? null,
    },
    push,
    speed: {
      ...turnLatencyStats(latencyRows.map((r) => r.detail)),
      claimsTable,
      // Observed inbound->wire percentiles - the queue's own testimony.
      wire: replyLatencyStats(replyLatencyRows.map((r) => r.detail)),
    },
  };

  // ---- Optional per-number thread trace (the "why no reply" answer) ---------
  if (number) {
    const encNum = encodeURIComponent(number);
    const outOr = threadNumberOr("to_number", number);
    const inOr = threadNumberOr("from_number", number);
    const [outbound, inbound, dropTrace] = await Promise.all([
      // TOLERANT matching, exactly like the engine. An exact `to_number=eq.`
      // read here could show "0 anchors" for a thread the resolver finds fine
      // (or vice versa) because a shop's number may be stored in a national
      // spelling - a doctor that disagrees with the engine sends you hunting
      // the wrong bug.
      sbSelect<{ received_at: string; raw: GateRaw | null }>(
        "whatsapp_messages",
        `select=received_at,raw&direction=eq.outbound&raw->>sender=eq.${enc}&order=received_at.desc&limit=10${
          outOr ? `&or=${outOr}` : `&to_number=eq.${encNum}`
        }`
      ).catch(() => []),
      sbSelect<{ id: number; received_at: string }>(
        "whatsapp_messages",
        `select=id,received_at&direction=eq.inbound&raw->>receiver=eq.${enc}&order=received_at.desc&limit=5${
          inOr ? `&or=${inOr}` : `&from_number=eq.${encNum}`
        }`
      ).catch(() => []),
      sbSelect<{ created_at: string; detail: string | null }>(
        "agent_events",
        `select=created_at,detail&kind=eq.inbound-dropped&user_email=eq.${enc}&order=created_at.desc&limit=5`
      ).catch(() => []),
    ]);

    const gate = classifyIngestDetailed(
      outbound.map((o) => ({ received_at: o.received_at, raw: o.raw })),
      Date.now()
    );
    // THE ANCHOR VERDICT MUST COME FROM THE ENGINE'S OWN RESOLVER. This used to
    // be `outbound[0]?.raw?.rfq != null` - the newest row only - which is the
    // exact predicate resolveThreadContext was written to replace. So the doctor
    // could report "RFQ anchor MISSING" on a thread the agent handles perfectly
    // (any rfq-less row on top), or the reverse. One predicate, one truth.
    const resolved = await resolveThreadContext(number, email).catch(() => null);
    const [takenOver, paused] = await Promise.all([
      isThreadTakenOver(email, number).catch(() => null),
      isSessionPaused(email).catch(() => null),
    ]);
    // ONLY this number's drop traces, matched STRUCTURALLY. The old substring
    // scan (`detail.includes(number)`) could never see an @lid drop - the one
    // failure mode this tool exists to find - because an @lid trace carries
    // `digits: null` and only a `lid` field, whose digits are (by the privacy
    // keystone) NOT the phone number. The trace detail is JSON; read it as
    // JSON: digits match tolerantly (any spelling), and a lid matches the
    // shop's lid learned from our OWN outbound anchor.
    const { lidAliasForShop } = await import("@/lib/wa/lid-alias");
    const shopLid = await lidAliasForShop(email, number).catch(() => "");
    // A privacy-gate drop (audit F173) stores NO digits - only a hash of the
    // spelling-normalised number - so the asked-for number is hashed the same
    // way and compared; the drop of a shop refused by the vendor gate is
    // still findable, while the row itself never names a personal contact.
    const { dropDigitsHash } = await import("@/lib/wa/drop-privacy");
    const askedHash = dropDigitsHash(number);
    const lastDrop =
      dropTrace.find((d) => {
        try {
          const det = JSON.parse(d.detail ?? "{}") as {
            digits?: unknown;
            digitsHash?: unknown;
            lid?: unknown;
          };
          if (typeof det.digits === "string" && det.digits && sameNumber(det.digits, number))
            return true;
          if (typeof det.digitsHash === "string" && det.digitsHash === askedHash) return true;
          if (shopLid && typeof det.lid === "string" && det.lid === shopLid) return true;
        } catch {}
        return false;
      }) ?? null;

    // The shop's profile picture, and - when there is none - WHY. Every avatar
    // on the board came back blank in the field while the shops plainly had
    // photos in WhatsApp; without the upstream reason there was nothing to act
    // on from a phone. `error` absent means "this shop simply has no picture".
    const avatar = await import("@/lib/evolution")
      .then((m) => m.fetchProfilePicture(email, number))
      .catch((e) => ({ url: null, error: e instanceof Error ? e.message : "failed" }));

    report.thread = {
      digits: number,
      avatar: { found: Boolean(avatar.url), error: avatar.error ?? null },
      anchors: outbound.map((o) => ({
        at: o.received_at,
        kind: o.raw?.kind ?? null,
        hasRfq: o.raw?.rfq != null,
      })),
      gate: { ingestible: gate.ok, reason: gate.reason },
      // What the AGENT sees, not what the newest row happens to carry.
      ctxRfqPresent: resolved?.rfq != null,
      /** true when the anchor came from self-healing recovery, not a stored row. */
      anchorRepaired: resolved?.repaired === true,
      takenOver,
      paused,
      recentInbound: inbound.map((i) => ({ at: i.received_at, id: String(i.id) })),
      lastDropTrace: lastDrop
        ? { at: lastDrop.created_at, detail: lastDrop.detail ?? "" }
        : null,
    };
  }

  return NextResponse.json(report);
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (action !== "rearm" || !email) {
    return NextResponse.json({ error: "action:rearm + email required" }, { status: 400 });
  }
  // THIS is the call that writes a webhook URL - with the token in it - onto
  // Evolution. Forwarded-aware so it works from the live public host before
  // APP_DOMAIN is saved, but ALLOW-LISTED, because a header must never choose
  // where the token is registered. canonicalWebhookOrigin still prefers
  // APP_DOMAIN and still rejects unroutable bind addresses on top of this.
  const result = await reassertWebhook(email, {
    force: true,
    requestOrigin: (await trustedRequestOrigin(req)) ?? undefined,
  }).catch((e) => ({
    ok: false,
    changed: false,
    registeredUrl: null,
    error: e instanceof Error ? e.message : "rearm failed",
  }));
  return NextResponse.json(result);
}
