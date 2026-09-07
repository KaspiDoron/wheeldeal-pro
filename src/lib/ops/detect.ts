// Weak-conversation + missed-opportunity detection - the system flags its own
// failures into the owner's review inbox, so review time goes where it counts.
// Pure heuristics over data that is already stored; each run is idempotent
// (one auto review row per thread, deduped by reason set, re-flag only after
// the previous flag was resolved AND new reasons appeared).

import "server-only";
import { sbSelect, sbSelectDark, sbInsert } from "../runtime-config";
import { identityKey } from "../wa/phone-key";

interface ThreadRow {
  thread_key: string;
  user_email: string;
  vendor_id: string | null;
  vendor_name: string | null;
  to_number: string;
  phase: string;
  fields: Record<string, unknown> | null;
  waiting_until: string | null;
  updated_at: string;
}

interface Finding {
  rule: string;
  weight: number;
  detail: string;
}

const FLAG_THRESHOLD = 3;

export async function detectWeakConversations(): Promise<{ scanned: number; flagged: number }> {
  const [threads, chiefs, moves, offers, msgs, replies, existing, citedRead] = await Promise.all([
    sbSelect<ThreadRow>(
      "negotiation_threads",
      "select=thread_key,user_email,vendor_id,vendor_name,to_number,phase,fields,waiting_until,updated_at&order=updated_at.desc&limit=120"
    ).catch(() => []),
    sbSelect<{ thread_key: string; scores: Record<string, number> | null; verdict: string | null }>(
      "agent_scores",
      "select=thread_key,scores,verdict&scorer=eq.chief-judge&order=created_at.desc&limit=200"
    ).catch(() => []),
    sbSelect<{ thread_key: string; scores: Record<string, number> | null }>(
      "agent_scores",
      "select=thread_key,scores&scorer=neq.chief-judge&order=created_at.desc&limit=300"
    ).catch(() => []),
    sbSelect<{
      user_email: string;
      vendor_id: string;
      price_per_day: number;
      currency: string;
      created_at: string;
    }>(
      "offers",
      "select=user_email,vendor_id,price_per_day,currency,created_at&simulated=eq.false&order=created_at.desc&limit=300"
    ).catch(() => []),
    sbSelect<{
      to_number: string;
      from_number: string | null;
      body: string | null;
      direction: string;
      received_at: string;
      raw: { sender?: string; receiver?: string } | null;
    }>(
      "whatsapp_messages",
      "select=to_number,from_number,body,direction,received_at,raw&order=received_at.desc&limit=400"
    ).catch(() => []),
    sbSelect<{ user_email: string; vendor_id: string; confidence: string | null }>(
      "vendor_replies",
      "select=user_email,vendor_id,confidence&confidence=eq.low&order=created_at.desc&limit=100"
    ).catch(() => []),
    sbSelect<{ thread_key: string; auto_reason: string | null; status: string }>(
      "agent_reviews",
      "select=thread_key,auto_reason,status&source=eq.auto&order=created_at.desc&limit=300"
    ).catch(() => []),
    // THE POSITIVE LEVERAGE SIGNAL (audit F069): turns whose outbound text
    // cited a rival, measured on the wire - spte/live.ts stamps `citedRival`
    // on every engine-v3-turn. `fields.lastLeverage` is written by the
    // failover engine's bargain node only, so on a thread the live engine
    // served its absence proved nothing and R3 fired against threads whose
    // own outbound had named the cheaper shop. Filtered server-side to the
    // citing turns, join columns only. sbSelectDark: unreadable means R3
    // abstains, never flags blind.
    sbSelectDark<{ user_email: string | null; to_number: string | null }>(
      "agent_events",
      `select=user_email,to_number&kind=eq.engine-v3-turn&detail=like.${encodeURIComponent(
        '*"citedRival":true*'
      )}&order=created_at.desc&limit=500`
    ),
  ]);
  const cited =
    citedRead === null
      ? null
      : new Set(citedRead.map((r) => `${r.user_email ?? ""}:${identityKey(r.to_number)}`));

  const chiefBy = new Map(chiefs.map((c) => [c.thread_key, c] as const));
  // Keyed by thread (owner:digits) - a bare-digits key would cross-match two
  // users' threads with the same shop number. Legacy unstamped rows dropped.
  const lastMsgBy = new Map<string, (typeof msgs)[number]>();
  for (const m of msgs) {
    const digits = m.direction === "inbound" ? m.from_number ?? "" : m.to_number;
    const owner = m.direction === "inbound" ? m.raw?.receiver : m.raw?.sender;
    if (!digits || !owner) continue;
    const key = `${owner}:${digits}`;
    if (!lastMsgBy.has(key)) lastMsgBy.set(key, m);
  }
  const lowConf = new Set(replies.map((r) => `${r.user_email}:${r.vendor_id}`));
  const now = Date.now();
  let flagged = 0;

  for (const t of threads) {
    const f = (t.fields ?? {}) as {
      rounds?: number;
      firmCount?: number;
      pricePerDay?: number;
      lastTarget?: number;
      lastLeverage?: string;
      declined?: boolean;
      presented?: boolean;
      digest?: { lastAskPerDay?: number };
    };
    // THE ASK WE LAST MADE, where the engine that answers shops keeps it:
    // `digest.lastAskPerDay` is measured off the sent text and persisted by
    // spte/live.ts (spte/pass.ts reads it as lastTarget); `fields.lastTarget`
    // is the failover engine's copy. Before, R5 read only the second and so
    // never fired on a live thread (audit F069).
    const lastTarget =
      typeof f.digest?.lastAskPerDay === "number" && f.digest.lastAskPerDay > 0
        ? f.digest.lastAskPerDay
        : f.lastTarget;
    const chief = chiefBy.get(t.thread_key);
    const findings: Finding[] = [];

    // R1 capitulation: rounds spent, zero discount landed.
    const discountMatch = (chief?.verdict ?? "").match(/discount (\d+)%/);
    if (discountMatch && Number(discountMatch[1]) === 0 && (f.rounds ?? 0) >= 2) {
      findings.push({
        rule: "R1",
        weight: 3,
        detail: `${f.rounds} bargaining rounds produced 0% discount`,
      });
    }

    // R3 missed rival leverage: a clearly cheaper same-user offer existed but
    // this thread's price stayed high and no turn of this thread cited it on
    // the wire (nor did the failover engine record leverage). Abstains when
    // the turn record could not be read.
    if (f.pricePerDay && !f.declined && cited !== null) {
      const rival = offers.find(
        (o) =>
          o.user_email === t.user_email &&
          // An offer is keyed by vendor id; the old `!== t.to_number` compared
          // an id to a phone number and never excluded the thread's own shop.
          o.vendor_id !== (t.vendor_id ?? t.to_number) &&
          o.price_per_day > 0 &&
          o.price_per_day < f.pricePerDay! * 0.9
      );
      const leveragePlayed =
        Boolean(f.lastLeverage) || cited.has(`${t.user_email}:${identityKey(t.to_number)}`);
      if (rival && !leveragePlayed) {
        findings.push({
          rule: "R3",
          weight: 2,
          detail: `a rival offered ${rival.price_per_day} ${rival.currency} (>10% cheaper) but no leverage was used`,
        });
      }
    }

    // R4 dead thread: the shop asked something and got silence for >6h.
    const last = lastMsgBy.get(`${t.user_email}:${t.to_number}`);
    if (
      last &&
      last.direction === "inbound" &&
      (last.body ?? "").includes("?") &&
      now - Date.parse(last.received_at) > 6 * 3600_000 &&
      !f.declined &&
      !t.waiting_until &&
      t.phase !== "closed"
    ) {
      findings.push({
        rule: "R4",
        weight: 2,
        detail: "the shop's question has been unanswered for over 6 hours",
      });
    }

    // R5 early stop: one firm ended the push with obvious room left.
    if (
      (f.firmCount ?? 0) === 1 &&
      !f.declined &&
      f.pricePerDay &&
      lastTarget &&
      f.pricePerDay > lastTarget * 1.25 &&
      (f.rounds ?? 0) < 4 &&
      now - Date.parse(t.updated_at) > 12 * 3600_000
    ) {
      findings.push({
        rule: "R5",
        weight: 2,
        detail: `one "last price" stopped the push at ${f.pricePerDay} while our target was ${lastTarget}`,
      });
    }

    // R6 quality floor: a judge scored a move's tone/uniqueness at the bottom.
    const badMove = moves.find(
      (m) =>
        m.thread_key === t.thread_key &&
        ((m.scores?.tone ?? 5) <= 2 || (m.scores?.uniqueness ?? 5) <= 1)
    );
    if (badMove) {
      findings.push({ rule: "R6", weight: 1, detail: "a move scored tone <=2 or uniqueness 1" });
    }

    // R7 extraction distrust: a low-confidence parse steered this thread.
    if (lowConf.has(`${t.user_email}:${t.to_number}`)) {
      findings.push({
        rule: "R7",
        weight: 1,
        detail: "a low-confidence extraction fed this negotiation",
      });
    }

    const score = findings.reduce((s, x) => s + x.weight, 0);
    if (score < FLAG_THRESHOLD) continue;

    const reason = findings.map((x) => `[${x.rule}] ${x.detail}`).join(" · ");
    // Idempotence: same reasons already flagged (any status) -> skip; an
    // unresolved auto flag on the thread -> skip (don't stack).
    let prior = existing.filter((e) => e.thread_key === t.thread_key);
    // The global newest-300 window is a CACHE, not the truth: once a thread's
    // earlier auto rows aged past it, `prior` came back empty, both guards
    // passed, and the "idempotent" sweep re-flagged the same conversation
    // forever. A thread the window says is clean gets one scoped read of its
    // OWN rows before the insert; unreadable fails closed (skip, don't stack).
    if (prior.length === 0) {
      // sbSelectDark, not sbSelect: the permissive read returns [] on an
      // outage, which is exactly the "no prior rows" answer that authorises
      // the duplicate insert. null = unreadable = skip this thread.
      const scoped = await sbSelectDark<{ thread_key: string; auto_reason: string | null; status: string }>(
        "agent_reviews",
        `select=thread_key,auto_reason,status&source=eq.auto&thread_key=eq.${encodeURIComponent(
          t.thread_key
        )}&limit=50`
      );
      if (scoped === null) continue;
      prior = scoped;
    }
    if (prior.some((e) => e.auto_reason === reason)) continue;
    if (prior.some((e) => e.status !== "resolved")) continue;

    const ok = await sbInsert("agent_reviews", [
      {
        decision_id: null,
        thread_key: t.thread_key,
        user_email: t.user_email,
        vendor_id: t.vendor_id ?? t.to_number,
        vendor_name: t.vendor_name,
        source: "auto",
        status: "auto_flagged",
        auto_reason: reason.slice(0, 800),
        tags: findings.map((x) => x.rule),
      },
    ]).catch(() => false);
    if (ok) flagged++;
  }

  return { scanned: threads.length, flagged };
}
