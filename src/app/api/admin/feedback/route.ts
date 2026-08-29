import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect, sbUpdate, sbDelete, sbCountDark } from "@/lib/runtime-config";

// In-app feedback inbox with a triage WORKFLOW: every report has a status
// (open / in-progress / resolved / dismissed) and an owner note, so feedback
// is actually worked through, not just read. Stored in Supabase - no email
// service required.
/**
 * How many screenshots the inbox inlines PER REPORT, and in total.
 *
 * Screenshots are base64 data URLs in a text column (capped at ~4MB each by the
 * submit route) and this endpoint used to inline up to 200 of them into ONE
 * JSON response - a response that could reach several hundred megabytes and
 * that the owner's phone has to parse before the panel paints. The rest are
 * counted, not sent: `imageCount` tells the panel there are more, and deleting
 * a report still removes every one of them.
 */
const IMAGES_PER_REPORT = 2;
const IMAGES_TOTAL = 24;

/** How many reports one page carries, and the most a caller may ask for. */
const PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

/** A caller-supplied integer, or the fallback. Never NaN, never unbounded. */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  // The blank check is load-bearing: `Number("")` is 0, not NaN, so an absent
  // parameter would clamp to `min` and serve a one-row page.
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const CATEGORIES = ["bug", "ui", "performance", "crash", "suggestion", "question", "other"];

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // CATEGORIES THAT DO SOMETHING (owner report 5 #18). They were collected,
  // stored and displayed, and drove NOTHING - no filter, no counts - so the
  // only axis the owner could slice the inbox on was triage severity. The
  // filter is applied in the QUERY (so a busy category is not truncated by the
  // 100-row limit before the owner sees it) and the counts are computed over
  // the unfiltered table, so the chips keep their numbers while one is active.
  const url = new URL(req.url);
  const category = String(url.searchParams.get("category") ?? "").trim().toLowerCase();
  const filtered = CATEGORIES.includes(category);
  const select =
    "select=id,category,body,reporter_email,is_real_issue,severity,summary,triage_reason,image_count,status,owner_note,created_at";

  // "FULLY VISIBLE TO EACH AND EVERY FEEDBACK" - AND IT WAS CAPPED AT 100.
  //
  // The read was a hard `limit=100` with no pagination and no way to ask for
  // the next page, and the response then reported `total: rows.length` - the
  // PAGE SIZE - which the panel renders as a metric labelled "Total". With 101
  // reports the 101st-oldest was unreachable through any UI, the owner was told
  // he had exactly 100, and nothing anywhere said otherwise. The window is now
  // a real one (`offset` + `limit`) and `total` is a real count.
  const limit = clampInt(url.searchParams.get("limit"), PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const categoryFilter = filtered ? `&category=eq.${encodeURIComponent(category)}` : "";

  const [rows, allCategories, total, highCount, issueCount] = await Promise.all([
    sbSelect<{ id: number; image_count: number; category: string }>(
      "feedback",
      `${select}${categoryFilter}&order=created_at.desc&offset=${offset}&limit=${limit}`
    ),
    sbSelect<{ category: string | null; severity: string | null; is_real_issue: boolean | null }>(
      "feedback",
      "select=category,severity,is_real_issue&order=created_at.desc&limit=1000"
    ).catch(() => [] as { category: string | null; severity: string | null; is_real_issue: boolean | null }[]),
    // THE REAL NUMBER, and `null` rather than a lie when it cannot be read.
    // `sbCount` answers 0 on any failure, which on a counter labelled "Total"
    // means an outage renders as "you have no feedback".
    // (The filter passed here is a FILTER - sbCountDark supplies its own
    // select, and the old `select=id${...}` emitted a duplicated parameter.)
    sbCountDark("feedback", categoryFilter.replace(/^&/, "")),
    // The two headline tiles' numbers, from real counts over the whole table -
    // they used to be .length over the loaded page, so "High severity: 3" was
    // a fact about pagination, not about the feedback.
    sbCountDark("feedback", "is_real_issue=eq.true&severity=eq.high"),
    sbCountDark("feedback", "is_real_issue=eq.true"),
  ]);

  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const r of allCategories) {
    const key = (r.category ?? "other").toLowerCase();
    byCategory[key] = (byCategory[key] ?? 0) + 1;
    if (r.is_real_issue) {
      const sev = (r.severity ?? "low").toLowerCase();
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    }
  }

  // Attach screenshots for the rows that have them - BOUNDED (see the caps).
  const withImages = rows
    .filter((r) => (r.image_count ?? 0) > 0)
    .map((r) => r.id)
    .slice(0, IMAGES_TOTAL);
  let images: { feedback_id: number; data_url: string }[] = [];
  if (withImages.length) {
    images = await sbSelect<{ feedback_id: number; data_url: string }>(
      "feedback_images",
      `select=feedback_id,data_url&feedback_id=in.(${withImages.join(",")})&limit=${IMAGES_TOTAL * IMAGES_PER_REPORT}`
    );
  }
  const byId: Record<number, string[]> = {};
  let inlined = 0;
  for (const img of images) {
    const bucket = (byId[img.feedback_id] ??= []);
    if (bucket.length >= IMAGES_PER_REPORT || inlined >= IMAGES_TOTAL) continue;
    bucket.push(img.data_url);
    inlined += 1;
  }

  // Attach the reply thread for each report so management sees the full,
  // two-way conversation (user replies + prior owner/admin answers).
  let replies: {
    id: number;
    feedback_id: number;
    author_role: string;
    author_email: string | null;
    body: string;
    created_at: string;
  }[] = [];
  if (rows.length) {
    const ids = rows.map((r) => r.id).join(",");
    replies = await sbSelect<{
      id: number;
      feedback_id: number;
      author_role: string;
      author_email: string | null;
      body: string;
      created_at: string;
    }>(
      "feedback_replies",
      `select=id,feedback_id,author_role,author_email,body,created_at&feedback_id=in.(${ids})&order=created_at.asc&limit=500`
    ).catch(() => []);
  }
  const repliesById: Record<number, typeof replies> = {};
  for (const r of replies) (repliesById[r.feedback_id] ??= []).push(r);

  return NextResponse.json({
    feedback: rows.map((r) => ({
      ...r,
      images: byId[r.id] ?? [],
      /** How many screenshots exist, vs how many are inlined above. */
      imageCount: r.image_count ?? 0,
      replies: repliesById[r.id] ?? [],
    })),
    /** Every category with a count - the owner's filter chips. */
    byCategory,
    /** Real-issue counts per severity (whole table, not the page). */
    bySeverity,
    /** The two headline tiles - exact counts, null when unreadable. */
    highSeverityTotal: highCount,
    realIssuesTotal: issueCount,
    categories: CATEGORIES,
    /** Which filter produced this list, so the panel cannot claim another. */
    category: filtered ? category : null,
    /** EVERY report matching the current filter - not the page size. `null`
     *  means the count could not be read, which a panel must render as
     *  "unknown" rather than as a number it made up. */
    total,
    /** How many are on THIS page, and where the page sits. */
    shown: rows.length,
    offset,
    limit,
    /** Is there another page? Falls back to a full page meaning "probably",
     *  so an unreadable count still offers the owner a way forward. */
    hasMore: total != null ? offset + rows.length < total : rows.length === limit,
    nextOffset: offset + rows.length,
  });
}

const STATUSES = ["open", "in-progress", "resolved", "dismissed"];

// Update a report's status and/or owner note (the triage workflow).
export async function PATCH(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (body.status && STATUSES.includes(String(body.status))) {
    patch.status = body.status;
    patch.resolved_at =
      body.status === "resolved" || body.status === "dismissed"
        ? new Date().toISOString()
        : null;
  }
  if (body.note !== undefined) patch.owner_note = String(body.note).slice(0, 2000);
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  await sbUpdate("feedback", `id=eq.${id}`, patch);
  return NextResponse.json({ ok: true });
}

// Permanently delete a feedback report (and its screenshots). Owner/management
// only - for spam or resolved noise the owner wants gone for good.
export async function DELETE(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  // Remove any attached screenshots first (best-effort), then the row itself.
  await sbDelete("feedback_images", `feedback_id=eq.${id}`).catch(() => {});
  await sbDelete("feedback", `id=eq.${id}`);
  return NextResponse.json({ ok: true });
}
