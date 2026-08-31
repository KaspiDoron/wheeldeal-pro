import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect, sbSelectStrict, pgTimestamp } from "@/lib/runtime-config";
import { senderSafety, type SenderSafety } from "@/lib/wa-guard";
import { deriveCountered } from "@/lib/counter-offer";
import { clampSince } from "@/lib/session-life";
import { searchSessionTtlMs } from "@/lib/session-life-config";

// The living-workspace feed: one endpoint that tells the user everything
// their agents are doing, chronologically, across every shop - built ENTIRELY
// from data the engine already persists on the live path (agent_traces,
// whatsapp_messages, vendor_replies, offers, wa_outbox, graph_wakeups,
// agent_scores, agent_events). Strictly scoped to the signed-in user.
//
// Also serves:
//   ?why=<decisionId>  -> the persisted director ladder for that decision
//   queue              -> same shape as /api/queue (this poll REPLACES it)
//   waHealth           -> the anti-ban guard's honest safety state

export interface ActivityItem {
  id: string;
  at: string; // ISO
  // Keep in step with FeedItem in components/activity/ActivityFeed - the two
  // are the wire's two ends. "contact" = a shop shared another shop's card.
  kind:
    | "trace"
    | "sent"
    | "reply"
    | "offer"
    | "queued"
    | "wait"
    | "judge"
    | "alert"
    | "drop"
    | "contact";
  vendorId?: string;
  vendorName?: string;
  title: string;
  detail?: string;
  /**
   * English gloss of `detail` when the quoted message is in a local language
   * (outbound: whatsapp_messages.raw.englishGloss; inbound:
   * vendor_replies.english_gloss). FEED DOCTRINE (W1.5): `detail` is always
   * the REAL text on the wire; the translation is a second quiet line when it
   * differs - never the gloss INSTEAD of what was actually sent or received.
   */
  english?: string;
  decisionId?: string;
  meta?: Record<string, unknown>;
}

// Friendly titles for pipeline stages a traveller should actually see.
// Anything not listed here is engine plumbing and stays out of the feed.
const STAGE_TITLES: Record<string, string> = {
  transcribe: "Listened to the shop's voice note",
  extract: "Read the shop's reply",
  "media-coherence": "Double-checked the photo against the conversation",
  "media-gap": "Checked what the deal is still missing",
  director: "Chose the next move",
  bargain: "Bargained for a better price",
  clarify: "Asked the shop to clarify",
  answer: "Answered the shop's question",
  "deposit-probe": "Asked about the deposit",
  "fulfillment-probe": "Asked how you get the vehicle",
  "pickup-location": "Shared your pickup location (with your consent)",
  close: "Wrapped up the conversation",
  present: "Marked this offer ready for you",
  "closing-message": "Sent the closing message",
  deliver: "Message on its way to the shop",
  // The PRIMARY engine's own moves (its trace stages are `spte:<move>`,
  // normalized by stageKey below). Without these every trace the live engine
  // wrote was silently dropped from the feed - the traveller watched an empty
  // activity list while the negotiation ran.
  farewell: "Wrapped up the conversation",
  "redirect-close": "Wrapped up the conversation",
  "graceful-close": "Wrapped up the conversation",
  momentum: "Nudged the shop to keep things moving",
  confirm: "Double-checked a detail with the shop",
  "confirm-vehicle": "Made sure it's the exact vehicle you asked for",
  "option-probe": "Asked what separates the options",
  "restock-probe": "Asked when it's back in stock",
  "verify-recap": "Recapped the deal for the shop to confirm",
};

/** SPTE writes trace stages as `spte:<move>`; the vocabulary above is the
 *  moves themselves. `silent` and unknown moves stay plumbing (no title). */
const stageKey = (s: string) => (s.startsWith("spte:") ? s.slice(5) : s);

interface TraceRow {
  id: number;
  decision_id: string;
  vendor_id: string | null;
  vendor_name: string | null;
  stage: string;
  reasoning: string | null;
  output: string | null;
  created_at: string;
}

/**
 * How to phrase a pending wait. Minutes for anything short (the only kind a
 * negotiation tactic ever is), a clock time only once it is genuinely far off.
 */
