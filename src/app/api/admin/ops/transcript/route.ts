import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { sbSelectDark } from "@/lib/runtime-config";

// Ops Center: ONE negotiation exactly as it happened, cross-user (owner only).
// The bilingual transcript is joined app-side to the decisions that produced
// each outbound message (raw.decisionId), and every decision comes back with
// its full stage trace, director ladder, latency, judge scores and reviews -
// the complete "why" behind every message.

interface WaRow {
  id: number;
  body: string | null;
  received_at: string;
  raw: {
    englishGloss?: string;
    english?: string;
    kind?: string;
    decisionId?: string;
    nodeId?: string;
    round?: number;
  } | null;
}

interface TraceDbRow {
  decision_id: string;
  stage: string;
  input: string | null;
  reasoning: string | null;
  output: string | null;
  verdict: string | null;
  node_id: string | null;
  edge_id: string | null;
  ms: number | null;
  spec_rev: number | null;
  created_at: string;
}

export interface LadderRung {
  e: string;
  l: string;
  k: string;
  legal: boolean;
  chosen: boolean;
  why: string;
}

export async function GET(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });

  const url = new URL(req.url);
  const threadKey = (url.searchParams.get("threadKey") ?? "").trim();
  const idx = threadKey.lastIndexOf(":");
  if (idx <= 0) return NextResponse.json({ error: "threadKey required" }, { status: 400 });
  const userEmail = threadKey.slice(0, idx);
  const digits = threadKey.slice(idx + 1);

  // FAIL DARK: every read here used the permissive sbSelect, whose [] means
  // "missing connection", "non-2xx" and "threw" alike - so an outage rendered
  // an EMPTY conversation with a 200 and the panel's error card never showed.
  // null now means unreadable; each failed leg lands in `degraded` and the
  // panel renders the shared banner over whatever could still be read.
  const [outs, ins, thread, scores, reviews, queued] = await Promise.all([
    sbSelectDark<WaRow>(
      "whatsapp_messages",
      // NEWEST first (then causally re-sorted below): asc&limit took the
      // OLDEST 80, so a long negotiation's live tail - the part the owner
      // opens the transcript FOR - silently fell off the end.
      `select=id,body,received_at,raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
        digits
      )}&raw->>sender=eq.${encodeURIComponent(userEmail)}&order=received_at.desc&limit=80`
    ),
    sbSelectDark<WaRow>(
      "whatsapp_messages",
      // PRIVACY: only the inbound THIS thread's user received - a drill or a
      // second user on the same shop number must never bleed in.
      `select=id,body,received_at,raw&direction=eq.inbound&from_number=eq.${encodeURIComponent(
        digits
      )}&raw->>receiver=eq.${encodeURIComponent(userEmail)}&order=received_at.desc&limit=80`
    ),
    sbSelectDark<{
      phase: string;
      stage: string | null;
      vendor_id: string | null;
      fields: Record<string, unknown> | null;
      last_decision_id: string | null;
      waiting_until: string | null;
      updated_at: string;
    }>(
      "negotiation_threads",
      `select=phase,stage,vendor_id,fields,last_decision_id,waiting_until,updated_at&thread_key=eq.${encodeURIComponent(
        threadKey
      )}&limit=1`
    ),
    sbSelectDark<{
      decision_id: string | null;
      node_id: string | null;
      scorer: string;
      scores: Record<string, number> | null;
      verdict: string | null;
      spec_rev: number | null;
      created_at: string;
    }>(
      "agent_scores",
      `select=decision_id,node_id,scorer,scores,verdict,spec_rev,created_at&thread_key=eq.${encodeURIComponent(
        threadKey
      )}&order=created_at.desc&limit=40`
    ),
    sbSelectDark<Record<string, unknown>>(
      "agent_reviews",
      `select=*&thread_key=eq.${encodeURIComponent(threadKey)}&order=created_at.desc&limit=60`
    ),
    sbSelectDark<{ body: string; not_before: string; meta: { reason?: string } | null }>(
      "wa_outbox",
      `select=body,not_before,meta&sender_key=eq.${encodeURIComponent(
        userEmail
      )}&to_number=eq.${encodeURIComponent(digits)}&order=not_before.asc&limit=5`
    ),
  ]);

  const degraded: string[] = [];
  if (outs === null) degraded.push("outbound messages");
  if (ins === null) degraded.push("inbound messages");
  if (thread === null) degraded.push("thread state");
  if (scores === null) degraded.push("judge scores");
  if (reviews === null) degraded.push("reviews");
  if (queued === null) degraded.push("queued sends");

  // OFFERS JOIN ON THE REAL KEY. offers.vendor_id is the discovery vendor id,
  // never the shop's phone - `vendor_id=eq.<digits>` matched only threads
  // whose vendorId happened to literally BE the digits, so the price panel
  // read empty on almost every healthy thread. The thread row carries the
  // real id; digits stay as the fallback for a vendor-less row (where the
  // old behavior was the only behavior). Dependent read, so it runs after.
  const offerVendorId = (thread ?? [])[0]?.vendor_id || digits;
  const offers = await sbSelectDark<{
    price_per_day: number;
    list_price_per_day: number | null;
    currency: string;
    round: number | null;
    verified: boolean | null;
    created_at: string;
  }>(
    "offers",
    `select=price_per_day,list_price_per_day,currency,round,verified,created_at&user_email=eq.${encodeURIComponent(
      userEmail
    )}&vendor_id=eq.${encodeURIComponent(offerVendorId)}&order=created_at.asc&limit=20`
  );
  if (offers === null) degraded.push("offers");

  const messages = [
    ...(outs ?? []).map((m) => ({
      id: `o${m.id}`,
      dir: "out" as const,
      text: m.body ?? "",
      english: m.raw?.englishGloss,
      kind: m.raw?.kind,
      decisionId: m.raw?.decisionId ?? null,
      nodeId: m.raw?.nodeId ?? null,
      round: m.raw?.round ?? null,
      at: m.received_at,
    })),
    ...(ins ?? []).map((m) => ({
      id: `i${m.id}`,
      dir: "in" as const,
      text: m.body ?? "",
      english: m.raw?.english,
      kind: undefined as string | undefined,
      decisionId: null,
      nodeId: null,
      round: null,
      at: m.received_at,
    })),
  ];
  // Deterministic causal ordering (same-second rows: inbound first, then id) -
  // the plain timestamp sort rendered replies above their questions.
  const { sortTranscript } = await import("@/lib/ops/transcript-sort");
  const ordered = sortTranscript(messages);

  // Every decision referenced by a message (plus the thread's last one) gets
  // its full trace: stages in order, the parsed director ladder, latency.
  const decisionIds = Array.from(
    new Set(
      [...ordered.map((m) => m.decisionId), (thread ?? [])[0]?.last_decision_id].filter(
        (x): x is string => Boolean(x)
      )
    )
  ).slice(-40);

  const traceRaw = decisionIds.length
    ? await sbSelectDark<TraceDbRow>(
        "agent_traces",
        `select=decision_id,stage,input,reasoning,output,verdict,node_id,edge_id,ms,spec_rev,created_at&decision_id=in.(${decisionIds
          .map((d) => encodeURIComponent(d))
          .join(",")})&order=created_at.asc&limit=400`
      )
    : [];
  if (traceRaw === null) degraded.push("decision traces");
  const traceRows: TraceDbRow[] = traceRaw ?? [];

  const decisions: Record<
    string,
    {
      stages: {
        stage: string;
        input: string;
        reasoning: string;
        output: string;
        verdict: string | null;
        nodeId: string | null;
        edgeId: string | null;
        ms: number | null;
      }[];
      ladder: LadderRung[];
      specRev: number | null;
      totalMs: number;
      at: string | null;
    }
  > = {};
  for (const r of traceRows) {
    const d =
      decisions[r.decision_id] ??
      (decisions[r.decision_id] = { stages: [], ladder: [], specRev: null, totalMs: 0, at: null });
    if (r.spec_rev != null) d.specRev = r.spec_rev;
    if (!d.at) d.at = r.created_at;
    if (typeof r.ms === "number") d.totalMs += r.ms;
    if (r.stage === "ladder") {
      try {
        const rungs = JSON.parse(r.output ?? "[]") as LadderRung[];
        if (Array.isArray(rungs)) d.ladder = rungs.slice(0, 30);
      } catch {
        /* unparsable ladder stays empty */
      }
      continue; // the raw JSON row itself is noise in the stage list
    }
    d.stages.push({
      stage: r.stage,
      input: (r.input ?? "").slice(0, 600),
      reasoning: (r.reasoning ?? "").slice(0, 600),
      output: (r.output ?? "").slice(0, 600),
      verdict: r.verdict,
      nodeId: r.node_id,
      edgeId: r.edge_id,
      ms: r.ms,
    });
  }

  const threadRow = (thread ?? [])[0];
  return NextResponse.json({
    threadKey,
    userEmail,
    digits,
    degraded,
    thread: threadRow
      ? {
          phase: threadRow.phase,
          // The funnel LEDGER stage - the vocabulary the owner's console
          // shares with the traveller tracker (funnel/stages.ts).
          stage: threadRow.stage ?? null,
          fields: threadRow.fields ?? {},
          waitingUntil: threadRow.waiting_until,
          updatedAt: threadRow.updated_at,
        }
      : null,
    messages: ordered,
    decisions,
    scores: scores ?? [],
    reviews: reviews ?? [],
    offers: offers ?? [],
    queued: (queued ?? []).map((q) => ({ text: q.body, at: q.not_before, reason: q.meta?.reason })),
  });
}

export const maxDuration = 60;
