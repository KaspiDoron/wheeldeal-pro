import { NextResponse } from "next/server";
import { triageFeedback } from "@/lib/agents";
import { sendEmail } from "@/lib/email";
import {
  sbInsert,
  sbInsertReturning,
  sbSelect,
  sbDelete,
  sbUpdate,
} from "@/lib/runtime-config";
import { adminEmails, getSession } from "@/lib/session";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { moderateFeedback } from "@/lib/feedback/moderation";
import { normalizeVerdict } from "@/lib/feedback/verdict";

interface ImagePayload {
  filename: string;
  dataUrl: string; // data:<mime>;base64,<data>
}

const MAX_IMAGES = 5;
// Each screenshot is stored base64 in a text column and re-emitted to the admin
// inbox, so an unbounded image is a storage-and-bandwidth amplifier. ~4MB of
// base64 is ~3MB of image - plenty for a phone screenshot, and a hard ceiling.
const MAX_IMAGE_B64 = 4 * 1024 * 1024;

function parseImages(images: ImagePayload[] | undefined) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, MAX_IMAGES).flatMap((img) => {
    const m = /^data:([^;]+);base64,(.+)$/.exec(img.dataUrl || "");
    if (!m || m[2].length > MAX_IMAGE_B64) return [];
    return [{ filename: img.filename || "screenshot.png", content: m[2] }];
  });
}

