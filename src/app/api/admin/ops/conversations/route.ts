import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { sbSelectDark } from "@/lib/runtime-config";
import { quotedInList } from "@/lib/wa/inbound-claim";

// Ops Center: every negotiation across ALL users, as a reviewable list.
// Owner-only - this is the internal quality-improvement surface, never a
// customer feature. Merges thread state + owner reviews + chief-judge
// verdicts + the latest message snippet.
//
// TWO HONESTY RULES this route used to break:
//   - FAIL DARK. Every read was the permissive sbSelect, so an outage
//     answered 200 with an empty list and the panel rendered "No
//     conversations yet" over a dead database. `degraded` now rides the
//     payload and the panel renders the shared banner.
//   - SEARCH THE DATABASE, NOT A WINDOW. q and the flagged/bookmarked
//     filters ran app-side over the newest 120 threads, so a match older
//     than the window was unreachable through any UI. The search is in the
//     query now, the filters drive from agent_reviews first, and
//     offset/hasMore page through the full set.

interface ThreadRow {
  thread_key: string;
  user_email: string;
  vendor_id: string | null;
  vendor_name: string | null;
  to_number: string;
  phase: string;
  fields: Record<string, unknown> | null;
  updated_at: string;
}

interface ReviewRow {
  thread_key: string;
  decision_id: string | null;
  rating: number | null;
  status: string;
  bookmark: boolean;
  source: string;
  auto_reason: string | null;
  created_at: string;
}

interface ChiefRow {
  thread_key: string;
  scores: Record<string, number> | null;
  verdict: string | null;
  created_at: string;
}

interface MsgRow {
  to_number: string;
  from_number: string | null;
  body: string | null;
  direction: string;
  received_at: string;
  raw: { sender?: string; receiver?: string } | null;
}