function waitEta(notBefore: string, nowMs: number): string {
  const at = Date.parse(notBefore);
  if (!Number.isFinite(at)) return "in a moment";
  const mins = Math.round((at - nowMs) / 60_000);
  if (mins <= 1) return "about a minute";
  if (mins < 60) return `about ${mins} min`;
  return `until ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const email = session.email;
  const enc = encodeURIComponent(email);
  const url = new URL(req.url);

  // ---- "Why this move?" lookup (ownership-verified) -------------------------
  const why = url.searchParams.get("why");
  if (why) {
    const rows = await sbSelect<TraceRow & { user_email: string | null }>(
      "agent_traces",
      `select=id,decision_id,user_email,vendor_id,vendor_name,stage,reasoning,output,created_at&decision_id=eq.${encodeURIComponent(
        why
      )}&stage=eq.ladder&limit=1`
    ).catch(() => []);
    const row = rows[0];
    // STRICT ownership: a trace with NO owner stamp is nobody's to read -
    // the old `row.user_email && ...` guard returned it to ANY signed-in
    // caller who knew the id. Reject unless the stamp matches exactly.
    if (!row || row.user_email !== email) {
      return NextResponse.json({ ladder: null });
    }
    let ladder: unknown = null;
    try {
      ladder = JSON.parse(row.output ?? "null");
    } catch {}
    return NextResponse.json({ ladder, at: row.created_at, vendorName: row.vendor_name });
  }

  // Opportunistic drain: this endpoint is polled while the app is open, so it
  // inherits the queue-poll's job of actually sending due messages.
  try {
    // ONE DRAIN OWNER PER CYCLE (E2/L2): /api/replies, this route and
    // /api/wa/status all drained the same user's queue back-to-back. The
    // claim lets one of them pay per interval; the rest answer fast.
    const { claimDrainSlot } = await import("@/lib/wa/drain-owner");
    if (claimDrainSlot(session.email)) {
    const { drainOutbox } = await import("@/lib/wa-guard");
    const { sendFromUser } = await import("@/lib/evolution");
    // Tagged failures: a broken drain must show up in the server logs, not
    // vanish into a blanket catch (it silently stops all queued sends).
    // AWAITED, not fire-and-forget. On Cloud Run the CPU is throttled to ~0
    // once the response is flushed, so a `void` drain was suspended mid-send:
    // messages the UI had already moved past stayed in the outbox forever.
    // Bounded so a slow host can never hold the poll open.
        // 3s, not 8s. This budget is applied TWICE per drain-owning poll (outbox
    // then wakeups), so 8s meant one poll could hold a Cloud Run concurrency
    // slot for 16 seconds. At 50 users x ~3 drain windows a minute that is
    // ~40 slots held against a --concurrency of 32 - i.e. the polls alone
    // force a second instance that does nothing but wait. The minute-cron and
    // reply-tick already cover the queue; this budget is opportunistic help,
    // not the delivery mechanism.
    const DRAIN_BUDGET_MS = 3_000;
    const bounded = <T,>(p: Promise<T>) =>
      Promise.race([p, new Promise((r) => setTimeout(r, DRAIN_BUDGET_MS))]);
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    // fast=true - the 8s budget below is the whole reason this matters: one row
    // paying 4-12s of presence simulation could consume the entire drain, so
    // the poll sent ONE message and timed out. The anti-ban floors are the
    // guard and the pacing claims, and both still run per row.
    // SCOPED TO THIS TRAVELLER. Both drains ran GLOBALLY here: one person's
    // 6-second poll executed OTHER users' real WhatsApp sends and up to 24
    // other users' multi-agent LLM composes, inside their request. The cost
    // scales as users x users - every extra traveller made every other
    // traveller's poll slower - and one person's slow Evolution host stalled a
    // stranger's feed while advancing pacing state that had nothing to do with
    // them. /api/replies fixed exactly this and left a comment saying the
    // sibling routes still needed it; this is that route.
    //
    // Rows belonging to signed-out users are not orphaned: the heartbeat
    // (Cloud Scheduler -> /api/wa/ping) and the tick chain drain globally,
    // which is a worker's job rather than somebody else's poll.
    await bounded(
      drainOutbox((k, to, text, lane) => sendFromUser(k, to, text, true, { lane }), {
        senderKey: session.email,
      }).catch((e) => console.error("[drain:outbox]", e instanceof Error ? e.message : e))
    );
    await bounded(
      drainGraphWakeups((k, to, text) => sendFromUser(k, to, text, true, { lane: "reply" }), {
        userEmail: session.email,
      }).catch((e) => console.error("[drain:wakeups]", e instanceof Error ? e.message : e))
    );
    }
  } catch (e) {
    console.error("[drain:init]", e instanceof Error ? e.message : e);
  }

  // `since` IS CALLER-SUPPLIED AND USED TO HAVE NO FLOOR.
  //
  // The client sends its session epoch here, and when a week-old hunt was
  // auto-restored it sent THAT - silently overriding the 24h default below and
  // making every query in this route reach back a week. The traveller then saw a
  // week of traces, replies and offers rendered as the current session. Clamping
  // is the server-side half of that fix; it also bounds a parameter that any
  // caller could previously set to zero.
  //
  // Absent `since` keeps the route's own 24h default: a client with no live hunt
  // is asking a different question, and narrowing it to the session TTL would
  // hide activity that legitimately belongs to the day.
  const requestedSince = Number(url.searchParams.get("since"));
  const ttlMs = await searchSessionTtlMs();
  const sinceMs =
    Number.isFinite(requestedSince) && requestedSince > 0
      ? clampSince(requestedSince, Date.now(), ttlMs)
      : Date.now() - 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 40, 10), 80);

  const [traces, outbound, replies, offers, outboxRead, wakeups, events, inboundRows] =
    await Promise.all([
    sbSelect<TraceRow>(
      "agent_traces",
      // 40, not 120. This is a SIX-SECOND poll and the feed renders a 220-char
      // slice of `reasoning` per row, so 120 rows of full trace text was ~3x
      // the bytes for rows the surface never shows. `reasoning` itself has to
      // stay in the select (the feed detail reads it) - the row count is the
      // lever that does not cost anything visible.
      `select=id,decision_id,vendor_id,vendor_name,stage,reasoning,output,created_at&user_email=eq.${enc}&created_at=gte.${pgTimestamp(sinceIso)}&order=created_at.desc&limit=40`
    ).catch(() => [] as TraceRow[]),
    (() => {
      type OutRow = {
        id: number;
        to_number: string;
        body: string;
        raw: { vendorId?: string; vendorName?: string; englishGloss?: string; kind?: string } | null;
        received_at: string;
      };
      // PROJECT ONLY the four raw fields the feed reads (OR11 E2.1), never the
      // whole `raw` jsonb: this is a 150-row read on a 6s poll, and shipping the
      // full blob to pull four small strings was the last un-trimmed egress
      // after OR8-A7. Re-inflated to the nested shape below so every consumer
      // (deriveCountered, the state rollup, the per-vendor last-message join) is
      // untouched. Outbound rows carry the gloss as raw.englishGloss (stamped by
      // every send path from the outbox meta); raw.english is the INBOUND key.
      return sbSelect<{
        id: number;
        to_number: string;
        body: string;
        vendorId: string | null;
        vendorName: string | null;
        englishGloss: string | null;
        kind: string | null;
        received_at: string;
      }>(
        "whatsapp_messages",
        // Marker rows (session pause/takeover flags) live in the same table -
        // keep them out of the human-facing feed. Fetched deep enough (150)
        // that the per-vendor state rollup below covers a full 40+ shop batch.
        `select=id,to_number,body,vendorId:raw->>vendorId,vendorName:raw->>vendorName,englishGloss:raw->>englishGloss,kind:raw->>kind,received_at&direction=eq.outbound&raw->>sender=eq.${enc}&to_number=not.in.(session,takeover,cancel)&received_at=gte.${pgTimestamp(sinceIso)}&order=received_at.desc&limit=150`
      )
        .then(
          (rows): OutRow[] =>
            rows.map((r) => ({
              id: r.id,
              to_number: r.to_number,
              body: r.body,
              received_at: r.received_at,
              raw: {
                vendorId: r.vendorId ?? undefined,
                vendorName: r.vendorName ?? undefined,
                englishGloss: r.englishGloss ?? undefined,
                kind: r.kind ?? undefined,
              },
            }))
        )
        .catch((): OutRow[] => []);
    })(),
    (async () => {
      type ReplyFeedRow = {
        id: number;
        vendor_id: string | null;
        vendor_name: string | null;
        reply_text: string | null;
        english_gloss?: string | null;
        image_count: number | null;
        created_at: string;
      };
      const filter = `user_email=eq.${enc}&created_at=gte.${pgTimestamp(sinceIso)}&order=created_at.desc&limit=80`;
      // english_gloss in the FIRST tier only: a select naming a not-yet-
      // migrated column fails SILENTLY as [] (same degrade /api/replies uses),
      // and this feed must never blank over a pending migration.
      let rows = await sbSelect<ReplyFeedRow>(
        "vendor_replies",
        `select=id,vendor_id,vendor_name,reply_text,english_gloss,image_count,created_at&${filter}`
      );
      if (rows.length === 0) {
        rows = await sbSelect<ReplyFeedRow>(
          "vendor_replies",
          `select=id,vendor_id,vendor_name,reply_text,image_count,created_at&${filter}`
        );
      }
      return rows;
    })().catch(
      () =>
        [] as {
          id: number;
          vendor_id: string | null;
          vendor_name: string | null;
          reply_text: string | null;
          english_gloss?: string | null;
          image_count: number | null;
          created_at: string;
        }[]
    ),
    sbSelect<{
      id: number;
      vendor_id: string | null;
      vendor_name: string | null;
      price_per_day: number | null;
      currency: string | null;
      round: number | null;
      verified: boolean | null;
      created_at: string;
    }>(
      "offers",
      `select=id,vendor_id,vendor_name,price_per_day,currency,round,verified,created_at&user_email=eq.${enc}&simulated=eq.false&created_at=gte.${pgTimestamp(sinceIso)}&order=created_at.desc&limit=80`
    ).catch(() => []),
    // STRICT, AND THE ONLY READ HERE THAT IS. "Nothing is queued" is a claim
    // this poll makes on the screen a traveller opens to ask whether their
    // messages are stuck, and `.catch(() => [])` made a Supabase outage
    // indistinguishable from an empty queue - a confident, reassuring, wrong
    // answer. The other reads above degrade to an under-full FEED, which is
    // visibly incomplete; an empty QUEUE reads as a positive statement of fact.
    sbSelectStrict<{
      id: number;
      to_number: string;
      not_before: string;
      meta: { reason?: string; vendorName?: string; vendorId?: string } | null;
    }>(
      "wa_outbox",
      // 50 was a silent ceiling: an Ultra hunt parks two dozen openers plus
      // replies, and a queue longer than this rendered as if it ended here -
      // the traveller counted their waiting shops and came up short. 200
      // covers any real hunt, and the rows are tiny.
      `select=id,to_number,not_before,meta&sender_key=eq.${enc}&order=not_before.asc&limit=200`
    ).catch(() => ({ error: "unavailable" }) as const),
    sbSelect<{
      id: number;
      kind: string;
      thread_key: string;
      not_before: string;
      payload: { reason?: string; vendorName?: string } | null;
      created_at: string;
    }>(
      "graph_wakeups",
      // EXACT ownership match on the stamped column - the old
      // `thread_key=like.<email>:*` read could surface a DIFFERENT user's
      // wakeup when one email `_`-wildcard-matched another. Same fix + same
      // legacy-row tradeoff as the agent_events filter below.
      `select=id,kind,thread_key,not_before,payload,created_at&user_email=eq.${encodeURIComponent(
        email
      )}&kind=eq.tick&order=not_before.asc&limit=10`
    ).catch(() => []),
    sbSelect<{
      id: number;
      kind: string;
      vendor_id: string | null;
      vendor_name: string | null;
      detail: string | null;
      created_at: string;
    }>(
      "agent_events",
      // EXACT ownership match - the old detail LIKE *email* substring filter
      // showed n@x.com the risk alerts (incl. message excerpts) of john@x.com.
      // Unstamped legacy rows are hidden by design; the feed is time-windowed
      // so they age out within a day.
      //
      // DROPS ARE FEED EVENTS TOO. The engine records inbound-dropped and
      // send-dropped honestly, but the feed used to read inbound-risk ONLY -
      // so a message the guard refused or a reply the pipeline lost had a
      // durable trace no user surface ever showed. Benign drops (privacy
      // gate, user pause, coalesced turns) are filtered out downstream.
      // ...AND SO IS A SHARED CONTACT. `contact-suggested` is written at
      // ingest when a shop sends another shop's card; it was a durable fact
      // with no surface at all, which is the same invisibility the drops above
      // were fixed for. It is a LEAD, not an alert - see the feed item below.
      `select=id,kind,vendor_id,vendor_name,detail,created_at&kind=in.("inbound-risk","inbound-dropped","send-dropped","contact-suggested")&user_email=eq.${encodeURIComponent(
        email
      )}&created_at=gte.${pgTimestamp(sinceIso)}&order=created_at.desc&limit=20`
    ).catch(() => []),
    sbSelect<{ from_number: string; body: string | null; english?: string | null; received_at: string }>(
      "whatsapp_messages",
      // STORED inbound, straight from the wire. vendor_replies only exists once
      // the agent turn DERIVED the message - so a stored reply whose turn
      // failed (or is still queued for the recovery sweep) left the card on
      // "Awaiting reply" while the reply sat in the DB. The card state must
      // follow the wire, not the derivation.
      //
      // english:raw->>english is the INBOUND gloss the agent loop stamps on the
      // stored row - a JSON-path projection on a column every deploy has, so it
      // degrades to null rather than blanking the read. This is exactly the
      // path that needs it: a reply whose agent turn has not run yet has no
      // vendor_replies row (and so no english_gloss) to read from.
      `select=from_number,body,english:raw->>english,received_at&direction=eq.inbound&raw->>receiver=eq.${enc}&received_at=gte.${pgTimestamp(sinceIso)}&order=received_at.desc&limit=60`
    ).catch(() => []),
    ]);

  // AN EMPTY QUEUE IS A CLAIM. A FAILED READ IS NOT.
  //
  // `queueState` travels with every poll so the client never has to guess which
  // of the two an empty `queue` array means:
  //   "ok"          - we read the queue; this is what is in it.
  //   "unavailable" - we could not read it. Show nothing CONFIDENT.
  // ("missing" - the table does not exist on this database - is a vacuously
  // empty read and is honestly "ok".)
  const queueState: "ok" | "unavailable" =
    "error" in outboxRead && outboxRead.error === "unavailable" ? "unavailable" : "ok";
  const outbox = "rows" in outboxRead ? outboxRead.rows : [];

  // decisionId per vendor (newest first) so cards can open "Why this move?".
  const ladderByDecision = new Set(
    traces.filter((t) => t.stage === "ladder").map((t) => t.decision_id)
  );
  const whyByVendor: Record<string, string> = {};
  for (const t of traces) {
    if (t.stage === "ladder" && t.vendor_id && !whyByVendor[t.vendor_id]) {
      whyByVendor[t.vendor_id] = t.decision_id;
    }
  }

  // ---- PER-VENDOR CONVERSATION STATE (the authoritative card signal) --------
  // The Live Status panel counted delivered RFQs from a 200-row server
  // aggregate while each CARD reconstructed its stage from a truncated feed -
  // split-brain, so a shop the panel counted "started" stayed stuck in the
  // "queued message" visual. This rollup is the card's authoritative signal:
  // built from the source rows above (fetched deep enough - 150 outbound / 80
  // replies+offers / 120 traces - to cover a full 40+ shop batch), keyed by
  // vendorId, so the card status mirrors the real DB state regardless of soft
  // filters. Ranked messaged < active < offer.
  const STATE_RANK = { messaged: 1, active: 2, offer: 3 } as const;
  type VState = keyof typeof STATE_RANK;
  const vendorStates: Record<string, VState> = {};
  const bumpState = (id: string | null | undefined, s: VState) => {
    if (!id) return;
    const cur = vendorStates[id];
    if (!cur || STATE_RANK[s] > STATE_RANK[cur]) vendorStates[id] = s;
  };
  // We MESSAGED the shop (RFQ delivered).
  //
  // NOT ONLY FROM THE 150-ROW FEED READ (L5): on a big hunt the follow-ups
  // push the oldest RFQs out of that window, so the earliest-contacted shops
  // silently lost their "messaged" state and the progress bar undercounted.
  // A dedicated RFQ-only read (tiny rows, one per shop per hunt) covers the
  // whole batch regardless of how chatty the newest threads are.
  const rfqRows = await sbSelect<{
    to_number: string;
    // Flattened by the `raw->>vendorId` projection below, not nested.
    vendorId?: string;
  }>(
    "whatsapp_messages",
    // `raw->>vendorId` is the only key `bumpState` reads below - pulling the
    // whole `raw` payload for 400 rows every six seconds was pure egress for
    // one string per row. Row count is left alone deliberately: this read is
    // what marks a shop "messaged", and truncating it would silently regress
    // the progress bar (the 150-row truncation bug of owner report 6, L5).
    `select=to_number,raw->>vendorId&direction=eq.outbound&raw->>sender=eq.${enc}&raw->>kind=eq.rfq&received_at=gte.${pgTimestamp(sinceIso)}&order=received_at.desc&limit=400`
  ).catch(() => []);
  for (const m of rfqRows) bumpState(m.vendorId, "messaged");
  for (const m of outbound) if (m.raw?.kind === "rfq") bumpState(m.raw?.vendorId, "messaged");
  // The agent is ACTIVELY working the thread (any engine trace) or the shop
  // has REPLIED - either way it is a live conversation, not a queued message.
  for (const t of traces) if (STAGE_TITLES[stageKey(t.stage)]) bumpState(t.vendor_id, "active");
  for (const r of replies) bumpState(r.vendor_id, "active");
  // A reply STORED but not yet derived counts too: join the raw inbound rows to
  // vendors by number via our own outbound rows. "Awaiting reply" can never
  // coexist with a reply already sitting in whatsapp_messages.
  const { digitsOnly } = await import("@/lib/phone");
  const vendorByDigits: Record<string, string> = {};
  // Two shapes on purpose: `outbound` carries a nested `raw`, while `rfqRows`
  // projects `raw->>vendorId` flat to keep that 400-row read cheap. Normalise
  // here rather than re-inflating the payload just to share one loop.
  const vendorIdOf = (m: { raw?: { vendorId?: string } | null; vendorId?: string }) =>
    m.raw?.vendorId ?? m.vendorId;
  for (const m of [...outbound, ...rfqRows]) {
    const id = vendorIdOf(m);
    const digits = digitsOnly(m.to_number);
    if (id && digits && !vendorByDigits[digits]) vendorByDigits[digits] = id;
  }
  for (const m of inboundRows) bumpState(vendorByDigits[digitsOnly(m.from_number)], "active");
  // A real priced OFFER is the strongest state.
  for (const o of offers) if (o.price_per_day) bumpState(o.vendor_id, "offer");

  // ---- THE FUNNEL LEDGER, SERVED (src/lib/funnel/stages.ts) -----------------
  // The durable per-thread stage - the single vocabulary the tracker migrates
  // onto, shipped ALONGSIDE the legacy 3-value rank so clients adopt it without
  // a flag day. One cheap indexed read; keyed by vendorId with a digits
  // fallback through the same join the raw-inbound rollup uses.
  const vendorStages: Record<string, { stage: string; at: string | null }> = {};
  {
    const threadRows = await sbSelect<{
      vendor_id: string | null;
      to_number: string;
      stage: string | null;
      stage_at: string | null;
    }>(
      "negotiation_threads",
      `select=vendor_id,to_number,stage,stage_at&user_email=eq.${enc}&stage=not.is.null&limit=200`
    ).catch(() => []);
    for (const t of threadRows) {
      if (!t.stage) continue;
      const id = t.vendor_id || vendorByDigits[digitsOnly(t.to_number)];
      if (id) vendorStages[id] = { stage: t.stage, at: t.stage_at };
    }
  }

  // ---- COUNTER-OFFER DETECTION (derived, never cosmetic) --------------------
  // See deriveCountered(): a vendor is countered once the agent has sent a
  // bargain move after the shop's opening quote (offer round>=1, or an outbound
  // bargain timestamped after the first inbound). Emitted as a SEPARATE signal
  // (not folded into the messaged<active<offer rank) so it never blocks the
  // priced offer from surfacing - the client only relabels the STAGE.
  const countered = deriveCountered({ offers, replies, outbound });

  // ---- PER-VENDOR LAST MESSAGES (F4 batch status) --------------------------
  // The status screen wants {shop, last shop message, last agent message} for
  // EVERY shop in one response. Previously the client N+1-polled /api/thread per
  // card; here we derive it from the outbound + replies rows already fetched.
  // Rows are newest-first, so the FIRST per vendor is the latest.
  type LastMsg = {
    lastOutboundText?: string;
    lastOutboundEnglish?: string;
    lastOutboundAt?: string;
    lastInboundText?: string;
    lastInboundEnglish?: string;
    lastInboundAt?: string;
  };
  const lastByVendor: Record<string, LastMsg> = {};
  const ensureLast = (id: string): LastMsg => (lastByVendor[id] ??= {});
  for (const m of outbound) {
    const id = m.raw?.vendorId;
    if (!id) continue;
    const slot = ensureLast(id);
    if (slot.lastOutboundAt) continue; // already have the newest for this vendor
    // The REAL sent body, with the English gloss beside it (W1.5 doctrine:
    // show what was actually sent, translation as a second quiet line). The
    // old "prefer the gloss" read keyed on raw.english - the INBOUND key -
    // so it silently never fired; outbound rows carry raw.englishGloss.
    slot.lastOutboundText = (m.body || "").slice(0, 240);
    slot.lastOutboundEnglish = m.raw?.englishGloss?.slice(0, 240);
    slot.lastOutboundAt = m.received_at;
  }
  for (const r of replies) {
    const id = r.vendor_id;
    if (!id) continue;
    const slot = ensureLast(id);
    if (slot.lastInboundAt) continue;
    slot.lastInboundText = (r.reply_text || (r.image_count ? "[photo]" : "") || "").slice(0, 240);
    slot.lastInboundEnglish = r.english_gloss?.slice(0, 240) ?? undefined;
    slot.lastInboundAt = r.created_at;
  }
  // Underived-but-stored inbound fills the gap (newest-first here too), so the
  // panel shows what the shop actually said even before the agent turn runs.
  for (const m of inboundRows) {
    const id = vendorByDigits[digitsOnly(m.from_number)];
    if (!id) continue;
    const slot = ensureLast(id);
    if (slot.lastInboundAt && Date.parse(slot.lastInboundAt) >= Date.parse(m.received_at)) continue;
    slot.lastInboundText = (m.body || "").slice(0, 240) || slot.lastInboundText;
    slot.lastInboundEnglish = m.english?.slice(0, 240) ?? undefined;
    slot.lastInboundAt = m.received_at;
  }

  const items: ActivityItem[] = [];

  for (const t of traces) {
    const title = STAGE_TITLES[stageKey(t.stage)];
    if (!title) continue; // plumbing stages stay out of the feed
    items.push({
      id: `trace:${t.id}`,
      at: t.created_at,
      kind: "trace",
      vendorId: t.vendor_id ?? undefined,
      vendorName: t.vendor_name ?? undefined,
      title,
      detail: (t.reasoning ?? "").slice(0, 220) || undefined,
      decisionId: ladderByDecision.has(t.decision_id) ? t.decision_id : undefined,
    });
  }
  for (const m of outbound) {
    const human = m.raw?.kind === "human-manual";
    items.push({
      id: `sent:${m.id}`,
      at: m.received_at,
      kind: "sent",
      vendorId: m.raw?.vendorId,
      vendorName: m.raw?.vendorName,
      title: human ? "You messaged the shop yourself" : "Message sent to the shop",
      // FEED DOCTRINE (W1.5): the REAL text on the wire, gloss beside it -
      // the gloss-INSTEAD render meant the traveller never saw what their
      // agent actually sent (and it read the inbound key anyway, see above).
      detail: (m.body || "").slice(0, 220) || undefined,
      english: m.raw?.englishGloss?.slice(0, 220),
    });
  }
  for (const r of replies) {
    items.push({
      id: `reply:${r.id}`,
      at: r.created_at,
      kind: "reply",
      vendorId: r.vendor_id ?? undefined,
      vendorName: r.vendor_name ?? undefined,
      title: r.image_count ? "The shop replied (with a photo)" : "The shop replied",
      detail: (r.reply_text ?? "").slice(0, 220) || undefined,
      english: r.english_gloss?.slice(0, 220) ?? undefined,
    });
  }
  for (const o of offers) {
    if (!o.price_per_day) continue;
    items.push({
      id: `offer:${o.id}`,
      at: o.created_at,
      kind: "offer",
      vendorId: o.vendor_id ?? undefined,
      vendorName: o.vendor_name ?? undefined,
      title: o.verified ? "Confirmed offer in" : "Offer in (unconfirmed)",
      detail: undefined,
      meta: {
        pricePerDay: o.price_per_day,
        currency: o.currency ?? "USD",
        round: o.round ?? 0,
        verified: Boolean(o.verified),
      },
    });
  }
  const now = Date.now();
  for (const w of wakeups) {
    if (Date.parse(w.not_before) <= now) continue;
    items.push({
      id: `wait:${w.id}`,
      at: w.created_at,
      kind: "wait",
      vendorName: w.payload?.vendorName,
      title: "Will is waiting on purpose",
      // A deliberate pause is minutes, so say MINUTES. The old absolute clock
      // time turned a two-minute pause into "until 08:28 AM" - which read as
      // "the agents are asleep until tomorrow" on a thread that had just
      // replied. A clock time is only meaningful when the wait is genuinely
      // long, and by then it is a queue hold, not a tactic.
      detail:
        (w.payload?.reason ?? "waiting a moment so the shop takes the offer seriously") +
        ` (${waitEta(w.not_before, now)})`,
    });
  }
  const { dropFeedItem } = await import("@/lib/wa/safety-signals");
  for (const e of events) {
    if (e.kind === "contact-suggested") {
      // The shop shared someone's card. Show WHO shared it and the number, so
      // the traveller can act - and nothing more: no thread is opened for
      // them (the ingest writer is deliberately suggestion-only).
      let shared: { name?: string | null; digits?: string } = {};
      try {
        shared = JSON.parse(e.detail ?? "{}");
      } catch {
        shared = {};
      }
      if (!shared.digits) continue; // a card with no number is nothing to act on
      items.push({
        id: `contact:${e.id}`,
        at: e.created_at,
        kind: "contact",
        // TRANSLATABLE TITLE, INTERPOLATED NAME. The title used to embed the
        // shared contact's name, which makes every occurrence a unique string
        // that can never be in the catalogue - and `t()` refuses anything
        // outside it, so this line rendered English in all nineteen other
        // languages. The name is a proper noun and is not translated anyway,
        // so the client appends it to the translated title.
        title: "A shop shared a contact",
        detail: `+${shared.digits} - shared by the shop you are talking to. Tap to copy if you want to ask them too; nothing was sent to them.`,
        meta: { digits: shared.digits, sharedName: shared.name ?? undefined },
      });
      continue;
    }
    if (e.kind === "inbound-dropped" || e.kind === "send-dropped") {
      const drop = dropFeedItem(e.kind, e.detail);
      if (!drop) continue; // benign, deliberate outcome - not an alert
      items.push({
        // ITS OWN KIND. A delivery drop is operational information; emitted as
        // kind:"alert" it wore the risk-screen's red styling AND fed the
        // card's "Will flagged this reply" banner - an undelivered message
        // masquerading as a scam warning.
        id: `drop:${e.id}`,
        at: e.created_at,
        kind: "drop",
        vendorId: e.vendor_id || undefined,
        // vendor_name on drop events carries the shop's digits, not a name -
        // the feed shows the honest copy, not a phone number masquerading.
        title: drop.title,
        detail: drop.detail,
        meta: { risk: "info" },
      });
      continue;
    }
    let excerpt = "";
    let risk = "high";
    let reasons: string[] = [];
    try {
      const d = JSON.parse(e.detail ?? "{}");
      excerpt = String(d.excerpt ?? "");
      risk = String(d.risk ?? "high");
      if (Array.isArray(d.reasons)) reasons = d.reasons.map(String);
    } catch {}
    items.push({
      id: `alert:${e.id}`,
      at: e.created_at,
      kind: "alert",
      vendorId: e.vendor_id ?? undefined,
      vendorName: e.vendor_name ?? undefined,
      title: "Will flagged this reply - please review",
      detail: (reasons[0] ?? excerpt).slice(0, 220) || undefined,
      meta: { risk, excerpt: excerpt.slice(0, 200) },
    });
  }

  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  // Same shape as /api/queue so the existing queue card keeps working. The
  // reason is the guard's REAL stored reason translated honestly - a pacing
  // hold must never masquerade as "shop closed".
  //
  // STATUS-PANEL DEDUP (live-trial fix): "Your queued messages" is the list of
  // UN-SENT INTROS. A parked agent REPLY to an already-messaged shop (kind
  // reply / bargain / auto-*) must NOT appear here - it made the same shop show
  // in "Messaged"/"Offers" AND "Queued" simultaneously. Replies surface through
  // the conversation thread, not the intro queue.
  const { queueReasonLabel } = await import("@/lib/queue-reason");
  const { cleanShopName } = await import("@/lib/text");
  const { outboxState } = await import("@/lib/wa/outbox-lifecycle");
  // Tombstones WITH their actor, fetched before the queue is shaped: a
  // tombstoned shop's rows are terminally dropped at drain, so advertising
  // them here ("next at ~05:38" over removed shops) was a promise the drain
  // was about to break. They are excluded from the queue payload, the ETA
  // simulation and the progress counters alike.
  let cancelledShops: { digits: string; reason: string; at: string | null }[] = [];
  try {
    const { cancelledEntries } = await import("@/lib/wa/cancellations");
    cancelledShops = await cancelledEntries(email);
  } catch {}
  const cancelledSet = new Set(cancelledShops.map((c) => c.digits));
  const INTRO_KINDS = new Set(["rfq", "custom", "human-manual"]);
  const queue = outbox
    .filter((r) => {
      const kind = (r.meta as { kind?: string } | null)?.kind;
      return (!kind || INTRO_KINDS.has(kind)) && !cancelledSet.has(r.to_number);
    })
    .map((r) => {
      const meta = r.meta as { vendorId?: string; vendorName?: string; reason?: string; kind?: string } | null;
      // Same lifecycle definition the queue viewer uses - the two surfaces can
      // no longer disagree about a message that is going out right now.
      const state = outboxState(r.not_before, meta, now);
      const sending = state === "sending";
      return {
        id: r.id,
        vendorId: meta?.vendorId ?? null,
        vendorName: meta?.vendorName ? cleanShopName(meta.vendorName) : null,
        toNumber: r.to_number,
        notBefore: r.not_before,
        due: state !== "waiting",
        sending,
        kind: meta?.kind ?? null,
        reason: sending
          ? "Sending now"
          : state === "due"
            ? "Sending shortly"
            : queueReasonLabel(meta?.reason),
        rawReason: meta?.reason ?? null,
      };
    });

  // WHICH SHOPS THE AGENT IS ALREADY MID-SENTENCE WITH.
  //
  // The queue above deliberately carries INTRO kinds only - it is the "your
  // messages are going out" panel, and an agent's counter-reply is part of the
  // conversation, not part of that queue. But that filter is also the reason
  // the client could not see agent activity AT ALL, and the Bargain button
  // paid for it: no `disabled`, no indicator, nothing to gate on. Tapping it
  // twice queued two pushes at one shop, and only the server's 3-minute window
  // stood between the traveller and a double message.
  //
  // So the agent's own rows are rolled up per vendor - a count and the fact of
  // it, never the drafted text (that is the conversation's, and the queue
  // payload is not where it belongs).
  //
  // REPRODUCTION OF THE HOLE: this loop reused INTRO_KINDS, which contains
  // "custom" - and "custom" is exactly what an EDITED bargain draft is queued
  // as (BargainDraftModal: `kind: edited ? "custom" : "bargain"`). So the one
  // path where the traveller had just written a message by hand was the one
  // path the lock could not see: row queued, button still live, second tap
  // stacks a second message at the same shop. The queue PANEL keeps its own
  // INTRO_KINDS filter (a different question - "are my introductions going
  // out?"); busy-ness is its own set.
  //
  // What counts as busy: anything in flight to this shop that is not the cold
  // introduction. `human-manual` is excluded because it mirrors a message the
  // traveller already sent from WhatsApp itself - it is a record, not a send
  // we are about to make. A row with no kind is legacy and stays excluded.
  const NOT_BUSY_KINDS = new Set(["rfq", "human-manual"]);
  const agentPending: Record<string, { count: number; sending: boolean; own: boolean }> = {};
  for (const r of outbox) {
    const meta = r.meta as { vendorId?: string; kind?: string } | null;
    const kind = meta?.kind;
    if (!kind || NOT_BUSY_KINDS.has(kind)) continue;
    if (cancelledSet.has(r.to_number)) continue;
    const id = meta?.vendorId;
    if (!id) continue;
    const prev = agentPending[id] ?? { count: 0, sending: false, own: false };
    agentPending[id] = {
      count: prev.count + 1,
      sending: prev.sending || outboxState(r.not_before, meta, now) === "sending",
      // Whose message is holding the shop. "Your agent is on it" is a lie when
      // the queued row is the traveller's own hand-edited text.
      own: prev.own || kind === "custom",
    };
  }

  // Two INDEPENDENT reads on a 6s poll - run them CONCURRENTLY, not serially
  // (OR11 E2.3). senderSafety gathers the safety signals; newContactBudget reads
  // the intro ledger (cheap now it is cached, E2.2). Neither needs the other.
  // The plan's rolling introductions budget lets the queued panel show a
  // STANDING "X of N new shops this window - next opens ~HH:MM" indicator
  // instead of the limit only flashing once as a mass-bargain toast.
  let waHealth: SenderSafety | null = null;
  let introBudget: {
    remaining: number;
    cap: number;
    windowHours: number;
    nextFreeAt: string;
  } | null = null;
  {
    const [health, budget] = await Promise.all([
      senderSafety(email).catch(() => null),
      (async () => {
        const { newContactBudget } = await import("@/lib/wa-guard");
        return newContactBudget(email, session.plan);
      })().catch(() => null),
    ]);
    waHealth = health;
    introBudget = budget;
  }

  // HONEST ETA (W2): the queue rows above carry not_before (a LOWER bound). Turn
  // it into a realistic [etaFrom, etaTo] window by simulating the drain's min-gap
  // + cold budget + drain cadence over queue position, so the UI can show a
  // "~10:20-10:25" range instead of a point estimate that silently slips.
  let queueEtaDoneBy: string | null = null;
  try {
    const { getPolicies } = await import("@/lib/wa-guard");
    const { computeQueueEtas } = await import("@/lib/wa/eta");
    // Independent reads - fetch the policies and the last-send timestamp
    // concurrently (OR11 E2.3).
    const [policies, lastOut] = await Promise.all([
      getPolicies(),
      sbSelect<{ received_at: string }>(
        "whatsapp_messages",
        `select=received_at&direction=eq.outbound&raw->>sender=eq.${enc}&order=received_at.desc&limit=1`
      ).catch(() => [] as { received_at: string }[]),
    ]);
    const stealth =
      waHealth?.state === "paused" ? 2.5 : waHealth?.state === "pacing" ? 1.5 : 1;
    const etas = computeQueueEtas(
      queue.map((q) => ({
        id: q.id,
        notBeforeMs: Date.parse(q.notBefore),
        kind: q.kind,
        rawReason: q.rawReason,
      })),
      {
        nowMs: now,
        lastSendAtMs: lastOut[0]?.received_at ? Date.parse(lastOut[0].received_at) : null,
        minGapSec: policies.min_gap_seconds,
        gapJitterSec: policies.gap_jitter_seconds,
        stealth,
        introRemaining: introBudget?.remaining ?? 0,
        introNextFreeAtMs: introBudget?.nextFreeAt ? Date.parse(introBudget.nextFreeAt) : null,
      }
    );
    let maxTo = 0;
    for (const q of queue as (typeof queue[number] & { etaFrom?: string; etaTo?: string })[]) {
      const w = etas.get(q.id);
      if (w) {
        q.etaFrom = new Date(w.etaFromMs).toISOString();
        q.etaTo = new Date(w.etaToMs).toISOString();
        maxTo = Math.max(maxTo, w.etaToMs);
      }
    }
    queueEtaDoneBy = maxTo ? new Date(maxTo).toISOString() : null;
  } catch {
    /* ETA is best-effort - the rows still carry notBefore */
  }

  // The LIVE pause state, on the same poll that carries the queue. The agent
  // switch used to read this once on mount and never again, so a session that
  // was paused later kept showing "Agents active" above a queue whose every row
  // said "Paused by you" - two states on one screen. One source, one truth.
  //
  // It carries its VERSION too. This poll is answered by whichever Cloud Run
  // instance picks it up, and each caches pause state for 30s - so right after a
  // resume, an instance that has not seen the write answers with the old value.
  // That answer is not wrong, it is OLD, and without a version the client could
  // not tell: it applied it and the switch flipped back to "paused" on its own.
  // `known` is what the client has already applied; a cached value older than
  // that is refused and re-read.
  let sessionPaused = false;
  let sessionPausedVersion = 0;
  try {
    const { sessionPauseState } = await import("@/lib/session-flags");
    const knownVersion = Number(url.searchParams.get("pauseVersion") ?? 0);
    const state = await sessionPauseState(email, Number.isFinite(knownVersion) ? knownVersion : 0);
    sessionPaused = state.paused === true;
    sessionPausedVersion = state.version;
  } catch {}

  // Tombstoned shops (fetched above, before the queue was shaped). The digits
  // digest stays for older clients; the typed list is what the UI now reads -
  // the ACTOR decides the copy ("Removed by you" only for user-removed).
  const cancelled = cancelledShops.map((c) => c.digits);

  // ---- F4: THE TWO-SEGMENT PROGRESS BAR, DERIVED ONCE, HERE ----------------
  //
  // Computed server-side deliberately. Part 5.5 found four live derivations of
  // "how many shops have been contacted" plus a fifth dead one, with the client
  // rendering Math.max() of two of them. A bar computed in the browser from an
  // already-truncated feed would be the fifth disagreeing number, on the
  // most-watched surface in the product. So it is built from `vendorStates` -
  // the same authoritative rung every card and counter reads - and shipped as
  // one field the client only renders.
  //
  // "Selected" is shops still in play: those the rung has seen plus those with
  // an intro still queued. Tombstoned shops are already excluded from `queue`
  // and never entered the rung, so a removed shop cannot hold the bar down.
  const { batchProgress } = await import("@/lib/progress");
  const inPlay = new Set<string>(Object.keys(vendorStates));
  for (const q of queue) if (q.vendorId) inPlay.add(q.vendorId);
  const queuedVendorIds = new Set(queue.map((q) => q.vendorId).filter(Boolean) as string[]);
  let reachedCount = 0;
  let quotedCount = 0;
  let negotiatingCount = 0;
  for (const id of inPlay) {
    const s = vendorStates[id];
    if (!s) continue; // queued but not yet reached
    reachedCount++;
    if (s === "offer") quotedCount++;
    else if (s === "active") negotiatingCount++;
  }
  const progress = batchProgress({
    selected: inPlay.size,
    reached: reachedCount,
    quoted: quotedCount,
    negotiating: negotiatingCount,
    queued: queuedVendorIds.size,
    introRemaining: introBudget ? introBudget.remaining : null,
    health: waHealth?.state ?? null,
    // The honest completion time the queue simulator produced from the real
    // schedule. Never a constant - a full batch runs 55-105 minutes and a free
    // one about 22, so one hardcoded hour is wrong in both directions.
    etaDoneBy: queueEtaDoneBy,
    introNextFreeAt: introBudget?.nextFreeAt ?? null,
  });

  // "(unverified)" PURGE: historical rows stamped the legacy drill suffix into
  // vendor names - strip it from every feed item so it never renders again.
  for (const it of items) {
    if (it.vendorName) it.vendorName = cleanShopName(it.vendorName);
  }

  return NextResponse.json({
    items: items.slice(0, limit),
    queue,
    queueState,
    agentPending, // F9: {vendorId: {count, sending}} - what the agent is mid-sentence with
    waHealth,
    introBudget,
    whyByVendor,
    vendorStates,
    vendorStages, // the funnel LEDGER stage per vendor: {stage, at} - the durable truth
    countered, // J: vendorIds where the agent countered a shop quote
    progress, // F4: the ONE two-segment bar derivation - the client renders it
    queueEtaDoneBy, // W2: honest "all done by" (max etaTo across the queue)
    lastByVendor, // F4: {vendorId: {lastInboundText/At, lastOutboundText/At}}
    sessionPaused, // live kill-switch state, so the panel cannot contradict the queue
    sessionPausedVersion, // monotonic: the client only ever moves this forward
    cancelledNumbers: cancelled,
    cancelledShops, // typed: {digits, reason, at} - the actor behind each tombstone
    now: new Date().toISOString(),
  });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
// NEVER CACHE. This is the live activity poll and its URL is byte-identical on
// every tick, so without this the browser/CDN could serve the FIRST (empty)
// response forever - the app showed "Nothing on the wire yet" while WhatsApp
// was actively exchanging messages, and froze the queue ETA at a past time.
export const dynamic = "force-dynamic";
export const revalidate = 0;