export async function POST(req: Request) {
  // THROTTLE. This route makes an LLM triage call and an unbounded storage
  // write per request with no session required - an open faucet. A modest
  // per-ip window keeps genuine feedback flowing while closing the abuse path.
  const ip = clientIp(req);
  const gate = await rateLimit("feedback", ip, 8, 3600);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Thanks - you have sent a lot just now. Please try again a bit later." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } }
    );
  }

  const body = await req.json().catch(() => null);
  if (!body?.text || !body?.category) {
    return NextResponse.json(
      { error: "Category and description are required." },
      { status: 400 }
    );
  }
  const text = String(body.text).slice(0, 4000);
  const category = String(body.category);
  // Ownership is the SESSION ONLY - never the spoofable body.email. An
  // anonymous submission is stored UNOWNED (reporter_email null) so it can
  // never be planted into another user's "Your reports" feed, nor trigger a
  // team-reply email to an attacker-chosen address.
  const session = await getSession();
  const email = session?.email ?? "";

  // SAFE WORDS (owner report 5 #18). BEFORE anything is stored, emailed or
  // shown: model-first moderation with a deterministic blocklist floor. A
  // rejected report is never written to the table, so abuse cannot reach the
  // owner's inbox at all - and the refusal is polite, specific, and never
  // quotes the abuse back at the person who wrote it.
  //
  // Deliberately NOT a complaint filter: fury about the product is exactly the
  // feedback we want, and the moderator is told so in as many words.
  const moderation = await moderateFeedback(text);
  if (!moderation.allowed) {
    return NextResponse.json(
      {
        error: moderation.message ?? "Please rephrase this without the language and send it again.",
        rejected: "language",
        stored: false,
      },
      { status: 400 }
    );
  }

  const attachments = parseImages(body.images);

  // Feedback Triage Agent: keep genuine issues, filter spam before emailing.
  //
  // VALIDATED. This used to accept the model's JSON on one `typeof` check, so a
  // reply missing `severity` threw a TypeError in the email subject below -
  // AFTER the row was inserted. The user saw "Something went wrong", nothing
  // was escalated, and re-submitting duplicated the row. See feedback/verdict.
  const verdict = normalizeVerdict(await triageFeedback(category, text), text);

  const inserted = await sbInsertReturning<{ id: number }>("feedback", [
    {
      category,
      body: text,
      reporter_email: email || null,
      is_real_issue: verdict.isRealIssue,
      severity: verdict.severity,
      summary: verdict.summary,
      triage_reason: verdict.reason,
      image_count: attachments.length,
    },
  ]);
  const feedbackId = inserted[0]?.id ?? null;
  // A LOST REPORT MUST NOT READ AS A RECEIVED ONE.
  //
  // Both replies below promise the reporter they can follow up "under Your
  // reports" - a thread that only exists if this row landed. With Supabase
  // configured and unreachable the row does not land, and the response still
  // said `accepted: true` with a null id. The escalation email is a separate
  // path and still goes out, so this is not a hard failure; it is a different
  // promise, and the copy has to match which one we actually kept.
  //
  // W6.2 - AND DEMO MODE IS NOT A STORED ROW EITHER. The `|| !supabaseConfigured()`
  // that used to sit here reported `stored: true` with no database at all, so
  // the app promised a thread under "Your reports" that the GET can only ever
  // answer with an empty list. No row, no thread, and we say so.
  const storedRow = feedbackId !== null;
  /** No session, so this report has no owner and no reply channel. Told to the
   *  reporter plainly rather than discovered by them later (W6.2). */
  const anonymous = !email;

  if (feedbackId !== null && Array.isArray(body.images) && body.images.length) {
    const rows = (body.images as { dataUrl?: string }[])
      .slice(0, MAX_IMAGES)
      .filter(
        (img) =>
          typeof img.dataUrl === "string" &&
          img.dataUrl.startsWith("data:") &&
          // Same ceiling as the email attachments - the raw data URL is a bit
          // larger than its base64 body, so bound the whole string.
          img.dataUrl.length <= MAX_IMAGE_B64 + 256
      )
      .map((img) => ({ feedback_id: feedbackId, data_url: img.dataUrl }));
    if (rows.length) await sbInsert("feedback_images", rows);
  }

  if (!verdict.isRealIssue) {
    // Even a filtered item is stored + visible in "your reports" so nothing a
    // user submits ever silently vanishes - they can follow up with detail.
    return NextResponse.json({
      accepted: false,
      id: feedbackId,
      stored: storedRow,
      anonymous,
      reason: storedRow
        ? "Thanks! Our assistant reviewed this and didn't flag a concrete bug, so it wasn't escalated. Add more detail (what happened, steps) to send it through - you can also reply on it under Your reports."
        : "Thanks - we read this, and our assistant didn't flag a concrete bug. We could not save a copy just now, so it will not appear under Your reports. If you want us to look again, please send it once more in a few minutes.",
    });
  }

  const to = await adminEmails();
  const emailResult = await sendEmail({
    to,
    subject: `[WheelDeal ${verdict.severity.toUpperCase()}] ${verdict.summary}`,
    html: `
      <h2>New verified feedback</h2>
      <p><b>Category:</b> ${escapeHtml(category)}</p>
      <p><b>Severity:</b> ${verdict.severity}</p>
      <p><b>From:</b> ${escapeHtml(email || "anonymous")}</p>
      <p><b>Triage:</b> ${escapeHtml(verdict.reason)}</p>
      <hr/>
      <p style="white-space:pre-wrap">${escapeHtml(text)}</p>
      <p><i>${attachments.length} image(s) attached.</i></p>
    `,
    attachments,
  });

  return NextResponse.json({
    accepted: true,
    id: feedbackId,
    stored: storedRow,
    anonymous,
    // The team got it either way (that is `emailed`); `stored` is specifically
    // whether a thread exists for the reporter to follow up in.
    storedNote: storedRow
      ? undefined
      : "Sent to the team, but we could not save your copy - it will not appear under Your reports.",
    severity: verdict.severity,
    summary: verdict.summary,
    emailed: emailResult.sent,
    emailReason: emailResult.reason,
  });
}