export async function GET(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const onlyFlagged = url.searchParams.get("flagged") === "1";
  const onlyBookmarked = url.searchParams.get("bookmarked") === "1";
  const limit = Math.min(120, Math.max(1, Number(url.searchParams.get("limit") ?? 60)));
  const offset = Math.max(0, Math.round(Number(url.searchParams.get("offset") ?? 0)) || 0);

  const degraded: string[] = [];
  const threadSelect =
    "select=thread_key,user_email,vendor_id,vendor_name,to_number,phase,fields,updated_at";
  // The search, IN the query. Sanitized to characters that cannot break the
  // or=() grammar - a search term is a needle, not a filter expression.
  const needle = q.replace(/[,()."'\\%*]/g, "").slice(0, 60);
  const qFilter = needle
    ? `&or=(vendor_name.ilike.${encodeURIComponent(`*${needle}*`)},user_email.ilike.${encodeURIComponent(
        `*${needle}*`
      )},phase.ilike.${encodeURIComponent(`*${needle}*`)})`
    : "";

  // Flagged/bookmarked drive from agent_reviews FIRST: the review is the fact
  // being filtered on, so the thread window can never hide it.
  let keyScope: string[] | null = null;
  if (onlyFlagged || onlyBookmarked) {
    const marks = await sbSelectDark<{ thread_key: string }>(
      "agent_reviews",
      `select=thread_key&${
        onlyFlagged ? "status=in.(open,flagged,auto_flagged)" : "bookmark=is.true"
      }&order=created_at.desc&limit=400`
    );
    if (marks === null) degraded.push("review marks");
    keyScope = [...new Set((marks ?? []).map((r) => r.thread_key))].slice(0, 150);
    if (keyScope.length === 0) {
      return NextResponse.json({ threads: [], hasMore: false, nextOffset: 0, degraded });
    }
  }

  // Page the thread read itself (limit+1 answers hasMore without a count).
  const threads =
    (await sbSelectDark<ThreadRow>(
      "negotiation_threads",
      keyScope
        ? `${threadSelect}&thread_key=in.(${quotedInList(keyScope)})${qFilter}&order=updated_at.desc&limit=${limit + 1}&offset=${offset}`
        : `${threadSelect}${qFilter}&order=updated_at.desc&limit=${limit + 1}&offset=${offset}`
    )) ?? null;
  if (threads === null) degraded.push("threads");
  const page = (threads ?? []).slice(0, limit);
  const hasMore = (threads ?? []).length > limit;

  // The joins are scoped to the visible page - a global newest-400 slice made
  // avgRating and the snippet drift as fleet volume grew past the cap.
  const pageKeys = page.map((t) => t.thread_key);
  const pageDigits = [...new Set(page.map((t) => t.to_number).filter(Boolean))];
  const keyList = pageKeys.length ? quotedInList(pageKeys) : "";
  const digitList = pageDigits.length ? quotedInList(pageDigits) : "";
  const [reviews, chiefs, msgs] = pageKeys.length
    ? await Promise.all([
        sbSelectDark<ReviewRow>(
          "agent_reviews",
          `select=thread_key,decision_id,rating,status,bookmark,source,auto_reason,created_at&thread_key=in.(${keyList})&order=created_at.desc&limit=400`
        ),
        sbSelectDark<ChiefRow>(
          "agent_scores",
          `select=thread_key,scores,verdict,created_at&scorer=eq.chief-judge&thread_key=in.(${keyList})&order=created_at.desc&limit=200`
        ),
        sbSelectDark<MsgRow>(
          "whatsapp_messages",
          `select=to_number,from_number,body,direction,received_at,raw&or=(to_number.in.(${digitList}),from_number.in.(${digitList}))&order=received_at.desc&limit=400`
        ),
      ])
    : [[], [], []];
  if (reviews === null) degraded.push("reviews");
  if (chiefs === null) degraded.push("judge verdicts");
  if (msgs === null) degraded.push("message snippets");

  // Newest chief verdict per thread.
  const chiefBy = new Map<string, ChiefRow>();
  for (const c of chiefs ?? []) if (!chiefBy.has(c.thread_key)) chiefBy.set(c.thread_key, c);

  // Review aggregate per thread.
  const revBy = new Map<
    string,
    { ratings: number[]; open: number; bookmark: boolean; autoReasons: string[]; count: number }
  >();
  for (const r of reviews ?? []) {
    const agg =
      revBy.get(r.thread_key) ??
      ({ ratings: [], open: 0, bookmark: false, autoReasons: [], count: 0 } as {
        ratings: number[];
        open: number;
        bookmark: boolean;
        autoReasons: string[];
        count: number;
      });
    agg.count++;
    if (typeof r.rating === "number") agg.ratings.push(r.rating);
    if (r.status === "flagged" || r.status === "auto_flagged" || r.status === "open") agg.open++;
    if (r.bookmark) agg.bookmark = true;
    if (r.source === "auto" && r.auto_reason && agg.autoReasons.length < 3)
      agg.autoReasons.push(r.auto_reason);
    revBy.set(r.thread_key, agg);
  }

  // Latest message per THREAD (owner + digits) - never keyed by bare digits:
  // two users on the same shop number (or a drill number) must never see each
  // other's snippets. Legacy rows without an owner stamp are dropped.
  const lastMsg = new Map<string, MsgRow>();
  for (const m of msgs ?? []) {
    const digits = m.direction === "inbound" ? m.from_number ?? "" : m.to_number;
    const owner = m.direction === "inbound" ? m.raw?.receiver : m.raw?.sender;
    if (!digits || !owner) continue;
    const key = `${owner}:${digits}`;
    if (!lastMsg.has(key)) lastMsg.set(key, m);
  }

  const out = page
    .map((t) => {
      const f = (t.fields ?? {}) as {
        rounds?: number;
        pricePerDay?: number;
        currency?: string;
        declined?: boolean;
        presented?: boolean;
        firmCount?: number;
        dealComplete?: boolean;
      };
      const agg = revBy.get(t.thread_key);
      const chief = chiefBy.get(t.thread_key);
      const last = lastMsg.get(`${t.user_email}:${t.to_number}`);
      return {
        threadKey: t.thread_key,
        userEmail: t.user_email,
        vendorId: t.vendor_id,
        vendorName: t.vendor_name || `+${t.to_number}`,
        // Owner rehearsals - labelled so they never read as real negotiations.
        drill:
          String(t.vendor_id ?? "").startsWith("drill-") ||
          String(t.vendor_id ?? "").startsWith("test-"),
        phase: t.phase,
        updatedAt: t.updated_at,
        rounds: f.rounds ?? 0,
        pricePerDay: f.pricePerDay ?? null,
        currency: f.currency ?? null,
        declined: f.declined === true,
        dealComplete: f.dealComplete === true,
        avgRating: agg?.ratings.length
          ? Number((agg.ratings.reduce((a, b) => a + b, 0) / agg.ratings.length).toFixed(1))
          : null,
        reviewCount: agg?.count ?? 0,
        openFlags: agg?.open ?? 0,
        bookmark: agg?.bookmark ?? false,
        autoReasons: agg?.autoReasons ?? [],
        judge: chief
          ? { outcomeDelta: chief.scores?.outcomeDelta ?? null, verdict: chief.verdict }
          : null,
        lastMsg: last
          ? {
              dir: last.direction === "inbound" ? "in" : "out",
              text: (last.body ?? "").slice(0, 140),
              at: last.received_at,
            }
          : null,
      };
    })
    // The q/flag predicates live in the QUERY now (see the reads above). This
    // residual pass only re-asserts the flagged/bookmarked semantics against
    // the page's own scoped review read, so a stale mark cannot show a row the
    // filter's meaning excludes.
    .filter((t) => {
      if (onlyFlagged && t.openFlags === 0 && !degraded.includes("reviews")) return false;
      if (onlyBookmarked && !t.bookmark && !degraded.includes("reviews")) return false;
      return true;
    });

  return NextResponse.json({
    threads: out,
    hasMore,
    nextOffset: offset + page.length,
    degraded,
  });
}

export const maxDuration = 60;
