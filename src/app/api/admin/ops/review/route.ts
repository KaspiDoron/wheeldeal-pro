import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { sbSelect, sbSelectDark, sbInsert, sbInsertReturning, sbUpdate } from "@/lib/runtime-config";
import type { ReviewInput, ReviewVerdict, OutcomeImpact, ReviewStatus } from "@/lib/ops/types";
import {
  compileMisreadLesson,
  isMisreadKind,
  lessonNote,
  misreadTag,
  misreadTurn,
} from "@/lib/ops/misread";
import { goldenProvenance } from "@/lib/ops/provenance";

// Ops Center: owner reviews of agent decisions - the feedback that actually
// teaches the system. Upserted per (thread, decision). Two side effects make
// the learning REAL the moment the owner saves:
//   bookmark        -> the negotiation is distilled into agent_training, which
//                      composeBargain already injects into every future prompt
//   better_response -> stored as a correction exemplar the same way
// (Phase 3 additionally recompiles the ops_learning blob for the director.)

const VERDICTS: ReviewVerdict[] = ["approve", "reject"];
const IMPACTS: OutcomeImpact[] = ["improved", "worsened", "neutral"];
const STATUSES: ReviewStatus[] = ["open", "flagged", "auto_flagged", "resolved"];

export async function GET(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });
  const url = new URL(req.url);
  // FAIL DARK: an unreadable queue must not answer 200 with an empty list -
  // that is how the inbox rendered a celebratory "Nothing needs review" over
  // a dead database. `degraded` rides the payload; the panel renders a red
  // could-not-be-read card instead of the party emoji.
  if (url.searchParams.get("queue") === "inbox") {
    const rows = await sbSelectDark<Record<string, unknown>>(
      "agent_reviews",
      "select=*&status=in.(open,flagged,auto_flagged)&order=created_at.desc&limit=100"
    );
    return NextResponse.json({
      reviews: rows ?? [],
      degraded: rows === null ? ["review queue"] : [],
    });
  }
  const threadKey = url.searchParams.get("threadKey") ?? "";
  const rows = threadKey
    ? await sbSelectDark<Record<string, unknown>>(
        "agent_reviews",
        `select=*&thread_key=eq.${encodeURIComponent(threadKey)}&order=created_at.desc&limit=60`
      )
    : [];
  return NextResponse.json({
    reviews: rows ?? [],
    degraded: rows === null ? ["reviews"] : [],
  });
}