// GET: the signed-in user's OWN submissions, each with its reply thread and
// status, newest first - so feedback is a visible, two-way conversation rather
// than a fire-and-forget box.
type OwnReportRow = {
  id: number;
  category: string;
  body: string;
  status: string | null;
  severity: string | null;
  summary: string | null;
  user_seen_at?: string | null;
  created_at: string;
};

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const me = encodeURIComponent(session.email);
  const filter = `reporter_email=eq.${me}&order=created_at.desc&limit=50`;
  // `user_seen_at` in the first tier only - the column exists in the schema and
  // has been DEAD CODE since it was added (the unread dot was computed from a
  // localStorage stamp, so a reply read on a phone was unread again on a
  // laptop, and the badge only ever appeared INSIDE the already-open modal).
  // An unknown column silently blanks a select, so the pre-migration tier keeps
  // the reports list alive without it.
  let rows = await sbSelect<OwnReportRow>(
    "feedback",
    `select=id,category,body,status,severity,summary,user_seen_at,created_at&${filter}`
  ).catch(() => [] as OwnReportRow[]);
  if (rows.length === 0) {
    rows = await sbSelect<OwnReportRow>(
      "feedback",
      `select=id,category,body,status,severity,summary,created_at&${filter}`
    ).catch(() => [] as OwnReportRow[]);
  }

  let replies: {
    id: number;
    feedback_id: number;
    author_role: string;
    body: string;
    created_at: string;
  }[] = [];
  if (rows.length) {
    const ids = rows.map((r) => r.id).join(",");
    replies = await sbSelect<{
      id: number;
      feedback_id: number;
      author_role: string;
      body: string;
      created_at: string;
    }>(
      "feedback_replies",
      `select=id,feedback_id,author_role,body,created_at&feedback_id=in.(${ids})&order=created_at.asc&limit=300`
    ).catch(() => []);
  }
  const byId: Record<number, typeof replies> = {};
  for (const r of replies) (byId[r.feedback_id] ??= []).push(r);

  // THE UNREAD SIGNAL, FROM THE SERVER (W6.2). A team reply newer than the
  // stamp this device-independent column carries is unread, full stop.
  const reports = rows.map((r) => {
    const thread = byId[r.id] ?? [];
    const seen = r.user_seen_at ? Date.parse(r.user_seen_at) : 0;
    const unread = thread.filter(
      (rp) => rp.author_role !== "user" && (Date.parse(rp.created_at) || 0) > seen
    ).length;
    return { ...r, replies: thread, unread };
  });

  // Categories that DO something: the counts the tab needs to offer a filter.
  const byCategory: Record<string, number> = {};
  for (const r of reports) byCategory[r.category || "other"] = (byCategory[r.category || "other"] ?? 0) + 1;

  return NextResponse.json({
    reports,
    unread: reports.reduce((n, r) => n + r.unread, 0),
    byCategory,
  });
}

// PATCH: "I have read the team's replies." Stamps `user_seen_at` on the
// caller's OWN reports, which is what makes the unread badge survive a device
// change - the column has existed since the feedback-threads migration and
// nothing has ever written to it.
export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body?.id);
  const me = encodeURIComponent(session.email);
  const scope = Number.isFinite(id) && id > 0 ? `id=eq.${id}&reporter_email=eq.${me}` : `reporter_email=eq.${me}`;
  // Ownership is in the FILTER, never in the id alone: one user can never stamp
  // another user's row, whatever they send.
  const ok = await sbUpdate("feedback", scope, { user_seen_at: new Date().toISOString() }).catch(
    () => false
  );
  return NextResponse.json({ ok: ok !== false });
}

// DELETE: a user removes their OWN submission (and its thread + screenshots).
// Ownership is enforced by matching reporter_email to the session - never id
// alone, so one user can never delete another's report.
export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const me = encodeURIComponent(session.email);
  const owned = await sbSelect<{ id: number }>(
    "feedback",
    `select=id&id=eq.${id}&reporter_email=eq.${me}&limit=1`
  ).catch(() => []);
  if (!owned.length) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await sbDelete("feedback_replies", `feedback_id=eq.${id}`).catch(() => {});
  await sbDelete("feedback_images", `feedback_id=eq.${id}`).catch(() => {});
  // HONEST WRITE (audit M45): the report row is the one the reporter sees,
  // and a delete Supabase refused used to answer ok:true anyway.
  const removed = await sbDelete("feedback", `id=eq.${id}`);
  if (!removed) {
    return NextResponse.json(
      { ok: false, error: "The report was not deleted - it is still in your reports. Try again." },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
