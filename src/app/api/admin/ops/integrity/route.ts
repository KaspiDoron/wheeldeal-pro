import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { integrityQueue, decideCase } from "@/lib/integrity/queue";
import {
  BLOCK_PRESETS,
  isBlockMinutes,
  partitionCases,
  type DecisionAction,
} from "@/lib/integrity/adjudication";

// The block-approval queue - the human end of the integrity ladder.
//
// The ladder's top rung is a PROPOSAL, and until this route existed there was
// nowhere for a proposal to go: the event was written to `agent_events` and
// read by nothing, while `api/outreach` quietly refused every send from anyone
// who reached that rung. This is the surface that makes the promise true - the
// owner sees the evidence, decides, and the decision is what enforces.

export async function GET() {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });

  const cases = await integrityQueue(Date.now());
  const { proposals, decided, watch } = partitionCases(cases);
  return NextResponse.json({
    proposals,
    decided: decided.slice(0, 40),
    watch: watch.slice(0, 40),
    presets: BLOCK_PRESETS,
  });
}

export async function POST(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const action = String(body.action ?? "") as DecisionAction;

  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  if (action !== "approve" && action !== "reject" && action !== "lift") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  // The owner cannot restrict the owner - the one way this queue could lock
  // its own operator out of the app that runs it.
  if (email === session.email.toLowerCase() && action === "approve") {
    return NextResponse.json({ error: "That is your own account." }, { status: 400 });
  }
  if (action === "approve" && !isBlockMinutes(body.minutes)) {
    return NextResponse.json({ error: "Pick how long the restriction runs." }, { status: 400 });
  }
  // A restriction with no stated reason is one nobody can explain later, least
  // of all to the traveller who asks why.
  const note = String(body.note ?? "").trim();
  if (action === "approve" && note.length < 3) {
    return NextResponse.json({ error: "Say why - it goes in the audit." }, { status: 400 });
  }

  const recorded = await decideCase({
    email,
    action,
    minutes: Number(body.minutes) || 0,
    restrictAccount: body.restrictAccount === true,
    note,
    by: session.email,
  });
  if (!recorded) {
    // The audit event is what closes the case - without it the queue shows
    // the same case open next load, so say that now rather than then.
    return NextResponse.json(
      { ok: false, error: "The decision was NOT recorded - the case stays open. Retry." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}

export const maxDuration = 60;