export async function POST(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });

  const body = (await req.json().catch(() => null)) as ReviewInput | null;
  const threadKey = String(body?.threadKey ?? "").trim();
  const idx = threadKey.lastIndexOf(":");
  if (!body || idx <= 0) {
    return NextResponse.json({ error: "threadKey required" }, { status: 400 });
  }
  const userEmail = threadKey.slice(0, idx);
  const digits = threadKey.slice(idx + 1);
  const decisionId = body.decisionId ? String(body.decisionId).slice(0, 64) : null;

  // Validate/clamp every field - the console can never write garbage.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.rating !== undefined) {
    const r = Math.round(Number(body.rating));
    if (r >= 1 && r <= 5) patch.rating = r;
  }
  if (body.verdict !== undefined && VERDICTS.includes(body.verdict)) patch.verdict = body.verdict;
  if (typeof body.branchCorrect === "boolean") patch.branch_correct = body.branchCorrect;
  if (body.outcomeImpact !== undefined && IMPACTS.includes(body.outcomeImpact))
    patch.outcome_impact = body.outcomeImpact;
  if (body.betterResponse !== undefined)
    patch.better_response = String(body.betterResponse).slice(0, 1500) || null;
  if (body.feedback !== undefined) patch.feedback = String(body.feedback).slice(0, 2000) || null;
  if (Array.isArray(body.tags))
    patch.tags = body.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 10);
  if (typeof body.bookmark === "boolean") patch.bookmark = body.bookmark;
  if (body.status !== undefined && STATUSES.includes(body.status)) patch.status = body.status;

  // Owner-facing notes about what the correction actually did.
  let lessonNoteOut: string | null = null;
  let goldenNote: string | null = null;

  // MISREAD CORRECTION. Validated against the closed vocabulary before it can
  // touch a row - an unknown label would compile into a lesson nothing can
  // retrieve. Rides `tags` (an existing column), so there is no migration.
  const misread =
    body.misread && isMisreadKind(body.misread.actualMeaning) &&
    String(body.misread.shopMessage ?? "").trim()
      ? {
          shopMessage: String(body.misread.shopMessage).slice(0, 600),
          actualMeaning: body.misread.actualMeaning,
          shouldHaveMoved: body.misread.shouldHaveMoved,
        }
      : null;
  if (misread) {
    const tags = new Set<string>(Array.isArray(patch.tags) ? (patch.tags as string[]) : []);
    tags.add(misreadTag(misread.actualMeaning));
    if (misread.shouldHaveMoved) tags.add(`move:${misread.shouldHaveMoved}`);
    patch.tags = [...tags].slice(0, 10);
  }

  // Existing review for this (thread, decision)?
  const filter = decisionId
    ? `thread_key=eq.${encodeURIComponent(threadKey)}&decision_id=eq.${encodeURIComponent(decisionId)}`
    : `thread_key=eq.${encodeURIComponent(threadKey)}&decision_id=is.null`;
  const existing = await sbSelect<{
    id: number;
    bookmark: boolean;
    better_response: string | null;
  }>("agent_reviews", `select=id,bookmark,better_response&${filter}&limit=1`).catch(() => []);

  let reviewId = existing[0]?.id ?? null;
  // HONEST WRITE: the review IS the owner's teaching - a rating that silently
  // failed to store is a lesson the agents never receive, painted as "Saved -
  // the agents learn from this." The write's boolean travels to the response.
  let reviewWrote = false;
  if (reviewId) {
    reviewWrote = await sbUpdate("agent_reviews", `id=eq.${reviewId}`, patch).catch(() => false);
  } else {
    // Denormalize vendor + chosen node/edge so priors and heatmaps never
    // need to re-join agent_traces at read time.
    const [thread, traces] = await Promise.all([
      sbSelect<{ vendor_id: string | null; vendor_name: string | null }>(
        "negotiation_threads",
        `select=vendor_id,vendor_name&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
      ).catch(() => []),
      decisionId
        ? sbSelect<{ node_id: string | null; edge_id: string | null }>(
            "agent_traces",
            `select=node_id,edge_id&decision_id=eq.${encodeURIComponent(
              decisionId
            )}&edge_id=not.is.null&order=created_at.asc&limit=1`
          ).catch(() => [])
        : Promise.resolve([] as { node_id: string | null; edge_id: string | null }[]),
    ]);
    const rows = await sbInsertReturning<{ id: number }>("agent_reviews", [
      {
        decision_id: decisionId,
        thread_key: threadKey,
        user_email: userEmail,
        vendor_id: thread[0]?.vendor_id ?? digits,
        vendor_name: thread[0]?.vendor_name ?? null,
        node_id: traces[0]?.node_id ?? null,
        edge_id: traces[0]?.edge_id ?? null,
        source: "owner",
        status: "open",
        ...patch,
      },
    ]).catch(() => []);
    reviewId = rows[0]?.id ?? null;
    reviewWrote = reviewId != null;
  }
  if (!reviewWrote) {
    // Refused BEFORE the learning side effects: a correction or bookmark
    // hanging off a review row that does not exist would be half-learned state
    // no later read can reconcile.
    return NextResponse.json(
      { ok: false, error: "The review was NOT stored - nothing was learned. Check Supabase and retry." },
      { status: 502 }
    );
  }

  // ---- learning side effects (only on TRANSITIONS, never duplicated) ----------
  const becameBookmarked = body.bookmark === true && existing[0]?.bookmark !== true;
  const newCorrection =
    typeof body.betterResponse === "string" &&
    body.betterResponse.trim().length > 0 &&
    body.betterResponse.trim() !== (existing[0]?.better_response ?? "").trim();

  // A MISREAD becomes a retrievable lesson. Written to the same agent_training
  // table the other teaching uses, but tagged in `note` so loadCoaching can
  // fetch ONLY the lessons that apply to the turn in front of it - a menu
  // lesson on a menu turn, not blended into every prompt forever.
  if (misread) {
    const thread = await sbSelect<{ vendor_name: string | null }>(
      "negotiation_threads",
      `select=vendor_name&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
    ).catch(() => []);
    // PARKED first. `loadCoaching` reads source="ops-lesson" only, so writing
    // "-pending" means the lesson exists but changes no behaviour yet. It is
    // promoted below, and only if the whole golden suite still passes.
    const lessonRows = await sbInsertReturning<{ id: number }>("agent_training", [
      {
        text: compileMisreadLesson(misread, {
          vendorName: thread[0]?.vendor_name ?? undefined,
          why: body.feedback ?? undefined,
        }),
        note: lessonNote(misread.actualMeaning),
        added_by: session.email,
        source: "ops-lesson-pending",
      },
    ]).catch(() => []);

    // FREEZE THE THREAD AS A GOLDEN CASE. A correction that only edits a prompt
    // can silently rot; a frozen case makes the same misread fail the gate
    // forever. Only assertable when the owner named the move it should have
    // made - otherwise there is nothing for the replay to check.
    if (misread.shouldHaveMoved) {
      // CARRY THE REAL FACTS (Wave 3). This used to freeze an EMPTY
      // stubExtraction with a null floor and an empty rfq - erasing exactly the
      // facts the misread was about, so the probe failed and the case landed
      // disabled. The stub now derives from the closed misread vocabulary plus
      // the deterministic parse stored nearest the pinned message; rfq/region
      // come from the thread's own outbound meta and the floor from the
      // decision's comparator trace, the same sources create-from-thread uses.
      // Every read is best-effort: a missing piece degrades to the old empty
      // value, never blocks the correction.
      const [outMeta, parses, comp] = await Promise.all([
        sbSelect<{ raw: { rfq?: Record<string, unknown>; region?: string } | null }>(
          "whatsapp_messages",
          `select=raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
            digits
          )}&raw->>sender=eq.${encodeURIComponent(userEmail)}&order=received_at.desc&limit=1`
        ).catch(() => []),
        sbSelect<{
          reply_text: string | null;
          found: boolean | null;
          price_per_day: number | null;
          currency: string | null;
          confidence: string | null;
        }>(
          "vendor_replies",
          `select=reply_text,found,price_per_day,currency,confidence&user_email=eq.${encodeURIComponent(
            userEmail
          )}&order=created_at.desc&limit=30`
        ).catch(() => []),
        decisionId
          ? sbSelect<{ input: string | null }>(
              "agent_traces",
              `select=input&stage=eq.comparator&decision_id=eq.${encodeURIComponent(
                decisionId
              )}&order=created_at.desc&limit=1`
            ).catch(() => [])
          : Promise.resolve([] as { input: string | null }[]),
      ]);
      // The parse OF the pinned message: match by normalized text, newest first.
      const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
      const pinned = squash(misread.shopMessage);
      const parseRow = parses.find((p) => squash(p.reply_text ?? "") === pinned) ?? null;
      const parse = parseRow
        ? {
            found: parseRow.found,
            pricePerDay: parseRow.price_per_day,
            currency: parseRow.currency,
            confidence: parseRow.confidence,
          }
        : null;
      const floorMatch = (comp[0]?.input ?? "").match(/floor=(\d+)/);
      const candidate = {
        name: `misread ${misread.actualMeaning} - ${thread[0]?.vendor_name ?? "shop"}`.slice(0, 80),
        // Pseudonymous provenance (audit F169) - same stamp as create-from-thread.
        thread_key: goldenProvenance(threadKey),
        rfq: outMeta[0]?.raw?.rfq ?? {},
        region: outMeta[0]?.raw?.region ?? null,
        floor: floorMatch
          ? { floor: Number(floorMatch[1]), currency: parse?.currency ?? undefined }
          : null,
        turns: [misreadTurn(misread, parse)],
        expects: [{ move: misread.shouldHaveMoved }],
        // Enabled only if it PASSES right now. A case the engine already fails
        // would block every future activation on day one - an honest "we still
        // get this wrong" belongs in the response, not in the gate.
        enabled: false,
      };
      try {
        const { runGoldenCase } = await import("@/lib/ops/golden");
        const probe = await runGoldenCase({
          ...candidate,
          id: 0,
          created_at: new Date().toISOString(),
        } as never);
        candidate.enabled = probe.pass;
        await sbInsert("agent_golden_cases", [candidate]).catch(() => {});
        goldenNote = probe.pass
          ? "Frozen as a golden case - this misread can never come back silently."
          : `Frozen but NOT enabled: the engine still answers "${probe.turns[0]?.got?.move ?? "?"}" here.`;
      } catch {
        /* freezing is a bonus - never block the correction itself */
      }
    }

    // ACTIVATE the lesson only behind a green suite, and version the change so
    // it has the same one-click rollback every other behaviour change has.
    // goldenGateBlocks fails CLOSED on an unreadable store - a suite that could
    // not see its cases reported 0/0 here and activated the lesson blind.
    try {
      const { runGoldenSuite, goldenGateBlocks } = await import("@/lib/ops/golden");
      const report = await runGoldenSuite();
      const blocked = goldenGateBlocks(report);
      if (!blocked && report.passed === report.total && lessonRows[0]?.id) {
        await sbUpdate("agent_training", `id=eq.${lessonRows[0].id}`, {
          source: "ops-lesson",
        }).catch(() => {});
        const { saveVersionedSpec } = await import("@/lib/policy");
        const { getPolicyOverlay } = await import("@/lib/ops/overlay");
        // The overlay itself is UNCHANGED - this row exists so the lesson's
        // activation is a versioned, rollbackable event like any other.
        await saveVersionedSpec({
          kind: "policy_overlay",
          spec: await getPolicyOverlay(),
          note: `lesson activated: ${misread.actualMeaning}`,
          author: session.email,
          replayReport: report,
        }).catch(() => {});
        const { bustCoachingCache } = await import("@/lib/spte/coaching");
        bustCoachingCache();
        lessonNoteOut = "Lesson is live - the suite still passes.";
      } else {
        lessonNoteOut = blocked
          ? `Lesson saved but NOT activated: ${blocked}`
          : `Lesson saved but NOT activated: ${report.total - report.passed} of ${report.total} golden cases would break.`;
      }
    } catch {
      lessonNoteOut = "Lesson saved. Activation check could not run.";
    }
  }

  if (becameBookmarked || newCorrection) {
    const [outs, ins, thread] = await Promise.all([
      sbSelect<{ body: string | null; received_at: string }>(
        "whatsapp_messages",
        `select=body,received_at&direction=eq.outbound&to_number=eq.${encodeURIComponent(
          digits
        )}&raw->>sender=eq.${encodeURIComponent(userEmail)}&order=received_at.desc&limit=4`
      ).catch(() => []),
      sbSelect<{ body: string | null; received_at: string }>(
        "whatsapp_messages",
        `select=body,received_at&direction=eq.inbound&from_number=eq.${encodeURIComponent(
          digits
        )}&raw->>receiver=eq.${encodeURIComponent(userEmail)}&order=received_at.desc&limit=4`
      ).catch(() => []),
      sbSelect<{ vendor_name: string | null }>(
        "negotiation_threads",
        `select=vendor_name&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
      ).catch(() => []),
    ]);
    const vendorName = thread[0]?.vendor_name || "a rental shop";
    const day = new Date().toISOString().slice(0, 10);

    if (becameBookmarked) {
      const exchange = [
        ...outs.map((m) => ({ who: "Agent", text: m.body ?? "", at: m.received_at })),
        ...ins.map((m) => ({ who: "Shop", text: m.body ?? "", at: m.received_at })),
      ]
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .map((m) => `${m.who}: ${m.text.slice(0, 260)}`)
        .join("\n");
      await sbInsert("agent_training", [
        {
          text: `[OPS-EXEMPLAR ${day}] Owner-approved negotiation with ${vendorName}:\n${exchange}`.slice(
            0,
            3500
          ),
          note: (body.feedback ?? "").slice(0, 300) || "Bookmarked in the Ops Center",
          added_by: session.email,
          source: "ops-exemplar",
        },
      ]).catch(() => {});
    }
    if (newCorrection) {
      const lastShop = ins[0]?.body ?? "";
      const lastAgent = outs[0]?.body ?? "";
      await sbInsert("agent_training", [
        {
          text:
            `[OPS-CORRECTION ${day}] With ${vendorName}, the shop said: "${lastShop.slice(0, 300)}". ` +
            `The agent replied: "${lastAgent.slice(0, 300)}". ` +
            `The CORRECT reply would have been: "${body.betterResponse!.trim().slice(0, 600)}".` +
            (body.feedback ? ` Why: ${String(body.feedback).slice(0, 300)}` : ""),
          note: "Owner correction from the Ops Center",
          added_by: session.email,
          source: "ops-correction",
        },
      ]).catch(() => {});
    }
  }

  // Recompile the director-facing learning blob (priors/exemplars) - Phase 3
  // makes this live; a failed recompile never blocks the review save.
  try {
    const { recompileOpsLearning } = await import("@/lib/ops/learning");
    await recompileOpsLearning();
  } catch {
    /* not wired yet / best-effort */
  }

  return NextResponse.json({ ok: true, id: reviewId, lesson: lessonNoteOut, golden: goldenNote });
}

export const maxDuration = 60;
